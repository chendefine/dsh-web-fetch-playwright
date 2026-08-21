/**
 * The card chrome — a faithful local copy of the shipped `ui-settings-plugins`
 * PluginCard (disclosure header, unsaved marker, save/discard footer), with
 * the chevron inlined so the bundle stays self-contained.
 *
 * @module dsh-web-fetch-playwright/client/PluginCard
 */

import { useState, type ReactNode } from 'react'
import type { CardShell } from './form.ts'
import css from './PluginCard.module.css'

/** Copy keys the chrome itself renders (the card's dictionary supplies them). */
export interface CardChromeCopy {
  expand: string
  collapse: string
  unsaved: string
  readOnly: string
  saveFailed: string
  discard: string
  save: string
  saving: string
}

/** Card chrome props. */
export interface PluginCardProps {
  /** Chrome copy (a subset of the card's locale keys). */
  copy: CardChromeCopy
  /** The plugin's display name. */
  title: string
  /** The line describing what this plugin's settings govern. */
  description: string
  /** The card's form state: availability, writability, and what a save would do. */
  state: CardShell
  /** Write every staged edit. */
  onSave: () => void
  /** Drop every staged edit. */
  onDiscard: () => void
  /** The plugin's controls. */
  children: ReactNode
}

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(part => typeof part === 'string').join(' ')
}

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg className={className} width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * Render the Playwright card's chrome.
 * @param props - the card's copy, name, form state, and controls.
 * @returns the card, or nothing when the namespace is unavailable.
 */
export function PluginCard(props: PluginCardProps) {
  const [open, setOpen] = useState(false)
  const { state, copy } = props
  if (!state.available) return null
  const blocked = !state.dirty || state.invalid || state.saving
  return (
    <li className={cx(css.card, open && css.cardOpen)}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${open ? copy.collapse : copy.expand}: ${props.title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{props.title}</span>
          <span className={css.description}>{props.description}</span>
        </span>
        {state.dirty ? <span className={css.pending}>{copy.unsaved}</span> : null}
        <ChevronDown className={cx(css.chevron, open && css.chevronOpen)} />
      </button>
      {open
        ? (
          <div className={css.body}>
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
        : null}
    </li>
  )
}
