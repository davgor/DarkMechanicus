/**
 * Starting one of the epic's agents by role. The Lexmechanic starts the epic's planner chat and selects it; the Magos
 * opens the Start run dialog, so a run keeps its own agent, model, instructions and policy and is never started here.
 */
import './epicAgentPanel.css'
import { useState } from 'react'
import { isActiveRunState } from '../../../shared/domain/status'
import { AgentRolePicker } from '../agentRoles/AgentRolePicker'
import type { AgentRole } from '../agentRoles/agentRoles'
import { errorMessage } from '../api/dm'
import { Dialog } from '../components/Dialog'
import type { WorkspaceHandle } from './useWorkspace'

/** Why the Magos cannot start now, read from the workspace's own plan and run; none when it can. */
function disabledRoles(ws: WorkspaceHandle): Partial<Record<AgentRole, string>> {
  if (ws.data.epic.currentRevisionId === null) return { orchestrator: 'Save the plan first' }
  const run = ws.data.run
  return run !== null && isActiveRunState(run.state) ? { orchestrator: 'A run is active; its Magos is in the list' } : {}
}

/**
 * The Magos and Lexmechanic cards for this epic. `onStarted` fires once the choice took: the planner chat is selected,
 * or the Start run dialog is open. A refusal (a `no_agent` sign-in prompt) stays shown here instead.
 */
export function EpicRolePicker({ ws, onStarted }: { ws: WorkspaceHandle; onStarted?(): void }): JSX.Element {
  const [starting, setStarting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  async function startPlanner(): Promise<void> {
    setStarting(true)
    setProblem(null)
    try {
      const result = await window.dm.chats.startPlanner({ folder: ws.folder.path, epicId: ws.epicId })
      if (!result.ok) {
        // A `no_agent` refusal carries main's sign-in prompt text.
        setProblem(result.error.message)
        return
      }
      setProblem(result.data.problem)
      if (result.data.chat !== null) {
        ws.dispatch({ type: 'select_agent', chatId: result.data.chat.id })
        await ws.orchestration.onChatsChanged()
        if (result.data.problem === null) onStarted?.()
      }
    } catch (error) {
      setProblem(errorMessage(error))
    } finally {
      setStarting(false)
    }
  }
  const choose = (role: AgentRole): void => {
    if (starting) return
    if (role === 'planner') {
      void startPlanner()
      return
    }
    ws.openStartRun()
    onStarted?.()
  }
  return (
    <div className="eap-picker">
      <AgentRolePicker onChoose={choose} disabled={disabledRoles(ws)} />
      {starting && <p role="status" className="ew-muted">Starting the Lexmechanic…</p>}
      {problem !== null && <p role="alert" className="ew-notice-error">{problem}</p>}
    </div>
  )
}

/** The role picker in a dialog, for starting another of the epic's agents; Escape or a backdrop press closes it. */
export function AgentPickerDialog({ ws, onClose }: { ws: WorkspaceHandle; onClose(): void }): JSX.Element {
  return (
    <Dialog title="Start an agent" description="The Lexmechanic plans this epic with you; the Magos runs it." onClose={onClose}>
      <EpicRolePicker ws={ws} onStarted={onClose} />
    </Dialog>
  )
}
