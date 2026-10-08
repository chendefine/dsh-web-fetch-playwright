/**
 * The provider over fake browser sessions: URL hygiene, content-type
 * branching, the denoise toggle, body caps, error taxonomy, the concurrency
 * queue (gated sessions), the CDP context modes (profile closing only its
 * tab, isolated closing page + context, abort leaving the shared default
 * context intact, the popup guard), plus one real-socket case for the CDP
 * connect failure path — and the bounded Cloudflare-challenge wait (A/B
 * baseline vs feature on, SPA clears, same-page retries, hard blocks,
 * aborts).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebError } from '@deepseek-ai/dsh-web'
import type { ResolvedConfig } from '../src/config.ts'
import { CdpConnectionPool } from '../src/cdp-pool.ts'
import { PlaywrightFetchProvider, WEB_FETCH_CHALLENGE_CODE } from '../src/provider.ts'
import type { BrowserSession } from '../src/provider.ts'
import type { PlaywrightBrowser, PlaywrightContext, PlaywrightDownload, PlaywrightPage, PlaywrightResponse } from '../src/types.ts'

/** Everything a fake navigation can be told to produce. */
interface FakePageSpec {
  finalUrl?: string
  status?: number
  contentType?: string
  html?: string
  textBody?: string
  gotoError?: Error
  networkIdleError?: boolean
  /** Never settle `goto` on its own — it rejects when the page closes. */
  hangGoto?: boolean
  /**
   * Chromium status-render failure (httpbin `/status/N` shape): `goto` emits
   * a main-frame response event (headers arrive before the loader is torn
   * down), then rejects with the net error Chromium reports for a response
   * it refused to render — `ERR_HTTP_RESPONSE_CODE_FAILURE` by default, or
   * `ERR_ABORTED` with `aborted: true` (the 204/205 shape).
   */
  statusFailure?: {
    status?: number
    contentType?: string
    headers?: Record<string, string>
    body?: string
    url?: string
    aborted?: boolean
  }
  /**
   * A download-turned navigation (publish.twitter.com oembed shape):
   * `goto` emits the main-frame response event — headers arrive before
   * Chromium flips the navigation to its download manager, and the response
   * body is already gone from the network stack — then rejects with
   * Playwright's "Download is starting". The recovery refetches through
   * `page.request`, which serves `refetched`.
   */
  downloadFailure?: {
    status?: number
    contentType?: string
    headers?: Record<string, string>
    url?: string
    /** What the page's API request context serves the recovery refetch. */
    refetched?: { status?: number; contentType?: string; body?: string }
    /** Omit `page.request` to exercise the no-request-context error path. */
    noRequestContext?: boolean
    /** Reject with a bare `net::ERR_ABORTED` instead of "Download is starting". */
    abortedSpelling?: boolean
  }
  /**
   * Single-shot challenge goto: 403 + `cf-mitigated: challenge` + the
   * interstitial HTML, cleared only by the scripted probe behavior below.
   */
  challenge?: boolean
  /**
   * Ordered goto results — the first `goto` uses [0], later ones repeat the
   * last entry; a `challenge: true` entry serves the interstitial.
   */
  gotoScript?: Array<{ status?: number; contentType?: string; html?: string; textBody?: string; challenge?: boolean }>
  /** The fake clears its challenge on the Nth probe (evaluate/content read). */
  clearAfterProbes?: number
  /** The fake never clears — a challenge only a human (or nothing) passes. */
  neverClears?: boolean
  /** A main-frame response emitted through 'response' listeners at clear time. */
  emitOnClear?: { status?: number; contentType?: string }
  /** Omit `evaluate` so the provider's probe falls back to content polling. */
  noEvaluate?: boolean
}

const ARTICLE_HTML = `<!doctype html><html><head><title>Fake page</title></head><body>
<nav>nav noise</nav>
<main><article><h1>Hello</h1><p>World</p><p>A second paragraph gives the article scorer enough text mass to find the main region.</p></article></main>
<footer>footer noise</footer>
</body></html>`

/** The interstitial a challenged navigation serves (markers must classify). */
const CHALLENGE_HTML = `<!doctype html><html lang="en"><head><title>Just a moment...</title></head><body>
<div class="main-wrapper"><div class="main-content">
<div id="challenge-stage"><div id="challenge-running">Verifying you are human. This may take a few seconds.</div></div>
<div class="footer"><div class="footer-inner"><span class="ray-id">Ray ID: FAKE0123456789</span></div></div>
</div>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1/fake" async></script>
<script>window._cf_chl_opt = { cvId: 3 };</script>
</body></html>`

/** Identity token shared by the page's mainFrame and its responses' requests. */
const mainFrameToken = Symbol('fake-main-frame')

/** A fake page's shared, observable lifecycle state. */
interface FakePageState {
  pageClosed: boolean
  /** How many `goto` calls the page served. */
  gotos: number
  /** Downloads the browser started (downloadFailure navigations fire one). */
  downloadsStarted: number
  /** How many of those the provider's guard canceled. */
  downloadCancels: number
  /** How many API-context refetches the page served. */
  refetches: number
}

function fakeResponse(spec: FakePageSpec, entry?: NonNullable<FakePageSpec['gotoScript']>[number]): PlaywrightResponse | null {
  if (spec.gotoError !== undefined) return null
  const challenge = entry?.challenge === true || (entry === undefined && spec.challenge === true)
  const headers: Record<string, string> = { 'content-type': entry?.contentType ?? spec.contentType ?? 'text/html; charset=utf-8' }
  if (challenge) headers['cf-mitigated'] = 'challenge'
  return {
    status: () => entry?.status ?? spec.status ?? (challenge ? 403 : 200),
    headers: () => headers,
    text: async () => entry?.textBody ?? spec.textBody ?? '',
    url: () => spec.finalUrl ?? 'https://final.example.com/docs',
    request: () => ({
      isNavigationRequest: () => true,
      resourceType: () => 'document',
      frame: () => mainFrameToken,
    }),
  }
}

/** Guards (listeners) the provider registers on a fake page, for assertion. */
interface FakePageListeners {
  popup: Array<(page: PlaywrightPage) => void>
  download: Array<(download: PlaywrightDownload) => void>
}

/** Shared page behavior: the members the provider touches, close tracking. */
function makeFakePage(spec: FakePageSpec, state: FakePageState, listeners: FakePageListeners = { popup: [], download: [] }): PlaywrightPage {
  const gotoRejecters: Array<(error: Error) => void> = []
  const responseListeners: Array<(response: PlaywrightResponse) => void> = []
  const downloadListeners = listeners.download
  const popupListeners = listeners.popup
  const scripted = spec.gotoScript ?? []
  let reads = 0
  let cleared = false

  const entryAt = (index: number): NonNullable<FakePageSpec['gotoScript']>[number] | undefined =>
    scripted.length === 0 ? undefined : scripted[Math.min(index, scripted.length - 1)]
  const currentEntry = (): NonNullable<FakePageSpec['gotoScript']>[number] | undefined =>
    entryAt(Math.max(0, state.gotos - 1))
  const onChallenge = (): boolean => {
    if (cleared) return false
    if (spec.neverClears === true) return true
    const entry = currentEntry()
    if (entry !== undefined) return entry.challenge === true
    return spec.challenge === true
  }
  /** One probe read of the challenged document; the fake clears at the Nth. */
  const noteRead = (): void => {
    if (cleared || !onChallenge() || spec.clearAfterProbes === undefined) return
    reads++
    if (reads >= spec.clearAfterProbes) {
      cleared = true
      if (spec.emitOnClear !== undefined) {
        const emit = spec.emitOnClear
        const headers = { 'content-type': emit.contentType ?? 'text/html; charset=utf-8' }
        const response: PlaywrightResponse = {
          status: () => emit.status ?? 200,
          headers: () => headers,
          text: async () => '',
          url: () => spec.finalUrl ?? 'https://final.example.com/docs',
          request: () => ({ isNavigationRequest: () => true, resourceType: () => 'document', frame: () => mainFrameToken }),
        }
        for (const listener of [...responseListeners]) listener(response)
      }
    }
  }

  const page: PlaywrightPage = {
    goto: (): Promise<PlaywrightResponse | null> => {
      // A closed page rejects navigation, like a real Playwright page.
      if (state.pageClosed) return Promise.reject(new Error('Target closed'))
      if (spec.gotoError !== undefined) return Promise.reject(spec.gotoError)
      if (spec.statusFailure !== undefined) {
        // Chromium's order: responseReceived (the response event) fires
        // before loadingFailed (the goto rejection) — the provider's
        // recovery depends on exactly that ordering.
        const sf = spec.statusFailure
        const responseUrl = sf.url ?? spec.finalUrl ?? 'https://final.example.com/docs'
        const response: PlaywrightResponse = {
          status: () => sf.status ?? 404,
          headers: () => ({ 'content-type': sf.contentType ?? 'text/html; charset=utf-8', ...(sf.headers ?? {}) }),
          text: async () => sf.body ?? '',
          url: () => responseUrl,
          request: () => ({
            isNavigationRequest: () => true,
            resourceType: () => 'document',
            frame: () => mainFrameToken,
          }),
        }
        for (const listener of [...responseListeners]) listener(response)
        const netError = sf.aborted === true ? 'net::ERR_ABORTED' : 'net::ERR_HTTP_RESPONSE_CODE_FAILURE'
        return Promise.reject(new Error(
          `page.goto: ${netError} at ${responseUrl}\nCall log:\n  - navigating to "${responseUrl}", waiting until "domcontentloaded"`,
        ))
      }
      if (spec.downloadFailure !== undefined) {
        // Chromium's order for a download-turned navigation: responseReceived
        // (the response event with the attachment disposition) fires, the
        // body is handed to the download manager (a download event follows),
        // and only then does goto reject with "Download is starting".
        const df = spec.downloadFailure
        const responseUrl = df.url ?? spec.finalUrl ?? 'https://final.example.com/download.json'
        const response: PlaywrightResponse = {
          status: () => df.status ?? 200,
          headers: () => ({ 'content-type': df.contentType ?? 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename=json.json', ...(df.headers ?? {}) }),
          // The network stack no longer has the body — the real error shape.
          text: async () => { throw new Error('Protocol error (Network.getResponseBody): No resource with given identifier found') },
          url: () => responseUrl,
          request: () => ({
            isNavigationRequest: () => true,
            resourceType: () => 'document',
            frame: () => mainFrameToken,
          }),
        }
        for (const listener of [...responseListeners]) listener(response)
        state.downloadsStarted++
        const download: PlaywrightDownload = { cancel: async () => { state.downloadCancels++ } }
        for (const listener of [...downloadListeners]) listener(download)
        const netError = df.abortedSpelling === true ? 'net::ERR_ABORTED' : 'Download is starting'
        return Promise.reject(new Error(
          `page.goto: ${netError}\nCall log:\n  - navigating to "${responseUrl}", waiting until "domcontentloaded"`,
        ))
      }
      if (spec.hangGoto === true) {
        return new Promise((_resolve, reject) => { gotoRejecters.push(reject) })
      }
      const entry = entryAt(state.gotos)
      state.gotos++
      return Promise.resolve(fakeResponse(spec, entry))
    },
    waitForLoadState: async () => {
      if (spec.networkIdleError === true) throw new Error('networkidle timeout')
    },
    url: () => spec.finalUrl ?? 'https://final.example.com/docs',
    content: async () => {
      noteRead()
      if (onChallenge()) return CHALLENGE_HTML
      return currentEntry()?.html ?? spec.html ?? ARTICLE_HTML
    },
    close: async () => {
      state.pageClosed = true
      for (const reject of gotoRejecters.splice(0)) reject(new Error('Target closed'))
    },
    route: async () => {},
    on: (event: 'popup' | 'response' | 'download', listener: ((page: PlaywrightPage) => void) | ((response: PlaywrightResponse) => void) | ((download: PlaywrightDownload) => void)) => {
      if (event === 'popup') popupListeners.push(listener as (page: PlaywrightPage) => void)
      else if (event === 'response') responseListeners.push(listener as (response: PlaywrightResponse) => void)
      else downloadListeners.push(listener as (download: PlaywrightDownload) => void)
    },
    ...(spec.noEvaluate === true ? {} : {
      evaluate: async (): Promise<unknown> => {
        noteRead()
        return onChallenge()
      },
    }),
    mainFrame: () => mainFrameToken,
    ...(spec.downloadFailure?.noRequestContext === true ? {} : {
      // The API request context the download recovery refetches through.
      // Absent entirely when no spec asks for it, mirroring minimal fakes.
      ...(spec.downloadFailure !== undefined ? {
        request: {
          get: async (fetchUrl: string): Promise<PlaywrightResponse> => {
            state.refetches++
            const rf = spec.downloadFailure?.refetched
            return {
              status: () => rf?.status ?? 200,
              headers: () => ({ 'content-type': rf?.contentType ?? 'application/json; charset=utf-8' }),
              text: async () => rf?.body ?? '{"type":"tweet","html":"<blockquote>…</blockquote>"}',
              url: () => fetchUrl,
            }
          },
        },
      } : {}),
    }),
  }
  return page
}

function fakeSession(spec: FakePageSpec): BrowserSession {
  const pageState: FakePageState = { pageClosed: false, gotos: 0, downloadsStarted: 0, downloadCancels: 0, refetches: 0 }
  const closed = { context: false, browser: false }
  const page = makeFakePage(spec, pageState)
  const context: PlaywrightContext = {
    newPage: async () => page,
    route: async () => {},
    close: async () => { closed.context = true },
  }
  const browser: PlaywrightBrowser = {
    newContext: async () => context,
    close: async () => { closed.browser = true },
  }
  return {
    browser,
    context,
    page,
    closed: {
      get pageClosed() { return pageState.pageClosed },
      get gotos() { return pageState.gotos },
      get downloadsStarted() { return pageState.downloadsStarted },
      get downloadCancels() { return pageState.downloadCancels },
      get refetches() { return pageState.refetches },
      get context() { return closed.context },
      get browser() { return closed.browser },
    },
  } as unknown as BrowserSession & { closed: { pageClosed: boolean; context: boolean; browser: boolean; gotos: number; downloadsStarted: number; downloadCancels: number; refetches: number } }
}

/** The provider under test: a fixed config and an injected fake session. */
class FakeProvider extends PlaywrightFetchProvider {
  /** The session the last fetch ran in (counters ride on it). */
  lastSession: BrowserSession | undefined

  constructor(config: Partial<ResolvedConfig> = {}, private readonly spec: FakePageSpec = {}) {
    super(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      // Legacy default: the challenge path stays off unless a test opts in.
      challengeWaitMs: 0,
      challengeRetries: 0,
      ...config,
    }))
  }

  protected async openSession(): Promise<BrowserSession> {
    this.lastSession = fakeSession(this.spec)
    return this.lastSession
  }
}

/**
 * The provider over a fake session whose `openSession` blocks on a test-held
 * gate: concurrency-queue behavior without real browser launches. `started`
 * records `openSession` entries in arrival order.
 */
class GatedProvider extends PlaywrightFetchProvider {
  readonly started: number[] = []
  private gate: Promise<void> = Promise.resolve()

  constructor(config: Partial<ResolvedConfig>) {
    super(() => ({
      backend: 'local',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeWaitMs: 0,
      challengeRetries: 0,
      ...config,
    }))
  }

  /** Make every subsequent `openSession` await the given promise. */
  blockOn(gate: Promise<void>): void {
    this.gate = gate
  }

  protected async openSession(): Promise<BrowserSession> {
    this.started.push(this.started.length)
    await this.gate
    return fakeSession({})
  }
}

/**
 * A fake shared CDP connection for provider-level tests: every fetch leases
 * a page (tab) over ONE browser — from its default context (profile mode)
 * or a throwaway context (isolated mode) — whose open/close counts are
 * tracked for assertions. The default context records (and tests assert it
 * never receives) a close.
 */
function fakeCdpConnection(spec: FakePageSpec = {}) {
  const state = {
    connects: 0,
    isolatedContextsOpened: 0,
    isolatedContextsClosed: 0,
    /** Tabs opened in the default context (profile mode). */
    defaultPagesOpened: 0,
    /** close() calls on the default context — profile mode must keep at 0. */
    defaultContextClosed: 0,
    /** Every page any mode opened / fully closed (closes are idempotent). */
    pagesOpened: 0,
    pagesClosed: 0,
    browserClosed: false,
    /** Popup listeners the guard registered on the leased pages. */
    popupListeners: [] as Array<(page: PlaywrightPage) => void>,
    /** Download listeners the guard registered on the leased pages. */
    downloadListeners: [] as Array<(download: PlaywrightDownload) => void>,
  }
  const makePage = (): PlaywrightPage => {
    state.pagesOpened++
    const pageState: FakePageState = { pageClosed: false, gotos: 0, downloadsStarted: 0, downloadCancels: 0, refetches: 0 }
    const page = makeFakePage(spec, pageState, { popup: state.popupListeners, download: state.downloadListeners })
    const base = page.close.bind(page)
    return {
      ...page,
      close: async () => {
        if (pageState.pageClosed) return // a real page's second close is a no-op
        state.pagesClosed++
        await base()
      },
    }
  }
  const defaultContext: PlaywrightContext = {
    newPage: async () => {
      state.defaultPagesOpened++
      return makePage()
    },
    route: async () => {},
    close: async () => { state.defaultContextClosed++ },
  }
  const browser: PlaywrightBrowser = {
    newContext: async () => {
      state.isolatedContextsOpened++
      const context: PlaywrightContext = {
        newPage: async () => makePage(),
        route: async () => {},
        close: async () => { state.isolatedContextsClosed++ },
      }
      return context
    },
    contexts: () => [defaultContext],
    close: async () => { state.browserClosed = true },
  }
  return {
    state,
    /** A pool whose connect always lands on this one connection. */
    pool: new CdpConnectionPool(async () => { state.connects++; return browser }),
  }
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    const webError = error as WebError
    if (webError instanceof WebError) return webError.code
    throw error
  }
  throw new Error('expected the fetch to reject')
}

describe('PlaywrightFetchProvider', () => {
  it('is always available (cheap check, no side effects)', () => {
    expect(new FakeProvider().available()).toBe(true)
    expect(new FakeProvider().id).toBe('playwright')
  })

  it('rejects non-http schemes and credentialed URLs up front', async () => {
    await expect(codeOf(new FakeProvider().fetch({ url: 'ftp://example.com/x' }))).resolves.toBe('WEB_INVALID_URL')
    await expect(codeOf(new FakeProvider().fetch({ url: 'http://user:pass@example.com/' }))).resolves.toBe('WEB_BLOCKED_URL')
    await expect(codeOf(new FakeProvider().fetch({ url: 'not a url' }))).resolves.toBe('WEB_INVALID_URL')
  })

  it('returns denoised markdown for html pages', async () => {
    const result = await new FakeProvider().fetch({ url: 'https://example.com/docs' })
    expect(result.url).toBe('https://final.example.com/docs')
    expect(result.statusCode).toBe(200)
    expect(result.truncated).toBe(false)
    expect(result.body.kind).toBe('text')
    const content = result.body.kind === 'text' ? result.body.content : ''
    // Either the kept article heading or the prepended page title leads it.
    expect(content).toMatch(/^# (Hello|Fake page)\b/m)
    expect(content).toContain('World')
    expect(content).not.toContain('nav noise')
    expect(content).not.toContain('footer noise')
  })

  it('returns raw html when the denoise toggle is off', async () => {
    const result = await new FakeProvider({ denoise: false }).fetch({ url: 'https://example.com/docs' })
    expect(result.body.kind).toBe('html')
    if (result.body.kind === 'html') {
      expect(result.body.content).toContain('<article>')
      expect(result.body.content).toContain('nav noise')
    }
  })

  it('decodes non-html text bodies verbatim', async () => {
    const result = await new FakeProvider({}, { contentType: 'application/json', textBody: '{"ok":true}' })
      .fetch({ url: 'https://example.com/api' })
    expect(result.body).toEqual({ kind: 'text', content: '{"ok":true}' })
  })

  it('refuses binary content types', async () => {
    const code = await codeOf(new FakeProvider({}, { contentType: 'image/png' }).fetch({ url: 'https://example.com/img' }))
    expect(code).toBe('WEB_UNSUPPORTED_CONTENT_TYPE')
  })

  it('keeps a non-2xx status as a result, not an error', async () => {
    const result = await new FakeProvider({}, { status: 404, html: '<html><body><h1>Not found</h1></body></html>' })
      .fetch({ url: 'https://example.com/missing' })
    expect(result.statusCode).toBe(404)
  })

  it('caps the body and flags the cut', async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `<p>paragraph ${String(i)} with some words</p>`).join('')
    const html = `<!doctype html><html><body><article><h1>Big</h1>${big}</article></body></html>`
    const result = await new FakeProvider({}, { html }).fetch({ url: 'https://example.com/big' })
    expect(result.truncated).toBe(true)
    expect((result.body as { content: string }).content.length).toBe(100_000)
  })

  it('maps navigation failures to WEB_PROVIDER_ERROR with the original message', async () => {
    const code = await codeOf(
      new FakeProvider({}, { gotoError: new Error('net::ERR_CONNECTION_REFUSED at https://example.com') })
        .fetch({ url: 'https://example.com/down' }),
    )
    expect(code).toBe('WEB_PROVIDER_ERROR')
  })

  it('translates a pre-aborted signal to WEB_ABORTED', async () => {
    const controller = new AbortController()
    controller.abort()
    const code = await codeOf(new FakeProvider().fetch({ url: 'https://example.com/x' }, controller.signal))
    expect(code).toBe('WEB_ABORTED')
  })

  it('survives a networkidle settle timeout (keeps domcontentloaded content)', async () => {
    const result = await new FakeProvider({}, { networkIdleError: true }).fetch({ url: 'https://example.com/spa' })
    expect(result.body.kind).toBe('text')
  })
})

describe('PlaywrightFetchProvider status-only navigation recovery', () => {
  /**
   * The seam contract: "a successful network fetch of a non-2xx response is
   * a result, not an error". Chromium breaks the goto for status-only
   * responses (empty-bodied error statuses via ERR_HTTP_RESPONSE_CODE_FAILURE;
   * 204/205 via ERR_ABORTED) — the tracker lets the provider keep the
   * contract the http backend already honors.
   */
  it('recovers an empty-bodied 404 (httpbin /status/N) as a result, not WEB_PROVIDER_ERROR', async () => {
    const result = await new FakeProvider({}, { statusFailure: { status: 404, url: 'https://httpbin.org/status/404' } })
      .fetch({ url: 'https://httpbin.org/status/404' })
    expect(result.statusCode).toBe(404)
    expect(result.url).toBe('https://httpbin.org/status/404')
    expect(result.body).toEqual({ kind: 'text', content: '' })
    expect(result.truncated).toBe(false)
  })

  it('recovers 4xx and 5xx shapes alike with the tracked content type', async () => {
    for (const [status, contentType] of [[418, 'text/html; charset=utf-8'], [500, 'application/json']] as const) {
      const result = await new FakeProvider({}, { statusFailure: { status, contentType } })
        .fetch({ url: 'https://example.com/status' })
      expect(result.statusCode).toBe(status)
      expect(result.body).toEqual({ kind: 'text', content: '' })
    }
  })

  it('recovers on the legacy challengeWaitMs: 0 path too (tracker is always on)', async () => {
    const result = await new FakeProvider({ challengeWaitMs: 0 }, { statusFailure: { status: 404 } })
      .fetch({ url: 'https://example.com/legacy' })
    expect(result.statusCode).toBe(404)
  })

  it('recovers with the challenge wait armed without burning the challenge budget', async () => {
    const result = await new FakeProvider({ challengeWaitMs: 60_000, challengeRetries: 3 }, { statusFailure: { status: 503 } })
      .fetch({ url: 'https://example.com/slow-origin' })
    expect(result.statusCode).toBe(503)
  })

  it('recovers a status-only 204 behind ERR_ABORTED as a result', async () => {
    const result = await new FakeProvider({}, { statusFailure: { status: 204, aborted: true, contentType: '' } })
      .fetch({ url: 'https://example.com/no-content' })
    expect(result.statusCode).toBe(204)
    expect(result.body).toEqual({ kind: 'text', content: '' })
  })

  it('keeps a body-bearing recovered html response through the denoise pipeline', async () => {
    const result = await new FakeProvider({}, {
      statusFailure: {
        status: 404,
        body: '<!doctype html><html><body><main><article><h1>Lost</h1><p>The page exists but the article is gone, with enough prose that the extractor locks on.</p></article></main></body></html>',
      },
    }).fetch({ url: 'https://example.com/gone' })
    expect(result.statusCode).toBe(404)
    expect(result.body.kind).toBe('text')
    if (result.body.kind === 'text') {
      expect(result.body.content).toMatch(/# (Lost|404|Fake page)/)
    }
  })

  it('keeps a body-bearing recovered html page raw when denoise is off', async () => {
    const result = await new FakeProvider({ denoise: false }, {
      statusFailure: { status: 404, body: '<html><body>raw missing page</body></html>' },
    }).fetch({ url: 'https://example.com/gone' })
    expect(result.statusCode).toBe(404)
    expect(result.body).toEqual({ kind: 'html', content: '<html><body>raw missing page</body></html>' })
  })

  it('refuses an unsupported content type on the recovered response', async () => {
    const code = await codeOf(new FakeProvider({}, { statusFailure: { status: 404, contentType: 'application/octet-stream' } })
      .fetch({ url: 'https://example.com/bin' }))
    expect(code).toBe('WEB_UNSUPPORTED_CONTENT_TYPE')
  })

  it('fails with WEB_FETCH_CHALLENGE when the unrendered response is a challenge edge', async () => {
    const error = await new FakeProvider({}, {
      statusFailure: { status: 403, headers: { 'cf-mitigated': 'challenge', server: 'cloudflare' } },
    }).fetch({ url: 'https://example.com/guarded' }).catch(error2 => error2)
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe(WEB_FETCH_CHALLENGE_CODE)
    expect((error as WebError).message).toContain('HTTP 403')
  })

  it('does NOT recover an ERR_ABORTED whose tracked response shows no attachment (an SPA cancel, a bare abort)', async () => {
    const code = await codeOf(new FakeProvider({}, { statusFailure: { status: 200, aborted: true, body: 'irrelevant' } })
      .fetch({ url: 'https://example.com/attachment' }))
    expect(code).toBe('WEB_PROVIDER_ERROR')
  })

  it('propagates WEB_PROVIDER_ERROR when no response event survived the failure', async () => {
    // gotoError rejects BEFORE any response event — a backend without
    // response tracking (minimal fake) cannot support recovery.
    const code = await codeOf(
      new FakeProvider({}, { gotoError: new Error('page.goto: net::ERR_HTTP_RESPONSE_CODE_FAILURE at https://example.com/x') })
        .fetch({ url: 'https://example.com/x' }),
    )
    expect(code).toBe('WEB_PROVIDER_ERROR')
  })
})

describe('PlaywrightFetchProvider download navigation recovery', () => {
  /**
   * The badcase (https://publish.twitter.com/oembed?url=<tweet>): a
   * decodable `application/json` body served with `Content-Disposition:
   * attachment`. Chromium refuses to commit it as a document — goto rejects
   * "Download is starting" and the body is gone from the network stack — so
   * the provider refetches through the page's API request context and keeps
   * the seam's "a fetched response is a result" contract.
   */
  it('recovers an attachment JSON (oembed shape) as a text result via the request-context refetch', async () => {
    const provider = new FakeProvider({}, {
      downloadFailure: {
        status: 200,
        contentType: 'application/json; charset=utf-8',
        url: 'https://publish.x.com/oembed?url=https://x.com/tianyi/status/2105790798461882377',
        refetched: { status: 200, contentType: 'application/json; charset=utf-8', body: '{"url":"https://x.com/tianyi/status/2105790798461882377","author_name":"Tianyi Cui"}' },
      },
    })
    const result = await provider.fetch({ url: 'https://publish.twitter.com/oembed?url=https://x.com/tianyi/status/2105790798461882377' })
    expect(result.statusCode).toBe(200)
    expect(result.body.kind).toBe('text')
    expect(result.body.kind === 'text' ? result.body.content : '').toContain('Tianyi Cui')
    expect(result.truncated).toBe(false)
  })

  it('reports the refetch\'s status when the download answered non-2xx (contract: a result, not an error)', async () => {
    const result = await new FakeProvider({}, {
      downloadFailure: { status: 401, refetched: { status: 401, contentType: 'application/json', body: '{"errors":["Unauthorized"]}' } },
    }).fetch({ url: 'https://example.com/oembed' })
    expect(result.statusCode).toBe(401)
    expect(result.body.kind).toBe('text')
  })

  it('runs an html attachment through the denoise pipeline, honoring the toggle', async () => {
    const denoised = await new FakeProvider({}, {
      downloadFailure: { contentType: 'text/html; charset=utf-8', refetched: { contentType: 'text/html; charset=utf-8', body: '<!doctype html><html><body><main><article><h1>Attached</h1><p>The saved page body, with enough prose that the extractor locks onto the article.</p></article></main></body></html>' } },
    }).fetch({ url: 'https://example.com/saved-page' })
    expect(denoised.body.kind).toBe('text')
    if (denoised.body.kind === 'text') expect(denoised.body.content).toMatch(/# Attached/)

    const raw = await new FakeProvider({ denoise: false }, {
      downloadFailure: { contentType: 'text/html; charset=utf-8', refetched: { contentType: 'text/html; charset=utf-8', body: '<html><body>attached raw</body></html>' } },
    }).fetch({ url: 'https://example.com/saved-page' })
    expect(raw.body).toEqual({ kind: 'html', content: '<html><body>attached raw</body></html>' })
  })

  it('refuses an undecodable download (pdf/zip) as WEB_UNSUPPORTED_CONTENT_TYPE without refetching', async () => {
    const provider = new FakeProvider({}, {
      downloadFailure: { contentType: 'application/pdf' },
    })
    const code = await codeOf(provider.fetch({ url: 'https://example.com/file.pdf' }))
    expect(code).toBe('WEB_UNSUPPORTED_CONTENT_TYPE')
    const session = provider.lastSession as unknown as { closed: { refetches: number } }
    expect(session.closed.refetches).toBe(0)
  })

  it('recognizes the ERR_ABORTED + attachment-disposition spelling of a download failure', async () => {
    // Engines that report a plain ERR_ABORTED for a download: the tracked
    // response's disposition is the second, engine-proof signal. (A bare
    // ERR_ABORTED WITHOUT the disposition stays unrecovered — covered in the
    // status-recovery block above.)
    const result = await new FakeProvider({}, {
      downloadFailure: {
        abortedSpelling: true,
        refetched: { status: 200, contentType: 'application/json', body: '{"ok":true}' },
      },
    }).fetch({ url: 'https://example.com/aborted-download' })
    expect(result.statusCode).toBe(200)
    expect(result.body.kind).toBe('text')
    if (result.body.kind === 'text') expect(result.body.content).toBe('{"ok":true}')
  })

  it('fails with a clear WEB_PROVIDER_ERROR when the page exposes no request context', async () => {
    const error = await new FakeProvider({}, {
      downloadFailure: { noRequestContext: true },
    }).fetch({ url: 'https://example.com/oembed' }).catch(caught => caught)
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
    expect((error as WebError).message).toContain('will not render')
  })

  it('the download guard cancels what the browser starts downloading', async () => {
    // Through the CDP path (whose real openSession installs the guards), the
    // same shape as the popup-guard case: a registered listener that cancels
    // whatever Chromium starts downloading on the fetch's tab, so nothing
    // lands in the (possibly remote) profile's download dir.
    const { state, pool } = fakeCdpConnection()
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      maxConcurrency: 4,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }), pool)
    await provider.fetch({ url: 'https://example.com/download-spawner' })
    expect(state.downloadListeners.length).toBeGreaterThan(0) // the guard attached

    let cancels = 0
    for (const listener of state.downloadListeners) listener({ cancel: async () => { cancels++ } }) // the browser started a download
    expect(cancels).toBe(state.downloadListeners.length)
  })

  it('recovers on the challenge-armed path too, without touching the challenge budget', async () => {
    const result = await new FakeProvider({ challengeWaitMs: 60_000, challengeRetries: 3 }, {
      downloadFailure: { refetched: { status: 200, contentType: 'application/json', body: '{"ok":true}' } },
    }).fetch({ url: 'https://example.com/oembed' })
    expect(result.statusCode).toBe(200)
  })
})

describe('PlaywrightFetchProvider concurrency queue', () => {
  /** Flush pending microtasks/macrotasks without waiting on gated fetches. */
  async function flush(): Promise<void> {
    await new Promise(resolve => { setImmediate(resolve) })
  }

  /** Real-timer safety net: a timed-out test's `finally` never runs. */
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('renders up to maxConcurrency pages at once and queues the rest', async () => {
    const provider = new GatedProvider({})
    provider.blockOn(new Promise<void>(() => {}))
    const controllers = Array.from({ length: 5 }, () => new AbortController())
    const fetches = controllers.map((controller, i) =>
      provider.fetch({ url: `https://example.com/page-${String(i)}` }, controller.signal).catch(() => {}) as Promise<unknown>)
    await flush()
    // The four slot holders reached openSession; the fifth is still queued.
    expect(provider.started).toEqual([0, 1, 2, 3])
    controllers.forEach(controller => controller.abort())
    await flush()
    void fetches
  })

  it('fails a queued fetch fast with a retry hint instead of hanging until abort', async () => {
    // Only the timeout functions are faked: flush() relies on a real setImmediate.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const provider = new GatedProvider({ maxConcurrency: 1 })
    provider.blockOn(new Promise<void>(() => {}))
    void provider.fetch({ url: 'https://example.com/holder' }).catch(() => {}) // occupies the only slot
    await flush()
    expect(provider.started).toEqual([0])
    const queued = provider.fetch({ url: 'https://example.com/queued' }).catch(error => error)
    await vi.advanceTimersByTimeAsync(20_000)
    const error = await queued
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_FETCH_TIMEOUT')
    expect((error as WebError).message).toContain('rendering slots stayed busy')
    expect((error as WebError).message).toContain('maxConcurrency')
  })

  it('keeps the slot message when the caller cancels a queued fetch', async () => {
    const provider = new GatedProvider({ maxConcurrency: 1 })
    provider.blockOn(new Promise<void>(() => {}))
    void provider.fetch({ url: 'https://example.com/holder' }).catch(() => {}) // occupies the only slot
    await flush()
    const controller = new AbortController()
    const queued = provider.fetch({ url: 'https://example.com/queued' }, controller.signal).catch(error => error)
    await flush()
    controller.abort()
    const error = await queued
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_ABORTED')
    expect((error as WebError).message).toContain('waiting for a free rendering slot')
  })

  it('does not release a phantom slot when a queued fetch fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const provider = new GatedProvider({ maxConcurrency: 1 })
    provider.blockOn(new Promise<void>(() => {}))
    void provider.fetch({ url: 'https://example.com/holder' }).catch(() => {}) // occupies the only slot
    await flush()
    const queued = provider.fetch({ url: 'https://example.com/queued' }).catch(error => error)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(await queued).toBeInstanceOf(WebError)
    // The failed waiter held no slot: a later fetch still queues (and fails
    // on its own patience) rather than slipping into a phantom free slot.
    const later = provider.fetch({ url: 'https://example.com/later' }).catch(error => error)
    await vi.advanceTimersByTimeAsync(20_000)
    const laterFailure = await later
    expect(laterFailure).toBeInstanceOf(WebError)
    expect((laterFailure as WebError).message).toContain('rendering slots stayed busy')
    expect(provider.started).toEqual([0])
  })
})

describe('PlaywrightFetchProvider CDP backend', () => {
  it('isolated mode (checkbox off): one shared connection, each fetch a throwaway context it closes', async () => {
    const { state, pool } = fakeCdpConnection()
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: false,
      denoise: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }), pool)

    const first = await provider.fetch({ url: 'https://example.com/a' })
    const second = await provider.fetch({ url: 'https://example.com/b' })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)

    // Two fetches, two isolated tabs (page + context each), ONE connection.
    expect(state.connects).toBe(1)
    expect(state.isolatedContextsOpened).toBe(2)
    expect(state.isolatedContextsClosed).toBe(2)
    expect(state.pagesClosed).toBe(2)
    expect(state.defaultPagesOpened).toBe(0)
    expect(state.browserClosed).toBe(false)

    // Teardown (plugin unload) is what drops the shared connection.
    await provider.dispose()
    expect(state.browserClosed).toBe(true)
  })

  it('runs many concurrent isolated CDP fetches as tabs without queueing', async () => {
    const { state, pool } = fakeCdpConnection()
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: false,
      denoise: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }), pool)

    const results = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      provider.fetch({ url: `https://example.com/tab-${String(i)}` })))
    expect(results.every(result => result.statusCode === 200)).toBe(true)
    // All fifty rode the single connection as concurrent tabs — the CDP
    // default concurrency is high enough that none queued.
    expect(state.connects).toBe(1)
    expect(state.isolatedContextsOpened).toBe(50)
    expect(state.isolatedContextsClosed).toBe(50)
  })

  it('profile mode: each fetch is a tab of the shared default context, closed when done', async () => {
    const { state, pool } = fakeCdpConnection()
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }), pool)

    const first = await provider.fetch({ url: 'https://example.com/a' })
    const second = await provider.fetch({ url: 'https://example.com/b' })
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(200)

    // Two tabs of the ONE default context; both closed; the context and
    // the connection itself never closed.
    expect(state.connects).toBe(1)
    expect(state.defaultPagesOpened).toBe(2)
    expect(state.pagesOpened).toBe(2)
    expect(state.pagesClosed).toBe(2)
    expect(state.isolatedContextsOpened).toBe(0)
    expect(state.defaultContextClosed).toBe(0)
    expect(state.browserClosed).toBe(false)

    // Even plugin teardown only disconnects (the remote browser survives).
    await provider.dispose()
    expect(state.defaultContextClosed).toBe(0)
  })

  it('profile mode serves a concurrent burst as tabs of the one default context', async () => {
    const { state, pool } = fakeCdpConnection()
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }), pool)

    const results = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      provider.fetch({ url: `https://example.com/tab-${String(i)}` })))
    expect(results.every(result => result.statusCode === 200)).toBe(true)
    expect(state.connects).toBe(1)
    expect(state.pagesOpened).toBe(12)
    expect(state.pagesClosed).toBe(12)
    expect(state.defaultContextClosed).toBe(0)
  })

  it('an aborted profile fetch closes only its tab — the shared default context survives', async () => {
    const { state, pool } = fakeCdpConnection({ hangGoto: true })
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }), pool)

    const controller = new AbortController()
    const pending = provider.fetch({ url: 'https://example.com/slow' }, controller.signal)
      .then(() => { throw new Error('expected rejection') }, (error: unknown) => error)
    await new Promise(resolve => { setImmediate(resolve) }) // reaches goto
    expect(state.pagesOpened).toBe(1)
    controller.abort()
    const error = await pending

    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_ABORTED')
    expect(state.pagesClosed).toBe(1)
    expect(state.defaultContextClosed).toBe(0) // other tabs of the profile unaffected
    expect(state.browserClosed).toBe(false)
  })

  it('closes popups a fetched page spawns so no tab outlives the fetch', async () => {
    const { state, pool } = fakeCdpConnection()
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '',
      shareBrowserContext: true,
      denoise: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }), pool)

    await provider.fetch({ url: 'https://example.com/popup-spawner' })
    expect(state.popupListeners.length).toBeGreaterThan(0) // the guard attached

    const popupState: FakePageState = { pageClosed: false, gotos: 0, downloadsStarted: 0, downloadCancels: 0, refetches: 0 }
    const popup = makeFakePage({}, popupState)
    for (const listener of state.popupListeners) listener(popup) // page spawned a popup
    expect(popupState.pageClosed).toBe(true)
  })

  it('closes a local session explicitly: page, context, then browser', async () => {
    const provider = new FakeProvider()
    await provider.fetch({ url: 'https://example.com/docs' })
    const closed = (provider.lastSession as unknown as { closed: { pageClosed: boolean; context: boolean; browser: boolean } }).closed
    expect(closed.pageClosed).toBe(true)
    expect(closed.context).toBe(true)
    expect(closed.browser).toBe(true)
  })

  it('wraps a dead CDP endpoint as WEB_PROVIDER_ERROR naming the endpoint', { timeout: 30_000 }, async () => {
    const provider = new PlaywrightFetchProvider(() => ({
      backend: 'cdp',
      playwrightPath: '',
      cdpEndpoint: '127.0.0.1:1',
      shareBrowserContext: true,
      denoise: true,
      challengeWaitMs: 0,
      challengeRetries: 0,
    }))
    // Real bundled playwright-core; port 1 refuses connections immediately.
    const error = await provider.fetch({ url: 'https://example.com/x' }).then(() => { throw new Error('expected rejection') }, (e: unknown) => e)
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_PROVIDER_ERROR')
    expect((error as WebError).message).toContain('127.0.0.1:1')
  })
})

/** The bounded Cloudflare-challenge wait, end to end over the fake page. */
describe('PlaywrightFetchProvider cloudflare challenge wait', () => {
  /** Read the page-under-test's lifecycle counters off the last session. */
  function counters(provider: FakeProvider): { pageClosed: boolean; gotos: number } {
    return (provider.lastSession as unknown as { closed: { pageClosed: boolean; gotos: number } }).closed
  }

  function bodyOf(result: { body: { kind: string; content: string } }): string {
    return result.body.content
  }

  it('A1 baseline (challengeWaitMs 0): the interstitial comes back as content — the 0.2.4 behavior', async () => {
    const provider = new FakeProvider({ challengeWaitMs: 0 }, { challenge: true, neverClears: true })
    const result = await provider.fetch({ url: 'https://example.com/guarded' })
    expect(result.statusCode).toBe(403)
    expect(bodyOf(result)).toMatch(/just a moment/i)
    expect(bodyOf(result)).not.toContain('World')
    expect(counters(provider).gotos).toBe(1)
  })

  it('A2 feature on: waits past the clear, reads the reloaded document, and reports the tracked response status', async () => {
    const provider = new FakeProvider({ challengeWaitMs: 3_000 }, {
      challenge: true,
      clearAfterProbes: 3,
      // The natural verification reloads the same URL — the tracker must
      // hand the provider THIS response, not the 403 it started from.
      emitOnClear: { status: 200 },
    })
    const result = await provider.fetch({ url: 'https://example.com/guarded' })
    expect(result.statusCode).toBe(200)
    expect(result.body.kind).toBe('text')
    expect(bodyOf(result)).toMatch(/^# (Fake page|Hello)\b/m)
    expect(bodyOf(result)).toContain('World')
    expect(counters(provider).gotos).toBe(1) // same page the whole time
  })

  it('A3 never clears: fails as WEB_FETCH_CHALLENGE within the bounded window, no slot leak', async () => {
    const provider = new FakeProvider({ challengeWaitMs: 60, challengeRetries: 0 }, { challenge: true, neverClears: true })
    const started = Date.now()
    const error = await provider.fetch({ url: 'https://example.com/hard' }).then(() => { throw new Error('expected rejection') }, (e: unknown) => e)
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe(WEB_FETCH_CHALLENGE_CODE)
    expect((error as WebError).message).toContain('Cloudflare')
    // Bounded: one wait window, far short of the fetch deadline.
    expect(Date.now() - started).toBeLessThan(5_000)
    // The session still closed — the concurrency slot is not held hostage.
    expect(counters(provider).pageClosed).toBe(true)
  })

  it('A4 first window runs out, one same-page retry lands on the cleared document', async () => {
    const provider = new FakeProvider({ challengeWaitMs: 80, challengeRetries: 1 }, {
      gotoScript: [{ challenge: true }, { status: 200 }],
    })
    const result = await provider.fetch({ url: 'https://example.com/guarded' })
    expect(result.statusCode).toBe(200)
    expect(bodyOf(result)).toContain('World')
    // The retry re-navigated the SAME page (only one page ever existed).
    expect(counters(provider).gotos).toBe(2)
  })

  it('A5 a hard block fails immediately with WEB_FETCH_CHALLENGE instead of burning the wait', async () => {
    // Real hard blocks ship 403 from the Cloudflare edge (no cf-mitigated —
    // that header marks challenges, not blocks), which is what opens the
    // suspicion gate for the content-level blocked-page classification.
    const provider = new FakeProvider({ challengeWaitMs: 10_000 }, {
      status: 403,
      html: '<!doctype html><html><head><title>Attention Required! | Cloudflare</title></head><body><h1 class="cf-headline">Sorry, you have been blocked</h1></body></html>',
    })
    const started = Date.now()
    const error = await provider.fetch({ url: 'https://example.com/blocked' }).then(() => { throw new Error('expected rejection') }, (e: unknown) => e)
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe(WEB_FETCH_CHALLENGE_CODE)
    expect((error as WebError).message).toContain('hard-blocked')
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('A6 an outer abort during the wait maps to WEB_ABORTED and closes the page', async () => {
    const provider = new FakeProvider({ challengeWaitMs: 10_000 }, { challenge: true, neverClears: true })
    const controller = new AbortController()
    const pending = provider.fetch({ url: 'https://example.com/guarded' }, controller.signal)
      .then(() => { throw new Error('expected rejection') }, (error: unknown) => error)
    await new Promise(resolve => { setImmediate(resolve) }) // reaches the wait loop
    controller.abort()
    const error = await pending
    expect(error).toBeInstanceOf(WebError)
    expect((error as WebError).code).toBe('WEB_ABORTED')
    expect(counters(provider).pageClosed).toBe(true)
  })

  it('A7 SPA clear (no navigation, no new response): the DOM probe sees the swap and the result reads 200', async () => {
    const provider = new FakeProvider({ challengeWaitMs: 3_000 }, { challenge: true, clearAfterProbes: 3 })
    const result = await provider.fetch({ url: 'https://example.com/spa-guarded' })
    expect(result.statusCode).toBe(200)
    expect(bodyOf(result)).toContain('World')
    expect(counters(provider).gotos).toBe(1)
  })

  it('A8 no evaluate on the page: the probe falls back to content polling and still clears', async () => {
    const provider = new FakeProvider({ challengeWaitMs: 3_000 }, { challenge: true, clearAfterProbes: 3, noEvaluate: true })
    const result = await provider.fetch({ url: 'https://example.com/guarded' })
    expect(result.statusCode).toBe(200)
    expect(bodyOf(result)).toContain('World')
  })

  it('A9 no false kill: a plain-200 article that merely looks challenge-ish is returned untouched', async () => {
    // The suspicion gate: content markers only run on challenge-compatible
    // responses (403/429/503 or a Cloudflare edge), so an ordinary 200
    // article — even one whose TITLE reads "Just a moment" — never enters
    // the challenge path, waits nothing, and fails nothing.
    const provider = new FakeProvider({ challengeWaitMs: 5_000 }, {
      status: 200,
      html: `<!doctype html><html><head><title>Just a moment</title></head><body>
<main><article><h1>Not a challenge</h1><p>An essay about waiting screens; enough words for the article scorer to lock onto the main region here.</p><p>A second paragraph.</p></article></main>
</body></html>`,
    })
    const result = await provider.fetch({ url: 'https://example.com/blog-about-waiting' })
    expect(result.statusCode).toBe(200)
    expect(bodyOf(result)).toContain('Not a challenge')
    expect(counters(provider).gotos).toBe(1)
  })

  it('A10 chained rounds: a clear that lands on another interstitial consumes a retry and still lands the article', async () => {
    // Round 1 "clears" into a second interstitial (JS test → Turnstile
    // interstitial chains); the settled-DOM recheck catches it, the
    // same-page retry (with its earned cookies) then gets the document.
    const provider = new FakeProvider({ challengeWaitMs: 3_000, challengeRetries: 1 }, {
      clearAfterProbes: 2,
      gotoScript: [
        { challenge: true, html: CHALLENGE_HTML }, // after the probe clears, the DOM still shows a challenge
        { status: 200 },
      ],
    })
    const result = await provider.fetch({ url: 'https://example.com/chained' })
    expect(result.statusCode).toBe(200)
    expect(bodyOf(result)).toContain('World')
    expect(counters(provider).gotos).toBe(2)
  })
})
