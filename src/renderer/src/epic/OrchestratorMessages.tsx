import { usePersistentState } from '../app/usePersistentState'
import { ConversationPanel } from '../conversation/ConversationPanel'
import type { WorkspaceHandle } from './useWorkspace'

const OPEN_STORAGE_KEY = 'dm.orchestratorMessages.open'
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'

/** Epic-level conversation with the orchestrator, kept available beneath the workspace stage. */
export function OrchestratorMessages({ ws }: { ws: WorkspaceHandle }): JSX.Element {
  const [open, setOpen] = usePersistentState(OPEN_STORAGE_KEY, false, isBoolean)
  return (
    <section className={open ? 'ew-orchestrator-messages is-open' : 'ew-orchestrator-messages'} aria-label="Orchestrator messages">
      <button type="button" className="ew-orchestrator-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        Orchestrator messages
      </button>
      <ConversationPanel
        folderPath={ws.folder.path}
        target={{ epicId: ws.epicId }}
        messages={() => ws.runner('listComments', { epicId: ws.epicId })}
        reloadKey={ws.state.loadedAt}
        canSend={ws.data.epic.status !== 'completed'}
        folderKey={ws.folder.attachmentKey}
        onOpenChat={ws.orchestration.onOpenChat}
      />
    </section>
  )
}
