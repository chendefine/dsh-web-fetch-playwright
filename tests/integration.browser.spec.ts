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
 *
 * The challenge cases hang simulated Cloudflare edges off the same server —
 * `/guarded/*` serves a real-looking interstitial (403 + `cf-mitigated` +
 * localized title + challenge-platform markers) whose in-page script clears
 * naturally after a delay, exactly like a managed challenge a real browser
 * passes on its own — and run the SAME site against the feature-off baseline
 * and the feature-on provider for the before/after comparison (issue #2).
 */
import { createServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import { PlaywrightFetchProvider, WEB_FETCH_CHALLENGE_CODE } from '../src/provider.ts'
import { resolvePlaywrightBackend } from '../src/playwright-resolve.ts'

const PAGE = `<!doctype html><html><head><title>Smoke page</title></head><body>
<nav><a href="/x">nav link</a></nav>
<main><article><h1>Smoke heading</h1><p>The rendered body text.</p><p>A second paragraph so the article extractor locks onto the main content region.</p></article></main>
<footer>footer noise</footer>
</body></html>`

/** Cookie-jar probe page: the marker only renders when the request carried
 *  the cookie a previous response in the SAME context set. The title is kept
 *  short so Readability keeps the (distinct) h1 heading. */
const COOKIE_PAGE_SEEN = `<!doctype html><html><head><title>Probe</title></head><body>
<main><article><h1>Cookie probe COOKIE-SEEN</h1><p>The shared context carried the cookie this far.</p><p>A second paragraph so the article extractor locks onto the main content region.</p></article></main>
</body></html>`

const COOKIE_PAGE_BLANK = `<!doctype html><html><head><title>Probe</title></head><body>
<main><article><h1>Cookie probe</h1><p>No cookie rode along with this request.</p><p>A second paragraph so the article extractor locks onto the main content region.</p></article></main>
</body></html>`

/** The real document behind the simulated challenge edge. */
const GUARDED_ARTICLE = `<!doctype html><html><head><title>Simulated protected article</title></head><body>
<main><article><h1>Real protected content</h1>
<p>This paragraph only renders once the simulated Cloudflare challenge has cleared inside the browser itself, and there is enough prose for the article extractor to lock onto the main content region.</p>
<p>A second paragraph of real body text.</p>
</article></main>
</body></html>`

/** The article's body markup, reused by the SPA-clear variant's swap-in. */
const GUARDED_ARTICLE_BODY = `<main><article><h1>Real protected content</h1>
<p>This paragraph only renders once the simulated Cloudflare challenge has cleared inside the browser itself, and there is enough prose for the article extractor to lock onto the main content region.</p>
<p>A second paragraph of real body text.</p>
</article></main>`

/**
 * A realistic interstitial: the localized title, the challenge-platform
 * script, the `#challenge-*` stage, the Turnstile-era footer — and an
 * in-page script that clears the way a real managed challenge does. With
 * `clearAfterMs`, after the delay the page either sets its clearance cookie
 * and reloads (the classic flow) or swaps the body in place and rewrites
 * the URL without any navigation (the SPA flow); `null` never clears.
 */
function challengePage(clearAfterMs: number | null, spa: boolean): string {
  const clearScript = clearAfterMs === null
    ? 'setTimeout(function () {}, 1000);' // alive, never solving
    : spa
      ? `setTimeout(function () {
        document.title = 'Simulated protected article';
        document.body.innerHTML = ${JSON.stringify(GUARDED_ARTICLE_BODY)};
        history.replaceState(null, '', '/guarded/spa?cleared=1');
      }, ${String(clearAfterMs)});`
      : `setTimeout(function () {
        document.cookie = 'cf_clearance=sim; path=/';
        location.reload();
      }, ${String(clearAfterMs)});`
  return `<!doctype html><html lang="en"><head><title>Just a moment...</title></head><body>
<div class="main-wrapper"><div class="main-content">
<div id="challenge-stage"><div id="challenge-running"><span class="spinner"></span>Verifying you are human. This may take a few seconds.</div></div>
<div class="footer"><div class="footer-inner"><span class="ray-id">Ray ID: SIMULATED012345</span></div></div>
</div>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1/simulated" async></script>
<script>window._cf_chl_opt = { cvId: 3 };
${clearScript}</script>
</body></html>`
}

const CHALLENGE_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cf-mitigated': 'challenge',
  'server': 'cloudflare',
} as const

/** Observable counters of the simulated challenge edge. */
const challengeState = { challengesServed: 0 }

let server: ReturnType<typeof createServer>
let baseUrl: string
let browserAvailable = false
let backendSource = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? ''
    if (url.startsWith('/cdn-cgi/')) {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end('// simulated challenge platform script')
      return
    }
    if (url.startsWith('/guarded/')) {
      const cleared = (req.headers.cookie ?? '').includes('cf_clearance=')
      if (url.startsWith('/guarded/spa')) {
        // SPA variant: the shell swaps to the real document client-side;
        // no reload ever happens, so only a DOM probe can see the clear.
        challengeState.challengesServed++
        res.writeHead(403, CHALLENGE_HEADERS)
        res.end(challengePage(5_500, true))
        return
      }
      if (url.startsWith('/guarded/hard')) {
        // A challenge nothing clears automatically (interactive-only).
        challengeState.challengesServed++
        res.writeHead(403, CHALLENGE_HEADERS)
        res.end(challengePage(null, false))
        return
      }
      const fast = url.startsWith('/guarded/fast')
      if (!cleared) {
        challengeState.challengesServed++
        res.writeHead(403, CHALLENGE_HEADERS)
        res.end(challengePage(fast ? 1_500 : 6_500, false))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(GUARDED_ARTICLE)
      return
    }
    if (url.startsWith('/cookie')) {
      if ((req.headers.cookie ?? '').includes('dsh-profile-probe=')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(COOKIE_PAGE_SEEN)
      } else {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'dsh-profile-probe=1; Path=/' })
        res.end(COOKIE_PAGE_BLANK)
      }
      return
    }
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
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeWaitMs: 0,
      challengeRetries: 0,
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
      shareBrowserContext: true,
      denoise: false,
      maxConcurrency: 4,
      challengeWaitMs: 0,
      challengeRetries: 0,
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
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeWaitMs: 0,
      challengeRetries: 0,
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
      shareBrowserContext: false, // isolated: preserves this suite's original stance
      denoise: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
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
      shareBrowserContext: false, // isolated: preserves this suite's original stance
      denoise: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) =>
      provider.fetch({ url: `${baseUrl}?tab=${String(i)}` })))
    const ok = results.filter(entry => entry.status === 'fulfilled').length
    expect(ok).toBe(12)
    await provider.dispose()
  })

  // The two cases below prove the context-mode semantics end to end against
  // a real remote browser: profile fetches share its cookie jar (the tab a
  // cookie was set in is gone, the jar is not), isolated ones never do.
  it('profile mode: fetches share the remote browser cookie jar and the browser survives', { timeout: 120_000 }, async () => {
    if (!browserAvailable || debugBrowser === undefined) {
      console.warn('skipping CDP smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: endpoint,
      shareBrowserContext: true,
      denoise: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    const first = await provider.fetch({ url: `${baseUrl}cookie` })
    const second = await provider.fetch({ url: `${baseUrl}cookie` })
    expect(first.statusCode).toBe(200)
    const firstText = first.body.kind === 'text' ? first.body.content : ''
    const secondText = second.body.kind === 'text' ? second.body.content : ''
    expect(firstText).not.toContain('COOKIE-SEEN') // the jar started empty
    expect(secondText).toContain('COOKIE-SEEN') // ...and kept the first tab's cookie
    await provider.dispose()
    // Disconnecting the shared connection never touches the remote browser.
    expect(debugBrowser.isConnected()).toBe(true)
  })

  it('isolated mode: every fetch gets a fresh jar, no cookie crosses fetches', { timeout: 120_000 }, async () => {
    if (!browserAvailable || debugBrowser === undefined) {
      console.warn('skipping CDP smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: endpoint,
      shareBrowserContext: false,
      denoise: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    await provider.fetch({ url: `${baseUrl}cookie` }) // sets a cookie — then dies with its context
    const second = await provider.fetch({ url: `${baseUrl}cookie` })
    const secondText = second.body.kind === 'text' ? second.body.content : ''
    expect(secondText).not.toContain('COOKIE-SEEN')
    await provider.dispose()
  })

  // The issue #2 cookie boundary over CDP: the challenge clearance a fetch's
  // browser earns lives in the remote profile across fetches (profile mode)
  // and dies with the fetch's context (isolated mode) — never copied,
  // exported, or manufactured by the plugin itself.
  it('profile mode: challenge clearance persists in the remote browser — the second fetch skips the challenge', { timeout: 120_000 }, async () => {
    if (!browserAvailable || debugBrowser === undefined) {
      console.warn('skipping CDP smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: endpoint,
      shareBrowserContext: true,
      denoise: true,
      challengeWaitMs: 12_000,
      challengeRetries: 1,
    }))
    const first = await provider.fetch({ url: `${baseUrl}guarded/article` })
    const firstText = first.body.kind === 'text' ? first.body.content : ''
    expect(first.statusCode).toBe(200)
    expect(firstText).toContain('Real protected content')
    const served = challengeState.challengesServed
    const second = await provider.fetch({ url: `${baseUrl}guarded/article` })
    const secondText = second.body.kind === 'text' ? second.body.content : ''
    expect(second.statusCode).toBe(200)
    expect(secondText).toContain('Real protected content')
    // No new challenge was served: the profile's clearance cookie held.
    expect(challengeState.challengesServed).toBe(served)
    await provider.dispose()
    expect(debugBrowser.isConnected()).toBe(true)
  })

  it('isolated mode: challenge clearance dies with the fetch — the second fetch is challenged again', { timeout: 120_000 }, async () => {
    if (!browserAvailable || debugBrowser === undefined) {
      console.warn('skipping CDP smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: endpoint,
      shareBrowserContext: false,
      denoise: true,
      challengeWaitMs: 12_000,
      challengeRetries: 1,
    }))
    const first = await provider.fetch({ url: `${baseUrl}guarded/article` })
    expect(first.statusCode).toBe(200)
    const served = challengeState.challengesServed
    const second = await provider.fetch({ url: `${baseUrl}guarded/article` })
    const secondText = second.body.kind === 'text' ? second.body.content : ''
    // The fresh context was challenged again — and cleared it again on its own.
    expect(challengeState.challengesServed).toBe(served + 1)
    expect(secondText).toContain('Real protected content')
    await provider.dispose()
  })
})

/**
 * The issue #2 A/B comparison, against the simulated Cloudflare edge on the
 * SAME server: the baseline (challengeWaitMs 0 — the 0.2.4 behavior) versus
 * the bounded natural wait, run through a real browser.
 */
describe('PlaywrightFetchProvider challenge A/B (simulated Cloudflare edge)', () => {
  function localConfig(over: { challengeWaitMs: number; challengeRetries: number }) {
    return () => ({
      backend: 'local' as const,
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      ...over,
    })
  }

  function textOf(result: { body: { kind: string; content: string } }): string {
    return result.body.content
  }

  it('baseline (0.2.4 behavior): the managed-challenge interstitial comes back as content', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping challenge A/B (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({ challengeWaitMs: 0, challengeRetries: 0 }))
    const result = await provider.fetch({ url: `${baseUrl}guarded/article` })
    const text = textOf(result)
    expect(result.statusCode).toBe(403)
    expect(text).toMatch(/just a moment/i)
    expect(text).not.toContain('Real protected content')
    await provider.dispose()
  })

  it('feature on: the same site returns the real article after the browser clears the challenge', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping challenge A/B (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({ challengeWaitMs: 12_000, challengeRetries: 1 }))
    const started = Date.now()
    const result = await provider.fetch({ url: `${baseUrl}guarded/article` })
    const text = textOf(result)
    expect(result.statusCode).toBe(200)
    expect(text).toContain('Real protected content')
    expect(text).not.toMatch(/just a moment/i)
    // It actually waited out the simulated 6.5s verification.
    expect(Date.now() - started).toBeGreaterThan(5_000)
    await provider.dispose()
  })

  it('baseline on a never-clearing challenge returns the interstitial as content; the feature fails WEB_FETCH_CHALLENGE instead', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping challenge A/B (no launchable browser)')
      return
    }
    const baseline = new PlaywrightFetchProvider(localConfig({ challengeWaitMs: 0, challengeRetries: 0 }))
    const garbage = await baseline.fetch({ url: `${baseUrl}guarded/hard` })
    expect(textOf(garbage)).toMatch(/just a moment/i) // "succeeds" with garbage — the bug
    await baseline.dispose()

    const provider = new PlaywrightFetchProvider(localConfig({ challengeWaitMs: 2_000, challengeRetries: 0 }))
    const started = Date.now()
    const error = await provider.fetch({ url: `${baseUrl}guarded/hard` })
      .then(() => { throw new Error('expected rejection') }, (e: unknown) => e)
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe(WEB_FETCH_CHALLENGE_CODE)
    expect((error as WebError).message).toContain('Cloudflare')
    // Bounded: gave up after the wait window, nowhere near the 45s deadline.
    expect(Date.now() - started).toBeLessThan(20_000)
    await provider.dispose()
  })

  it('baseline misses SPA-style clears; the feature waits them out (no navigation at all)', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping challenge A/B (no launchable browser)')
      return
    }
    const baseline = new PlaywrightFetchProvider(localConfig({ challengeWaitMs: 0, challengeRetries: 0 }))
    const garbage = await baseline.fetch({ url: `${baseUrl}guarded/spa` })
    expect(textOf(garbage)).toMatch(/just a moment/i)
    await baseline.dispose()

    const provider = new PlaywrightFetchProvider(localConfig({ challengeWaitMs: 12_000, challengeRetries: 1 }))
    const result = await provider.fetch({ url: `${baseUrl}guarded/spa` })
    expect(result.statusCode).toBe(200)
    expect(textOf(result)).toContain('Real protected content')
    await provider.dispose()
  })

  it('control: a challenge that clears quickly (1.5s) works under the feature with no regression', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping challenge A/B (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({ challengeWaitMs: 15_000, challengeRetries: 1 }))
    const result = await provider.fetch({ url: `${baseUrl}guarded/fast` })
    expect(result.statusCode).toBe(200)
    expect(textOf(result)).toContain('Real protected content')
    await provider.dispose()
  })

  it('isolated local fetches never carry the clearance cookie across fetches', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping challenge A/B (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({ challengeWaitMs: 12_000, challengeRetries: 1 }))
    const first = await provider.fetch({ url: `${baseUrl}guarded/article` })
    expect(first.statusCode).toBe(200)
    const served = challengeState.challengesServed
    const second = await provider.fetch({ url: `${baseUrl}guarded/article` })
    // The second fetch's fresh browser was challenged again — nothing leaked.
    expect(challengeState.challengesServed).toBe(served + 1)
    expect(textOf(second)).toContain('Real protected content')
    await provider.dispose()
  })
})
