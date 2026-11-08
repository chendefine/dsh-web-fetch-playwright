/** Opt-in regression for connection-scoped CDP gateways. Creates and closes only
 * test-owned connections/contexts; never navigates or closes existing tabs.
 * Set PLAYWRIGHT_TEST_CDP_ENDPOINT explicitly to enable.
 */
import { chromium } from 'playwright-core'
import type { Browser, BrowserContext, Page } from 'playwright-core'
import { describe, expect, it } from 'vitest'
import { CdpConnectionPool } from '../src/cdp-pool.ts'
import type { CdpLease } from '../src/cdp-pool.ts'
import type { PlaywrightBrowser } from '../src/types.ts'

const endpoint = process.env.PLAYWRIGHT_TEST_CDP_ENDPOINT?.trim()
const origin = 'https://dsh-isolation-test.invalid/'

async function identity(lease: CdpLease) {
  const session = await (lease.context as unknown as BrowserContext).newCDPSession(lease.page as unknown as Page)
  try {
    const { targetInfo } = await session.send('Target.getTargetInfo')
    const { windowId } = await session.send('Browser.getWindowForTarget', { targetId: targetInfo.targetId })
    return { contextId: targetInfo.browserContextId, targetId: targetInfo.targetId, windowId }
  } finally { await session.detach() }
}

async function probe(lease: CdpLease, value?: string) {
  const page = lease.page as unknown as Page
  // Fulfilled locally: no request is sent to the .invalid hostname.
  await page.route(`${origin}**`, route => route.fulfill({ contentType: 'text/html', body: '<html><body>DSH isolation verification</body></html>' }))
  await page.goto(origin)
  return await page.evaluate(value => {
    if (value) {
      document.cookie = `dsh_isolation_probe=${value}; Path=/`
      localStorage.setItem('dsh_isolation_probe', value)
    }
    return { cookie: document.cookie, storage: localStorage.getItem('dsh_isolation_probe') }
  }, value)
}

describe.skipIf(!endpoint)('configured connection-scoped CDP gateway', () => {
  it('separates sessions, shares same-session tabs, and reconnects after idle close', async () => {
    let connects = 0
    const pool = new CdpConnectionPool(async (url, timeout) => {
      connects++
      return await chromium.connectOverCDP(url, { timeout }) as unknown as PlaywrightBrowser
    })
    const mode = (name: string) => ({ scope: 'session' as const, name: `gateway-test-${name}` })
    try {
      const [a, b] = await Promise.all([
        pool.acquire(endpoint!, 20_000, mode('A')),
        pool.acquire(endpoint!, 20_000, mode('B')),
      ])
      const a2 = await pool.acquire(endpoint!, 20_000, mode('A'))
      const [ia, ib, ia2] = await Promise.all([identity(a), identity(b), identity(a2)])
      expect(connects).toBe(2)
      expect(a.browser).not.toBe(b.browser)
      expect(a.browser).toBe(a2.browser)
      expect(ia.contextId).not.toBe(ib.contextId)
      expect(ia.contextId).toBe(ia2.contextId)
      expect(ia.windowId).toBe(ia2.windowId)
      // Numeric window IDs are process-local; cloned Chromium processes may
      // reuse the same number, so never compare them across gateway connections.
      await probe(a, 'ALPHA')
      expect(await probe(a2)).toMatchObject({ cookie: expect.stringContaining('dsh_isolation_probe=ALPHA'), storage: 'ALPHA' })
      expect(await probe(b)).toEqual({ cookie: '', storage: null })
      await a.release()
      expect((a2.page as unknown as Page).isClosed()).toBe(false)
      expect((b.page as unknown as Page).isClosed()).toBe(false)
      await a2.release()
      expect((a.browser as unknown as Browser).isConnected()).toBe(false)
      expect((b.browser as unknown as Browser).isConnected()).toBe(true)
      const next = await pool.acquire(endpoint!, 20_000, mode('A'))
      expect(connects).toBe(3)
      expect((await identity(next)).contextId).not.toBe(ia.contextId)
      expect(await probe(next)).toEqual({ cookie: '', storage: null })
      await Promise.all([next.release(), b.release()])
      expect((next.browser as unknown as Browser).isConnected()).toBe(false)
      expect((b.browser as unknown as Browser).isConnected()).toBe(false)
    } finally { await pool.dispose() }
  }, 90_000)
})
