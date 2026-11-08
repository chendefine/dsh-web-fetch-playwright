/** Session-dedicated or global/profile-shared CDP connections and page leases.
 * Retired generations drain
 * before disconnecting; named contexts belong to a generation, never a profile.
 * @module dsh-web-fetch-playwright/cdp-pool
 */
import type { PlaywrightBrowser, PlaywrightContext, PlaywrightPage } from './types.ts'
import { createSessionPage } from './session-window.ts'

export type SessionPageFactory = (context: PlaywrightContext, browser: PlaywrightBrowser, timeoutMs: number) => Promise<PlaywrightPage>

export type CdpConnect = (endpoint: string, timeoutMs: number) => Promise<PlaywrightBrowser>
export type CdpAcquireMode = 'isolated' | 'profile' | { scope: 'session' | 'global'; name: string }
export interface CdpLease {
  browser: PlaywrightBrowser
  context: PlaywrightContext
  page: PlaywrightPage
  /** Retained context: never close it directly on fetch completion. */
  persistent: boolean
  /** Idempotent, bounded cleanup; use this rather than closing context/browser. */
  release(): Promise<void>
}
interface ContextEntry {
  context: PlaywrightContext
  closed: boolean
  /** Named leases, including acquisitions still creating their page. */
  active: number
}
interface Generation {
  endpoint: string
  /** Session-isolated connections must never be shared across DSH sessions. */
  sessionKey?: string
  browser?: PlaywrightBrowser
  connecting?: Promise<PlaywrightBrowser>
  retired: boolean
  disposed: boolean
  /** Includes pending acquisitions so retirement cannot race page creation. */
  active: number
  named: Map<string, Promise<ContextEntry>>
  owned: Set<PlaywrightContext>
  cleanup?: Promise<void>
  /** FIFO lifecycle mutex per named context, never held while fetching content. */
  locks: Map<string, Promise<void>>
}

const CLOSE_GRACE_MS = 2_000

/** Thrown when a policy/connection change retired the generation mid-acquisition.
 * A dedicated class lets acquire() recognise it without matching message text.
 */
class AcquisitionAbandonedError extends Error {
  constructor() { super('cdp acquisition abandoned after policy or connection change') }
}

/** Chromium does not notify other CDP clients when a browser context is
 * disposed externally. Only this explicit createTarget error proves that the
 * context used by newPage no longer exists; generic "Target closed" errors do
 * not justify discarding shared state. Kept private to the newPage path.
 */
function isMissingBrowserContext(error: unknown): boolean {
  return error instanceof Error && /Protocol error \(Target\.createTarget\): Failed to find browser context with id [A-Za-z0-9_-]+(?:\r?\n|$)/.test(error.message)
}

export class CdpConnectionPool {
  private current?: Generation
  private readonly sessionConnections = new Map<string, Generation>()
  private policy?: string
  private epoch = 0
  private readonly generations = new Set<Generation>()
  private readonly closes = new WeakMap<object, Promise<void>>()

  constructor(
    private readonly connect: CdpConnect,
    private readonly sessionPageFactory: SessionPageFactory = createSessionPage,
  ) {}

  /** Serialize create/reuse/new-tab and tab-close/empty-check/context-close as
   * whole transactions. Different session keys never wait for each other.
   * A failed operation cannot poison the queue, and the map only drops the
   * exact tail it owns (a queued acquisition may already have replaced it).
   */
  private async withLock<T>(generation: Generation, key: string, operation: () => Promise<T>): Promise<T> {
    const previous = generation.locks.get(key) ?? Promise.resolve()
    let unlock!: () => void
    const tail = new Promise<void>(resolve => { unlock = resolve })
    generation.locks.set(key, tail)
    await previous
    try { return await operation() } finally {
      unlock()
      if (generation.locks.get(key) === tail) generation.locks.delete(key)
    }
  }

  /** Call synchronously for every fetch, including local-backend fetches.
   * Keys must encode backend, endpoint and effective context policy. A change
   * prevents new leases on the old generation but preserves existing pages.
   */
  setPolicy(key: string): void {
    if (this.policy === key) return
    this.policy = key
    this.epoch++
    for (const generation of this.generations) this.retire(generation)
  }

  async acquire(endpoint: string, timeoutMs: number, mode: CdpAcquireMode = 'isolated'): Promise<CdpLease> {
    for (let attempt = 0; ; attempt++) {
      const generation = this.ensure(endpoint, mode)
      const epoch = this.epoch
      generation.active++
      try {
        const browser = await this.attach(generation, timeoutMs)
        this.assertCurrent(generation)
        const open = async () => {
          this.assertCurrent(generation)
          return await this.openLease(generation, browser, mode, timeoutMs)
        }
        return typeof mode === 'object'
          ? await this.withLock(generation, JSON.stringify([mode.scope, mode.name]), open)
          : await open()
      } catch (error: unknown) {
        generation.active--
        const idleSessionRetired = generation.sessionKey !== undefined && generation.retired && epoch === this.epoch
          && error instanceof AcquisitionAbandonedError
        // A failed acquisition must not leave a per-session socket stranded, nor
        // an idle context kept open for it as a pending same-session fetch.
        if (generation.sessionKey !== undefined && generation.active === 0) this.retire(generation)
        void this.drain(generation)
        // A queued acquisition may have waited behind the last tab's close;
        // take a fresh session connection rather than reuse a closing gateway.
        if (attempt === 0 && idleSessionRetired) continue
        // Otherwise retry only a confirmed dead connection, never arbitrary
        // target errors or a policy-superseded acquisition.
        if (attempt > 0 || epoch !== this.epoch || !generation.browser || this.isLive(generation.browser)) throw error
        this.retire(generation)
      }
    }
  }

  release(lease: CdpLease): Promise<void> { return lease.release() }

  /** Teardown is stronger than policy retirement: close owned contexts and
   * disconnect even with active leases. Pending creations clean up on arrival.
   * The remote default context is NEVER explicitly closed.
   */
  async dispose(): Promise<void> {
    const generations = [...this.generations]
    this.epoch++
    this.current = undefined
    this.sessionConnections.clear()
    for (const generation of generations) {
      generation.retired = true
      generation.disposed = true
    }
    await Promise.all(generations.map(generation => this.drain(generation)))
  }

  private ensure(endpoint: string, mode: CdpAcquireMode): Generation {
    if (typeof mode === 'object' && mode.scope === 'session') {
      const key = JSON.stringify([endpoint, mode.name])
      let generation = this.sessionConnections.get(key)
      if (generation?.browser && !this.isLive(generation.browser)) {
        this.retire(generation)
        generation = undefined
      }
      if (!generation) {
        generation = { endpoint, sessionKey: key, retired: false, disposed: false, active: 0, named: new Map(), owned: new Set(), locks: new Map() }
        this.sessionConnections.set(key, generation)
        this.generations.add(generation)
      }
      return generation
    }
    if (this.current && (this.current.endpoint !== endpoint || (this.current.browser && !this.isLive(this.current.browser)))) {
      if (this.current.endpoint !== endpoint) this.epoch++
      this.retire(this.current)
    }
    if (!this.current) {
      this.current = { endpoint, retired: false, disposed: false, active: 0, named: new Map(), owned: new Set(), locks: new Map() }
      this.generations.add(this.current)
    }
    return this.current
  }

  private async attach(generation: Generation, timeoutMs: number): Promise<PlaywrightBrowser> {
    if (generation.browser) return generation.browser
    if (!generation.connecting) {
      generation.connecting = (async () => {
        const browser = await this.connect(generation.endpoint, timeoutMs)
        generation.browser = browser
        if (generation.retired) {
          await this.close(browser)
          throw new Error('cdp connection abandoned before it attached')
        }
        try {
          browser.on?.('disconnected', () => {
            // Keep the record for draining leases but do not reuse it.
            this.retire(generation)
          })
        } catch { /* optional event support */ }
        return browser
      })()
    }
    try { return await generation.connecting } catch (error) {
      generation.connecting = undefined
      throw error
    }
  }

  private assertCurrent(generation: Generation): void {
    if (generation.retired) throw new AcquisitionAbandonedError()
  }

  private async createContext(generation: Generation, browser: PlaywrightBrowser): Promise<ContextEntry> {
    const context = await browser.newContext()
    // Fail closed on adapters/proxies that return a profile or another lease's
    // context instead of a fresh isolated context. Never take ownership of it.
    if (browser.contexts?.()[0] === context || [...this.generations].some(item => item.owned.has(context))) {
      throw new Error('CDP backend did not create a distinct isolated browser context')
    }
    if (generation.retired) {
      await this.close(context)
      throw new Error('cdp context abandoned after policy or connection change')
    }
    const entry = { context, closed: false, active: 0 }
    generation.owned.add(context)
    try {
      context.on?.('close', () => {
        entry.closed = true
        generation.owned.delete(context)
      })
    } catch { /* optional event support */ }
    return entry
  }

  private async namedContext(generation: Generation, browser: PlaywrightBrowser, key: string): Promise<ContextEntry> {
    let pending = generation.named.get(key)
    if (!pending) {
      pending = this.createContext(generation, browser)
      generation.named.set(key, pending)
    }
    try {
      const entry = await pending
      if (!entry.closed) {
        // Reserve before returning across an await boundary: the last release
        // must not close a context that another acquisition is about to use.
        entry.active++
        return entry
      }
      if (generation.named.get(key) === pending) generation.named.delete(key)
      this.assertCurrent(generation)
      return await this.namedContext(generation, browser, key)
    } catch (error) {
      if (generation.named.get(key) === pending) generation.named.delete(key)
      throw error
    }
  }

  /** Invalidate the exact entry, not its key: a concurrent request may already
   * have installed a replacement. namedContext removes only the Promise it read.
   * Best-effort close attempts to release Playwright's local handle after an
   * external CDP deletion (some versions retain it until disconnect); it never
   * touches a sibling context or the default profile.
   */
  private invalidateContext(generation: Generation, entry: ContextEntry): void {
    entry.closed = true
    generation.owned.delete(entry.context)
    void this.close(entry.context)
  }

  private async releaseNamedContext(generation: Generation, entry: ContextEntry, mode: CdpAcquireMode): Promise<void> {
    entry.active--
    if (typeof mode !== 'object' || mode.scope !== 'session' || entry.active > 0 || entry.closed) return
    // Same-session acquisitions already inside the pool (queued on the lock or
    // still attaching) count as pending: keep the context so they inherit its
    // cookies instead of reconnecting. The caller's own lease is still counted
    // in generation.active here; the last one out closes the context (or, if it
    // fails before reaching the lock, acquire() retires the idle generation).
    if (generation.active > 1) return
    // Count real tabs too, not just leases: never tear down an unrelated tab
    // or a page whose close failed/timed out. Minimal backends use lease count.
    if ((entry.context.pages?.().length ?? 0) > 0) return
    // Mark unavailable synchronously before awaiting close. New acquisitions
    // replace this exact entry rather than racing its asynchronous teardown.
    entry.closed = true
    generation.named.delete(JSON.stringify([mode.scope, mode.name]))
    await this.close(entry.context)
    generation.owned.delete(entry.context)
    // Some CDP gateways map a connection's first context to a whole browser.
    // Discard that socket too: never create nested contexts for another session
    // or race a new context against an asynchronously destroyed gateway browser.
    if (generation.sessionKey !== undefined) this.retire(generation)
  }

  private async openLease(generation: Generation, browser: PlaywrightBrowser, mode: CdpAcquireMode, timeoutMs: number): Promise<CdpLease> {
    const namedKey = typeof mode === 'object' ? JSON.stringify([mode.scope, mode.name]) : undefined
    let entry: ContextEntry
    if (mode === 'profile') {
      const context = browser.contexts?.()[0]
      if (!context) throw new Error('the CDP endpoint exposed no default browser context (profile mode requires a real browser profile)')
      entry = { context, closed: false, active: 0 }
    } else {
      entry = namedKey === undefined ? await this.createContext(generation, browser) : await this.namedContext(generation, browser, namedKey)
    }
    let page: PlaywrightPage
    try {
      for (let attempt = 0; ; attempt++) {
        this.assertCurrent(generation)
        try {
          page = typeof mode === 'object' && mode.scope === 'session'
            ? await this.sessionPageFactory(entry.context, browser, timeoutMs)
            : await entry.context.newPage()
          break
        } catch (error) {
          if (!namedKey || (!entry.closed && !isMissingBrowserContext(error))) throw error
          this.invalidateContext(generation, entry)
          // Also invalidate an unsuccessful replacement so a later request can
          // recover, but this acquisition gets at most ONE newPage retry.
          if (attempt >= 1 || !this.isLive(browser)) throw error
          this.assertCurrent(generation)
          const replacement = await this.namedContext(generation, browser, namedKey)
          entry.active--
          entry = replacement
        }
      }
      if (generation.retired) {
        await this.close(page)
        this.assertCurrent(generation)
      }
    } catch (error) {
      if (mode === 'isolated') {
        await this.close(entry.context)
        generation.owned.delete(entry.context)
      }
      if (namedKey !== undefined) await this.releaseNamedContext(generation, entry, mode)
      throw error
    }
    const context = entry.context
    let released: Promise<void> | undefined
    const release = (): Promise<void> => {
      const cleanup = async () => {
        await this.close(page)
        if (mode === 'isolated') {
          await this.close(context)
          generation.owned.delete(context)
        }
        if (namedKey !== undefined) await this.releaseNamedContext(generation, entry, mode)
        generation.active--
        await this.drain(generation)
      }
      // Global release only decrements a counter and closes its own tab: it
      // never touches the shared context, so it need not queue behind creation.
      released ??= namedKey === undefined || (typeof mode === 'object' && mode.scope === 'global')
        ? cleanup()
        : this.withLock(generation, namedKey, cleanup)
      return released
    }
    return { browser, context, page, persistent: mode !== 'isolated', release }
  }

  private retire(generation: Generation): void {
    generation.retired = true
    if (this.current === generation) this.current = undefined
    if (generation.sessionKey !== undefined && this.sessionConnections.get(generation.sessionKey) === generation) {
      this.sessionConnections.delete(generation.sessionKey)
    }
    void this.drain(generation)
  }

  private async drain(generation: Generation): Promise<void> {
    if (!generation.retired || (!generation.disposed && generation.active > 0)) return
    generation.cleanup ??= (async () => {
      await Promise.all([...generation.owned].map(context => this.close(context)))
      generation.owned.clear()
      generation.named.clear()
      if (generation.browser) await this.close(generation.browser)
      this.generations.delete(generation)
    })()
    await generation.cleanup
  }

  /** Bound cleanup and deduplicate close calls, including release/dispose races. */
  private close(value: { close(): Promise<void> }): Promise<void> {
    let pending = this.closes.get(value)
    if (!pending) {
      pending = new Promise<void>(resolve => {
        const timer = setTimeout(resolve, CLOSE_GRACE_MS)
        void Promise.resolve().then(() => value.close()).catch(() => {}).then(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      this.closes.set(value, pending)
    }
    return pending
  }

  private isLive(browser: PlaywrightBrowser): boolean { return browser.isConnected?.() !== false }
}
