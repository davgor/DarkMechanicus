/**
 * The two `settings:*Notifications` channels, the only way the renderer reads or edits the notification and
 * approval settings. `ipc` is the sender-guarded registrar; `next` arrives untrusted and `setNotifications`
 * validates it strictly before main decides whether the person must confirm it.
 */
import type { IpcMain } from 'electron'
import { SETTINGS_CHANNELS, type NotificationSettings } from '../../shared/desktop/notificationSettings'
import type { AppSettings } from './appSettings'

/** Arguments are `unknown` because they come straight from IPC. */
export interface SettingsHandlers {
  getNotifications(): Promise<NotificationSettings>
  setNotifications(next: unknown): Promise<NotificationSettings>
}

export function createSettingsHandlers(settings: AppSettings): SettingsHandlers {
  return {
    getNotifications: async () => settings.notifications(),
    setNotifications: (next) => settings.setNotifications(next)
  }
}

export function registerSettingsIpc(ipc: Pick<IpcMain, 'handle'>, handlers: SettingsHandlers): void {
  ipc.handle(SETTINGS_CHANNELS.getNotifications, () => handlers.getNotifications())
  ipc.handle(SETTINGS_CHANNELS.setNotifications, (_event, next: unknown) => handlers.setNotifications(next))
}
