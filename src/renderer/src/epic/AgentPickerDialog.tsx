/**
 * Starting one of the epic's agents by role. The Lexmechanic starts the epic's planner chat and selects it; the Magos
 * opens the Start run dialog, so a run keeps its own agent, model, instructions and policy and is never started here.
 * When main will start the Lexmechanic on a Skitarii agent (`pickChatAgent`), its model and effort are chosen here
 * from that agent's OMP catalog first.
 */
import './epicAgentPanel.css'
import { useState, type ReactNode } from 'react'
import { pickChatAgent } from '../../../shared/agents/pickChatAgent'
import type { AgentId } from '../../../shared/desktop/api'
import { AgentRolePicker } from '../agentRoles/AgentRolePicker'
import type { AgentRole } from '../agentRoles/agentRoles'
import type { StartingModel } from '../agents/ChatDialogs'
import { CatalogModelChoice } from '../agents/NewChatFields'
import { errorMessage } from '../api/dm'
import { Dialog } from '../components/Dialog'
import { runLocks, startRunBlocker, type StartRunBlocker } from './headerView'
import type { WorkspaceHandle } from './useWorkspace'

/** The Magos card's reason for each way the header's Start run is withheld. */
const MAGOS_BLOCKED: Record<StartRunBlocker, string> = {
  completed: 'The epic is complete',
  no_plan: 'Save the plan first',
  draft_view: 'View the saved plan to start a run',
  active_run: 'A run is active; its Magos is in the list',
  open_transfer: 'A Linear transfer is open'
}

/** Why the Magos cannot start now: exactly when the header withholds Start run. None when it can. */
function disabledRoles(ws: WorkspaceHandle): Partial<Record<AgentRole, string>> {
  const blocker = startRunBlocker({ epic: ws.data.epic, view: ws.state.view, ...runLocks(ws.data) })
  return blocker === null ? {} : { orchestrator: MAGOS_BLOCKED[blocker] }
}

interface PlannerModel {
  /** The Skitarii agent main will start the Lexmechanic on (`pickChatAgent`); null for any other agent, which takes no model here. */
  skitarii: AgentId | null
  model: string | null
  thinking: StartingModel['thinking']
  choose(model: string | null, thinking: StartingModel['thinking']): void
  /** What `startPlanner` carries: the model and effort when one was chosen for the Skitarii agent; nothing for Default. */
  request: { model?: string; thinking?: NonNullable<StartingModel['thinking']> }
}

/** The Lexmechanic's model and effort, chosen for the agent main will pick; forgotten when that agent changes. */
function usePlannerModel(ws: WorkspaceHandle): PlannerModel {
  const { agents, statuses } = ws.orchestration
  const picked = pickChatAgent(agents, statuses)?.agentId ?? null
  const skitarii = agents.find((agent) => agent.id === picked && agent.kind === 'omp')?.id ?? null
  const [chosen, setChosen] = useState<StartingModel & { agent: AgentId | null }>({ agent: null, model: null, thinking: null })
  const { model, thinking } = chosen.agent !== null && chosen.agent === skitarii ? chosen : { model: null, thinking: null }
  return {
    skitarii, model, thinking,
    choose: (next, level) => setChosen({ agent: skitarii, model: next, thinking: level }),
    request: { ...(model === null ? {} : { model }), ...(thinking === null ? {} : { thinking }) }
  }
}

/**
 * The Magos and Lexmechanic cards for this epic. `onStarted` fires once the choice took: the planner chat is selected,
 * or the Start run dialog is open. A refusal (a `no_agent` sign-in prompt) stays shown here instead.
 */
export function EpicRolePicker({ ws, onStarted }: { ws: WorkspaceHandle; onStarted?(): void }): JSX.Element {
  const [starting, setStarting] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const planner = usePlannerModel(ws)
  async function startPlanner(): Promise<void> {
    setStarting(true)
    setProblem(null)
    try {
      const result = await window.dm.chats.startPlanner({ folder: ws.folder.path, epicId: ws.epicId, ...planner.request })
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
      {planner.skitarii !== null && <CatalogModelChoice folder={ws.folder.path} agent={planner.skitarii} label="Lexmechanic model"
        model={planner.model} thinking={planner.thinking} onChange={planner.choose} />}
      {starting && <p role="status" className="ew-muted">Starting the Lexmechanic…</p>}
      {problem !== null && <p role="alert" className="ew-notice-error">{problem}</p>}
    </div>
  )
}

/**
 * The role picker in a dialog, for starting another of the epic's agents; Escape or a backdrop press closes it.
 * `children` follow the cards (the tab strip's Reopen list).
 */
export function AgentPickerDialog({ ws, onClose, children }: { ws: WorkspaceHandle; onClose(): void; children?: ReactNode }): JSX.Element {
  return (
    <Dialog title="Start an agent" description="The Lexmechanic plans this epic with you; the Magos runs it." onClose={onClose}>
      <EpicRolePicker ws={ws} onStarted={onClose} />
      {children}
    </Dialog>
  )
}
