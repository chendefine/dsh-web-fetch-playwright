/**
 * The shared CDP connection pool over fake connections: one connect under
 * concurrent acquires, per-fetch contexts released independently, reconnect
 * after a drop, endpoint replacement, abandonment races, and teardown.
 */
import { describe, expect, it } from 'vitest'
import { CdpConnectionPool } from '../src/cdp-pool.ts'
import type { CdpConnect } from '../src/cdp-pool.ts'
import type { PlaywrightBrowser, PlaywrightContext } from '../src/types.ts'

/** A fake leased context tracking its own close. */
class FakeContext {
  private closedFlag = false
  readonly context: PlaywrightContext = {
    newPage: async () => { throw new Error('not used') },
    route: async () => {},
    close: async () => { this.closedFlag = true },
  }
  get closed(): boolean { return this.closedFlag }
}

/** Instrumented fake connection: contexts it handed out and its own state. */
class FakeConnection {
  readonly contexts: FakeContext[] = []
  closed = false
  live = true
  private readonly listeners: Array<() => void> = []
  private nextBroken = false

  readonly browser: PlaywrightBrowser = {
    newContext: async () => {
      if (this.nextBroken || !this.live) {
        this.nextBroken = false
        throw new Error('Target closed')
      }
      const context = new FakeContext()
      this.contexts.push(context)
      return context.context
    },
    close: async () => { this.closed = true },
    isConnected: () => this.live,
    on: (_event: 'disconnected', listener: () => void) => { this.listeners.push(listener) },
  }

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
    expect(connection.contexts).toHaveLength(5)
    for (const lease of leases) expect(lease.browser).toBe(connection.browser)
  })

  it('release closes the leased context and keeps the connection open', async () => {
    const connection = new FakeConnection()
    const { connect } = scriptedConnect(connection)
    const pool = new CdpConnectionPool(connect)

    const lease = await pool.acquire('http://127.0.0.1:9222', 1000)
    await pool.release(lease)
    expect(connection.contexts[0]?.closed).toBe(true)
    expect(connection.closed).toBe(false)

    // The connection is reused for the next lease.
    const second = await pool.acquire('http://127.0.0.1:9222', 1000)
    expect(second.browser).toBe(connection.browser)
    expect(connection.contexts).toHaveLength(2)
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
