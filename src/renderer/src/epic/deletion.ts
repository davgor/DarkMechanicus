/**
 * The workspace's two deletes. Both run through `perform`, so the shell refreshes the sidebar on
 * success; the epic delete then leaves the epic, and the ticket delete closes the ticket's panel.
 */
import type { SaveResultView } from '../../../shared/domain/views'
import type { WorkspaceHandle } from './useWorkspace'

/** Deletes the open epic and leaves it; a refusal shows in the banner and the epic stays open. */
export async function deleteOpenEpic(ws: WorkspaceHandle): Promise<void> {
  const result = await ws.actions.perform(() => ws.runner('deleteEpic', { epicId: ws.epicId }))
  if (result.ok) {
    ws.onDeleted()
    return
  }
  ws.dispatch({ type: 'banner', text: result.failure.message })
}

/** "Deleted DM-12. Saved rev 5." or, while the snapshot is still being written, says it is pending. */
function ticketDeletedMessage(key: string, result: SaveResultView): string {
  if (result.status === 'pending') {
    const reason = result.error === null ? '' : ` (${result.error})`
    return `Deleted ${key}. Rev ${result.revisionNumber} is pending — its snapshot hasn't been written yet.${reason}`
  }
  return `Deleted ${key}. Saved rev ${result.revisionNumber}.`
}

/** Deletes a ticket from the saved plan; resolves to the refusal's reason, or null once it is gone. */
export async function deleteTicketFromPlan(ws: WorkspaceHandle, ticketId: string, key: string): Promise<string | null> {
  const result = await ws.actions.perform(() => ws.runner('deleteTicket', { epicId: ws.epicId, ticketId }))
  if (!result.ok) {
    return result.failure.message
  }
  ws.dispatch({ type: 'select_ticket', ticketId: null })
  ws.dispatch({ type: 'toast', text: ticketDeletedMessage(key, result.value) })
  return null
}
