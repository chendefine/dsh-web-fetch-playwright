/** Explicit CDP window allocation for session-owned Playwright contexts. */
import type { PlaywrightBrowser, PlaywrightContext, PlaywrightPage } from './types.ts'

interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>
  detach(): Promise<void>
}
interface WindowContext {
  newCDPSession(page: PlaywrightPage): Promise<CdpSession>
  pages(): PlaywrightPage[]
  on(event: 'page', listener: (page: PlaywrightPage) => void): unknown
  removeListener(event: 'page', listener: (page: PlaywrightPage) => void): unknown
}
interface WindowBrowser { newBrowserCDPSession(): Promise<CdpSession> }
interface TargetIdentity { targetId: string; browserContextId: string }

// Weak ownership plus close-event pruning prevents retaining completed sessions.
const ownership = new WeakMap<PlaywrightBrowser, Map<string, WeakRef<PlaywrightContext>>>()
// Never adopt an unconfirmed late tab after timing out, nor close sibling leases.
const unavailable = new WeakSet<PlaywrightContext>()
// Identities confirmed when each session tab was created. Re-identifying a busy
// sibling would attach to it, and detaching from a tab mid-navigation can stall
// until its response arrives; a target id and its context never change.
const identities = new WeakMap<PlaywrightPage, TargetIdentity>()
const CLEANUP_GRACE_MS = 100

function claim(browser: PlaywrightBrowser, context: PlaywrightContext, keys: string[]): void {
  let owners = ownership.get(browser)
  if (!owners) { owners = new Map(); ownership.set(browser, owners) }
  for (const [key, reference] of owners) if (!reference.deref()) owners.delete(key)
  for (const key of keys) {
    const previous = owners.get(key)?.deref()
    if (previous && previous !== context) throw new Error('session context or window identity is already owned by another session context')
  }
  const reference = new WeakRef(context)
  const added = keys.filter(key => !owners!.has(key))
  for (const key of added) owners.set(key, reference)
  if (added.length) context.on?.('close', () => {
    for (const key of added) if (owners!.get(key) === reference) owners!.delete(key)
  })
}

/** Bound a promise without abandoning responsibility for resources arriving late. */
class SetupDeadline {
  private readonly end: number
  stopped = false
  constructor(timeoutMs: number, private readonly expired: () => void) {
    this.end = Date.now() + Math.max(1, timeoutMs)
  }
  run<T>(operation: () => Promise<T>, late?: (value: T) => Promise<unknown>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('session window setup has finished'))
    if (Date.now() >= this.end) {
      this.expired()
      return Promise.reject(new Error('timed out creating the dedicated session window'))
    }
    return new Promise<T>((resolve, reject) => {
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        if (!this.stopped) this.expired()
        reject(new Error('timed out creating the dedicated session window'))
      }, Math.max(1, this.end - Date.now()))
      void Promise.resolve().then(operation).then(value => {
        clearTimeout(timer)
        if (timedOut) { if (late) void Promise.resolve().then(() => late(value)).catch(() => {}); return }
        resolve(value)
      }, error => { clearTimeout(timer); if (!timedOut) reject(error) })
    })
  }
}

/** Cleanup must never hold a pool lock indefinitely, including detach itself. */
async function cleanup(operation: () => Promise<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    Promise.resolve().then(operation).catch(() => {}),
    new Promise<void>(resolve => { timer = setTimeout(resolve, CLEANUP_GRACE_MS) }),
  ])
  if (timer) clearTimeout(timer)
}

/**
 * Caller serializes creation and release for this context. A bootstrap supplies
 * its public CDP identity; the real first tab explicitly requests a NEW window.
 * Subsequent tabs must match that window. Never falls back to the profile.
 * On timeout only owned pages/targets are cleaned; existing leases stay alive.
 */
export async function createSessionPage(
  context: PlaywrightContext,
  browser: PlaywrightBrowser,
  timeoutMs: number,
): Promise<PlaywrightPage> {
  const ctx = context as PlaywrightContext & WindowContext
  const owner = browser as PlaywrightBrowser & WindowBrowser
  if (typeof owner.newBrowserCDPSession !== 'function' || typeof ctx.newCDPSession !== 'function'
    || typeof ctx.pages !== 'function' || typeof ctx.on !== 'function' || typeof ctx.removeListener !== 'function') {
    throw new Error('session window isolation requires Playwright Chromium CDP session and page event APIs')
  }
  if (browser.contexts?.()[0] === context) throw new Error('session window isolation must not use the default browser profile context')
  if (unavailable.has(context)) throw new Error('session window context is unavailable after a setup timeout')
  const deadline = new SetupDeadline(timeoutMs, () => unavailable.add(context))
  const sessions = new Set<CdpSession>()
  let root: CdpSession | undefined
  let bootstrap: PlaywrightPage | undefined
  let bootstrapTargetId: string | undefined
  let created: PlaywrightPage | undefined
  let targetId: string | undefined
  let listener: ((page: PlaywrightPage) => void) | undefined
  let succeeded = false
  const detach = (session: CdpSession) => cleanup(() => session.detach())
  const closePage = (page: PlaywrightPage) => cleanup(() => page.close())
  const newSession = async (operation: () => Promise<CdpSession>) => {
    const session = await deadline.run(operation, detach)
    if (deadline.stopped) { await detach(session); throw new Error('session window setup has finished') }
    sessions.add(session)
    return session
  }
  const identify = async (page: PlaywrightPage): Promise<TargetIdentity> => {
    const known = identities.get(page)
    if (known) return known
    const session = await newSession(() => ctx.newCDPSession(page))
    let identificationFailed = false
    try {
      const { targetInfo } = await deadline.run(() => session.send('Target.getTargetInfo'))
      if (!targetInfo?.targetId || !targetInfo.browserContextId) throw new Error('session window isolation requires a target and browser context identity')
      return targetInfo
    } catch (error) {
      identificationFailed = true
      throw error
    } finally {
      // Bounded by the SAME setup deadline; a stuck detach is not an unbounded
      // finally. Keep it tracked so outer cleanup can retry best-effort.
      try {
        await deadline.run(() => session.detach())
        sessions.delete(session)
      } catch (error) { if (!identificationFailed) throw error }
    }
  }
  const windowOf = async (id: string): Promise<number> => {
    const { windowId } = await deadline.run(() => root!.send('Browser.getWindowForTarget', { targetId: id }))
    if (!Number.isInteger(windowId)) throw new Error('session window isolation requires a browser window identity')
    return windowId
  }
  // A late createTarget result arrives after the original root may be detached.
  const closeLateTarget = async (value: { targetId?: string }) => {
    if (!value?.targetId) return
    const lateDeadline = new SetupDeadline(CLEANUP_GRACE_MS, () => {})
    let session: CdpSession | undefined
    try {
      session = await lateDeadline.run(() => owner.newBrowserCDPSession(), detach)
      await lateDeadline.run(() => session!.send('Target.closeTarget', { targetId: value.targetId }))
    } finally { if (session) await detach(session) }
  }
  try {
    root = await newSession(() => owner.newBrowserCDPSession())
    const existing = ctx.pages()
    if (existing.length) {
      const identity = await identify(existing[0]!)
      const expectedWindow = await windowOf(identity.targetId)
      for (const page of existing.slice(1)) {
        const other = await identify(page)
        if (other.browserContextId !== identity.browserContextId || await windowOf(other.targetId) !== expectedWindow) {
          throw new Error('session context contains tabs in multiple windows; refusing unsafe reuse')
        }
      }
      created = await deadline.run(() => ctx.newPage(), closePage)
      const actual = await identify(created)
      targetId = actual.targetId
      if (actual.browserContextId !== identity.browserContextId || await windowOf(actual.targetId) !== expectedWindow) {
        throw new Error('Chromium did not place the session tab in its dedicated window')
      }
      claim(browser, context, [`context:${actual.browserContextId}`, `window:${expectedWindow}`])
      identities.set(created, actual)
      succeeded = true
      return created
    }
    bootstrap = await deadline.run(() => ctx.newPage(), closePage)
    const identity = await identify(bootstrap)
    bootstrapTargetId = identity.targetId
    claim(browser, context, [`context:${identity.browserContextId}`])
    const bootstrapWindow = await windowOf(identity.targetId)
    // Register BEFORE createTarget. Events can precede its response; match the
    // exact returned target id, never URL, event order, or context.pages()[0].
    const candidates = new Map<string, { page: PlaywrightPage; contextId: string }>()
    let resolvePage!: (page: PlaywrightPage) => void
    let rejectPage!: (error: Error) => void
    const pending = new Promise<PlaywrightPage>((resolve, reject) => { resolvePage = resolve; rejectPage = reject })
    void pending.catch(() => {})
    const match = () => {
      const candidate = targetId ? candidates.get(targetId) : undefined
      if (!candidate) return
      if (candidate.contextId !== identity.browserContextId) rejectPage(new Error('created target belongs to the wrong browser context'))
      else resolvePage(candidate.page)
    }
    listener = page => {
      void identify(page).then(info => {
        candidates.set(info.targetId, { page, contextId: info.browserContextId })
        match()
      }).catch(() => { /* unrelated pages may close during target discovery */ })
    }
    ctx.on('page', listener)
    // Bind creation to the bootstrap PAGE session. A CDP gateway may map the
    // Playwright context alias to another Chromium process while routing a
    // browser-target session to its main process. Page sessions follow their
    // actual target; getTargetInfo above supplies that backend's context ID.
    const creator = await newSession(() => ctx.newCDPSession(bootstrap!))
    const result = await deadline.run(() => creator.send('Target.createTarget', {
      url: 'about:blank', browserContextId: identity.browserContextId, newWindow: true,
    }), closeLateTarget)
    if (typeof result.targetId !== 'string' || !result.targetId) throw new Error('CDP did not return a session window target id')
    const explicitTargetId: string = result.targetId
    targetId = explicitTargetId
    match()
    for (const page of ctx.pages()) listener(page)
    created = await deadline.run(() => pending, closePage)
    const explicitWindow = await windowOf(explicitTargetId)
    if (explicitWindow === bootstrapWindow) throw new Error('Chromium ignored the dedicated session window request')
    claim(browser, context, [`context:${identity.browserContextId}`, `window:${explicitWindow}`])
    identities.set(created, { targetId: explicitTargetId, browserContextId: identity.browserContextId })
    await deadline.run(() => bootstrap!.close())
    bootstrap = undefined
    succeeded = true
    return created
  } finally {
    deadline.stopped = true
    if (listener) ctx.removeListener('page', listener)
    // All cleanup runs concurrently under one bounded grace, never closes the
    // shared context/browser, and cannot replace the operation's original error.
    await Promise.all([
      ...(!succeeded && created ? [closePage(created)] : []),
      ...(!succeeded && targetId && root ? [cleanup(() => root!.send('Target.closeTarget', { targetId }))] : []),
      ...(bootstrap ? [closePage(bootstrap)] : []),
      ...(bootstrap && bootstrapTargetId && root ? [cleanup(() => root!.send('Target.closeTarget', { targetId: bootstrapTargetId }))] : []),
    ])
    await Promise.all([...sessions].map(detach))
  }
}
