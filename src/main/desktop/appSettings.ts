/**
 * The app-wide settings main owns, stored as JSON in the app database's `app_meta` table. Today that is the
 * "Notifications & approvals" settings under the key `notificationSettings`: every consumer reads
 * `notifications()` at decision time and never a renderer copy.
 *
 * A stored value is read leniently, section by section, so an older or partly damaged value keeps what is still
 * valid: a missing or invalid event, sound or focus setting takes its default, and an arbitration block that does
 * not parse reads as arbitration off with the valid always-ask entries kept, never as the looser default. Nothing
 * stored, or text that is not a JSON object, gives the defaults. Either fallback is logged once and never throws.
 *
 * A save that loosens a security setting (arbitration turned on, an always-ask entry removed, the auto-handle notes
 * changed) needs the person's yes at the injected native confirmation first; tightening saves without one.
 */
import { z } from 'zod'
import type { Db } from '../../core/db/database'
import { DomainError } from '../../core/errors'
import { parseInput } from '../../core/schemas'
import {
  ALWAYS_ASK_LIMIT,
  DEFAULT_NOTIFICATION_SETTINGS,
  NOTIFICATION_EVENTS,
  notificationSettingsSchema,
  type NotificationSettings
} from '../../shared/desktop/notificationSettings'

const arbitrationSettingsSchema = notificationSettingsSchema.shape.arbitration
const alwaysAskEntrySchema = arbitrationSettingsSchema.shape.alwaysAsk.element

const KEY = 'notificationSettings'

export interface AppSettings {
  /** The current settings, read from the cache (loaded from the database on first use). Frozen. */
  notifications(): NotificationSettings
  /**
   * Validates `next` strictly (`invalid_input`), asks the person to confirm a loosening change (`cancelled` when
   * declined, nothing changed), saves it and tells the `onChange` listeners. Saves run one at a time.
   */
  setNotifications(next: unknown): Promise<NotificationSettings>
  /** Called with the new settings after every save; returns the unsubscribe function. */
  onChange(listener: (settings: NotificationSettings) => void): () => void
}

interface AppSettingsDeps {
  db: Db
  /** The native confirmation; true only when the person approved the change described by `summary`. */
  confirm(summary: string): Promise<boolean>
  logger: { warn(message: string, ...details: unknown[]): void }
}

export function createAppSettings(deps: AppSettingsDeps): AppSettings {
  let cached: NotificationSettings | undefined
  let saving: Promise<unknown> = Promise.resolve()
  const listeners = new Set<(settings: NotificationSettings) => void>()

  const notifications = (): NotificationSettings => {
    cached ??= frozen(readStored(deps))
    return cached
  }

  const save = async (next: unknown): Promise<NotificationSettings> => {
    const parsed = parseInput(notificationSettingsSchema, next, 'notification settings')
    const loosening = looseningChanges(notifications(), parsed)
    if (loosening.length > 0 && !(await deps.confirm(loosening.join('\n')))) {
      throw new DomainError('cancelled', 'The change was not confirmed.')
    }
    deps.db.run(
      'INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      KEY,
      JSON.stringify(parsed)
    )
    const saved = frozen(parsed)
    cached = saved
    for (const listener of listeners) {
      try {
        listener(saved)
      } catch (error: unknown) {
        deps.logger.warn('A notification settings listener failed:', error)
      }
    }
    return saved
  }

  return {
    notifications,
    setNotifications: (next) => {
      const run = saving.then(() => save(next))
      saving = run.catch(() => undefined)
      return run
    },
    onChange: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    }
  }
}

/** What `next` loosens compared with `current`, one line per change; empty when it loosens nothing. */
function looseningChanges(current: NotificationSettings, next: NotificationSettings): string[] {
  const changes: string[] = []
  if (!current.arbitration.enabled && next.arbitration.enabled) {
    changes.push('Turn on the Magos arbiter, which decides routine worker approvals without asking you.')
  }
  const kept = new Set(next.arbitration.alwaysAsk)
  const removed = current.arbitration.alwaysAsk.filter((entry) => !kept.has(entry))
  if (removed.length > 0) {
    changes.push(`Stop always asking you about: ${removed.join(', ')}.`)
  }
  if (current.arbitration.autoHandleNotes !== next.arbitration.autoHandleNotes) {
    changes.push('Change the notes that tell the Magos arbiter what it may handle on its own.')
  }
  return changes
}

const storedObjectSchema = z.record(z.string(), z.unknown())

function readStored(deps: AppSettingsDeps): NotificationSettings {
  const row = deps.db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', KEY)
  if (row === undefined) return DEFAULT_NOTIFICATION_SETTINGS
  let stored: Record<string, unknown>
  try {
    stored = storedObjectSchema.parse(JSON.parse(row.value))
  } catch (error: unknown) {
    deps.logger.warn('The stored notification settings are unreadable; using the defaults.', error)
    return DEFAULT_NOTIFICATION_SETTINGS
  }
  const strict = notificationSettingsSchema.safeParse(stored)
  if (strict.success) return strict.data
  const settings = lenientSettings(stored)
  deps.logger.warn(
    settings.arbitration.enabled
      ? 'Parts of the stored notification settings were invalid or missing and took their defaults.'
      : 'The stored notification settings were partly invalid; invalid parts took their defaults and arbitration is off.'
  )
  return settings
}

/** Each section of `stored` that parses on its own, the default for every other one; see the module comment. */
function lenientSettings(stored: Record<string, unknown>): NotificationSettings {
  const defaults = DEFAULT_NOTIFICATION_SETTINGS
  const events = storedObjectSchema.safeParse(stored.events).data ?? {}
  const sound = z.boolean().safeParse(stored.sound)
  const whenFocused = notificationSettingsSchema.shape.whenFocused.safeParse(stored.whenFocused)
  return {
    version: 1,
    events: Object.fromEntries(
      NOTIFICATION_EVENTS.map((event) => [event, z.boolean().safeParse(events[event]).data ?? defaults.events[event]])
    ) as NotificationSettings['events'],
    sound: sound.success ? sound.data : defaults.sound,
    whenFocused: whenFocused.success ? whenFocused.data : defaults.whenFocused,
    arbitration: lenientArbitration(stored.arbitration)
  }
}

function lenientArbitration(stored: unknown): NotificationSettings['arbitration'] {
  const strict = arbitrationSettingsSchema.safeParse(stored)
  if (strict.success) return strict.data
  const block = storedObjectSchema.safeParse(stored).data ?? {}
  const entries = Array.isArray(block.alwaysAsk) ? block.alwaysAsk : []
  const alwaysAsk = [
    ...new Set(entries.flatMap((entry: unknown) => alwaysAskEntrySchema.safeParse(entry).data ?? []))
  ].slice(0, ALWAYS_ASK_LIMIT)
  const notes = arbitrationSettingsSchema.shape.autoHandleNotes.safeParse(block.autoHandleNotes)
  return { enabled: false, alwaysAsk, autoHandleNotes: notes.success ? notes.data : '' }
}

/** A deeply frozen copy, so no consumer can change the cache (or the shared defaults) in place. */
function frozen(settings: NotificationSettings): NotificationSettings {
  const copy = structuredClone(settings)
  Object.freeze(copy.events)
  Object.freeze(copy.arbitration.alwaysAsk)
  Object.freeze(copy.arbitration)
  return Object.freeze(copy)
}
