/**
 * `dsh-web-fetch-playwright`: registers the Playwright/CDP
 * {@link PlaywrightFetchProvider} with `ctx.web`.
 *
 * The `web-fetch-playwright` settings section is derived from this plugin's
 * `Config` schema (dsh ≥ 0.1.7): its volatile fields are editable live on
 * the Plugins page, and a committed change is pushed into the running
 * config's volatile references — the provider re-reads them per fetch, so an
 * edit reaches the next request without a restart or re-registration.
 *
 * A function plugin (NOT a default-export service): like the shipped search
 * providers, it registers INTO the web seam's fetch registry.
 *
 * @module dsh-web-fetch-playwright
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-web'
import { resolveConfig, snapshotsOf } from './config.ts'
import type { PlaywrightPluginConfig } from './config.ts'
import { PlaywrightFetchProvider } from './provider.ts'

export {
  Config,
  DEFAULT_CDP_ENDPOINT,
  DEFAULT_CHALLENGE_RETRIES,
  DEFAULT_CHALLENGE_WAIT_MS,
  effectiveChallengeRetries,
  effectiveChallengeWaitMs,
  effectiveContextMode,
  normalizeCdpEndpoint,
  resolveConfig,
  snapshotsOf,
} from './config.ts'
export type {
  Config as PlaywrightFetchConfig,
  CdpContextMode,
  PlaywrightBackend,
  PlaywrightPluginConfig,
  ResolvedConfig,
} from './config.ts'
export { CdpConnectionPool } from './cdp-pool.ts'
export type { CdpAcquireMode, CdpConnect, CdpLease } from './cdp-pool.ts'
export { CHALLENGE_DOM_PROBE, CHALLENGE_FINISH_RESERVE_MS, CHALLENGE_POLL_INTERVAL_MS, CHALLENGE_TITLE_RE, classifyChallengeHtml, classifyChallengeResponse, isChallengeCompatibleResponse } from './challenge.ts'
export type { ChallengeVerdict } from './challenge.ts'
export { PLAYWRIGHT_FETCH_PROVIDER_ID, PlaywrightFetchProvider, WEB_FETCH_CHALLENGE_CODE } from './provider.ts'
export { htmlToMarkdown } from './markdown.ts'
export type { DenoiseMode, DenoiseResult } from './markdown.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-web-fetch-playwright'

/**
 * The capability seam this plugin registers into. The settings section
 * needs no inject: the host's settings service derives it from the entry's
 * `Config` schema (its volatile fields) by entry id.
 */
export const inject = ['web']

/**
 * Settings namespace carrying this provider's configuration page: the
 * composition entry id, which is what the settings service keys the
 * derived section by.
 */
export const WEB_FETCH_PLAYWRIGHT_SETTINGS_NAMESPACE = 'web-fetch-playwright'

/**
 * Register the Playwright fetch provider with `ctx.web`.
 *
 * @param ctx - plugin context supplying the web seam.
 * @param config - the loader-resolved plugin config; its volatile fields are
 *   live references a settings commit updates in place.
 */
export function apply(ctx: Context, config: PlaywrightPluginConfig): void {
  // Re-read AND re-resolve per fetch: `snapshotsOf` dereferences the volatile
  // references each time, so a section committed from the settings page
  // between two fetches serves the second one.
  const provider = new PlaywrightFetchProvider(() => resolveConfig(snapshotsOf(config)))
  // The CDP backend holds one shared connection for the provider's lifetime;
  // drop it when this plugin unloads so restarts don't strand sockets.
  ctx.effect(() => () => { void provider.dispose() }, 'dsh-web-fetch-playwright: shared CDP connection')
  ctx.web.registerFetchProvider(provider)
}
