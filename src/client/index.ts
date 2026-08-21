/**
 * Browser half of `dsh-web-fetch-playwright`: registers the locale dictionary
 * and the plugin-configuration card keyed by the `web-fetch-playwright`
 * settings namespace, so the card pairs with the Host section the plugin half
 * registers — the shipped configurable-plugins tab dispatches it with no
 * changes.
 *
 * @module dsh-web-fetch-playwright/client
 */

import type { Context } from 'cordis'
// Type-only: pulls the ctx.locale / ctx.slots / ctx.settingsScope Context
// merges, and the 'settings.plugin.item' SlotMap declaration from the
// ui-settings-plugins package that owns the slot contract.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import { PlaywrightCardController, WEB_FETCH_PLAYWRIGHT_NS } from './controller.ts'
import { PlaywrightCard } from './card.tsx'
import { en, zh } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'web-fetch-playwright'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * Mount the Playwright plugin-configuration card.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'web-fetch-playwright: card dictionary')

  const controller = new PlaywrightCardController(
    ctx.settingsScope.bind({ namespace: WEB_FETCH_PLAYWRIGHT_NS }),
  )
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: WEB_FETCH_PLAYWRIGHT_NS,
    locale: NS,
    inject: () => controller.inject(),
  }, PlaywrightCard))
}
