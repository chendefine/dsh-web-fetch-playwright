/**
 * The shared CDP connection pool over fake connections: one connect under
 * concurrent acquires, per-fetch pages released independently (isolated
 * leases closing page + context, profile leases closing ONLY the page in the
 * remote default context), reconnect after a drop, endpoint replacement,
 * abandonment races, and teardown.
 */
import { describe, expect, it } from 'vitest'
import { CdpConnectionPool } from '../src/cdp-pool.ts'
import type { CdpConnect } from '../src/cdp-pool.ts'
import type { PlaywrightBrowser, PlaywrightContext, PlaywrightPage } from '../src/types.ts'

/** A fake page tracking its own close (all members the pool may touch). */
class FakePage {
  private closedFlag = false
  readonly page: PlaywrightPage = {
    goto: async () => null,
    waitForLoadState: async () => {},
    url: () => 'about:blank',
    content: async () => '',
    route: async () => {},
    close: async () => { this.closedFlag = true },
  }
  get closed(): boolean { return this.closedFlag }
}

/** A fake leased context tracking its pages and its own close. */
class FakeContext {
  private closedFlag = false
  private failNextPage = false
  readonly pages: FakePage[] = []
  readonly context: PlaywrightContext = {
    newPage: async () => {
      if (this.failNextPage) {
        this.failNextPage = false
        throw new Error('Target closed')
      }
      const page = new FakePage()
      this.pages.push(page)
      return page.page
    },
    route: async () => {},
    close: async () => { this.closedFlag = true },
  }
  get closed(): boolean { return this.closedFlag }

  /** Make the next newPage fail once while the context looks healthy. */
  breakNextPage(): void { this.failNextPage = true }
}

/**
 * Instrumented fake connection: contexts/pages it handed out and its own
 * state. Carries a default context (the remote profile) reported through
 * `browser.contexts()` unless `exposeDefaultContext` is set false — the
 * degenerate endpoint profile mode must diagnose.
 */
class FakeConnection {
  readonly isolatedContexts: FakeContext[] = []
  readonly defaultContext = new FakeContext()
  /** When false, `contexts()` reports none — profile mode must diagnose. */
  exposeDefaultContext = true
  closed = false
  live = true

  private readonly listeners: Array<() => void> = []
  private nextBroken = false
  /** Contexts scripted to be handed out before fresh ones get created. */
  private readonly queuedContexts: FakeContext[] = []

  readonly browser: PlaywrightBrowser = {
    newContext: async () => {
      if (this.nextBroken || !this.live) {
        this.nextBroken = false
        throw new Error('Target closed')
      }
      const context = this.queuedContexts.shift() ?? new FakeContext()
      this.isolatedContexts.push(context)
      return context.context
    },
    contexts: () => this.exposeDefaultContext ? [this.defaultContext.context] : [],
    close: async () => { this.closed = true },
    isConnected: () => this.live,
    on: (_event: 'disconnected', listener: () => void) => { this.listeners.push(listener) },
  }

  /** Hand this exact context out on the next newContext (scripted behavior). */
  queueContext(context: FakeContext): void { this.queuedContexts.push(context) }

  /** Make the next newContext fail once while the connection looks alive. */
  breakNextContext(): void { this.nextBroken = true }

  /** Simulate the connection dropping; fires the disconnect listener. */
  drop(): void {
    this.live = false
    for (const listener of this.listeners) listener()
  }
}

/** Connect function recording calls and returning scripted connections. */
function scriptedConnect(...connections: FakeConnection[]): { connect: CdpConnect; calls: string[] } {
  if (connections.length === 0) throw new Error('scriptedConnect needs at least one connection')
  const calls: string[] = []
  let index = 0
  const connect: CdpConnect = async (endpoint, timeout) => {
    calls.push(`${endpoint}@${String(timeout)}`)
    const connection = connections[Math.min(index, connections.length - 1)] as FakeConnection
    index++
    return connection.browser
  }
  return { connect, calls }
}

describe('CdpConnectionPool', () => {
  it('connects once and shares the connection across concurrent acquires', async () => {
    const connection = new FakeConnection()
    const { connect, calls } = scriptedConnect(connection)
    const pool = new CdpConnectionPool(connect)

    const leases = await Promise.all(Array.from({ length: 5 }, () => pool.acquire('http://127.0.0.1:9222', 1000)))
    expect(calls).toEqual(['http://127.0.0.1:9222@1000'])
    expect(connection.isolatedContexts).toHaveLength(5)
    for (const lease of leases) expect(lease.browser).toBe(connection.browser)
  })

  it('release closes the leased context and keeps the connection open', async () => {
    const connection = new FakeConnection()
    const { connect } = scriptedConnect(connection)
    const pool = new CdpConnectionPool(connect)

    const lease = await pool.acquire('http://127.0.0.1:9222', 1000)
    await pool.release(lease)
    expect(connection.isolatedContexts[0]?.closed).toBe(true)
    expect(connection.closed).toBe(false)

    // The connection is reused for the next lease.
    const second = await pool.acquire('http://127.0.0.1:9222', 1000)
    expect(second.browser).toBe(connection.browser)
    expect(connection.isolatedContexts).toHaveLength(2)
  })

  it('reconnects when the connection dropped', async () => {
    const first = new FakeConnection()
    const second = new FakeConnection()
    const { connect, calls } = scriptedConnect(first, second)
    const pool = new CdpConnectionPool(connect)

    await pool.acquire('http://127.0.0.1:9222', 1000) // establishes `first`
    first.drop()
    const lease = await pool.acquire('http://127.0.0.1:9222', 1000)

    expect(lease.browser).toBe(second.browser)
    expect(calls).toHaveLength(2)
  })

  it('propagates a newContext failure on a live connection instead of retrying', async () => {
    const connection = new FakeConnection()
    const { connect, calls } = scriptedConnect(connection)
    const pool = new CdpConnectionPool(connect)

    await pool.acquire('http://127.0.0.1:9222', 1000)
    connection.breakNextContext()
    await expect(pool.acquire('http://127.0.0.1:9222', 1000)).rejects.toThrow('Target closed')
    expect(calls).toHaveLength(1) // no reconnect — the connection is healthy
  })

  it('replaces the connection when the configured endpoint changes', async () => {
    const old = new FakeConnection()
    const next = new FakeConnection()
    const { connect } = scriptedConnect(old, next)
    const pool = new CdpConnectionPool(connect)

    await pool.acquire('http://127.0.0.1:9222', 1000)
    const lease = await pool.acquire('http://browser.lan:9223', 1000)

    expect(lease.browser).toBe(next.browser)
    expect(old.closed).toBe(true)
    expect(next.closed).toBe(false)
  })

  it('abandons a connect that settles after dispose, leaving no stale reference', async () => {
    const connection = new FakeConnection()
    let releaseConnect: (() => void) | undefined
    let connectCount = 0
    const endpoint = 'http://127.0.0.1:9222'
    const pool = new CdpConnectionPool(async () => {
      connectCount++
      // The second connect hangs until the test releases it.
      if (connectCount === 2) await new Promise<void>(resolve => { releaseConnect = resolve })
      return connection.browser
    })

    await pool.acquire(endpoint, 1000) // connect #1 establishes
    await pool.dispose()
    const pending = pool.acquire(endpoint, 1000).then(  // connect #2, hanging
      lease => lease.browser,
      () => undefined as unknown as PlaywrightBrowser,
    )
    await new Promise(resolve => { setImmediate(resolve) })
    await pool.dispose() // abandons the in-flight #2
    releaseConnect?.()
    expect(await pending).toBeUndefined() // the abandoned attach rejects

    // The next acquire must connect fresh — the late settler left no residue.
    const lease = await pool.acquire(endpoint, 1000)
    expect(lease.browser).toBe(connection.browser)
    expect(connectCount).toBe(3)
  })

  it('abandons a connect made stale by an endpoint change before it settles', async () => {
    const connection = new FakeConnection()
    let releaseB: (() => void) | undefined
    const pool = new CdpConnectionPool(async (endpoint) => {
      if (endpoint === 'http://browser.b:9223') await new Promise<void>(resolve => { releaseB = resolve })
      return connection.browser
    })

    const toB = pool.acquire('http://browser.b:9223', 1000).then(
      lease => lease.browser,
      () => undefined as unknown as PlaywrightBrowser,
    )
    await new Promise(resolve => { setImmediate(resolve) }) // connect to B hangs
    const lease = await pool.acquire('http://browser.a:9222', 1000) // supersedes B
    expect(lease.browser).toBe(connection.browser)
    releaseB?.()
    expect(await toB).toBeUndefined() // B's attach was abandoned, not parked

    // The pool keeps serving the endpoint that won.
    const again = await pool.acquire('http://browser.a:9222', 1000)
    expect(again.browser).toBe(connection.browser)
  })

  it('propagates connect failures so the provider can wrap them', async () => {
    const failure = new Error('ECONNREFUSED')
    const pool = new CdpConnectionPool(async () => { throw failure })
    await expect(pool.acquire('http://127.0.0.1:9222', 1000)).rejects.toBe(failure)
    // A failed connect leaves no residue: the next acquire connects afresh.
    const recovery = new FakeConnection()
    let failOnce = true
    const retryPool = new CdpConnectionPool(async () => {
      if (failOnce) { failOnce = false; throw failure }
      return recovery.browser
    })
    await expect(retryPool.acquire('http://127.0.0.1:9222', 1000)).rejects.toBe(failure)
    const lease = await retryPool.acquire('http://127.0.0.1:9222', 1000)
    expect(lease.browser).toBe(recovery.browser)
  })
})

describe('CdpConnectionPool profile mode', () => {
  it('leases the default context (the remote profile) as a persistent tab', async () => {
    const connection = new FakeConnection()
    const { connect } = scriptedConnect(connection)
    const pool = new CdpConnectionPool(connect)

    const lease = await pool.acquire('http://127.0.0.1:9222', 1000, 'profile')
    expect(lease.persistent).toBe(true)
    expect(lease.context).toBe(connection.defaultContext.context)
    expect(connection.isolatedContexts).toHaveLength(0) // no throwaway context
    expect(connection.defaultContext.pages).toHaveLength(1)
    expect(lease.page).toBe(connection.defaultContext.pages[0]?.page)
  })

  it('release closes ONLY the page — the default context is never closed', async () => {
    const connection = new FakeConnection()
    const { connect } = scriptedConnect(connection)
    const pool = new CdpConnectionPool(connect)

    const lease = await pool.acquire('http://127.0.0.1:9222', 1000, 'profile')
    await pool.release(lease)
    expect(connection.defaultContext.pages[0]?.closed).toBe(true)
    // The single most important assertion of the feature: closing the
    // default context would tear down the whole shared connection.
    expect(connection.defaultContext.closed).toBe(false)
    expect(connection.closed).toBe(false)
    expect(connection.isolatedContexts).toHaveLength(0)
  })

  it('isolated leases still open a fresh context that release fully closes', async () => {
    const connection = new FakeConnection()
    const { connect } = scriptedConnect(connection)
    const pool = new CdpConnectionPool(connect)

    const lease = await pool.acquire('http://127.0.0.1:9222', 1000, 'isolated')
    expect(lease.persistent).toBe(false)
    expect(lease.context).toBe(connection.isolatedContexts[0]?.context)
    await pool.release(lease)
    expect(connection.isolatedContexts[0]?.pages[0]?.closed).toBe(true)
    expect(connection.isolatedContexts[0]?.closed).toBe(true)
    expect(connection.defaultContext.pages).toHaveLength(0) // profile never touched
  })

  it('diagnoses a live endpoint that reports no default context', async () => {
    const connection = new FakeConnection()
    connection.exposeDefaultContext = false
    const { connect, calls } = scriptedConnect(connection)
    const pool = new CdpConnectionPool(connect)

    await expect(pool.acquire('http://127.0.0.1:9222', 1000, 'profile'))
      .rejects.toThrow('no default browser context')
    expect(calls).toHaveLength(1) // the connection is healthy — no reconnect
  })

  it('takes the default context of the NEW connection after a reconnect', async () => {
    const first = new FakeConnection()
    const second = new FakeConnection()
    const { connect } = scriptedConnect(first, second)
    const pool = new CdpConnectionPool(connect)

    const stale = await pool.acquire('http://127.0.0.1:9222', 1000, 'profile')
    expect(stale.context).toBe(first.defaultContext.context)
    first.drop()
    const fresh = await pool.acquire('http://127.0.0.1:9222', 1000, 'profile')
    // The profile handle is never cached across connections.
    expect(fresh.browser).toBe(second.browser)
    expect(fresh.context).toBe(second.defaultContext.context)
  })

  it('serves concurrent profile leases as pages of one shared default context', async () => {
    const connection = new FakeConnection()
    const { connect } = scriptedConnect(connection)
    const pool = new CdpConnectionPool(connect)

    const leases = await Promise.all(Array.from({ length: 4 }, () => pool.acquire('http://127.0.0.1:9222', 1000, 'profile')))
    expect(connection.defaultContext.pages).toHaveLength(4)
    const pages = new Set(leases.map(lease => lease.page))
    expect(pages.size).toBe(4) // each lease got its own tab

    for (const lease of leases) await pool.release(lease)
    for (const page of connection.defaultContext.pages) expect(page.closed).toBe(true)
    expect(connection.defaultContext.closed).toBe(false)
    expect(connection.closed).toBe(false)
  })

  it('closes an isolated context whose newPage failed on a live connection', async () => {
    const connection = new FakeConnection()
    const { connect, calls } = scriptedConnect(connection)
    const pool = new CdpConnectionPool(connect)

    // The next newContext hands out a context whose first newPage fails —
    // a transient failure on an otherwise healthy connection.
    const strander = new FakeContext()
    strander.breakNextPage()
    connection.queueContext(strander)

    await expect(pool.acquire('http://127.0.0.1:9222', 1000, 'isolated')).rejects.toThrow('Target closed')
    // The stranded context was cleaned up, not left open until teardown.
    expect(strander.closed).toBe(true)
    expect(calls).toHaveLength(1) // the connection is healthy — no reconnect
  })
})
