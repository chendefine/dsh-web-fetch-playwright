/**
 * Settings/config surface for the Playwright fetch provider: the schemastery
 * schema the loader validates the row against, the settings namespace's
 * resolved shape, and the small pure normalizers the provider applies per
 * fetch (CDP endpoint shaping) — kept network-free for unit tests.
 *
 * @module dsh-web-fetch-playwright/config
 */

import z from '@deepseek-ai/schemastery'

/** Default CDP endpoint when the settings section leaves it blank. */
export const DEFAULT_CDP_ENDPOINT = '127.0.0.1:9222'

/**
 * Default concurrency for the local backend: each slot launches a whole
 * Chromium, so the default stays frugal; parallel `web_fetch` bursts stop
 * queueing without a browser farm per fetch.
 */
export const DEFAULT_MAX_CONCURRENCY_LOCAL = 4

/**
 * Default concurrency for the CDP backend: the browser already exists, each
 * fetch only opens a tab (isolated context) inside it over one shared
 * connection — so the budget behaves like "max concurrent tabs" and defaults
 * high.
 */
export const DEFAULT_MAX_CONCURRENCY_CDP = 50

/** Ceiling the schema accepts for `maxConcurrency` (local slots are browsers). */
export const MAX_CONCURRENCY_CEILING = 200

/**
 * Default bounded wait (ms) for a Cloudflare challenge to clear naturally —
 * the user's real browser passes the verification on its own while the fetch
 * holds the same page and context. Sized to fit the 45s per-fetch deadline
 * with the settle/decode tail (and one retry) still inside it.
 */
export const DEFAULT_CHALLENGE_WAIT_MS = 15_000

/** Ceiling the schema accepts for `challengeWaitMs`. */
export const MAX_CHALLENGE_WAIT_MS = 60_000

/** Default same-page re-navigation attempts after a challenge wait runs out. */
export const DEFAULT_CHALLENGE_RETRIES = 1

/** Ceiling the schema accepts for `challengeRetries`. */
export const MAX_CHALLENGE_RETRIES = 3

/** Which browser backend serves a fetch. */
export type PlaywrightBackend = 'local' | 'cdp'

/**
 * How the CDP backend scopes a fetch: a throwaway isolated context, or a tab
 * in the remote browser's real profile (default context).
 */
export type CdpContextMode = 'isolated' | 'profile'

/** Plugin config: everything optional — the schema fills the defaults. */
export interface Config {
  /** Backend selector: local Playwright launch or a remote CDP endpoint. */
  backend?: PlaywrightBackend
  /**
   * Local backend: path to a `playwright` executable (Node CLI) or to a
   * Chromium-family browser executable. Empty = discover `playwright` on
   * `$PATH`, then fall back to the plugin's bundled `playwright-core`.
   */
  playwrightPath?: string
  /** CDP backend: `host:port`, `http(s)://…`, or `ws(s)://…`. Empty = default. */
  cdpEndpoint?: string
  /**
   * CDP backend only. `true` (default): each fetch is a tab in the remote
   * browser's default context — the real profile — so cookies/localStorage
   * come from (and are written back to) it and its persistent logins apply.
   * `false`: a fresh incognito-like isolated context per fetch, no shared
   * state. Meaningless for the local backend (collapses to isolated).
   */
  shareBrowserContext?: boolean
  /** Whether the Readability + DOMPurify denoise pipeline runs before markdown. */
  denoise?: boolean
  /**
   * Bounded wait (ms) for a Cloudflare challenge to clear naturally inside
   * the same page/context. `0` (or any config leaving this at 0) restores the
   * legacy behavior: the first response is final, no waiting — the A/B
   * baseline. Schema default: {@link DEFAULT_CHALLENGE_WAIT_MS}.
   */
  challengeWaitMs?: number
  /**
   * Same-page re-navigation attempts after a challenge wait window runs out
   * (any partial clearance cookies stay in the context for the retry).
   * Schema default: {@link DEFAULT_CHALLENGE_RETRIES}.
   */
  challengeRetries?: number
  /**
   * How many fetches may render at once. Blank = backend default (4 for
   * local — each slot launches a browser; 50 for CDP — each slot is a tab in
   * the already-running remote browser).
   */
  maxConcurrency?: number
}

export const Config: z<Config> = z.object({
  // union-of-consts rather than z.enum: the profile's published schemastery
  // build does not expose `.enum`, and this schema executes at runtime
  // against that copy.
  backend: z.union([z.const('local'), z.const('cdp')]).default('local'),
  playwrightPath: z.string().default(''),
  cdpEndpoint: z.string().default(''),
  shareBrowserContext: z.boolean().default(true),
  denoise: z.boolean().default(true),
  // Optional on purpose: the effective default depends on `backend`, which a
  // static schema default cannot express.
  maxConcurrency: z.number().step(1).min(1).max(MAX_CONCURRENCY_CEILING),
  // The bounded natural-wait knobs; 0 disables the whole challenge path.
  challengeWaitMs: z.number().step(100).min(0).max(MAX_CHALLENGE_WAIT_MS).default(DEFAULT_CHALLENGE_WAIT_MS),
  challengeRetries: z.number().step(1).min(0).max(MAX_CHALLENGE_RETRIES).default(DEFAULT_CHALLENGE_RETRIES),
})

/**
 * Complete config after schemastery applies the field defaults it owns.
 * `maxConcurrency` stays optional — {@link effectiveMaxConcurrency} resolves
 * it against the backend.
 */
export type ResolvedConfig = Omit<Required<Config>, 'maxConcurrency'> & { maxConcurrency?: number }

/**
 * The concurrency limit a fetch actually runs with: an explicit setting
 * wins; otherwise the backend default (local launches browsers, CDP only
 * opens tabs, so their budgets differ by an order of magnitude).
 *
 * @param config - the resolved settings section (or any partial of it).
 * @returns the effective limit for the semaphore.
 */
export function effectiveMaxConcurrency(config: Pick<Config, 'backend' | 'maxConcurrency'>): number {
  if (typeof config.maxConcurrency === 'number') return config.maxConcurrency
  return config.backend === 'cdp' ? DEFAULT_MAX_CONCURRENCY_CDP : DEFAULT_MAX_CONCURRENCY_LOCAL
}

/**
 * The challenge wait budget a fetch actually runs with: an explicit setting
 * wins, else the schema default. `0` means the challenge path is off.
 *
 * @param config - the resolved settings section (or any partial of it).
 * @returns the bounded wait in milliseconds.
 */
export function effectiveChallengeWaitMs(config: Pick<Config, 'challengeWaitMs'>): number {
  if (typeof config.challengeWaitMs === 'number') return config.challengeWaitMs
  return DEFAULT_CHALLENGE_WAIT_MS
}

/**
 * The same-page retry count a challenge fetch actually runs with: an explicit
 * setting wins, else the schema default.
 *
 * @param config - the resolved settings section (or any partial of it).
 * @returns retries after a wait window runs out.
 */
export function effectiveChallengeRetries(config: Pick<Config, 'challengeRetries'>): number {
  if (typeof config.challengeRetries === 'number') return config.challengeRetries
  return DEFAULT_CHALLENGE_RETRIES
}

/**
 * The context mode a fetch actually runs with: profile (a tab in the remote
 * browser's real profile) requires the CDP backend — a local launch has no
 * meaningful shared profile — and the checkbox (which defaults on, so an
 * absent value reads as `true`, mirroring the schema default); everything
 * else collapses to isolated.
 *
 * @param config - the resolved settings section (or any partial of it).
 * @returns the mode the pool acquires its lease with.
 */
export function effectiveContextMode(config: Pick<Config, 'backend' | 'shareBrowserContext'>): CdpContextMode {
  if (config.backend === 'cdp' && config.shareBrowserContext !== false) return 'profile'
  return 'isolated'
}

/**
 * Normalize a configured CDP endpoint for `chromium.connectOverCDP`:
 * blank becomes the default loopback endpoint; `wss?://` and `https?://`
 * pass through; a bare `host:port` gains the `http://` scheme Playwright's
 * CDP discovery (`GET /json/version`) expects.
 *
 * @param input - the raw configured endpoint.
 * @returns the endpoint string to hand to Playwright.
 * @throws {Error} when the normalized value is not a parseable URL.
 */
export function normalizeCdpEndpoint(input: string): string {
  const trimmed = input.trim()
  const value = trimmed === '' ? DEFAULT_CDP_ENDPOINT : trimmed
  const candidate = /^wss?:\/\//i.test(value) || /^https?:\/\//i.test(value)
    ? value
    : `http://${value}`
  // Surface garbage early with a plain Error; the provider wraps it in a
  // structured WebError with the configured value for context.
  new URL(candidate)
  return candidate
}
