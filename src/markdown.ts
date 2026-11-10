/**
 * The denoise pipeline: rendered HTML → sanitized article HTML → markdown.
 *
 * Since 0.2.20 the pipeline is "propose, then select": jsdom parses the
 * page; inline `data:` image payloads are elided to size placeholders;
 * every extraction heuristic proposes a candidate (`./candidates.ts` —
 * Readability pruned/unpruned/lenient, the semantic main container, the
 * whole document with and without consent/chrome stripping, the repeated
 * record region, noscript-unwrapped variants, the Discourse preloaded post
 * stream) plus the block classifier's pick (`./blocks.ts`); DOMPurify
 * sanitizes each and forbids the layout tags noise lives in; a learned
 * selector (`./selector.ts`) estimates each candidate's quality from page-
 * and candidate-level features and the best one wins, with the 0.2.18
 * choice kept unless another candidate clearly beats it. Turndown with the
 * GFM plugin converts the winner using the same style options and span-safe
 * table rules as the shipped `dsh-tool-web` renderer.
 *
 * Synchronous for its callers and unit-tested against fixture pages: jsdom
 * itself is loaded lazily on the first call — and, inside a dsh profile, only
 * after `installBuiltinSlashResolveCompat`, so a host resolver that
 * mishandles tr46's `require("punycode/")` cannot take the plugin down.
 *
 * @module dsh-web-fetch-playwright/markdown
 */

import { createRequire } from 'node:module'
import createDOMPurify from 'dompurify'
import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'
import { installBuiltinSlashResolveCompat } from './host-resolve-compat.ts'
import { FORBID_TAGS, generateCandidates, type CandidateKind, type RawCandidate, visibleTextLength } from './candidates.ts'
import { candidateFeatures, type CandidateStats, measureCandidate, pageFeatures, scoreCandidate } from './selector.ts'
import { type Block, blockFeatures, blockKey, blockThreshold, classifyBlocks, hasBlockModel, renderBlocks, segmentBlocks } from './blocks.ts'

/** `createRequire` anchored at this module, so jsdom resolves from this install. */
const require_ = createRequire(import.meta.url)

/** The lazily loaded jsdom exports; jsdom is CommonJS, so loading stays synchronous. */
type JsdomModule = typeof import('jsdom')

/** Loaded jsdom module, cached after the first denoise. */
let jsdom: JsdomModule | undefined

/**
 * Load jsdom on first use, installing the host resolve compat first.
 *
 * Deferral serves two purposes: plugin activation never depends on jsdom's
 * import chain surviving the host's module-resolution interception, and the
 * compat shim — which must wrap the resolver *before* tr46's
 * `require("punycode/")` runs — gets a guaranteed installation point.
 * @returns the jsdom module exports.
 */
function loadJsdom(): JsdomModule {
  if (jsdom === undefined) {
    installBuiltinSlashResolveCompat()
    jsdom = require_('jsdom') as JsdomModule
  }
  return jsdom
}

/** Attributes stripped from sanitized output (styling survives as noise). */
const FORBID_ATTR = ['style', 'class', 'id', 'hidden', 'aria-hidden', 'role']

/**
 * Elide inline `data:` image payloads to `data:<mime>;base64,...<size>`.
 *
 * Build tools (Docusaurus/webpack, Hugo) inline images above a size cutoff
 * straight into the HTML as data URIs — measured on an onlyoffice.com docs
 * page, 12 inline PNGs were 21.6% of the HTML and, surviving Readability
 * (they are content), DOMPurify (img+data: is on its DATA_URI_TAGS
 * allowlist), and Turndown's default image rule, ended up **65% of the
 * returned markdown body**. Network-level filtering cannot touch them: a
 * data URI is never fetched, so the provider's subrequest abort misses it.
 * The placeholder keeps alt text, MIME type, and the approximate size, so
 * the model still knows an inline image existed. The marker is pure ASCII
 * because Readability re-resolves image srcs through `new URL()`, which
 * would percent-encode anything else.
 */
function elideDataUriImages(document: Document): void {
  for (const img of Array.from(document.querySelectorAll('img'))) {
    const src = img.getAttribute('src')
    if (src === null || !src.startsWith('data:')) continue
    img.setAttribute('src', dataUriPlaceholder(src))
  }
}

/**
 * Shorten one data URI to its header plus a size marker.
 * @param src - the original `data:` URI.
 * @returns e.g. `data:image/png;base64,...8.9KB` (base64 sizes are decoded
 * bytes; non-base64 payloads report their character count).
 */
function dataUriPlaceholder(src: string): string {
  const commaIndex = src.indexOf(',')
  const header = commaIndex === -1 ? src : src.slice(0, commaIndex + 1)
  const payload = commaIndex === -1 ? '' : src.slice(commaIndex + 1)
  const size = /;base64$/i.test(header.slice(5, -1))
    ? Math.max(0, Math.floor(payload.length / 4) * 3 - (payload.match(/=+$/)?.[0].length ?? 0))
    : payload.length
  return `${header}...${humanSize(size)}`
}

/** Render a byte count as `123B` / `8.9KB` / `1.2MB`. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1_048_576).toFixed(1)}MB`
}

/** The shared converter: same style options as `dsh-tool-web`'s renderer. */
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
})
turndown.use(gfm)
turndown.remove(['script', 'style', 'noscript'])

/** Render one GFM table cell without interpreting HTML span counts (tool-web parity). */
function renderTableCell(content: string, index: number): string {
  const prefix = index === 0 ? '| ' : ' '
  const escaped = content.trim().replace(/\n\r/g, '<br>').replace(/\n/g, '<br>').replace(/\|+/g, '\\|').padEnd(3, ' ')
  return `${prefix}${escaped} |`
}

/** Whether a row is the table's Markdown heading row (tool-web parity). */
function isTableHeadingRow(row: HTMLTableRowElement): boolean {
  const cells = Array.from(row.cells)
  const section = row.parentElement as HTMLTableSectionElement
  const table = section.parentElement as HTMLTableElement
  return (section.nodeName === 'THEAD' || table.rows[0] === row)
    && cells.every(cell => cell.nodeName === 'TH')
}

/** Map an HTML table-cell alignment to the GFM separator marker (tool-web parity). */
function tableBorder(cell: HTMLTableCellElement): string {
  const alignment = (cell.getAttribute('align') || cell.style.textAlign || '').toLowerCase()
  if (alignment === 'left') return ':---'
  if (alignment === 'right') return '---:'
  if (alignment === 'center') return ':---:'
  return '---'
}

turndown.addRule('tableCellWithoutSpanExpansion', {
  filter: ['th', 'td'],
  replacement(content, node) {
    const cell = node as HTMLTableCellElement
    const row = cell.parentNode as HTMLTableRowElement
    // GFM cannot represent spanning cells; ignoring colspan keeps conversion
    // work proportional to the source (tool-web's deliberate choice).
    return renderTableCell(content, Array.prototype.indexOf.call(row.childNodes, cell))
  },
})
turndown.addRule('tableRowWithoutSpanExpansion', {
  filter: 'tr',
  replacement(content, node) {
    const row = node as HTMLTableRowElement
    const border = isTableHeadingRow(row)
      ? Array.from(row.cells, (cell, index) => renderTableCell(tableBorder(cell), index)).join('')
      : ''
    return `\n${content}${border.length > 0 ? `\n${border}` : ''}`
  },
})

/** Which extraction path produced a result. */
export type DenoiseMode = 'article' | 'document'

/** One denoise pipeline outcome. */
export interface DenoiseResult {
  /** The markdown body (title, when found, already prepended). */
  markdown: string
  /**
   * `article` = a content-focused candidate (Readability, main container,
   * record region, forum post stream); `document` = a whole-document
   * candidate (sanitized body, optionally chrome-stripped).
   */
  mode: DenoiseMode
  /** The candidate strategy the selector picked. */
  strategy: CandidateKind
}

/** One candidate after sanitization, with its selector inputs. */
export interface ScoredCandidate {
  kind: CandidateKind
  title?: string
  legacy: boolean
  root: HTMLElement
  stats: CandidateStats
  vector: number[]
  score: number
}

const DOCUMENT_KINDS = new Set<CandidateKind>(['doc', 'docc', 'ns_doc'])

/** Everything one parse produced, before selection. */
interface Analysis {
  sanitized: { kind: CandidateKind, title?: string, legacy: boolean, root: HTMLElement, stats: CandidateStats }[]
  page: number[]
  blocks: Block[]
  blockVectors: number[][]
}

/**
 * Parse, generate candidates, sanitize and measure them, compute the page
 * features, and featurize the page's text blocks for the block classifier.
 */
function analyze(html: string, url: string): Analysis {
  const { JSDOM, VirtualConsole } = loadJsdom()
  // jsdom's virtual console defaults to forwarding parse noise; a silent one
  // keeps broken inline CSS on random pages out of host logs.
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() })
  const purify = createDOMPurify(dom.window)
  const document = dom.window.document
  // Before anything reads the DOM: shrink inline data-URI image payloads.
  elideDataUriImages(document)

  let generated: ReturnType<typeof generateCandidates>
  try {
    generated = generateCandidates(document)
  } catch {
    // Pathological DOMs: the whole document is still usable.
    generated = {
      candidates: [{ kind: 'doc', html: document.body?.innerHTML ?? '', legacy: true }],
      facts: { readabilityNull: true, gatePass: false, pruneChanged: false, noscriptText: 0, record: null, hasMain: false, hasPreloaded: false, main: null },
    }
  }
  const sanitize = (candidate: RawCandidate): Analysis['sanitized'][number] => {
    // KEEP_CONTENT: false is the load-bearing half of the denoise: DOMPurify
    // un-wraps forbidden tags but keeps their text by default; with it, the
    // whole subtree of a forbidden element goes.
    const root = purify.sanitize(candidate.html, { FORBID_TAGS, FORBID_ATTR, KEEP_CONTENT: false, RETURN_DOM: true }) as HTMLElement
    return { kind: candidate.kind, title: candidate.title, legacy: candidate.legacy, root, stats: measureCandidate(candidate.kind, candidate.legacy, root) }
  }
  const sanitized = generated.candidates.map(sanitize)
  const page = pageFeatures(document, url, generated.facts, sanitized.find(c => c.kind === 'doc')?.stats, visibleTextLength(document.body))

  let blocks: Block[] = []
  let blockVectors: number[][] = []
  if (document.body !== null) {
    try {
      blocks = segmentBlocks(document.body, generated.facts.main, new Set(generated.facts.record?.items ?? []))
        .filter(block => block.words > 0)
      const art = sanitized.find(c => c.kind === 'art')
      const artKeys = new Set(art === undefined ? [] : segmentBlocks(art.root).map(block => blockKey(block.text)))
      blockVectors = blockFeatures(blocks, artKeys).map(vector => [...page, ...vector])
    } catch {
      blocks = []
      blockVectors = []
    }
  }
  if (blocks.length > 0 && hasBlockModel()) {
    const threshold = blockThreshold()
    const keep = classifyBlocks(blockVectors).map(p => p >= threshold)
    if (keep.some(Boolean)) {
      const title = sanitized.find(c => c.title !== undefined)?.title
      sanitized.push(sanitize({ kind: 'blk', html: renderBlocks(blocks, keep), title, legacy: false }))
    }
  }
  return { sanitized, page, blocks, blockVectors }
}

/**
 * Parse, generate, sanitize, featurize, and score every candidate.
 * @returns candidates sorted by the selector's estimate, best first.
 */
export function scoreCandidates(html: string, url: string): ScoredCandidate[] {
  const { sanitized, page } = analyze(html, url)
  const allStats = sanitized.map(candidate => candidate.stats)
  const scored = sanitized.map(candidate => {
    const vector = [...page, ...candidateFeatures(candidate.stats, allStats)]
    return { ...candidate, vector, score: scoreCandidate(vector) }
  })
  // Stable: ties keep generation order (legacy-first preference).
  return scored.sort((a, b) => b.score - a.score)
}

/**
 * Block-classifier training rows for one page (benchmark tooling): every
 * text block's feature vector and its text, for labeling against ground
 * truth.
 */
export function blockTrainingRows(html: string, url: string): { vector: number[], text: string }[] {
  const { blocks, blockVectors } = analyze(html, url)
  return blocks.map((block, index) => ({ vector: blockVectors[index] ?? [], text: block.text }))
}

/** Render one sanitized candidate to markdown (title prepended when found). */
export function renderCandidate(candidate: Pick<ScoredCandidate, 'root' | 'title'>): string {
  let markdown: string
  try {
    markdown = turndown.turndown(candidate.root)
  } catch {
    markdown = candidate.root.textContent ?? ''
  }
  // Collapse the runs of blank lines nested-list removal leaves behind, then
  // prepend the extracted title when the body did not open with one.
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim()
  const headingTitle = candidate.title?.trim()
  if (headingTitle !== undefined && headingTitle !== '' && !markdown.startsWith('# ')) {
    markdown = `# ${headingTitle}\n\n${markdown}`
  }
  return markdown
}

/**
 * Convert one rendered HTML document to denoised markdown.
 *
 * Every extraction heuristic proposes a candidate (see `./candidates.ts`);
 * the learned selector (`./selector.ts`) estimates each candidate's quality
 * from page- and candidate-level features and the best one is rendered.
 *
 * @param html - the rendered page HTML (`page.content()`).
 * @param url - the page URL, used to resolve relative links during parsing.
 * @returns the markdown, the extraction mode, and the chosen strategy.
 */
export function htmlToMarkdown(html: string, url: string): DenoiseResult {
  const ranked = scoreCandidates(html, url)
  // An empty winner is never better than a non-empty runner-up for a caller
  // that already paid for a browser render.
  const best = ranked.find(candidate => candidate.stats.words > 0) ?? ranked[0]
  if (best === undefined) return { markdown: '', mode: 'document', strategy: 'doc' }
  return {
    markdown: renderCandidate(best),
    mode: DOCUMENT_KINDS.has(best.kind) ? 'document' : 'article',
    strategy: best.kind,
  }
}
