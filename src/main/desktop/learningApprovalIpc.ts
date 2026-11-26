/**
 * DM-956: the `dm:approveLearningCard` channel (`window.dm.approveLearningCard`). Only the app's own window reaches it
 * (`guardIpc`), it runs with the desktop session of the folder's own workspace, and the folder must be tracked; the
 * coordinator validates the exact reviewed card, attempt and drafts hash. The result is a `CommandResult`, so a
 * refusal or a conflict reaches the renderer as a structured domain error rather than a thrown IPC error.
 */
import type { IpcMain } from 'electron'
import { toErrorShape } from '../../core/errors'
import type { CommandResult } from '../../shared/desktop/api'
import type { KanbanCardView } from '../../shared/domain/kanban'
import type { LearningApprovalController } from '../kanban/approveLearningCard'

export interface LearningApprovalHandlers {
  approveLearningCard(folder: unknown, input: unknown): Promise<CommandResult<KanbanCardView>>
}

export function createLearningApprovalHandlers(approvals: Pick<LearningApprovalController, 'approve'>): LearningApprovalHandlers {
  return {
    async approveLearningCard(folder, input) {
      try {
        return { ok: true, data: await approvals.approve(folder, input) }
      } catch (error) {
        return { ok: false, error: toErrorShape(error) }
      }
    }
  }
}

export function registerLearningApprovalIpc(ipcMain: Pick<IpcMain, 'handle'>, handlers: LearningApprovalHandlers): void {
  ipcMain.handle('dm:approveLearningCard', (_event, folder: unknown, input: unknown) => handlers.approveLearningCard(folder, input))
}
