/**
 * Config schema defaults, the CDP endpoint normalizer, and the
 * backend-dependent concurrency resolution (pure, network-free).
 */
import { describe, expect, it } from 'vitest'
import {
  Config,
  DEFAULT_CDP_ENDPOINT,
  DEFAULT_MAX_CONCURRENCY_CDP,
  DEFAULT_MAX_CONCURRENCY_LOCAL,
  MAX_CONCURRENCY_CEILING,
  effectiveMaxConcurrency,
  normalizeCdpEndpoint,
} from '../src/config.ts'

describe('Config', () => {
  it('fills every field default it owns (maxConcurrency stays optional)', () => {
    const resolved = Config({})
    expect(resolved).toEqual({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      denoise: true,
    })
  })

  it('accepts a full CDP section unchanged', () => {
    const resolved = Config({ backend: 'cdp', cdpEndpoint: 'browser.lan:9223', denoise: false, maxConcurrency: 50 })
    expect(resolved).toEqual({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: 'browser.lan:9223',
      denoise: false,
      maxConcurrency: 50,
    })
  })

  it('accepts maxConcurrency across its whole integer range and rejects outside it', () => {
    expect(Config({ maxConcurrency: 1 }).maxConcurrency).toBe(1)
    expect(Config({ maxConcurrency: MAX_CONCURRENCY_CEILING }).maxConcurrency).toBe(MAX_CONCURRENCY_CEILING)
    expect(() => Config({ maxConcurrency: 0 })).toThrow()
    expect(() => Config({ maxConcurrency: MAX_CONCURRENCY_CEILING + 1 })).toThrow()
    expect(() => Config({ maxConcurrency: 2.5 })).toThrow()
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
