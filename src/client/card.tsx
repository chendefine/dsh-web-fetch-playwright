/**
 * The Playwright plugin-configuration card: backend radio group (each option
 * carrying its backend-specific inputs nested inside — local path under Local
 * Playwright, CDP endpoint and shared-context checkbox under Remote CDP) plus
 * the denoise checkbox, staged and saved through the card form like the
 * built-in plugin cards.
 *
 * The Plugins page asks for `view: 'summary'` (a row's description
 * fallback) or `view: 'page'` (this form). The same component serves both
 * seats it is registered into: the bundle's own page (between its
 * description and its rows) and the row's page (under the plugin's own
 * title); one controller stages the edits shared by the two.
 *
 * @module dsh-web-fetch-playwright/client/card
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { CardForm } from './PluginCard.tsx'
import { CheckboxField, RadioGroupField, ValueField } from './fields.tsx'
import type { PlaywrightCardFace, PlaywrightCardState } from './controller.ts'

/** Props the renderer binds for the Playwright card. */
export type PlaywrightCardProps =
  (PropsRuntime<'plugins.bundle.config'> | PropsRuntime<'plugins.row.config'>)
  & PropsLocale<'web-fetch-playwright'>
  & InjectFace<PlaywrightCardFace>

/**
 * Render the Playwright card: its one-liner for the list, or the staged form
 * for the page.
 * @param props - the view asked for, locale copy, the card snapshot, and its form actions.
 * @returns the one-liner, the form, or nothing while the namespace is unavailable.
 */
export function PlaywrightCard(props: PlaywrightCardProps) {
  const { t } = props
  if (props.view === 'summary') return t('description')
  const state = props.usePlaywrightCard(snapshot => snapshot)
  if (!state.available) return null
  const disabled = !state.writable
  const backend = state.backend.text === 'cdp' ? 'cdp' : 'local'
  return (
    <CardForm
      copy={{
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        discard: t('discard'),
        save: t('save'),
        saving: t('saving'),
      }}
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <RadioGroupField
        label={t('backendLabel')}
        options={[
          {
            value: 'local',
            label: t('backendLocal'),
            hint: t('backendLocalHint'),
            content: (
              <ValueField
                embedded
                id="plugin-config-playwright-path"
                label={t('playwrightPath')}
                hint={t('playwrightPathHint')}
                placeholder={t('playwrightPathPlaceholder')}
                overriddenLabel={t('overridden')}
                resetLabel={t('reset')}
                invalidLabel={t('invalidText')}
                disabled={disabled || backend !== 'local'}
                {...state.playwrightPath}
                onEdit={(text) => { props.edit('playwrightPath', text) }}
                onReset={() => { props.resetField('playwrightPath') }}
              />
            ),
          },
          {
            value: 'cdp',
            label: t('backendCdp'),
            hint: t('backendCdpHint'),
            content: (
              <>
                <ValueField
                  embedded
                  id="plugin-config-playwright-cdp"
                  label={t('cdpEndpoint')}
                  hint={t('cdpEndpointHint')}
                  placeholder="127.0.0.1:9222"
                  overriddenLabel={t('overridden')}
                  resetLabel={t('reset')}
                  invalidLabel={t('invalidText')}
                  disabled={disabled || backend !== 'cdp'}
                  {...state.cdpEndpoint}
                  onEdit={(text) => { props.edit('cdpEndpoint', text) }}
                  onReset={() => { props.resetField('cdpEndpoint') }}
                />
                <CheckboxField
                  embedded
                  id="plugin-config-playwright-share-context"
                  label={t('shareBrowserContext')}
                  hint={t('shareBrowserContextHint')}
                  checked={state.shareBrowserContext.text !== 'false'}
                  overridden={state.shareBrowserContext.overridden}
                  overriddenLabel={t('overridden')}
                  resetLabel={t('reset')}
                  disabled={disabled || backend !== 'cdp'}
                  onEdit={(text) => { props.edit('shareBrowserContext', text) }}
                  onReset={() => { props.resetField('shareBrowserContext') }}
                />
              </>
            ),
          },
        ]}
        text={state.backend.text}
        overridden={state.backend.overridden}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        disabled={disabled}
        onEdit={(text) => { props.edit('backend', text) }}
        onReset={() => { props.resetField('backend') }}
      />
      <CheckboxField
        id="plugin-config-playwright-denoise"
        label={t('denoise')}
        hint={t('denoiseHint')}
        checked={state.denoise.text !== 'false'}
        overridden={state.denoise.overridden}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        disabled={disabled}
        onEdit={(text) => { props.edit('denoise', text) }}
        onReset={() => { props.resetField('denoise') }}
      />
      <ValueField
        id="plugin-config-playwright-concurrency"
        label={t('maxConcurrency')}
        hint={t('maxConcurrencyHint')}
        placeholder={t('maxConcurrencyPlaceholder')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.maxConcurrency}
        onEdit={(text) => { props.edit('maxConcurrency', text) }}
        onReset={() => { props.resetField('maxConcurrency') }}
      />
      <ValueField
        id="plugin-config-playwright-challenge-wait"
        label={t('challengeWaitMs')}
        hint={t('challengeWaitMsHint')}
        placeholder={t('challengeWaitMsPlaceholder')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidText')}
        disabled={disabled}
        {...state.challengeWaitMs}
        onEdit={(text) => { props.edit('challengeWaitMs', text) }}
        onReset={() => { props.resetField('challengeWaitMs') }}
      />
    </CardForm>
  )
}
