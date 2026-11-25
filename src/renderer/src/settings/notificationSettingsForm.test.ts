import { describe, expect, it } from 'vitest'
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from '../../../shared/desktop/notificationSettings'
import { NOTES_LIMIT, addAlwaysAsk, isDirty, notesError, removeAlwaysAsk, validForm } from './notificationSettingsForm'

const settings = (): NotificationSettings => structuredClone(DEFAULT_NOTIFICATION_SETTINGS)
const fifty = Array.from({ length: 50 }, (_, index) => `tool_${index}`)

describe('addAlwaysAsk', () => {
  it('adds a trimmed entry matching the shared regex, including the mcp__server__* prefix form', () => {
    expect(addAlwaysAsk([], '  Bash ')).toEqual({ ok: true, list: ['Bash'] })
    expect(addAlwaysAsk(['Bash'], 'mcp__github__*')).toEqual({ ok: true, list: ['Bash', 'mcp__github__*'] })
  })

  it('refuses an empty, malformed or over-long entry', () => {
    for (const bad of ['', '   ', 'rm -rf', 'Bash(ls)', 'a/b', 'x'.repeat(101)]) {
      const result = addAlwaysAsk([], bad)
      expect(result.ok, bad).toBe(false)
    }
    expect(addAlwaysAsk([], 'rm -rf')).toEqual({
      ok: false,
      error: 'Use only letters, digits and _ . : * - (no spaces), at most 100 characters.'
    })
    expect(addAlwaysAsk([], 'x'.repeat(100)).ok).toBe(true)
  })

  it('refuses a case-insensitive duplicate', () => {
    expect(addAlwaysAsk(['Bash'], 'bash')).toEqual({ ok: false, error: 'bash is already on the list.' })
    expect(addAlwaysAsk(['mcp__X__*'], ' MCP__x__* ').ok).toBe(false)
  })

  it('accepts the 50th entry and refuses the 51st', () => {
    const fortyNine = fifty.slice(0, 49)
    const added = addAlwaysAsk(fortyNine, 'tool_49')
    expect(added).toEqual({ ok: true, list: fifty })
    expect(addAlwaysAsk(fifty, 'tool_50')).toEqual({
      ok: false,
      error: 'The list holds at most 50 entries; remove one first.'
    })
  })
})

describe('removeAlwaysAsk', () => {
  it('removes only the entry at the index', () => {
    expect(removeAlwaysAsk(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
    expect(removeAlwaysAsk(['a'], 3)).toEqual(['a'])
  })
})

describe('notes limit', () => {
  it('allows exactly 4,000 characters and refuses 4,001', () => {
    expect(NOTES_LIMIT).toBe(4000)
    expect(notesError('n'.repeat(4000))).toBeNull()
    expect(notesError('n'.repeat(4001))).toBe('The notes hold at most 4,000 characters; remove 1.')
    const over = settings()
    over.arbitration.autoHandleNotes = 'n'.repeat(4001)
    expect(validForm(over)).toBeNull()
  })
})

describe('isDirty', () => {
  it('is false for an equal copy and true for a change in any field', () => {
    const base = settings()
    expect(isDirty(settings(), base)).toBe(false)
    const changes: ((form: NotificationSettings) => void)[] = [
      (form) => (form.events.run_stalled = false),
      (form) => (form.sound = false),
      (form) => (form.whenFocused = 'notify'),
      (form) => (form.arbitration.enabled = false),
      (form) => (form.arbitration.alwaysAsk = ['Bash']),
      (form) => (form.arbitration.autoHandleNotes = 'x')
    ]
    for (const change of changes) {
      const form = settings()
      change(form)
      expect(isDirty(form, base)).toBe(true)
    }
  })

  it('sees a reordered or replaced always-ask list as dirty', () => {
    const base = settings()
    base.arbitration.alwaysAsk = ['a', 'b']
    const form = structuredClone(base)
    form.arbitration.alwaysAsk = ['b', 'a']
    expect(isDirty(form, base)).toBe(true)
    form.arbitration.alwaysAsk = ['a', 'b']
    expect(isDirty(form, base)).toBe(false)
  })
})

describe('validForm', () => {
  it('returns the full object for a valid form', () => {
    const form = settings()
    form.arbitration.alwaysAsk = fifty
    expect(validForm(form)).toEqual(form)
  })
})
