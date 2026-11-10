/**
 * Deep-capture walk without a browser: the composed in-page expression is
 * evaluated BY SOURCE inside a jsdom window — exactly how `page.evaluate`
 * receives it, so a helper leaking a module-scope reference fails here —
 * against scripted virtualizers whose layout is stubbed (jsdom has none).
 * The driver's silent degradation runs over fake pages. Real-browser proof
 * of the same shapes lives in the integration suite.
 */
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  SCROLL_MIN_BUDGET_MS,
  deepCaptureExpression,
  deepCaptureParams,
  deepCaptureScript,
  deepCaptureWalk,
} from '../src/autoscroll.ts'
import type { DeepCapture, DeepCaptureParams } from '../src/autoscroll.ts'
import { DEFAULT_SCROLL_BUDGET_MS } from '../src/config.ts'
import type { PlaywrightPage } from '../src/types.ts'

/** Millisecond-scale knobs so a whole walk runs in well under a second. */
function fastParams(over: Partial<DeepCaptureParams> = {}): DeepCaptureParams {
  return {
    ...deepCaptureParams(5_000),
    stepMotionMs: 4,
    stepSettleMs: 4,
    bottomPollMs: 5,
    bottomPatienceMs: 40,
    inertPatienceMs: 10,
    ...over,
  }
}

type Win = JSDOM['window'] & { eval(src: string): unknown }

/** Run the composed expression inside the jsdom window, as the page would. */
async function runWalk(dom: JSDOM, params: DeepCaptureParams): Promise<DeepCapture> {
  return await ((dom.window as Win).eval(deepCaptureExpression(params)) as Promise<DeepCapture>)
}

const ROW_H = 100
const VIEW_H = 300

/**
 * Discourse shape over the WINDOW: rows outside [y - 1.5vh, y + 1.5vh] are
 * cloaked in place — same id, one id-bearing screen-reader heading, no body.
 */
function windowFeed(total: number): JSDOM {
  const dom = new JSDOM('<!doctype html><html><body><main id="stream"></main></body></html>', { runScripts: 'outside-only' })
  const { window } = dom
  const doc = window.document
  const stream = doc.getElementById('stream')!
  let y = 0
  const rendered = (n: number): string =>
    `<article id="post_${String(n)}"><h2 id="post-heading-${String(n)}">Reply ${String(n)}</h2><p>BODY-${String(n)} the reply text.</p></article>`
  const cloaked = (n: number): string =>
    `<div id="post_${String(n)}" class="cloaked"><h2 id="post-heading-${String(n)}">Reply ${String(n)}</h2></div>`
  for (let n = 1; n <= total; n++) stream.insertAdjacentHTML('beforeend', cloaked(n))
  const refresh = (): void => {
    for (let n = 1; n <= total; n++) {
      const top = (n - 1) * ROW_H
      const want = top >= y - VIEW_H * 1.5 && top <= y + VIEW_H * 1.5
      const el = doc.getElementById(`post_${String(n)}`)!
      if (want !== (el.tagName === 'ARTICLE')) el.outerHTML = want ? rendered(n) : cloaked(n)
    }
  }
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => VIEW_H })
  Object.defineProperty(window, 'scrollY', { configurable: true, get: () => y })
  Object.defineProperty(doc.documentElement, 'scrollHeight', { configurable: true, get: () => total * ROW_H })
  window.scrollTo = ((arg: ScrollToOptions) => {
    y = Math.max(0, Math.min(total * ROW_H - VIEW_H, arg.top ?? 0))
    refresh()
  }) as typeof window.scrollTo
  refresh()
  return dom
}

/**
 * Feishu shape: the document never scrolls; one overflow container does,
 * blocks carry only data-block-id, and off-window blocks are REMOVED. With
 * `anchorAt`, the walk starts mid-document (a deep link).
 */
function containerDoc(total: number, anchorAt = 0): JSDOM {
  const dom = new JSDOM(`<!doctype html><html><body>
<aside id="side">side noise</aside>
<div id="scroller" style="overflow-y: auto"><div id="wrap"><div class="spacer"></div></div></div>
<div id="toast">Saved</div>
</body></html>`, { runScripts: 'outside-only' })
  const { window } = dom
  const doc = window.document
  const scroller = doc.getElementById('scroller')!
  const wrap = doc.getElementById('wrap')!
  let top = 0
  const live = new Map<number, Element>()
  const block = (n: number): Element => {
    const el = doc.createElement('div')
    el.setAttribute('data-block-id', String(n))
    el.innerHTML = `<p>BLOCK-${String(n)} body text.</p>`
    return el
  }
  const refresh = (): void => {
    const want = new Set<number>()
    for (let n = 1; n <= total; n++) {
      const at = (n - 1) * ROW_H
      if (at + ROW_H >= top - VIEW_H && at <= top + VIEW_H * 2) want.add(n)
    }
    for (const [n, el] of live) if (!want.has(n)) { el.remove(); live.delete(n) }
    let anchor: Element | null = null
    for (let n = total; n >= 1; n--) {
      if (!want.has(n)) continue
      let el = live.get(n)
      if (el === undefined) { el = block(n); live.set(n, el); wrap.insertBefore(el, anchor) }
      anchor = el
    }
  }
  Object.defineProperty(window, 'innerHeight', { configurable: true, get: () => VIEW_H })
  Object.defineProperty(doc.documentElement, 'scrollHeight', { configurable: true, get: () => VIEW_H })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => VIEW_H })
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => total * ROW_H })
  Object.defineProperty(scroller, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = Math.max(0, Math.min(total * ROW_H - VIEW_H, v)); refresh() },
  })
  top = anchorAt
  refresh()
  // A transient toast that vanishes before the walk ends: never spliced back.
  window.setTimeout(() => { doc.getElementById('toast')?.remove() }, 5)
  return dom
}

/** A long page that never reacts to scrolling. */
function inertDoc(rows: number): { dom: JSDOM; scrolls: number[] } {
  const parts: string[] = []
  for (let n = 1; n <= rows; n++) parts.push(`<h2 id="sec-${String(n)}">Section ${String(n)}</h2><p>STATIC-${String(n)}</p>`)
  const dom = new JSDOM(`<!doctype html><html><body><article>${parts.join('')}</article></body></html>`, { runScripts: 'outside-only' })
  const scrolls: number[] = []
  let y = 0
  const height = rows * ROW_H
  Object.defineProperty(dom.window, 'innerHeight', { configurable: true, get: () => VIEW_H })
  Object.defineProperty(dom.window, 'scrollY', { configurable: true, get: () => y })
  Object.defineProperty(dom.window.document.documentElement, 'scrollHeight', { configurable: true, get: () => height })
  dom.window.scrollTo = ((arg: ScrollToOptions) => {
    y = Math.max(0, Math.min(height - VIEW_H, arg.top ?? 0))
    scrolls.push(y)
  }) as typeof dom.window.scrollTo
  return { dom, scrolls }
}

/**
 * jsdom has no Resource Timing: stand in a PerformanceObserver that reports
 * completed requests of the given initiator types once the walk reaches the
 * bottom of an {@link inertDoc}.
 */
function requestsAtBottom(dom: JSDOM, initiatorTypes: string[]): void {
  const pending: { initiatorType: string }[] = []
  const scrollTo = dom.window.scrollTo
  dom.window.scrollTo = ((arg: ScrollToOptions) => {
    scrollTo(arg)
    if (dom.window.scrollY + VIEW_H >= dom.window.document.documentElement.scrollHeight) {
      pending.push(...initiatorTypes.map(initiatorType => ({ initiatorType })))
    }
  }) as typeof dom.window.scrollTo
  Object.defineProperty(dom.window, 'PerformanceObserver', {
    configurable: true,
    value: class {
      observe(): void {}
      disconnect(): void {}
      takeRecords(): { initiatorType: string }[] { return pending.splice(0) }
    },
  })
}

const order = (html: string, prefix: string, total: number): number[] => {
  const at: number[] = []
  for (let n = 1; n <= total; n++) at.push(html.indexOf(`${prefix}-${String(n)} `))
  return at
}

describe('deepCaptureInPage (evaluated by source in jsdom)', () => {
  it('window walk: rehydrates every cloaked row in place, leaving no placeholder', async () => {
    const dom = windowFeed(30)
    const result = await runWalk(dom, fastParams())
    expect(result.reactive).toBe(true)
    expect(result.spliced).toBe(0)
    expect(result.rehydrated).toBeGreaterThan(0)
    const html = result.html ?? ''
    const at = order(html, 'BODY', 30)
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(html).not.toContain('class="cloaked"')
    // The walk serializes a clone: the live page is left as the engine had it.
    expect(dom.window.document.querySelectorAll('.cloaked').length).toBeGreaterThan(0)
  })

  it('container walk: splices removed blocks back in document order, even from an anchored start', async () => {
    const dom = containerDoc(30, 1_200)
    const result = await runWalk(dom, fastParams())
    expect(result.spliced).toBeGreaterThan(0)
    const html = result.html ?? ''
    const at = order(html, 'BLOCK', 30)
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    for (let n = 1; n <= 30; n++) expect(html.split(`BLOCK-${String(n)} `).length - 1).toBe(1)
    // Keyed UI outside the scroll container is never resurrected.
    expect(html).not.toContain('id="toast"')
  })

  it('scroll-inert page: two careful steps, then one jump — not a full walk', async () => {
    const { dom, scrolls } = inertDoc(100)
    const result = await runWalk(dom, fastParams())
    expect(result.reactive).toBe(false)
    expect(result.steps).toBe(3)
    expect(scrolls.at(-1)).toBe(100 * ROW_H - VIEW_H)
    // Nothing degraded, nothing restored: the provider reads the live page.
    expect(result.html).toBeUndefined()
  })

  it('scroll-inert page: holds at the bottom only for the short inert patience', async () => {
    const { dom } = inertDoc(100)
    const result = await runWalk(dom, fastParams({ bottomPatienceMs: 1_500, inertPatienceMs: 10 }))
    expect(result.reactive).toBe(false)
    expect(result.elapsedMs).toBeLessThan(1_000)
  })

  it('scroll-inert page that fetches data at the bottom keeps the full patience', async () => {
    const { dom } = inertDoc(100)
    requestsAtBottom(dom, ['img', 'xmlhttprequest'])
    const result = await runWalk(dom, fastParams({ bottomPatienceMs: 300, inertPatienceMs: 10 }))
    expect(result.reactive).toBe(false)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(300)
  })

  it('images and beacons at the bottom are not data requests: the short hold stands', async () => {
    const { dom } = inertDoc(100)
    requestsAtBottom(dom, ['img', 'beacon', 'css'])
    const result = await runWalk(dom, fastParams({ bottomPatienceMs: 1_500, inertPatienceMs: 10 }))
    expect(result.elapsedMs).toBeLessThan(1_000)
  })

  it('a page that reacts keeps the full bottom patience', async () => {
    const dom = windowFeed(30)
    const result = await runWalk(dom, fastParams({ bottomPatienceMs: 400, inertPatienceMs: 10 }))
    expect(result.reactive).toBe(true)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(400)
  })

  it('a page that does not scroll at all is skipped', async () => {
    const dom = new JSDOM('<!doctype html><html><body><p>short</p></body></html>', { runScripts: 'outside-only' })
    await expect(runWalk(dom, fastParams())).resolves.toMatchObject({ steps: 0, skipped: 'not-scrollable' })
  })

  it('strips scripting from the merged capture (data scripts cannot corrupt it)', async () => {
    const dom = windowFeed(20)
    const doc = dom.window.document
    doc.body.insertAdjacentHTML('beforeend', '<script id="__NEXT_DATA__" type="application/json">{}</script><script type="application/ld+json">{"a":"x</b>"}</script>')
    doc.getElementById('__NEXT_DATA__')!.textContent = '{"x":"</script><div>SOUP</div>"}'
    const html = (await runWalk(dom, fastParams())).html ?? ''
    expect(html).toContain('BODY-20 ')
    expect(html).not.toContain('SOUP')
    expect(html).toContain('{"a":"x<\\/b>"}')
  })
})

describe('deepCaptureScript', () => {
  it('composes one self-contained expression carrying the per-fetch budget', () => {
    const script = deepCaptureScript(7_500)
    expect(script.startsWith('/* dsh-deep-capture */ (')).toBe(true)
    expect(script).toContain('"budgetMs":7500')
    expect(() => new Function(`return ${script}`)).not.toThrow()
  })

  it('clamps a non-positive budget to 0, which the walk reports as no-budget', async () => {
    expect(deepCaptureScript(-3)).toContain('"budgetMs":0')
    const dom = windowFeed(10)
    await expect(runWalk(dom, fastParams({ budgetMs: 0 }))).resolves.toMatchObject({ skipped: 'no-budget' })
  })
})

/** A minimal page whose evaluate records what the provider asked it to run. */
function fakePage(behavior: { result?: unknown; error?: Error }): { page: PlaywrightPage; scripts: string[] } {
  const scripts: string[] = []
  const page = {
    evaluate: async (script: string): Promise<unknown> => {
      scripts.push(script)
      if (behavior.error !== undefined) throw behavior.error
      return behavior.result
    },
  } as unknown as PlaywrightPage
  return { page, scripts }
}

describe('deepCaptureWalk', () => {
  it('returns the stats object the page resolved, merged html included', async () => {
    const stats = { steps: 9, stashed: 44, rehydrated: 31, spliced: 27, reactive: true, elapsedMs: 4_100, height: 8_955, html: '<html></html>' }
    const { page, scripts } = fakePage({ result: stats })
    await expect(deepCaptureWalk(page, DEFAULT_SCROLL_BUDGET_MS)).resolves.toEqual(stats)
    expect(scripts).toHaveLength(1)
    expect(scripts[0]).toContain('dsh-deep-capture')
  })

  it('keeps the skip reason when the page reports one', async () => {
    const { page } = fakePage({ result: { steps: 0, stashed: 0, rehydrated: 0, skipped: 'not-scrollable' } })
    await expect(deepCaptureWalk(page, DEFAULT_SCROLL_BUDGET_MS)).resolves.toEqual({
      steps: 0, stashed: 0, rehydrated: 0, skipped: 'not-scrollable',
    })
  })

  it('drops unknown or mistyped optional fields instead of forwarding them', async () => {
    const { page } = fakePage({ result: { steps: 1, stashed: 2, rehydrated: 3, injected: 'x', html: 42 } })
    await expect(deepCaptureWalk(page, DEFAULT_SCROLL_BUDGET_MS)).resolves.toEqual({
      steps: 1, stashed: 2, rehydrated: 3,
    })
  })

  it('a budget under the minimum skips the walk without touching the page', async () => {
    const { page, scripts } = fakePage({ result: { steps: 0, stashed: 0, rehydrated: 0 } })
    await expect(deepCaptureWalk(page, SCROLL_MIN_BUDGET_MS - 1)).resolves.toBeUndefined()
    expect(scripts).toHaveLength(0)
  })

  it.each([
    ['the evaluation rejects (deadline closed the tab mid-walk)', { error: new Error('Target closed') }],
    ['the page resolved a non-object', { result: true }],
    ['the page resolved a malformed object', { result: { steps: 'many' } }],
    ['the page resolved null', { result: null }],
  ])('silently degrades to no stats when %s', async (_name, behavior) => {
    const { page } = fakePage(behavior as { result?: unknown; error?: Error })
    await expect(deepCaptureWalk(page, DEFAULT_SCROLL_BUDGET_MS)).resolves.toBeUndefined()
  })

  it('a page without evaluate (minimal fakes) skips the walk', async () => {
    const page = {} as PlaywrightPage
    await expect(deepCaptureWalk(page, DEFAULT_SCROLL_BUDGET_MS)).resolves.toBeUndefined()
  })
})
