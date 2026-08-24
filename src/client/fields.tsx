/**
 * The Playwright card's controls: the shipped ValueField (text input with
 * override badge and reset) plus the two this card adds — a two-option radio
 * group for the backend (each option carrying its backend-specific input
 * nested inside) and a checkbox for the denoise toggle — styled on the same
 * tokens and rhythm as the built-in plugin-configuration fields.
 *
 * @module dsh-web-fetch-playwright/client/fields
 */

import type { ReactNode } from 'react'
import css from './fields.module.css'

/** A staged text field (copy of the shipped ValueField). */
export function ValueField(props: {
  id: string
  label: string
  hint: string
  text: string
  overridden: boolean
  invalid: boolean
  overriddenLabel: string
  resetLabel: string
  invalidLabel: string
  disabled: boolean
  placeholder?: string
  /** Render inside a radio option: no card-level chrome (border, padding). */
  embedded?: boolean
  onEdit: (text: string) => void
  onReset: () => void
}) {
  return (
    <div className={props.embedded ? css.fieldEmbedded : css.field}>
      <div className={css.head}>
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{props.overriddenLabel}</span>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <input
        id={props.id}
        className={props.invalid ? css.inputInvalid : css.input}
        type="text"
        {...props.invalid ? { 'aria-invalid': true } : {}}
        value={props.text}
        placeholder={props.placeholder ?? ''}
        disabled={props.disabled}
        spellCheck={false}
        onChange={(event) => { props.onEdit(event.target.value) }}
      />
      <p className={props.invalid ? css.invalid : css.hint}>
        {props.invalid ? props.invalidLabel : props.hint}
      </p>
    </div>
  )
}

/** One radio option's copy, staged value, and nested control. */
export interface RadioOption {
  /** The option's stored value ('local' | 'cdp'). */
  value: string
  /** Option label shown beside the radio. */
  label: string
  /** One-line explanation under the option. */
  hint: string
  /**
   * Optional control rendered inside the option, under the label and hint —
   * used to nest each backend's fill-in input in its own radio option. The
   * option box stays a plain div so the nested field's own label element is
   * valid HTML (a `<label>` may not nest another `<label>`).
   */
  content?: ReactNode
}

/** A staged radio group: the backend selector. */
export function RadioGroupField(props: {
  label: string
  options: readonly RadioOption[]
  text: string
  overridden: boolean
  overriddenLabel: string
  resetLabel: string
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
}) {
  return (
    <fieldset className={css.field}>
      <div className={css.head}>
        <span className={css.label}>{props.label}</span>
        {props.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{props.overriddenLabel}</span>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <div className={css.radioGroup} role="radiogroup" aria-label={props.label}>
        {props.options.map(option => (
          <div key={option.value} className={css.radioOption}>
            <label className={css.radioPick}>
              <input
                type="radio"
                name="playwright-backend"
                value={option.value}
                checked={props.text === option.value}
                disabled={props.disabled}
                onChange={() => { props.onEdit(option.value) }}
              />
              <span className={css.radioText}>
                <span className={css.radioLabel}>{option.label}</span>
                <span className={css.radioHint}>{option.hint}</span>
              </span>
            </label>
            {option.content === undefined
              ? null
              : <div className={css.radioContent}>{option.content}</div>}
          </div>
        ))}
      </div>
    </fieldset>
  )
}

/**
 * A staged checkbox: the denoise toggle and the CDP shared-context toggle.
 * An absent stored value formats as '' — callers render the schema default
 * (denoise on, context shared).
 */
export function CheckboxField(props: {
  id: string
  label: string
  hint: string
  checked: boolean
  overridden: boolean
  overriddenLabel: string
  resetLabel: string
  disabled: boolean
  onEdit: (text: string) => void
  onReset: () => void
  /** Render inside a radio option: no card-level chrome, hint under the label. */
  embedded?: boolean
}) {
  return (
    <div className={props.embedded ? css.fieldEmbedded : css.field}>
      <div className={css.checkboxRow}>
        <input
          id={props.id}
          type="checkbox"
          checked={props.checked}
          disabled={props.disabled}
          onChange={(event) => { props.onEdit(event.target.checked ? 'true' : 'false') }}
        />
        <label className={css.label} htmlFor={props.id}>{props.label}</label>
        {props.overridden
          ? (
            <span className={css.badges}>
              <span className={css.badge}>{props.overriddenLabel}</span>
              <button
                type="button"
                className={css.reset}
                disabled={props.disabled}
                onClick={props.onReset}
              >
                {props.resetLabel}
              </button>
            </span>
          )
          : null}
      </div>
      <p className={props.embedded ? `${css.hint} ${css.hintIndented}` : css.hint}>{props.hint}</p>
    </div>
  )
}
