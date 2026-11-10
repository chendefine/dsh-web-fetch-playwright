/**
 * Deep capture: a bounded in-page scroll walk that defeats viewport
 * virtualization before the document is serialized.
 *
 * WHY. Long "feed-shaped" pages — Discourse topic streams (linux.do,
 * meta.discourse.org), comment threads, timelines — increasingly render only
 * the posts near the current scroll position. Discourse is the measured
 * badcase: at rest the live DOM holds the posts within roughly one viewport
 * of the top, while every post outside that window is a height-only
 * placeholder that keeps the post's identity but none of its content:
 *
 * ```html
 * <div class="post-stream--cloaked" data-post-number="1" id="post_1"
 *      style="height:297.9px !important;…">
 *   <h2 class="sr-only">由 Diver-QC 于 2 小时前 发布</h2>
 * </div>
 * ```
 *
 * The placeholder carries the SAME id the rendered `<article id="post_1">`
 * has — every mainstream virtualized list needs some stable identity to
 * recycle its rows. A fetch that renders, never scrolls, and serializes one
 * instant of that DOM returns the skeleton (the screen-reader-only "posted
 * by" headings survive the pipeline as if they were content) while the reply
 * bodies silently vanish. Scrolling to the bottom once does not help either:
 * the window MOVES — measured on the same page, scrolling to the bottom left
 * only posts 31–40 rendered and re-cloaked 1–30. And the denoise pipeline's
 * own coverage gate cannot notice the loss: the page's "visible text" it
 * measures against is the same windowed fragment as the extraction, so the
 * ratio always passes. Only walk depth can see what a resting viewport hides.
 *
 * The SAME pathology, one level deeper, hits app-shell document editors —
 * the second measured badcase is a Feishu wiki page (bocha-ai.feishu.cn).
 * There the body never scrolls at all: html/body are locked at exactly one
 * viewport and the document scrolls inside `div.bear-web-x-container`
 * (measured: documentElement.scrollHeight 720 == innerHeight,
 * window.scrollTo(0, 800) left scrollY at 0, while the container held 4534px
 * against a 656px client). Its blocks are virtualized too, with two twists
 * over Discourse: blocks carry `data-block-id` and NO id, and off-window
 * blocks are REMOVED outright — the whole un-rendered tail is one anonymous
 * `.bear-virtual-renderUnit-placeholder` spacer with an explicit height — so
 * there is neither a window scrollbar to walk nor a degraded-in-place row to
 * swap back. A fetch therefore returns the statically rendered first screen.
 *
 * HOW. Between the settle and the serialization the provider runs one
 * in-page async walk ({@link deepCaptureInPage}, a typed function evaluated
 * by source):
 *
 * 1. Resolve the walk TARGET: the window when the document itself scrolls
 *    (the Discourse shape), else the page's dominant inner scroll container
 *    (the app-shell shape) — the element with the largest scrollable
 *    distance among computed `overflow-y: auto|scroll` elements, gated at
 *    half a viewport so dropdown-sized scrollers never trigger a walk. A
 *    page with neither is left alone (the legacy capture).
 * 2. STASH every keyed content element — key = id, else a namespaced
 *    `data-block-id` — as a detached clone (the RICHEST sighting per key
 *    wins), together with its nearest keyed siblings: where it sits in its
 *    own list, which is what a removed row is later spliced back next to.
 * 3. WALK down from the top in smooth 0.7-viewport steps (300ms motion +
 *    300ms quiet settle — the rest a feed engine's debounced uncloak needs),
 *    collecting after each, until the walk can hold AT THE BOTTOM through a
 *    {@link SCROLL_BOTTOM_PATIENCE_MS} window with the height unchanged
 *    (growth restarts the clock — that is what pages load-more sentinels),
 *    or the step/budget caps close it. A page that never reacted and issued
 *    no fetch/XHR holds only {@link SCROLL_INERT_PATIENCE_MS}.
 *
 *    A MutationObserver watches for the walk's whole reason to exist: the
 *    page REACTING to scroll by adding or removing elements. Most of the web
 *    never does (a long static article only costs latency here), so after
 *    {@link SCROLL_INERT_STEPS} careful steps with no reaction the walk
 *    probes the rest with one jump to the bottom. Any reaction after that
 *    jump — an uncloak, a re-cloak, a load-more append — means the region
 *    jumped over may hold content that never rendered, so the walk rewinds
 *    to where it jumped from and finishes carefully. Correctness never
 *    rests on the warm-up guess; only the cost of a scroll-inert page does.
 *
 *    The same observer HARVESTS UNKEYED ROWS — the third shape: react-window
 *    lists and X-style timelines give rows no DOM identity at all (the
 *    framework key never reaches the DOM), and framework-generated ids
 *    (`ember123`, React useId's `:r1:`) change per render so they are not
 *    keys either. When the engine removes such a row, the record still
 *    holds it whole plus the sibling nodes it sat between; that is the row's
 *    stash and its splice anchor, with no layout read at all.
 * 4. MERGE into a structural clone (`document.cloneNode(true)`: no
 *    serialize/re-parse round trip — a runtime-rewritten data script with a
 *    literal `</script>` in its text cannot corrupt it — and, having no
 *    browsing context, it runs no scripts, upgrades no custom elements and
 *    loads no frames):
 *    - SPLICE (container walks): stashed keys from inside the scroll
 *      container that the clone no longer holds were REMOVED by the engine
 *      (the Feishu shape — its placeholders are anonymous) and go back next
 *      to their recorded sibling, resolved iteratively so a removed run
 *      chains off whichever end survived; a key that rode in inside its
 *      spliced parent is already present and skipped. Placement is
 *      structural, so it is right whatever order the walk SAW rows in (an
 *      anchored open starts mid-document).
 *    - RESTORE (unkeyed rows): in every list the engine both removed text-
 *      bearing rows from and added to during the walk, each removed row the
 *      list no longer holds goes back beside the sibling it was removed
 *      next to (chains through removed anchors; rows with no surviving
 *      anchor at all — a wholesale innerHTML re-render — go above the final
 *      window, which is the only place a top-down walk loses them). Rows
 *      still present are recognised by a per-list identity attribute
 *      (data-index, aria-rowindex, …) or by text; in-place stubs are
 *      absorbed.
 *    - SWAP: every keyed element emptier than its snapshot (fewer child
 *      elements, or meaningfully less text — the Discourse placeholder) is
 *      replaced by that snapshot, except containers (ancestors of another
 *      element being swapped), which are assembled from those descendants
 *      instead: a container's own snapshot is one window's partial view. A
 *      restored list and its ancestors are containers too.
 *    The clone is then stripped of scripting elements and serialized; the
 *    provider reads that string instead of the live page. The live document
 *    is never rewritten, so no late scroll/rAF/timer reaction can touch the
 *    capture either.
 *
 * Failure is always silent degradation: a page without `evaluate`, a script
 * error, or an engine that rejects the walk just keeps the legacy
 * single-instant capture — a walk can only add content, never fail a fetch.
 * A walk that restored nothing returns no HTML, and the provider reads the
 * live page exactly as before — scrolled back to where it opened when the
 * page reacted, so a virtualizer the merge could not rebuild hands over its
 * opening window rather than the walk's last one.
 *
 * The walk runs in BOTH denoise modes (the raw-HTML path serializes the same
 * cloaked placeholders) but never for non-HTML documents. It is bounded by
 * the `scrollBudgetMs` setting (`0` restores the pre-walk legacy behavior)
 * and always by the remaining fetch deadline minus a decode reserve — the
 * provider's abort closes the tab, which rejects the pending evaluation.
 *
 * @module dsh-web-fetch-playwright/autoscroll
 */

import { stripScriptingElementsIn } from './strip.ts'
import type { PlaywrightPage } from './types.ts'

/** How far each step scrolls, as a share of the viewport height. */
export const SCROLL_STEP_RATIO = 0.7

/**
 * How long one step's smooth scroll motion takes (ms). The step ANIMATES
 * down its distance (time-interpolated ticks at ~60fps) instead of
 * teleporting: feed engines' uncloak/re-cloak logic is built around a
 * continuous stream of scroll events, and background-tab timer throttling
 * self-corrects because every tick derives its position from the clock.
 */
export const SCROLL_STEP_MOTION_MS = 300

/**
 * Per-step settle (ms): the QUIET window after the motion, where a feed
 * engine's debounced uncloak fires (measured: stepping without a rest
 * starves Discourse's cloak manager, which renders nothing new until the
 * scroll rests ~300ms) and the freshly rendered rows become stashable.
 */
export const SCROLL_STEP_SETTLE_MS = 300

/** How often the walk re-checks the height while holding at the bottom. */
export const SCROLL_BOTTOM_POLL_MS = 450

/**
 * How long at the bottom, with no height growth, before the walk concludes
 * the page is complete. Real feed engines fetch their next chunk with
 * network latency (measured on linux.do: a pending chunk landed well after
 * two 450ms checks), so this is sized over a slow round trip.
 */
export const SCROLL_BOTTOM_PATIENCE_MS = 2_500

/**
 * Bottom hold for a page that has given no sign of loading more: it never
 * added or removed an element in response to the walk's scrolling, and it
 * issued no fetch/XHR since the walk began. The full
 * {@link SCROLL_BOTTOM_PATIENCE_MS} exists for feeds whose next chunk is in
 * flight; holding it on every static article made the walk cost ~4s on
 * pages it could never help. Any reaction or data request (even one that
 * lands during this shorter hold) restores the full patience.
 */
export const SCROLL_INERT_PATIENCE_MS = 900

/**
 * Careful steps without any DOM reaction before the walk treats the page as
 * scroll-inert and probes the rest with a single jump (rewinding if the
 * jump provokes a reaction). Two steps cover ~1.4 viewports — past the
 * render window edge of every measured virtualizer.
 */
export const SCROLL_INERT_STEPS = 2

/** Hard cap on scroll steps regardless of budget (unbounded feeds). */
export const SCROLL_MAX_STEPS = 50

/**
 * Cap on stashed keys — pathological id counts cannot pin memory. Sized for
 * long topics: a Discourse post carries several ids of its own (post,
 * heading, avatar, …), so a few hundred posts already need a thousand-plus.
 * {@link SCROLL_STASH_MAX_CHARS} is the real memory bound.
 */
export const SCROLL_STASH_MAX_ENTRIES = 2_000

/** Cap on stashed HTML characters (aligned with the pipeline input cap). */
export const SCROLL_STASH_MAX_CHARS = 2_000_000

/**
 * Cap on ONE stashed element's HTML. A virtualized row is a few KB; an
 * element tens of KB big is a CONTAINER (measured on linux.do: six nested
 * wrappers each embed the whole post stream — main 164KB ⊃
 * main-outlet-wrapper 156KB ⊃ … — plus data-preloaded 300KB and
 * svg-sprites 277KB) or a data island — never a row the merge could
 * rehydrate. Such keys are remembered and never serialized again.
 */
export const SCROLL_STASH_MAX_ENTRY_CHARS = 64_000

/**
 * Tail of the fetch budget the walk never spends, keeping room for the
 * content read and the synchronous denoise decode.
 */
export const SCROLL_FINISH_RESERVE_MS = 4_000

/**
 * A walk budget below this cannot complete even the first window plus one
 * stability check, so the walk is skipped outright.
 */
export const SCROLL_MIN_BUDGET_MS = 500

/**
 * Floor (px) on the scrollable distance an inner container must offer
 * before the walk targets it, when the document itself does not scroll.
 */
export const SCROLL_CONTAINER_MIN_RANGE_PX = 300

/** The viewport share an inner container's scrollable distance must reach. */
export const SCROLL_CONTAINER_MIN_RANGE_RATIO = 0.5

/**
 * Text shortfall (chars) versus the snapshot that marks an element as
 * degraded even when its child-element count held — below it, live text
 * (relative timestamps, counters) merely ticked.
 */
export const SCROLL_TEXT_DEGRADE_TOLERANCE = 16

/** What one completed (or skipped) walk reports back, for tests and logs. */
export interface DeepCaptureStats {
  /** Scroll steps taken (0 when the walk skipped or had no room). */
  steps: number
  /** Distinct keys stashed across the walk. */
  stashed: number
  /** Degraded elements swapped for their snapshot in the capture. */
  rehydrated: number
  /** Removed keyed elements spliced back (container walks only). */
  spliced?: number
  /** Unkeyed rows a virtualizer removed, restored into their list. */
  restored?: number
  /**
   * True when nothing could be restored on a page that reacted, so the walk
   * scrolled back to where the page opened before handing it to the
   * provider's live read.
   */
  rewound?: boolean
  /**
   * Whether the page reacted to scrolling (added/removed elements). False
   * means the walk took the scroll-inert fast path to the bottom.
   */
  reactive?: boolean
  /** Walk duration (ms). */
  elapsedMs?: number
  /** Walk-target height (px) — document or inner scroll container. */
  height?: number
  /** Set when the walk skipped without scrolling, and why. */
  skipped?: 'not-scrollable' | 'no-budget'
}

/** A finished walk: its stats, plus the merged capture when it restored anything. */
export interface DeepCapture extends DeepCaptureStats {
  /**
   * The merged, scripting-stripped document serialized like
   * `page.content()` — present only when the walk restored something; the
   * provider then reads it instead of the live page.
   */
  html?: string
}

/** The walk's knobs, handed to {@link deepCaptureInPage} as JSON. */
export interface DeepCaptureParams {
  budgetMs: number
  stepRatio: number
  stepMotionMs: number
  stepSettleMs: number
  bottomPollMs: number
  bottomPatienceMs: number
  inertPatienceMs: number
  inertSteps: number
  maxSteps: number
  stashMaxEntries: number
  stashMaxChars: number
  stashMaxEntryChars: number
  containerMinRangePx: number
  containerMinRatio: number
  textDegradeTolerance: number
}

/**
 * The in-page walk. Evaluated BY SOURCE (`fn.toString()` composed into an
 * expression by {@link deepCaptureScript}), so it must stay self-contained:
 * every helper is nested, every knob arrives in `p`, and the one shared
 * routine — the scripting strip — arrives as an argument. Typed here so the
 * compiler checks what used to be an unchecked string.
 *
 * @param p - the walk's knobs.
 * @param strip - {@link stripScriptingElementsIn}, applied to the merged clone.
 * @returns the walk's stats, plus the merged HTML when anything was restored.
 */
export async function deepCaptureInPage(p: DeepCaptureParams, strip: (doc: Document) => void): Promise<DeepCapture> {
  const started = Date.now()
  const root = document.documentElement
  const body = document.body
  if (root === null || body === null) return { steps: 0, stashed: 0, rehydrated: 0, skipped: 'not-scrollable' }
  if (p.budgetMs <= 0) return { steps: 0, stashed: 0, rehydrated: 0, skipped: 'no-budget' }

  const KEYED = '[id], [data-block-id]'
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const sleep = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

  // ── Target: the window, or the dominant inner scroll container ─────────
  // The app-shell shape (Feishu docs, Notion-class editors) locks html/body
  // at one viewport and scrolls inside one container, where window-only
  // primitives are no-ops. Largest scrollable distance wins; document order
  // keeps the OUTERMOST on ties.
  function findScrollContainer(host: HTMLElement): Element | null {
    const minRange = Math.max(p.containerMinRangePx, window.innerHeight * p.containerMinRatio)
    let best: Element | null = null
    let bestRange = 0
    for (const el of Array.from(host.querySelectorAll('*'))) {
      const range = el.scrollHeight - el.clientHeight
      if (range < minRange || range <= bestRange) continue
      const overflowY = getComputedStyle(el).overflowY
      if (overflowY === 'auto' || overflowY === 'scroll') { best = el; bestRange = range }
    }
    return best
  }
  const documentScrolls = root.scrollHeight > window.innerHeight + 4
  const scroller = documentScrolls ? null : findScrollContainer(body)
  if (!documentScrolls && scroller === null) return { steps: 0, stashed: 0, rehydrated: 0, skipped: 'not-scrollable' }
  const viewportH = (): number => scroller === null ? window.innerHeight : scroller.clientHeight
  const scrollH = (): number => scroller === null ? root.scrollHeight : scroller.scrollHeight
  const curY = (): number => scroller === null ? window.scrollY : scroller.scrollTop
  const atBottom = (): boolean => curY() + viewportH() >= scrollH() - 2
  function scrollToY(y: number): void {
    if (scroller === null) window.scrollTo({ top: y, behavior: 'instant' })
    else scroller.scrollTop = y
  }
  // One step's smooth descent, positioned from the wall clock each tick so
  // background-tab throttling degrades to coarser jumps along the same path.
  function smoothScrollBy(dy: number): Promise<void> {
    return new Promise(resolve => {
      const fromY = curY()
      const t0 = Date.now()
      const tick = (): void => {
        const progress = (Date.now() - t0) / p.stepMotionMs
        if (progress >= 1 || (curY() !== fromY && atBottom())) {
          scrollToY(fromY + dy)
          resolve()
          return
        }
        scrollToY(fromY + Math.round(dy * progress))
        setTimeout(tick, 16)
      }
      tick()
    })
  }

  // ── Identity ────────────────────────────────────────────────────────────
  // id, else data-block-id (namespaced so the two can never collide): app-
  // shell editors key their blocks that way and carry no id at all.
  // Framework-GENERATED ids are per-render, not identities: a row re-rendered
  // by Ember (`ember123`) or React's useId (`:r1:`, `«r1»`, `_r_1_`) comes
  // back under a new id, so keying on one only ever stashes dead snapshots.
  // Such elements count as unkeyed and take the unkeyed-row path below.
  const GENERATED_ID = /^ember\d+$|:r[0-9a-z]*:|«r[0-9a-z]*»|^_r_[0-9a-z]+_$/
  function keyOf(el: Element): string | null {
    if (el.id !== '' && !GENERATED_ID.test(el.id)) return el.id
    const block = el.getAttribute('data-block-id')
    return block !== null && block !== '' ? `data-block-id:${block}` : null
  }
  // Nearest keyed sibling in one direction: where the element sits in its
  // own list — the splice anchor if the engine removes it later.
  function siblingKey(el: Element, dir: 'previousElementSibling' | 'nextElementSibling'): string | null {
    for (let sib = el[dir]; sib !== null; sib = sib[dir]) {
      const key = keyOf(sib)
      if (key !== null) return key
    }
    return null
  }

  // ── Reactivity ─────────────────────────────────────────────────────────
  // Element additions/removals are a virtualizer's (or a load-more's)
  // signature; attribute churn (lazy images, sticky-header classes) and
  // text ticks are not, nor are injected scripting/metadata elements.
  const INERT_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'IFRAME', 'TEMPLATE'])
  let reactions = 0
  const counts = (nodes: NodeList): boolean => {
    for (const node of Array.from(nodes)) {
      if (node.nodeType === 1 && !INERT_TAGS.has(node.nodeName)) return true
    }
    return false
  }
  const tally = (records: MutationRecord[]): void => {
    for (const record of records) {
      if (counts(record.addedNodes) || counts(record.removedNodes)) reactions++
      harvest(record)
    }
  }
  // (The observer itself starts below, once the unkeyed-row harvest it
  // feeds is declared.)
  const reacted = (): boolean => { tally(observer.takeRecords()); return reactions > 0 }
  // Data requests (fetch/XHR): the other sign of a feed loading more.
  // Images, fonts and beacons are not. Observed rather than read from the
  // resource buffer, which stops growing once full (250 entries in Chromium)
  // on exactly the heavy pages that matter. Resource Timing reports a
  // request only once it COMPLETES: a next chunk still in flight when the
  // short inert hold expires goes unseen, which is the price of that hold.
  let requests = 0
  const tallyRequests = (entries: PerformanceEntryList): void => {
    for (const entry of entries) {
      const type = (entry as PerformanceResourceTiming).initiatorType
      if (type === 'fetch' || type === 'xmlhttprequest') requests++
    }
  }
  let requestObserver: PerformanceObserver | null = null
  try {
    requestObserver = new PerformanceObserver(list => { tallyRequests(list.getEntries()) })
    requestObserver.observe({ type: 'resource' })
  } catch {
    requestObserver = null // no Resource Timing: reactions alone decide
  }
  const requested = (): boolean => {
    if (requestObserver !== null) tallyRequests(requestObserver.takeRecords())
    return requests > 0
  }

  // ── Stash ──────────────────────────────────────────────────────────────
  interface Snapshot {
    node: Element // detached clone, owned by stashDoc
    els: number
    text: number
    len: number
    prev: string | null
    next: string | null
    inScroller: boolean
  }
  // Clones live in a document without a browsing context: no scripts run,
  // no custom elements upgrade, nothing loads.
  const stashDoc = document.implementation.createHTMLDocument('')
  const stash = new Map<string, Snapshot>()
  const oversized = new Set<string>()
  let stashChars = 0

  // ── Unkeyed rows ───────────────────────────────────────────────────────
  // Many virtualizers give their rows no DOM identity at all (react-window
  // rows, X-style timeline cells: the framework key never reaches the DOM).
  // Such a row is harvested at the instant the engine REMOVES it: the
  // MutationObserver record hands over the detached row, still whole, plus
  // the sibling nodes it sat between — enough to splice it back into the
  // same list at merge without reading any layout (absolute positioning and
  // transforms do not matter). Nodes are tracked by object identity, so
  // even an anonymous spacer or a row filtered out as noise still anchors
  // its neighbors.
  const ROW_IDENT_ATTRS = [
    'data-index', 'data-item-index', 'data-row-index', 'data-rowindex', 'aria-rowindex', 'aria-posinset',
    'data-key', 'data-row-key', 'data-item-key', 'data-id', 'data-item-id',
  ]
  // Transient UI — toasts, live status, spinners, menus — is never content.
  const NOISE_ROLES = new Set(['status', 'alert', 'alertdialog', 'dialog', 'tooltip', 'progressbar', 'menu', 'listbox', 'timer', 'marquee'])
  const squash = (s: string): string => s.replace(/\s+/g, ' ').trim()
  // Identity for de-duplication against the rows still live: a per-LIST
  // attribute when the engine sets one (scoped to the list, so data-index
  // values repeating across lists cannot collide), else the row's text.
  function rowIdent(el: Element): string | null {
    for (const attr of ROW_IDENT_ATTRS) {
      const value = el.getAttribute(attr)
      if (value !== null && value !== '') return `${attr}=${value}`
    }
    return null
  }
  function rowText(el: Element): string | null {
    if (keyOf(el) !== null || INERT_TAGS.has(el.nodeName) || el.namespaceURI === SVG_NS) return null
    if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true' || el.getAttribute('aria-busy') === 'true') return null
    const role = el.getAttribute('role')
    if (role !== null && NOISE_ROLES.has(role)) return null
    const text = squash(el.textContent ?? '')
    return text === '' ? null : text
  }
  interface Removal {
    row: { node: Element; text: string; ident: string | null; len: number } | null // null: anchor-only ghost
    /** A ghost repeating an already-stashed row: the node that holds its copy. */
    same?: Node
    parent: Node
    prev: Node | null
    next: Node | null
    seq: number
  }
  const removals = new Map<Node, Removal>()
  // Per list: the one stashed copy of each row identity. An engine that
  // re-renders every frame removes the same row thousands of times; only
  // the first sighting (richest wins) is stashed, the rest only anchor.
  const rowsSeen = new Map<Node, Map<string, Node>>()
  const lists = new Map<Node, { rows: number; added: number }>()
  const addedNodes = new WeakSet<Node>()
  let removalSeq = 0
  let rowsStashed = 0
  // Its OWN character budget: rows churned inside keyed content (a forum
  // engine re-rendering post internals) must never starve the keyed stash,
  // which is what the established feed shapes rely on.
  let rowChars = 0
  // Anchor-only bookkeeping is cheap but holds detached nodes alive.
  const MAX_REMOVALS = 50_000
  function harvest(record: MutationRecord): void {
    const parent = record.target
    if (record.type !== 'childList' || parent.nodeType !== 1 || parent === body || !parent.isConnected) return
    if (scroller !== null ? !scroller.contains(parent) : !body.contains(parent)) return
    let list = lists.get(parent)
    if (list === undefined) { list = { rows: 0, added: 0 }; lists.set(parent, list) }
    for (const node of Array.from(record.addedNodes)) {
      addedNodes.add(node)
      if (node.nodeType === 1 && !INERT_TAGS.has(node.nodeName)) list.added++
    }
    // One record may remove a whole run (innerHTML, replaceChildren): its
    // members anchor on each other, the run's ends on the record's siblings.
    const gone = Array.from(record.removedNodes)
    let seen = rowsSeen.get(parent)
    if (seen === undefined) { seen = new Map(); rowsSeen.set(parent, seen) }
    gone.forEach((node, i) => {
      if (removals.size >= MAX_REMOVALS) return
      const removal: Removal = {
        row: null,
        parent,
        prev: i > 0 ? gone[i - 1]! : record.previousSibling,
        next: i < gone.length - 1 ? gone[i + 1]! : record.nextSibling,
        seq: removalSeq++,
      }
      removals.set(node, removal)
      const text = node.nodeType === 1 ? rowText(node as Element) : null
      if (text === null) return
      const el = node as Element
      const ident = rowIdent(el)
      const identity = ident ?? `${el.nodeName}|${text}`
      const priorNode = seen.get(identity)
      const prior = priorNode === undefined ? undefined : removals.get(priorNode)
      if (priorNode !== undefined) removal.same = priorNode
      if (prior?.row != null && prior.row.text.length >= text.length) return
      if (prior === undefined && rowsStashed >= p.stashMaxEntries) return
      const len = el.outerHTML.length
      const freed = prior?.row?.len ?? 0
      if (len > p.stashMaxEntryChars || rowChars - freed + len > p.stashMaxChars) return
      rowChars += len - freed
      const row = { node: stashDoc.importNode(el, true), text, ident, len }
      if (prior !== undefined) {
        prior.row = row // a richer sighting, kept at the FIRST sighting's place
      } else {
        removal.row = row
        seen.set(identity, node)
        rowsStashed++
        list.rows++
      }
    })
  }
  const observer = new MutationObserver(tally)
  observer.observe(body, { childList: true, subtree: true })
  const host: HTMLElement = body
  function collect(): void {
    for (const el of Array.from(host.querySelectorAll(KEYED))) {
      const key = keyOf(el)
      if (key === null || oversized.has(key) || el.namespaceURI === SVG_NS) continue
      const els = el.childElementCount
      const text = (el.textContent ?? '').length
      if (els === 0 && text === 0) continue
      const prev = stash.get(key)
      if (prev !== undefined) {
        // Neighbors refresh on every sighting: any observed sibling is a
        // true one, and later windows see more of the list.
        prev.prev = siblingKey(el, 'previousElementSibling') ?? prev.prev
        prev.next = siblingKey(el, 'nextElementSibling') ?? prev.next
        // Richest sighting wins; a rendered row collapsing back to its
        // placeholder never downgrades the stash.
        if (els <= prev.els && text <= prev.text) continue
      } else if (stash.size >= p.stashMaxEntries) {
        continue
      }
      if (text > p.stashMaxEntryChars) { oversized.add(key); continue }
      const len = el.outerHTML.length
      if (len > p.stashMaxEntryChars) { oversized.add(key); continue }
      const freed = prev === undefined ? 0 : prev.len
      if (stashChars - freed + len > p.stashMaxChars) continue
      stashChars += len - freed
      stash.set(key, {
        node: stashDoc.importNode(el, true),
        els,
        text,
        len,
        prev: prev?.prev ?? siblingKey(el, 'previousElementSibling'),
        next: prev?.next ?? siblingKey(el, 'nextElementSibling'),
        inScroller: scroller !== null && scroller.contains(el),
      })
    }
  }

  // ── Walk ───────────────────────────────────────────────────────────────
  // Stash whatever the (possibly anchored) start renders, then restart from
  // the top so the walk covers the whole target.
  const startY = curY()
  collect()
  if (curY() > 0) {
    scrollToY(0)
    await sleep(p.stepSettleMs)
    collect()
  }
  // Only reactions to the walk's own scrolling count from here on.
  tally(observer.takeRecords())
  reactions = 0
  requested()
  requests = 0

  let steps = 0
  let lastHeight = scrollH()
  let lastChangeAt = Date.now()
  let careful = false // the page reacted: never jump again
  let jumpedFrom: number | null = null
  const noteHeight = (): void => {
    const height = scrollH()
    if (height !== lastHeight) { lastHeight = height; lastChangeAt = Date.now() }
  }
  try {
    while (steps < p.maxSteps && Date.now() - started < p.budgetMs) {
      if (jumpedFrom !== null && reacted()) {
        // The jump provoked a reaction: what lies between jumpedFrom and the
        // bottom may never have rendered. Go back and walk it carefully.
        scrollToY(jumpedFrom)
        jumpedFrom = null
        careful = true
        await sleep(p.stepSettleMs)
        collect()
        noteHeight()
        continue
      }
      if (atBottom()) {
        // Bottom patience: growth at any poll restarts the clock (the walk
        // then keeps scrolling into what loaded); completion is only trusted
        // after the full window passes with the height unchanged.
        await sleep(p.bottomPollMs)
        collect()
        const before = lastHeight
        noteHeight()
        // `careful` implies reacted(): reactions are never reset mid-walk.
        const patience = reacted() || requested() ? p.bottomPatienceMs : p.inertPatienceMs
        if (lastHeight === before && Date.now() - lastChangeAt >= patience) break
        continue
      }
      if (!careful && jumpedFrom === null) {
        if (reacted()) {
          careful = true
        } else if (steps >= p.inertSteps) {
          // Scroll-inert so far: probe the rest in one jump. The jump counts
          // as a change, so a load-more it triggers gets the full patience.
          jumpedFrom = curY()
          steps++
          scrollToY(scrollH())
          lastChangeAt = Date.now()
          await sleep(p.stepSettleMs)
          collect()
          noteHeight()
          continue
        }
      }
      steps++
      await smoothScrollBy(Math.max(1, Math.round(viewportH() * p.stepRatio)))
      collect()
      await sleep(p.stepSettleMs)
      collect()
      noteHeight()
    }
  } finally {
    // Flush first: disconnect() drops queued records, and the last batch of
    // removals is exactly what the unkeyed-row merge needs.
    tally(observer.takeRecords())
    observer.disconnect()
    requestObserver?.disconnect()
  }
  const reactive = reacted()
  const finalHeight = scrollH()

  // ── Merge into a structural clone (synchronous from here on) ──────────
  const fresh = document.cloneNode(true) as Document

  // Unkeyed lists to restore, mapped into the clone NOW — the clone is an
  // exact structural copy only until the merge starts editing it. A list
  // qualifies when the engine both removed text-bearing rows from it and
  // added elements to it during the walk (a virtualizer's churn; a lone
  // toast or a load-more append does not), and it is not a live/status
  // region or carousel whose churn is rotation rather than windowing.
  interface ListPlan {
    live: Node
    fresh: Element
    childOf: Map<Node, Node> // live child → its clone twin
    added: Set<Node> // clone twins of children the engine added during the walk
  }
  const NOISE_REGION = '[aria-live="assertive"], [role="alert"], [role="status"], [role="timer"], [role="marquee"], [aria-roledescription~="carousel"]'
  function freshOf(live: Node): Node | null {
    const path: number[] = []
    for (let at: Node = live; at !== document;) {
      const up = at.parentNode
      if (up === null) return null
      path.push(Array.prototype.indexOf.call(up.childNodes, at) as number)
      at = up
    }
    let at: Node = fresh
    for (let i = path.length - 1; i >= 0; i--) {
      const child = at.childNodes[path[i]!]
      if (child === undefined) return null
      at = child
    }
    return at
  }
  const plans: ListPlan[] = []
  for (const [live, list] of lists) {
    if (list.rows < 2 || list.added < 1 || !live.isConnected || (live as Element).closest(NOISE_REGION) !== null) continue
    const twin = freshOf(live)
    if (twin === null || twin.nodeType !== 1) continue
    const liveKids = Array.from(live.childNodes)
    const freshKids = Array.from(twin.childNodes)
    if (liveKids.length !== freshKids.length) continue
    const childOf = new Map<Node, Node>()
    const added = new Set<Node>()
    liveKids.forEach((child, i) => {
      childOf.set(child, freshKids[i]!)
      if (addedNodes.has(child)) added.add(freshKids[i]!)
    })
    plans.push({ live, fresh: twin as Element, childOf, added })
  }

  const present = new Map<string, Element>()
  const index = (node: Element): void => {
    const key = keyOf(node)
    if (key !== null && !present.has(key)) present.set(key, node)
    for (const el of Array.from(node.querySelectorAll(KEYED))) {
      const inner = keyOf(el)
      if (inner !== null && !present.has(inner)) present.set(inner, el)
    }
  }
  if (fresh.documentElement !== null) index(fresh.documentElement)

  // SPLICE (container walks): absent keys go back beside a surviving
  // sibling; each pass can anchor the next, so a removed run chains off
  // whichever end survived. Keys with no surviving relative stay out.
  let spliced = 0
  if (scroller !== null) {
    let pending = Array.from(stash.keys()).filter(key => stash.get(key)!.inScroller && !present.has(key))
    let progressed = true
    while (pending.length > 0 && progressed) {
      progressed = false
      const unresolved: string[] = []
      for (const key of pending) {
        if (present.has(key)) { progressed = true; continue } // rode in with its parent
        const snap = stash.get(key)!
        const after = snap.prev === null ? undefined : present.get(snap.prev)
        const before = snap.next === null ? undefined : present.get(snap.next)
        if (after === undefined && before === undefined) { unresolved.push(key); continue }
        const node = fresh.importNode(snap.node, true)
        if (after !== undefined) after.after(node)
        else before!.before(node)
        index(node)
        spliced++
        progressed = true
      }
      pending = unresolved
    }
  }

  // RESTORE unkeyed rows into their lists, oldest removal first — before the
  // swap, which must see each list already whole.
  // Clone nodes the merge replaced, so a list anchor on one still resolves.
  const replacedBy = new Map<Node, Node>()
  let restored = 0
  const restoredLists: Element[] = []
  for (const plan of plans) {
    const count = restoreList(plan)
    if (count > 0) { restored += count; restoredLists.push(plan.fresh) }
  }

  // SWAP degraded leaves for their snapshots; their ancestors are
  // containers, assembled from them rather than swapped wholesale. So is a
  // restored list and everything around it: a keyed wrapper's snapshot is
  // one window's partial view of the rows the restore just made whole.
  const degraded: Array<{ el: Element; snap: Snapshot }> = []
  for (const el of Array.from(fresh.querySelectorAll(KEYED))) {
    const key = keyOf(el)
    const snap = key === null ? undefined : stash.get(key)
    if (snap === undefined || el.namespaceURI === SVG_NS) continue
    if (el.childElementCount < snap.els || snap.text - (el.textContent ?? '').length > p.textDegradeTolerance) {
      degraded.push({ el, snap })
    }
  }
  const containers = new Set<Element>()
  for (const { el } of degraded) {
    for (let up = el.parentElement; up !== null && !containers.has(up); up = up.parentElement) containers.add(up)
  }
  for (const list of restoredLists) {
    for (let up: Element | null = list; up !== null && !containers.has(up); up = up.parentElement) containers.add(up)
  }
  let rehydrated = 0
  for (const { el, snap } of degraded) {
    if (containers.has(el)) continue
    el.replaceWith(fresh.importNode(snap.node, true))
    rehydrated++
  }

  function restoreList(plan: ListPlan): number {
    const follow = (node: Node | undefined): Node | null => {
      let at = node
      while (at !== undefined && replacedBy.has(at)) at = replacedBy.get(at)
      return at !== undefined && at.parentNode === plan.fresh ? at : null
    }
    // What the list holds now, for de-duplication: identity attribute and
    // text of every element child (live rows, spliced or swapped ones).
    const byIdent = new Map<string, Element>()
    const byText = new Map<string, Element>()
    const textOf = new Map<Element, string>()
    const note = (el: Element): void => {
      const text = squash(el.textContent ?? '')
      textOf.set(el, text)
      const ident = rowIdent(el)
      if (ident !== null && !byIdent.has(ident)) byIdent.set(ident, el)
      if (text !== '' && !byText.has(`${el.nodeName}|${text}`)) byText.set(`${el.nodeName}|${text}`, el)
    }
    const forget = (el: Element): void => {
      const text = textOf.get(el) ?? ''
      const ident = rowIdent(el)
      if (ident !== null && byIdent.get(ident) === el) byIdent.delete(ident)
      if (byText.get(`${el.nodeName}|${text}`) === el) byText.delete(`${el.nodeName}|${text}`)
    }
    for (const child of Array.from(plan.fresh.children)) note(child)

    const placed = new Map<Node, Node>() // live removed node → clone node it became
    const rows = Array.from(removals.entries())
      .filter(([node, r]) => r.parent === plan.live && r.row !== null && !node.isConnected)
      .sort((a, b) => a[1].seq - b[1].seq)
    const pending = new Set(rows.map(([node]) => node))
    // Later removals of the same row (ghosts pointing at its stashed copy).
    const repeats = new Map<Node, Removal[]>()
    for (const removal of removals.values()) {
      if (removal.row !== null || removal.same === undefined || removal.parent !== plan.live) continue
      const list = repeats.get(removal.same)
      if (list === undefined) repeats.set(removal.same, [removal])
      else list.push(removal)
    }
    let allowPending = false
    const PENDING = 1
    // Walk an anchor chain to a node of the clone list: a live sibling, a
    // row already restored, or — through rows that will never come back
    // (ghosts, duplicates) — whatever THEY sat next to.
    function resolve(start: Node | null, dir: 'prev' | 'next'): Node | null | typeof PENDING {
      let anchor = start
      for (let hops = 0; anchor !== null && hops <= removals.size; hops++) {
        const done = placed.get(anchor)
        if (done !== undefined) return follow(done)
        if (anchor.parentNode === plan.live) return follow(plan.childOf.get(anchor))
        const removal = removals.get(anchor)
        if (removal === undefined || removal.parent !== plan.live) return null
        if (pending.has(anchor) && !allowPending) return PENDING
        // A repeat of a stashed row stands where that row is restored.
        if (removal.row === null && removal.same !== undefined && removal.same !== anchor) { anchor = removal.same; continue }
        anchor = dir === 'prev' ? removal.prev : removal.next
      }
      return null
    }
    let count = 0
    // A row already in the list is not restored again; one whose live twin
    // (same identity attribute) is a far emptier placeholder replaces it.
    function dedupe(live: Node, row: NonNullable<Removal['row']>): boolean {
      const sameIdent = row.ident === null ? undefined : byIdent.get(row.ident)
      const twin = sameIdent ?? byText.get(`${row.node.nodeName}|${row.text}`)
      if (twin === undefined) return false
      const twinText = textOf.get(twin) ?? ''
      if (sameIdent !== undefined && twinText.length * 4 <= row.text.length && row.text.length - twinText.length > p.textDegradeTolerance) {
        const node = fresh.importNode(row.node, true)
        twin.replaceWith(node)
        forget(twin)
        replacedBy.set(twin, node)
        note(node)
        placed.set(live, node)
        count++
      } else {
        placed.set(live, twin)
      }
      return true
    }
    // Stubs: the placeholder an unkeyed cloak puts in a row's place carries
    // a short piece of the row's own text ("posted by …"). Whichever of the
    // two the merge meets second, only the row survives.
    const restoredHere = new Set<Element>()
    const stubOf = (stub: string, full: string): boolean => stub !== '' && stub.length * 4 <= full.length && full.includes(stub)
    function insert(live: Node, row: NonNullable<Removal['row']>, place: (node: Element) => void): void {
      const node = fresh.importNode(row.node, true)
      place(node)
      const sides = [node.previousElementSibling, node.nextElementSibling]
      // A restored stub beside the row it stood in for adds nothing.
      for (const side of sides) {
        if (side !== null && stubOf(row.text, textOf.get(side) ?? '')) {
          node.remove()
          placed.set(live, side)
          return
        }
      }
      note(node)
      placed.set(live, node)
      restoredHere.add(node)
      count++
      // A stub beside the restored row goes — one the engine ADDED during the
      // walk, or one restored earlier; never a row the page had all along.
      for (const side of sides) {
        if (side === null || keyOf(side) !== null || !(plan.added.has(side) || restoredHere.has(side))) continue
        if (!stubOf(textOf.get(side) ?? '', row.text)) continue
        forget(side)
        side.remove()
        replacedBy.set(side, node)
        if (restoredHere.delete(side)) count--
      }
    }
    let queue = rows
    while (queue.length > 0) {
      const later: typeof rows = []
      let progressed = false
      for (const entry of queue) {
        const [live, removal] = entry
        const row = removal.row!
        if (dedupe(live, row)) { pending.delete(live); progressed = true; continue }
        // Every sighting of the row knows where it sat at that instant; the
        // first that resolves wins (an anchored open's first window, say,
        // was removed beside rows only a later pass ever pinned down).
        let place: ((node: Element) => void) | null = null
        for (const sighting of [removal, ...(repeats.get(live) ?? [])]) {
          const before = resolve(sighting.next, 'next')
          if (before !== null && before !== PENDING) { place = node => { (before as ChildNode).before(node) }; break }
          const after = resolve(sighting.prev, 'prev')
          if (after !== null && after !== PENDING) { place = node => { (after as ChildNode).after(node) }; break }
        }
        if (place === null) {
          later.push(entry)
          continue
        }
        insert(live, row, place)
        pending.delete(live)
        progressed = true
      }
      queue = later
      if (!progressed) {
        if (allowPending) break
        allowPending = true
      }
    }
    // Rows with no surviving relative (a list re-rendered wholesale leaves no
    // anchor behind): a walk runs top-down and ends at the bottom, so what
    // the engine removed and did not render again lay ABOVE the final
    // window — before the first text-bearing row, in removal order.
    if (queue.length > 0) {
      const first = Array.from(plan.fresh.children).find(el => (textOf.get(el) ?? '') !== '') ?? null
      for (const [live, removal] of queue) {
        const row = removal.row!
        if (dedupe(live, row)) continue
        insert(live, row, node => { plan.fresh.insertBefore(node, first) })
      }
    }
    return count
  }

  const stats: DeepCapture = {
    steps,
    stashed: stash.size,
    rehydrated,
    spliced,
    restored,
    reactive,
    elapsedMs: Date.now() - started,
    height: finalHeight,
  }
  if ((rehydrated > 0 || spliced > 0 || restored > 0) && fresh.documentElement !== null) {
    strip(fresh)
    // page.content()'s own serialization: doctype, then the root element.
    const doctype = fresh.doctype === null ? '' : new XMLSerializer().serializeToString(fresh.doctype)
    stats.html = doctype + fresh.documentElement.outerHTML
  } else if (reactive && curY() !== startY) {
    // Nothing restored on a page that reacted: the provider reads the LIVE
    // page, which now shows the walk's last (bottom) window. A virtualizer
    // the merge could not rebuild (rows without text, canvas) would then
    // hand over the tail instead of the opening screen the legacy capture
    // read, so return to where the page opened and let it re-render there.
    scrollToY(startY)
    await settleQuiet()
    stats.rewound = true
  }
  stats.elapsedMs = Date.now() - started
  return stats

  // Wait until the page stops adding or removing elements (bounded).
  async function settleQuiet(): Promise<void> {
    let churn = 0
    const watch = new MutationObserver(records => {
      for (const record of records) if (counts(record.addedNodes) || counts(record.removedNodes)) churn++
    })
    watch.observe(body!, { childList: true, subtree: true })
    try {
      for (let round = 0; round < 5; round++) {
        await sleep(p.stepSettleMs)
        for (const record of watch.takeRecords()) if (counts(record.addedNodes) || counts(record.removedNodes)) churn++
        if (churn === 0) break
        churn = 0
      }
    } finally {
      watch.disconnect()
    }
  }
}

/**
 * The walk's knobs for one fetch: the module constants plus its budget.
 *
 * @param budgetMs - wall-clock budget the walk may spend inside the page.
 */
export function deepCaptureParams(budgetMs: number): DeepCaptureParams {
  return {
    budgetMs: Math.max(0, Math.round(budgetMs)),
    stepRatio: SCROLL_STEP_RATIO,
    stepMotionMs: SCROLL_STEP_MOTION_MS,
    stepSettleMs: SCROLL_STEP_SETTLE_MS,
    bottomPollMs: SCROLL_BOTTOM_POLL_MS,
    bottomPatienceMs: SCROLL_BOTTOM_PATIENCE_MS,
    inertPatienceMs: SCROLL_INERT_PATIENCE_MS,
    inertSteps: SCROLL_INERT_STEPS,
    maxSteps: SCROLL_MAX_STEPS,
    stashMaxEntries: SCROLL_STASH_MAX_ENTRIES,
    stashMaxChars: SCROLL_STASH_MAX_CHARS,
    stashMaxEntryChars: SCROLL_STASH_MAX_ENTRY_CHARS,
    containerMinRangePx: SCROLL_CONTAINER_MIN_RANGE_PX,
    containerMinRatio: SCROLL_CONTAINER_MIN_RANGE_RATIO,
    textDegradeTolerance: SCROLL_TEXT_DEGRADE_TOLERANCE,
  }
}

/**
 * Compose the evaluate expression: the in-page walk applied to `params` and
 * the shared scripting strip, both by source.
 *
 * @param params - the walk's knobs (see {@link deepCaptureParams}).
 * @returns the expression string to pass to `page.evaluate`.
 */
export function deepCaptureExpression(params: DeepCaptureParams): string {
  return `/* dsh-deep-capture */ (${deepCaptureInPage.toString()})(${JSON.stringify(params)}, ${stripScriptingElementsIn.toString()})`
}

/** {@link deepCaptureExpression} over {@link deepCaptureParams} — one fetch's walk. */
export function deepCaptureScript(budgetMs: number): string {
  return deepCaptureExpression(deepCaptureParams(budgetMs))
}

/**
 * Run the deep-capture walk in the page, degrading silently to the legacy
 * single-instant capture on any failure: a page without `evaluate`, a budget
 * too small to act, a rejected evaluation (the fetch deadline closes the tab
 * mid-walk), or a result that is not the stats object all just skip it. A
 * walk can only add content, never fail a fetch.
 *
 * @param page - the fetch's tab.
 * @param budgetMs - wall-clock budget for the in-page walk; budgets under
 *   {@link SCROLL_MIN_BUDGET_MS} skip it.
 * @returns the walk's stats (with the merged `html` when it restored
 *   anything), or undefined when the walk did not run.
 */
export async function deepCaptureWalk(page: PlaywrightPage, budgetMs: number): Promise<DeepCapture | undefined> {
  if (typeof page.evaluate !== 'function') return undefined
  if (budgetMs < SCROLL_MIN_BUDGET_MS) return undefined
  try {
    const result = await page.evaluate(deepCaptureScript(budgetMs))
    if (result === null || typeof result !== 'object') return undefined
    const raw = result as Partial<DeepCapture>
    if (typeof raw.steps !== 'number' || typeof raw.stashed !== 'number' || typeof raw.rehydrated !== 'number') {
      return undefined
    }
    return {
      steps: raw.steps,
      stashed: raw.stashed,
      rehydrated: raw.rehydrated,
      ...(typeof raw.spliced === 'number' ? { spliced: raw.spliced } : {}),
      ...(typeof raw.restored === 'number' ? { restored: raw.restored } : {}),
      ...(typeof raw.rewound === 'boolean' ? { rewound: raw.rewound } : {}),
      ...(typeof raw.reactive === 'boolean' ? { reactive: raw.reactive } : {}),
      ...(typeof raw.elapsedMs === 'number' ? { elapsedMs: raw.elapsedMs } : {}),
      ...(typeof raw.height === 'number' ? { height: raw.height } : {}),
      ...(raw.skipped === 'not-scrollable' || raw.skipped === 'no-budget' ? { skipped: raw.skipped } : {}),
      ...(typeof raw.html === 'string' ? { html: raw.html } : {}),
    }
  } catch {
    // A failed walk degrades to the legacy capture; the fetch continues.
    return undefined
  }
}
