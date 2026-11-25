/**
 * `window.dm.settings` for renderer tests: starts at the defaults, keeps what was last set and records every saved
 * value. It confirms nothing: the native confirmation of a loosening change lives in main.
 */
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  type SettingsApi
} from '../../../shared/desktop/notificationSettings'

export class FakeSettings implements SettingsApi {
  notifications: NotificationSettings = structuredClone(DEFAULT_NOTIFICATION_SETTINGS)
  /** Every value passed to `setNotifications`, oldest first. */
  readonly saved: NotificationSettings[] = []

  getNotifications(): Promise<NotificationSettings> {
    return Promise.resolve(structuredClone(this.notifications))
  }

  setNotifications(next: NotificationSettings): Promise<NotificationSettings> {
    this.saved.push(structuredClone(next))
    this.notifications = structuredClone(next)
    return this.getNotifications()
  }
}
