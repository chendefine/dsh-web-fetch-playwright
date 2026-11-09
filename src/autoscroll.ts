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
 * HOW. Between the settle and the serialization the provider runs one
 * in-page async walk (this module's {@link deepCaptureScript}, evaluated like
 * the challenge probe and the scripting strip):
 *
 * 1. Stash every id-bearing content element at the current position, then
 *    from the top of the document.
 * 2. Step down by 70% of the viewport per step, each step a SMOOTH
 *    300ms-animated descent (time-interpolated ticks, so background-tab
 *    throttling self-corrects) followed by a quiet settle where the feed
 *    engine's debounced uncloak fires, stashing what each window renders
 *    (richest snapshot per id — a row first seen as its placeholder is
 *    upgraded when its rendered form appears), until the walk can hold AT
 *    THE BOTTOM through a full {@link SCROLL_BOTTOM_PATIENCE_MS} window
 *    with the document height unchanged — growth at any poll restarts the
 *    clock, which is what pages load-more sentinels; height stability
 *    anywhere else proves nothing (measured on the linux.do badcase, the
 *    height was final at half-page while half the posts had never entered
 *    the window) — or the step/budget caps close it.
 * 3. Restore the original scroll position (courtesy for the app and, on a
 *    shared CDP tab, its user); the reaction this may trigger lands inside
 *    the restore settle, BEFORE the merge.
 * 4. MERGE, in three synchronous phases with no await between them:
 *    REPARSE the live document into a fresh `createHTMLDocument` (working on
 *    a deterministic reparse sidesteps every stale-closure hazard a walk's
 *    worth of mutations can leave behind), REHYDRATE it — every id-bearing
 *    element that is emptier than its stashed snapshot (fewer child
 *    elements, or meaningfully less text) is swapped for that snapshot,
 *    except containers (elements with a descendant the merge would itself
 *    restore), which are assembled from those descendants instead — then
 *    TRANSPLANT the merged root into the live document. The transplant
 *    severs the app's listeners, so no late scroll/rAF/timer reaction can
 *    re-virtualize what the walk restored; the final DOM holds the union of
 *    every window in document order, and the existing
 *    Readability/DOMPurify/turndown pipeline runs unchanged.
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

/** What one completed (or skipped) walk reports back, for tests and logs. */
export interface DeepCaptureStats {
  /** Scroll steps taken (0 when the walk skipped or had no room). */
  steps: number
  /** Distinct ids stashed across the walk. */
  stashed: number
  /** Placeholder elements rehydrated from the stash in the final DOM. */
  rehydrated: number
  /** Walk duration (ms). */
  elapsedMs?: number
  /** Document height (px) when the walk ended. */
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
  // dsh-deep-capture: see src/autoscroll.ts for the measured badcase this defeats.
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
  var TEXT_DEGRADE_TOLERANCE = 16;

  var doc = document.documentElement;
  var body = document.body;
  var started = Date.now();
  if (!doc || !body) return { steps: 0, stashed: 0, rehydrated: 0, skipped: 'not-scrollable' };
  if (BUDGET_MS <= 0) return { steps: 0, stashed: 0, rehydrated: 0, skipped: 'no-budget' };
  if (doc.scrollHeight <= window.innerHeight + 4) {
    return { steps: 0, stashed: 0, rehydrated: 0, skipped: 'not-scrollable' };
  }

  // id -> { html, els, text, len }: the RICHEST snapshot of an id wins. A
  // virtualized row is often first seen as its placeholder — the walk starts
  // at the top, outside that row's render window — so the rendered article
  // it becomes a few steps later must REPLACE the placeholder entry, while a
  // rendered row collapsing back to a placeholder must never downgrade the
  // stash. Richness is child-element count, then text length.
  var stash = new Map();
  var stashChars = 0;
  function collect() {
    var els = body.querySelectorAll('[id]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var id = el.id;
      if (!id) continue;
      if (typeof SVGElement === 'function' && el instanceof SVGElement) continue;
      var elText = el.textContent.length;
      var elEls = el.childElementCount;
      if (elEls === 0 && elText === 0) continue;
      var prev = stash.get(id);
      if (prev !== undefined && elEls <= prev.els && elText <= prev.text) continue;
      // New ids stop at the entry cap; upgrading a stashed id never counts
      // against it (a richer window replacing a placeholder snapshot is the
      // walk's whole point).
      if (prev === undefined && stash.size >= STASH_MAX_ENTRIES) continue;
      var html = el.outerHTML;
      if (html.length > STASH_MAX_ENTRY_CHARS) continue;
      if (stashChars - (prev !== undefined ? prev.len : 0) + html.length > STASH_MAX_CHARS) continue;
      if (prev !== undefined) stashChars -= prev.len;
      stash.set(id, { html: html, els: elEls, text: elText, len: html.length });
      stashChars += html.length;
    }
  }

  function atBottom() {
    return window.scrollY + window.innerHeight >= doc.scrollHeight - 2;
  }
  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms) });
  }
  function scrollTo(y) {
    try { window.scrollTo({ top: y, behavior: 'instant' }) }
    catch (e) { window.scrollTo(0, y) }
  }
  // One step's smooth descent: animate dy pixels over STEP_MOTION_MS with
  // time-interpolated ticks (~16ms apart). Every tick derives its position
  // from the wall clock, so background-tab timer throttling degrades to a
  // few coarse jumps along the same path — the motion never stalls, and the
  // page's scroll handlers still see the descent as continuous scrolling
  // rather than a teleport.
  function smoothScrollBy(dy, durationMs) {
    return new Promise(function (resolve) {
      var startY = window.scrollY;
      var t0 = Date.now();
      function tick() {
        var progress = (Date.now() - t0) / durationMs;
        if (progress >= 1 || window.scrollY !== startY && (window.scrollY + window.innerHeight >= doc.scrollHeight - 2)) {
          scrollTo(startY + dy);
          resolve();
          return;
        }
        scrollTo(startY + Math.round(dy * progress));
        setTimeout(tick, 16);
      }
      tick();
    });
  }

  // Stash whatever the initial (possibly anchored) position renders, then
  // restart from the top so the walk covers the whole document.
  var startScrollY = window.scrollY;
  collect();
  if (window.scrollY > 0) {
    scrollTo(0);
    await sleep(STEP_SETTLE_MS);
    collect();
  }

  var steps = 0;
  var lastHeight = doc.scrollHeight;
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
      var grown = doc.scrollHeight;
      if (grown !== lastHeight) {
        lastHeight = grown;
        lastChangeAt = Date.now();
      } else if (Date.now() - lastChangeAt >= BOTTOM_PATIENCE_MS) {
        break;
      }
      continue;
    }
    steps++;
    await smoothScrollBy(Math.max(1, Math.round(window.innerHeight * STEP_RATIO)), STEP_MOTION_MS);
    collect();
    await sleep(STEP_SETTLE_MS);
    collect();
    var stepped = doc.scrollHeight;
    if (stepped !== lastHeight) {
      lastHeight = stepped;
      lastChangeAt = Date.now();
    }
  }

  // Back to where the page started; the reaction this may trigger (re-
  // cloaking the far window) lands inside this settle, BEFORE the merge.
  scrollTo(startScrollY);
  await sleep(RESTORE_SETTLE_MS);

  // MERGE, in three synchronous phases with NO await between them:
  //
  // 1. REPARSE: serialize the live document and parse it into a FRESH
  //    document (createHTMLDocument — scripts never execute there). Working
  //    on a deterministic reparse sidesteps every stale-closure and
  //    half-detached-tree hazard a walk's worth of mutations can leave in
  //    the live DOM, and the html element's own attributes ride along
  //    explicitly (innerHTML does not carry them).
  // 2. REHYDRATE: in the fresh tree, swap every id-bearing element that is
  //    degraded versus its stashed snapshot — fewer child elements (the
  //    Discourse placeholder is an empty div with one screen-reader heading
  //    where the article it stands for has a full subtree) or meaningfully
  //    less text — for that snapshot. A still-healthy element, the common
  //    case on non-virtualized pages, is left untouched. Only LEAF items are
  //    swapped — an element with id-bearing descendants is assembled from
  //    those descendants' own snapshots below it in the list, and swapping
  //    the container first would orphan them: its snapshot is a partial
  //    window too, and the swap detaches every static-list entry inside it,
  //    silently no-oping the rest of the merge (the measured failure mode).
  // 3. TRANSPLANT: adopt the merged root into the live document and replace
  //    its documentElement. The transplanted tree carries no listeners (the
  //    app's scroll handlers, rAF callbacks, and timers all reference the
  //    old tree), so no late reaction can re-cloak what the walk restored —
  //    and the provider's serialization strip and page.content() then read
  //    the merged tree like any other.
  var rehydrated = 0;
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
  // A container is assembled from its own stashed descendants, never swapped
  // wholesale: its snapshot is one window's partial view, and replacing it
  // would discard what those descendants restore. But "has an id-descendant"
  // is too blunt a container test — Discourse's placeholder itself embeds an
  // id-bearing screen-reader heading (post-heading-N), which is never
  // restorable (it is never degraded), so the row must stay eligible. A
  // container is therefore an element with a descendant that the merge WOULD
  // restore; everything else is a row.
  function isContainer(el) {
    var inner = el.querySelectorAll('[id]');
    for (var k = 0; k < inner.length; k++) {
      var innerSnap = stash.get(inner[k].id);
      if (innerSnap !== undefined && degraded(inner[k], innerSnap)) return true;
    }
    return false;
  }
  var freshEls = fresh.querySelectorAll('[id]');
  for (var j = 0; j < freshEls.length; j++) {
    var current = freshEls[j];
    var snapshot = stash.get(current.id);
    if (snapshot === undefined) continue;
    if (typeof SVGElement === 'function' && current instanceof SVGElement) continue;
    // Cheap check first: most elements are healthy and never reach the
    // descendant walk below.
    if (!degraded(current, snapshot)) continue;
    if (isContainer(current)) continue;
    current.outerHTML = snapshot.html;
    rehydrated++;
  }
  if (rehydrated > 0) {
    mergedRoot = document.adoptNode(fresh.documentElement);
    document.replaceChild(mergedRoot, doc);
  }
  return {
    steps: steps,
    stashed: stash.size,
    rehydrated: rehydrated,
    elapsedMs: Date.now() - started,
    height: document.documentElement.scrollHeight
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
      ...(typeof stats.elapsedMs === 'number' ? { elapsedMs: stats.elapsedMs } : {}),
      ...(typeof stats.height === 'number' ? { height: stats.height } : {}),
      ...(stats.skipped === 'not-scrollable' || stats.skipped === 'no-budget' ? { skipped: stats.skipped } : {}),
    }
  } catch {
    // A failed walk degrades to the legacy capture; the fetch continues.
    return undefined
  }
}
