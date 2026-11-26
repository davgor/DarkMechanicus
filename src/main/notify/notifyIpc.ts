/**
 * `notifications:raise`: the renderer reports a run event it observed (a checkpoint ready, a run failed) by ids only.
 * The request is validated strictly, its folder must be tracked, and main reads the epic title from the folder's own
 * workspace: no renderer text reaches a notification. `ipc` is the sender-guarded registrar.
 */
import type { IpcMain } from 'electron'
import { parseInput } from '../../core/schemas'
import type { CommandResult } from '../../shared/desktop/api'
import { NOTIFICATION_CHANNELS, notificationRaiseSchema, type NavigateTarget } from '../../shared/desktop/notifications'
import { answer } from '../agents/chatHandlers'
import type { FolderRegistry } from '../desktop/folderRegistry'
import { requireTracked } from '../desktop/handlers'
import type { WorkspacePool } from '../desktop/workspacePool'
import type { NotificationEvent } from './notifier'

/** Arguments are `unknown` because they come straight from IPC. */
export interface NotifyHandlers {
  raise(request: unknown): Promise<CommandResult<null>>
}

interface NotifyHandlerDeps {
  registry: Pick<FolderRegistry, 'resolve'>
  workspaces: Pick<WorkspacePool, 'get'>
  /** The OS notifier's `notify`: it applies the settings and shows a key once per 10 minutes. */
  notify(event: NotificationEvent): void
  /** Told about every failure that is not a `DomainError`, which the renderer sees as `internal`. */
  onUnexpectedError?: (error: unknown) => void
}

/** A checkpoint lands on the epic's checkpoint, a failed run on the epic; the dedupe key is `<kind>:<runId>`. */
export function createNotifyHandlers(deps: NotifyHandlerDeps): NotifyHandlers {
  return {
    raise: (request) => answer(deps, async () => {
      const { folder, kind, epicId, runId } = parseInput(notificationRaiseSchema, request, 'notification')
      const tracked = requireTracked(deps.registry, folder)
      const { title } = await deps.workspaces.get(tracked).getEpic({ epicId })
      const target: NavigateTarget = kind === 'checkpoint_ready'
        ? { kind: 'checkpoint', folder: tracked, epicId }
        : { kind: 'epic', folder: tracked, epicId }
      deps.notify(kind === 'checkpoint_ready'
        ? { kind, key: `${kind}:${runId}`, title: `Checkpoint ready: ${title}`, body: 'A sprint checkpoint waits for your review.', target }
        : { kind, key: `${kind}:${runId}`, title: `Run failed: ${title}`, body: 'Open the epic to see what failed.', target })
      return null
    })
  }
}

export function registerNotifyIpc(ipc: Pick<IpcMain, 'handle'>, handlers: NotifyHandlers): void {
  ipc.handle(NOTIFICATION_CHANNELS.raise, (_event, request: unknown) => handlers.raise(request))
}
