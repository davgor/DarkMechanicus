/**
 * The two run events the renderer reports to main for an OS notification (`window.dm.notifications.raise`): a
 * submitted sprint report is a checkpoint ready for the person, and a failed run. Only ids travel: main reads the title.
 */
import type { NotificationsApi } from '../../../shared/desktop/notifications'
import type { EventView } from '../../../shared/domain/views'

type RaiseRequest = Parameters<NotificationsApi['raise']>[0]

interface NotificationRaise {
  /**
   * `checkpoint_ready:<runId>:<sprintId>`, so report revisions of one sprint share it, or `run_failed:<runId>`. A key
   * notifies once per app session (`useEventFeed`); across a restart see `raiseNotifications` there.
   */
  key: string
  request: RaiseRequest
}

/** Maps `report.submitted` and `run.failed` events to raise requests; events without their ids and other kinds map to nothing. */
export function notificationRaises(events: readonly EventView[], folder: string): NotificationRaise[] {
  const raises: NotificationRaise[] = []
  for (const { kind, epicId, runId, payload } of events) {
    if (epicId === null || runId === null) continue
    if (kind === 'report.submitted') {
      const sprintId = payload.sprintId
      if (typeof sprintId !== 'string' || sprintId === '') continue
      raises.push({ key: `checkpoint_ready:${runId}:${sprintId}`, request: { folder, kind: 'checkpoint_ready', epicId, runId } })
    } else if (kind === 'run.failed') {
      raises.push({ key: `run_failed:${runId}`, request: { folder, kind: 'run_failed', epicId, runId } })
    }
  }
  return raises
}
