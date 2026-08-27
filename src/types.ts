/**
 * Structural types over the Playwright surface this plugin uses. Declared
 * locally (not imported from `playwright`) because the runtime module is
 * discovered dynamically — a user's global install, a pinned browser
 * executable, or the bundled `playwright-core` — and only these members are
 * load-bearing.
 *
 * @module dsh-web-fetch-playwright/types
 */

/** A navigation response, as `page.goto` returns it. */
export interface PlaywrightResponse {
  status(): number
  headers(): Record<string, string>
  text(): Promise<string>
  /** This response's URL; absent on minimal fakes. */
  url?(): string
  /**
   * The request this response answers — used to recognize main-frame
   * navigation responses while the challenge wait runs. Absent on fakes.
   */
  request?(): PlaywrightRequest
}

/** The request side of a response, for main-frame filtering. */
export interface PlaywrightRequest {
  /** True for navigations (document loads and their redirect hops). */
  isNavigationRequest?(): boolean
  /** `'document'` for frame navigations; absent on minimal fakes. */
  resourceType?(): string
  /** The frame that issued the request; compare with `page.mainFrame()`. */
  frame?(): unknown
}

/** A page inside a context. */
export interface PlaywrightPage {
  goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout?: number }): Promise<PlaywrightResponse | null>
  waitForLoadState(state?: 'load' | 'domcontentloaded' | 'networkidle', options?: { timeout?: number }): Promise<void>
  url(): string
  content(): Promise<string>
  close(): Promise<void>
  /**
   * Resource-filter interception at page level — installed on the page (not
   * its context) so profile mode never intercepts tabs it does not own.
   */
  route(glob: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>
  /** Popup notification; the fetch closes whatever its page spawns. */
  on?(event: 'popup', listener: (page: PlaywrightPage) => void): unknown
  /**
   * Response notification — the challenge wait uses it to track the LAST
   * main-frame navigation response (challenge pages reload into the real
   * document). Absent on minimal fakes (content polling covers them).
   */
  on?(event: 'response', listener: (response: PlaywrightResponse) => void): unknown
  /**
   * Evaluate an expression in the page — the challenge probe's live-DOM
   * path. Absent on minimal fakes (content polling covers them).
   */
  evaluate?(script: string, arg?: unknown): Promise<unknown>
  /** The main frame handle; compare with `request.frame()` for filtering. */
  mainFrame?(): unknown
}

/**
 * A browser context: fetch-owned and isolated (local backend, or CDP
 * `isolated` mode), or the remote browser's default context carrying its
 * real profile (CDP `profile` mode — never closed by a fetch).
 */
export interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>
  route(glob: string, handler: (route: PlaywrightRoute) => Promise<void>): Promise<void>
  close(): Promise<void>
}

/** A route interception decision. */
export interface PlaywrightRoute {
  request(): { resourceType(): string }
  abort(): Promise<void>
  continue(): Promise<void>
}

/** A browser instance (launched locally or connected over CDP). */
export interface PlaywrightBrowser {
  newContext(): Promise<PlaywrightContext>
  close(): Promise<void>
  /**
   * Contexts visible to this connection. Over CDP the default context — the
   * remote browser's real profile — is always dispatched first, so `[0]` is
   * it; absent on minimal fakes (isolated mode never calls this).
   */
  contexts?(): PlaywrightContext[]
  /** Liveness probe; absent on minimal fakes (assumed live). */
  isConnected?(): boolean
  /** Optional disconnect notification used to drop a stale shared CDP connection. */
  on?(event: 'disconnected', listener: () => void): unknown
}

/** The `chromium` namespace of whichever Playwright module serves a fetch. */
export interface PlaywrightChromium {
  launch(options?: { headless?: boolean; executablePath?: string; timeout?: number }): Promise<PlaywrightBrowser>
  connectOverCDP(endpointURL: string, options?: { timeout?: number }): Promise<PlaywrightBrowser>
}
