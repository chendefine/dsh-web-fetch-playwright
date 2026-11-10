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
 *    - SWAP: every keyed element emptier than its snapshot (fewer child
 *      elements, or meaningfully less text — the Discourse placeholder) is
 *      replaced by that snapshot, except containers (ancestors of another
 *      element being swapped), which are assembled from those descendants
 *      instead: a container's own snapshot is one window's partial view.
 *    The clone is then stripped of scripting elements and serialized; the
 *    provider reads that string instead of the live page. The live document
 *    is never rewritten, so no late scroll/rAF/timer reaction can touch the
 *    capture either.
 *
 * Failure is always silent degradation: a page without `evaluate`, a script
 * error, or an engine that rejects the walk just keeps the legacy
 * single-instant capture — a walk can only add content, never fail a fetch.
 * A walk that restored nothing returns no HTML, and the provider reads the
 * live page exactly as before.
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
  function keyOf(el: Element): string | null {
    if (el.id !== '') return el.id
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
    }
  }
  const observer = new MutationObserver(tally)
  observer.observe(body, { childList: true, subtree: true })
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
    observer.disconnect()
    requestObserver?.disconnect()
  }
  const reactive = reacted()
  const finalHeight = scrollH()

  // ── Merge into a structural clone (synchronous from here on) ──────────
  const fresh = document.cloneNode(true) as Document
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

  // SWAP degraded leaves for their snapshots; their ancestors are
  // containers, assembled from them rather than swapped wholesale.
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
  let rehydrated = 0
  for (const { el, snap } of degraded) {
    if (containers.has(el)) continue
    el.replaceWith(fresh.importNode(snap.node, true))
    rehydrated++
  }

  const stats: DeepCapture = {
    steps,
    stashed: stash.size,
    rehydrated,
    spliced,
    reactive,
    elapsedMs: Date.now() - started,
    height: finalHeight,
  }
  if ((rehydrated > 0 || spliced > 0) && fresh.documentElement !== null) {
    strip(fresh)
    // page.content()'s own serialization: doctype, then the root element.
    const doctype = fresh.doctype === null ? '' : new XMLSerializer().serializeToString(fresh.doctype)
    stats.html = doctype + fresh.documentElement.outerHTML
  }
  return stats
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
