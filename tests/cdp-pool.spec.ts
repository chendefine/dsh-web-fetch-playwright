/**
 * The shared CDP connection pool over fake connections: one connect under
 * concurrent acquires, per-fetch pages released independently (isolated
 * leases closing page + context, profile leases closing ONLY the page in the
 * remote default context), reconnect after a drop, endpoint replacement,
 * abandonment races, and teardown.
 */
import { describe, expect, it, vi } from 'vitest'
import { CdpConnectionPool } from '../src/cdp-pool.ts'
import type { CdpConnect } from '../src/cdp-pool.ts'
import type { PlaywrightBrowser, PlaywrightContext, PlaywrightPage } from '../src/types.ts'

/** Pool tests exercise lifecycle locking, not CDP target/window operations. */
class FakePagePool extends CdpConnectionPool {
  constructor(connect: CdpConnect) { super(connect, async context => await context.newPage()) }
}

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
  private readonly listeners: Array<() => void> = []
  closeCalls = 0
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
    pages: () => this.pages.filter(page => !page.closed).map(page => page.page),
    route: async () => {},
    close: async () => { this.closeCalls++; this.externallyClose() },
    on: (_event, listener) => { this.listeners.push(listener) },
  }
  get closed(): boolean { return this.closedFlag }
  externallyClose(): void {
    this.closedFlag = true
    for (const listener of this.listeners) listener()
  }

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
    const pool = new FakePagePool(connect)

    const leases = await Promise.all(Array.from({ length: 5 }, () => pool.acquire('http://127.0.0.1:9222', 1000)))
    expect(calls).toEqual(['http://127.0.0.1:9222@1000'])
    expect(connection.isolatedContexts).toHaveLength(5)
    for (const lease of leases) expect(lease.browser).toBe(connection.browser)
  })

  it('release closes the leased context and keeps the connection open', async () => {
    const connection = new FakeConnection()
    const { connect } = scriptedConnect(connection)
    const pool = new FakePagePool(connect)

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
    const pool = new FakePagePool(connect)

    await pool.acquire('http://127.0.0.1:9222', 1000) // establishes `first`
    first.drop()
    const lease = await pool.acquire('http://127.0.0.1:9222', 1000)

    expect(lease.browser).toBe(second.browser)
    expect(calls).toHaveLength(2)
  })

  it('propagates a newContext failure on a live connection instead of retrying', async () => {
    const connection = new FakeConnection()
    const { connect, calls } = scriptedConnect(connection)
    const pool = new FakePagePool(connect)

    await pool.acquire('http://127.0.0.1:9222', 1000)
    connection.breakNextContext()
    await expect(pool.acquire('http://127.0.0.1:9222', 1000)).rejects.toThrow('Target closed')
    expect(calls).toHaveLength(1) // no reconnect — the connection is healthy
  })

  it('replaces the connection when the configured endpoint changes', async () => {
    const old = new FakeConnection()
    const next = new FakeConnection()
    const { connect } = scriptedConnect(old, next)
    const pool = new FakePagePool(connect)

    const oldLease = await pool.acquire('http://127.0.0.1:9222', 1000)
    const lease = await pool.acquire('http://browser.lan:9223', 1000)

    expect(lease.browser).toBe(next.browser)
    expect(old.closed).toBe(false) // endpoint replacement drains active leases
    await oldLease.release()
    expect(old.closed).toBe(true)
    expect(next.closed).toBe(false)
  })

  it('abandons a connect that settles after dispose, leaving no stale reference', async () => {
    const connection = new FakeConnection()
    let releaseConnect: (() => void) | undefined
    let connectCount = 0
    const endpoint = 'http://127.0.0.1:9222'
    const pool = new FakePagePool(async () => {
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
    const pool = new FakePagePool(async (endpoint) => {
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
    const pool = new FakePagePool(async () => { throw failure })
    await expect(pool.acquire('http://127.0.0.1:9222', 1000)).rejects.toBe(failure)
    // A failed connect leaves no residue: the next acquire connects afresh.
    const recovery = new FakeConnection()
    let failOnce = true
    const retryPool = new FakePagePool(async () => {
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
    const pool = new FakePagePool(connect)

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
    const pool = new FakePagePool(connect)

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
    const pool = new FakePagePool(connect)

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
    const pool = new FakePagePool(connect)

    await expect(pool.acquire('http://127.0.0.1:9222', 1000, 'profile'))
      .rejects.toThrow('no default browser context')
    expect(calls).toHaveLength(1) // the connection is healthy — no reconnect
  })

  it('takes the default context of the NEW connection after a reconnect', async () => {
    const first = new FakeConnection()
    const second = new FakeConnection()
    const { connect } = scriptedConnect(first, second)
    const pool = new FakePagePool(connect)

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
    const pool = new FakePagePool(connect)

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
    const pool = new FakePagePool(connect)

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

const MISSING_CONTEXT_ERROR = 'browserContext.newPage: Protocol error (Target.createTarget): Failed to find browser context with id F5244FC7D8EB217BEC8B461CBBBEA146'
const endpoint = 'http://127.0.0.1:9222'
const named = { scope: 'session', name: 'alpha' } as const
const tick = async (): Promise<void> => { await new Promise<void>(resolve => { setImmediate(resolve) }) }

describe('CdpConnectionPool named contexts and policy retirement', () => {
  it('deduplicates concurrent session creation and closes context after all page releases', async () => {
    const connection = new FakeConnection()
    const { connect, calls } = scriptedConnect(connection)
    const pool = new FakePagePool(connect)
    const leases = await Promise.all(Array.from({ length: 8 }, () => pool.acquire(endpoint, 1000, named)))
    expect(calls).toHaveLength(1)
    expect(connection.isolatedContexts).toHaveLength(1)
    expect(new Set(leases.map(lease => lease.context)).size).toBe(1)
    expect(new Set(leases.map(lease => lease.page)).size).toBe(8)
    await Promise.all(leases.map(lease => lease.release()))
    expect(connection.isolatedContexts[0]?.closed).toBe(true)
    expect(connection.isolatedContexts[0]?.pages.every(page => page.closed)).toBe(true)
    const next = await pool.acquire(endpoint, 1000, named)
    expect(next.context).not.toBe(leases[0]?.context)
    await next.release()
    await pool.dispose()
    expect(connection.isolatedContexts[0]?.closed).toBe(true)
    expect(connection.defaultContext.closed).toBe(false)
    expect(connection.closed).toBe(true)
  })

  it('gives each DSH session its own connection and disconnects only the idle session', async () => {
    const alpha = new FakeConnection()
    const beta = new FakeConnection()
    const reopened = new FakeConnection()
    const { connect, calls } = scriptedConnect(alpha, beta, reopened)
    const pool = new FakePagePool(connect)
    const a = await pool.acquire(endpoint, 1000, named)
    const a2 = await pool.acquire(endpoint, 1000, named)
    const b = await pool.acquire(endpoint, 1000, { scope: 'session', name: 'beta' })
    expect(a.browser).toBe(a2.browser)
    expect(a.browser).not.toBe(b.browser)
    expect(calls).toHaveLength(2)
    await a.release()
    expect(alpha.closed).toBe(false)
    await a2.release()
    expect(alpha.closed).toBe(true)
    expect(beta.closed).toBe(false)
    expect(beta.isolatedContexts[0]?.closed).toBe(false)
    const next = await pool.acquire(endpoint, 1000, named)
    expect(next.browser).toBe(reopened.browser)
    expect(calls).toHaveLength(3)
    await Promise.all([next.release(), b.release()])
    expect(beta.closed).toBe(true)
    expect(reopened.closed).toBe(true)
    await pool.dispose()
  })

  it('keeps global contexts after their last tab closes', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const mode = { scope: 'global', name: 'global' } as const
    const first = await pool.acquire(endpoint, 1000, mode)
    await first.release()
    const next = await pool.acquire(endpoint, 1000, mode)
    expect(next.context).toBe(first.context)
    await next.release()
    expect(connection.isolatedContexts[0]?.closed).toBe(false)
    await pool.dispose()
  })

  it('keeps sibling tabs and sessions alive until their own last release', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const a = await pool.acquire(endpoint, 1000, named)
    const b = await pool.acquire(endpoint, 1000, named)
    const other = await pool.acquire(endpoint, 1000, { scope: 'session', name: 'beta' })
    await a.release()
    expect(connection.isolatedContexts[0]?.closed).toBe(false)
    await b.release()
    expect(connection.isolatedContexts[0]?.closed).toBe(true)
    expect(connection.isolatedContexts[1]?.closed).toBe(false)
    await other.release()
    expect(connection.isolatedContexts[1]?.closed).toBe(true)
    await pool.dispose()
  })

  it('preserves a context while another tab is still being created', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const first = await pool.acquire(endpoint, 1000, named)
    const createPage = first.context.newPage.bind(first.context)
    let resume!: () => void
    first.context.newPage = async () => {
      await new Promise<void>(resolve => { resume = resolve })
      return await createPage()
    }
    const pending = pool.acquire(endpoint, 1000, named)
    await tick()
    const released = first.release()
    await tick()
    expect(connection.isolatedContexts[0]?.closed).toBe(false)
    expect(connection.isolatedContexts[0]?.pages[0]?.closed).toBe(false)
    resume()
    const second = await pending
    await released
    expect(second.context).toBe(first.context)
    await second.release()
    expect(connection.isolatedContexts[0]?.closed).toBe(true)
    await pool.dispose()
  })

  it('holds the session mutex through context close before reopening', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const first = await pool.acquire(endpoint, 1000, named)
    let finishClose!: () => void
    const closeContext = first.context.close.bind(first.context)
    first.context.close = async () => {
      await new Promise<void>(resolve => { finishClose = resolve })
      await closeContext()
    }
    const releasing = first.release()
    await tick()
    const pending = pool.acquire(endpoint, 1000, named)
    await tick()
    expect(connection.isolatedContexts).toHaveLength(1)
    // A different session must not be blocked by alpha's teardown.
    const other = await pool.acquire(endpoint, 1000, { scope: 'session', name: 'beta' })
    expect(connection.isolatedContexts).toHaveLength(2)
    finishClose()
    await releasing
    const next = await pending
    expect(next.context).not.toBe(first.context)
    expect(connection.isolatedContexts).toHaveLength(3)
    expect(connection.isolatedContexts[2]?.closed).toBe(false)
    await Promise.all([next.release(), other.release()])
    await pool.dispose()
  })

  it('serializes tab close with new-tab and never closes a newly acquired tab', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const first = await pool.acquire(endpoint, 1000, named)
    const sibling = await pool.acquire(endpoint, 1000, named)
    let finishClose!: () => void
    const closePage = first.page.close.bind(first.page)
    first.page.close = async () => {
      await new Promise<void>(resolve => { finishClose = resolve })
      await closePage()
    }
    const releasing = first.release()
    await tick()
    const pending = pool.acquire(endpoint, 1000, named)
    await tick()
    expect(connection.isolatedContexts[0]?.pages).toHaveLength(2)
    finishClose()
    await releasing
    const next = await pending
    expect(next.context).toBe(sibling.context)
    await sibling.release()
    expect(connection.isolatedContexts[0]?.closed).toBe(false)
    expect(connection.isolatedContexts[0]?.pages[2]?.closed).toBe(false)
    await next.release()
    expect(connection.isolatedContexts[0]?.closeCalls).toBe(1)
    await pool.dispose()
  })

  it('keeps the session context for a same-session acquisition queued behind the last release', async () => {
    const connection = new FakeConnection()
    const { connect, calls } = scriptedConnect(connection)
    const pool = new FakePagePool(connect)
    const first = await pool.acquire(endpoint, 1000, named)
    let finishClose!: () => void
    const closePage = first.page.close.bind(first.page)
    first.page.close = async () => {
      await new Promise<void>(resolve => { finishClose = resolve })
      await closePage()
    }
    const releasing = first.release()
    await tick()
    const pending = pool.acquire(endpoint, 1000, named)
    await tick()
    finishClose()
    await releasing
    const next = await pending
    expect(next.context).toBe(first.context)
    expect(next.browser).toBe(first.browser)
    expect(calls).toHaveLength(1)
    expect(connection.isolatedContexts[0]?.closed).toBe(false)
    await next.release()
    expect(connection.isolatedContexts[0]?.closed).toBe(true)
    expect(connection.closed).toBe(true)
    await pool.dispose()
  })

  it('global release does not wait behind a same-scope tab creation', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const mode = { scope: 'global', name: 'global' } as const
    const first = await pool.acquire(endpoint, 1000, mode)
    const createPage = first.context.newPage.bind(first.context)
    let resume!: () => void
    first.context.newPage = async () => {
      await new Promise<void>(resolve => { resume = resolve })
      return await createPage()
    }
    const pending = pool.acquire(endpoint, 1000, mode)
    await tick()
    await first.release()
    expect(connection.isolatedContexts[0]?.pages[0]?.closed).toBe(true)
    resume()
    const second = await pending
    expect(second.context).toBe(first.context)
    await second.release()
    expect(connection.isolatedContexts[0]?.closed).toBe(false)
    await pool.dispose()
  })

  it('rejects queued acquisitions after retirement instead of opening in the old context', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const first = await pool.acquire(endpoint, 1000, named)
    let resume!: () => void
    const createPage = first.context.newPage.bind(first.context)
    first.context.newPage = async () => {
      await new Promise<void>(resolve => { resume = resolve })
      return await createPage()
    }
    const pending = pool.acquire(endpoint, 1000, named)
    const rejected = expect(pending).rejects.toThrow('abandoned')
    await tick()
    const queued = pool.acquire(endpoint, 1000, named)
    const queuedRejected = expect(queued).rejects.toThrow('abandoned')
    pool.setPolicy('local')
    resume()
    await Promise.all([rejected, queuedRejected])
    await first.release()
    expect(connection.closed).toBe(true)
    await pool.dispose()
  })

  it('does not close a context containing an unrelated open tab', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const first = await pool.acquire(endpoint, 1000, named)
    const external = await first.context.newPage()
    await first.release()
    expect(connection.isolatedContexts[0]?.closed).toBe(false)
    const next = await pool.acquire(endpoint, 1000, named)
    expect(next.context).toBe(first.context)
    await external.close()
    await next.release()
    expect(connection.isolatedContexts[0]?.closed).toBe(true)
    await pool.dispose()
  })

  it('cleans an empty session context when page creation fails', async () => {
    const connection = new FakeConnection()
    const context = new FakeContext()
    context.breakNextPage()
    connection.queueContext(context)
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    await expect(pool.acquire(endpoint, 1000, named)).rejects.toThrow('Target closed')
    expect(context.closed).toBe(true)
    const next = await pool.acquire(endpoint, 1000, named)
    expect(next.context).not.toBe(context.context)
    await Promise.all([next.release(), next.release()])
    expect(connection.isolatedContexts[1]?.closeCalls).toBe(1)
    await pool.dispose()
  })

  it('uses distinct keys for scope and name (including punctuation)', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const modes = [named, { scope: 'global', name: 'alpha' }, { scope: 'session', name: 'global:alpha' }] as const
    const leases = await Promise.all(modes.map(mode => pool.acquire(endpoint, 1000, mode)))
    expect(new Set(leases.map(lease => lease.context)).size).toBe(3)
    await Promise.all(leases.map(lease => lease.release()))
    await pool.dispose()
  })

  it('release callbacks and pool.release share one idempotent cleanup', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const lease = await pool.acquire(endpoint, 1000)
    const closePage = vi.spyOn(lease.page, 'close')
    const a = lease.release()
    expect(lease.release()).toBe(a)
    await Promise.all([a, pool.release(lease), lease.release()])
    expect(closePage).toHaveBeenCalledTimes(1)
    expect(connection.isolatedContexts[0]?.closeCalls).toBe(1)
    await pool.dispose()
    expect(connection.isolatedContexts[0]?.closeCalls).toBe(1)
  })

  it('same policy keeps contexts; policy changes drain all old leases before disconnect', async () => {
    const old = new FakeConnection()
    const next = new FakeConnection()
    const { connect, calls } = scriptedConnect(old, next)
    const pool = new FakePagePool(connect)
    pool.setPolicy('cdp/session/alpha')
    const a = await pool.acquire(endpoint, 1000, named)
    pool.setPolicy('cdp/session/alpha')
    const b = await pool.acquire(endpoint, 1000, named)
    expect(calls).toHaveLength(1)
    pool.setPolicy('cdp/global/alpha')
    expect(old.closed).toBe(false)
    expect(old.isolatedContexts[0]?.closed).toBe(false)
    const c = await pool.acquire(endpoint, 1000, { scope: 'global', name: 'alpha' })
    expect(c.browser).toBe(next.browser)
    await a.release()
    expect(old.closed).toBe(false)
    await b.release()
    expect(old.closed).toBe(true)
    expect(old.isolatedContexts[0]?.closed).toBe(true)
    expect(next.closed).toBe(false)
    await c.release()
    await pool.dispose()
  })

  it('switch to local retires idle CDP resources without another acquire', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    pool.setPolicy('cdp')
    await (await pool.acquire(endpoint, 1000, named)).release()
    pool.setPolicy('local')
    await tick()
    expect(connection.closed).toBe(true)
    expect(connection.isolatedContexts[0]?.closed).toBe(true)
    expect(connection.defaultContext.closed).toBe(false)
  })

  it('policy retirement never closes the default profile context', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    pool.setPolicy('profile')
    const lease = await pool.acquire(endpoint, 1000, 'profile')
    pool.setPolicy('local')
    expect(connection.closed).toBe(false)
    await lease.release()
    expect(connection.closed).toBe(true)
    expect(connection.defaultContext.closed).toBe(false)
  })

  it('invalidates externally closed named contexts', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const a = await pool.acquire(endpoint, 1000, named)
    connection.isolatedContexts[0]?.externallyClose()
    const b = await pool.acquire(endpoint, 1000, named)
    expect(b.context).not.toBe(a.context)
    expect(connection.isolatedContexts).toHaveLength(2)
    await b.release()
    await pool.dispose()
  })

  it.each(['session', 'global'] as const)('recovers a missing %s context without a close event, preserving other contexts', async scope => {
    const connection = new FakeConnection()
    const { connect, calls } = scriptedConnect(connection)
    const pool = new FakePagePool(connect)
    const mode = { scope, name: 'deleted' }
    try {
      const old = await pool.acquire(endpoint, 1000, mode)
      const sibling = await pool.acquire(endpoint, 1000, { scope, name: 'unaffected' })
      old.context.newPage = vi.fn().mockRejectedValue(new Error(MISSING_CONTEXT_ERROR))
      const fresh = await pool.acquire(endpoint, 1000, mode)
      const again = await pool.acquire(endpoint, 1000, mode)
      expect(fresh.context).not.toBe(old.context)
      expect(again.context).toBe(fresh.context)
      expect(connection.isolatedContexts).toHaveLength(3)
      expect(connection.isolatedContexts[1]?.closed).toBe(false)
      expect(connection.defaultContext.closed).toBe(false)
      expect(connection.closed).toBe(false)
      expect(calls).toHaveLength(scope === 'session' ? 2 : 1)
      expect(old.context.newPage).toHaveBeenCalledTimes(1)
      await Promise.all([fresh.release(), again.release(), sibling.release()])
    } finally { await pool.dispose() }
  })

  it('coalesces concurrent recovery after protocol-only context deletion', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    try {
      const old = await pool.acquire(endpoint, 1000, named)
      old.context.newPage = vi.fn().mockRejectedValue(new Error(MISSING_CONTEXT_ERROR))
      const leases = await Promise.all(Array.from({ length: 8 }, () => pool.acquire(endpoint, 1000, named)))
      expect(connection.isolatedContexts).toHaveLength(2)
      expect(new Set(leases.map(x => x.context)).size).toBe(1)
      expect(leases[0]?.context).not.toBe(old.context)
      expect(new Set(leases.map(x => x.page)).size).toBe(8)
      await Promise.all(leases.map(x => x.release()))
      expect(connection.isolatedContexts[0]?.closeCalls).toBe(1)
    } finally { await pool.dispose() }
  })

  it('serializes missing-context recovery before queued acquisitions reuse the replacement', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    try {
      const old = await pool.acquire(endpoint, 1000, named)
      let rejectSlow!: (error: Error) => void
      old.context.newPage = vi.fn()
        .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSlow = reject }))
        .mockRejectedValue(new Error(MISSING_CONTEXT_ERROR))
      const slow = pool.acquire(endpoint, 1000, named)
      await tick()
      const queued = pool.acquire(endpoint, 1000, named)
      await tick()
      expect(old.context.newPage).toHaveBeenCalledTimes(1)
      rejectSlow(new Error(MISSING_CONTEXT_ERROR))
      const late = await slow
      const fast = await queued
      expect(late.context).toBe(fast.context)
      expect(connection.isolatedContexts).toHaveLength(2)
      expect(connection.isolatedContexts[1]?.closed).toBe(false)
      await Promise.all([late.release(), fast.release()])
    } finally { await pool.dispose() }
  })

  it('limits protocol recovery to one retry and invalidates a failed replacement for later requests', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    try {
      const old = await pool.acquire(endpoint, 1000, named)
      old.context.newPage = vi.fn().mockRejectedValue(new Error(MISSING_CONTEXT_ERROR))
      const brokenReplacement = new FakeContext()
      brokenReplacement.context.newPage = vi.fn().mockRejectedValue(new Error(MISSING_CONTEXT_ERROR))
      connection.queueContext(brokenReplacement)
      await expect(pool.acquire(endpoint, 1000, named)).rejects.toThrow('Failed to find browser context')
      expect(connection.isolatedContexts).toHaveLength(2)
      expect(old.context.newPage).toHaveBeenCalledTimes(1)
      expect(brokenReplacement.context.newPage).toHaveBeenCalledTimes(1)
      const later = await pool.acquire(endpoint, 1000, named)
      expect(connection.isolatedContexts).toHaveLength(3)
      expect(later.context).not.toBe(brokenReplacement.context)
      await later.release()
    } finally { await pool.dispose() }
  })

  it.each([
    'Target page, context or browser has been closed',
    'Protocol error (Runtime.evaluate): Failed to find browser context with id ABC123',
    'Protocol error (Target.createTarget): Permission denied',
    'Failed to find browser context with id ABC123',
  ])('does not treat an ambiguous error as external deletion: %s', async message => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    try {
      const old = await pool.acquire(endpoint, 1000, named)
      const error = new Error(message)
      old.context.newPage = vi.fn().mockRejectedValue(error)
      await expect(pool.acquire(endpoint, 1000, named)).rejects.toBe(error)
      expect(connection.isolatedContexts).toHaveLength(1)
      expect(connection.isolatedContexts[0]?.closed).toBe(false)
    } finally { await pool.dispose() }
  })

  it('never substitutes a named context for a failed default profile', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    try {
      connection.defaultContext.context.newPage = vi.fn().mockRejectedValue(new Error(MISSING_CONTEXT_ERROR))
      await expect(pool.acquire(endpoint, 1000, 'profile')).rejects.toThrow('Failed to find browser context')
      expect(connection.isolatedContexts).toHaveLength(0)
      expect(connection.defaultContext.closeCalls).toBe(0)
    } finally { await pool.dispose() }
  })

  it('retries newPage once only after a confirmed named context close', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const a = await pool.acquire(endpoint, 1000, named)
    const context = connection.isolatedContexts[0]!
    context.context.newPage = async () => {
      context.externallyClose()
      throw new Error('Target closed')
    }
    const b = await pool.acquire(endpoint, 1000, named)
    expect(b.context).not.toBe(a.context)
    await b.release()
    await pool.dispose()
  })

  it('does not retry or discard healthy named contexts on arbitrary newPage errors', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const a = await pool.acquire(endpoint, 1000, named)
    connection.isolatedContexts[0]?.breakNextPage()
    await expect(pool.acquire(endpoint, 1000, named)).rejects.toThrow('Target closed')
    const b = await pool.acquire(endpoint, 1000, named)
    expect(b.context).toBe(a.context)
    expect(connection.isolatedContexts).toHaveLength(1)
    await b.release()
    await pool.dispose()
  })

  it('fails closed when an endpoint returns the default profile as a new context', async () => {
    const connection = new FakeConnection()
    connection.browser.newContext = async () => connection.defaultContext.context
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    await expect(pool.acquire(endpoint, 1000, named)).rejects.toThrow('distinct isolated browser context')
    expect(connection.defaultContext.pages).toHaveLength(0)
    await pool.dispose()
    expect(connection.defaultContext.closeCalls).toBe(0)
  })

  it('rejects reused context objects across sessions without closing the first session', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const first = await pool.acquire(endpoint, 1000, named)
    connection.browser.newContext = async () => first.context
    await expect(pool.acquire(endpoint, 1000, { scope: 'session', name: 'other' }))
      .rejects.toThrow('distinct isolated browser context')
    expect(connection.isolatedContexts[0]?.closed).toBe(false)
    expect(connection.isolatedContexts[0]?.pages[0]?.closed).toBe(false)
    await first.release()
    await pool.dispose()
  })

  it('failed named creation is not cached', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    connection.breakNextContext()
    await expect(pool.acquire(endpoint, 1000, named)).rejects.toThrow('Target closed')
    const lease = await pool.acquire(endpoint, 1000, named)
    expect(connection.isolatedContexts).toHaveLength(1)
    await lease.release()
    await pool.dispose()
  })

  it('reconnect creates a fresh named context', async () => {
    const first = new FakeConnection()
    const second = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(first, second).connect)
    const a = await pool.acquire(endpoint, 1000, named)
    first.drop()
    const b = await pool.acquire(endpoint, 1000, named)
    expect(b.context).not.toBe(a.context)
    expect(b.browser).toBe(second.browser)
    await Promise.all([a.release(), b.release()])
    await pool.dispose()
  })

  it.each(['policy', 'dispose'] as const)('cleans a context creation settling after %s', async change => {
    const first = new FakeConnection()
    const second = new FakeConnection()
    const late = new FakeContext()
    let settle!: (context: PlaywrightContext) => void
    first.browser.newContext = () => new Promise(resolve => { settle = resolve })
    const pool = new FakePagePool(scriptedConnect(first, second).connect)
    const pending = pool.acquire(endpoint, 1000, named)
    const failure = expect(pending).rejects.toThrow('abandoned')
    await tick()
    if (change === 'policy') pool.setPolicy('new')
    else await pool.dispose()
    const fresh = await pool.acquire(endpoint, 1000, named)
    settle(late.context)
    await failure
    await tick()
    expect(late.closed).toBe(true)
    expect(late.pages).toHaveLength(0)
    expect(fresh.browser).toBe(second.browser)
    expect(first.closed).toBe(true)
    await fresh.release()
    await pool.dispose()
  })

  it('closes a page arriving after policy retirement without returning a stale lease', async () => {
    const connection = new FakeConnection()
    const context = new FakeContext()
    const late = new FakePage()
    let settle!: (page: PlaywrightPage) => void
    context.context.newPage = () => new Promise(resolve => { settle = resolve })
    connection.queueContext(context)
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const pending = pool.acquire(endpoint, 1000, named)
    const failure = expect(pending).rejects.toThrow('abandoned')
    await tick()
    pool.setPolicy('local')
    expect(connection.closed).toBe(false)
    settle(late.page)
    await failure
    await tick()
    expect(late.closed).toBe(true)
    expect(context.closed).toBe(true)
    expect(connection.closed).toBe(true)
  })

  it('dispose closes retained contexts and disconnects even with active leases', async () => {
    const connection = new FakeConnection()
    const pool = new FakePagePool(scriptedConnect(connection).connect)
    const a = await pool.acquire(endpoint, 1000, named)
    const b = await pool.acquire(endpoint, 1000, 'profile')
    await pool.dispose()
    expect(connection.isolatedContexts[0]?.closed).toBe(true)
    expect(connection.defaultContext.closed).toBe(false)
    expect(connection.closed).toBe(true)
    await Promise.all([a.release(), b.release(), pool.dispose()])
    expect(connection.isolatedContexts[0]?.closeCalls).toBe(1)
  })

  it('retries a connection lost during acquisition even when its disconnect event fired', async () => {
    const first = new FakeConnection()
    const second = new FakeConnection()
    first.browser.newContext = async () => {
      first.drop()
      throw new Error('Target closed')
    }
    const { connect, calls } = scriptedConnect(first, second)
    const pool = new FakePagePool(connect)
    const lease = await pool.acquire(endpoint, 1000, named)
    expect(lease.browser).toBe(second.browser)
    expect(calls).toHaveLength(2)
    await lease.release()
    await pool.dispose()
  })

  it('does not reconnect an acquisition whose policy changed while the connection died', async () => {
    const first = new FakeConnection()
    const { connect, calls } = scriptedConnect(first)
    const pool = new FakePagePool(connect)
    first.browser.newContext = async () => {
      first.drop()
      pool.setPolicy('local')
      throw new Error('Target closed')
    }
    await expect(pool.acquire(endpoint, 1000, named)).rejects.toThrow('Target closed')
    expect(calls).toHaveLength(1)
    await pool.dispose()
  })

  it('bounds hung page, context and browser cleanup', async () => {
    vi.useFakeTimers()
    try {
      const connection = new FakeConnection()
      const pool = new FakePagePool(scriptedConnect(connection).connect)
      const lease = await pool.acquire(endpoint, 1000)
      lease.page.close = () => new Promise(() => {})
      lease.context.close = () => new Promise(() => {})
      connection.browser.close = () => new Promise(() => {})
      pool.setPolicy('local')
      const released = lease.release()
      await vi.advanceTimersByTimeAsync(6_001)
      await released
      await pool.dispose()
    } finally { vi.useRealTimers() }
  })
})
