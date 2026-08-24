/**
 * The denoise pipeline: rendered HTML → sanitized article HTML → markdown.
 *
 * The classic stack, in order: jsdom parses the page Playwright rendered;
 * inline `data:` image payloads are elided to size placeholders (build
 * tools inline images as base64, which would otherwise dominate the body);
 * Mozilla Readability extracts the article (dropping nav bars, sidebars,
 * footers, and ad chrome by scoring link density and text mass); DOMPurify
 * sanitizes whatever HTML remains and forbids the layout tags noise lives in;
 * Turndown with the GFM plugin converts to markdown using the same style
 * options and span-safe table rules as the shipped `dsh-tool-web` renderer,
 * so output is consistent with what `web_fetch` produces elsewhere.
 *
 * Pure and synchronous — unit-tested against fixture pages.
 *
 * @module dsh-web-fetch-playwright/markdown
 */

import { JSDOM, VirtualConsole } from 'jsdom'
import createDOMPurify from 'dompurify'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'

/** Layout/noise tags DOMPurify removes outright (with their content). */
const FORBID_TAGS = [
  'nav', 'aside', 'header', 'footer', 'form', 'svg', 'iframe', 'noscript',
  'button', 'select', 'option', 'input', 'textarea', 'dialog', 'canvas',
  'video', 'audio', 'template',
]

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
  /** `article` = Readability extraction; `document` = whole-document fallback. */
  mode: DenoiseMode
}

/**
 * Convert one rendered HTML document to denoised markdown.
 *
 * Readability failure (non-article pages) degrades to converting the
 * sanitized whole document — layout tags are still forbidden, so the
 * fallback stays cleaner than raw turndown, and a degraded page beats an
 * error for a body the browser already rendered.
 *
 * @param html - the rendered page HTML (`page.content()`).
 * @param url - the page URL, used to resolve relative links during parsing.
 * @returns the markdown and the extraction mode used.
 */
export function htmlToMarkdown(html: string, url: string): DenoiseResult {
  // jsdom's virtual console defaults to forwarding parse noise; a silent one
  // keeps broken inline CSS on random pages out of host logs.
  const dom = new JSDOM(html, { url, virtualConsole: new VirtualConsole() })
  const purify = createDOMPurify(dom.window)
  const document = dom.window.document

  // Before anything downstream reads the DOM: shrink inline data-URI image
  // payloads to size placeholders. Mutating the live document here covers
  // both paths — the Readability clone below, and the document.body fallback
  // (innerHTML reflects the rewritten src) — while Turndown's default image
  // rule keeps handling alt/title escaping on the already-short src.
  elideDataUriImages(document)

  let source: string | null = null
  let title: string | undefined
  try {
    // Ungated: isProbablyReaderable is a conservative hint that rejects
    // sparse-but-real articles (measured on a browser-rendered fixture), so
    // the extraction is simply attempted; a null or empty result falls back
    // to the sanitized whole document below. parse() mutates, hence the clone
    // (typed as Document: DOM lib types cloneNode's return as Node).
    const cloned = document.cloneNode(true) as typeof document
    const article = new Readability(cloned).parse()
    if (article !== null && typeof article.content === 'string' && article.content !== '') {
      source = article.content
      title = article.title ?? undefined
    }
  } catch {
    // Readability throws on pathological DOMs; the whole-document path below
    // still returns something usable.
  }
  let mode: DenoiseMode = 'article'
  if (source === null) {
    mode = 'document'
    source = document.body?.innerHTML ?? ''
  }

  // KEEP_CONTENT: false is the load-bearing half of the denoise: DOMPurify
  // un-wraps forbidden tags but keeps their text by default, which would
  // leave nav/footer strings floating in the fallback path. With it, the
  // whole subtree of a forbidden element goes.
  const clean = purify.sanitize(source, { FORBID_TAGS, FORBID_ATTR, KEEP_CONTENT: false }) as string
  let markdown: string
  try {
    markdown = turndown.turndown(clean)
  } catch {
    markdown = dom.window.document.createElement('div').textContent ?? ''
  }
  // Collapse the runs of blank lines nested-list removal leaves behind, then
  // prepend the extracted title when the body did not open with one.
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim()
  const headingTitle = title?.trim()
  if (headingTitle !== undefined && headingTitle !== '' && !markdown.startsWith('# ')) {
    markdown = `# ${headingTitle}\n\n${markdown}`
  }
  return { markdown, mode }
}
