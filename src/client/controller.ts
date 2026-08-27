/**
 * The Playwright card's controller: the staged form over the
 * `web-fetch-playwright` settings namespace, projected into one snapshot the
 * card's slot entry injects.
 *
 * @module dsh-web-fetch-playwright/client/controller
 */

import type { SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
import { CardForm, checkboxField, numberField, radioField, textField } from './form.ts'
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
  /**
   * CDP backend: whether fetches share the remote browser's context (its
   * real profile — cookies, localStorage, persistent logins) as tabs, or
   * each use a fresh isolated context. Absent = schema default (true).
   */
  shareBrowserContext?: boolean
  /** Whether the Readability + DOMPurify pipeline runs. */
  denoise?: boolean
  /** How many fetches may render at once (1–200); blank = backend default. */
  maxConcurrency?: number
  /**
   * Bounded wait (ms) for a Cloudflare challenge to clear naturally in the
   * same tab (0–60000); 0 = off (return the first response as-is).
   */
  challengeWaitMs?: number
}

/** What the Playwright card renders. */
export interface PlaywrightCardState extends CardShell {
  /** Backend radio group. */
  backend: CardFieldState
  /** Local-backend path input. */
  playwrightPath: CardFieldState
  /** CDP endpoint input. */
  cdpEndpoint: CardFieldState
  /** CDP shared-context checkbox (draft 'true'/'false'). */
  shareBrowserContext: CardFieldState
  /** Denoise checkbox (draft 'true'/'false'). */
  denoise: CardFieldState
  /** Concurrency input (draft decimal integer). */
  maxConcurrency: CardFieldState
  /** Challenge wait input (draft decimal integer of milliseconds). */
  challengeWaitMs: CardFieldState
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
        checkboxField('shareBrowserContext'),
        checkboxField('denoise'),
        numberField('maxConcurrency', 1, 200),
        numberField('challengeWaitMs', 0, 60_000),
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
      shareBrowserContext: this.form.field('shareBrowserContext'),
      denoise: this.form.field('denoise'),
      maxConcurrency: this.form.field('maxConcurrency'),
      challengeWaitMs: this.form.field('challengeWaitMs'),
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
