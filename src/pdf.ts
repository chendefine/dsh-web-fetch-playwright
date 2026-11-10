/**
 * PDF → markdown. A fetched URL that turns out to be a PDF (served inline as
 * `application/pdf`, as a `Content-Disposition: attachment` download, or as
 * an anonymous `application/octet-stream` whose bytes start with `%PDF-`) is
 * routed here instead of failing with `WEB_UNSUPPORTED_CONTENT_TYPE`.
 *
 * Two layers, kept apart so the heuristics are testable without pdf.js:
 *
 * 1. {@link readPdfDocument} — the pdf.js boundary (through `unpdf`'s
 *    serverless build, loaded lazily so plugin start never pays for it).
 *    Per page it reads the positioned text runs (`getTextContent`) plus the
 *    real font names (`getOperatorList` + `fontExtraProperties`, the only way
 *    pdf.js exposes "NimbusRomNo9L-Medi" instead of a generic family), so the
 *    layout pass can see bold and monospace. Bounded by the fetch deadline,
 *    the caller's abort signal, a page cap, and a collected-character cap.
 * 2. {@link layoutPdfMarkdown} — pure heuristics over those runs:
 *    - runs → lines (baseline grouping in content-stream order, x-sorted
 *      inside a line; rotated runs such as arXiv's side stamp are dropped);
 *    - running headers/footers (text repeated in the page margins across
 *      pages, digits normalized) and bare page numbers are removed;
 *    - the dominant (body) font size and line pitch are measured;
 *    - headings come from, strongest first: the PDF outline (bookmarks),
 *      section numbering ("3.1 Pre-training", "第二章", "一、"), larger font
 *      sizes (ranked into levels), and standalone bold lines;
 *    - lines are merged into paragraphs (vertical gap, first-line indent,
 *      short terminal line, font change; continuation across columns and
 *      pages when the sentence is unfinished), with dictionary-checked
 *      de-hyphenation and CJK-aware joining;
 *    - bullets / numbered items become markdown lists, monospace blocks
 *      become fenced code (unless the whole document is monospace), lines
 *      with wide column gaps become GFM tables when they line up;
 *    - `<!-- page N -->` markers keep page provenance for citations.
 *
 * Scanned PDFs without a text layer, encrypted PDFs, and broken files fail
 * with dedicated, provider-specific error codes (OCR is out of scope).
 *
 * @module dsh-web-fetch-playwright/pdf
 */

import { WebError } from '@deepseek-ai/dsh-web'

/** Largest PDF this provider downloads and parses (bytes). */
export const MAX_PDF_BYTES = 50 * 1024 * 1024

/** Most pages read from one document; later pages are reported as truncated. */
export const MAX_PDF_PAGES = 500

/** No text layer (a scanned / image-only PDF); OCR is not supported. */
export const WEB_PDF_NO_TEXT_CODE = 'WEB_PDF_NO_TEXT'
/** Password-protected PDF the parser cannot open. */
export const WEB_PDF_ENCRYPTED_CODE = 'WEB_PDF_ENCRYPTED'
/** Bytes claimed (or sniffed) to be a PDF that pdf.js cannot parse. */
export const WEB_PDF_INVALID_CODE = 'WEB_PDF_INVALID'
/** PDF larger than {@link MAX_PDF_BYTES}. */
export const WEB_PDF_TOO_LARGE_CODE = 'WEB_PDF_TOO_LARGE'

const PDF_MIME_TYPES = new Set(['application/pdf', 'application/x-pdf', 'application/acrobat', 'applications/vnd.pdf', 'text/pdf', 'text/x-pdf'])

/** Generic binary types a server may use for a PDF; their bytes get sniffed. */
const OPAQUE_BINARY_TYPES = new Set([
  'application/octet-stream',
  'binary/octet-stream',
  'application/binary',
  'application/download',
  'application/x-download',
  'application/force-download',
  'application/unknown',
])

/** The bare media type of a `Content-Type` header value. */
function mediaType(contentType: string | undefined): string {
  return (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
}

/** Whether a `Content-Type` names a PDF. */
export function isPdfContentType(contentType: string | undefined): boolean {
  return PDF_MIME_TYPES.has(mediaType(contentType))
}

/**
 * Whether a response that is not otherwise decodable is worth downloading
 * to sniff for PDF bytes: a PDF content type, a `.pdf` attachment filename,
 * a `.pdf` URL path, or an opaque binary type (servers commonly hand PDFs out
 * as `application/octet-stream`). The magic-byte check then decides.
 */
export function mayBePdf(headers: Record<string, string>, url: string): boolean {
  if (isPdfContentType(headers['content-type'])) return true
  const disposition = headers['content-disposition'] ?? ''
  if (/filename\*?\s*=\s*(?:[\w-]+'[^']*')?"?[^";]*\.pdf\b/i.test(disposition)) return true
  try {
    if (/\.pdf$/i.test(new URL(url).pathname)) return true
  } catch {
    // not a URL — no path hint
  }
  return OPAQUE_BINARY_TYPES.has(mediaType(headers['content-type']))
}

/**
 * Whether the bytes are a PDF: `%PDF-` within the first 1024 bytes (the
 * spec-tolerated leading-garbage window every mainstream reader accepts).
 */
export function isPdfBytes(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length - 5, 1024)
  for (let i = 0; i <= limit; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Positioned text model (the layout pass's input)
// ---------------------------------------------------------------------------

/** One positioned, horizontal text run (pdf.js text item, normalized). */
export interface PdfTextRun {
  text: string
  /** Left edge in PDF user space. */
  x: number
  /** Baseline in PDF user space (origin bottom-left). */
  y: number
  width: number
  /** Font size (vertical scale of the text matrix). */
  size: number
  bold: boolean
  mono: boolean
}

/** One page's text runs in content-stream order. */
export interface PdfPageText {
  /** 1-based page number. */
  number: number
  /** Page box bottom edge (user space). */
  bottom: number
  /** Page box height (user space). */
  height: number
  runs: PdfTextRun[]
}

/** One bookmark, flattened with its nesting depth (0 = top level). */
export interface PdfOutlineEntry {
  title: string
  depth: number
}

/** Everything the layout pass consumes. */
export interface PdfDocumentText {
  /** Document info / XMP title, when present. */
  title?: string
  outline: PdfOutlineEntry[]
  pages: PdfPageText[]
  totalPages: number
}

/** The finished extraction. */
export interface PdfExtraction {
  markdown: string
  totalPages: number
  /** Pages actually read (fewer than `totalPages` when a limit cut in). */
  pagesRead: number
  /** True when a page, size, or time limit stopped the extraction early. */
  truncated: boolean
}

// ---------------------------------------------------------------------------
// pdf.js boundary
// ---------------------------------------------------------------------------

/** The structural pdf.js surface this module touches. */
interface PdfJsTextItem {
  str?: string
  transform?: number[]
  width?: number
  height?: number
  fontName?: string
}
interface PdfJsPage {
  view: number[]
  getTextContent(): Promise<{ items: PdfJsTextItem[] }>
  getOperatorList(): Promise<unknown>
  commonObjs: { get(id: string): unknown }
  cleanup(): unknown
}
interface PdfJsOutlineNode {
  title?: string
  items?: PdfJsOutlineNode[]
}
interface PdfJsDocument {
  numPages: number
  getPage(n: number): Promise<PdfJsPage>
  getOutline(): Promise<PdfJsOutlineNode[] | null>
  getMetadata(): Promise<{ info?: { Title?: unknown }; metadata?: { get(name: string): unknown } | null }>
  loadingTask?: { destroy(): Promise<void> }
}

/** Limits one extraction runs under. */
export interface PdfExtractOptions {
  /** Abort → stop between pages and fail. */
  signal?: AbortSignal
  /** Wall-clock budget for reading pages (ms); pages left over are truncated. */
  timeBudgetMs?: number
  /** Stop reading pages once this many characters were collected. */
  maxChars?: number
  /** Page cap (defaults to {@link MAX_PDF_PAGES}). */
  maxPages?: number
}

/** Bold-looking PostScript font names (subset prefix already stripped). */
const BOLD_FONT_RE = /bold|black|heavy|semibold|demibold|demi\b|[-,]?medi(um)?\b|-B$|,B$|-SB$|CMBX|CMB\d|BX\d|\bHei\b|SimHei|Heiti|HTJ-|HT-|黑体/i
/** Monospace-looking font names. */
const MONO_FONT_RE = /mono|courier|consol|menlo|inconsolata|NimbusMonL|CMTT|SFTT|LMMono|SourceCodePro|FiraCode|DejaVuSansMono|LucidaConsole|Code/i

/**
 * Classify a pdf.js font object by its real (PostScript) name. pdf.js only
 * exposes the name after the page's operator list loaded the font, and only
 * with `fontExtraProperties`; anything unreadable classifies as regular.
 */
function classifyFont(page: PdfJsPage, loadedName: string | undefined, cache: Map<string, { bold: boolean; mono: boolean }>): { bold: boolean; mono: boolean } {
  if (loadedName === undefined) return { bold: false, mono: false }
  const cached = cache.get(loadedName)
  if (cached !== undefined) return cached
  let name = ''
  let flagsBold = false
  try {
    const font = page.commonObjs.get(loadedName) as { name?: string; bold?: boolean; isMonospace?: boolean; black?: boolean } | undefined
    name = (font?.name ?? '').replace(/^[A-Z]{6}\+/, '')
    flagsBold = font?.bold === true || font?.black === true
  } catch {
    // font not resolved (op list skipped/failed) — regular
  }
  // Monospace by NAME only: CJK fonts routinely set the FixedPitch flag, and
  // a Chinese paragraph is not a code block.
  const result = { bold: flagsBold || BOLD_FONT_RE.test(name), mono: MONO_FONT_RE.test(name) }
  cache.set(loadedName, result)
  return result
}

/** Flatten the outline tree (bounded) into `{ title, depth }` entries. */
function flattenOutline(nodes: PdfJsOutlineNode[] | null, depth = 0, out: PdfOutlineEntry[] = []): PdfOutlineEntry[] {
  if (nodes === null) return out
  for (const node of nodes) {
    if (out.length >= 2000) break
    const title = (node.title ?? '').replace(/\s+/g, ' ').trim()
    if (title !== '') out.push({ title, depth })
    if (node.items !== undefined && node.items.length > 0 && depth < 8) flattenOutline(node.items, depth + 1, out)
  }
  return out
}

/** Map a pdf.js load failure onto the provider's PDF error codes. */
function translatePdfError(error: unknown): WebError {
  if (error instanceof WebError) return error
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  if (name === 'PasswordException' || /password/i.test(message)) {
    return new WebError('the PDF is password-protected and cannot be read', WEB_PDF_ENCRYPTED_CODE, { cause: error })
  }
  return new WebError(`the PDF could not be parsed: ${message.split('\n')[0]!.slice(0, 200)}`, WEB_PDF_INVALID_CODE, { cause: error })
}

/**
 * Map Kangxi / CJK radical code points to the unified ideographs they look
 * like. Some producers (Chromium printing Noto CJK among them) write a
 * ToUnicode CMap that resolves 文 / 用 / 长 glyphs to U+2F42 ⽂ / U+2F64 ⽤
 * / U+2EA7 ⻓ — visually identical, but they break search and reading.
 * NFKC maps exactly these; it is applied to nothing else (fullwidth forms
 * stay as the document wrote them).
 */
function normalizeRadicals(text: string): string {
  return text.replace(/[\u2E80-\u2FDF]/g, ch => SIMPLIFIED_RADICALS[ch] ?? ch.normalize('NFKC'))
}

/**
 * The C-simplified radicals (CJK Radicals Supplement) have no NFKC mapping;
 * these are the ones that double as everyday simplified characters.
 */
const SIMPLIFIED_RADICALS: Record<string, string> = {
  '\u2EC5': '见', '\u2EC6': '角', '\u2EC8': '讠', '\u2EC9': '贝', '\u2ECB': '车', '\u2ED0': '钅',
  '\u2ED3': '长', '\u2ED4': '门', '\u2ED9': '韦', '\u2EDA': '页', '\u2EDB': '风', '\u2EDC': '飞',
  '\u2EE0': '饣', '\u2EE2': '马', '\u2EE5': '鱼', '\u2EE6': '鸟', '\u2EE7': '卤', '\u2EE8': '麦',
  '\u2EE9': '黄', '\u2EEA': '黾', '\u2EEC': '齐', '\u2EEE': '齿', '\u2EF0': '龙',
}

/** A run is horizontal when the text matrix has (almost) no rotation/skew. */
function isHorizontal(t: number[]): boolean {
  const [a = 0, b = 0, c = 0, d = 0] = t
  return Math.abs(b) <= Math.abs(a) * 0.1 + 1e-6 && Math.abs(c) <= Math.abs(d) * 0.1 + 1e-6 && a > 0 && d > 0
}

/**
 * Read a PDF's positioned text with pdf.js, page by page, inside the given
 * limits. Text items become {@link PdfTextRun}s (horizontal only — rotated
 * stamps and vertical margin text are dropped as layout noise).
 *
 * @returns the text model, plus whether a limit stopped reading early.
 */
export async function readPdfDocument(bytes: Uint8Array, options: PdfExtractOptions = {}): Promise<{ doc: PdfDocumentText; truncated: boolean }> {
  const startedAt = Date.now()
  const budget = options.timeBudgetMs ?? Number.POSITIVE_INFINITY
  const maxChars = options.maxChars ?? Number.POSITIVE_INFINITY
  const maxPages = options.maxPages ?? MAX_PDF_PAGES
  const { getDocumentProxy } = await import('unpdf')
  // pdf.js refuses Node `Buffer`s (and may detach what it is given): hand it
  // a private plain `Uint8Array` copy.
  const data = new Uint8Array(bytes.byteLength)
  data.set(bytes)
  let pdf: PdfJsDocument
  try {
    pdf = await getDocumentProxy(data, {
      // Real font names (bold / monospace detection) after the operator list.
      fontExtraProperties: true,
      // (pdf.js 6 no longer compiles font programs with `new Function`, so
      // there is no `isEvalSupported` switch left to turn off.)
      verbosity: 0,
      stopAtErrors: false,
    }) as unknown as PdfJsDocument
  } catch (error: unknown) {
    throw translatePdfError(error)
  }
  try {
    let title: string | undefined
    try {
      const meta = await pdf.getMetadata()
      const xmpTitle = meta.metadata?.get('dc:title')
      const infoTitle = meta.info?.Title
      const candidate = typeof xmpTitle === 'string' && xmpTitle.trim() !== '' ? xmpTitle : typeof infoTitle === 'string' ? infoTitle : ''
      if (candidate.trim() !== '') title = candidate.replace(/\s+/g, ' ').trim()
    } catch {
      // metadata is optional
    }
    let outline: PdfOutlineEntry[] = []
    try {
      outline = flattenOutline(await pdf.getOutline())
    } catch {
      // outline is optional
    }

    const pages: PdfPageText[] = []
    const fontCache = new Map<string, { bold: boolean; mono: boolean }>()
    let chars = 0
    let truncated = false
    const pageCount = pdf.numPages
    for (let n = 1; n <= pageCount; n++) {
      if (options.signal?.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new Error('pdf extraction aborted')
      if (n > maxPages || chars >= maxChars || Date.now() - startedAt >= budget) {
        truncated = true
        break
      }
      const page = await pdf.getPage(n)
      const content = await page.getTextContent()
      // Fonts resolve only through the operator list; skip it when time is
      // short (the layout then simply sees no bold/monospace on this page).
      if (Date.now() - startedAt < budget * 0.8) {
        try { await page.getOperatorList() } catch { /* fonts stay unknown */ }
      }
      const [, viewBottom = 0, , viewTop = 0] = page.view
      const runs: PdfTextRun[] = []
      for (const item of content.items) {
        if (typeof item.str !== 'string' || item.str === '' || item.transform === undefined) continue
        if (!isHorizontal(item.transform)) continue
        const t = item.transform
        const size = Math.hypot(t[2] ?? 0, t[3] ?? 0) || item.height || 0
        if (!(size > 0)) continue
        const font = classifyFont(page, item.fontName, fontCache)
        runs.push({ text: normalizeRadicals(item.str), x: t[4] ?? 0, y: t[5] ?? 0, width: item.width ?? 0, size, bold: font.bold, mono: font.mono })
        chars += item.str.length
      }
      pages.push({ number: n, bottom: Math.min(viewBottom, viewTop), height: Math.abs(viewTop - viewBottom) || 792, runs })
      page.cleanup()
    }
    return { doc: { ...(title !== undefined ? { title } : {}), outline, pages, totalPages: pageCount }, truncated }
  } catch (error: unknown) {
    if (options.signal?.aborted) throw error
    throw translatePdfError(error)
  } finally {
    // Destroying the loading task tears down the (in-process) worker too.
    void pdf.loadingTask?.destroy().catch(() => {})
  }
}

/**
 * Extract a PDF as markdown: read it with pdf.js inside the limits, lay it
 * out, and fail with {@link WEB_PDF_NO_TEXT_CODE} when there is no text layer
 * to speak of (a scan). Sizes beyond {@link MAX_PDF_BYTES} are refused.
 */
export async function extractPdfMarkdown(bytes: Uint8Array, options: PdfExtractOptions = {}): Promise<PdfExtraction> {
  if (bytes.length > MAX_PDF_BYTES) {
    throw new WebError(`the PDF is ${String(Math.round(bytes.length / 1024 / 1024))}MB, above the ${String(MAX_PDF_BYTES / 1024 / 1024)}MB limit`, WEB_PDF_TOO_LARGE_CODE)
  }
  const { doc, truncated } = await readPdfDocument(bytes, options)
  const textChars = doc.pages.reduce((sum, page) => sum + page.runs.reduce((s, run) => s + run.text.replace(/\s+/g, '').length, 0), 0)
  // A scan carries no (or a few stray) characters per page; a genuinely
  // short born-digital document ("Dummy PDF file") still clears this.
  if (doc.pages.length > 0 && textChars < Math.max(1, doc.pages.length * 5)) {
    throw new WebError(
      `the PDF has no extractable text layer (${String(doc.totalPages)} page(s), likely scanned images); OCR is not supported`,
      WEB_PDF_NO_TEXT_CODE,
    )
  }
  let markdown = layoutPdfMarkdown(doc)
  if (truncated) {
    markdown += `\n\n> [PDF extraction stopped after page ${String(doc.pages.length)} of ${String(doc.totalPages)} (size/time limit).]\n`
  }
  return { markdown, totalPages: doc.totalPages, pagesRead: doc.pages.length, truncated }
}

// ---------------------------------------------------------------------------
// Layout heuristics (pure)
// ---------------------------------------------------------------------------

/** CJK ideographs, kana, hangul, and fullwidth/CJK punctuation. */
const CJK_RE = /[⺀-⿿　-〿぀-ヿ㄀-ㇿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/

function isCjk(ch: string | undefined): boolean {
  return ch !== undefined && CJK_RE.test(ch)
}

/** Letter-spaced CJK ("预 防 和 治 理") reads as one word. */
function collapseCjkSpacing(text: string): string {
  return text.replace(new RegExp(`(?<=${CJK_RE.source}) +(?=${CJK_RE.source})`, 'g'), '')
}

/** A styled fragment of a line (for inline bold). */
interface Segment {
  text: string
  bold: boolean
}

/** One visual line. */
interface Line {
  page: number
  text: string
  segments: Segment[]
  x0: number
  x1: number
  y: number
  size: number
  bold: boolean
  mono: boolean
  /** Text cells separated by wide horizontal gaps (table-ish rows). */
  cells: string[]
  /** Left edge of each cell in {@link Line.cells}. */
  cellX: number[]
  /** Non-whitespace character count. */
  chars: number
  /** Position relative to the page box (0 = bottom, 1 = top). */
  relY: number
}

/** Group a page's runs into lines (content-stream order, baseline match). */
function buildLines(page: PdfPageText): Line[] {
  const groups: PdfTextRun[][] = []
  let current: PdfTextRun[] = []
  let baseY = 0
  let baseSize = 0
  for (const run of page.runs) {
    if (current.length > 0) {
      const tolerance = Math.max(0.6 * Math.max(run.size, baseSize), 1)
      if (Math.abs(run.y - baseY) <= tolerance) {
        current.push(run)
        if (run.text.trim() !== '' && run.size > baseSize) { baseSize = run.size; baseY = run.y }
        continue
      }
      groups.push(current)
    }
    current = [run]
    baseY = run.y
    baseSize = run.size
  }
  if (current.length > 0) groups.push(current)

  const lines: Line[] = []
  for (const group of groups) {
    const line = composeLine(group, page)
    if (line !== undefined) lines.push(line)
  }
  return lines
}

/** Join one baseline group's runs (x-sorted) into a {@link Line}. */
function composeLine(group: PdfTextRun[], page: PdfPageText): Line | undefined {
  const runs = [...group].sort((a, b) => a.x - b.x)
  const visible = runs.filter(run => run.text.trim() !== '')
  if (visible.length === 0) return undefined
  // Dominant size and baseline: the size carrying the most characters.
  const weight = new Map<number, number>()
  for (const run of visible) {
    const key = Math.round(run.size * 10) / 10
    weight.set(key, (weight.get(key) ?? 0) + run.text.trim().length)
  }
  let size = visible[0]!.size
  let best = -1
  for (const [key, w] of weight) if (w > best) { best = w; size = key }
  const baseline = visible.find(run => Math.abs(run.size - size) < 0.11)?.y ?? visible[0]!.y

  const segments: Segment[] = []
  const cells: string[] = ['']
  const cellX: number[] = []
  let text = ''
  let prevEnd: number | undefined
  let boldChars = 0
  let monoChars = 0
  let chars = 0
  for (const run of runs) {
    const content = run.text
    const trimmed = content.trim()
    if (trimmed === '') {
      // Whitespace runs only matter as separators; gaps are measured between
      // visible runs.
      continue
    }
    let sep = ''
    if (prevEnd !== undefined && text !== '') {
      const gap = run.x - prevEnd
      const last = text[text.length - 1]
      const first = trimmed[0]
      if (gap > run.size * 1.5 && !(isCjk(last) && isCjk(first) && gap < run.size * 3)) {
        cells.push('')
        cellX.push(run.x)
        sep = ' '
      } else if (gap > run.size * 0.15 || /\s$/.test(content.slice(0, content.length - content.trimStart().length)) || /^\s/.test(content)) {
        sep = isCjk(last) && isCjk(first) ? '' : ' '
      }
      if (/\s$/.test(text)) sep = ''
    }
    const piece = sep + trimmed
    if (cellX.length === 0) cellX.push(run.x)
    text += piece
    cells[cells.length - 1] += (cells[cells.length - 1] === '' ? trimmed : piece)
    const prev = segments[segments.length - 1]
    if (prev !== undefined && prev.bold === run.bold) prev.text += piece
    else segments.push({ text: piece, bold: run.bold })
    prevEnd = Math.max(prevEnd ?? -Infinity, run.x + run.width)
    const n = trimmed.replace(/\s+/g, '').length
    chars += n
    if (run.bold) boldChars += n
    if (run.mono) monoChars += n
  }
  text = collapseCjkSpacing(text.replace(/\s+/g, ' ').trim())
  if (text === '') return undefined
  for (const segment of segments) segment.text = collapseCjkSpacing(segment.text)
  const x0 = visible.reduce((m, run) => Math.min(m, run.x), Infinity)
  const x1 = visible.reduce((m, run) => Math.max(m, run.x + run.width), -Infinity)
  return {
    page: page.number,
    text,
    segments,
    x0,
    x1,
    y: baseline,
    size,
    bold: chars > 0 && boldChars / chars >= 0.8,
    mono: chars > 0 && monoChars / chars >= 0.8,
    cells: cells.map(cell => collapseCjkSpacing(cell.replace(/\s+/g, ' ').trim())),
    cellX,
    chars,
    relY: page.height > 0 ? (baseline - page.bottom) / page.height : 0.5,
  }
}

/** Bare page-number shapes found in page margins. */
const PAGE_NUMBER_RES = [
  /^[-–—\s]*(?:page|p\.|pág\.|seite)?\s*\d{1,4}(?:\s*(?:\/|of|von|de)\s*\d{1,4})?[-–—\s]*$/i,
  /^[-–—\s]*[ivxlcdm]{1,7}[-–—\s]*$/i,
  /^第\s*\d{1,4}\s*页(?:\s*[,，/／]?\s*共\s*\d{1,4}\s*页)?$/,
  // "— 12 —" (Chinese official documents), including the OCR misreading of
  // the dashes as 一 and fullwidth dash variants.
  /^[-–—一－―·•]{1,2}\s*\d{1,4}\s*[-–—一－―·•]{1,2}$/,
]

const isMarginLine = (line: Line): boolean => line.relY > 0.9 || line.relY < 0.12

/** Drop running headers/footers and page numbers. */
function removeMarginNoise(pages: Line[][]): Line[][] {
  const keyOf = (line: Line): string => line.text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim()
  const pagesByKey = new Map<string, Set<number>>()
  for (const lines of pages) {
    for (const line of lines) {
      if (!isMarginLine(line)) continue
      const key = keyOf(line)
      let set = pagesByKey.get(key)
      if (set === undefined) { set = new Set(); pagesByKey.set(key, set) }
      set.add(line.page)
    }
  }
  const repeatThreshold = Math.max(3, Math.ceil(pages.length * 0.3))
  return pages.map(lines => lines.filter((line) => {
    if (!isMarginLine(line)) return true
    const plain = line.text.normalize('NFKC')
    if (PAGE_NUMBER_RES.some(re => re.test(plain))) return false
    if (pages.length >= 3 && (pagesByKey.get(keyOf(line))?.size ?? 0) >= repeatThreshold) return false
    return true
  }))
}

/** Character-weighted mode of the line font sizes (0.5pt buckets). */
function bodySizeOf(lines: Line[]): number {
  const weight = new Map<number, number>()
  for (const line of lines) {
    const key = Math.round(line.size * 2) / 2
    weight.set(key, (weight.get(key) ?? 0) + line.chars)
  }
  let body = 10
  let best = -1
  for (const [key, w] of weight) if (w > best) { best = w; body = key }
  return body
}

/** Median baseline-to-baseline distance between consecutive body lines. */
function lineSpacingOf(pages: Line[][], body: number): number {
  const deltas: number[] = []
  for (const lines of pages) {
    for (let i = 1; i < lines.length; i++) {
      const a = lines[i - 1]!
      const b = lines[i]!
      if (Math.abs(a.size - body) > body * 0.1 || Math.abs(b.size - body) > body * 0.1) continue
      const dy = a.y - b.y
      if (dy > body * 0.6 && dy < body * 3) deltas.push(dy)
    }
  }
  if (deltas.length === 0) return body * 1.2
  deltas.sort((p, q) => p - q)
  return deltas[Math.floor(deltas.length / 2)]!
}

/** Normalization for comparing headings to outline titles. */
function headingKey(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
}

/** Leading section number ("3", "3.1", "A.2") stripped for outline matching. */
function stripNumbering(text: string): string {
  return text.replace(/^(?:\d+(?:\.\d+)*|[A-Z](?:\.\d+)+)\.?\s+/, '').replace(/^(?:第[一二三四五六七八九十百千零〇两\d]+[章节篇部]|[一二三四五六七八九十]+[、.．]|[（(][一二三四五六七八九十]+[）)])\s*/, '')
}

const NUMBERED_HEADING_RE = /^(\d{1,2}(?:\.\d{1,2}){0,4}|[A-Z](?:\.\d{1,2}){1,4})\.?\s+(?=\S)/
const CN_CHAPTER_RE = /^第[一二三四五六七八九十百千零〇两\d]+[章篇部]/
const CN_SECTION_RE = /^第[一二三四五六七八九十百千零〇两\d]+节/
const CN_ENUM_RE = /^[一二三四五六七八九十]{1,3}[、．]/
const CN_PAREN_ENUM_RE = /^[（(][一二三四五六七八九十]{1,3}[）)]/
/** A table-of-contents entry: leader dots (or a wide gap) then a page reference. */
const TOC_ENTRY_RE = /(?:[.…·．]\s*){4,}[^.…·．]{0,16}?[（(]?\s*[\d０-９ivxlc]+\s*[）)]?$/i
const EXPLICIT_HEADING_RES = [NUMBERED_HEADING_RE, CN_CHAPTER_RE, CN_SECTION_RE, CN_ENUM_RE, CN_PAREN_ENUM_RE]
const TERMINAL_RE = /[.!?。！？…:：;；"”’)）\]】]$/
const SENTENCE_END_RE = /[.!?。！？…"”’]$/

const BULLET_RE = /^(?:[•◦▪▫●○■□►▸‣⁃∙·*❖➢✓✔]|[])\s*/
const DASH_BULLET_RE = /^[-–—]\s+(?=\S)/
const ORDERED_RE = /^(\d{1,3})[.)]\s+(?=\S)/
const PAREN_ITEM_RE = /^(?:[（(](?:\d{1,3}|[a-zA-Z]|[ivx]{1,4})[）)]|[a-z][.)]|[①-⑳])\s*(?=\S)/

/** Markdown kinds a line can open. */
type BlockKind = 'heading' | 'bullet' | 'ordered' | 'item' | 'code' | 'text' | 'table'

interface Block {
  kind: BlockKind
  page: number
  level?: number
  lines: Line[]
}

interface LayoutStats {
  body: number
  spacing: number
  monoIsBody: boolean
  /** Heading font sizes, largest first (each rank is one heading level). */
  headingSizes: number[]
  /** Whether a dedicated document-title size exists (rank 0 = h1). */
  titleSize?: number
  outlineKeys: Map<string, number>
  /** 1 when the outline's single root is the document title (children → h2). */
  outlineOffset: number
}

/** Heading level placeholder: one below the most recent heading. */
const RELATIVE_HEADING = -1

/** Decide a line's heading level, if it is one. */
function headingLevel(line: Line, groupLines: Line[], stats: LayoutStats, standalone: boolean, styleRules: boolean): number | undefined {
  const text = groupLines.map(l => l.text).join(' ')
  const chars = groupLines.reduce((s, l) => s + l.chars, 0)
  if (chars === 0 || chars > 200 || !/\p{L}/u.test(text)) return undefined
  const words = text.split(/\s+/).length
  const sentenceLike = /[,，;；]$/.test(text) || (/[.。]$/.test(text) && !/^\d+(\.\d+)*\.?$/.test(text.split(' ')[0] ?? ''))
  // 1. The outline (bookmarks) — the author's own structure.
  if (stats.titleSize !== undefined && Math.abs(line.size - stats.titleSize) < 0.3 && groupLines.length <= 3 && styleRules) return 1
  const outlineDepth = stats.outlineKeys.get(headingKey(text)) ?? stats.outlineKeys.get(headingKey(stripNumbering(text)))
  if (outlineDepth !== undefined && chars <= 160) return Math.min(6, Math.max(2, outlineDepth + 2 - stats.outlineOffset))

  const bigger = line.size >= stats.body * 1.12
  const emphasized = bigger || line.bold
  // Table rows (wide column gaps) are never style-only headings.
  const styleOk = styleRules && groupLines.every(l => l.cells.length < 2)
  // 2. Section numbering.
  const numbered = NUMBERED_HEADING_RE.exec(text)
  if (numbered !== null && emphasized && !sentenceLike && words <= 16 && chars <= 120) {
    const depth = numbered[1]!.split('.').length
    return Math.min(6, depth + 1)
  }
  if (CN_CHAPTER_RE.test(text) && chars <= 60 && !sentenceLike) return 2
  if (CN_SECTION_RE.test(text) && chars <= 60 && !sentenceLike) return 3
  if (CN_ENUM_RE.test(text) && chars <= 40 && !/[。；;]$/.test(text) && (emphasized || standalone)) return 2
  if (CN_PAREN_ENUM_RE.test(text) && chars <= 30 && !/[。；;]$/.test(text) && (emphasized || standalone)) return 3
  if (!styleOk) return undefined
  // 3. Larger type, ranked.
  if (bigger && groupLines.length <= 3 && !sentenceLike) {
    if (stats.titleSize !== undefined && Math.abs(line.size - stats.titleSize) < 0.3) return 1
    const rank = stats.headingSizes.findIndex(size => Math.abs(size - Math.round(line.size * 2) / 2) < 0.3)
    return Math.min(4, 2 + Math.max(0, rank))
  }
  // 4. Standalone bold line at body size: a child of the current section
  // (resolved by the caller). A run-in heading — bold lead, regular text
  // after it on the same line — is a paragraph, not a heading.
  const lastSegment = groupLines[groupLines.length - 1]!.segments.at(-1)
  if (line.bold && lastSegment?.bold === true && standalone && groupLines.length <= 2 && chars <= 100 && words <= 14 && !sentenceLike && !TERMINAL_RE.test(text.replace(/[)）]$/, ''))) {
    return RELATIVE_HEADING
  }
  return undefined
}

/** Group lines into markdown blocks. */
function buildBlocks(pages: Line[][], stats: LayoutStats): Block[] {
  const all = pages.flat()
  const blocks: Block[] = []
  // Column right edge for a line: the widest line on the page starting near it.
  const rightEdge = new Map<Line, number>()
  for (const lines of pages) {
    for (const line of lines) {
      let right = line.x1
      for (const other of lines) {
        if (Math.abs(other.x0 - line.x0) < line.size * 3 && Math.abs(other.size - line.size) < line.size * 0.15) right = Math.max(right, other.x1)
      }
      rightEdge.set(line, right)
    }
  }
  const pitch = (line: Line): number => stats.spacing * (line.size / stats.body)
  const gapBefore = (i: number): number => {
    const prev = all[i - 1]
    const line = all[i]!
    if (prev === undefined || prev.page !== line.page) return Infinity
    return prev.y - line.y
  }
  const isStandalone = (i: number, span: number): boolean => {
    const before = gapBefore(i)
    const after = i + span < all.length ? gapBefore(i + span) : Infinity
    const first = all[i]!
    const sepBefore = before === Infinity || before < 0 || before > pitch(first) * 1.3 || all[i - 1]!.size !== first.size || all[i - 1]!.bold !== first.bold
    const next = all[i + span]
    const sepAfter = after === Infinity || after < 0 || after > pitch(first) * 1.3 || next === undefined || Math.abs(next.size - first.size) > 0.3
    const short = all[i + span - 1]!.x1 < (rightEdge.get(all[i + span - 1]!) ?? Infinity) - first.size * 2
    return (sepBefore && (sepAfter || short))
  }

  // A lone monospace line wedged into running text (a URL or identifier
  // the paragraph wrapped onto its own line) stays in the paragraph.
  const isInlineMono = (index: number): boolean => {
    const line = all[index]!
    const prev = all[index - 1]
    const next = all[index + 1]
    if (prev === undefined || prev.mono || next?.mono === true && next.page === line.page && gapBefore(index + 1) > 0 && gapBefore(index + 1) < pitch(line) * 2.2) return false
    const dy = gapBefore(index)
    return dy > 0 && dy < pitch(line) * 1.45 && !TERMINAL_RE.test(prev.text) && line.chars <= 80
  }
  // Tables: runs of consecutive multi-cell lines whose columns line up.
  // A justified line with wide word gaps has "cells" too, but no other row
  // shares its column starts.
  const tableEnd = new Map<number, number>()
  const inTable = new Set<number>()
  for (let start = 0; start < all.length;) {
    if (all[start]!.cells.length < 2 || all[start]!.mono) { start++; continue }
    let end = start + 1
    while (end < all.length && all[end]!.cells.length >= 2 && !all[end]!.mono && all[end]!.page === all[start]!.page
      && gapBefore(end) > 0 && gapBefore(end) < pitch(all[end]!) * 2.5) end++
    // Rows at either end that share no columns with the rest are not part
    // of the table (a justified line just above or below it).
    let first = start
    let last = end
    while (last - first >= 2 && !rowAligned(all[last - 1]!, all.slice(first, last - 1))) last--
    while (last - first >= 2 && !rowAligned(all[first]!, all.slice(first + 1, last))) first++
    if (last - first >= 2 && columnsAlign(all.slice(first, last))) {
      tableEnd.set(first, last)
      for (let k = first; k < last; k++) inTable.add(k)
    }
    start = end
  }
  let lastLevel = 1
  let i = 0
  while (i < all.length) {
    const line = all[i]!
    // Candidate heading group: consecutive lines of the same size/weight.
    let span = 1
    while (
      span < 4 && i + span < all.length
      && all[i + span]!.page === line.page
      && Math.abs(all[i + span]!.size - line.size) < 0.3
      && all[i + span]!.bold === line.bold
      && gapBefore(i + span) > 0 && gapBefore(i + span) < pitch(line) * 1.6
      && !EXPLICIT_HEADING_RES.some(re => re.test(all[i + span]!.text))
    ) span++
    let level: number | undefined
    let used = 0
    // Style rules (size / bold) judge the WHOLE same-style run — a slice of
    // a longer run is just its first lines (a 3-line notice in larger type
    // is not a heading plus a paragraph). Explicit signals (outline,
    // numbering) may still claim the first line alone.
    if (span <= 3) {
      level = headingLevel(line, all.slice(i, i + span), stats, isStandalone(i, span), true)
      if (level !== undefined) used = span
    }
    if (level === undefined && span > 1) {
      level = headingLevel(line, [line], stats, isStandalone(i, 1), false)
      if (level !== undefined) used = 1
    }
    if (level !== undefined && line.mono && !stats.monoIsBody) level = undefined
    if (level === RELATIVE_HEADING) level = Math.min(6, Math.max(2, lastLevel + 1))
    else if (level !== undefined) lastLevel = level
    if (level !== undefined) {
      blocks.push({ kind: 'heading', page: line.page, level, lines: all.slice(i, i + used) })
      i += used
      continue
    }

    const start = i
    const kind = tableEnd.has(i) ? 'table' : lineKind(line, stats)
    const block: Block = { kind: kind === 'code' && isInlineMono(i) ? 'text' : kind, page: line.page, lines: [line] }
    i++
    if (kind === 'table') {
      const end = tableEnd.get(start) ?? start + 1
      while (i < end) {
        block.lines.push(all[i]!)
        i++
      }
      blocks.push(block)
      continue
    }
    if (kind === 'code') {
      while (i < all.length && all[i]!.mono && gapBefore(i) > 0 && gapBefore(i) < pitch(all[i]!) * 2.2) {
        block.lines.push(all[i]!)
        i++
      }
      blocks.push(block)
      continue
    }
    let blockRight = rightEdge.get(line) ?? line.x1
    while (i < all.length) {
      const next = all[i]!
      const prev = block.lines[block.lines.length - 1]!
      if (inTable.has(i)) break
      const nextKind = lineKind(next, stats)
      if (nextKind !== 'text' && !(nextKind === 'code' && isInlineMono(i))) break
      if (Math.abs(next.size - prev.size) > Math.max(next.size, prev.size) * 0.12) break
      const dy = next.page === prev.page ? prev.y - next.y : -Infinity
      const sameFlow = dy > 0 && dy < pitch(next) * 1.45
      if (!sameFlow) {
        // A page or column change: continue only an unfinished sentence.
        if (dy > 0) break // a vertical gap inside the column
        if (TERMINAL_RE.test(prev.text)) break
        if (headingStartLike(next)) break
        if (next.page !== prev.page && block.kind !== 'text') break
      } else {
        // A table-of-contents entry is a line of its own.
        if (TOC_ENTRY_RE.test(prev.text)) break
        // First-line indent opens a paragraph: a full-measure line starting
        // further right after a line that finished (centered lines are inset
        // on both sides; a hanging-indent continuation follows an unfinished
        // line).
        if (next.x0 - prev.x0 > next.size * 0.8 && block.kind === 'text' && next.x1 >= blockRight - next.size * 2
          && (TERMINAL_RE.test(prev.text) || prev.x1 < blockRight - prev.size * 2)) break
        // List items continue only on their hanging indent.
        if (block.kind !== 'text' && next.x0 < block.lines[0]!.x0 + next.size * 0.3 && TERMINAL_RE.test(prev.text)) break
        // A short line that ends a sentence closes its paragraph.
        if (prev.x1 < blockRight - prev.size * 2.5 && SENTENCE_END_RE.test(prev.text)) break
        if (next.bold !== prev.bold && next.bold && next.chars < 100 && SENTENCE_END_RE.test(prev.text)) break
      }
      block.lines.push(next)
      blockRight = Math.max(blockRight, rightEdge.get(next) ?? next.x1)
      i++
    }
    blocks.push(block)
  }
  return blocks
}

/**
 * Whether table-candidate rows share column starts: at least 60% of the rows
 * have two or more cell left edges within one em of another row's.
 */
function columnsAlign(rows: Line[]): boolean {
  // Prose with a right-hand field label (forms: "Enter the amount . . . 3b $")
  // has two "columns", the first of them sentences — not a table.
  const firstCells = rows.map(row => row.cells.find(cell => cell !== '') ?? '').map(cell => cell.length).sort((a, b) => a - b)
  const maxCells = Math.max(...rows.map(row => row.cells.filter(cell => cell !== '').length))
  if (maxCells <= 2 && (firstCells[Math.floor(firstCells.length / 2)] ?? 0) > 50) return false
  const aligned = rows.filter(row => rowAligned(row, rows.filter(other => other !== row))).length
  return aligned / rows.length >= 0.6
}

/** Whether a row shares at least two column starts with some other row. */
function rowAligned(row: Line, others: Line[]): boolean {
  return others.some(other => row.cellX.filter(x => other.cellX.some(o => Math.abs(o - x) < row.size)).length >= 2)
}

/** A line that looks like the start of a new structural element. */
function headingStartLike(line: Line): boolean {
  return BULLET_RE.test(line.text) || ORDERED_RE.test(line.text) || CN_CHAPTER_RE.test(line.text)
}

/** Classify a non-heading line. */
function lineKind(line: Line, stats: LayoutStats): BlockKind {
  if (line.mono && !stats.monoIsBody) return 'code'
  if (BULLET_RE.test(line.text) && line.text.replace(BULLET_RE, '').trim() !== '') return 'bullet'
  if (DASH_BULLET_RE.test(line.text)) return 'bullet'
  if (ORDERED_RE.test(line.text)) return 'ordered'
  if (PAREN_ITEM_RE.test(line.text)) return 'item'
  return 'text'
}

/** Words seen in the document (lowercased), for de-hyphenation decisions. */
function vocabularyOf(lines: Line[]): Set<string> {
  const words = new Set<string>()
  for (const line of lines) {
    for (const match of line.text.matchAll(/[A-Za-z]+(?:-[A-Za-z]+)*/g)) {
      const word = match[0].toLowerCase()
      words.add(word)
      if (word.includes('-')) words.add(word.replace(/-/g, '\u0000'))
    }
  }
  return words
}

/** Join two consecutive lines of one paragraph. */
function joinText(acc: string, next: string, vocabulary: Set<string>): string {
  if (acc === '') return next
  const hyphen = /([A-Za-z]+)[-\u2010\u00AD]$/.exec(acc)
  const lead = /^([a-z]+)/.exec(next)
  if (hyphen !== null && lead !== null && !/\s[-\u2010\u00AD]$/.test(acc)) {
    const head = hyphen[1]!.toLowerCase()
    const tail = lead[1]!
    if (vocabulary.has(head + tail)) return acc.slice(0, -1) + next
    if (vocabulary.has(`${head}\u0000${tail}`)) return `${acc.slice(0, -1)}-${next}`
    return acc.slice(0, -1) + next
  }
  const last = acc[acc.length - 1]
  const first = next[0]
  if (isCjk(last) || isCjk(first)) {
    // Latin word followed by CJK across a break: no space either, the
    // original line break carried no space.
    return acc + next
  }
  if (/[-/]$/.test(acc)) return acc + next
  return `${acc} ${next}`
}

/** Escape what would otherwise read as markdown structure at a block start. */
function escapeLeading(text: string): string {
  return text.replace(/^(#{1,6}\s|>|[-+*]\s|\d{1,9}[.)]\s)/, '\\$1')
}

/** Render a line with inline bold (when only part of it is bold). */
function renderLine(line: Line, inlineBold: boolean): string {
  if (!inlineBold || !line.segments.some(s => s.bold) || line.segments.every(s => s.bold)) return line.text
  let out = ''
  for (const segment of line.segments) {
    const text = segment.text
    const core = text.trim()
    if (segment.bold && core.replace(/[^\p{L}\p{N}]/gu, '').length >= 2 && !/^\*|\*$/.test(core)) {
      const lead = text.slice(0, text.length - text.trimStart().length)
      const trail = text.slice(text.trimEnd().length)
      out += `${lead}**${core}**${trail}`
    } else {
      out += text
    }
  }
  return out.replace(/\s+/g, ' ').trim()
}

/**
 * Merge bold spans split only by whitespace or punctuation set in the
 * regular face ("**一是…会议**，**推动会议** **精神**" → one span): the
 * separator moves inside, and a line-break space between CJK spans goes.
 */
function mergeBoldRuns(text: string): string {
  return text.replace(/\*\*(\s*)([，、,;；：:]?)(\s*)\*\*/g, (match: string, a: string, punct: string, b: string, offset: number, whole: string) => {
    const before = whole[offset - 1]
    const after = whole[offset + match.length]
    const space = (a !== '' || b !== '') && !(isCjk(before) || isCjk(after) || isCjk(punct)) ? ' ' : ''
    return punct === '' ? space : `${punct}${b !== '' && !isCjk(punct) ? ' ' : ''}`
  })
}

/** Render a table block as GFM when its rows line up, else as plain rows. */
function renderTable(block: Block): string {
  const rows = block.lines.map(line => line.cells.filter(cell => cell !== '').map(cell => cell.replace(/\|/g, '\\|')))
  const width = Math.max(...rows.map(row => row.length))
  const aligned = rows.filter(row => row.length === width).length
  if (rows.length >= 2 && width >= 2 && aligned / rows.length >= 0.6) {
    const pad = (row: string[]): string => `| ${[...row, ...Array<string>(width - row.length).fill('')].slice(0, width).join(' | ')} |`
    return [pad(rows[0]!), `| ${Array<string>(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(pad)].join('\n')
  }
  return block.lines.map(line => escapeLeading(line.cells.join('  '))).join('  \n')
}

/** Whether a metadata title is worth printing as the document heading. */
function plausibleTitle(title: string | undefined): title is string {
  if (title === undefined) return false
  const t = title.trim()
  if (t.length < 3 || t.length > 250) return false
  if (/^(?:microsoft\s+(?:word|powerpoint|excel)\b|untitled|slide\s*\d|document\d*$|title$|no title|无标题)/i.test(t)) return false
  if (/\.(?:docx?|pdf|pptx?|xlsx?|tex|dvi|indd|qxd|rtf|odt)$/i.test(t)) return false
  if (/^[\w-]+$/.test(t) && !/\s/.test(t) && /\d/.test(t)) return false // file-name-like ids
  return true
}

/**
 * Lay a PDF's positioned text out as markdown (see the module docs for the
 * heuristics). Pure — no pdf.js — so the rules are unit-testable with
 * synthetic runs.
 */
export function layoutPdfMarkdown(doc: PdfDocumentText): string {
  const pages = removeMarginNoise(doc.pages.map(buildLines))
  const all = pages.flat()
  if (all.length === 0) return plausibleTitle(doc.title) ? `# ${doc.title}\n` : ''
  const body = bodySizeOf(all)
  const totalChars = all.reduce((s, l) => s + l.chars, 0)
  const monoChars = all.reduce((s, l) => s + (l.mono ? l.chars : 0), 0)
  const monoIsBody = monoChars > totalChars * 0.5

  // Heading sizes: larger-than-body sizes that only occur on short line runs.
  const sizeChars = new Map<number, number>()
  for (const line of all) {
    if (line.size < body * 1.12) continue
    const key = Math.round(line.size * 2) / 2
    sizeChars.set(key, (sizeChars.get(key) ?? 0) + line.chars)
  }
  let headingSizes = [...sizeChars.keys()].filter(size => (sizeChars.get(size) ?? 0) < Math.max(totalChars * 0.25, 400)).sort((a, b) => b - a)
  // The document title: the largest type on the first page, when it is
  // clearly display-sized and used for at most a few lines there.
  let titleSize: number | undefined
  const firstPage = doc.pages[0]?.number ?? 1
  const firstPageLines = all.filter(line => line.page === firstPage && /\p{L}{2}/u.test(line.text))
  const firstLargest = firstPageLines.reduce((m, line) => Math.max(m, Math.round(line.size * 2) / 2), 0)
  if (firstLargest >= body * 1.3) {
    const uses = firstPageLines.filter(line => Math.abs(Math.round(line.size * 2) / 2 - firstLargest) < 0.3)
    if (uses.length <= 3) {
      titleSize = firstLargest
      headingSizes = headingSizes.filter(size => size < firstLargest - 0.25)
    }
  }
  headingSizes = headingSizes.slice(0, 3)
  const outlineKeys = new Map<string, number>()
  for (const entry of doc.outline) {
    for (const key of [headingKey(entry.title), headingKey(stripNumbering(entry.title))]) {
      if (key.length >= 2 && !outlineKeys.has(key)) outlineKeys.set(key, entry.depth)
    }
  }
  const roots = doc.outline.filter(entry => entry.depth === 0)
  const titleKeys = new Set([doc.title ?? '', ...all.filter(line => titleSize !== undefined && Math.abs(line.size - titleSize) < 0.3).map(line => line.text)].map(headingKey))
  const outlineOffset = roots.length === 1 && titleKeys.has(headingKey(roots[0]!.title)) ? 1 : 0
  const stats: LayoutStats = { body, spacing: lineSpacingOf(pages, body), monoIsBody, headingSizes, ...(titleSize !== undefined ? { titleSize } : {}), outlineKeys, outlineOffset }
  const blocks = buildBlocks(pages, stats)
  const vocabulary = vocabularyOf(all)

  const out: string[] = []
  const metaKey = headingKey(doc.title ?? '')
  const hasTitleHeading = blocks.slice(0, 12).some(block => block.kind === 'heading' && (block.level === 1 || headingKey(block.lines.map(l => l.text).join('')) === metaKey))
  if (!hasTitleHeading && plausibleTitle(doc.title)) out.push(`# ${doc.title.replace(/\s+/g, ' ').trim()}`)
  let lastPage = 0
  for (const block of blocks) {
    if (block.page !== lastPage) {
      out.push(`<!-- page ${String(block.page)} -->`)
      lastPage = block.page
    }
    switch (block.kind) {
      case 'heading': {
        const text = block.lines.map(l => l.text).reduce((acc, t) => joinText(acc, t, vocabulary), '')
        out.push(`${'#'.repeat(block.level ?? 2)} ${text}`)
        break
      }
      case 'code': {
        const left = Math.min(...block.lines.map(l => l.x0))
        // Monospace: one character's advance, measured on the block itself.
        const advances = block.lines.filter(l => l.text.length >= 4).map(l => (l.x1 - l.x0) / l.text.length).sort((p, q) => p - q)
        const advance = advances[Math.floor(advances.length / 2)] ?? block.lines[0]!.size * 0.6
        const body = block.lines.map((l) => {
          const indent = Math.max(0, Math.round((l.x0 - left) / advance))
          return ' '.repeat(Math.min(indent, 40)) + l.text
        }).join('\n')
        out.push(`\`\`\`\n${body.replace(/```/g, '`​``')}\n\`\`\``)
        break
      }
      case 'table':
        out.push(renderTable(block))
        break
      default: {
        let text = ''
        for (const line of block.lines) text = joinText(text, renderLine(line, true), vocabulary)
        text = mergeBoldRuns(text)
        if (block.kind === 'bullet') {
          text = text.replace(BULLET_RE, '').replace(DASH_BULLET_RE, '')
          // A bullet list stays one list: no blank line between its items.
          const prev = out[out.length - 1]
          if (prev?.startsWith('- ') === true) out[out.length - 1] = `${prev}\n- ${text}`
          else out.push(`- ${text}`)
        } else if (block.kind === 'ordered') {
          const prev = out[out.length - 1]
          if (prev !== undefined && /^\d{1,3}\.\s/.test(prev)) out[out.length - 1] = `${prev}\n${text.replace(/^(\d{1,3})\)/, '$1.')}`
          else out.push(text.replace(/^(\d{1,3})\)/, '$1.'))
        } else {
          out.push(escapeLeading(text))
        }
      }
    }
  }
  return `${out.join('\n\n')}\n`
}
