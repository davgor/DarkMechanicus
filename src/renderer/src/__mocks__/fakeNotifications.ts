/**
 * `window.dm.notifications` for renderer tests: records every `raise` request and answers `{ ok: true }`; `navigate`
 * delivers a target to every `onNavigate` listener, as main's push would after the person clicks a notification.
 */
import type { z } from 'zod'
import type { CommandResult } from '../../../shared/desktop/api'
import type { NavigateTarget, notificationRaiseSchema, NotificationsApi } from '../../../shared/desktop/notifications'

type RaiseRequest = z.infer<typeof notificationRaiseSchema>

export class FakeNotifications implements NotificationsApi {
  /** Every request passed to `raise`, oldest first. */
  readonly raised: RaiseRequest[] = []
  private readonly listeners = new Set<(target: NavigateTarget) => void>()

  raise(request: RaiseRequest): Promise<CommandResult<null>> {
    this.raised.push(structuredClone(request))
    return Promise.resolve({ ok: true, data: null })
  }

  onNavigate(listener: (target: NavigateTarget) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  navigate(target: NavigateTarget): void {
    for (const listener of this.listeners) listener(target)
  }
}
