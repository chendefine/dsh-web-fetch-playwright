import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { createSessionPage } from '../src/session-window.ts'
import type { PlaywrightBrowser, PlaywrightContext, PlaywrightPage } from '../src/types.ts'

function fixture() {
  const events = new EventEmitter()
  const pages: PlaywrightPage[] = []
  const identities = new Map<PlaywrightPage, { targetId: string; browserContextId: string; windowId: number }>()
  let sequence = 0
  const options = { ignoreNewWindow: false, omitEvent: false, unrelatedFirst: false, wrongNextWindow: false, failCreate: false }
  const make = (windowId: number, targetId = `page-${++sequence}`) => {
    const page = { close: vi.fn(async () => { const at = pages.indexOf(page); if (at >= 0) pages.splice(at, 1) }) } as unknown as PlaywrightPage
    pages.push(page)
    identities.set(page, { targetId, browserContextId: 'session-context', windowId })
    return page
  }
  const root = {
    send: vi.fn(async (method: string, params?: Record<string, unknown>): Promise<any> => {
      if (method === 'Browser.getWindowForTarget') {
        const info = [...identities.values()].find(info => info.targetId === params?.targetId)
        if (!info) throw new Error('missing target')
        return { windowId: info.windowId }
      }
      if (method === 'Target.createTarget') {
        if (options.failCreate) throw new Error('unsupported newWindow')
        if (options.omitEvent) return { targetId: 'unobserved-target' }
        if (options.unrelatedFirst) events.emit('page', make(99, 'unrelated'))
        const page = make(options.ignoreNewWindow ? 1 : 2, 'explicit-target')
        events.emit('page', page) // Deliberately before CDP response.
        return { targetId: 'explicit-target' }
      }
      return {}
    }),
    detach: vi.fn(async () => {}),
  }
  const context = Object.assign(events, {
    pages: () => [...pages],
    newPage: vi.fn(async () => make(options.wrongNextWindow ? 88 : (pages.length ? identities.get(pages[0]!)!.windowId : 1))),
    newCDPSession: vi.fn(async (page: PlaywrightPage) => ({
      send: async (method: string, params?: Record<string, unknown>) => method === 'Target.getTargetInfo'
        ? { targetInfo: identities.get(page) } : root.send(method, params),
      detach: vi.fn(async () => {}),
    })),
  }) as unknown as PlaywrightContext
  const browser = { newBrowserCDPSession: async () => root } as unknown as PlaywrightBrowser
  return { context, browser, root, pages, identities, options, make, events }
}

describe('dedicated session windows through public CDP APIs', () => {
  it('creates a new window in the exact Playwright context, closes bootstrap, detaches sessions', async () => {
    const f = fixture()
    const page = await createSessionPage(f.context, f.browser, 100)
    expect(f.identities.get(page)?.targetId).toBe('explicit-target')
    expect(f.pages).toEqual([page])
    expect(f.root.send).toHaveBeenCalledWith('Target.createTarget', {
      url: 'about:blank', browserContextId: 'session-context', newWindow: true,
    })
    expect(f.root.detach).toHaveBeenCalledOnce()
    expect(f.events.listenerCount('page')).toBe(0)
  })

  it('routes explicit creation through the page session for multiplexing CDP gateways', async () => {
    const f = fixture()
    const backend = f.root.send.getMockImplementation()!
    f.root.send.mockImplementation(async (method, params) => {
      if (method === 'Target.createTarget') throw new Error('browser session routes context ID to the wrong Chromium')
      return backend(method, params)
    })
    const pageSend = vi.fn(async (page: PlaywrightPage, method: string, params?: Record<string, unknown>) => {
      if (method === 'Target.getTargetInfo') return { targetInfo: f.identities.get(page) }
      return backend(method, params)
    })
    Object.assign(f.context, { newCDPSession: async (page: PlaywrightPage) => ({
      send: (method: string, params?: Record<string, unknown>) => pageSend(page, method, params),
      detach: async () => {},
    }) })
    const page = await createSessionPage(f.context, f.browser, 100)
    expect(f.identities.get(page)?.targetId).toBe('explicit-target')
    expect(pageSend).toHaveBeenCalledWith(expect.anything(), 'Target.createTarget', {
      url: 'about:blank', browserContextId: 'session-context', newWindow: true,
    })
    expect(f.root.send.mock.calls.some(([method]) => method === 'Target.createTarget')).toBe(false)
  })

  it('matches exact target ID rather than the first page event', async () => {
    const f = fixture()
    f.options.unrelatedFirst = true
    const page = await createSessionPage(f.context, f.browser, 100)
    expect(f.identities.get(page)?.targetId).toBe('explicit-target')
    expect(f.pages.some(page => f.identities.get(page)?.targetId === 'unrelated')).toBe(true)
  })

  it('reuses the one verified session window for subsequent tabs', async () => {
    const f = fixture()
    const first = await createSessionPage(f.context, f.browser, 100)
    const second = await createSessionPage(f.context, f.browser, 100)
    expect(f.identities.get(first)?.windowId).toBe(f.identities.get(second)?.windowId)
    expect(f.root.send.mock.calls.filter(([method]) => method === 'Target.createTarget')).toHaveLength(1)
  })

  it('fails closed and closes a subsequent tab placed in the wrong window', async () => {
    const f = fixture()
    const first = await createSessionPage(f.context, f.browser, 100)
    f.options.wrongNextWindow = true
    await expect(createSessionPage(f.context, f.browser, 100)).rejects.toThrow('dedicated window')
    expect(f.pages).toEqual([first])
  })

  it('rejects ambiguous contexts already spanning multiple windows', async () => {
    const f = fixture()
    f.make(1); f.make(2)
    await expect(createSessionPage(f.context, f.browser, 100)).rejects.toThrow('multiple windows')
    expect(f.context.newPage).not.toHaveBeenCalled()
  })

  it('rejects ignored newWindow instead of silently accepting a tab', async () => {
    const f = fixture()
    f.options.ignoreNewWindow = true
    await expect(createSessionPage(f.context, f.browser, 100)).rejects.toThrow('ignored')
    expect(f.pages).toHaveLength(0)
    expect(f.root.send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'explicit-target' })
  })

  it('closes an unobserved target on page timeout and removes event listeners', async () => {
    const f = fixture()
    f.options.omitEvent = true
    await expect(createSessionPage(f.context, f.browser, 5)).rejects.toThrow('timed out')
    expect(f.root.send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'unobserved-target' })
    expect(f.pages).toHaveLength(0)
    expect(f.events.listenerCount('page')).toBe(0)
  })

  it('cleans bootstrap after unsupported CDP commands without profile fallback', async () => {
    const f = fixture()
    f.options.failCreate = true
    await expect(createSessionPage(f.context, f.browser, 100)).rejects.toThrow('unsupported newWindow')
    expect(f.pages).toHaveLength(0)
    expect(f.events.listenerCount('page')).toBe(0)
  })

  it('rejects the default profile context', async () => {
    const f = fixture()
    f.browser.contexts = () => [f.context]
    await expect(createSessionPage(f.context, f.browser, 100)).rejects.toThrow('default browser profile')
    expect(f.context.newPage).not.toHaveBeenCalled()
  })

  it('rejects a second context handle exposing an already owned context identity', async () => {
    const f = fixture()
    await createSessionPage(f.context, f.browser, 100)
    const other = fixture()
    await expect(createSessionPage(other.context, f.browser, 100)).rejects.toThrow('already owned')
    expect(other.pages).toHaveLength(0)
  })

  it('releases identity ownership when its context closes', async () => {
    const f = fixture()
    await createSessionPage(f.context, f.browser, 100)
    f.events.emit('close')
    const other = fixture()
    Object.assign(f.browser, { newBrowserCDPSession: async () => other.root })
    await expect(createSessionPage(other.context, f.browser, 100)).resolves.toBeDefined()
  })

  it('bounds hung newPage, closes its late page, and never closes sibling leases', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      const sibling = f.make(1)
      let resolve!: (page: PlaywrightPage) => void
      f.context.newPage = vi.fn(() => new Promise<PlaywrightPage>(resolvePage => { resolve = resolvePage }))
      f.context.close = vi.fn(async () => {})
      const result = expect(createSessionPage(f.context, f.browser, 10)).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(300)
      await result
      const late = f.make(1)
      resolve(late)
      await vi.advanceTimersByTimeAsync(300)
      expect(late.close).toHaveBeenCalled()
      expect(sibling.close).not.toHaveBeenCalled()
      expect(f.context.close).not.toHaveBeenCalled()
      await expect(createSessionPage(f.context, f.browser, 10)).rejects.toThrow('unavailable')
    } finally { vi.useRealTimers() }
  })

  it('bounds a hung createTarget response and closes the late target through a new root session', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      const original = f.root.send.getMockImplementation()!
      let resolve!: (value: { targetId: string }) => void
      f.root.send.mockImplementation(async (method, params) => method === 'Target.createTarget'
        ? await new Promise(resolveTarget => { resolve = resolveTarget }) : original(method, params))
      const newRoot = vi.fn(async () => f.root)
      Object.assign(f.browser, { newBrowserCDPSession: newRoot })
      const result = expect(createSessionPage(f.context, f.browser, 10)).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(300)
      await result
      resolve({ targetId: 'late-explicit' })
      await vi.advanceTimersByTimeAsync(300)
      expect(newRoot).toHaveBeenCalledTimes(2)
      expect(f.root.send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'late-explicit' })
      expect(f.events.listenerCount('page')).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('bounds a hung identity CDP send and hung session detach', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      const detach = vi.fn(() => new Promise<void>(() => {}))
      Object.assign(f.context, { newCDPSession: async () => ({ send: () => new Promise(() => {}), detach }) })
      const result = expect(createSessionPage(f.context, f.browser, 10)).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(500)
      await result
      expect(detach).toHaveBeenCalled()
      expect(f.pages).toHaveLength(0)
    } finally { vi.useRealTimers() }
  })

  it('bounds hung bootstrap close and root detach during failure cleanup', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      const original = f.context.newPage
      f.context.newPage = async () => {
        const page = await original()
        page.close = vi.fn(() => new Promise<void>(() => {}))
        return page
      }
      f.root.detach.mockImplementation(() => new Promise<void>(() => {}))
      const result = expect(createSessionPage(f.context, f.browser, 10)).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(500)
      await result
      expect(f.root.send).toHaveBeenCalledWith('Target.closeTarget', { targetId: 'explicit-target' })
      expect(f.events.listenerCount('page')).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('detaches a browser CDP session that arrives after its setup deadline', async () => {
    vi.useFakeTimers()
    try {
      const f = fixture()
      let resolve!: (session: typeof f.root) => void
      Object.assign(f.browser, { newBrowserCDPSession: () => new Promise(resolveSession => { resolve = resolveSession }) })
      const result = expect(createSessionPage(f.context, f.browser, 10)).rejects.toThrow('timed out')
      await vi.advanceTimersByTimeAsync(300)
      await result
      resolve(f.root)
      await vi.advanceTimersByTimeAsync(300)
      expect(f.root.detach).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('requires CDP capabilities instead of silently using plain newPage', async () => {
    const f = fixture()
    await expect(createSessionPage(f.context, {} as PlaywrightBrowser, 100)).rejects.toThrow('requires Playwright Chromium CDP')
    expect(f.context.newPage).not.toHaveBeenCalled()
  })
})
