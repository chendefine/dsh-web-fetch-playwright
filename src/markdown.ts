/**
 * The denoise pipeline: rendered HTML → sanitized article HTML → markdown.
 *
 * The classic stack, in order: jsdom parses the page Playwright rendered;
 * inline `data:` image payloads are elided to size placeholders (build
 * tools inline images as base64, which would otherwise dominate the body);
 * Mozilla Readability extracts the article (dropping nav bars, sidebars,
 * footers, and ad chrome by scoring link density and text mass) — its result
 * must then pass a coverage gate that distrusts tiny or sliver-thin
 * extractions, which on list-shaped pages (portals, catalogs) is exactly
 * what the link-density penalty leaves behind; DOMPurify sanitizes whatever
 * HTML remains and forbids the layout tags noise lives in; Turndown with
 * the GFM plugin converts to markdown using the same style options and
 * span-safe table rules as the shipped `dsh-tool-web` renderer, so output
 * is consistent with what `web_fetch` produces elsewhere.
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
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'
import { installBuiltinSlashResolveCompat } from './host-resolve-compat.ts'

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

/**
 * Tags whose subtrees are noise when measuring how much of a page an
 * extraction kept: DOMPurify drops these outright (`KEEP_CONTENT: false`),
 * and its default policy always removes `script`/`style` — so a text walk
 * that skips them measures what the sanitized document fallback could
 * actually return, not text that is already destined for deletion. Measuring
 * the raw body instead would let a huge `<nav>`/`<footer>` mass shrink an
 * article's honest coverage share and demote good extractions.
 */
const NOISE_SUBTREE_TAGS = new Set([...FORBID_TAGS, 'script', 'style'])

/**
 * A page must have at least this much visible (post-noise) text before the
 * article acceptance gate below has an opinion. Sparse pages — logins,
 * stubs, `login-like` fixtures — have nowhere for content to hide, so
 * Readability's pick, however short, is still the best reading of the page
 * and keeps flowing through the article path exactly as before.
 */
const GATE_MIN_BODY_TEXT_CHARS = 1_000

/**
 * Minimum non-whitespace characters a Readability extraction must carry
 * before it can be trusted as a page's content. Measured on the 163.com
 * homepage, the scorer's pick was a 96-character footer licensing block —
 * real articles and even sparse pages clear two-to-three times this bar,
 * while link-dense portal pages lose whole news columns to it.
 */
const GATE_MIN_ARTICLE_TEXT_CHARS = 250

/**
 * Minimum share of a page's visible text an extraction must cover to be
 * trusted. Measured separation on real pages is wide: portal homepages
 * (163 0.01, sina 0.03, sohu 0.02) vs article pages (0.28–0.45), so 10%
 * sits in an empty band with margin on both sides.
 */
const GATE_MIN_ARTICLE_COVERAGE = 0.1

/**
 * Count non-whitespace characters under `root`, skipping noise subtrees
 * ({@link NOISE_SUBTREE_TAGS}). Whitespace is ignored so CJK pages (no
 * spaces) and latin pages (space-separated) measure comparable densities,
 * mirroring how the extraction-quality ratios in the docs were computed.
 *
 * @param root - the subtree to measure; `null` counts as nothing.
 * @returns the number of non-whitespace characters in kept subtrees.
 */
function visibleTextLength(root: Node | null): number {
  if (root === null) return 0
  let length = 0
  const visit = (node: Node): void => {
    // Text nodes contribute their non-whitespace characters (nodeType 3).
    if (node.nodeType === 3) {
      length += (node.nodeValue ?? '').replace(/\s+/g, '').length
      return
    }
    // Only elements branch further (nodeType 1); comments and friends carry
    // no text, and noise subtrees are skipped wholesale.
    if (node.nodeType !== 1 || NOISE_SUBTREE_TAGS.has(node.nodeName.toLowerCase())) return
    for (let child = node.firstChild; child !== null; child = child.nextSibling) visit(child)
  }
  visit(root)
  return length
}

/**
 * Whether a Readability extraction is trustworthy as *the* content of the
 * page it came from — the acceptance gate that keeps list-shaped pages whole.
 *
 * Readability is an article extractor: it scores text mass and penalizes
 * link density, so on a portal/catalog page — where the content *is* the
 * links — every news column scores near zero, some sparse low-link block (a
 * footer licensing notice, a province-switcher popup) wins by default, and
 * Readability's own 500-char quality check cannot fail the parse because its
 * retry loop eventually returns the longest of its bad attempts. The plugin
 * used to accept any non-null result, so the 163.com homepage rendered as a
 * 162-character licensing fragment while 320 headlines were dropped — a
 * recall loss far worse than any precision the gate could cost.
 *
 * The gate therefore distrusts an extraction that is tiny in absolute terms
 * or covers a sliver of the page's visible text; the pipeline then falls
 * back to the sanitized whole document, which DOMPurify keeps clean and
 * which on such pages retains effectively all list content (measured 0%
 * text loss on the 163.com homepage). Only text-rich pages are gated
 * ({@link GATE_MIN_BODY_TEXT_CHARS}); below that, behavior is unchanged.
 *
 * @param articleHtml - the `article.content` HTML Readability produced.
 * @param document - the live document the article was extracted from.
 * @returns whether the article should flow through the article path.
 */
function articleCoversPage(articleHtml: string, document: Document): boolean {
  const bodyText = visibleTextLength(document.body)
  if (bodyText < GATE_MIN_BODY_TEXT_CHARS) return true
  const container = document.createElement('div')
  container.innerHTML = articleHtml
  const articleText = visibleTextLength(container)
  return articleText >= GATE_MIN_ARTICLE_TEXT_CHARS
    && articleText / bodyText >= GATE_MIN_ARTICLE_COVERAGE
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
   * `article` = Readability extraction that passed the coverage gate;
   * `document` = whole-document fallback (Readability returned nothing, or
   * the gate distrusted what it returned — list-shaped pages).
   */
  mode: DenoiseMode
}

/**
 * Convert one rendered HTML document to denoised markdown.
 *
 * Readability failure (non-article pages, or extractions the coverage gate
 * {@link articleCoversPage} distrusts) degrades to converting the sanitized
 * whole document — layout tags are still forbidden, so the fallback stays
 * cleaner than raw turndown, and a degraded page beats an error for a body
 * the browser already rendered.
 *
 * @param html - the rendered page HTML (`page.content()`).
 * @param url - the page URL, used to resolve relative links during parsing.
 * @returns the markdown and the extraction mode used.
 */
export function htmlToMarkdown(html: string, url: string): DenoiseResult {
  const { JSDOM, VirtualConsole } = loadJsdom()
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
    // Ungated readability: isProbablyReaderable is a conservative hint that
    // rejects sparse-but-real articles (measured on a browser-rendered fixture),
    // so the extraction is simply attempted; a null, empty, or gate-rejected
    // result falls back to the sanitized whole document below. parse() mutates,
    // hence the clone (typed as Document: DOM lib types cloneNode's return as
    // Node).
    const cloned = document.cloneNode(true) as typeof document
    const article = new Readability(cloned).parse()
    if (
      article !== null && typeof article.content === 'string' && article.content !== ''
      && articleCoversPage(article.content, document)
    ) {
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
