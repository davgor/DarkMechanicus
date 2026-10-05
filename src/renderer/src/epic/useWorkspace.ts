import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { unwrapChat } from '../agents/chatCalls'
import { errorMessage } from '../api/dm'
import type { Scheduler } from '../app/scheduler'
import { useClock } from './clock'
import type { OrchestrationHost, StartOrchestrator } from './orchestration'
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
  now: number
  /** Timers for what the workspace polls (the run feed). */
  scheduler: Scheduler
  folder: TrackedFolderView
  epicId: string
  /** Agents, chats and navigation for starting a run with an agent and linking the chat that runs it. */
  orchestration: OrchestrationHost
  onOpenEpic(epicId: string): void
  /** Leaves the epic once it has been deleted. */
  onDeleted(): void
}

interface WorkspaceInput {
  folderPath: string
  epicId: string
  refreshToken: number
  onChanged(): void
  onChatsChanged(): void
}

interface LoadInput {
  runner: Runner
  epicId: string
  refreshToken: number
  reloadToken: object
  dispatch: Dispatch<WorkspaceAction>
}

/** Loads the epic into the workspace state, again whenever the refresh or reload token changes. */
function useWorkspaceLoad({ runner, epicId, refreshToken, reloadToken, dispatch }: LoadInput): void {
  const clock = useClock()
  useEffect(() => {
    let active = true
    dispatch({ type: 'load_started' })
    loadWorkspace(runner, epicId).then(
      (data) => {
        if (active) {
          dispatch({ type: 'load_succeeded', data, at: clock.now() })
        }
      },
      (error: unknown) => {
        if (active) {
          dispatch({ type: 'load_failed', message: errorMessage(error) })
        }
      }
    )
    return () => {
      active = false
    }
  }, [runner, epicId, refreshToken, reloadToken, clock, dispatch])
}

/**
 * Loads the epic (again whenever `refreshToken` changes or an action reloads) and binds actions. The
 * view the person picks is remembered for the epic, so it reopens there after visiting another one.
 */
export function useWorkspace(input: WorkspaceInput): WorkspaceController {
  const memory = useViewMemory()
  const { folderPath, epicId, refreshToken } = input
  const runner = useMemo(() => bindRunner(folderPath), [folderPath])
  const [state, dispatch] = useReducer(workspaceReducer, memory.recall(folderPath, epicId), initialWorkspaceState)
  const [reloadToken, setReloadToken] = useState<object>({})
  const stateRef = useRef(state)
  stateRef.current = state
  const changedRef = useRef(input.onChanged)
  changedRef.current = input.onChanged
  const chatsChangedRef = useRef(input.onChatsChanged)
  chatsChangedRef.current = input.onChatsChanged
  const startOrchestrator = useMemo<StartOrchestrator>(
    () => (choice) => unwrapChat(window.dm.chats.startOrchestrator({ folder: folderPath, epicId, agent: choice.agent, model: choice.model })),
    [folderPath, epicId]
  )
  const reload = useCallback(() => setReloadToken({}), [])
  useEffect(() => {
    memory.remember(folderPath, epicId, state.chosenView)
  }, [memory, folderPath, epicId, state.chosenView])
  useWorkspaceLoad({ runner, epicId, refreshToken, reloadToken, dispatch })
  const actions = useMemo(
    () =>
      createWorkspaceActions({
        runner,
        epicId,
        startOrchestrator,
        getState: () => stateRef.current,
        dispatch,
        reload,
        onChanged: () => changedRef.current(),
        onChatsChanged: () => chatsChangedRef.current()
      }),
    [runner, epicId, startOrchestrator, reload]
  )
  return { state, dispatch, actions, runner, reload }
}
