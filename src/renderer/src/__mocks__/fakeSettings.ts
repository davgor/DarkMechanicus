/**
 * `window.dm.settings` for renderer tests: starts at the defaults, keeps what was last set and records every value
 * passed to `setNotifications`. It confirms nothing (the native confirmation lives in main): queue a failure in
 * `failures` (`cancelled` for a declined confirmation, `invalid_input` for a refused shape) to have the next save
 * answer it and change nothing.
 */
import type { CommandResult } from '../../../shared/desktop/api'
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  type SettingsApi
} from '../../../shared/desktop/notificationSettings'
import type { DomainErrorShape } from '../../../shared/domain/errors'

export class FakeSettings implements SettingsApi {
  notifications: NotificationSettings = structuredClone(DEFAULT_NOTIFICATION_SETTINGS)
  /** Every value passed to `setNotifications`, oldest first, including refused ones. */
  readonly saved: NotificationSettings[] = []
  /** Failures the next saves answer, one per call, oldest first. */
  readonly failures: DomainErrorShape[] = []

  getNotifications(): Promise<CommandResult<NotificationSettings>> {
    return Promise.resolve({ ok: true, data: structuredClone(this.notifications) })
  }

  setNotifications(next: NotificationSettings): Promise<CommandResult<NotificationSettings>> {
    this.saved.push(structuredClone(next))
    const error = this.failures.shift()
    if (error !== undefined) return Promise.resolve({ ok: false, error })
    this.notifications = structuredClone(next)
    return this.getNotifications()
  }
}
