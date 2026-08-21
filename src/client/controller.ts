/**
 * The Playwright card's controller: the staged form over the
 * `web-fetch-playwright` settings namespace, projected into one snapshot the
 * card's slot entry injects.
 *
 * @module dsh-web-fetch-playwright/client/controller
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { CardForm, checkboxField, radioField, textField } from './form.ts'
import type { CardShell, CardFieldState, CardActions, SnapshotStore } from './form.ts'

/**
 * Settings namespace this card edits. Spelled here rather than imported: a
 * client package must not depend on a Host package.
 */
export const WEB_FETCH_PLAYWRIGHT_NS = 'web-fetch-playwright'

/** The section fields this card edits. */
export interface PlaywrightSettings {
  /** Backend selector: local Playwright launch or a remote CDP endpoint. */
  backend?: string
  /** Local backend: playwright/browser executable path. */
  playwrightPath?: string
  /** CDP backend: endpoint (host:port / http(s) / ws). */
  cdpEndpoint?: string
  /** Whether the Readability + DOMPurify pipeline runs. */
  denoise?: boolean
}

/** What the Playwright card renders. */
export interface PlaywrightCardState extends CardShell {
  /** Backend radio group. */
  backend: CardFieldState
  /** Local-backend path input. */
  playwrightPath: CardFieldState
  /** CDP endpoint input. */
  cdpEndpoint: CardFieldState
  /** Denoise checkbox (draft 'true'/'false'). */
  denoise: CardFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface PlaywrightCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as usePlaywrightCard. */
    playwrightCard: SnapshotStore<PlaywrightCardState>
  }
}

/** Bridges the `web-fetch-playwright` settings scope onto the card. */
export class PlaywrightCardController {
  private readonly form: CardForm<PlaywrightSettings>
  private readonly store: SnapshotStore<PlaywrightCardState>

  /**
   * @param scope - the bound settings scope for the `web-fetch-playwright` namespace.
   */
  constructor(scope: SettingsScope<PlaywrightSettings>) {
    this.form = new CardForm(
      scope,
      [
        radioField('backend', ['local', 'cdp']),
        textField('playwrightPath'),
        textField('cdpEndpoint'),
        checkboxField('denoise'),
      ],
    )
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): PlaywrightCardState {
    return {
      ...this.form.shell(),
      backend: this.form.field('backend'),
      playwrightPath: this.form.field('playwrightPath'),
      cdpEndpoint: this.form.field('cdpEndpoint'),
      denoise: this.form.field('denoise'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): PlaywrightCardFace {
    return { hooks: { playwrightCard: this.store }, ...this.form.actions() }
  }
}
