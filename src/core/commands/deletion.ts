import type { SaveResultView } from '../../shared/domain/views'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { removeEpicFiles } from '../repo/epicRemoval'
import { deleteEpic } from '../services/epicDeletion'
import { saveResult } from '../services/plans'
import { deleteTicket } from '../services/ticketDeletion'
import type { CommandTable, WorkspaceCore } from './types'

/** Like savePlan: the new revision is flushed right away, so the result says whether it is durable. */
function deleteTicketCommand(core: WorkspaceCore, input: { epicId: string; ticketId: string }): SaveResultView {
  const ctx = core.ctx()
  const request = deleteTicket(ctx, input)
  core.safeFlush()
  return saveResult(ctx, request.revisionId)
}

const deletionCommands = {
  deleteEpic: {
    schema: COMMAND_SCHEMAS.deleteEpic,
    mutates: true,
    run: (core, input) =>
      deleteEpic(core.ctx(), input, (epicId, runIds) =>
        removeEpicFiles({ layout: core.layout, fs: core.fs }, epicId, runIds)
      )
  },
  deleteTicket: { schema: COMMAND_SCHEMAS.deleteTicket, mutates: false, run: deleteTicketCommand }
} satisfies Partial<CommandTable>

export { deletionCommands }
