/**
 * The staged-form model behind the Playwright card — a faithful subset of the
 * shipped `ui-settings-plugins` CardForm (same staging semantics: edits stay
 * local until the card's save, presence in the user layer — not value
 * equality — marks a field overridden), plus the two field kinds this card
 * adds: a radio group (backend) and a checkbox (denoise), staged through the
 * same draft mechanism as text.
 *
 * Bundled locally because external client bundles cannot value-import
 * `@deepseek-ai/*` packages; the snapshot store is a local structural clone
 * of the runtime contract.
 *
 * @module dsh-web-fetch-playwright/client/form
 */

import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'

/** The write one field's staged draft performs when the card is saved. */
export type FieldWrite =
  | { kind: 'set'; value: unknown }
  | { kind: 'clear' }

/** How one section field converts between its stored value and its draft. */
export interface CardFieldSpec {
  /** Field name inside the namespace section. */
  field: string
  /** Render a stored value as a draft string; empty when the section carries none. */
  format: (value: unknown) => string
  /**
   * The write this draft stages, or undefined when the draft is not a value
   * this field accepts — which blocks the save rather than discarding it.
   */
  parse: (text: string) => FieldWrite | undefined
}

/** One field as the card renders it. */
export interface CardFieldState {
  /** Draft string the control renders. */
  text: string
  /** Whether saving would leave a user-layer entry for this field. */
  overridden: boolean
  /** Whether the draft is not a value this field accepts, which blocks saving. */
  invalid: boolean
}

/** Form state every plugin card shares. */
export interface CardShell {
  /** False while the namespace is not served to this client; the card renders nothing. */
  available: boolean
  /** Whether the Host document accepts writes. */
  writable: boolean
  /** Whether the form holds edits that a save would write. */
  dirty: boolean
  /** Whether any staged draft is invalid, which blocks the save. */
  invalid: boolean
  /** Whether a save is crossing the wire. */
  saving: boolean
  /** Whether the last save did not land as staged; cleared by the next edit or save. */
  failed: boolean
}

/** The write actions the card's slot entry injects. */
export interface CardActions {
  /** Stage a draft for one field. */
  edit: (field: string, text: string) => void
  /** Stage a clear, so saving lets the field re-inherit the composition layer. */
  resetField: (field: string) => void
  /** Write every staged edit, then re-seed from what the Host accepted. */
  save: () => void
  /** Drop every staged edit. */
  discard: () => void
}

/** Minimal observable snapshot source (structural clone of the runtime contract). */
export interface SnapshotStore<T> {
  getSnapshot(): T
  subscribe(listener: () => void): () => void
  set(next: T): void
}

/** One staged edit. */
interface StagedEdit {
  /** Draft string the control renders. */
  text: string
  /** True when this edit clears the field whatever draft it shows. */
  clear: boolean
}

/** One staged edit resolved into the write a save performs. */
interface PlannedWrite {
  /** Field this entry writes. */
  field: string
  /** Perform the write and report whether the Host holds the staged value. */
  run: (() => Promise<boolean>) | undefined
}

/**
 * A free-text field. An empty draft clears the field, so emptying the control
 * and saving is the same gesture as resetting it.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function textField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'string' ? value : '',
    parse: (text) => {
      const trimmed = text.trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/**
 * A radio-group field over a fixed option set.
 * @param field - field name inside the namespace section.
 * @param values - the accepted option values.
 * @returns the field's conversion spec.
 */
export function radioField(field: string, values: readonly string[]): CardFieldSpec {
  const set = new Set(values)
  return {
    field,
    format: value => typeof value === 'string' && set.has(value) ? value : '',
    parse: text => set.has(text) ? { kind: 'set', value: text } : undefined,
  }
}

/**
 * A checkbox field. The draft carries 'true'/'false'; an absent stored value
 * formats as '' so the control can fall back to the schema default.
 * @param field - field name inside the namespace section.
 * @returns the field's conversion spec.
 */
export function checkboxField(field: string): CardFieldSpec {
  return {
    field,
    format: value => typeof value === 'boolean' ? (value ? 'true' : 'false') : '',
    parse: text => text === 'true' ? { kind: 'set', value: true } : text === 'false' ? { kind: 'set', value: false } : undefined,
  }
}

/**
 * Stages the Playwright card's edits over one settings namespace and writes
 * them on save. Publishes through a snapshot store because slot components
 * read through a selector while both the scope and the drafts change below.
 */
export class CardForm<T> {
  private readonly specs: Map<string, CardFieldSpec>
  private readonly staged = new Map<string, StagedEdit>()
  private readonly listeners = new Set<() => void>()
  private saving = false
  private failed = false

  /**
   * @param scope - the bound settings scope for this card's namespace.
   * @param specs - the section fields this card edits.
   */
  constructor(
    private readonly scope: SettingsScope<T>,
    specs: CardFieldSpec[],
  ) {
    this.specs = new Map(specs.map(spec => [spec.field, spec]))
    scope.subscribe(() => { this.publish() })
  }

  /**
   * Publish a projection of this form, rebuilt whenever the scope or a draft
   * changes.
   * @param project - build the card's state from the form's current reads.
   * @returns the store the card's component reads through its bound selector.
   */
  bind<S>(project: () => S): SnapshotStore<S> {
    let last = project()
    const listeners = new Set<() => void>()
    const store: SnapshotStore<S> = {
      getSnapshot: () => last,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      set: (next) => {
        last = next
        for (const listener of listeners) listener()
      },
    }
    this.listeners.add(() => { store.set(project()) })
    return store
  }

  /**
   * Read the card-level state: what the Host serves, and what a save would do.
   * @returns the form state every card shares.
   */
  shell(): CardShell {
    const snapshot = this.scope.getSnapshot()
    const plan = this.plan()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some(item => item.run === undefined),
      saving: this.saving,
      failed: this.failed,
    }
  }

  /**
   * Read one control's state.
   * @param field - field name of a section field.
   * @returns the draft string, whether a save would leave an override, and whether it is invalid.
   */
  field(field: string): CardFieldState {
    const staged = this.staged.get(field)
    const spec = this.spec(field)
    if (staged === undefined) {
      return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false }
    }
    const write = staged.clear ? { kind: 'clear' as const } : spec.parse(staged.text)
    return {
      text: staged.text,
      overridden: write?.kind === 'set',
      invalid: write === undefined,
    }
  }

  /**
   * Build the edit, reset, save, and discard actions bound to this form.
   * @returns the actions the card's slot entry injects.
   */
  actions(): CardActions {
    return {
      edit: (field, text) => { this.stage(field, { text, clear: false }) },
      resetField: (field) => {
        this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true })
      },
      save: () => { void this.save() },
      discard: () => {
        if (this.staged.size === 0 && !this.failed) return
        this.staged.clear()
        this.failed = false
        this.publish()
      },
    }
  }

  /**
   * Write every staged edit, then re-seed from what the Host accepted. A save
   * that did not land keeps its drafts, so the user corrects them instead of
   * retyping.
   */
  async save(): Promise<void> {
    const plan = this.plan()
    const writes = plan.flatMap(item => item.run === undefined ? [] : [item.run])
    if (plan.length === 0 || this.saving || writes.length !== plan.length) return
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const write of writes) {
      landed = await write() && landed
    }
    if (landed) this.staged.clear()
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  /**
   * Every staged edit a save would write. An entry whose draft is not a value
   * its field accepts carries no write: the form stays dirty and the save
   * refuses rather than dropping the edit.
   */
  private plan(): PlannedWrite[] {
    const plan: PlannedWrite[] = []
    for (const [field, staged] of this.staged) {
      const spec = this.spec(field)
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, run: () => this.clear(field) })
        continue
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue
      const write = spec.parse(staged.text)
      if (write === undefined) plan.push({ field, run: undefined })
      else if (write.kind === 'clear') plan.push({ field, run: () => this.clear(field) })
      else plan.push({ field, run: () => this.store(field, write.value) })
    }
    return plan
  }

  private async clear(field: string): Promise<boolean> {
    await this.scope.unset(field)
    return !this.stored(field)
  }

  private async store(field: string, value: unknown): Promise<boolean> {
    await this.scope.set(field, value)
    return this.userLayer()?.[field] === value
  }

  private stage(field: string, edit: StagedEdit): void {
    this.staged.set(field, edit)
    this.failed = false
    this.publish()
  }

  private spec(field: string): CardFieldSpec {
    const spec = this.specs.get(field)
    if (spec === undefined) throw new Error(`plugin card has no field ${field}`)
    return spec
  }

  private snapshotOf(): SettingsScopeSnapshot<T> {
    return this.scope.getSnapshot()
  }

  private sectionValue(field: string): unknown {
    return (this.snapshotOf().value as Record<string, unknown> | undefined)?.[field]
  }

  private baseValue(field: string): unknown {
    return (this.snapshotOf().base as Record<string, unknown> | undefined)?.[field]
  }

  private userLayer(): Record<string, unknown> | undefined {
    return this.snapshotOf().user as Record<string, unknown> | undefined
  }

  private stored(field: string): boolean {
    const user = this.userLayer()
    return user !== undefined && Object.hasOwn(user, field)
  }

  private publish(): void {
    for (const listener of this.listeners) listener()
  }
}
