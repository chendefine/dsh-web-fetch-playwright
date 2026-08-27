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
 * Cloudflare challenges (issue #2): when a navigation lands on a challenge
 * interstitial, the fetch waits — on the SAME page and in the SAME browser
 * context, so the browser's natural verification and any clearance cookies
 * it earns apply — for a bounded, configurable window
 * (`challengeWaitMs`, default 15s; 0 restores the legacy first-response
 * behavior). The wait tracks the LAST main-frame navigation response (the
 * real page reloads in after the challenge clears) and watches the live DOM
 * so SPA-style clears are caught too. It never clicks, never injects
 * answers, never touches cookies itself; when the budget runs out the fetch
 * fails with {@link WEB_FETCH_CHALLENGE_CODE} instead of returning the
 * interstitial as content.
 *
 * @module dsh-web-fetch-playwright/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { CHALLENGE_DOM_PROBE, CHALLENGE_FINISH_RESERVE_MS, CHALLENGE_POLL_INTERVAL_MS, classifyChallengeHtml, classifyChallengeResponse, isChallengeCompatibleResponse } from './challenge.ts'
import type { ChallengeVerdict } from './challenge.ts'
import { DEFAULT_MAX_CONCURRENCY_CDP, DEFAULT_MAX_CONCURRENCY_LOCAL, effectiveChallengeRetries, effectiveChallengeWaitMs, effectiveContextMode, effectiveMaxConcurrency, normalizeCdpEndpoint } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { CdpConnectionPool } from './cdp-pool.ts'
import { htmlToMarkdown } from './markdown.ts'
import { resolveCdpBackend, resolvePlaywrightBackend } from './playwright-resolve.ts'
import type { PlaywrightBrowser, PlaywrightContext, PlaywrightPage, PlaywrightResponse, PlaywrightRoute } from './types.ts'

/** Stable id this provider registers under (the bundle patch pins it). */
export const PLAYWRIGHT_FETCH_PROVIDER_ID = 'playwright'

/**
 * Error code for a Cloudflare challenge the bounded natural wait could not
 * clear. Provider-specific by design — the web seam's `code` is an open
 * string and consumers must tolerate provider-specific codes — so callers
 * can tell "the site challenged us and the browser did not pass" apart from
 * a transport timeout or a provider bug.
 */
export const WEB_FETCH_CHALLENGE_CODE = 'WEB_FETCH_CHALLENGE'

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

  /**
   * Navigate, settle, and decode one URL inside an open session's tab —
   * waiting out any Cloudflare interstitial within the bounded challenge
   * budget before the final document is read (see the class docs).
   */
  private async retrieve(
    session: BrowserSession,
    url: URL,
    config: ResolvedConfig,
    deadline: Deadline,
  ): Promise<WebFetchResult> {
    const page = session.page
    const challengeWaitMs = effectiveChallengeWaitMs(config)
    // Feature switch: 0 keeps the exact legacy (pre-0.2.5) behavior — the
    // first response decides, no waiting — an escape hatch and the A/B
    // baseline every test proves the bug against.
    const tracker = challengeWaitMs > 0 ? trackMainFrameResponses(page) : undefined
    let response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: deadline.remainingMs() })
    tracker?.seed(response)

    let challengeEntryResponse: PlaywrightResponse | null = null
    if (challengeWaitMs > 0) {
      let attemptsLeft = effectiveChallengeRetries(config) + 1
      for (;;) {
        const verdict = await this.verdictAfterLoad(page, tracker?.last() ?? response)
        if (verdict === 'blocked') {
          throw new WebError(
            `the site hard-blocked this fetch at its Cloudflare edge (waiting cannot clear it): ${page.url()}`,
            WEB_FETCH_CHALLENGE_CODE,
          )
        }
        if (verdict !== 'challenge') break
        challengeEntryResponse = tracker?.last() ?? response
        const cleared = await this.waitForChallengeClear(page, deadline, challengeWaitMs)
        if (cleared) {
          // The settled document may be the next round of a CHAINED
          // challenge (JS test → Turnstile interstitial): the probe can
          // clear in the gap between rounds, so confirm on the settled
          // DOM. Deliberately content-level — an SPA clear keeps the 403
          // challenge response forever and must still pass here.
          let chained = false
          try { chained = classifyChallengeHtml(await page.content()) === 'challenge' } catch { chained = false }
          if (!chained) break
        }
        if (--attemptsLeft <= 0) {
          const lastStatus = (tracker?.last() ?? response)?.status()
          throw new WebError(
            `the site kept serving a Cloudflare challenge (last status ${lastStatus === undefined ? 'unknown' : String(lastStatus)}) for up to ${String(challengeWaitMs)}ms across ${String(effectiveChallengeRetries(config) + 1)} attempt(s); the browser did not clear it naturally — retry later, raise challengeWaitMs, or use a profile whose browser already holds clearance`,
            WEB_FETCH_CHALLENGE_CODE,
          )
        }
        // Same page, same context — after an expired window OR a chained
        // round: any clearance cookies already earned stay in the jar for
        // this one retry, then everything is torn down as usual.
        response = await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: deadline.remainingMs() })
        tracker?.seed(response)
      }
    }

    // Final document: the LAST main-frame response when the challenge wait
    // ran (the real page reloads in), else the response goto returned.
    const finalResponse = (challengeWaitMs > 0 ? tracker?.last() : undefined) ?? response
    const kind = classifyContentType(finalResponse?.headers()['content-type'])
    if (kind === undefined) {
      throw new WebError(`unsupported content type "${finalResponse?.headers()['content-type'] ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }
    const finalUrl = page.url()
    // An SPA-style clear swaps the document without navigating: no new
    // response exists to report, so the cleared document reads as served.
    const clearedWithoutNavigation = challengeEntryResponse !== null && finalResponse === challengeEntryResponse
    const statusCode = finalResponse !== null && !clearedWithoutNavigation ? finalResponse.status() : 200

    // Non-HTML decodes straight from the response body; no denoise applies.
    if (kind === 'text') {
      const text = finalResponse !== null ? await finalResponse.text() : await page.content()
      return capResult(finalUrl, statusCode, { kind: 'text', content: text })
    }

    // Best-effort settle for client-rendered content; a timeout just keeps
    // what domcontentloaded already produced.
    await page.waitForLoadState('networkidle', { timeout: Math.min(SETTLE_MS, deadline.remainingMs()) }).catch(() => {})

    const html = await page.content()
    if (!config.denoise) {
      // The tool layer's own turndown renders raw HTML; the checkbox only
      // governs the Readability/DOMPurify stage this provider owns.
      return capResult(finalUrl, statusCode, { kind: 'html', content: html })
    }
    const bounded = html.length > MAX_PIPELINE_INPUT_CHARS ? html.slice(0, MAX_PIPELINE_INPUT_CHARS) : html
    const { markdown } = htmlToMarkdown(bounded, finalUrl)
    const result = capResult(finalUrl, statusCode, { kind: 'text', content: markdown })
    return bounded !== html
      ? { ...result, truncated: true }
      : result
  }

  /**
   * Whether the freshly loaded document is a Cloudflare interstitial: the
   * response-level signals first (the documented `cf-mitigated` header, then
   * the 403/503 + cloudflare fallback), then — gated behind
   * {@link isChallengeCompatibleResponse}, because interstitials never ship
   * a plain 200 — the localized title family and structural markers, which
   * also recognize the hard-block page waiting can never clear.
   */
  private async verdictAfterLoad(page: PlaywrightPage, response: PlaywrightResponse | null): Promise<ChallengeVerdict> {
    if (response !== null && classifyChallengeResponse(response.status(), response.headers()) === 'challenge') return 'challenge'
    // Suspicion gate: the content-level fallback only runs on a
    // challenge-compatible response, so a normal article cannot be misread
    // as a challenge no matter what it quotes. A response-less navigation
    // keeps the check — its headers are simply unavailable.
    if (response !== null && !isChallengeCompatibleResponse(response.status(), response.headers())) return 'none'
    // Only HTML documents can be interstitials; classifyContentType already
    // reads a missing content type as html (a response-less navigation).
    if (response === null || classifyContentType(response.headers()['content-type']) === 'html') {
      try {
        return classifyChallengeHtml(await page.content())
      } catch {
        return 'none' // a document we cannot read is not a challenge we can wait on
      }
    }
    return 'none'
  }

  /**
   * The bounded natural wait: poll the live document for challenge markers
   * until they are gone (the user's real browser passed the verification and
   * reloaded into the real page, or swapped it in SPA-style), the per-fetch
   * wait budget runs out, or the fetch's deadline aborts. No clicks, no
   * injected answers — the browser either clears it on its own or it does not.
   *
   * @returns true when the challenge cleared; false when the budget ran out.
   */
  private async waitForChallengeClear(page: PlaywrightPage, deadline: Deadline, challengeWaitMs: number): Promise<boolean> {
    // Keep the settle + decode tail inside the fetch budget: never spend the
    // whole deadline waiting only to time out reading the cleared page.
    const budget = Math.min(challengeWaitMs, deadline.remainingMs() - CHALLENGE_FINISH_RESERVE_MS)
    if (budget <= 0) return false
    const until = Date.now() + budget
    for (;;) {
      if (deadline.signal.aborted) throw new Error('challenge wait aborted')
      if (await probeStillOnChallenge(page)) {
        const remaining = until - Date.now()
        if (remaining <= 0) return false
        await sleep(Math.min(CHALLENGE_POLL_INTERVAL_MS, remaining))
        continue
      }
      // Markers gone: let the fresh document reach domcontentloaded before
      // the caller reads it (the reload may still be committing).
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(deadline.remainingMs(), 2_000) }).catch(() => {})
      return true
    }
  }
}

/** Resolve after `ms` — the bounded wait's inter-poll nap. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/**
 * Whether a response event belongs to the page's main frame as a document
 * navigation — the filter the challenge wait uses to keep the LAST such
 * response (challenge pages reload the same URL into the real document).
 * Structural members are optional; when the backend does not expose them the
 * check degrades to "looks like a document" so fakes stay usable.
 */
function isMainFrameDocument(response: PlaywrightResponse, page: PlaywrightPage): boolean {
  const request = response.request?.()
  if (request === undefined) return true
  if (typeof request.isNavigationRequest === 'function' && !request.isNavigationRequest()) return false
  const resourceType = typeof request.resourceType === 'function' ? request.resourceType() : undefined
  if (resourceType !== undefined && resourceType !== 'document') return false
  if (typeof request.frame === 'function' && typeof page.mainFrame === 'function') {
    return request.frame() === page.mainFrame()
  }
  return true
}

/** The running record of the last main-frame navigation response. */
interface MainFrameTracker {
  /** The most recent main-frame navigation response seen, if any. */
  last(): PlaywrightResponse | null
  /** Pin the tracker to a goto's return (it is that navigation's response). */
  seed(response: PlaywrightResponse | null): void
}

/**
 * Watch the page for main-frame navigation responses so a challenge that
 * reloads into the real document hands the caller THAT response — status,
 * headers — instead of the challenge's. Best-effort: a page without the
 * listener falls back to SPA-style content polling only.
 */
function trackMainFrameResponses(page: PlaywrightPage): MainFrameTracker {
  let last: PlaywrightResponse | null = null
  try {
    page.on?.('response', (response) => {
      if (isMainFrameDocument(response, page)) last = response
    })
  } catch {
    // keep going without response tracking
  }
  return {
    last: () => last,
    seed: (response) => { if (response !== null) last = response },
  }
}

/**
 * Probe the live document for challenge markers. Prefers the in-page probe
 * (`page.evaluate`) — the only thing that can see SPA-style clears — and
 * falls back to reading and classifying the serialized HTML when the backend
 * does not expose evaluate. A probe that throws mid-navigation (execution
 * context destroyed while the challenge reloads) counts as "still on the
 * challenge": the next poll sees the fresh document.
 */
async function probeStillOnChallenge(page: PlaywrightPage): Promise<boolean> {
  if (typeof page.evaluate === 'function') {
    try {
      const verdict = await page.evaluate(CHALLENGE_DOM_PROBE)
      if (typeof verdict === 'boolean') return verdict
    } catch {
      // fall through to the content check
    }
  }
  try {
    return classifyChallengeHtml(await page.content()) !== 'none'
  } catch {
    return true
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
