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
 * what the link-density penalty leaves behind; an accepted extraction is
 * then pruned of trailing link-dense sections — the post-article
 * recommendation rails and share bars the scorer's vocabularies cannot name
 * (they arrive as bare divs with no class to match); DOMPurify sanitizes
 * whatever HTML remains and forbids the layout tags noise lives in;
 * Turndown with the GFM plugin converts to markdown using the same style
 * options and span-safe table rules as the shipped `dsh-tool-web` renderer,
 * so output is consistent with what `web_fetch` produces elsewhere.
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
 * Count non-whitespace characters under `root` that sit inside an anchor,
 * skipping the same noise subtrees {@link visibleTextLength} skips so the
 * numerator and denominator of a link-density ratio stay comparable.
 *
 * @param root - the subtree to measure; `null` counts as nothing.
 * @returns the number of non-whitespace characters inside `<a>` descendants.
 */
function linkTextLength(root: Node | null): number {
  if (root === null) return 0
  let length = 0
  const visit = (node: Node, insideAnchor: boolean): void => {
    if (node.nodeType === 3) {
      if (insideAnchor) length += (node.nodeValue ?? '').replace(/\s+/g, '').length
      return
    }
    if (node.nodeType !== 1 || NOISE_SUBTREE_TAGS.has(node.nodeName.toLowerCase())) return
    const anchor = insideAnchor || node.nodeName.toLowerCase() === 'a'
    for (let child = node.firstChild; child !== null; child = child.nextSibling) visit(child, anchor)
  }
  visit(root, false)
  return length
}

/**
 * Minimum non-whitespace characters a block must carry before its link
 * density is even evaluated. Blocks below this are spacers, empty wrappers,
 * or one-line sign-offs — too small to be worth a removal decision, so the
 * trailing walk skips past them instead of stopping at them.
 */
const TRAILING_MIN_TEXT_CHARS = 40

/**
 * Link-density share above which a trailing block reads as a link farm:
 * recommendation feeds, related-article rails, tag clouds, share bars.
 * Measured on the 163.com dy-article badcase the section's pick carried 84
 * linked characters inside 183 total (0.46) — recommendation cards dilute
 * their density with author/date lines, so a 0.5 bar would miss them by
 * construction; an honest closing paragraph with a citation or two measures
 * 0.1–0.3, leaving 0.4 in the empty band between.
 */
const TRAILING_LINK_DENSITY = 0.4

/**
 * A trailing block qualifies as a link farm only when it is link-heavy in
 * aggregate too: at least {@link TRAILING_LINK_COUNT} anchors or
 * {@link TRAILING_LINK_TEXT_CHARS} linked characters. Density alone would
 * let a single long linked sentence (an inline citation) drag a legitimate
 * paragraph under the knife.
 */
const TRAILING_LINK_COUNT = 3
const TRAILING_LINK_TEXT_CHARS = 60

/**
 * A trailing block may never hold more than this share of the whole
 * article's text. The prune targets *appended* widgets; a block that IS most
 * of the extraction says the scorer picked the widget, which is the coverage
 * gate's failure mode to handle, not this walk's.
 */
const TRAILING_MAX_ARTICLE_SHARE = 0.6

/**
 * A trailing run may never hold more than this share of its container's
 * text — the aggregate form of the guard above, and the one that keeps
 * list-shaped extractions whole. A recommendation rail is a *minority*
 * appended to real content (the 163 rail is 44% of its container); a
 * portal or feed whose extraction IS a list of link rows (measured on a
 * Hacker News homepage capture: ~91 trailing rows, every one individually
 * link-dense at 0.69–0.94) has a tail run holding ~97% of the container —
 * there the tail IS the content, the walk declines wholesale, and only a
 * run that is a minority of its container is removed.
 */
const TRAILING_MAX_RUN_SHARE = 0.6

/**
 * Link-density band within which a run and the block the walk stopped at
 * read as the same material. When the content immediately before the run
 * is itself as link-dense as the run — measured on a Hacker News homepage
 * capture, the rows after the run's cut measure 0.94 against the run's
 * 0.91 — the container is a *uniform list* (feed rows, portal headlines)
 * and the tail is that list's own content, not a widget appended after it;
 * a widget hangs after genuinely different material (the 163 rail's 0.44
 * follows body text at 0.00). Only a run denser than what precedes it is
 * removed.
 */
const TRAILING_UNIFORM_DENSITY_BAND = 0.25

/**
 * Prune trailing link-dense sections from an accepted Readability
 * extraction — the post-article widget class the scorer itself cannot be
 * taught to drop.
 *
 * Why this exists (badcase: `https://www.163.com/dy/article/…`): Chinese
 * portal article pages append a recommendation feed inside the very wrapper
 * Readability scores as the article (`#content` holds the body, the
 * platform disclaimer, then a rail of image/title/author/date cards). Every
 * existing noise layer misses it: Readability's `unlikelyCandidates` /
 * `negative` vocabularies know `related` but not `recommend` (nor the
 * pinyin families `tuijian`/`xiangguan`), and its own cleaning pass draws
 * the "mostly links" line at per-block density 0.5 — these cards measure
 * 0.42–0.48 (the title links over title+author+date text), so every card
 * clears it; in the extracted HTML the rail is a *bare* div — class and id
 * are gone — so no class-based rule can ever see it again; DOMPurify's
 * FORBID_TAGS works on tags, and the rail is plain div/p/h3/a; and the
 * coverage gate cannot help because the noise rides *inside* the
 * extraction it measures (the badcase passed at 0.103 — the rail's text
 * was in both numerator and denominator). Modern sites with CSS-module
 * class names (`css-1b3x7r`) present the same shape with no vocabulary to
 * match at all, so the only signal that survives all of this is
 * structural: a *trailing* run of blocks whose text is mostly links.
 *
 * For every container in the extraction the walk gathers the maximal
 * trailing run of qualifying children — link-farm blocks per the constants
 * above, plus sub-threshold spacers (empty wrapper divs) — and removes the
 * run only when BOTH structural guards say "appended widget, not content":
 * the run is a minority of the container's text
 * ({@link TRAILING_MAX_RUN_SHARE}), and the run is clearly denser than the
 * block the walk stopped at ({@link TRAILING_UNIFORM_DENSITY_BAND}). The
 * guards split the two worlds the per-block view cannot: a rail is
 * one-or-few appended blocks after genuinely different material (the 163
 * rail's 0.44 density follows body text at 0.00), while a link-list
 * extraction — feed rows, portal headlines — is *uniform*: its rows before
 * any cut measure the same density as the rows after it (0.91 vs 0.94 on
 * the Hacker News capture), so no tail of it can be mistaken for a widget.
 *
 * Deliberately NOT applied to the whole-document fallback: that path
 * exists for list-shaped pages where the links *are* the content (the
 * 163.com homepage fix), and pruning link-dense regions there would
 * re-introduce exactly the recall loss the coverage gate exists to
 * prevent.
 *
 * @param container - parsed `article.content`; mutated in place.
 */
function pruneTrailingLinkDenseSections(container: Element): void {
  const articleText = visibleTextLength(container)
  if (articleText === 0) return
  // The container itself leads the walk — Readability usually wraps its
  // content in div#readability-page-1, but an unwrapped extraction's
  // top-level blocks are the container's direct children and must be
  // examined too. querySelectorAll snapshots before any removal; entries
  // inside an already-removed subtree are skipped by the contains() check,
  // and parents are visited before children, so a deeper run inside a block
  // an outer run is taking never competes with it.
  for (const element of [container, ...Array.from(container.querySelectorAll('*'))]) {
    if (!container.contains(element) && element !== container) continue
    removeTrailingLinkDenseRun(element, articleText)
  }
}

/**
 * Remove one container's maximal trailing run of link-dense children when
 * that run is a minority of the container's text AND clearly different
 * material from the content that precedes it.
 *
 * @param parent - the container whose element children are examined from
 * the end.
 * @param articleText - the whole article's text, for the per-block share
 * guard.
 */
function removeTrailingLinkDenseRun(parent: Element, articleText: number): void {
  const children = Array.from(parent.children)
  if (children.length === 0) return
  const containerText = visibleTextLength(parent)
  if (containerText === 0) return
  const run: Element[] = []
  let runText = 0
  let runLinked = 0
  let stopIndex = -1
  for (let index = children.length - 1; index >= 0; index--) {
    const child = children[index]
    if (child === undefined) break
    const text = visibleTextLength(child)
    // Too small to judge (spacer, empty wrapper): it belongs to the run
    // but cannot extend it — keep walking toward earlier siblings.
    if (text < TRAILING_MIN_TEXT_CHARS) {
      run.push(child)
      continue
    }
    const linked = linkTextLength(child)
    const linkCount = child.querySelectorAll('a').length
    if (
      linked / text >= TRAILING_LINK_DENSITY
      && (linkCount >= TRAILING_LINK_COUNT || linked >= TRAILING_LINK_TEXT_CHARS)
      && text <= TRAILING_MAX_ARTICLE_SHARE * articleText
    ) {
      run.push(child)
      runText += text
      runLinked += linked
      continue
    }
    // Real content that is not a link farm: everything before it is
    // anchored by actual article flow — stop and compare against it.
    stopIndex = index
    break
  }
  if (runText === 0 || stopIndex === -1) {
    // Nothing to remove — or the run reached the top of the container (no
    // preceding content to differ from): a tail that IS the whole
    // container is list content, never a widget.
    return
  }
  // The tail is the same material as what precedes it (a uniform list's
  // rows): decline wholesale.
  const stopChild = children[stopIndex]
  if (stopChild === undefined) return
  const stopDensity = linkTextLength(stopChild) / Math.max(1, visibleTextLength(stopChild))
  if (Math.abs(runLinked / runText - stopDensity) <= TRAILING_UNIFORM_DENSITY_BAND) return
  // The tail holds most of the container (a link-list page's rows): decline
  // wholesale.
  if (runText > TRAILING_MAX_RUN_SHARE * containerText) return
  for (const child of run) child.remove()
}

/**
 * Run {@link pruneTrailingLinkDenseSections} over one extraction with a
 * misfire guard: a prune that takes a healthy article below the gate's
 * absolute floor ({@link GATE_MIN_ARTICLE_TEXT_CHARS}) or empties it
 * entirely says the walk misread the page, and Readability's original pick
 * is returned untouched. A *sparse* article (under the floor before the
 * prune, auto-trusted by the gate) keeps its pruned form — its trailing
 * links were noise all the same.
 *
 * @param articleHtml - the `article.content` HTML Readability produced.
 * @param document - the live document, for parsing the fragment.
 * @returns the pruned article HTML, or the original on a misfire.
 */
function prunedArticleContent(articleHtml: string, document: Document): string {
  const container = document.createElement('div')
  container.innerHTML = articleHtml
  const before = visibleTextLength(container)
  if (before === 0) return articleHtml
  pruneTrailingLinkDenseSections(container)
  const after = visibleTextLength(container)
  if (after === 0 || (before >= GATE_MIN_ARTICLE_TEXT_CHARS && after < GATE_MIN_ARTICLE_TEXT_CHARS)) {
    return articleHtml
  }
  return container.innerHTML
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
      // Gate first, prune second, and in that order on purpose: the gate
      // must judge Readability's pick as delivered (the widget rides inside
      // it), and the prune then strips the post-article link farms the
      // scorer could not be taught — see pruneTrailingLinkDenseSections.
      source = prunedArticleContent(article.content, document)
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
