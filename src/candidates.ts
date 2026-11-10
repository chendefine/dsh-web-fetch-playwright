/**
 * Candidate generation for the denoise pipeline.
 *
 * The pipeline used to be ONE chain of hard decisions (Readability → coverage
 * gate → trailing prune → whole-document fallback), each tuned by a global
 * threshold. Every page shape that disagrees with a threshold's notion of
 * "content" (link-dense docs indexes vs. recommendation rails, noscript
 * server fallbacks on forums vs. lazy-image wrappers elsewhere) turned each
 * fix into a regression somewhere else. Here every heuristic instead
 * *proposes* a candidate extraction, and a learned selector
 * (`./selector.ts`) picks one per page from page-level and candidate-level
 * features — adding a heuristic can only add an option, never silently
 * override the others.
 *
 * Candidates (see {@link CandidateKind}):
 * - `art`    Readability, trailing link farms pruned (the 0.2.18 article path)
 * - `artu`   Readability unpruned (link directories that ARE content)
 * - `artx`   Readability with a lenient link-density modifier
 * - `main`   the page's semantic main container (`<main>`, `[role=main]`, …)
 * - `doc`    the whole sanitized document (the 0.2.18 fallback)
 * - `docc`   the whole document minus consent/cookie banners, hidden and
 *            chrome-classed subtrees
 * - `rec`    the dominant repeated-record region (product cards, list rows)
 * - `ns_art` / `ns_doc`  the same two paths after unwrapping `<noscript>`
 *            server fallbacks (Discourse and friends ship their whole thread
 *            there for script-less clients)
 * - `pre`    Discourse `data-preloaded` post stream
 * - `blk`    blocks kept by the block classifier (`./blocks.ts`), added by
 *            the orchestrator once page features exist
 *
 * @module dsh-web-fetch-playwright/candidates
 */

import { Readability } from '@mozilla/readability'

/** Every candidate extraction strategy, in the selector's one-hot order. */
export const CANDIDATE_KINDS = ['art', 'artu', 'artx', 'main', 'doc', 'docc', 'rec', 'ns_art', 'ns_doc', 'pre', 'blk'] as const
export type CandidateKind = typeof CANDIDATE_KINDS[number]

/** One proposed extraction, still as (unsanitized) HTML. */
export interface RawCandidate {
  kind: CandidateKind
  /** HTML of the extraction; sanitized by the caller. */
  html: string
  /** Title to prepend when the body does not open with a heading. */
  title?: string
  /** Whether the 0.2.18 pipeline would have returned exactly this candidate. */
  legacy: boolean
}

/** Layout/noise tags DOMPurify removes outright (with their content). */
export const FORBID_TAGS = [
  'nav', 'aside', 'header', 'footer', 'form', 'svg', 'iframe', 'noscript',
  'button', 'select', 'option', 'input', 'textarea', 'dialog', 'canvas',
  'video', 'audio', 'template',
]

/** Tags whose subtrees never count as visible text. */
export const NOISE_SUBTREE_TAGS = new Set([...FORBID_TAGS, 'script', 'style'])

// ---------------------------------------------------------------- text ----

/**
 * Count non-whitespace characters under `root`, skipping noise subtrees.
 * Whitespace is ignored so CJK and latin pages measure comparable densities.
 */
export function visibleTextLength(root: Node | null, skip: Set<string> = NOISE_SUBTREE_TAGS): number {
  if (root === null) return 0
  let length = 0
  const visit = (node: Node): void => {
    if (node.nodeType === 3) {
      length += (node.nodeValue ?? '').replace(/\s+/g, '').length
      return
    }
    if (node.nodeType !== 1 || skip.has(node.nodeName.toLowerCase())) return
    for (let child = node.firstChild; child !== null; child = child.nextSibling) visit(child)
  }
  visit(root)
  return length
}

/** Count non-whitespace characters under `root` that sit inside an anchor. */
export function linkTextLength(root: Node | null): number {
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

// ------------------------------------------------------- coverage gate ----

/** Below this much visible page text the gate trusts any extraction. */
const GATE_MIN_BODY_TEXT_CHARS = 1_000
/** Minimum characters a trusted Readability extraction carries. */
export const GATE_MIN_ARTICLE_TEXT_CHARS = 250
/** Minimum share of the page's visible text a trusted extraction covers. */
const GATE_MIN_ARTICLE_COVERAGE = 0.1

/**
 * The 0.2.18 acceptance gate: distrust an extraction that is tiny in absolute
 * terms or covers a sliver of the page's visible text. Kept as a selector
 * feature and as the legacy-choice marker; it no longer decides alone.
 */
export function articleCoversPage(articleHtml: string, document: Document): boolean {
  const bodyText = visibleTextLength(document.body)
  if (bodyText < GATE_MIN_BODY_TEXT_CHARS) return true
  const container = document.createElement('div')
  container.innerHTML = articleHtml
  const articleText = visibleTextLength(container)
  return articleText >= GATE_MIN_ARTICLE_TEXT_CHARS
    && articleText / bodyText >= GATE_MIN_ARTICLE_COVERAGE
}

// ------------------------------------------------------ trailing prune ----

const TRAILING_MIN_TEXT_CHARS = 40
const TRAILING_LINK_DENSITY = 0.4
const TRAILING_LINK_COUNT = 3
const TRAILING_LINK_TEXT_CHARS = 60
const TRAILING_MAX_ARTICLE_SHARE = 0.6
const TRAILING_MAX_RUN_SHARE = 0.6
const TRAILING_UNIFORM_DENSITY_BAND = 0.25

/**
 * Prune trailing link-dense sections (recommendation rails, share bars) from
 * a Readability extraction — the 0.2.18 heuristic (see CHANGELOG 0.2.18 for
 * the 163.com badcase and the Hacker News guards). Since 0.2.20 its output is
 * one candidate (`art`) beside the unpruned extraction (`artu`), so pages
 * whose trailing link block IS content (docs indexes, contributor lists) are
 * no longer forced through it.
 */
function pruneTrailingLinkDenseSections(container: Element): void {
  const articleText = visibleTextLength(container)
  if (articleText === 0) return
  for (const element of [container, ...Array.from(container.querySelectorAll('*'))]) {
    if (!container.contains(element) && element !== container) continue
    removeTrailingLinkDenseRun(element, articleText)
  }
}

function removeTrailingLinkDenseRun(parent: Element, articleText: number): void {
  const children = childElements(parent)
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
    stopIndex = index
    break
  }
  if (runText === 0 || stopIndex === -1) return
  const stopChild = children[stopIndex]
  if (stopChild === undefined) return
  const stopDensity = linkTextLength(stopChild) / Math.max(1, visibleTextLength(stopChild))
  if (Math.abs(runLinked / runText - stopDensity) <= TRAILING_UNIFORM_DENSITY_BAND) return
  if (runText > TRAILING_MAX_RUN_SHARE * containerText) return
  for (const child of run) child.remove()
}

/** Prune with the 0.2.18 misfire guard; returns the original on a misfire. */
export function prunedArticleContent(articleHtml: string, document: Document): string {
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

// ------------------------------------------------------------ helpers ----

/**
 * An element's element children as an array. Walks sibling pointers:
 * jsdom's `HTMLCollection` is a proxy whose indexed access dominates
 * profiles when `Array.from(el.children)` runs on every element of a large
 * page (measured: 5.2s for a 4,000-paragraph article).
 */
export function childElements(element: Element): Element[] {
  const out: Element[] = []
  for (let child = element.firstElementChild; child !== null; child = child.nextElementSibling) out.push(child)
  return out
}

interface ReadabilityPick { content: string, title?: string }

/** Run Readability on a clone of `document`; null on failure/empty. */
function runReadability(document: Document, options?: ConstructorParameters<typeof Readability>[1]): ReadabilityPick | null {
  try {
    const cloned = document.cloneNode(true) as Document
    const article = new Readability(cloned, options).parse()
    if (article === null || typeof article.content !== 'string' || article.content === '') return null
    return { content: article.content, title: article.title ?? undefined }
  } catch {
    return null
  }
}

/**
 * Rewrite every `<noscript>` into a `<div>` holding its markup.
 *
 * Script-less parsing (jsdom, static snapshots) exposes noscript content as
 * markup that DOMPurify and Readability then delete wholesale — on Discourse
 * that is the entire server-rendered thread, measured 16–36KB per page.
 * Scripting-enabled parsing leaves it as one raw text node, which is
 * reparsed here so both parser modes converge.
 */
export function unwrapNoscripts(document: Document): number {
  let count = 0
  for (const noscript of Array.from(document.querySelectorAll('noscript'))) {
    const div = document.createElement('div')
    const onlyText = noscript.children.length === 0
    if (onlyText) div.innerHTML = noscript.textContent ?? ''
    else while (noscript.firstChild !== null) div.appendChild(noscript.firstChild)
    noscript.replaceWith(div)
    count++
  }
  return count
}

/** Visible text inside `<noscript>` elements (parsed either way). */
export function noscriptTextLength(document: Document): number {
  let total = 0
  for (const noscript of Array.from(document.querySelectorAll('noscript'))) {
    if (noscript.children.length === 0) {
      const div = document.createElement('div')
      div.innerHTML = noscript.textContent ?? ''
      total += visibleTextLength(div)
    } else {
      total += visibleTextLength(noscript, new Set(['script', 'style']))
    }
  }
  return total
}

/** Semantic main-container selectors, most specific first. */
const MAIN_SELECTORS = [
  'main', '[role="main"]', '#main-content', '#maincontent', '#main', '.main-content',
  '#content', '#primary', '.content',
]

/** Find the page's semantic main container, if it carries real text. */
function findMainContainer(document: Document): Element | null {
  const articles = document.querySelectorAll('article')
  for (const selector of MAIN_SELECTORS) {
    const element = document.querySelector(selector)
    if (element !== null && visibleTextLength(element) >= 200) return element
  }
  if (articles.length === 1 && articles[0] !== undefined && visibleTextLength(articles[0]) >= 200) return articles[0]
  return null
}

/** Sub-tokens of class/id names that mark page chrome, not content. */
const CHROME_TOKENS = new Set([
  'cookie', 'cookies', 'cookiebar', 'consent', 'gdpr', 'onetrust', 'cmp', 'ccpa',
  'newsletter', 'subscribe', 'popup', 'modal', 'overlay', 'lightbox', 'skip', 'skiplink',
  'breadcrumb', 'breadcrumbs', 'share', 'sharing', 'social', 'socials', 'advert',
  'advertisement', 'ads', 'ad', 'sponsor', 'sponsored', 'navbar', 'navigation', 'megamenu',
  'menu', 'sidebar', 'promo', 'banner', 'toast', 'drawer', 'offcanvas',
])

const CHROME_ROLES = new Set(['navigation', 'dialog', 'alertdialog', 'complementary', 'contentinfo', 'search', 'banner'])

/** Cookie/consent banner wording (EN/DE/FR/ES/IT/NL/ZH). */
const CONSENT_TEXT = /\b(cookies?|consent|datenschutz\w*|einwilligung|zustimm\w*|akzeptier\w*|privacy|gdpr|rgpd)\b|隐私|同意/i
const CONSENT_ACTION = /\b(accept|agree|allow|reject|decline|manage|preferences|settings|akzeptieren|zustimmen|einverstanden|ablehnen|accepter|aceptar|accetta|accepteren)\b|接受|同意/i

function isChromeElement(element: Element): boolean {
  const role = element.getAttribute('role')
  if (role !== null && CHROME_ROLES.has(role.toLowerCase())) return true
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true' || element.getAttribute('aria-modal') === 'true') return true
  const style = element.getAttribute('style')
  if (style !== null && /(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) return true
  const names = `${element.getAttribute('class') ?? ''} ${element.id}`.toLowerCase()
  if (names.trim() === '') return false
  for (const token of names.split(/[\s_-]+/)) {
    if (CHROME_TOKENS.has(token)) return true
  }
  return false
}

/**
 * Strip page chrome from a cloned body: chrome-named/roled subtrees, hidden
 * subtrees, and consent banners recognised by their wording. A subtree is
 * only removed while it is a minority of the page, so a site that names its
 * article wrapper `content-modal` cannot lose everything.
 */
export function stripPageChrome(body: Element): void {
  const total = Math.max(1, visibleTextLength(body))
  const doomed: Element[] = []
  const walk = (element: Element): void => {
    for (const child of childElements(element)) {
      if (isChromeElement(child) && visibleTextLength(child) <= 0.4 * total) {
        doomed.push(child)
        continue
      }
      walk(child)
    }
  }
  walk(body)
  for (const element of doomed) element.remove()
  // Consent banners without telltale names: climb from the wording to the
  // largest ancestor that is still banner-sized.
  const ownerDocument = body.ownerDocument
  const walker = ownerDocument.createTreeWalker(body, 4 /* SHOW_TEXT */)
  const hits: Element[] = []
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.nodeValue ?? ''
    if (text.length < 20 || !CONSENT_TEXT.test(text)) continue
    let block = node.parentElement
    if (block === null) continue
    const blockText = block.textContent ?? ''
    if (!CONSENT_ACTION.test(blockText) && !CONSENT_ACTION.test(block.parentElement?.textContent ?? '')) continue
    while (block.parentElement !== null && block.parentElement !== body && visibleTextLength(block.parentElement) < 1_200) {
      block = block.parentElement
    }
    if (visibleTextLength(block) < 1_200) hits.push(block)
  }
  for (const element of hits) if (element.isConnected) element.remove()
}

/** Record-region discovery result. */
export interface RecordRegion {
  items: Element[]
  /** Total visible text of the items. */
  text: number
}

/**
 * Find the dominant repeated-record region: the sibling group with the same
 * tag + class signature, at least four members, carrying the most text —
 * product cards on a collection page, rows on a listing. Menu-like groups
 * (tiny items, flat subtrees) are skipped.
 */
export function findRecordRegion(body: Element): RecordRegion | null {
  let best: RecordRegion | null = null
  const visit = (element: Element): void => {
    const name = element.nodeName.toLowerCase()
    if (NOISE_SUBTREE_TAGS.has(name)) return
    const children = childElements(element)
    if (children.length >= 4) {
      const groups = new Map<string, Element[]>()
      for (const child of children) {
        const classes = (child.getAttribute('class') ?? '').replace(/\d+/g, '').trim().split(/\s+/).filter(Boolean).sort().slice(0, 2).join('.')
        const signature = `${child.nodeName}.${classes}`
        const group = groups.get(signature)
        if (group === undefined) groups.set(signature, [child])
        else group.push(child)
      }
      for (const items of groups.values()) {
        if (items.length < 4) continue
        let text = 0
        let depth = 0
        for (const item of items) {
          text += visibleTextLength(item)
          depth += item.getElementsByTagName('*').length
        }
        if (text / items.length < 15 || depth / items.length < 2) continue
        if (best === null || text > best.text) best = { items, text }
      }
    }
    for (const child of children) visit(child)
  }
  visit(body)
  return best
}

/** Format an ISO timestamp the way forum UIs print it ("September 5, 2024"). */
function formatForumDate(iso: unknown): string {
  if (typeof iso !== 'string') return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' })
}

/**
 * Discourse ships the topic's post stream as JSON in
 * `#data-preloaded[data-preloaded]` (a map of JSON strings). Rebuild the
 * thread as HTML: author, date, cooked post body.
 */
export function discoursePreloadedHtml(document: Document): string | null {
  const holder = document.querySelector('#data-preloaded[data-preloaded]')
  const raw = holder?.getAttribute('data-preloaded')
  if (raw == null) return null
  try {
    const outer = JSON.parse(raw) as Record<string, unknown>
    for (const [key, value] of Object.entries(outer)) {
      if (!key.startsWith('topic_') || typeof value !== 'string') continue
      const topic = JSON.parse(value) as { title?: string, post_stream?: { posts?: { username?: string, created_at?: string, cooked?: string }[] } }
      const posts = topic.post_stream?.posts ?? []
      if (posts.length === 0) continue
      const parts = posts.map(post => `<div><p>${escapeHtml(post.username ?? '')}</p><p>${escapeHtml(formatForumDate(post.created_at))}</p>${post.cooked ?? ''}</div>`)
      return parts.join('\n')
    }
  } catch {
    return null
  }
  return null
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch)
}

// ---------------------------------------------------------- generation ----

/** Everything candidate generation learned about the page, for features. */
export interface GenerationFacts {
  readabilityNull: boolean
  gatePass: boolean
  pruneChanged: boolean
  noscriptText: number
  record: RecordRegion | null
  hasMain: boolean
  hasPreloaded: boolean
  /** The semantic main container, when found. */
  main: Element | null
}

/** Below this much noscript text the noscript-unwrapped paths are skipped. */
const NOSCRIPT_MIN_TEXT_CHARS = 200

/**
 * Propose every candidate extraction for one parsed page.
 * @param document - the parsed page (data URIs already elided); not mutated.
 */
export function generateCandidates(document: Document): { candidates: RawCandidate[], facts: GenerationFacts } {
  const candidates: RawCandidate[] = []
  const body = document.body
  const bodyHtml = body?.innerHTML ?? ''

  const art = runReadability(document)
  const gatePass = art !== null && articleCoversPage(art.content, document)
  let pruneChanged = false
  if (art !== null) {
    const pruned = prunedArticleContent(art.content, document)
    pruneChanged = pruned !== art.content
    candidates.push({ kind: 'art', html: pruned, title: art.title, legacy: gatePass })
    if (pruneChanged) candidates.push({ kind: 'artu', html: art.content, title: art.title, legacy: false })
  }
  // `linkDensityModifier` is a public Readability option missing from the
  // bundled type declarations; it relaxes the link-density cleaning cutoffs.
  const lenient = runReadability(document, { linkDensityModifier: 0.4 } as ConstructorParameters<typeof Readability>[1])
  if (lenient !== null && lenient.content !== art?.content) {
    candidates.push({ kind: 'artx', html: lenient.content, title: lenient.title, legacy: false })
  }
  const title = art?.title ?? lenient?.title

  const main = body === null ? null : findMainContainer(document)
  if (main !== null) candidates.push({ kind: 'main', html: main.innerHTML, title, legacy: false })

  candidates.push({ kind: 'doc', html: bodyHtml, legacy: !gatePass })

  if (body !== null) {
    const cleaned = body.cloneNode(true) as Element
    stripPageChrome(cleaned)
    candidates.push({ kind: 'docc', html: cleaned.innerHTML, legacy: false })
  }

  const record = body === null ? null : findRecordRegion(body)
  if (record !== null) {
    const heading = document.querySelector('h1')
    const html = (heading !== null ? heading.outerHTML : '') + record.items.map(item => item.outerHTML).join('\n')
    candidates.push({ kind: 'rec', html, legacy: false })
  }

  const noscriptText = noscriptTextLength(document)
  if (noscriptText >= NOSCRIPT_MIN_TEXT_CHARS) {
    const unwrapped = document.cloneNode(true) as Document
    unwrapNoscripts(unwrapped)
    const nsArt = runReadability(unwrapped)
    if (nsArt !== null) candidates.push({ kind: 'ns_art', html: prunedArticleContent(nsArt.content, unwrapped), title: nsArt.title, legacy: false })
    candidates.push({ kind: 'ns_doc', html: unwrapped.body?.innerHTML ?? '', legacy: false })
  }

  const preloaded = discoursePreloadedHtml(document)
  if (preloaded !== null) candidates.push({ kind: 'pre', html: preloaded, title, legacy: false })

  // Identical proposals (a `<main>` that IS Readability's pick, a chrome
  // strip that removed nothing) would only cost another sanitize pass.
  const seen = new Set(candidates.filter(candidate => candidate.legacy).map(candidate => candidate.html))
  const unique = candidates.filter(candidate => {
    if (candidate.legacy) return true
    if (seen.has(candidate.html)) return false
    seen.add(candidate.html)
    return true
  })

  return {
    candidates: unique,
    facts: {
      readabilityNull: art === null,
      gatePass,
      pruneChanged,
      noscriptText,
      record,
      hasMain: main !== null,
      hasPreloaded: preloaded !== null,
      main,
    },
  }
}
