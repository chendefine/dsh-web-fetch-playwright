/**
 * Config schema defaults, the CDP endpoint normalizer, the backend-dependent
 * concurrency resolution, and the challenge-wait knobs (pure, network-free).
 *
 * The schema's fields are all `.volatile()`: resolving through the schema
 * (what {@link resolveConfig} does — validate, fill defaults, unwrap the
 * volatile references) yields the plain section the provider consumes, so
 * these tests resolve every input that way.
 */
import { describe, expect, it } from 'vitest'
import {
  Config,
  DEFAULT_CDP_ENDPOINT,
  DEFAULT_CHALLENGE_RETRIES,
  DEFAULT_CHALLENGE_WAIT_MS,
  DEFAULT_MAX_CONCURRENCY_CDP,
  DEFAULT_MAX_CONCURRENCY_LOCAL,
  DEFAULT_SCROLL_BUDGET_MS,
  MAX_CHALLENGE_RETRIES,
  MAX_CHALLENGE_WAIT_MS,
  MAX_CONCURRENCY_CEILING,
  MAX_SCROLL_BUDGET_MS,
  effectiveChallengeRetries,
  effectiveChallengeWaitMs,
  effectiveContextMode,
  effectiveMaxConcurrency,
  effectiveScrollBudgetMs,
  normalizeCdpEndpoint,
  resolveConfig,
  snapshotsOf,
} from '../src/config.ts'
import type { PlaywrightPluginConfig } from '../src/config.ts'

describe('Config', () => {
  it('fills every field default it owns (maxConcurrency stays optional)', () => {
    const resolved = resolveConfig({})
    expect(resolved).toEqual({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      contextIsolationScope: 'global',
      denoise: true,
      challengeWaitMs: DEFAULT_CHALLENGE_WAIT_MS,
      challengeRetries: DEFAULT_CHALLENGE_RETRIES,
      scrollBudgetMs: DEFAULT_SCROLL_BUDGET_MS,
    })
  })

  it('resolves every field as a live volatile reference', () => {
    // The schema itself (what the loader runs against the composition row)
    // wraps every field in a Volatile ref — the face `apply` receives.
    const resolved = Config({}) as PlaywrightPluginConfig
    expect(typeof resolved.backend.get).toBe('function')
    expect(resolved.backend.get()).toBe('local')
    expect(resolved.maxConcurrency.get()).toBeUndefined()
  })

  it('accepts a full CDP section unchanged', () => {
    const resolved = resolveConfig({
      backend: 'cdp',
      cdpEndpoint: 'browser.lan:9223',
      shareBrowserContext: false,
      contextIsolationScope: 'global',
      denoise: false,
      maxConcurrency: 50,
      challengeWaitMs: 30_000,
      challengeRetries: 2,
      scrollBudgetMs: 12_000,
    })
    expect(resolved).toEqual({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: 'browser.lan:9223',
      shareBrowserContext: false,
      contextIsolationScope: 'global',
      denoise: false,
      maxConcurrency: 50,
      challengeWaitMs: 30_000,
      challengeRetries: 2,
      scrollBudgetMs: 12_000,
    })
  })

  it('accepts maxConcurrency across its whole integer range and rejects outside it', () => {
    expect(resolveConfig({ maxConcurrency: 1 }).maxConcurrency).toBe(1)
    expect(resolveConfig({ maxConcurrency: MAX_CONCURRENCY_CEILING }).maxConcurrency).toBe(MAX_CONCURRENCY_CEILING)
    expect(() => resolveConfig({ maxConcurrency: 0 })).toThrow()
    expect(() => resolveConfig({ maxConcurrency: MAX_CONCURRENCY_CEILING + 1 })).toThrow()
    expect(() => resolveConfig({ maxConcurrency: 2.5 })).toThrow()
  })

  it('accepts the challenge knobs across their ranges, rejects outside them', () => {
    expect(resolveConfig({ challengeWaitMs: 0 }).challengeWaitMs).toBe(0)
    expect(resolveConfig({ challengeWaitMs: MAX_CHALLENGE_WAIT_MS }).challengeWaitMs).toBe(MAX_CHALLENGE_WAIT_MS)
    expect(() => resolveConfig({ challengeWaitMs: -1 })).toThrow()
    expect(() => resolveConfig({ challengeWaitMs: MAX_CHALLENGE_WAIT_MS + 1 })).toThrow()
    expect(resolveConfig({ challengeRetries: 0 }).challengeRetries).toBe(0)
    expect(resolveConfig({ challengeRetries: MAX_CHALLENGE_RETRIES }).challengeRetries).toBe(MAX_CHALLENGE_RETRIES)
    expect(() => resolveConfig({ challengeRetries: -1 })).toThrow()
    expect(() => resolveConfig({ challengeRetries: MAX_CHALLENGE_RETRIES + 1 })).toThrow()
  })

  it('accepts the scroll-walk budget across its range, rejects outside it', () => {
    expect(resolveConfig({ scrollBudgetMs: 0 }).scrollBudgetMs).toBe(0)
    expect(resolveConfig({ scrollBudgetMs: MAX_SCROLL_BUDGET_MS }).scrollBudgetMs).toBe(MAX_SCROLL_BUDGET_MS)
    expect(() => resolveConfig({ scrollBudgetMs: -1 })).toThrow()
    expect(() => resolveConfig({ scrollBudgetMs: MAX_SCROLL_BUDGET_MS + 1 })).toThrow()
    expect(() => resolveConfig({ scrollBudgetMs: 2.5 })).toThrow()
  })
})

describe('the volatile configuration face', () => {
  /** Build the live-reference face `apply` receives over one plain section. */
  function pluginConfig(section: Record<string, unknown>): PlaywrightPluginConfig {
    return Config(section as never) as PlaywrightPluginConfig
  }

  it('snapshotsOf dereferences every live field, defaults included', () => {
    const config = pluginConfig({ maxConcurrency: 8 })
    expect(snapshotsOf(config)).toEqual({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      contextIsolationScope: 'global',
      denoise: true,
      maxConcurrency: 8,
      challengeWaitMs: DEFAULT_CHALLENGE_WAIT_MS,
      challengeRetries: DEFAULT_CHALLENGE_RETRIES,
      scrollBudgetMs: DEFAULT_SCROLL_BUDGET_MS,
    })
  })

  it('a settings commit reaches the provider through the same references', () => {
    // A commit replaces a ref's snapshot in place (updateVolatile); the
    // provider's per-fetch projection sees the new value without a remount.
    // Model it exactly as the host does: fresh refs over the new section.
    const config = pluginConfig({ backend: 'local' })
    expect(resolveConfig(snapshotsOf(config)).backend).toBe('local')
    const updated = pluginConfig({ backend: 'cdp', cdpEndpoint: 'browser.lan:9222' })
    expect(resolveConfig(snapshotsOf(updated))).toMatchObject({ backend: 'cdp', cdpEndpoint: 'browser.lan:9222' })
  })

  it('an optional live field snapshots as undefined while unset', () => {
    const config = pluginConfig({})
    expect(snapshotsOf(config).maxConcurrency).toBeUndefined()
    // And resolveConfig keeps it optional (the backend resolves a default).
    expect(resolveConfig(snapshotsOf(config)).maxConcurrency).toBeUndefined()
  })
})

describe('effective challenge knobs', () => {
  it('an explicit wait wins; a missing one falls back to the schema default', () => {
    expect(effectiveChallengeWaitMs({ challengeWaitMs: 0 })).toBe(0)
    expect(effectiveChallengeWaitMs({ challengeWaitMs: 7_500 })).toBe(7_500)
    expect(effectiveChallengeWaitMs({})).toBe(DEFAULT_CHALLENGE_WAIT_MS)
  })

  it('an explicit retry count wins; a missing one falls back to the schema default', () => {
    expect(effectiveChallengeRetries({ challengeRetries: 0 })).toBe(0)
    expect(effectiveChallengeRetries({ challengeRetries: 3 })).toBe(3)
    expect(effectiveChallengeRetries({})).toBe(DEFAULT_CHALLENGE_RETRIES)
  })
})

describe('effectiveScrollBudgetMs', () => {
  it('an explicit budget wins (0 = the walk is off); a missing one falls back to the schema default', () => {
    expect(effectiveScrollBudgetMs({ scrollBudgetMs: 0 })).toBe(0)
    expect(effectiveScrollBudgetMs({ scrollBudgetMs: 7_500 })).toBe(7_500)
    expect(effectiveScrollBudgetMs({})).toBe(DEFAULT_SCROLL_BUDGET_MS)
  })
})

describe('effectiveMaxConcurrency', () => {
  it('defaults per backend: local browsers are dear, CDP tabs are cheap', () => {
    expect(effectiveMaxConcurrency({ backend: 'local' })).toBe(DEFAULT_MAX_CONCURRENCY_LOCAL)
    expect(effectiveMaxConcurrency({ backend: 'cdp' })).toBe(DEFAULT_MAX_CONCURRENCY_CDP)
    expect(DEFAULT_MAX_CONCURRENCY_CDP).toBeGreaterThan(DEFAULT_MAX_CONCURRENCY_LOCAL)
  })

  it('an explicit setting wins over both backend defaults', () => {
    expect(effectiveMaxConcurrency({ backend: 'local', maxConcurrency: 50 })).toBe(50)
    expect(effectiveMaxConcurrency({ backend: 'cdp', maxConcurrency: 2 })).toBe(2)
  })
})

describe('effectiveContextMode', () => {
  it('CDP shares the remote profile by default; an explicit opt-out isolates', () => {
    // Absent value reads as the schema default (true) — the checkbox's
    // "unchecked draft formats as ''" case collapses to the same thing.
    expect(effectiveContextMode({ backend: 'cdp' })).toBe('profile')
    expect(effectiveContextMode({ backend: 'cdp', shareBrowserContext: true })).toBe('profile')
    expect(effectiveContextMode({ backend: 'cdp', shareBrowserContext: false })).toBe('isolated')
  })

  it('the local backend has no shared profile to use — always isolated', () => {
    expect(effectiveContextMode({ backend: 'local' })).toBe('isolated')
    expect(effectiveContextMode({ backend: 'local', shareBrowserContext: true })).toBe('isolated')
  })
})

describe('normalizeCdpEndpoint', () => {
  it('defaults a blank endpoint to the loopback address', () => {
    expect(normalizeCdpEndpoint('')).toBe(`http://${DEFAULT_CDP_ENDPOINT}`)
    expect(normalizeCdpEndpoint('   ')).toBe(`http://${DEFAULT_CDP_ENDPOINT}`)
  })

  it('prefixes bare host:port with the http scheme', () => {
    expect(normalizeCdpEndpoint('127.0.0.1:9222')).toBe('http://127.0.0.1:9222')
    expect(normalizeCdpEndpoint('browser.internal:9222')).toBe('http://browser.internal:9222')
  })

  it('passes http(s)/ws(s) endpoints through', () => {
    expect(normalizeCdpEndpoint('http://127.0.0.1:9222')).toBe('http://127.0.0.1:9222')
    expect(normalizeCdpEndpoint('https://browser.corp:9222')).toBe('https://browser.corp:9222')
    expect(normalizeCdpEndpoint('ws://127.0.0.1:9222/devtools/browser/abc')).toBe('ws://127.0.0.1:9222/devtools/browser/abc')
  })

  it('rejects unparseable values', () => {
    expect(() => normalizeCdpEndpoint('http://')).toThrow()
    expect(() => normalizeCdpEndpoint('://missing-host')).toThrow()
  })
})


describe('isolated context reuse configuration', () => {
  it('defaults isolated contexts to global reuse', () => {
    const config = resolveConfig({ backend: 'cdp', shareBrowserContext: false })
    expect(config.contextIsolationScope).toBe('global')
  })

  it.each(['session', 'global'] as const)('accepts %s scope and exposes live snapshots', scope => {
    const config = Config({ contextIsolationScope: scope }) as PlaywrightPluginConfig
    expect(config.contextIsolationScope.get()).toBe(scope)
    expect(snapshotsOf(config)).toMatchObject({ contextIsolationScope: scope })
  })

  it('rejects unsupported isolation scopes', () => {
    expect(() => resolveConfig({ contextIsolationScope: 'fetch' as never })).toThrow()
  })
})
