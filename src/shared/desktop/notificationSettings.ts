/**
 * The "Notifications & approvals" settings. Main owns them: it stores them in the app database, reads them at every
 * decision and never trusts a renderer copy. The renderer reads and edits them only through the two
 * `settings:*Notifications` channels; loosening a security setting needs the person at a native dialog in main.
 */
import { z } from 'zod'
import type { CommandResult } from './api'

/** The events that can raise an OS notification. */
export const NOTIFICATION_EVENTS = ['approval_needed', 'question', 'checkpoint_ready', 'run_failed', 'run_stalled'] as const

type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]

/** One always-ask pattern: a tool, command or approval kind the Magos arbiter never decides on its own. */
const alwaysAskEntrySchema = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_.:*-]+$/)

export const ALWAYS_ASK_LIMIT = 50

const arbitrationSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  alwaysAsk: z.array(alwaysAskEntrySchema).max(ALWAYS_ASK_LIMIT),
  autoHandleNotes: z.string().max(4000)
})

export const notificationSettingsSchema = z.strictObject({
  version: z.literal(1),
  events: z.strictObject({
    approval_needed: z.boolean(),
    question: z.boolean(),
    checkpoint_ready: z.boolean(),
    run_failed: z.boolean(),
    run_stalled: z.boolean()
  }) satisfies z.ZodType<Record<NotificationEvent, boolean>>,
  sound: z.boolean(),
  whenFocused: z.enum(['skip', 'notify']),
  arbitration: arbitrationSettingsSchema
})

export type NotificationSettings = z.infer<typeof notificationSettingsSchema>

/** Every event on, with sound, skipped while the app is focused; the Magos arbiter on with nothing always asked. */
export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  version: 1,
  events: { approval_needed: true, question: true, checkpoint_ready: true, run_failed: true, run_stalled: true },
  sound: true,
  whenFocused: 'skip',
  arbitration: { enabled: true, alwaysAsk: [], autoHandleNotes: '' }
}

export const SETTINGS_CHANNELS = {
  getNotifications: 'settings:getNotifications',
  setNotifications: 'settings:setNotifications'
} as const

/**
 * `window.dm.settings`: one invoke per method, each answering `{ ok, data }` or `{ ok: false, error }`; main validates
 * `next` and may ask the person to confirm it.
 */
export interface SettingsApi {
  getNotifications(): Promise<CommandResult<NotificationSettings>>
  /**
   * Saves and returns the settings. An invalid shape is refused with `invalid_input`; a loosening change the person
   * declines at the native confirmation is refused with `cancelled` and changes nothing.
   */
  setNotifications(next: NotificationSettings): Promise<CommandResult<NotificationSettings>>
}
