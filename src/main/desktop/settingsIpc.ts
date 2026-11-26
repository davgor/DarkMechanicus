/**
 * The two `settings:*Notifications` channels, the only way the renderer reads or edits the notification and
 * approval settings. `ipc` is the sender-guarded registrar; `next` arrives untrusted and `setNotifications`
 * validates it strictly before main decides whether the person must confirm it. Both answer `{ ok, data }` or
 * `{ ok: false, error }` like `chats:*`, so the renderer sees `cancelled` and `invalid_input` by their codes.
 */
import type { IpcMain } from 'electron'
import type { CommandResult } from '../../shared/desktop/api'
import { SETTINGS_CHANNELS, type NotificationSettings } from '../../shared/desktop/notificationSettings'
import { answer } from '../agents/chatHandlers'
import type { AppSettings } from './appSettings'

/** Arguments are `unknown` because they come straight from IPC. */
export interface SettingsHandlers {
  getNotifications(): Promise<CommandResult<NotificationSettings>>
  setNotifications(next: unknown): Promise<CommandResult<NotificationSettings>>
}

interface SettingsHandlerDeps {
  settings: AppSettings
  /** Told about every failure that is not a `DomainError`, which the renderer sees as `internal`. */
  onUnexpectedError?: (error: unknown) => void
}

export function createSettingsHandlers(deps: SettingsHandlerDeps): SettingsHandlers {
  return {
    getNotifications: () => answer(deps, () => deps.settings.notifications()),
    setNotifications: (next) => answer(deps, () => deps.settings.setNotifications(next))
  }
}

export function registerSettingsIpc(ipc: Pick<IpcMain, 'handle'>, handlers: SettingsHandlers): void {
  ipc.handle(SETTINGS_CHANNELS.getNotifications, () => handlers.getNotifications())
  ipc.handle(SETTINGS_CHANNELS.setNotifications, (_event, next: unknown) => handlers.setNotifications(next))
}
