/**
 * `dsh-web-fetch-playwright`: registers the Playwright/CDP
 * {@link PlaywrightFetchProvider} with `ctx.web` and exposes its settings
 * section ('web-fetch-playwright') so the web client's plugin-configuration
 * card can edit it live.
 *
 * A function plugin (NOT a default-export service): like the shipped search
 * providers, it registers INTO the seam's fetch registry.
 *
 * @module dsh-web-fetch-playwright
 */

import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-web'
import { Config } from './config.ts'
import type { ResolvedConfig } from './config.ts'
import { PlaywrightFetchProvider } from './provider.ts'

export { Config, DEFAULT_CDP_ENDPOINT, normalizeCdpEndpoint } from './config.ts'
export type { Config as PlaywrightFetchConfig, PlaywrightBackend, ResolvedConfig } from './config.ts'
export { PLAYWRIGHT_FETCH_PROVIDER_ID, PlaywrightFetchProvider } from './provider.ts'
export { htmlToMarkdown } from './markdown.ts'
export type { DenoiseMode, DenoiseResult } from './markdown.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-web-fetch-playwright'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Settings namespace carrying this provider's configuration card. */
export const WEB_FETCH_PLAYWRIGHT_SETTINGS_NAMESPACE = settingsNamespace('web-fetch-playwright')

/** Register the Playwright fetch provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  // `current` is REASSIGNED by setSource when the settings scope attaches
  // (possibly after this function returns), so the provider must receive an
  // indirection — `() => current()` — never the thunk's value at this moment.
  // Passing `current` directly would pin the composition entry forever (the
  // web-search-deepseek provider uses the same wrapper idiom).
  let current: () => ResolvedConfig = () => config as ResolvedConfig
  installSettingsSection(ctx, WEB_FETCH_PLAYWRIGHT_SETTINGS_NAMESPACE, Config, config, {
    setSource: (source) => {
      current = source as () => ResolvedConfig
    },
    // The provider projects the section per fetch, so a committed change
    // needs no re-registration.
    onChange: () => {},
  })
  ctx.web.registerFetchProvider(new PlaywrightFetchProvider(() => current()))
}
