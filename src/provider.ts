/**
 * The Playwright `WebFetchProvider`: renders one URL in a real browser and
 * returns it as markdown (denoised) or HTML. Mirrors `dsh-web-fetch-http`'s
 * error taxonomy (URL hygiene, abort/timeout translation, content-type
 * classification) so the tool layer sees the same codes from either backend.
 *
 * Lifecycle is per-fetch and fully reversible: local launches close their
 * browser, CDP connections disconnect, and an aborted signal closes both —
 * no browser outlives the call that opened it. Concurrency is capped at
 * {@link MAX_CONCURRENT_FETCHES} local browsers.
 *
 * Private-network and SSRF protection is not implemented (same stance as the
 * shipped HTTP provider); a page this provider can reach is whatever the
 * browser can reach.
 *
 * @module dsh-web-fetch-playwright/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { normalizeCdpEndpoint } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { htmlToMarkdown } from './markdown.ts'
import { resolveCdpBackend, resolvePlaywrightBackend } from './playwright-resolve.ts'
import type { PlaywrightBrowser, PlaywrightContext } from './types.ts'

/** Stable id this provider registers under (the bundle patch pins it). */
export const PLAYWRIGHT_FETCH_PROVIDER_ID = 'playwright'

/** Maximum accepted request URL length (http-provider parity). */
const MAX_URL_LENGTH = 2048

/** Cap on the decoded markdown/HTML body this provider returns. */
const MAX_BODY_CHARS = 100_000

/** Cap on rendered HTML fed into the synchronous denoise pipeline. */
const MAX_PIPELINE_INPUT_CHARS = 2_000_000

/** How many browsers may render at once; further fetches queue. */
const MAX_CONCURRENT_FETCHES = 2

/** Default per-fetch budget (ms), inside the tool layer's 60s. */
const DEFAULT_TIMEOUT_MS = 45_000

/** Best-effort post-DOM settle wait (ms) so SPA content can finish rendering. */
const SETTLE_MS = 5_000

/** One open browser plus its per-fetch context, closed together. */
export interface BrowserSession {
  browser: PlaywrightBrowser
  context: PlaywrightContext
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

/** A cap-{@link MAX_CONCURRENT_FETCHES} async semaphore with abort support. */
class Semaphore {
  private active = 0
  private readonly queue: Array<{ start: () => void; abort: () => void }> = []

  /** Take a slot, or queue until one frees; an aborted signal rejects the wait. */

  acquire(signal: AbortSignal): Promise<void> {
    if (this.active < MAX_CONCURRENT_FETCHES) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        start: () => {
          signal.removeEventListener('abort', waiter.abort)
          this.active++
          resolve()
        },
        abort: () => {
          const index = this.queue.indexOf(waiter)
          if (index !== -1) this.queue.splice(index, 1)
          reject(new WebError('web fetch aborted while waiting for a free browser slot', 'WEB_ABORTED'))
        },
      }
      this.queue.push(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
    })
  }

  release(): void {
    const next = this.queue.shift()
    if (next === undefined) {
      this.active = Math.max(0, this.active - 1)
      return
    }
    next.start()
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
  if (deadline.signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
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

  private readonly semaphore = new Semaphore()

  /**
   * @param configSource - thunk returning the currently authoritative config.
   */
  constructor(private readonly configSource: () => ResolvedConfig) {}

  /** Cheap and side-effect free; backend problems surface per fetch instead. */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    const config = this.configSource()
    const url = validateFetchUrl(request.url)
    const deadline = new Deadline(signal, DEFAULT_TIMEOUT_MS)

    await this.semaphore.acquire(deadline.signal)
    let session: BrowserSession | undefined
    try {
      session = await this.openSession(config, deadline)
      // An aborted deadline must also interrupt Playwright's own waits:
      // closing the context rejects every pending page operation.
      const onAbort = () => {
        void session?.context.close().catch(() => {})
        void session?.browser.close().catch(() => {})
      }
      deadline.signal.addEventListener('abort', onAbort, { once: true })
      try {
        return await this.retrieve(session, url, config, deadline)
      } finally {
        deadline.signal.removeEventListener('abort', onAbort)
      }
    } catch (error: unknown) {
      throw translateError(error, deadline)
    } finally {
      // Local launches exit; CDP connections merely disconnect.
      await session?.context.close().catch(() => {})
      await session?.browser.close().catch(() => {})
      this.semaphore.release()
    }
  }

  /**
   * Open the configured backend and its per-fetch context. Split out so the
   * test suite can substitute a fake browser.
   * @param config - the resolved settings section.
   * @param deadline - the fetch budget, applied to launch/connect timeouts.
   * @returns the browser session the fetch will use.
   */
  protected async openSession(config: ResolvedConfig, deadline: Deadline): Promise<BrowserSession> {
    const timeout = Math.min(deadline.remainingMs(), 20_000)
    if (config.backend === 'cdp') {
      const endpoint = normalizeCdpEndpoint(config.cdpEndpoint)
      const { chromium, source } = await resolveCdpBackend()
      try {
        const browser = await chromium.connectOverCDP(endpoint, { timeout })
        const context = await browser.newContext()
        await installResourceFilter(context)
        return { browser, context }
      } catch (error: unknown) {
        throw new WebError(
          `cannot connect to the CDP endpoint ${endpoint} (${source}); is the browser started with --remote-debugging-port? ${String(error instanceof Error ? error.message : error)}`,
          'WEB_PROVIDER_ERROR',
          { cause: error },
        )
      }
    }
    const { chromium, executablePath, source } = await resolvePlaywrightBackend(config.playwrightPath)
    try {
      const browser = await chromium.launch({ headless: true, ...(executablePath !== undefined ? { executablePath } : {}), timeout })
      const context = await browser.newContext()
      await installResourceFilter(context)
      return { browser, context }
    } catch (error: unknown) {
      throw new WebError(
        `cannot launch the local browser (${source}); run \`playwright install chromium\` or point the settings path at a playwright/browser executable. ${String(error instanceof Error ? error.message : error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
  }

  /** Navigate, settle, and decode one URL inside an open session. */
  private async retrieve(
    session: BrowserSession,
    url: URL,
    config: ResolvedConfig,
    deadline: Deadline,
  ): Promise<WebFetchResult> {
    const page = await session.context.newPage()
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
 * Abort image/font/media subrequests: the markdown output keeps their URLs
 * but never renders them, so downloading them only spends the budget.
 * Best-effort — a context that refuses interception still fetches.
 */
async function installResourceFilter(context: PlaywrightContext): Promise<void> {
  try {
    await context.route('**/*', async (route) => {
      const type = route.request().resourceType()
      if (type === 'image' || type === 'font' || type === 'media') await route.abort()
      else await route.continue()
    })
  } catch {
    // keep going without the filter
  }
}
