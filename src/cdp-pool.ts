/**
 * The CDP backend's shared connection: one `connectOverCDP` session reused by
 * every fetch, each fetch leasing an isolated context (a tab in the remote
 * browser) that it closes when done. The connection itself outlives fetches —
 * reconnecting per fetch would spend 100–500ms per call and open one socket
 * per concurrent tab for no benefit.
 *
 * Liveness is handled three ways: `isConnected()` is checked before reuse, a
 * `disconnected` event (when the backend emits it) drops the reference
 * immediately, and a `newContext` failure against a dead connection triggers
 * exactly one reconnect-and-retry before the error surfaces. A changed
 * endpoint (settings edit) replaces the connection.
 *
 * @module dsh-web-fetch-playwright/cdp-pool
 */

import type { PlaywrightBrowser, PlaywrightContext } from './types.ts'

/** Opens the shared connection; injected so tests can substitute a fake. */
export type CdpConnect = (endpoint: string, timeoutMs: number) => Promise<PlaywrightBrowser>

/** One fetch's lease: the shared browser plus a context it owns. */
export interface CdpLease {
  /** The shared connection — close only what the lease owns, never this. */
  browser: PlaywrightBrowser
  /** The fetch-owned isolated context; {@link CdpConnectionPool.release} closes it. */
  context: PlaywrightContext
}

/** A reusable `connectOverCDP` session handing out per-fetch contexts. */
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
   * Lease a fresh isolated context on the shared connection, connecting (or
   * reconnecting) first if needed. Concurrent first fetches share one
   * connect attempt.
   *
   * @param endpoint - normalized CDP endpoint URL.
   * @param timeoutMs - connect timeout budget.
   * @returns the shared browser and a context the caller must release.
   * @throws whatever the connect function throws when no connection can be
   * established (the provider wraps it in a structured WebError).
   */
  async acquire(endpoint: string, timeoutMs: number): Promise<CdpLease> {
    const browser = await this.ensure(endpoint, timeoutMs)
    try {
      return { browser, context: await browser.newContext() }
    } catch (error: unknown) {
      // The connection may have died between ensure() and newContext(); one
      // fresh connection attempt, then the error propagates as-is.
      if (this.isLive(browser)) throw error
      this.drop(browser)
      const fresh = await this.ensure(endpoint, timeoutMs)
      return { browser: fresh, context: await fresh.newContext() }
    }
  }

  /**
   * Close a fetch-owned context. The shared connection stays open for the
   * next fetch.
   * @param lease - the lease whose context goes away.
   */
  async release(lease: CdpLease): Promise<void> {
    await lease.context.close().catch(() => {})
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
