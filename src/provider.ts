/**
 * The Playwright `WebFetchProvider`: renders one URL in a real browser and
 * returns it as markdown (denoised) or HTML. Mirrors `dsh-web-fetch-http`'s
 * error taxonomy (URL hygiene, abort/timeout translation, content-type
 * classification) so the tool layer sees the same codes from either backend.
 *
 * Lifecycle: the local backend launches a browser per fetch and closes it —
 * nothing outlives the call. The CDP backend keeps ONE shared connection to
 * the remote browser for the provider's lifetime; each fetch only opens a
 * page (tab) inside it and closes that on completion — in a throwaway
 * isolated context, or (the default, `shareBrowserContext`) in the remote
 * browser's default context so its profile, cookies, and persistent logins
 * apply; that default context is never closed. The concurrency cap counts
 * tabs, not browsers. Either way, an aborted signal closes the fetch's page.
 * Concurrency is capped at the `maxConcurrency` setting (explicit, or the
 * backend default — {@link DEFAULT_MAX_CONCURRENCY_LOCAL} browsers /
 * {@link DEFAULT_MAX_CONCURRENCY_CDP} tabs); further fetches wait briefly in
 * a queue and fail fast (rather than hang until abort) when no slot frees.
 *
 * Private-network and SSRF protection is not implemented (same stance as the
 * shipped HTTP provider); a page this provider can reach is whatever the
 * browser can reach. Profile mode additionally acts WITH the remote
 * browser's logged-in sessions (see the README's risk notes).
 *
 * @module dsh-web-fetch-playwright/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { DEFAULT_MAX_CONCURRENCY_CDP, DEFAULT_MAX_CONCURRENCY_LOCAL, effectiveContextMode, effectiveMaxConcurrency, normalizeCdpEndpoint } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { CdpConnectionPool } from './cdp-pool.ts'
import { htmlToMarkdown } from './markdown.ts'
import { resolveCdpBackend, resolvePlaywrightBackend } from './playwright-resolve.ts'
import type { PlaywrightBrowser, PlaywrightContext, PlaywrightPage, PlaywrightRoute } from './types.ts'

/** Stable id this provider registers under (the bundle patch pins it). */
export const PLAYWRIGHT_FETCH_PROVIDER_ID = 'playwright'

/** Maximum accepted request URL length (http-provider parity). */
const MAX_URL_LENGTH = 2048

/** Cap on the decoded markdown/HTML body this provider returns. */
const MAX_BODY_CHARS = 100_000

/** Cap on rendered HTML fed into the synchronous denoise pipeline. */
const MAX_PIPELINE_INPUT_CHARS = 2_000_000

/**
 * How long a fetch may sit in the concurrency queue before failing fast.
 * Waiting longer cannot help — the per-fetch deadline leaves too little
 * budget to render after dequeue — and failing fast tells the caller to
 * retry or raise `maxConcurrency` instead of hanging until an abort.
 */
const QUEUE_TIMEOUT_MS = 20_000

/** Default per-fetch budget (ms), inside the tool layer's 60s. */
const DEFAULT_TIMEOUT_MS = 45_000

/** Best-effort post-DOM settle wait (ms) so SPA content can finish rendering. */
const SETTLE_MS = 5_000

/**
 * Grace period (ms) for context/browser closes in the cleanup path. A wedged
 * `close()` must never hold a concurrency slot hostage — a leaked slot would
 * fail every later fetch with the queue error until restart.
 */
const CLOSE_GRACE_MS = 2_000

/**
 * One render session: a browser, the context this fetch works in, and the
 * tab it owns. Local backends own the browser too; CDP sessions ride the
 * shared connection, and in `profile` mode the context is the remote
 * browser's default context — shared, never closed, only the tab is.
 */
export interface BrowserSession {
  browser: PlaywrightBrowser
  context: PlaywrightContext
  /** The fetch-owned tab this fetch renders in. */
  page: PlaywrightPage
  /** True when `browser` is the CDP pool's shared connection — never closed per fetch. */
  sharedBrowser?: boolean
  /** True when `context` is the remote default context — close only the page. */
  persistent?: boolean
}

/**
 * A single abort deadline composing the caller's signal with this provider's
 * time budget. The timeout reason is kept apart from an outer abort so the
 * error translation can pick `WEB_FETCH_TIMEOUT` over `WEB_ABORTED`.
 */
class Deadline {
  readonly signal: AbortSignal
  private readonly controller = new AbortController()
  private readonly expiresAt: number
  private timedOut = false

  constructor(outer: AbortSignal | undefined, timeoutMs: number) {
    this.signal = this.controller.signal
    this.expiresAt = Date.now() + timeoutMs
    const timer = setTimeout(() => {
      this.timedOut = true
      this.controller.abort(new Error('playwright fetch deadline'))
    }, timeoutMs)
    if (outer !== undefined) {
      if (outer.aborted) this.controller.abort(outer.reason)
      else outer.addEventListener('abort', () => { this.controller.abort(outer.reason) }, { once: true })
    }
    this.signal.addEventListener('abort', () => { clearTimeout(timer) }, { once: true })
  }

  /** Whether OUR timer fired (vs an outer cancellation). */
  get isTimeout(): boolean {
    return this.timedOut
  }

  /** Milliseconds left on the budget, floored at 1 for Playwright options. */
  remainingMs(): number {
    return Math.max(1, this.expiresAt - Date.now())
  }
}

/**
 * A bounded async semaphore with abort support. The limit is live-resizable
 * (`resize`) because the config thunk re-reads on every fetch — raising it
 * wakes queued waiters immediately; lowering it lets in-flight holders run
 * out naturally.
 */
class Semaphore {
  private active = 0
  private limit: number
  private readonly queue: Array<{ start: () => void; fail: (error: WebError) => void }> = []

  /** @param limit - how many holders may run at once. */
  constructor(limit: number) {
    this.limit = limit
  }

  /** Apply a new limit, starting queued waiters for any capacity it opens. */
  resize(limit: number): void {
    this.limit = limit
    this.drain()
  }

  /**
   * Take a slot, or queue until one frees. A queued fetch fails fast on the
   * caller's abort signal or after `queueTimeoutMs` without a slot — the
   * queue wait must not eat the whole fetch budget only to die mid-render.
   */
  acquire(signal: AbortSignal, queueTimeoutMs: number): Promise<void> {
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      const waiter = {
        start: () => {
          cleanup()
          this.active++
          resolve()
        },
        fail: (error: WebError) => {
          const index = this.queue.indexOf(waiter)
          if (index !== -1) this.queue.splice(index, 1)
          cleanup()
          reject(error)
        },
      }
      const timer = setTimeout(() => {
        waiter.fail(new WebError(
          `all ${String(this.limit)} rendering slots stayed busy for ${String(queueTimeoutMs)}ms; retry shortly, or raise the maxConcurrency setting`,
          'WEB_FETCH_TIMEOUT',
        ))
      }, queueTimeoutMs)
      const onAbort = () => {
        waiter.fail(new WebError('web fetch aborted while waiting for a free rendering slot', 'WEB_ABORTED'))
      }
      this.queue.push(waiter)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  release(): void {
    // Below the limit a freed slot hands straight to the next waiter; above
    // it (the limit was lowered) the slot disappears instead.
    const next = this.active <= this.limit ? this.queue.shift() : undefined
    if (next === undefined) {
      this.active = Math.max(0, this.active - 1)
      return
    }
    next.start()
  }

  private drain(): void {
    while (this.active < this.limit) {
      const next = this.queue.shift()
      if (next === undefined) return
      next.start()
    }
  }
}

/** Validate a request URL: http(s) only, no embedded credentials, bounded. */
function validateFetchUrl(input: string): URL {
  if (input.length > MAX_URL_LENGTH) {
    throw new WebError(`URL exceeds the maximum length of ${String(MAX_URL_LENGTH)}`, 'WEB_INVALID_URL')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch (error: unknown) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

/** The decodable body kinds, mirroring the HTTP provider's classification. */
type FetchableKind = 'html' | 'text'

/** Classify a `Content-Type` into a decodable kind; undefined = unsupported. */
function classifyContentType(contentType: string | undefined): FetchableKind | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === '' || mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

/** Translate a thrown pipeline error into the seam's WebError taxonomy. */
function translateError(error: unknown, deadline: Deadline): WebError {
  if (deadline.isTimeout) return new WebError('playwright web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: error })
  if (deadline.signal.aborted) {
    // An outer cancellation of a queued fetch already carries the precise
    // "waiting for a free rendering slot" message — keep it over the generic abort.
    if (error instanceof WebError) return error
    return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  }
  if (error instanceof WebError) return error
  return new WebError(`playwright web fetch failed: ${String(error instanceof Error ? error.message : error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

/**
 * The Playwright-backed fetch provider. Configuration is read through a thunk
 * so committed settings-section changes apply to the next fetch with no
 * re-registration.
 */
export class PlaywrightFetchProvider implements WebFetchProvider {
  readonly id = PLAYWRIGHT_FETCH_PROVIDER_ID

  private readonly semaphore = new Semaphore(DEFAULT_MAX_CONCURRENCY_LOCAL)

  /** Shared CDP connection; injectable so the suite can substitute a fake. */
  protected readonly cdpPool: CdpConnectionPool

  /**
   * @param configSource - thunk returning the currently authoritative config.
   * @param cdpPool - optional pool over the CDP backend (tests inject fakes).
   */
  constructor(private readonly configSource: () => ResolvedConfig, cdpPool?: CdpConnectionPool) {
    this.cdpPool = cdpPool ?? new CdpConnectionPool(defaultCdpConnect)
  }

  /** Cheap and side-effect free; backend problems surface per fetch instead. */
  available(): boolean {
    return true
  }

  /**
   * Drop the shared CDP connection (plugin teardown). Local browsers need
   * nothing — they never outlive their fetch. In-flight CDP fetches keep
   * their leases and close them when they finish.
   */
  async dispose(): Promise<void> {
    await this.cdpPool.dispose()
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    const config = this.configSource()
    const url = validateFetchUrl(request.url)
    const deadline = new Deadline(signal, DEFAULT_TIMEOUT_MS)

    let session: BrowserSession | undefined
    let acquired = false
    try {
      // The live config decides the limit per fetch (explicit setting, else
      // the backend default); raising it immediately starts queued waiters.
      this.semaphore.resize(effectiveMaxConcurrency(config))
      await this.semaphore.acquire(deadline.signal, QUEUE_TIMEOUT_MS)
      acquired = true
      session = await this.openSession(config, deadline)
      // An aborted deadline must also interrupt Playwright's own waits:
      // closing the page rejects every pending operation on it (and, for
      // fetch-owned contexts, the context close that follows takes the rest).
      const held = session
      const onAbort = () => { void closeSession(held) }
      deadline.signal.addEventListener('abort', onAbort, { once: true })
      try {
        return await this.retrieve(session, url, config, deadline)
      } finally {
        deadline.signal.removeEventListener('abort', onAbort)
      }
    } catch (error: unknown) {
      throw translateError(error, deadline)
    } finally {
      // Local launches exit; CDP connections merely disconnect. Both closes
      // are grace-bounded so a wedged browser can never pin a concurrency slot.
      await closeSession(session)
      // Only a slot actually taken is given back — a queued fetch that failed
      // to acquire must not hand a phantom slot to the next waiter.
      if (acquired) this.semaphore.release()
    }
  }

  /**
   * Open the configured backend and its per-fetch page. Split out so the
   * test suite can substitute a fake browser.
   * @param config - the resolved settings section.
   * @param deadline - the fetch budget, applied to launch/connect timeouts.
   * @returns the browser session the fetch will use.
   */
  protected async openSession(config: ResolvedConfig, deadline: Deadline): Promise<BrowserSession> {
    const timeout = Math.min(deadline.remainingMs(), 20_000)
    if (config.backend === 'cdp') {
      const endpoint = normalizeCdpEndpoint(config.cdpEndpoint)
      const { source } = await resolveCdpBackend()
      try {
        // One shared connection per provider; this fetch leases a tab — in a
        // throwaway isolated context, or in the remote profile's default
        // context (profile mode), whose persistent logins then apply.
        const lease = await this.cdpPool.acquire(endpoint, timeout, effectiveContextMode(config))
        await installResourceFilter(lease.page)
        guardPopups(lease.page)
        return {
          browser: lease.browser,
          context: lease.context,
          page: lease.page,
          sharedBrowser: true,
          persistent: lease.persistent,
        }
      } catch (error: unknown) {
        throw new WebError(
          `cannot connect to the CDP endpoint ${endpoint} (${source}); is the browser started with --remote-debugging-port? ${String(error instanceof Error ? error.message : error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
    }
    const { chromium, executablePath, source } = await resolvePlaywrightBackend(config.playwrightPath)
    let browser: PlaywrightBrowser | undefined
    try {
      browser = await chromium.launch({ headless: true, ...(executablePath !== undefined ? { executablePath } : {}), timeout })
      const context = await browser.newContext()
      const page = await context.newPage()
      await installResourceFilter(page)
      guardPopups(page)
      return { browser, context, page }
    } catch (error: unknown) {
      // A partial setup (browser launched, then newContext/newPage failed)
      // must not strand the process — closing the browser takes its
      // contexts and pages with it.
      await browser?.close().catch(() => {})
      throw new WebError(
        `cannot launch the local browser (${source}); run \`playwright install chromium\` or point the settings path at a playwright/browser executable. ${String(error instanceof Error ? error.message : error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }

  /** Navigate, settle, and decode one URL inside an open session's tab. */
  private async retrieve(
    session: BrowserSession,
    url: URL,
    config: ResolvedConfig,
    deadline: Deadline,
  ): Promise<WebFetchResult> {
    const page = session.page
    const response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: deadline.remainingMs() })

    const kind = classifyContentType(response?.headers()['content-type'])
    if (kind === undefined) {
      throw new WebError(`unsupported content type "${response?.headers()['content-type'] ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }
    const finalUrl = page.url()

    // Non-HTML decodes straight from the response body; no denoise applies.
    if (kind === 'text') {
      const text = response !== null ? await response.text() : await page.content()
      return capResult(finalUrl, response?.status() ?? 200, { kind: 'text', content: text })
    }

    // Best-effort settle for client-rendered content; a timeout just keeps
    // what domcontentloaded already produced.
    await page.waitForLoadState('networkidle', { timeout: Math.min(SETTLE_MS, deadline.remainingMs()) }).catch(() => {})

    const html = await page.content()
    if (!config.denoise) {
      // The tool layer's own turndown renders raw HTML; the checkbox only
      // governs the Readability/DOMPurify stage this provider owns.
      return capResult(finalUrl, response?.status() ?? 200, { kind: 'html', content: html })
    }
    const bounded = html.length > MAX_PIPELINE_INPUT_CHARS ? html.slice(0, MAX_PIPELINE_INPUT_CHARS) : html
    const { markdown } = htmlToMarkdown(bounded, finalUrl)
    const result = capResult(finalUrl, response?.status() ?? 200, { kind: 'text', content: markdown })
    return bounded !== html
      ? { ...result, truncated: true }
      : result
  }
}

/** Apply the decoded-body cap and flag the cut. */
function capResult(url: string, statusCode: number, body: { kind: 'html' | 'text'; content: string }): WebFetchResult {
  const truncated = body.content.length > MAX_BODY_CHARS
  return {
    url,
    statusCode,
    body: { kind: body.kind, content: truncated ? body.content.slice(0, MAX_BODY_CHARS) : body.content },
    truncated,
  }
}

/**
 * Close a session's fetch-owned tab, then its context unless the context is
 * the remote default context (profile mode — closing it would tear down the
 * whole shared connection), then its browser when the session launched one
 * (local backend). CDP sessions ride the shared connection, which stays
 * open. Every close is grace-bounded so cleanup always completes and the
 * concurrency slot is released even when Playwright hangs.
 */
async function closeSession(session: BrowserSession | undefined): Promise<void> {
  if (session === undefined) return
  await closeWithGrace(session.page)
  if (session.persistent !== true) await closeWithGrace(session.context)
  if (session.sharedBrowser !== true) await closeWithGrace(session.browser)
}

/** One best-effort `close()` that resolves within the grace period. */
async function closeWithGrace(closeable: { close(): Promise<void> }): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, CLOSE_GRACE_MS)
    void closeable.close().then(
      () => { clearTimeout(timer); resolve() },
      () => { clearTimeout(timer); resolve() },
    )
  })
}

/**
 * The real CDP connect the pool runs with: the bundled playwright-core's
 * `connectOverCDP`. Kept as a function (not inline) so the pool constructor
 * stays injectable for tests.
 */
async function defaultCdpConnect(endpoint: string, timeoutMs: number): Promise<PlaywrightBrowser> {
  const { chromium } = await resolveCdpBackend()
  return await chromium.connectOverCDP(endpoint, { timeout: timeoutMs })
}

/**
 * Abort image/font/media subrequests: the markdown output keeps their URLs
 * but never renders them, so downloading them only spends the budget.
 * Installed on the PAGE (never the context): in profile mode a context-level
 * route would intercept the remote browser's other tabs too. Best-effort —
 * a page that refuses interception still fetches.
 */
async function installResourceFilter(owner: {
  route(glob: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>
}): Promise<void> {
  try {
    await owner.route('**/*', async (route) => {
      const type = route.request().resourceType()
      if (type === 'image' || type === 'font' || type === 'media') await route.abort()
      else await route.continue()
    })
  } catch {
    // keep going without the filter
  }
}

/**
 * Close any popup a fetched page spawns so nothing outlives the fetch's tab
 * — `page.close()` does not auto-close windows the page opened, and in
 * profile mode a stray tab would stay in the user's remote browser.
 * Best-effort: a page that refuses listeners just loses the guard.
 */
function guardPopups(page: PlaywrightPage): void {
  try {
    page.on?.('popup', popup => { void popup.close().catch(() => {}) })
  } catch {
    // keep going without the guard
  }
}
