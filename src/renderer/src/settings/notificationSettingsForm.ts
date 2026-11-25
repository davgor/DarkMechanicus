/**
 * The pure rules of the "Notifications & approvals" form: the always-ask list editing, the notes limit, the dirty
 * check and the final validation. Every bound comes from the shared schema main enforces, so the form refuses inline
 * exactly what main would refuse.
 */
import {
  ALWAYS_ASK_LIMIT,
  NOTIFICATION_EVENTS,
  notificationSettingsSchema,
  type NotificationSettings
} from '../../../shared/desktop/notificationSettings'

const arbitrationShape = notificationSettingsSchema.shape.arbitration.shape
const alwaysAskEntrySchema = arbitrationShape.alwaysAsk.element

/** The most characters the Magos auto-handles notes may hold. */
export const NOTES_LIMIT = arbitrationShape.autoHandleNotes.maxLength ?? 0

type AlwaysAskAdd = { ok: true; list: string[] } | { ok: false; error: string }

/** Adds one always-ask entry (trimmed), refusing an empty or malformed entry, a case-insensitive duplicate and the 51st. */
export function addAlwaysAsk(list: readonly string[], raw: string): AlwaysAskAdd {
  const entry = raw.trim()
  if (entry === '') return { ok: false, error: 'Type a tool name or pattern first.' }
  if (!alwaysAskEntrySchema.safeParse(entry).success) {
    return {
      ok: false,
      error: 'Use only letters, digits and _ . : * - (no spaces), at most 100 characters.'
    }
  }
  const lower = entry.toLowerCase()
  if (list.some((existing) => existing.toLowerCase() === lower)) {
    return { ok: false, error: `${entry} is already on the list.` }
  }
  if (list.length >= ALWAYS_ASK_LIMIT) {
    return { ok: false, error: `The list holds at most ${ALWAYS_ASK_LIMIT} entries; remove one first.` }
  }
  return { ok: true, list: [...list, entry] }
}

/** The list without the entry at `index`. */
export function removeAlwaysAsk(list: readonly string[], index: number): string[] {
  return list.filter((_, at) => at !== index)
}

/** The inline refusal for notes over the limit, or null when they fit. */
export function notesError(notes: string): string | null {
  return notes.length > NOTES_LIMIT
    ? `The notes hold at most ${NOTES_LIMIT.toLocaleString('en-US')} characters; remove ${(notes.length - NOTES_LIMIT).toLocaleString('en-US')}.`
    : null
}

/** Whether the form differs from the stored baseline in any field. */
export function isDirty(form: NotificationSettings, baseline: NotificationSettings): boolean {
  const { arbitration: a } = form
  const { arbitration: b } = baseline
  return (
    NOTIFICATION_EVENTS.some((event) => form.events[event] !== baseline.events[event]) ||
    form.sound !== baseline.sound ||
    form.whenFocused !== baseline.whenFocused ||
    a.enabled !== b.enabled ||
    a.autoHandleNotes !== b.autoHandleNotes ||
    a.alwaysAsk.length !== b.alwaysAsk.length ||
    a.alwaysAsk.some((entry, index) => entry !== b.alwaysAsk[index])
  )
}

/** The whole form checked against the shared schema: the object to save, or null when main would refuse it. */
export function validForm(form: NotificationSettings): NotificationSettings | null {
  const parsed = notificationSettingsSchema.safeParse(form)
  return parsed.success ? parsed.data : null
}
