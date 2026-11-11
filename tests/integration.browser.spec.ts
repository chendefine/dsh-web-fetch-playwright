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
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AsyncLocalStorage } from 'node:async_hooks'
import { resolveConfig } from '../src/config.ts'
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
 * The `#__NEXT_DATA__` runtime-rewrite badcase (techcommunity.microsoft.com
 * shape), end to end in a real browser: the server serves a wire-correct
 * page whose data script is properly closed, then the page's own script
 * writes its "Apollo cache" back into that script's text WITHOUT
 * re-escaping — planting a literal `</script>` (and a JSON tail full of
 * widget markup) inside script text that `page.content()` serializes
 * verbatim. Fetching this page must still return the article: the provider
 * strips scripting subtrees in the live DOM, where the script element still
 * holds its full textual content, so the corruption never reaches the
 * HTML string the pipeline re-parses. The page also carries the two things
 * the strip deliberately KEEPS — a schema.org JSON-LD metadata script
 * (Readability reads it for the title, so the strip must defuse, not
 * delete, it) and a noscript-wrapped lazy-load image (Readability salvages
 * the real image out of it) — locking the output-neutral carve-outs.
 * `<\/script>` keeps the inline script from terminating itself in the
 * SERVER's response.
 */
const REWRITE_PAGE = `<!doctype html><html><head><title>Rewrite page - Some Site Suffix</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","name":"Rewrite clean JSON-LD title","author":{"name":"Ada"}}</script>
</head><body>
<main><article><h1>Rewrite safe heading</h1>
<p>The body text that must survive a data script rewritten at runtime, with enough prose for the article extractor to lock onto the main content region.</p>
<p><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="placeholder"><noscript><img src="https://img.example.com/real-photo.jpg" alt="The real photo"></noscript></p>
<p>A second paragraph of real body text.</p>
</article></main>
<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"placeholder":true}}}</script>
<script>
  var soup = '';
  for (var i = 0; i < 40; i++) {
    soup += '<div class="lia-quilt-column-alley lia-content">CachedAsset:text:en_US-components/messages/MessageBanner-' + i
      + ' {"value":{"messageRejectedWithReason@board:BLOG":"This post was rejected: {reason}","messageMarkedAsSpam":"This post has been marked as spam"}}</div>';
  }
  document.getElementById('__NEXT_DATA__').textContent =
    '{"props":{"apolloState":{"CachedAsset:widget:MicrosoftFooter":{"css":".custom_widget_social-share > div {\\r\\n  position: absolute;\\r\\n  top: 50%;\\r\\n}\\r\\n"}}' + '<\\/script>' + soup + '"page":"/blogs/BlogMessagePage"}}';
</script>
</body></html>`

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

/** PDF fixtures (scripts/make-pdf-fixtures.mjs) served by the PDF routes. */
const STRUCTURED_PDF = readFileSync(fileURLToPath(new URL('./fixtures/pdf/structured.pdf', import.meta.url)))
const SCANNED_PDF = readFileSync(fileURLToPath(new URL('./fixtures/pdf/scanned.pdf', import.meta.url)))
const ZIP_BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00])

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
    if (url.startsWith('/virtualized/')) {
      // The deep-capture badcase page (built at the bottom of this file).
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      const query = new URL(url, 'http://fixture.invalid').searchParams
      res.end(virtualizedTopicPage({
        quantum: Number(query.get('quantum') ?? '0'),
        nextData: query.has('nextdata'),
      }))
      return
    }
    if (url.startsWith('/unkeyed/')) {
      // The unkeyed-row deep-capture case (built at the bottom of this file).
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(unkeyedTimelinePage({ wholesale: url.includes('wholesale') }))
      return
    }
    if (url.startsWith('/longstatic/')) {
      // A long, plain, NON-virtualized article: the walk's cost control.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(longStaticArticlePage())
      return
    }
    if (url.startsWith('/appshell/')) {
      // The app-shell deep-capture badcase page (built at the bottom of this file).
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(appShellDocPage({ anchored: (req.url ?? '').includes('anchored') }))
      return
    }
    if (url.startsWith('/rewrite/')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(REWRITE_PAGE)
      return
    }
    if (url.startsWith('/widget-embed/')) {
      // The linux.do shape: a NORMAL 200 article behind a Cloudflare edge
      // (server: cloudflare + cf-ray open the suspicion gate) whose page
      // embeds a REAL Turnstile widget — the Discourse Turnstile plugin
      // mounts one into every topic page. The widget's iframe src strings a
      // challenge-platform path, exactly like the real thing. With the
      // challenge wait ON this must still fetch the article immediately:
      // the widget alone is not interstitial proof.
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'server': 'cloudflare',
        'cf-ray': 'a57a2100b917f23a',
      })
      res.end(`<!doctype html><html><head><title>Widget protected article - LINUX DO</title>
<script src="https://challenges.cloudflare.com/turnstile/v0/api/origin/refresh.js"></script>
</head><body>
<div id="main-outlet" class="wrap"><main><article><h1>Real widget-protected content</h1>
<p>This page embeds a genuine Turnstile widget and is served at 200 behind a Cloudflare edge, exactly like a linux.do topic; the fetch must read it without ever entering the challenge wait.</p>
<p>A second paragraph of real body text.</p></article></main></div>
<div class="login-modal"><form><div class="cf-turnstile" data-sitekey="0x4AAAAAAA"><div id="cf-chl-widget-0001" class="cf-turnstile-wrap"><iframe src="https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/turnstile/if/ov2/av0/rcv/i1x0z/0x4AAAAAAA/dark/normal" title="Widget containing a Cloudflare security challenge"></div></div></form></div>
<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js" defer></script>
</body></html>`)
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
    if (url.startsWith('/storage')) {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><body><p id="result"></p><script>
        document.querySelector('#result').textContent = localStorage.getItem('probe') ? 'STORAGE-SEEN' : 'STORAGE-EMPTY';
        localStorage.setItem('probe', '1');
      </script></body></html>`)
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
    if (url === '/status/404') {
      // httpbin /status/N parity: an error status whose body is EMPTY. Some
      // Chromium builds refuse to render such responses and fail the whole
      // navigation (ERR_HTTP_RESPONSE_CODE_FAILURE); the seam contract still
      // wants the status as a result.
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' })
      res.end()
      return
    }
    if (url === '/status/500') {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end()
      return
    }
    if (url === '/no-content') {
      // Status-only success: Chromium never renders a 204 document and
      // aborts the navigation (ERR_ABORTED) even though the response is
      // final — the recovery path must surface it as a result.
      res.writeHead(204, { 'content-type': 'text/html; charset=utf-8' })
      res.end()
      return
    }
    if (url === '/download/json') {
      // publish.twitter.com/oembed parity: decodable JSON served with an
      // attachment disposition — Chromium hands it to its download manager
      // instead of committing a document, so goto rejects with
      // "Download is starting". The recovery must refetch the bytes.
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename=json.json' })
      res.end('{"url":"https://x.com/tianyi/status/2105790798461882377","author_name":"Tianyi Cui"}')
      return
    }
    if (url === '/slow/never-ends') {
      // A document that streams its article and then never finishes: the
      // response arrived, DOMContentLoaded never fires.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.write(`<!doctype html><html><head><title>Slow page</title></head><body>
<nav>nav link</nav>
<main><article><h1>Slow heading</h1><p>The part that already streamed in.</p>
<p>A second paragraph gives the article scorer enough text mass to find the main region.</p></article></main>
`)
      return // the connection stays open; afterAll tears it down
    }
    if (url === '/pdf/inline.pdf') {
      // The common case: a PDF link served inline. Headless Chromium has no
      // viewer and downloads it; a headed / CDP-attached Chrome may commit
      // it into the viewer — both must end up extracted.
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': String(STRUCTURED_PDF.length) })
      res.end(STRUCTURED_PDF)
      return
    }
    if (url === '/pdf/attachment') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="handbook.pdf"' })
      res.end(STRUCTURED_PDF)
      return
    }
    if (url.startsWith('/pdf/blob')) {
      // A PDF behind an opaque type and a path without an extension: only
      // the %PDF- magic identifies it.
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(STRUCTURED_PDF)
      return
    }
    if (url === '/pdf/zip') {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename=archive.zip' })
      res.end(ZIP_BYTES)
      return
    }
    if (url === '/pdf/scan.pdf') {
      res.writeHead(200, { 'content-type': 'application/pdf' })
      res.end(SCANNED_PDF)
      return
    }
    if (url === '/pdf/login') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': 'dsh-pdf-session=ok; Path=/' })
      res.end(COOKIE_PAGE_BLANK)
      return
    }
    if (url === '/pdf/private.pdf') {
      // Only a request carrying the session cookie gets the PDF: the bytes
      // refetch must ride the browser context's cookie jar.
      if ((req.headers.cookie ?? '').includes('dsh-pdf-session=ok')) {
        res.writeHead(200, { 'content-type': 'application/pdf' })
        res.end(STRUCTURED_PDF)
      } else {
        res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<html><body><h1>Forbidden</h1></body></html>')
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
  server.closeAllConnections()
  await new Promise<void>(resolve => { server.close(() => { resolve() }) })
})

/** The real provider with a short waiting budget, so the soft deadline fires fast. */
class ShortBudgetProvider extends PlaywrightFetchProvider {
  protected override readonly fetchTimeoutMs = 4_000
}

describe('PlaywrightFetchProvider integration', () => {
  it('returns what a never-finishing page already streamed when the waiting budget runs out', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping browser smoke (no launchable browser)')
      return
    }
    const provider = new ShortBudgetProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    const started = Date.now()
    const result = await provider.fetch({ url: `${baseUrl}slow/never-ends` })
    expect(Date.now() - started).toBeLessThan(4_000 + 10_000)
    expect(result.statusCode).toBe(200)
    expect(result.truncated).toBe(true)
    const content = result.body.kind === 'text' ? result.body.content : ''
    expect(content).toContain('Slow heading')
    expect(content).toContain('The part that already streamed in.')
  })

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
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeHttpFallback: true,
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
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: false,
      maxConcurrency: 4,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    const result = await provider.fetch({ url: baseUrl })
    expect(result.body.kind).toBe('html')
    if (result.body.kind === 'html') expect(result.body.content).toContain('<article>')
  })

  it('keeps a runtime-rewritten data script from corrupting the fetched article', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping browser smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    const result = await provider.fetch({ url: `${baseUrl}rewrite/` })
    expect(result.statusCode).toBe(200)
    expect(result.body.kind).toBe('text')
    const content = result.body.kind === 'text' ? result.body.content : ''
    // The article wins over the rewritten cache payload...
    expect(content).toMatch(/^# Rewrite /m)
    expect(content).toContain('The body text that must survive')
    // ...whose CSS/JSON soup — had it serialized inside script text — would
    // have re-parsed as phantom markup and swamped the extraction.
    expect(content).not.toContain('CachedAsset')
    expect(content).not.toContain('messageRejectedWithReason')
    // The strip's carve-outs stay output-neutral: the JSON-LD metadata
    // script is defused (not deleted), so the title keeps coming from it
    // (not the site-suffix <title>), and the noscript lazy-load image is
    // salvaged by Readability as usual.
    expect(content).toContain('# Rewrite clean JSON-LD title')
    expect(content).not.toContain('- Some Site Suffix')
    expect(content).toContain('real-photo.jpg')
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
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    // Port 1 on loopback: connection refused by the OS, no browser page loads.
    const error = await provider.fetch({ url: 'http://127.0.0.1:1/' })
      .then(() => { throw new Error('expected rejection') }, (e: unknown) => e)
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
  })

  /**
   * The seam contract ("a successful network fetch of a non-2xx response is
   * a result, not an error") meets Chromium's refusal to render status-only
   * responses. Whether the local build commits the empty document or fails
   * the navigation, the provider must answer with the STATUS — the same
   * thing `dsh-web-fetch-http` returns for these URLs.
   */
  it('returns an empty-bodied 404 as a result (httpbin /status parity)', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping browser smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    const result = await provider.fetch({ url: `${baseUrl}status/404` })
    expect(result.statusCode).toBe(404)
    expect(result.body.kind).toBe('text')
    expect(result.body.kind === 'text' ? result.body.content : '').toBe('')
  })

  it('returns an empty-bodied 500 json status as a result', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping browser smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    const result = await provider.fetch({ url: `${baseUrl}status/500` })
    expect(result.statusCode).toBe(500)
  })

  /**
   * 204 is the one status-only response EVERY Chromium build refuses to
   * render (ERR_ABORTED), so this case exercises the recovery path through
   * a real browser and a real navigation failure.
   */
  it('recovers a status-only 204 from Chromium\'s ERR_ABORTED as a result', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping browser smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    const result = await provider.fetch({ url: `${baseUrl}no-content` })
    expect(result.statusCode).toBe(204)
    expect(result.body.kind === 'text' ? result.body.content : '').toBe('')
  })

  /**
   * The oembed badcase shape (https://publish.twitter.com/oembed?url=<tweet>):
   * decodable JSON behind `Content-Disposition: attachment`. A real Chromium
   * fails goto with "Download is starting" and the navigation body is gone
   * from the network stack — the recovery refetches through the page's API
   * request context and returns the JSON as a text result.
   */
  it('recovers an attachment JSON (oembed parity) from "Download is starting" as a result', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping browser smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    const result = await provider.fetch({ url: `${baseUrl}download/json` })
    expect(result.statusCode).toBe(200)
    expect(result.body.kind).toBe('text')
    const content = result.body.kind === 'text' ? result.body.content : ''
    expect(content).toContain('Tianyi Cui')
    expect(result.truncated).toBe(false)
  })

  describe('PDF links (real headless Chromium)', () => {
    const localProvider = (): PlaywrightFetchProvider => new PlaywrightFetchProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    const expectHandbook = (result: Awaited<ReturnType<PlaywrightFetchProvider['fetch']>>): void => {
      expect(result.statusCode).toBe(200)
      expect(result.body.kind).toBe('text')
      const content = result.body.kind === 'text' ? result.body.content : ''
      expect(content).toMatch(/^# PDF Fixture Handbook$/m)
      expect(content).toContain('## 1 Introduction')
      expect(content).toContain('| alpha | 12 | 0.8 |')
      expect(content).toContain('这是第一段中文内容')
    }

    it('extracts an inline application/pdf link', { timeout: 120_000 }, async () => {
      if (!browserAvailable) return
      expectHandbook(await localProvider().fetch({ url: `${baseUrl}pdf/inline.pdf` }))
    })

    it('extracts an attachment PDF', { timeout: 120_000 }, async () => {
      if (!browserAvailable) return
      expectHandbook(await localProvider().fetch({ url: `${baseUrl}pdf/attachment` }))
    })

    it('sniffs an application/octet-stream PDF without a .pdf path', { timeout: 120_000 }, async () => {
      if (!browserAvailable) return
      expectHandbook(await localProvider().fetch({ url: `${baseUrl}pdf/blob?id=42` }))
    })

    it('still refuses a non-PDF binary download', { timeout: 120_000 }, async () => {
      if (!browserAvailable) return
      const error = await localProvider().fetch({ url: `${baseUrl}pdf/zip` }).catch(caught => caught)
      expect(error).toBeInstanceOf(WebError)
      expect((error as WebError).code).toBe('WEB_UNSUPPORTED_CONTENT_TYPE')
    })

    it('reports a scanned PDF as WEB_PDF_NO_TEXT', { timeout: 120_000 }, async () => {
      if (!browserAvailable) return
      const error = await localProvider().fetch({ url: `${baseUrl}pdf/scan.pdf` }).catch(caught => caught)
      expect((error as WebError).code).toBe('WEB_PDF_NO_TEXT')
    })
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
      contextIsolationScope: 'global' as const,
      shareBrowserContext: false, // isolated: preserves this suite's original stance
      denoise: true,
      challengeHttpFallback: true,
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

  it('extracts PDF links over CDP, refetching with the remote browser\'s cookies', { timeout: 120_000 }, async () => {
    if (!browserAvailable || debugBrowser === undefined) {
      console.warn('skipping CDP smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: endpoint,
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true, // profile mode: the remote browser's own jar
      denoise: true,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    try {
      const inline = await provider.fetch({ url: `${baseUrl}pdf/inline.pdf` })
      expect(inline.body.kind === 'text' ? inline.body.content : '').toMatch(/^# PDF Fixture Handbook$/m)
      // The private PDF is only served to the session the login page set up
      // IN the remote browser: the bytes refetch must carry that cookie.
      await provider.fetch({ url: `${baseUrl}pdf/login` })
      const gated = await provider.fetch({ url: `${baseUrl}pdf/private.pdf` })
      expect(gated.statusCode).toBe(200)
      expect(gated.body.kind === 'text' ? gated.body.content : '').toContain('## 2 Lists')
    } finally {
      await provider.dispose()
    }
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
      contextIsolationScope: 'global' as const,
      shareBrowserContext: false, // isolated: preserves this suite's original stance
      denoise: true,
      challengeHttpFallback: true,
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
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      challengeHttpFallback: true,
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

  // Sequential fetches leave each session context idle, so it closes between
  // them (README: "Cookies/localStorage reset after idle cleanup"). Retention
  // while in use needs concurrent same-session tabs in one window, which
  // headless_shell cannot host; tests/cdp-recovery.browser.spec.ts covers it.
  it('session isolation never leaks cookies or localStorage and resets them once idle', { timeout: 120_000 }, async () => {
    if (!browserAvailable || debugBrowser === undefined) return
    const identity = new AsyncLocalStorage<string>()
    const provider = new PlaywrightFetchProvider(() => resolveConfig({
      backend: 'cdp', cdpEndpoint: endpoint, shareBrowserContext: false,
      contextIsolationScope: 'session', denoise: false, challengeWaitMs: 0,
    }), undefined, () => identity.getStore())
    const fetchAs = (id: string, path: string) => identity.run(id, () => provider.fetch({ url: `${baseUrl}${path}` }))
    try {
      for (const id of ['A', 'B', 'A']) {
        expect((await fetchAs(id, 'cookie')).body.content).not.toContain('COOKIE-SEEN')
        // Match rendered DOM, not the JavaScript string literals in the HTML.
        expect((await fetchAs(id, 'storage')).body.content).toContain('id="result">STORAGE-EMPTY')
      }
    } finally { await provider.dispose() }
    expect(debugBrowser.isConnected()).toBe(true)
  })

  it('global isolated mode: retains its jar without inheriting default profile cookies', { timeout: 120_000 }, async () => {
    if (!browserAvailable || debugBrowser === undefined) {
      console.warn('skipping CDP smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: endpoint,
      contextIsolationScope: 'global' as const,
      shareBrowserContext: false,
      denoise: true,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    const first = await provider.fetch({ url: `${baseUrl}cookie` })
    expect(first.body.content).not.toContain('COOKIE-SEEN')
    const second = await provider.fetch({ url: `${baseUrl}cookie` })
    const secondText = second.body.kind === 'text' ? second.body.content : ''
    expect(secondText).toContain('COOKIE-SEEN')
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
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      challengeHttpFallback: true,
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

  it('global isolated mode: challenge clearance survives across fetches', { timeout: 120_000 }, async () => {
    if (!browserAvailable || debugBrowser === undefined) {
      console.warn('skipping CDP smoke (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: endpoint,
      contextIsolationScope: 'global' as const,
      shareBrowserContext: false,
      denoise: true,
      challengeHttpFallback: true,
      challengeWaitMs: 12_000,
      challengeRetries: 1,
    }))
    const first = await provider.fetch({ url: `${baseUrl}guarded/article` })
    expect(first.statusCode).toBe(200)
    const served = challengeState.challengesServed
    const second = await provider.fetch({ url: `${baseUrl}guarded/article` })
    const secondText = second.body.kind === 'text' ? second.body.content : ''
    // The plugin-owned context retained its clearance across tab closes.
    expect(challengeState.challengesServed).toBe(served)
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
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeHttpFallback: true,
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
    // Bounded: gave up after the wait window, nowhere near the 25s fetch budget.
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

  it('a widget-embedding normal page behind a Cloudflare edge fetches clean (linux.do badcase)', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping challenge A/B (no launchable browser)')
      return
    }
    // The full feature stack on: bounded wait + retries. Before the fix the
    // widget marker read this page as a challenge, the DOM probe could never
    // confirm a clear, and two 15s attempts died as WEB_FETCH_CHALLENGE
    // (last status 200) — surfacing as the tool layer's 30s timeout. Now the
    // article comes back on the first navigation, no wait round-trip at all.
    const provider = new PlaywrightFetchProvider(localConfig({ challengeWaitMs: 15_000, challengeRetries: 1 }))
    const started = Date.now()
    const result = await provider.fetch({ url: `${baseUrl}widget-embed/` })
    const text = textOf(result)
    expect(result.statusCode).toBe(200)
    expect(text).toContain('Real widget-protected content')
    expect(text).not.toMatch(/just a moment/i)
    // No challenge wait ran: far under even ONE wait window.
    expect(Date.now() - started).toBeLessThan(15_000)
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

/**
 * The viewport-virtualization badcase (linux.do / Discourse topic streams),
 * rebuilt as a deterministic fixture: only the posts near the scroll
 * position exist in the DOM — everything outside the render window is an
 * empty height-only placeholder that keeps the post's id (exactly
 * Discourse's `.post-stream--cloaked`), and posts beyond the first chunk
 * are only appended when a bottom sentinel nears the viewport (Discourse's
 * load-more). A resting single-instant capture returns the skeleton: the
 * screen-reader-only "Reply N by userN" headings survive the pipeline as if
 * they were content while every reply body vanishes. The deep-capture walk
 * must return the whole topic instead.
 */
function virtualizedTopicPage(opts: { quantum: number; nextData: boolean }): string {
  return `<!doctype html><html lang="en"><head><title>Virtualized topic - Test Forum</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  header, footer { height: 60px; background: #eee; }
  main { max-width: 720px; margin: 0 auto; }
  .post { min-height: 150px; padding: 8px 0; border-bottom: 1px solid #ddd; }
  .post-stream--cloaked { min-height: 150px; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style></head>
<body>
<header id="site-header"><span>Test Forum — header noise</span></header>
<main id="main-outlet">
  <h1 id="topic-title">Virtualized topic</h1>
  <div id="post-stream"></div>
</main>
<footer id="site-footer">footer noise</footer>
${opts.nextData ? '<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>' : ''}
<script>
  var TOTAL = 40, CHUNK = 20, loaded = 20, QUANTUM = ${String(opts.quantum)}, anchorY = 0;
  if (${String(opts.nextData)}) {
    // The runtime data-script rewrite (techcommunity shape): a literal
    // closing script tag plus a markup tail planted inside script text.
    document.getElementById('__NEXT_DATA__').textContent =
      '{"apollo":"' + '<\\/script>' + '<div class="lia-content">NEXTDATA-SOUP-NOISE</div>' + '"}';
  }
  var stream = document.getElementById('post-stream');
  function postHtml(n) {
    return '<article class="post" id="post_' + n + '" data-post-number="' + n + '">'
      + '<h2>Reply ' + n + ' by user' + n + '</h2>'
      + '<div class="cooked"><p>Reply body ' + n + ' says: the quick brown fox jumps over the lazy dog, '
      + 'and enough prose follows so the article extractor scores the stream as the main region. '
      + 'MARKER-POST-' + n + ' ends this reply.</p></div></article>';
  }
  function placeholderHtml(n) {
    return '<div class="post-stream--cloaked" id="post_' + n + '" data-post-number="' + n + '">'
      + '<h2 class="sr-only">Reply ' + n + ' by user' + n + '</h2></div>';
  }
  var sentinel = document.createElement('div');
  sentinel.id = 'load-more-sentinel';
  sentinel.style.height = '1px';
  function appendPost(n) {
    var wrap = document.createElement('div');
    wrap.innerHTML = postHtml(n);
    stream.insertBefore(wrap.firstElementChild, sentinel);
  }
  stream.appendChild(sentinel);
  for (var n = 1; n <= CHUNK; n++) appendPost(n);

  // Discourse's cloak/uncloak: render only within a window around the scroll.
  // QUANTUM > 0: a coarse virtualizer with a huge overscan that only
  // re-renders once the scroll has moved QUANTUM viewports from where it
  // last rendered — a short walk sees NO reaction at all.
  function refresh() {
    if (QUANTUM === 0 || Math.abs(window.scrollY - anchorY) >= window.innerHeight * QUANTUM) anchorY = window.scrollY;
    var lo = anchorY - window.innerHeight * 1.2;
    var hi = anchorY + window.innerHeight * (2.2 + QUANTUM);
    var children = stream.children;
    for (var i = 0; i < children.length; i++) {
      var el = children[i];
      var num = parseInt(el.getAttribute('data-post-number') || '0', 10);
      if (num < 1) continue;
      var top = el.getBoundingClientRect().top + window.scrollY;
      var wantRendered = top >= lo && top <= hi;
      var isRendered = el.tagName === 'ARTICLE';
      if (wantRendered !== isRendered) el.outerHTML = wantRendered ? postHtml(num) : placeholderHtml(num);
    }
  }

  // Discourse's load-more: a sentinel nearing the viewport appends the next
  // chunk after a network-like delay.
  var loading = false;
  function maybeLoadMore() {
    if (loading || loaded >= TOTAL) return;
    var rect = sentinel.getBoundingClientRect();
    if (rect.top < window.innerHeight + 200) {
      loading = true;
      setTimeout(function () {
        for (var k = 0; k < 5 && loaded < TOTAL; k++) { loaded++; appendPost(loaded); }
        loading = false;
        refresh();
      }, 250);
    }
  }

  window.addEventListener('scroll', function () { requestAnimationFrame(refresh); maybeLoadMore(); });
  maybeLoadMore();
  refresh();
</script>
</body></html>`
}

/**
 * The app-shell deep-capture badcase (a Feishu wiki document —
 * bocha-ai.feishu.cn — is the measured shape), rebuilt deterministically:
 * html/body are locked at exactly one viewport so the DOCUMENT never
 * scrolls — all content lives inside ONE overflow-y container — blocks are
 * keyed ONLY by data-block-id (no id attributes at all, exactly like the
 * real bear editor), off-window blocks are REMOVED from the DOM (the
 * un-rendered regions held open by anonymous explicit-height spacers,
 * Feishu's .bear-virtual-renderUnit-placeholder), and further chunks load
 * lazily as the bottom nears. A resting single-instant capture therefore
 * returns only the statically rendered first screen: the walk must detect
 * the inner scroll container, drive IT, and splice the removed blocks back.
 */
function appShellDocPage(opts: { anchored: boolean } = { anchored: false }): string {
  return `<!doctype html><html lang="en"><head><title>App-shell document - Bocha Wiki</title>
<style>
  html, body { height: 100%; margin: 0; overflow: hidden; }
  #shell { display: flex; height: 100%; font-family: sans-serif; }
  #side { width: 200px; overflow-y: auto; background: #f2f2f2; }
  #bear-web-x-container { flex: 1; overflow-y: auto; }
  .block { height: 130px; box-sizing: border-box; padding: 8px; border-bottom: 1px solid #ddd; }
  .bear-virtual-renderUnit-placeholder { border: 0; }
</style></head>
<body>
<div id="shell">
  <aside id="side"><div style="height:1400px">side panel noise</div></aside>
  <main id="bear-web-x-container"><div id="render-unit-wrapper"></div></main>
</div>
<script>
  var TOTAL = 40, loaded = 15, H = 130;
  var scroller = document.getElementById('bear-web-x-container');
  var wrap = document.getElementById('render-unit-wrapper');
  var spacerTop = document.createElement('div');
  spacerTop.className = 'bear-virtual-renderUnit-placeholder';
  var spacerBottom = document.createElement('div');
  spacerBottom.className = 'bear-virtual-renderUnit-placeholder';
  wrap.appendChild(spacerTop);
  wrap.appendChild(spacerBottom);
  var rendered = {};
  function blockEl(n) {
    var el = document.createElement('div');
    el.className = 'block docx-text-block';
    el.setAttribute('data-block-id', String(n));
    el.innerHTML = '<h2>Doc block ' + n + ' by author' + n + '</h2>'
      + '<p>Body prose for block ' + n + ': the quick brown fox jumps over the lazy dog, '
      + 'and enough text follows so the article extractor scores the document stream as the main region. '
      + 'MARKER-BLOCK-' + n + ' ends this block.</p>';
    return el;
  }
  // The bear engine's windowed rendering: blocks whose fixed-height offsets
  // fall outside [scrollTop - 1.2 viewports, scrollTop + 2.2 viewports] are
  // REMOVED; two anonymous spacers hold the un-rendered regions' heights.
  function refresh() {
    var top = scroller.scrollTop, vh = scroller.clientHeight;
    var lo = top - vh * 1.2, hi = top + vh * 2.2;
    var want = {};
    for (var n = 1; n <= loaded; n++) {
      var y = (n - 1) * H;
      if (y + H >= lo && y <= hi) want[n] = true;
    }
    for (var k in rendered) {
      if (!want[k]) { rendered[k].remove(); delete rendered[k]; }
    }
    var anchor = spacerBottom;
    for (var n2 = loaded; n2 >= 1; n2--) {
      if (!want[n2]) continue;
      if (!rendered[n2]) {
        var el = blockEl(n2);
        rendered[n2] = el;
        wrap.insertBefore(el, anchor);
      }
      anchor = rendered[n2];
    }
    var above = 0, below = 0, seen = false;
    for (var m = 1; m <= loaded; m++) {
      if (want[m]) { seen = true; continue; }
      if (seen) below += H; else above += H;
    }
    spacerTop.style.height = above + 'px';
    spacerBottom.style.height = below + 'px';
    if (loaded < TOTAL && top + vh >= loaded * H - 300) maybeLoadMore();
  }
  // Lazy chunk loading, like the real editor fetching more of the document.
  var loading = false;
  function maybeLoadMore() {
    if (loading) return;
    loading = true;
    setTimeout(function () {
      for (var j = 0; j < 10 && loaded < TOTAL; j++) loaded++;
      loading = false;
      refresh();
    }, 250);
  }
  scroller.addEventListener('scroll', function () { refresh(); });
  refresh();
  // anchored: the link pointed mid-document (a #heading deep link), so the
  // editor opens scrolled — the first window holds neither the first block
  // nor the last.
  if (${String(opts.anchored)}) { scroller.scrollTop = 1000; refresh(); }
</script>
</body></html>`
}

/**
 * The unkeyed virtualizer shape (react-window rows, X-style timeline cells):
 * rows carry NO id and no per-row attribute — every cell shares the same
 * `data-testid`, because the framework key never reaches the DOM — and are
 * absolutely positioned by `transform`, so their DOM order says nothing
 * about layout. Rows outside the render window are REMOVED and re-created
 * as new nodes on re-entry. `wholesale`: the engine re-renders the whole
 * window via innerHTML on every scroll (no row survives to anchor others).
 */
function unkeyedTimelinePage(opts: { wholesale: boolean }): string {
  return `<!doctype html><html lang="en"><head><title>Unkeyed timeline - Test Social</title>
<style>
  body { margin: 0; font-family: sans-serif; }
  header { height: 60px; background: #eee; }
  main { max-width: 640px; margin: 0 auto; }
  #timeline { position: relative; }
  .cell { position: absolute; left: 0; right: 0; height: 140px; box-sizing: border-box; padding: 8px; border-bottom: 1px solid #ddd; }
</style></head>
<body>
<header><span>Test Social — header noise</span></header>
<main>
  <h1>Unkeyed timeline</h1>
  <div id="timeline" aria-label="Timeline"><div class="list"></div></div>
</main>
<script>
  var TOTAL = 60, H = 140, WHOLESALE = ${String(opts.wholesale)};
  var timeline = document.getElementById('timeline');
  var list = timeline.firstElementChild;
  timeline.style.height = (TOTAL * H) + 'px';
  function cellHtml(n) {
    return '<div class="cell" data-testid="cellInnerDiv" style="transform: translateY(' + ((n - 1) * H) + 'px)">'
      + '<article><h2>Post ' + n + ' by handle' + n + '</h2>'
      + '<p>Post body ' + n + ': the quick brown fox jumps over the lazy dog, and enough prose '
      + 'follows so the extractor scores the timeline as the main region. MARKER-ROW-' + n + ' ends it.</p>'
      + '</article></div>';
  }
  var live = {};
  function refresh() {
    var origin = timeline.getBoundingClientRect().top + window.scrollY;
    var lo = window.scrollY - origin - window.innerHeight, hi = window.scrollY - origin + window.innerHeight * 2;
    var want = [];
    for (var n = 1; n <= TOTAL; n++) {
      var y = (n - 1) * H;
      if (y + H >= lo && y <= hi) want.push(n);
    }
    if (WHOLESALE) { list.innerHTML = want.map(cellHtml).join(''); return; }
    var keep = {};
    want.forEach(function (n) { keep[n] = true; });
    for (var k in live) if (!keep[k]) { live[k].remove(); delete live[k]; }
    var anchor = null;
    for (var i = want.length - 1; i >= 0; i--) {
      var m = want[i];
      if (!live[m]) {
        var t = document.createElement('template');
        t.innerHTML = cellHtml(m);
        live[m] = t.content.firstElementChild;
        list.insertBefore(live[m], anchor);
      }
      anchor = live[m];
    }
  }
  var queued = false;
  window.addEventListener('scroll', function () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; refresh(); });
  });
  refresh();
</script>
</body></html>`
}

/**
 * A long, plain article with NO virtualization (~30 viewports of static
 * prose, id-anchored headings): the shape of most of the web. Nothing here
 * reacts to scrolling, so the deep-capture walk can only cost latency —
 * the cost control for the walk's scroll-inert fast path.
 */
function longStaticArticlePage(): string {
  const sections: string[] = []
  for (let n = 1; n <= 60; n++) {
    sections.push(`<h2 id="sec-${String(n)}">Section ${String(n)}</h2>`
      + `<p>${'Static prose that never reacts to scrolling. '.repeat(18)}STATIC-MARKER-${String(n)}.</p>`)
  }
  return `<!doctype html><html lang="en"><head><title>Long static article</title>
<style>body { margin: 0 auto; max-width: 720px; font-family: sans-serif; } h2 { margin-top: 140px; }</style></head>
<body><main><article><h1 id="title">Long static article</h1>${sections.join('\n')}</article></main></body></html>`
}

describe('PlaywrightFetchProvider deep capture (viewport-virtualized topic)', () => {
  function localConfig(over: { scrollBudgetMs?: number; denoise?: boolean }) {
    return () => ({
      backend: 'local' as const,
      playwrightPath: '',
      cdpEndpoint: '',
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
      ...over,
    })
  }

  it('baseline (scrollBudgetMs 0): the resting capture is the skeleton — headings without bodies', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping deep-capture baseline (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({ scrollBudgetMs: 0 }))
    const result = await provider.fetch({ url: `${baseUrl}virtualized/` })
    const text = result.body.kind === 'text' ? result.body.content : ''
    // The resting window renders the early posts...
    expect(text).toContain('MARKER-POST-2')
    // ...but a post past the window comes back as the skeleton: the
    // placeholder's screen-reader heading survives the pipeline, its body
    // does not — exactly the linux.do symptom.
    expect(text).toContain('Reply 15 by user15')
    expect(text).not.toContain('MARKER-POST-15')
    // And nothing past the first chunk is even loaded without scrolling.
    expect(text).not.toContain('MARKER-POST-21')
    await provider.dispose()
  })

  it('feature on: the walk captures every reply across windows and load-more chunks', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping deep-capture feature case (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({}))
    const result = await provider.fetch({ url: `${baseUrl}virtualized/` })
    const text = result.body.kind === 'text' ? result.body.content : ''
    for (const marker of ['MARKER-POST-1', 'MARKER-POST-11', 'MARKER-POST-20', 'MARKER-POST-21', 'MARKER-POST-30', 'MARKER-POST-40']) {
      expect(text).toContain(marker)
    }
    await provider.dispose()
  })

  it('feature on with denoise off: the raw HTML path keeps the rehydrated stream too', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping deep-capture raw-html case (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: false,
      maxConcurrency: 4,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
      scrollBudgetMs: 10_000,
    }))
    const result = await provider.fetch({ url: `${baseUrl}virtualized/` })
    const html = result.body.kind === 'html' ? result.body.content : ''
    expect(html).toContain('MARKER-POST-40')
    // And no cloaked placeholder ELEMENT remains in the serialized document
    // (the .post-stream--cloaked SELECTOR text in the page's <style> is fine):
    // the stream is whole, not a mix of articles and cloaks.
    expect(html).not.toMatch(/<div class="post-stream--cloaked/)
    await provider.dispose()
  })

  it('cost control: a long static article pays the scroll-inert fast path, not a full slow walk', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping deep-capture cost control (no launchable browser)')
      return
    }
    const legacy = new PlaywrightFetchProvider(localConfig({ scrollBudgetMs: 0 }))
    const legacyStart = Date.now()
    await legacy.fetch({ url: `${baseUrl}longstatic/` })
    const legacyMs = Date.now() - legacyStart
    await legacy.dispose()
    const provider = new PlaywrightFetchProvider(localConfig({}))
    const start = Date.now()
    const result = await provider.fetch({ url: `${baseUrl}longstatic/` })
    const walkMs = Date.now() - start
    const text = result.body.kind === 'text' ? result.body.content : ''
    expect(text).toContain('STATIC-MARKER-1.')
    expect(text).toContain('STATIC-MARKER-60.')
    // ~30 viewports at the careful cadence would be ~25 steps x 600ms; the
    // walk must notice the page never reacts and stop stepping.
    expect(walkMs - legacyMs).toBeLessThan(6_000)
    await provider.dispose()
  })

  it('a coarse virtualizer that ignores the first steps is still walked whole (fast path rewinds)', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping deep-capture rewind case (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({}))
    const result = await provider.fetch({ url: `${baseUrl}virtualized/?quantum=3` })
    const text = result.body.kind === 'text' ? result.body.content : ''
    for (let n = 1; n <= 40; n++) expect(text).toContain(`MARKER-POST-${String(n)} `)
    await provider.dispose()
  })

  it('a runtime-rewritten data script cannot corrupt the merged document', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping deep-capture rewrite case (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({ denoise: false }))
    const result = await provider.fetch({ url: `${baseUrl}virtualized/?nextdata=1` })
    const html = result.body.kind === 'html' ? result.body.content : ''
    expect(html).toContain('MARKER-POST-1 ')
    expect(html).toContain('MARKER-POST-40 ')
    // The data script's planted markup must never surface as document markup.
    expect(html).not.toContain('NEXTDATA-SOUP-NOISE')
    await provider.dispose()
  })

  it('control: a plain article still fetches whole (the walk cannot lose content)', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping deep-capture control (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({}))
    const result = await provider.fetch({ url: baseUrl })
    const text = result.body.kind === 'text' ? result.body.content : ''
    expect(text).toContain('The rendered body text.')
    expect(text).not.toContain('nav link')
    expect(text).not.toContain('footer noise')
    await provider.dispose()
  })
})

describe('PlaywrightFetchProvider deep capture (app-shell inner scroll container)', () => {
  function localConfig(over: { scrollBudgetMs?: number; denoise?: boolean }) {
    return () => ({
      backend: 'local' as const,
      playwrightPath: '',
      cdpEndpoint: '',
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
      ...over,
    })
  }

  it('baseline (scrollBudgetMs 0): the resting capture is the statically rendered first screen', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping app-shell baseline (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({ scrollBudgetMs: 0 }))
    const result = await provider.fetch({ url: `${baseUrl}appshell/` })
    const text = result.body.kind === 'text' ? result.body.content : ''
    // The document never scrolls and the render window holds only the first
    // ~13 blocks; everything past it was REMOVED from the DOM, not cloaked.
    expect(text).toContain('MARKER-BLOCK-3')
    expect(text).not.toContain('MARKER-BLOCK-15')
    // Nothing past the first lazy chunk is even loaded without scrolling.
    expect(text).not.toContain('MARKER-BLOCK-30')
    await provider.dispose()
  })

  it('feature on: the walk drives the inner container and splices every removed block back', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping app-shell feature case (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({}))
    const result = await provider.fetch({ url: `${baseUrl}appshell/` })
    const text = result.body.kind === 'text' ? result.body.content : ''
    // First screen, a block the engine removed mid-walk, a lazily loaded
    // chunk, and the final block of the document — the splice restored the
    // union of every window in document order.
    for (const marker of ['MARKER-BLOCK-1', 'MARKER-BLOCK-16', 'MARKER-BLOCK-26', 'MARKER-BLOCK-40']) {
      expect(text).toContain(marker)
    }
    // No block was duplicated by the splice (blocks appear exactly once).
    expect(text.split('MARKER-BLOCK-16').length - 1).toBe(1)
    await provider.dispose()
  })

  it('an anchored open (mid-document start) splices removed blocks back in DOCUMENT order', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping app-shell anchored case (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({}))
    const result = await provider.fetch({ url: `${baseUrl}appshell/?anchored` })
    const text = result.body.kind === 'text' ? result.body.content : ''
    let last = -1
    for (let n = 1; n <= 40; n++) {
      const marker = `MARKER-BLOCK-${String(n)} `
      expect(text.split(marker).length - 1, marker).toBe(1)
      const at = text.indexOf(marker)
      expect(at, `${marker} out of document order`).toBeGreaterThan(last)
      last = at
    }
    await provider.dispose()
  })

  it('feature on with denoise off: the raw HTML path carries the spliced blocks too', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping app-shell raw-html case (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: false,
      maxConcurrency: 4,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
      scrollBudgetMs: 10_000,
    }))
    const result = await provider.fetch({ url: `${baseUrl}appshell/` })
    const html = result.body.kind === 'html' ? result.body.content : ''
    expect(html).toContain('MARKER-BLOCK-40')
    expect(html).toContain('data-block-id="38"')
    await provider.dispose()
  })
})

describe('PlaywrightFetchProvider deep capture (unkeyed virtualized rows)', () => {
  function localConfig(over: { scrollBudgetMs?: number; denoise?: boolean }) {
    return () => ({
      backend: 'local' as const,
      playwrightPath: '',
      cdpEndpoint: '',
      contextIsolationScope: 'global' as const,
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeHttpFallback: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
      ...over,
    })
  }

  /** Every MARKER-ROW-n exactly once, in document order. */
  function expectWholeTimeline(text: string): void {
    let last = -1
    for (let n = 1; n <= 60; n++) {
      const marker = `MARKER-ROW-${String(n)} `
      expect(text.split(marker).length - 1, marker).toBe(1)
      const at = text.indexOf(marker)
      expect(at, `${marker} out of document order`).toBeGreaterThan(last)
      last = at
    }
  }

  it('baseline (scrollBudgetMs 0): the resting capture holds only the opening window', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping unkeyed baseline (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({ scrollBudgetMs: 0 }))
    const result = await provider.fetch({ url: `${baseUrl}unkeyed/` })
    const text = result.body.kind === 'text' ? result.body.content : ''
    expect(text).toContain('MARKER-ROW-1 ')
    expect(text).not.toContain('MARKER-ROW-30 ')
    await provider.dispose()
  })

  it('feature on: rows with no DOM identity are restored whole, once each, in order', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping unkeyed feature case (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({}))
    const result = await provider.fetch({ url: `${baseUrl}unkeyed/` })
    expectWholeTimeline(result.body.kind === 'text' ? result.body.content : '')
    await provider.dispose()
  })

  it('a window re-rendered wholesale via innerHTML is restored whole too', { timeout: 120_000 }, async () => {
    if (!browserAvailable) {
      console.warn('skipping unkeyed wholesale case (no launchable browser)')
      return
    }
    const provider = new PlaywrightFetchProvider(localConfig({}))
    const result = await provider.fetch({ url: `${baseUrl}unkeyed/?wholesale` })
    expectWholeTimeline(result.body.kind === 'text' ? result.body.content : '')
    await provider.dispose()
  })
})
