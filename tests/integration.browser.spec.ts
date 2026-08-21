/**
 * Integration smoke: a real local HTTP server through the REAL provider
 * (real playwright resolution, real browser launch, real denoise pipeline).
 * Self-skips when no usable local playwright/browser exists so the suite
 * stays green on machines without browsers.
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

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no server address')
  baseUrl = `http://127.0.0.1:${String(address.port)}/`
})

afterAll(async () => {
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
})

describe('PlaywrightFetchProvider integration', () => {
  it('fetches a local page through a real browser and denoises it', { timeout: 120_000 }, async () => {
    let resolution: Awaited<ReturnType<typeof resolvePlaywrightBackend>>
    try {
      resolution = await resolvePlaywrightBackend('')
    } catch (error) {
      // No playwright on this machine — skip rather than fail.
      console.warn(`skipping browser smoke: ${String(error instanceof Error ? error.message : error)}`)
      return
    }
    console.warn(`smoke backend: ${resolution.source}`)

    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      denoise: true,
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
    try {
      await resolvePlaywrightBackend('')
    } catch {
      console.warn('skipping browser smoke (no playwright)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      denoise: false,
    }))
    const result = await provider.fetch({ url: baseUrl })
    expect(result.body.kind).toBe('html')
    if (result.body.kind === 'html') expect(result.body.content).toContain('<article>')
  })

  it('maps an unreachable page to a structured WebError', { timeout: 120_000 }, async () => {
    try {
      await resolvePlaywrightBackend('')
    } catch {
      console.warn('skipping browser smoke (no playwright)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      denoise: true,
    }))
    // Port 1 on loopback: connection refused by the OS, no browser page loads.
    const error = await provider.fetch({ url: 'http://127.0.0.1:1/' })
      .then(() => { throw new Error('expected rejection') }, (e: unknown) => e)
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
  })
})
