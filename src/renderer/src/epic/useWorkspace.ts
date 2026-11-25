import { useCallback, useEffect, useMemo, useReducer, useState, type Dispatch, type MutableRefObject } from 'react'
import type { AgentView, TrackedFolderView } from '../../../shared/desktop/api'
import { unwrapChat } from '../agents/chatCalls'
import { CommandError, errorMessage } from '../api/dm'
import type { Scheduler } from '../app/scheduler'
import { useLatest } from '../app/useLatest'
import { useClock } from './clock'
import type { OrchestrationHost, StartOrchestrator, TransferChats } from './orchestration'
import { bindRunner, type Runner } from './runner'
import { useViewMemory } from './viewMemory'
import { createWorkspaceActions, type WorkspaceActions } from './workspaceActions'
import { loadWorkspace } from './workspaceLoad'
import {
  initialWorkspaceState,
  workspaceReducer,
  type WorkspaceAction,
  type WorkspaceData,
  type WorkspaceState
} from './workspaceState'

interface WorkspaceController {
  state: WorkspaceState
  dispatch: Dispatch<WorkspaceAction>
  actions: WorkspaceActions
  runner: Runner
  reload(): void
}

/** Everything a loaded workspace's components need. */
export interface WorkspaceHandle {
  state: WorkspaceState
  data: WorkspaceData
  dispatch: Dispatch<WorkspaceAction>
  actions: WorkspaceActions
  runner: Runner
  /** Reads the epic again. */
  reload(): void
  now: number
  /** Timers for what the workspace polls (the run feed). */
  scheduler: Scheduler
  folder: TrackedFolderView
  epicId: string
  /** Agents, chats and navigation for starting a run with an agent and linking the chat that runs it. */
  orchestration: OrchestrationHost
  onOpenEpic(epicId: string): void
  /** Opens an epic of another tracked folder in its own workspace; null where the shell offers no such navigation. */
  onOpenFolderEpic: ((folderPath: string, epicId: string) => void) | null
  /** Tells the shell another tracked folder changed from here (its sidebar lists its epics again); null where it cannot. */
  onFolderChanged: ((folderPath: string) => void) | null
  /** Leaves the epic once it has been deleted. */
  onDeleted(): void
}

interface WorkspaceInput {
  folderPath: string
  identity: string
  epicId: string
  refreshToken: number
  onChanged(): void
  onChatsChanged(): Promise<void>
  /** Opens one of the folder's chats: the orchestrator chat a run was started with, or the transfer chat once one is started or resumed. */
  onOpenChat(chatId: string): void
  /** The connected agents, read when an action names one. */
  agents: readonly AgentView[]
}

interface LoadInput {
  runner: Runner
  epicId: string
  refreshToken: number
  reloadToken: object
  dispatch: Dispatch<WorkspaceAction>
  /** The latest state: an unchanged draft is read only while the draft is shown or chosen. */
  stateRef: MutableRefObject<WorkspaceState>
}

/** Loads the epic into the workspace state, again whenever the refresh or reload token changes. */
function useWorkspaceLoad({ runner, epicId, refreshToken, reloadToken, dispatch, stateRef }: LoadInput): void {
  const clock = useClock()
  useEffect(() => {
    let active = true
    dispatch({ type: 'load_started' })
    loadWorkspace(runner, epicId, () => stateRef.current.view === 'draft' || stateRef.current.chosenView === 'draft').then(
      (data) => {
        if (active) {
          dispatch({ type: 'load_succeeded', data, at: clock.now() })
        }
      },
      (error: unknown) => {
        if (active) {
          const unavailable = error instanceof CommandError && ['not_found', 'not_initialized', 'project_mismatch', 'unsafe_path'].includes(error.code)
          dispatch({ type: 'load_failed', message: errorMessage(error), unavailable })
        }
      }
    )
    return () => {
      active = false
    }
  }, [runner, epicId, refreshToken, reloadToken, clock, dispatch, stateRef])
}

/** The transfer calls of the chat bridge, for one epic of one folder. */
function transferChatsFor(folder: string, epicId: string): TransferChats {
  return {
    start: (choice) => unwrapChat(window.dm.chats.startTransferChat({ folder, epicId, agent: choice.agent, model: choice.model })),
    find: () => unwrapChat(window.dm.chats.findTransferChat({ folder, epicId })),
    prompt: () => unwrapChat(window.dm.chats.transferPrompt({ folder, epicId })),
    copy: (text) => window.dm.copyText(text)
  }
}

/**
 * Loads the epic (again whenever `refreshToken` changes or an action reloads) and binds actions. The
 * view the person picks is remembered for the epic, so it reopens there after visiting another one.
 */
export function useWorkspace(input: WorkspaceInput): WorkspaceController {
  const memory = useViewMemory()
  const { folderPath, identity, epicId, refreshToken } = input
  const runner = useMemo(() => bindRunner(folderPath), [folderPath])
  const [state, dispatch] = useReducer(workspaceReducer, null, () => {
    const snapshot = memory.workspace(identity, epicId)
    return {
      ...initialWorkspaceState(memory.recall(identity, epicId)),
      ...snapshot,
      validation: snapshot?.data?.validation ?? null
    }
  })
  const [reloadToken, setReloadToken] = useState<object>({})
  const stateRef = useLatest(state)
  const changedRef = useLatest(input.onChanged)
  const chatsChangedRef = useLatest(input.onChatsChanged)
  const openChatRef = useLatest(input.onOpenChat)
  const agentsRef = useLatest(input.agents)
  const startOrchestrator = useMemo<StartOrchestrator>(
    () => (choice) => unwrapChat(window.dm.chats.startOrchestrator({ folder: folderPath, epicId, ...choice })),
    [folderPath, epicId]
  )
  const transferChats = useMemo(() => transferChatsFor(folderPath, epicId), [folderPath, epicId])
  const reload = useCallback(() => setReloadToken({}), [])
  const { data, loadedAt, view, layout, chosenView, selectedTicketId, checkpointOpen, scorecardOpen } = state
  useEffect(() => {
    memory.remember(identity, epicId, chosenView)
    memory.saveWorkspace(identity, epicId, stateRef.current)
    if (data?.epic.hasDraft === false) memory.discardEditors(identity, epicId) // Not on draft === null: an unchanged draft may be unread.
  }, [memory, identity, epicId, data, loadedAt, view, layout, chosenView, selectedTicketId, checkpointOpen, scorecardOpen, stateRef])
  useWorkspaceLoad({ runner, epicId, refreshToken, reloadToken, dispatch, stateRef })
  const actions = useMemo(
    () =>
      createWorkspaceActions({
        runner,
        epicId,
        startOrchestrator,
        agents: () => agentsRef.current,
        getState: () => stateRef.current,
        dispatch,
        reload,
        onChanged: () => changedRef.current(),
        onChatsChanged: () => chatsChangedRef.current(),
        transferChats,
        onOpenChat: (chatId) => openChatRef.current(chatId)
      }),
    [runner, epicId, startOrchestrator, transferChats, reload, stateRef, changedRef, chatsChangedRef, openChatRef, agentsRef]
  )
  return { state, dispatch, actions, runner, reload }
}
