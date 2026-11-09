/**
 * Deep-capture walk: the script builder's shape and the driver's silent
 * degradation, over fake pages (no browser needed — the in-page script's
 * behavior is proven end to end by the integration suite's virtualized
 * fixture).
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCROLL_BUDGET_MS,
  SCROLL_BOTTOM_PATIENCE_MS,
  SCROLL_BOTTOM_POLL_MS,
  SCROLL_MAX_STEPS,
  SCROLL_MIN_BUDGET_MS,
  SCROLL_STEP_MOTION_MS,
  SCROLL_STEP_RATIO,
  SCROLL_STASH_MAX_ENTRY_CHARS,
  deepCaptureScript,
  deepCaptureWalk,
} from '../src/autoscroll.ts'
import type { PlaywrightPage } from '../src/types.ts'

/** A minimal page whose evaluate records what the provider asked it to run. */
function fakePage(behavior: {
  result?: unknown
  error?: Error
}): { page: PlaywrightPage; scripts: string[] } {
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

describe('deepCaptureScript', () => {
  it('bakes the per-fetch budget and the walk constants into one expression', () => {
    const script = deepCaptureScript(7_500)
    expect(script).toContain('dsh-deep-capture')
    expect(script).toContain('BUDGET_MS = 7500')
    expect(script).toContain(`STEP_RATIO = ${String(SCROLL_STEP_RATIO)}`)
    expect(script).toContain(`STEP_MOTION_MS = ${String(SCROLL_STEP_MOTION_MS)}`)
    expect(script).toContain(`BOTTOM_POLL_MS = ${String(SCROLL_BOTTOM_POLL_MS)}`)
    expect(script).toContain(`BOTTOM_PATIENCE_MS = ${String(SCROLL_BOTTOM_PATIENCE_MS)}`)
    expect(script).toContain(`MAX_STEPS = ${String(SCROLL_MAX_STEPS)}`)
    expect(script).toContain(`STASH_MAX_ENTRY_CHARS = ${String(SCROLL_STASH_MAX_ENTRY_CHARS)}`)
    // The walk's load-bearing invariants, stated where a maintainer will read them.
    expect(script).toContain('BOTTOM_PATIENCE_MS) {')
    expect(script).toContain('grown !== lastHeight')
    // An async IIFE expression is what page.evaluate accepts as a string.
    expect(script.startsWith('(async () => {')).toBe(true)
    expect(script.endsWith('})()')).toBe(true)
  })

  it('clamps a non-positive budget to 0 rather than baking garbage', () => {
    expect(deepCaptureScript(0)).toContain('BUDGET_MS = 0')
    expect(deepCaptureScript(-3)).toContain('BUDGET_MS = 0')
  })
})

describe('deepCaptureWalk', () => {
  it('returns the stats object the page resolved', async () => {
    const stats = { steps: 9, stashed: 44, rehydrated: 31, elapsedMs: 4_100, height: 8_955 }
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

  it('drops unknown optional fields instead of forwarding them', async () => {
    const { page } = fakePage({ result: { steps: 1, stashed: 2, rehydrated: 3, injected: 'x' } })
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
