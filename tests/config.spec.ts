/**
 * Config schema defaults and the CDP endpoint normalizer (pure, network-free).
 */
import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_CDP_ENDPOINT, normalizeCdpEndpoint } from '../src/config.ts'

describe('Config', () => {
  it('fills every field default', () => {
    const resolved = Config({})
    expect(resolved).toEqual({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      denoise: true,
    })
  })

  it('accepts a full CDP section unchanged', () => {
    const resolved = Config({ backend: 'cdp', cdpEndpoint: 'browser.lan:9223', denoise: false })
    expect(resolved).toEqual({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: 'browser.lan:9223',
      denoise: false,
    })
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
