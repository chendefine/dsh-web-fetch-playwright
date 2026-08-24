/**
 * The CDP backend's shared connection: one `connectOverCDP` session reused by
 * every fetch, each fetch leasing a page (a tab in the remote browser) that
 * it closes when done — in an isolated throwaway context (`isolated` mode),
 * or in the remote browser's default context (`profile` mode, whose cookies
 * and localStorage are the real profile's, so its persistent logins apply;
 * that context is never closed, only the tab is). The connection itself
 * outlives fetches — reconnecting per fetch would spend 100–500ms per call
 * and open one socket per concurrent tab for no benefit.
 *
 * Liveness is handled three ways: `isConnected()` is checked before reuse, a
 * `disconnected` event (when the backend emits it) drops the reference
 * immediately, and an open-lease failure against a dead connection triggers
 * exactly one reconnect-and-retry before the error surfaces. A changed
 * endpoint (settings edit) replaces the connection.
 *
 * @module dsh-web-fetch-playwright/cdp-pool
 */

import type { PlaywrightBrowser, PlaywrightContext, PlaywrightPage } from './types.ts'

/** Opens the shared connection; injected so tests can substitute a fake. */
export type CdpConnect = (endpoint: string, timeoutMs: number) => Promise<PlaywrightBrowser>

/** How a lease scopes its fetch: throwaway context or the remote profile. */
export type CdpAcquireMode = 'isolated' | 'profile'

/** One fetch's lease: the shared browser, a context, and the tab it owns. */
export interface CdpLease {
  /** The shared connection — close only what the lease owns, never this. */
  browser: PlaywrightBrowser
  /**
   * The context the page lives in: fetch-owned (`isolated`) or the remote
   * browser's default context (`profile`). NEVER close the latter — closing
   * it tears down the whole shared connection (playwright-core maps a
   * default-context close to "close browser" for this connection).
   */
  context: PlaywrightContext
  /** The fetch-owned tab; {@link CdpConnectionPool.release} always closes it. */
  page: PlaywrightPage
  /** True when `context` is the remote default context: release must not close it. */
  persistent: boolean
}

/** A reusable `connectOverCDP` session handing out per-fetch pages. */
export class CdpConnectionPool {
  private browser: PlaywrightBrowser | undefined
  private endpoint = ''
  private connecting: Promise<PlaywrightBrowser> | undefined
  private connectingEndpoint = ''
  /** Bumped by dispose/replace so a settling connect knows it was abandoned. */
  private generation = 0

  /**
   * @param connect - opens a connection to an endpoint (the provider's real
   * one resolves the bundled playwright-core; tests inject fakes).
   */
  constructor(private readonly connect: CdpConnect) {}

  /**
   * Lease a fetch's page on the shared connection, connecting (or
   * reconnecting) first if needed. Concurrent first fetches share one
   * connect attempt.
   *
   * @param endpoint - normalized CDP endpoint URL.
   * @param timeoutMs - connect timeout budget.
   * @param mode - `isolated` (default): a fresh throwaway context plus a page
   *   in it; `profile`: a page in the remote browser's default context — the
   *   real profile — which is never closed, only the page is.
   * @returns the shared browser, the page's context, and the page the caller
   *   must release.
   * @throws whatever the connect function throws when no connection can be
   *   established (the provider wraps it in a structured WebError), or a
   *   diagnostic error when `profile` mode finds no default context.
   */
  async acquire(endpoint: string, timeoutMs: number, mode: CdpAcquireMode = 'isolated'): Promise<CdpLease> {
    const browser = await this.ensure(endpoint, timeoutMs)
    try {
      return await this.openLease(browser, mode)
    } catch (error: unknown) {
      // The connection may have died between ensure() and opening the lease;
      // one fresh connection attempt, then the error propagates as-is.
      if (this.isLive(browser)) throw error
      this.drop(browser)
      const fresh = await this.ensure(endpoint, timeoutMs)
      return await this.openLease(fresh, mode)
    }
  }

  /**
   * Open one lease's page on a live connection. The profile-mode handle is
   * taken fresh every call (never cached across connections): a reconnect
   * yields a new Browser object whose `contexts()[0]` must be re-read.
   */
  private async openLease(browser: PlaywrightBrowser, mode: CdpAcquireMode): Promise<CdpLease> {
    if (mode === 'profile') {
      // [0] is the default context: playwright-core's BrowserDispatcher
      // always dispatches it first, and contexts created outside this
      // connection never appear here — so the pick is deterministic.
      const context = browser.contexts?.()[0]
      if (context === undefined) {
        throw new Error('the CDP endpoint exposed no default browser context (profile mode requires a real browser profile)')
      }
      // A failed newPage leaves nothing behind (the default context is not
      // ours to clean), so the acquire-level retry can simply try again.
      return { browser, context, page: await context.newPage(), persistent: true }
    }
    const context = await browser.newContext()
    try {
      return { browser, context, page: await context.newPage(), persistent: false }
    } catch (error: unknown) {
      // The context exists but its page does not: close it now, or a
      // transient newPage failure on a live connection strands the context
      // until the whole connection goes away.
      await context.close().catch(() => {})
      throw error
    }
  }

  /**
   * Close a fetch-owned page, plus its context when the lease owns one. The
   * remote default context (persistent leases) and the shared connection
   * stay for the next fetch.
   * @param lease - the lease whose page (and, when isolated, context) goes away.
   */
  async release(lease: CdpLease): Promise<void> {
    await lease.page.close().catch(() => {})
    if (!lease.persistent) await lease.context.close().catch(() => {})
  }

  /**
   * Drop the shared connection (plugin teardown or endpoint change). Fetches
   * holding leases keep their contexts until they release them. A connect
   * still in flight is abandoned — its own continuation closes the stray
   * browser (nothing here waits on it, so teardown cannot deadlock).
   */
  async dispose(): Promise<void> {
    const browser = this.browser
    this.browser = undefined
    this.endpoint = ''
    this.connecting = undefined
    this.connectingEndpoint = ''
    this.generation++
    await browser?.close().catch(() => {})
  }

  /** The shared connection for `endpoint`, connecting or reconnecting as needed. */
  private async ensure(endpoint: string, timeoutMs: number): Promise<PlaywrightBrowser> {
    if (this.browser !== undefined && this.endpoint === endpoint && this.isLive(this.browser)) return this.browser
    if (this.connecting !== undefined && this.connectingEndpoint === endpoint) return this.connecting
    // Dead connection or different endpoint: (re)connect. An in-flight connect
    // to another endpoint is abandoned by the generation bump below — its own
    // continuation closes the stray browser and rejects to its waiter.
    return await this.connectFresh(endpoint, timeoutMs)
  }

  /** Start a connection to `endpoint`, superseding whatever was there. */
  private connectFresh(endpoint: string, timeoutMs: number): Promise<PlaywrightBrowser> {
    const stale = this.browser
    this.browser = undefined
    this.endpoint = ''
    const generation = ++this.generation
    const attempt = (async () => {
      const browser = await this.connect(endpoint, timeoutMs)
      // A dispose/replace won the race while we were connecting: this
      // connection is unwanted — close it and surface the abandonment.
      if (generation !== this.generation) {
        await browser.close().catch(() => {})
        throw new Error('cdp connection abandoned before it attached')
      }
      this.browser = browser
      this.endpoint = endpoint
      this.watch(browser)
      return browser
    })()
    this.connecting = attempt
    this.connectingEndpoint = endpoint
    void attempt.then(
      () => { if (this.connecting === attempt) this.connecting = undefined },
      () => { if (this.connecting === attempt) this.connecting = undefined },
    )
    void stale?.close().catch(() => {})
    return attempt
  }

  /** Clear the reference when this exact connection reports it went away. */
  private watch(browser: PlaywrightBrowser): void {
    try {
      browser.on?.('disconnected', () => {
        if (this.browser === browser) {
          this.browser = undefined
          this.endpoint = ''
        }
      })
    } catch {
      // a backend that refuses listeners just loses proactive detection
    }
  }

  /** Forget a connection known to be dead (absent probe = assume dead here). */
  private drop(browser: PlaywrightBrowser): void {
    if (this.browser === browser) {
      this.browser = undefined
      this.endpoint = ''
    }
  }

  private isLive(browser: PlaywrightBrowser): boolean {
    return browser.isConnected?.() !== false
  }
}
