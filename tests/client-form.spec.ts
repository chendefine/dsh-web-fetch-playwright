/**
 * The client card form model against a fake settings scope: staging, dirty
 * tracking, save writes (set/clear), failed-save retention, discard, and the
 * radio/checkbox field kinds — no browser, no DOM.
 */
import { describe, expect, it } from 'vitest'
import type { SettingsScope, SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-runtime/client'
import { CardForm, checkboxField, numberField, radioField, textField } from '../src/client/form.ts'

/** Minimal reactive scope double: a snapshot, a publish path, and a write log. */
class FakeScope implements SettingsScope<Record<string, unknown>> {
  snapshot: SettingsScopeSnapshot<Record<string, unknown>>
  readonly writes: Array<{ field: string; op: 'set' | 'unset'; value?: unknown }> = []
  /** When true, writes settle WITHOUT applying (a rejected Host write). */
  dropWrites = false
  private readonly listeners = new Set<() => void>()

  constructor(
    value: Record<string, unknown> = {},
    user: Record<string, unknown> = {},
    base: Record<string, unknown> = {},
  ) {
    this.snapshot = { status: 'ready', value, base, user, revision: 1, writable: true, mode: 'host' }
  }

  getSnapshot(): SettingsScopeSnapshot<Record<string, unknown>> {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async set(field: string, value: unknown): Promise<void> {
    if (this.dropWrites) return
    this.writes.push({ field, op: 'set', value })
    const user = { ...(this.snapshot.user as Record<string, unknown>), [field]: value }
    this.publish({ value: { ...(this.snapshot.value as Record<string, unknown>), [field]: value }, user })
  }

  async unset(field: string): Promise<void> {
    if (this.dropWrites) return
    this.writes.push({ field, op: 'unset' })
    const user = { ...(this.snapshot.user as Record<string, unknown>) }
    const value = { ...(this.snapshot.value as Record<string, unknown>) }
    delete user[field]
    delete value[field]
    this.publish({ value, user })
  }

  private publish(partial: Partial<SettingsScopeSnapshot<Record<string, unknown>>>): void {
    this.snapshot = { ...this.snapshot, ...partial }
    for (const listener of this.listeners) listener()
  }
}

/** The card's field set: backend radio, two text inputs, two checkboxes, two numbers. */
function makeForm(scope: SettingsScope<Record<string, unknown>>) {
  return new CardForm(scope, [
    radioField('backend', ['local', 'cdp']),
    textField('playwrightPath'),
    checkboxField('shareBrowserContext'),
    checkboxField('denoise'),
    numberField('maxConcurrency', 1, 8),
    numberField('challengeWaitMs', 0, 60_000),
  ])
}

describe('CardForm', () => {
  it('seeds field state from the scope snapshot', () => {
    const scope = new FakeScope({ backend: 'cdp', playwrightPath: '/usr/bin/chrome', denoise: false })
    const form = makeForm(scope)
    expect(form.field('backend').text).toBe('cdp')
    expect(form.field('playwrightPath').text).toBe('/usr/bin/chrome')
    expect(form.field('denoise').text).toBe('false')
    expect(form.shell()).toMatchObject({ available: true, writable: true, dirty: false, invalid: false })
  })

  it('stages an edit and marks the form dirty without touching the scope', () => {
    const scope = new FakeScope({ playwrightPath: '' })
    const form = makeForm(scope)
    form.actions().edit('playwrightPath', '/opt/chrome')
    expect(form.field('playwrightPath').text).toBe('/opt/chrome')
    expect(form.shell().dirty).toBe(true)
    expect(scope.writes).toHaveLength(0)
  })

  it('save writes staged edits through scope.set and clears the drafts on success', async () => {
    const scope = new FakeScope({ backend: 'local', playwrightPath: '' })
    const form = makeForm(scope)
    form.actions().edit('backend', 'cdp')
    form.actions().edit('playwrightPath', '/usr/bin/chrome')
    await form.save()
    expect(scope.writes).toEqual([
      { field: 'backend', op: 'set', value: 'cdp' },
      { field: 'playwrightPath', op: 'set', value: '/usr/bin/chrome' },
    ])
    expect(form.shell().dirty).toBe(false)
    expect(form.shell().failed).toBe(false)
  })

  it('keeps drafts and flags the save when the write does not land', async () => {
    const scope = new FakeScope({ playwrightPath: '' })
    scope.dropWrites = true
    const form = makeForm(scope)
    form.actions().edit('playwrightPath', '/opt/chrome')
    await form.save()
    expect(form.shell().failed).toBe(true)
    expect(form.field('playwrightPath').text).toBe('/opt/chrome')
    expect(form.shell().dirty).toBe(true)
  })

  it('resetField stages a clear that lets the field re-inherit the composition layer', async () => {
    const scope = new FakeScope({ playwrightPath: '/old/path' }, { playwrightPath: '/old/path' }, { playwrightPath: '/default' })
    const form = makeForm(scope)
    form.actions().resetField('playwrightPath')
    expect(form.field('playwrightPath').overridden).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([{ field: 'playwrightPath', op: 'unset' }])
    expect(form.shell().dirty).toBe(false)
  })

  it('discard drops every staged edit', () => {
    const scope = new FakeScope({ playwrightPath: '/a' })
    const form = makeForm(scope)
    form.actions().edit('playwrightPath', '/b')
    form.actions().discard()
    expect(form.field('playwrightPath').text).toBe('/a')
    expect(form.shell().dirty).toBe(false)
  })

  it('radioField rejects values outside the option set and blocks the save', () => {
    const form = makeForm(new FakeScope({ backend: 'local' }))
    form.actions().edit('backend', 'whatever')
    expect(form.field('backend').invalid).toBe(true)
    expect(form.shell().invalid).toBe(true)
  })

  it('checkboxField round-trips booleans through the draft strings', async () => {
    const scope = new FakeScope({ denoise: true })
    const form = makeForm(scope)
    form.actions().edit('denoise', 'false')
    expect(form.field('denoise').text).toBe('false')
    expect(form.field('denoise').invalid).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([{ field: 'denoise', op: 'set', value: false }])
    expect(form.field('denoise').text).toBe('false')
  })

  it('the shared-context checkbox seeds absent as empty (card renders the on default)', async () => {
    const scope = new FakeScope({ backend: 'cdp' })
    const form = makeForm(scope)
    // Absent stored value formats as '': the checkbox control falls back to
    // its schema default (checked) while nothing is staged.
    expect(form.field('shareBrowserContext').text).toBe('')
    expect(form.field('shareBrowserContext').overridden).toBe(false)
    expect(form.shell().dirty).toBe(false)

    form.actions().edit('shareBrowserContext', 'false') // the user unchecks
    await form.save()
    expect(scope.writes).toEqual([{ field: 'shareBrowserContext', op: 'set', value: false }])
    expect(form.field('shareBrowserContext').text).toBe('false')
    expect(form.field('shareBrowserContext').overridden).toBe(true)

    form.actions().resetField('shareBrowserContext') // back to the default
    await form.save()
    expect(scope.writes[scope.writes.length - 1]).toEqual({ field: 'shareBrowserContext', op: 'unset' })
    expect(form.field('shareBrowserContext').text).toBe('')
  })

  it('numberField round-trips in-range integers and clears on empty', async () => {
    const scope = new FakeScope({ maxConcurrency: 4 })
    const form = makeForm(scope)
    expect(form.field('maxConcurrency').text).toBe('4')
    form.actions().edit('maxConcurrency', '6')
    expect(form.field('maxConcurrency').invalid).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([{ field: 'maxConcurrency', op: 'set', value: 6 }])
    form.actions().edit('maxConcurrency', '')
    await form.save()
    expect(scope.writes[scope.writes.length - 1]).toEqual({ field: 'maxConcurrency', op: 'unset' })
  })

  it('numberField rejects out-of-range and non-integer drafts, blocking the save', () => {
    const form = makeForm(new FakeScope({ maxConcurrency: 4 }))
    for (const bad of ['0', '9', '2.5', '-1', 'four', '1 2']) {
      form.actions().edit('maxConcurrency', bad)
      expect(form.field('maxConcurrency').invalid, bad).toBe(true)
      expect(form.shell().invalid, bad).toBe(true)
    }
    form.actions().discard()
  })

  it('the challenge-wait field round-trips its millisecond range, 0 included', async () => {
    const scope = new FakeScope({ challengeWaitMs: 15_000 })
    const form = makeForm(scope)
    expect(form.field('challengeWaitMs').text).toBe('15000')
    form.actions().edit('challengeWaitMs', '20000')
    expect(form.field('challengeWaitMs').invalid).toBe(false)
    form.actions().edit('challengeWaitMs', '0') // 0 is the feature-off value, not invalid
    expect(form.field('challengeWaitMs').invalid).toBe(false)
    await form.save()
    expect(scope.writes).toEqual([{ field: 'challengeWaitMs', op: 'set', value: 0 }])
    form.actions().edit('challengeWaitMs', '')
    await form.save()
    expect(scope.writes[scope.writes.length - 1]).toEqual({ field: 'challengeWaitMs', op: 'unset' })
    // Out of range blocks the save like any number field.
    form.actions().edit('challengeWaitMs', '60001')
    expect(form.field('challengeWaitMs').invalid).toBe(true)
    expect(form.shell().invalid).toBe(true)
    form.actions().discard()
  })

  it('an external scope change republishes through the bound snapshot store', () => {
    const scope = new FakeScope({ playwrightPath: '/a' })
    const form = makeForm(scope)
    const store = form.bind(() => form.shell())
    expect(store.getSnapshot().dirty).toBe(false)
    scope.set('playwrightPath', '/b')
    expect(store.getSnapshot().dirty).toBe(false)
  })
})
