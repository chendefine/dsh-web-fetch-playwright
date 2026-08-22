/**
 * The Playwright plugin-configuration card: backend radio group (each option
 * carrying its backend-specific input nested inside — local path under Local
 * Playwright, CDP endpoint under Remote CDP) plus the denoise checkbox,
 * staged and saved through the card form like the built-in plugin cards.
 *
 * @module dsh-web-fetch-playwright/client/card
 */

import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginCard } from './PluginCard.tsx'
import { CheckboxField, RadioGroupField, ValueField } from './fields.tsx'
import type { PlaywrightCardFace, PlaywrightCardState } from './controller.ts'

/** Props the renderer binds for the Playwright card. */
export type PlaywrightCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'web-fetch-playwright'>
  & InjectFace<PlaywrightCardFace>

/**
 * Render the Playwright card.
 * @param props - locale copy, the card snapshot, and its form actions.
 * @returns the card.
 */
export function PlaywrightCard(props: PlaywrightCardProps) {
  const { t } = props
  const state = props.usePlaywrightCard(snapshot => snapshot)
  const disabled = !state.writable
  const backend = state.backend.text === 'cdp' ? 'cdp' : 'local'
  return (
    <PluginCard
      copy={{
        expand: t('expand'),
        collapse: t('collapse'),
        unsaved: t('unsaved'),
        readOnly: t('readOnly'),
        saveFailed: t('saveFailed'),
        discard: t('discard'),
        save: t('save'),
        saving: t('saving'),
      }}
      title={t('title')}
      description={t('description')}
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
    </PluginCard>
  )
}
