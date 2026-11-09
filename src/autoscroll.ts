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
 * in-page async walk (this module's {@link deepCaptureScript}, evaluated like
 * the challenge probe and the scripting strip):
 *
 * 1. Resolve the walk TARGET: the window when the document itself scrolls
 *    (the Discourse shape), else the page's dominant inner scroll container
 *    (the app-shell shape) — the element with the largest scrollable
 *    distance among computed `overflow-y: auto|scroll` elements, gated at
 *    half a viewport so dropdown-sized scrollers never trigger a walk. A
 *    page with neither is left alone (the legacy capture).
 * 2. Stash every keyed content element at the current position, then from
 *    the top of the target. A key is an element's id, else its
 *    `data-block-id` (namespaced — app-shell editors key their blocks that
 *    way and carry no id at all).
 * 3. Step down by 70% of the target's viewport per step, each step a SMOOTH
 *    300ms-animated descent (time-interpolated ticks, so background-tab
 *    throttling self-corrects) followed by a quiet settle where the feed
 *    engine's debounced uncloak fires, stashing what each window renders
 *    (richest snapshot per key — a row first seen as its placeholder is
 *    upgraded when its rendered form appears), until the walk can hold AT
 *    THE BOTTOM through a full {@link SCROLL_BOTTOM_PATIENCE_MS} window
 *    with the target height unchanged — growth at any poll restarts the
 *    clock, which is what pages load-more sentinels; height stability
 *    anywhere else proves nothing (measured on the linux.do badcase, the
 *    height was final at half-page while half the posts had never entered
 *    the window) — or the step/budget caps close it.
 * 4. Restore the original scroll position (courtesy for the app and, on a
 *    shared CDP tab, its user); the reaction this may trigger lands inside
 *    the restore settle, BEFORE the merge.
 * 5. MERGE, in synchronous phases with no await between them: REPARSE the
 *    live document into a fresh `createHTMLDocument` (working on a
 *    deterministic reparse sidesteps every stale-closure hazard a walk's
 *    worth of mutations can leave behind), then RESTORE keyed elements in
 *    the fresh tree two ways — every element that is emptier than its
 *    stashed snapshot (fewer child elements, or meaningfully less text) is
 *    swapped for that snapshot, except containers (elements with a
 *    descendant the merge would itself restore), which are assembled from
 *    those descendants instead, and on container walks keys that are
 *    MISSING outright (removed, not degraded — the Feishu shape, whose
 *    placeholders are anonymous) are spliced back at their walk-order
 *    position: a run of absent keys before the next surviving key, after
 *    the last, before the first. Nested keys whose keyed parent is spliced
 *    in the same run (and verifiably inside its snapshot) ride along with
 *    it instead of duplicating themselves. Finally TRANSPLANT the merged
 *    root into the live document. The transplant severs the app's
 *    listeners, so no late scroll/rAF/timer reaction can re-virtualize what
 *    the walk restored; the final DOM holds the union of every window in
 *    document order, and the existing Readability/DOMPurify/turndown
 *    pipeline runs unchanged.
 *
 * Failure is always silent degradation: a page without `evaluate`, a script
 * error, or an engine that rejects the walk just keeps the legacy
 * single-instant capture — a walk can only add content, never fail a fetch.
 *
 * The walk runs in BOTH denoise modes (the raw-HTML path serializes the same
 * cloaked placeholders) but never for non-HTML documents. It is bounded by
 * the `scrollBudgetMs` setting (default {@link DEFAULT_SCROLL_BUDGET_MS};
 * `0` restores the pre-walk legacy behavior, the challenge knobs' pattern)
 * and always by the remaining fetch deadline minus a decode reserve — the
 * provider's abort closes the tab, which rejects the pending evaluation.
 *
 * @module dsh-web-fetch-playwright/autoscroll
 */

import type { PlaywrightPage } from './types.ts'

/** How far each step scrolls, as a share of the viewport height. */
export const SCROLL_STEP_RATIO = 0.7

/**
 * How long one step's smooth scroll motion takes (ms). The step ANIMATES
 * down its distance over this window (time-interpolated ticks at ~60fps)
 * instead of teleporting: the page's scroll handlers see a continuous,
 * human-like stream of scroll events, which is what feed engines'
 * uncloak/re-cloak logic is built around — and background-tab timer
 * throttling self-corrects, because every tick derives its position from
 * the wall clock rather than counting frames.
 */
export const SCROLL_STEP_MOTION_MS = 300

/**
 * Per-step settle (ms): the QUIET window after the motion, where a feed
 * engine's debounced uncloak fires (measured: stepping without a rest
 * starves Discourse's cloak manager, which renders nothing new until the
 * scroll rests ~300ms) and the freshly rendered rows become stashable.
 */
export const SCROLL_STEP_SETTLE_MS = 300

/**
 * How often the walk re-checks the document height while holding at the
 * bottom, waiting out a feed page's next-chunk fetch.
 */
export const SCROLL_BOTTOM_POLL_MS = 450

/**
 * How long at the bottom, with no height growth, before the walk concludes
 * the page is complete. Real feed engines fetch their next chunk with
 * network latency — measured on linux.do, a pending chunk landed well after
 * two 450ms stability checks and a confirmation beat had concluded "done"
 * — so the patience window is sized over a slow chunk round-trip, not a
 * re-render. A page that is truly done pays this once.
 */
export const SCROLL_BOTTOM_PATIENCE_MS = 2_500

/** Hard cap on scroll steps regardless of budget (unbounded feeds). */
export const SCROLL_MAX_STEPS = 50

/** Cap on stashed elements — pathological id counts cannot pin memory. */
export const SCROLL_STASH_MAX_ENTRIES = 400

/** Cap on stashed HTML characters (aligned with the pipeline input cap). */
export const SCROLL_STASH_MAX_CHARS = 2_000_000

/**
 * Cap on ONE stashed element's HTML. A virtualized row is a few KB; an
 * element tens of KB big is a CONTAINER (whose outerHTML embeds every
 * descendant — measured on linux.do, six nested wrappers each embed the
 * whole post stream: main 164KB ⊃ main-outlet-wrapper 156KB ⊃ …, plus
 * data-preloaded 300KB and svg-sprites 277KB, ballooning one collect pass
 * to 1.9MB of the 2MB budget before any post row was reached) or a data
 * island — either way never a row the merge could rehydrate. The walk
 * assembles containers from their own stashed descendants instead.
 */
export const SCROLL_STASH_MAX_ENTRY_CHARS = 64_000

/** Settle (ms) after restoring the original position, before rehydration. */
export const SCROLL_RESTORE_SETTLE_MS = 120

/**
 * Tail of the fetch budget the walk never spends, keeping room for the
 * scripting strip, the content read, and the synchronous denoise decode.
 */
export const SCROLL_FINISH_RESERVE_MS = 4_000

/**
 * A walk budget below this cannot complete even the first window plus one
 * stability check, so the walk is skipped outright instead of tearing the
 * page around for nothing.
 */
export const SCROLL_MIN_BUDGET_MS = 500

/**
 * Default bounded walk budget (ms); the `scrollBudgetMs` schema default.
 * Sized so long topics stay fully covered at the smooth cadence (300ms of
 * motion + 300ms of rest per ~0.7-viewport step, plus the bottom patience
 * window): 20s walks ~25kpx with pagination, which covers the measured
 * linux.do badcase (~18kpx, 51 replies) with headroom.
 */
export const DEFAULT_SCROLL_BUDGET_MS = 20_000

/** Ceiling the schema accepts for `scrollBudgetMs`. */
export const MAX_SCROLL_BUDGET_MS = 30_000

/**
 * Floor (px) on the scrollable distance an inner container must offer
 * before the walk will target it, when the document itself does not scroll.
 * Half a viewport typically; never below this absolute floor.
 */
export const SCROLL_CONTAINER_MIN_RANGE_PX = 300

/**
 * The viewport share an inner container's scrollable distance must reach
 * (see {@link SCROLL_CONTAINER_MIN_RANGE_PX}).
 */
export const SCROLL_CONTAINER_MIN_RANGE_RATIO = 0.5

/** What one completed (or skipped) walk reports back, for tests and logs. */
export interface DeepCaptureStats {
  /** Scroll steps taken (0 when the walk skipped or had no room). */
  steps: number
  /** Distinct keys stashed across the walk. */
  stashed: number
  /** Placeholder elements rehydrated from the stash in the final DOM. */
  rehydrated: number
  /**
   * Keyed elements the engine had REMOVED (not degraded) that the merge
   * spliced back from the stash — container walks only (window walks keep
   * their placeholders in the DOM, so swaps already cover them).
   */
  spliced?: number
  /** Walk duration (ms). */
  elapsedMs?: number
  /** Walk-target height (px) — document or inner scroll container. */
  height?: number
  /** Set when the walk skipped without scrolling, and why. */
  skipped?: 'not-scrollable' | 'no-budget'
}

/**
 * Build the deep-capture script for one fetch. The walk parameters are baked
 * into the expression string (the {@link CHALLENGE_DOM_PROBE} /
 * {@link STRIP_SCRIPTING_ELEMENTS} house style): `page.evaluate` receives a
 * self-contained async IIFE whose promise resolves to the walk's
 * {@link DeepCaptureStats}.
 *
 * Written in deliberately plain ES2017-ish: no optional chaining, no arrow
 * shorthand that transpiles oddly through engines older than the browsers
 * Playwright drives, no template literals (this IS one).
 *
 * @param budgetMs - wall-clock budget the walk may spend inside the page.
 * @returns the expression string to pass to `page.evaluate`.
 */
export function deepCaptureScript(budgetMs: number): string {
  return `(async () => {
  // dsh-deep-capture: see src/autoscroll.ts for the measured badcases this defeats.
  var BUDGET_MS = ${JSON.stringify(Math.max(0, Math.round(budgetMs)))};
  var STEP_RATIO = ${JSON.stringify(SCROLL_STEP_RATIO)};
  var STEP_MOTION_MS = ${JSON.stringify(SCROLL_STEP_MOTION_MS)};
  var STEP_SETTLE_MS = ${JSON.stringify(SCROLL_STEP_SETTLE_MS)};
  var BOTTOM_POLL_MS = ${JSON.stringify(SCROLL_BOTTOM_POLL_MS)};
  var BOTTOM_PATIENCE_MS = ${JSON.stringify(SCROLL_BOTTOM_PATIENCE_MS)};
  var MAX_STEPS = ${JSON.stringify(SCROLL_MAX_STEPS)};
  var STASH_MAX_ENTRIES = ${JSON.stringify(SCROLL_STASH_MAX_ENTRIES)};
  var STASH_MAX_CHARS = ${JSON.stringify(SCROLL_STASH_MAX_CHARS)};
  var STASH_MAX_ENTRY_CHARS = ${JSON.stringify(SCROLL_STASH_MAX_ENTRY_CHARS)};
  var RESTORE_SETTLE_MS = ${JSON.stringify(SCROLL_RESTORE_SETTLE_MS)};
  var CONTAINER_MIN_RANGE_PX = ${JSON.stringify(SCROLL_CONTAINER_MIN_RANGE_PX)};
  var CONTAINER_MIN_RATIO = ${JSON.stringify(SCROLL_CONTAINER_MIN_RANGE_RATIO)};
  var TEXT_DEGRADE_TOLERANCE = 16;

  var doc = document.documentElement;
  var body = document.body;
  var started = Date.now();
  if (!doc || !body) return { steps: 0, stashed: 0, rehydrated: 0, spliced: 0, skipped: 'not-scrollable' };
  if (BUDGET_MS <= 0) return { steps: 0, stashed: 0, rehydrated: 0, spliced: 0, skipped: 'no-budget' };

  // Walk target: the WINDOW when the document itself scrolls (the Discourse
  // shape), else the page's dominant inner scroll container — the app-shell
  // shape (Feishu docs, Notion-class editors): body locked at exactly one
  // viewport, all content scrolling inside one container, and window-only
  // primitives are no-ops (measured on the Feishu badcase: documentElement
  // scrollHeight 720 == innerHeight, window.scrollTo(0, 800) left scrollY at
  // 0, while div.bear-web-x-container held 4534px against a 656px client).
  // The largest scrollable distance wins; document order keeps the OUTERMOST
  // on ties. The gate (at least half a viewport, never under an absolute
  // floor) keeps dropdown-sized scrollers from ever triggering a walk.
  function findScrollContainer() {
    var minRange = Math.round(Math.max(CONTAINER_MIN_RANGE_PX, window.innerHeight * CONTAINER_MIN_RATIO));
    var best = null;
    var bestRange = 0;
    var els = body.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var range = el.scrollHeight - el.clientHeight;
      if (!(range >= minRange)) continue;
      var oy = getComputedStyle(el).overflowY;
      if (oy !== 'auto' && oy !== 'scroll') continue;
      if (range > bestRange) { bestRange = range; best = el; }
    }
    return best;
  }
  var scroller = null; // null -> the window is the walk target
  if (doc.scrollHeight <= window.innerHeight + 4) {
    scroller = findScrollContainer();
    if (scroller === null) {
      return { steps: 0, stashed: 0, rehydrated: 0, spliced: 0, skipped: 'not-scrollable' };
    }
  }
  var containerWalk = scroller !== null;

  // Window-or-container: every walk primitive below speaks through these.
  function viewportH() { return scroller === null ? window.innerHeight : scroller.clientHeight }
  function docH() { return scroller === null ? doc.scrollHeight : scroller.scrollHeight }
  function curY() { return scroller === null ? window.scrollY : scroller.scrollTop }
  function scrollToY(y) {
    if (scroller === null) {
      try { window.scrollTo({ top: y, behavior: 'instant' }) }
      catch (e) { window.scrollTo(0, y) }
    } else {
      scroller.scrollTop = y
    }
  }

  // Identity: an element's id, else its data-block-id (namespaced so the two
  // attributes can never collide). App-shell editors key their blocks by
  // data-block-id and carry no id at all (measured: every block on the Feishu
  // badcase), so an id-only stash would find nothing to rehydrate.
  function keyOf(el) {
    var id = el.id;
    if (id) return id;
    var raw = el.getAttribute('data-block-id');
    return raw ? 'data-block-id:' + raw : null;
  }
  // The serialized attribute to search a snapshot's html for, used to prove a
  // nested key really rides inside its parent's snapshot.
  function markOf(el) {
    var id = el.id;
    if (id) return 'id="' + id + '"';
    var raw = el.getAttribute('data-block-id');
    return raw ? 'data-block-id="' + raw + '"' : null;
  }

  // key -> { html, els, text, len, parent, mark }: the RICHEST snapshot of a
  // key wins. A virtualized row is often first seen as its placeholder — the
  // walk starts at the top, outside that row's render window — so the
  // rendered article it becomes a few steps later must REPLACE the
  // placeholder entry, while a rendered row collapsing back to a placeholder
  // must never downgrade the stash. Richness is child-element count, then
  // text length. parent is the nearest keyed ANCESTOR (null at the top), the
  // splice pass's guard against re-adding a block that rides inside its
  // parent's own snapshot.
  var stash = new Map();
  var stashChars = 0;
  // First-observation order of container-internal keys — document order for
  // a top-down walk, the splice pass's positional source.
  var order = [];
  function collect() {
    var els = body.querySelectorAll('[id], [data-block-id]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var key = keyOf(el);
      if (key === null) continue;
      if (typeof SVGElement === 'function' && el instanceof SVGElement) continue;
      var elText = el.textContent.length;
      var elEls = el.childElementCount;
      if (elEls === 0 && elText === 0) continue;
      var prev = stash.get(key);
      if (prev !== undefined && elEls <= prev.els && elText <= prev.text) continue;
      // New keys stop at the entry cap; upgrading a stashed key never counts
      // against it (a richer window replacing a placeholder snapshot is the
      // walk's whole point).
      if (prev === undefined && stash.size >= STASH_MAX_ENTRIES) continue;
      var html = el.outerHTML;
      if (html.length > STASH_MAX_ENTRY_CHARS) continue;
      if (stashChars - (prev !== undefined ? prev.len : 0) + html.length > STASH_MAX_CHARS) continue;
      if (prev !== undefined) stashChars -= prev.len;
      var ancestor = el.parentElement;
      var parentKey = null;
      while (ancestor !== null && ancestor !== body) {
        var ancestorKey = keyOf(ancestor);
        if (ancestorKey !== null) { parentKey = ancestorKey; break; }
        ancestor = ancestor.parentElement;
      }
      var isNew = prev === undefined;
      stash.set(key, { html: html, els: elEls, text: elText, len: html.length, parent: parentKey, mark: markOf(el) });
      stashChars += html.length;
      if (isNew && containerWalk && scroller.contains(el)) order.push(key);
    }
  }

  function atBottom() {
    return curY() + viewportH() >= docH() - 2;
  }
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms) });
  }
  // One step's smooth descent: animate dy pixels over STEP_MOTION_MS with
  // time-interpolated ticks (~16ms apart). Every tick derives its position
  // from the wall clock, so background-tab timer throttling degrades to a
  // few coarse jumps along the same path — the motion never stalls, and the
  // page's scroll handlers still see the descent as continuous scrolling
  // rather than a teleport. Setting scrollTop per tick drives an inner
  // container the same way window.scrollTo drives the document; both fire
  // the scroll-event stream the feed engines' uncloak logic reacts to.
  function smoothScrollBy(dy, durationMs) {
    return new Promise(function (resolve) {
      var startY = curY();
      var t0 = Date.now();
      function tick() {
        var progress = (Date.now() - t0) / durationMs;
        if (progress >= 1 || (curY() !== startY && curY() + viewportH() >= docH() - 2)) {
          scrollToY(startY + dy);
          resolve();
          return;
        }
        scrollToY(startY + Math.round(dy * progress));
        setTimeout(tick, 16);
      }
      tick();
    });
  }

  // Stash whatever the initial (possibly anchored) position renders, then
  // restart from the top of the target so the walk covers the whole thing.
  var startScrollY = curY();
  collect();
  if (curY() > 0) {
    scrollToY(0);
    await sleep(STEP_SETTLE_MS);
    collect();
  }

  var steps = 0;
  var lastHeight = docH();
  var lastChangeAt = Date.now();
  while (steps < MAX_STEPS && Date.now() - started < BUDGET_MS) {
    if (atBottom()) {
      // Bottom patience: hold here and poll — a feed page's next chunk is
      // one network round trip away, and growth at ANY poll restarts the
      // clock (the walk then keeps scrolling into what loaded). Completion
      // is only trusted after the full patience window passes with the
      // height unchanged; height stability anywhere else proves nothing
      // (measured on the linux.do badcase, the height was final at
      // half-page while half the posts had never entered the window).
      await sleep(BOTTOM_POLL_MS);
      collect();
      var grown = docH();
      if (grown !== lastHeight) {
        lastHeight = grown;
        lastChangeAt = Date.now();
      } else if (Date.now() - lastChangeAt >= BOTTOM_PATIENCE_MS) {
        break;
      }
      continue;
    }
    steps++;
    await smoothScrollBy(Math.max(1, Math.round(viewportH() * STEP_RATIO)), STEP_MOTION_MS);
    collect();
    await sleep(STEP_SETTLE_MS);
    collect();
    var stepped = docH();
    if (stepped !== lastHeight) {
      lastHeight = stepped;
      lastChangeAt = Date.now();
    }
  }

  // Back to where the page started; the reaction this may trigger (re-
  // cloaking the far window) lands inside this settle, BEFORE the merge.
  scrollToY(startScrollY);
  await sleep(RESTORE_SETTLE_MS);
  var finalHeight = docH();

  // MERGE, in synchronous phases with NO await between them:
  //
  // 1. REPARSE: serialize the live document and parse it into a FRESH
  //    document (createHTMLDocument — scripts never execute there). Working
  //    on a deterministic reparse sidesteps every stale-closure and
  //    half-detached-tree hazard a walk's worth of mutations can leave in
  //    the live DOM, and the html element's own attributes ride along
  //    explicitly (innerHTML does not carry them).
  // 2. RESTORE keyed elements, two ways. SWAP: every keyed element that is
  //    degraded versus its stashed snapshot — fewer child elements (the
  //    Discourse placeholder is an empty div with one screen-reader heading
  //    where the article it stands for has a full subtree) or meaningfully
  //    less text — for that snapshot. A still-healthy element, the common
  //    case on non-virtualized pages, is left untouched. Only LEAF items
  //    are swapped — an element with restorable descendants is assembled
  //    from those descendants, and swapping the container first would
  //    orphan them: its snapshot is a partial window too, and the swap
  //    detaches every static-list entry inside it, silently no-oping the
  //    rest of the merge (the measured failure mode). SPLICE (container
  //    walks): stashed keys the reparse no longer HOLDS were removed by the
  //    engine, not degraded (the Feishu shape — its placeholders are one
  //    anonymous explicit-height spacer), and are inserted back at their
  //    walk-order position instead.
  // 3. TRANSPLANT: adopt the merged root into the live document and replace
  //    its documentElement. The transplanted tree carries no listeners (the
  //    app's scroll handlers, rAF callbacks, and timers all reference the
  //    old tree), so no late reaction can re-cloak what the walk restored —
  //    and the provider's serialization strip and page.content() then read
  //    the merged tree like any other.
  var rehydrated = 0;
  var spliced = 0;
  var mergedRoot = null;
  var fresh = document.implementation.createHTMLDocument('dsh-deep-capture');
  fresh.documentElement.innerHTML = doc.innerHTML;
  var liveAttrs = doc.attributes;
  for (var a = 0; a < liveAttrs.length; a++) {
    fresh.documentElement.setAttribute(liveAttrs[a].name, liveAttrs[a].value);
  }
  function degraded(el, snap) {
    return el.childElementCount < snap.els ||
      snap.text - el.textContent.length > TEXT_DEGRADE_TOLERANCE;
  }
  // Keys the reparse holds; computed once because swaps never REMOVE keys
  // (a snapshot carries the key of the element it replaces). An absent key
  // is the splice pass's to restore — and it pins its keyed ancestors as
  // containers, so no partial-window snapshot swap can orphan it.
  var freshKeys = null;
  function absentFromFresh(key) {
    if (freshKeys === null) {
      freshKeys = {};
      var held = fresh.querySelectorAll('[id], [data-block-id]');
      for (var q = 0; q < held.length; q++) {
        var heldKey = keyOf(held[q]);
        if (heldKey !== null) freshKeys[heldKey] = true;
      }
    }
    return freshKeys[key] !== true;
  }
  // A container is assembled from its own stashed descendants, never swapped
  // wholesale: its snapshot is one window's partial view, and replacing it
  // would discard what those descendants restore. But "has an keyed
  // descendant" is too blunt a container test — Discourse's placeholder
  // itself embeds an id-bearing screen-reader heading (post-heading-N),
  // which is never restorable (it is never degraded), so the row must stay
  // eligible. A container is therefore an element with a descendant the
  // merge WOULD restore — degraded in place, or (container walks) removed
  // outright and awaiting its splice; everything else is a row.
  function isContainer(el) {
    var inner = el.querySelectorAll('[id], [data-block-id]');
    for (var k = 0; k < inner.length; k++) {
      var ik = keyOf(inner[k]);
      if (ik === null) continue;
      var innerSnap = stash.get(ik);
      if (innerSnap === undefined) continue;
      if (degraded(inner[k], innerSnap)) return true;
      if (containerWalk && absentFromFresh(ik)) return true;
    }
    return false;
  }
  var freshEls = fresh.querySelectorAll('[id], [data-block-id]');
  for (var j = 0; j < freshEls.length; j++) {
    var current = freshEls[j];
    var ckey = keyOf(current);
    if (ckey === null) continue;
    var snapshot = stash.get(ckey);
    if (snapshot === undefined) continue;
    if (typeof SVGElement === 'function' && current instanceof SVGElement) continue;
    // Cheap check first: most elements are healthy and never reach the
    // descendant walk below.
    if (!degraded(current, snapshot)) continue;
    if (isContainer(current)) continue;
    current.outerHTML = snapshot.html;
    rehydrated++;
  }

  // SPLICE (container walks only — window-walked placeholders stay in the
  // DOM, so swaps already cover them, and re-adding expired keyed UI to a
  // scrolled document would only risk noise). A run of absent keys is
  // inserted right before the next surviving key, after the last survivor
  // when nothing follows, before the first when nothing precedes. The
  // engine's anonymous height-only spacer is simply left in place: an empty
  // styled div is invisible to the extraction pipeline. A key whose keyed
  // PARENT is spliced in the same run — and whose serialized attribute
  // verifiably appears inside that parent's snapshot html — rides along
  // with it instead of duplicating itself as a sibling.
  if (containerWalk && order.length > 0) {
    var presentEl = {};
    var survivors = fresh.querySelectorAll('[id], [data-block-id]');
    for (var m = 0; m < survivors.length; m++) {
      var sk = keyOf(survivors[m]);
      if (sk !== null && presentEl[sk] === undefined) presentEl[sk] = survivors[m];
    }
    var pending = [];
    var lastAnchor = null;
    function flush(before) {
      if (pending.length === 0) return;
      if (before === null && lastAnchor === null) { pending = []; return; }
      var chosen = [];
      for (var f = 0; f < pending.length; f++) {
        var entry = stash.get(pending[f]);
        var rides = false;
        if (entry.parent !== null) {
          for (var g = 0; g < f; g++) {
            if (pending[g] === entry.parent && stash.get(pending[g]).html.indexOf(entry.mark) !== -1) {
              rides = true;
              break;
            }
          }
        }
        if (!rides) chosen.push(entry.html);
      }
      var html = chosen.join('');
      try {
        if (before !== null) before.insertAdjacentHTML('beforebegin', html);
        else lastAnchor.insertAdjacentHTML('afterend', html);
        spliced += chosen.length;
      } catch (e) {
        // Best effort: a run with no insertable anchor stays absent.
      }
      pending = [];
    }
    for (var p = 0; p <= order.length; p++) {
      if (p === order.length) { flush(null); break; }
      var ok = order[p];
      var anchor = presentEl[ok];
      if (anchor !== undefined) {
        flush(anchor);
        lastAnchor = anchor;
      } else if (stash.has(ok)) {
        pending.push(ok);
      }
    }
  }

  if (rehydrated > 0 || spliced > 0) {
    mergedRoot = document.adoptNode(fresh.documentElement);
    document.replaceChild(mergedRoot, doc);
  }
  return {
    steps: steps,
    stashed: stash.size,
    rehydrated: rehydrated,
    spliced: spliced,
    elapsedMs: Date.now() - started,
    height: finalHeight
  };
})()`
}

/**
 * Run the deep-capture walk in the page, degrading silently to the legacy
 * single-instant capture on any failure: a page without `evaluate` (minimal
 * fakes and engines), a budget too small to act, a rejected evaluation (the
 * fetch deadline closes the tab mid-walk), or a result that is not the stats
 * object all just skip the walk. A walk can only add content, never fail a
 * fetch.
 *
 * @param page - the fetch's tab.
 * @param budgetMs - wall-clock budget for the in-page walk; non-positive
 *   budgets (and budgets under {@link SCROLL_MIN_BUDGET_MS}) skip it.
 * @returns the walk's stats, or undefined when the walk did not run.
 */
export async function deepCaptureWalk(page: PlaywrightPage, budgetMs: number): Promise<DeepCaptureStats | undefined> {
  if (typeof page.evaluate !== 'function') return undefined
  if (budgetMs < SCROLL_MIN_BUDGET_MS) return undefined
  try {
    const result = await page.evaluate(deepCaptureScript(budgetMs))
    if (result === null || typeof result !== 'object') return undefined
    const stats = result as Partial<DeepCaptureStats>
    if (typeof stats.steps !== 'number' || typeof stats.stashed !== 'number' || typeof stats.rehydrated !== 'number') {
      return undefined
    }
    return {
      steps: stats.steps,
      stashed: stats.stashed,
      rehydrated: stats.rehydrated,
      ...(typeof stats.spliced === 'number' ? { spliced: stats.spliced } : {}),
      ...(typeof stats.elapsedMs === 'number' ? { elapsedMs: stats.elapsedMs } : {}),
      ...(typeof stats.height === 'number' ? { height: stats.height } : {}),
      ...(stats.skipped === 'not-scrollable' || stats.skipped === 'no-budget' ? { skipped: stats.skipped } : {}),
    }
  } catch {
    // A failed walk degrades to the legacy capture; the fetch continues.
    return undefined
  }
}
