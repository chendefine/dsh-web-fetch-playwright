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

/** Which browser backend serves a fetch. */
export type PlaywrightBackend = 'local' | 'cdp'

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
  /** Whether the Readability + DOMPurify denoise pipeline runs before markdown. */
  denoise?: boolean
}

export const Config: z<Config> = z.object({
  // union-of-consts rather than z.enum: the profile's published schemastery
  // build does not expose `.enum`, and this schema executes at runtime
  // against that copy.
  backend: z.union([z.const('local'), z.const('cdp')]).default('local'),
  playwrightPath: z.string().default(''),
  cdpEndpoint: z.string().default(''),
  denoise: z.boolean().default(true),
})

/** Complete config after schemastery applies every field default. */
export type ResolvedConfig = Required<Config>

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
