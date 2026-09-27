/**
 * The form chrome — a page-level container (read-only notice, the staged
 * controls, and the save/discard footer), in the rhythm of the shipped
 * plugin-configuration forms. Since the Plugins page (dsh ≥ 0.1.7) draws the
 * title, description, and navigation around a configuration entry, this is
 * the body only; the disclosure header of the old settings-list card is
 * gone with that seat.
 *
 * @module dsh-web-fetch-playwright/client/PluginCard
 */

import type { ReactNode } from 'react'
import type { CardShell } from './form.ts'
import css from './PluginCard.module.css'

/** Copy keys the chrome itself renders (the card's dictionary supplies them). */
export interface CardFormCopy {
  readOnly: string
  saveFailed: string
  discard: string
  save: string
  saving: string
}

/** Form chrome props. */
export interface CardFormProps {
  /** Chrome copy (a subset of the card's locale keys). */
  copy: CardFormCopy
  /** The card's form state: availability, writability, and what a save would do. */
  state: CardShell
  /** Write every staged edit. */
  onSave: () => void
  /** Drop every staged edit. */
  onDiscard: () => void
  /** The plugin's controls. */
  children: ReactNode
}

/**
 * Render the Playwright form's chrome.
 * @param props - the form's copy, form state, and controls.
 * @returns the form body with its footer.
 */
export function CardForm(props: CardFormProps) {
  const { state, copy } = props
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <div className={css.form}>
      {!state.writable ? <p className={css.readOnly} role="status">{copy.readOnly}</p> : null}
      {props.children}
      <div className={css.footer}>
        {state.failed ? <p className={css.failed} role="status">{copy.saveFailed}</p> : null}
        <button
          type="button"
          className={css.discard}
          disabled={!state.dirty || state.saving}
          onClick={props.onDiscard}
        >
          {copy.discard}
        </button>
        <button
          type="button"
          className={css.save}
          disabled={blocked}
          onClick={props.onSave}
        >
          {state.saving ? copy.saving : copy.save}
        </button>
      </div>
    </div>
  )
}
