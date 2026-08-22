/**
 * Integration smoke: a real local HTTP server through the REAL provider
 * (real playwright resolution, real browser launch, real denoise pipeline).
 * Self-skips when no usable local playwright/browser exists — resolution
 * succeeding is not enough (playwright-core resolves even without browsers),
 * so a launch probe runs once in `beforeAll` and the cases skip when it fails
 * — keeping the suite green on machines and CI runners without browsers.
 *
 * The CDP case launches a real Chromium with `--remote-debugging-port` and
 * drives it the way a user's remote-browser setup does: one shared
 * connection, many tabs.
 */
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import { PlaywrightFetchProvider } from '../src/provider.ts'
import { resolvePlaywrightBackend } from '../src/playwright-resolve.ts'

const PAGE = `<!doctype html><html><head><title>Smoke page</title></head><body>
<nav><a href="/x">nav link</a></nav>
<main><article><h1>Smoke heading</h1><p>The rendered body text.</p><p>A second paragraph so the article extractor locks onto the main content region.</p></article></main>
<footer>footer noise</footer>
</body></html>`

let server: ReturnType<typeof createServer>
let baseUrl: string
let browserAvailable = false
let backendSource = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no server address')
  baseUrl = `http://127.0.0.1:${String(address.port)}/`

  // Resolution succeeding is not enough: the bundled playwright-core resolves
  // even when no browser binary is installed, and launch is the real gate.
  try {
    const resolution = await resolvePlaywrightBackend('')
    backendSource = resolution.source
    const browser = await resolution.chromium.launch({ headless: true, timeout: 20_000 })
    await browser.close()
    browserAvailable = true
  } catch (error) {
    console.warn(`skipping browser smoke: ${String(error instanceof Error ? error.message : error)}`)
  }
})

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
})

describe('PlaywrightFetchProvider integration', () => {
  it('fetches a local page through a real browser and denoises it', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping browser smoke (no launchable browser)')
      return
    }
    console.warn(`smoke backend: ${backendSource}`)

    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      denoise: true,
      maxConcurrency: 4,
    }))
    const result = await provider.fetch({ url: baseUrl })
    expect(result.statusCode).toBe(200)
    expect(result.url).toBe(baseUrl)
    expect(result.body.kind).toBe('text')
    const content = result.body.kind === 'text' ? result.body.content : ''
    expect(content).toMatch(/^# (Smoke page|Smoke heading)\b/m)
    expect(content).toContain('The rendered body text.')
    expect(content).not.toContain('nav link')
    expect(content).not.toContain('footer noise')
  })

  it('returns raw html with denoise off', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping browser smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      denoise: false,
      maxConcurrency: 4,
    }))
    const result = await provider.fetch({ url: baseUrl })
    expect(result.body.kind).toBe('html')
    if (result.body.kind === 'html') expect(result.body.content).toContain('<article>')
  })

  it('maps an unreachable page to a structured WebError', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping browser smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      denoise: true,
      maxConcurrency: 4,
    }))
    // Port 1 on loopback: connection refused by the OS, no browser page loads.
    const error = await provider.fetch({ url: 'http://127.0.0.1:1/' })
      .then(() => { throw new Error('expected rejection') }, (e: unknown) => e)
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
  })
})

/** CDP-mode smoke: a real Chromium with a debugging port, as users configure it. */
describe('PlaywrightFetchProvider CDP integration', () => {
  let debugBrowser: import('playwright-core').Browser | undefined
  let endpoint = ''

  beforeAll(async () => {
    if (!browserAvailable) return
    // A real Chromium with CDP exposed, like a user's remote browser.
    const { chromium } = await import('playwright-core')
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer()
      probe.listen(0, '127.0.0.1', () => {
        const address = probe.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('no probe port'))
          return
        }
        const { port: free } = address
        probe.close(() => { resolve(free) })
      })
    })
    debugBrowser = await chromium.launch({
      headless: true,
      args: [`--remote-debugging-port=${String(port)}`, '--no-first-run'],
      timeout: 20_000,
    })
    // The debugging endpoint comes up a moment after the process; poll it.
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${String(port)}/json/version`)
        if (response.ok) break
      } catch {
        // not up yet
      }
      await new Promise(resolve => { setTimeout(resolve, 200) })
    }
    endpoint = `127.0.0.1:${String(port)}`
  }, 60_000)

  afterAll(async () => {
    await debugBrowser?.close().catch(() => {})
  })

  it('fetches through a real remote browser over CDP and denoises it', { timeout: 120_000 }, async () => {
    if (!browserAvailable || debugBrowser === undefined) {
      console.warn('skipping CDP smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: endpoint,
      denoise: true,
    }))
    const result = await provider.fetch({ url: baseUrl })
    expect(result.statusCode).toBe(200)
    expect(result.body.kind).toBe('text')
    const content = result.body.kind === 'text' ? result.body.content : ''
    expect(content).toMatch(/^# (Smoke page|Smoke heading)\b/m)
    expect(content).not.toContain('nav link')
    await provider.dispose()
  })

  it('serves a concurrent burst as tabs over the one shared connection', { timeout: 120_000 }, async () => {
    if (!browserAvailable || debugBrowser === undefined) {
      console.warn('skipping CDP smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: endpoint,
      denoise: true,
    }))
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
      provider.fetch({ url: `${baseUrl}?tab=${String(i)}` })))
    const ok = results.filter(entry => entry.status === 'fulfilled').length
    expect(ok).toBe(12)
    await provider.dispose()
  })
})
