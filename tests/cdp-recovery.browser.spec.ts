/** Real CDP regression: deleting an idle named context outside its owning
 * Playwright connection must not poison the pool. No live DSH configuration or
 * shared browser is used. Set PLAYWRIGHT_TEST_EXECUTABLE_PATH to an installed
 * Chromium executable; otherwise this suite genuinely skips if none is present.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core'
import { describe, expect, it, vi } from 'vitest'
import { CdpConnectionPool } from '../src/cdp-pool.ts'
import type { CdpAcquireMode, CdpLease } from '../src/cdp-pool.ts'
import type { PlaywrightBrowser } from '../src/types.ts'
import { resolveConfig } from '../src/config.ts'
import { PlaywrightFetchProvider } from '../src/provider.ts'

const configuredExecutable = process.env.PLAYWRIGHT_TEST_EXECUTABLE_PATH?.trim()
const executablePath = configuredExecutable || chromium.executablePath()
// Explicitly configured paths must fail if invalid; runtime launch/protocol
// errors are also failures, not reasons to silently mark the tests green.
const noInstalledBrowser = !configuredExecutable && !existsSync(executablePath)

type NamedMode = Exclude<CdpAcquireMode, string>
interface Probe {
  beforeCookie: string | null
  beforeStorage: string | null
  cookie: string
  localStorage: string
}
interface Fixture {
  endpoint: string
  origin: string
  owner: BrowserContext
  observer: Browser
  cdp: CDPSession
  pool: CdpConnectionPool
  records: Map<string, Probe>
}

const PROBE = `<!doctype html><html><head><title>Context recovery probe</title></head><body><main><pre id="probe"></pre></main><script>
(async () => {
  const q = new URLSearchParams(location.search);
  const cookie = document.cookie.split('; ').find(x => x.startsWith('recovery='))?.slice('recovery='.length) || null;
  const storage = localStorage.getItem('recovery');
  const value = q.get('seed') || cookie || crypto.randomUUID();
  document.cookie = 'recovery=' + value + '; Path=/; SameSite=Lax';
  if (q.has('seed') || !storage) localStorage.setItem('recovery', value);
  const result = {beforeCookie: cookie, beforeStorage: storage, cookie: value, localStorage: localStorage.getItem('recovery')};
  document.querySelector('#probe').textContent = JSON.stringify(result);
  await fetch('/record?case=' + encodeURIComponent(q.get('case')), {method:'POST', body:JSON.stringify(result)});
  document.documentElement.dataset.recorded = 'true';
})();
</script></body></html>`

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const records = new Map<string, Probe>()
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/record') {
      let body = ''
      for await (const part of req) body += String(part)
      records.set(url.searchParams.get('case') ?? '', JSON.parse(body) as Probe)
      res.end('ok')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PROBE)
  })
  const profile = await mkdtemp(join(tmpdir(), 'dsh-cdp-recovery-'))
  let owner: BrowserContext | undefined
  let observer: Browser | undefined
  let pool: CdpConnectionPool | undefined
  try {
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('test HTTP server has no port')
    const origin = `http://127.0.0.1:${String(address.port)}`
    owner = await chromium.launchPersistentContext(profile, {
      executablePath,
      headless: process.env.PLAYWRIGHT_TEST_HEADED !== '1',
      args: ['--remote-debugging-port=0'],
      timeout: 20_000,
    })
    let port = ''
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0] ?? ''
        if (/^\d+$/.test(port)) break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await delay(50)
    }
    if (!/^\d+$/.test(port)) throw new Error('dedicated Chromium did not expose a CDP port')
    const endpoint = `http://127.0.0.1:${port}`
    observer = await chromium.connectOverCDP(endpoint)
    const cdp = await observer.newBrowserCDPSession()
    // Use the actual browser, not a fake adapter. Recent Playwright route()
    // returns Disposable whereas the plugin's intentionally minimal structural
    // facade ignores that return value; bridge only this type-level difference.
    pool = new CdpConnectionPool(async (url, timeout) =>
      await chromium.connectOverCDP(url, { timeout }) as unknown as PlaywrightBrowser)
    await run({ endpoint, origin, owner, observer, cdp, pool, records })
  } finally {
    // All resources are owned by this individual test, even after assertions
    // reject; closing the observer is not the fault-injection mechanism.
    await pool?.dispose().catch(() => {})
    await observer?.close().catch(() => {})
    await owner?.close().catch(() => {})
    server.closeAllConnections()
    await new Promise<void>(resolveClose => { server.close(() => resolveClose()) })
    const absolute = await realpath(profile)
    if (absolute !== resolve(profile) || dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith('dsh-cdp-recovery-')) {
      throw new Error(`refusing to remove unexpected test profile: ${absolute}`)
    }
    await rm(absolute, { recursive: true, force: true })
  }
}

async function pageProbe(page: Page, fixture: Fixture, name: string, seed?: string): Promise<Probe> {
  const url = new URL('/probe', fixture.origin)
  url.searchParams.set('case', name)
  if (seed !== undefined) url.searchParams.set('seed', seed)
  await page.goto(url.toString())
  await page.waitForFunction(() => document.documentElement.dataset.recorded === 'true')
  return JSON.parse(await page.locator('#probe').innerText()) as Probe
}

/** Read the real id while the lease owns a page; never use private PW fields. */
async function contextId(lease: CdpLease): Promise<string> {
  const context = lease.context as unknown as BrowserContext
  const session = await context.newCDPSession(lease.page as unknown as Page)
  try {
    const { targetInfo } = await session.send('Target.getTargetInfo')
    if (!targetInfo.browserContextId) throw new Error('test lease has no CDP context id')
    return targetInfo.browserContextId
  } finally { await session.detach() }
}

async function seedNamed(fixture: Fixture, mode: NamedMode, marker: string): Promise<string> {
  const lease = await fixture.pool.acquire(fixture.endpoint, 10_000, mode)
  try {
    await pageProbe(lease.page as unknown as Page, fixture, `seed-${marker}`, marker)
    // Keep a real tab open so session scope is not intentionally disposed at
    // release; fixture teardown owns this anchor tab.
    if (mode.scope === 'session') await lease.context.newPage()
    return await contextId(lease)
  } finally { await lease.release() }
}

async function assertNamedMarker(fixture: Fixture, mode: NamedMode, marker: string, id: string): Promise<void> {
  const lease = await fixture.pool.acquire(fixture.endpoint, 10_000, mode)
  try {
    expect(await contextId(lease)).toBe(id)
    const state = await pageProbe(lease.page as unknown as Page, fixture, `verify-${marker}`)
    expect(state.beforeCookie).toBe(marker)
    expect(state.beforeStorage).toBe(marker)
  } finally { await lease.release() }
}

async function assertDefaultMarker(fixture: Fixture, marker: string): Promise<void> {
  const page = await fixture.owner.newPage()
  try {
    const result = await pageProbe(page, fixture, `default-${marker}`)
    expect(result.beforeCookie).toBe(marker)
    expect(result.beforeStorage).toBe(marker)
  } finally { await page.close() }
}

async function seedDefault(fixture: Fixture): Promise<void> {
  const page = await fixture.owner.newPage()
  try { await pageProbe(page, fixture, 'default-seed', 'DEFAULT-PROFILE') } finally { await page.close() }
}

async function deleteExternally(fixture: Fixture, id: string): Promise<void> {
  expect((await fixture.cdp.send('Target.getBrowserContexts')).browserContextIds).toContain(id)
  // Essential regression condition: NOT lease.context.close(), which would
  // notify the owning Playwright client and hide the stale-handle bug.
  await fixture.cdp.send('Target.disposeBrowserContext', { browserContextId: id })
  expect((await fixture.cdp.send('Target.getBrowserContexts')).browserContextIds).not.toContain(id)
}

async function windowId(fixture: Fixture, lease: CdpLease): Promise<number> {
  const session = await (lease.context as unknown as BrowserContext).newCDPSession(lease.page as unknown as Page)
  try {
    const { targetInfo } = await session.send('Target.getTargetInfo')
    return (await fixture.cdp.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId })).windowId
  } finally { await session.detach() }
}

describe.skipIf(noInstalledBrowser)('real CDP external context deletion recovery', () => {
  it('isolates concurrent DSH sessions by actual context, window, cookies and localStorage', async () => {
    await withFixture(async fixture => {
      const alpha = { scope: 'session', name: 'alpha' } as const
      const beta = { scope: 'session', name: 'beta' } as const
      const [a, b] = await Promise.all([
        fixture.pool.acquire(fixture.endpoint, 10_000, alpha),
        fixture.pool.acquire(fixture.endpoint, 10_000, beta),
      ])
      const a2 = await fixture.pool.acquire(fixture.endpoint, 10_000, alpha)
      const [aId, bId, a2Id] = await Promise.all([a, b, a2].map(contextId))
      const [aWindow, bWindow, a2Window] = await Promise.all([a, b, a2].map(lease => windowId(fixture, lease)))
      expect(aId).not.toBe(bId)
      expect(a2Id).toBe(aId)
      expect(aWindow).not.toBe(bWindow)
      expect(a2Window).toBe(aWindow)
      await pageProbe(a.page as unknown as Page, fixture, 'alpha-seed', 'ALPHA')
      const isolated = await pageProbe(b.page as unknown as Page, fixture, 'beta-seed', 'BETA')
      expect(isolated).toMatchObject({ beforeCookie: null, beforeStorage: null })
      const shared = await pageProbe(a2.page as unknown as Page, fixture, 'alpha-shared')
      expect(shared).toMatchObject({ beforeCookie: 'ALPHA', beforeStorage: 'ALPHA' })
      await a.release()
      expect((a2.page as unknown as Page).isClosed()).toBe(false)
      expect((b.page as unknown as Page).isClosed()).toBe(false)
      expect((await fixture.cdp.send('Target.getBrowserContexts')).browserContextIds).toContain(aId)
      await a2.release()
      const afterAlpha = (await fixture.cdp.send('Target.getBrowserContexts')).browserContextIds
      expect(afterAlpha).not.toContain(aId)
      expect(afterAlpha).toContain(bId)
      const fresh = await fixture.pool.acquire(fixture.endpoint, 10_000, alpha)
      expect(await contextId(fresh)).not.toBe(aId)
      const reset = await pageProbe(fresh.page as unknown as Page, fixture, 'alpha-reset')
      expect(reset).toMatchObject({ beforeCookie: null, beforeStorage: null })
      await Promise.all([fresh.release(), b.release()])
      expect((await fixture.cdp.send('Target.getBrowserContexts')).browserContextIds).toHaveLength(0)
    })
  }, 60_000)

  it('routes concurrent provider calls by their captured DSH session identity', async () => {
    await withFixture(async fixture => {
      const identity = new AsyncLocalStorage<string>()
      const provider = new PlaywrightFetchProvider(() => resolveConfig({
        backend: 'cdp', cdpEndpoint: fixture.endpoint, shareBrowserContext: false,
        contextIsolationScope: 'session', denoise: false, challengeWaitMs: 0, maxConcurrency: 4,
      }), fixture.pool, () => identity.getStore())
      const captured: Array<{ name: string; lease: CdpLease }> = []
      let ready!: () => void
      let proceed!: () => void
      const allReady = new Promise<void>(resolve => { ready = resolve })
      const gate = new Promise<void>(resolve => { proceed = resolve })
      const original = fixture.pool.acquire.bind(fixture.pool)
      const spy = vi.spyOn(fixture.pool, 'acquire').mockImplementation(async (url, timeout, mode) => {
        const lease = await original(url, timeout, mode)
        captured.push({ name: typeof mode === 'object' ? mode.name : '', lease })
        if (captured.length === 4) ready()
        await gate
        return lease
      })
      const requests = ['A', 'B', 'A', 'B'].map((id, index) => identity.run(id,
        () => provider.fetch({ url: `${fixture.origin}/probe?case=provider-${index}` })))
      const results = Promise.all(requests)
      // Surface setup failures rather than waiting forever on the test barrier.
      try {
        await Promise.race([allReady, results])
        expect(captured).toHaveLength(4)
        const metadata = await Promise.all(captured.map(async ({ name, lease }) => ({
          name, context: await contextId(lease), window: await windowId(fixture, lease),
        })))
        for (const name of ['A', 'B']) {
          expect(new Set(metadata.filter(item => item.name === name).map(item => item.context)).size).toBe(1)
          expect(new Set(metadata.filter(item => item.name === name).map(item => item.window)).size).toBe(1)
        }
        expect(new Set(metadata.map(item => item.context)).size).toBe(2)
        expect(new Set(metadata.map(item => item.window)).size).toBe(2)
        proceed()
        for (const result of await results) expect(result.statusCode).toBe(200)
        expect((await fixture.cdp.send('Target.getBrowserContexts')).browserContextIds).toHaveLength(0)
      } finally {
        proceed()
        await Promise.allSettled(requests)
        spy.mockRestore()
        await provider.dispose()
      }
    })
  }, 60_000)

  it('survives simultaneous last-release and new acquisitions without closing their tabs', async () => {
    await withFixture(async fixture => {
      const mode = { scope: 'session', name: 'racing' } as const
      let current = await fixture.pool.acquire(fixture.endpoint, 10_000, mode)
      for (let round = 0; round < 8; round++) {
        const closing = current.release()
        const next = await Promise.all(Array.from({ length: 4 }, () => fixture.pool.acquire(fixture.endpoint, 10_000, mode)))
        await closing
        expect(new Set(await Promise.all(next.map(contextId))).size).toBe(1)
        expect(new Set(await Promise.all(next.map(lease => windowId(fixture, lease)))).size).toBe(1)
        await Promise.all(next.map(async (lease, index) => {
          const page = lease.page as unknown as Page
          await page.goto(`${fixture.origin}/probe?case=race-${round}-${index}`)
          expect(page.isClosed()).toBe(false)
        }))
        current = next[0]!
        await Promise.all(next.slice(1).map(lease => lease.release()))
        expect((current.page as unknown as Page).isClosed()).toBe(false)
      }
      await current.release()
      expect((await fixture.cdp.send('Target.getBrowserContexts')).browserContextIds).toHaveLength(0)
    })
  }, 60_000)

  it.each(['session', 'global'] as const)('provider %s mode: two later fetches recover without resetting unrelated state', async scope => {
    await withFixture(async fixture => {
      const config = resolveConfig({ backend: 'cdp', cdpEndpoint: fixture.endpoint, shareBrowserContext: false,
        contextIsolationScope: scope, denoise: false, challengeWaitMs: 0 })
      const provider = new PlaywrightFetchProvider(() => config, fixture.pool, () => 'session-primary')
      const affected: NamedMode = { scope, name: scope === 'session' ? 'session-primary' : 'global' }
      const unrelated: NamedMode = { scope, name: 'unrelated' }
      try {
        // Let the real provider establish its policy before directly acquiring
        // supplementary leases on the same pool.
        await provider.fetch({ url: `${fixture.origin}/probe?case=initial&seed=OLD-AFFECTED` })
        const oldId = await seedNamed(fixture, affected, 'OLD-AFFECTED')
        const unrelatedId = await seedNamed(fixture, unrelated, 'UNRELATED')
        await seedDefault(fixture)
        await deleteExternally(fixture, oldId)

        const first = await provider.fetch({ url: `${fixture.origin}/probe?case=recovered-first` })
        const second = await provider.fetch({ url: `${fixture.origin}/probe?case=recovered-second` })
        expect(first.statusCode).toBe(200)
        expect(second.statusCode).toBe(200)
        const firstState = fixture.records.get('recovered-first')
        const secondState = fixture.records.get('recovered-second')
        expect(firstState).toMatchObject({ beforeCookie: null, beforeStorage: null })
        expect(firstState?.cookie).not.toBe('OLD-AFFECTED')
        expect(secondState).toMatchObject(scope === 'session'
          ? { beforeCookie: null, beforeStorage: null }
          : { beforeCookie: firstState?.cookie, beforeStorage: firstState?.localStorage })
        const replacement = await fixture.pool.acquire(fixture.endpoint, 10_000, affected)
        try { expect(await contextId(replacement)).not.toBe(oldId) } finally { await replacement.release() }
        await assertNamedMarker(fixture, unrelated, 'UNRELATED', unrelatedId)
        await assertDefaultMarker(fixture, 'DEFAULT-PROFILE')
        expect(fixture.observer.isConnected()).toBe(true)
        expect(fixture.owner.pages()).not.toHaveLength(0)
      } finally { await provider.dispose() }
    })
  }, 60_000)

  it.each(['session', 'global'] as const)('pool %s mode: concurrent acquisitions create exactly one replacement', async scope => {
    await withFixture(async fixture => {
      const affected: NamedMode = { scope, name: 'concurrent-primary' }
      const unrelated: NamedMode = { scope, name: 'concurrent-unrelated' }
      const oldId = await seedNamed(fixture, affected, 'OLD-CONCURRENT')
      const unrelatedId = await seedNamed(fixture, unrelated, 'UNRELATED-CONCURRENT')
      await seedDefault(fixture)
      await deleteExternally(fixture, oldId)
      const baselineIds = (await fixture.cdp.send('Target.getBrowserContexts')).browserContextIds
      // allSettled ensures even a broken implementation's partially successful
      // acquisitions are released in finally rather than leaked by Promise.all.
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => fixture.pool.acquire(fixture.endpoint, 10_000, affected)))
      const leases = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
      try {
        const failure = results.find(result => result.status === 'rejected')
        if (failure?.status === 'rejected') throw failure.reason
        expect(leases).toHaveLength(6)
        const ids = await Promise.all(leases.map(contextId))
        expect(new Set(ids).size).toBe(1)
        expect(ids[0]).not.toBe(oldId)
        const afterIds = (await fixture.cdp.send('Target.getBrowserContexts')).browserContextIds
        expect(afterIds.filter(id => !baselineIds.includes(id))).toEqual([ids[0]])
        const fresh = await pageProbe(leases[0]!.page as unknown as Page, fixture, 'concurrent-fresh', 'REPLACEMENT')
        expect(fresh).toMatchObject({ beforeCookie: null, beforeStorage: null })
        for (const lease of leases.slice(1)) {
          const state = await pageProbe(lease.page as unknown as Page, fixture, 'concurrent-reuse')
          expect(state).toMatchObject({ beforeCookie: 'REPLACEMENT', beforeStorage: 'REPLACEMENT' })
        }
        await assertNamedMarker(fixture, unrelated, 'UNRELATED-CONCURRENT', unrelatedId)
        await assertDefaultMarker(fixture, 'DEFAULT-PROFILE')
      } finally { await Promise.all(leases.map(lease => lease.release())) }
    })
  }, 60_000)
})
