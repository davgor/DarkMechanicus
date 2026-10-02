import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type Dispatch } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import { errorMessage } from '../api/dm'
import { useClock } from './clock'
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
  folder: TrackedFolderView
  epicId: string
  onOpenEpic(epicId: string): void
}

interface WorkspaceInput {
  folderPath: string
  epicId: string
  refreshToken: number
  onChanged(): void
}

/**
 * Loads the epic (again whenever `refreshToken` changes or an action reloads) and binds actions. The
 * view the person picks is remembered for the epic, so it reopens there after visiting another one.
 */
export function useWorkspace(input: WorkspaceInput): WorkspaceController {
  const clock = useClock()
  const memory = useViewMemory()
  const { folderPath, epicId, refreshToken } = input
  const runner = useMemo(() => bindRunner(folderPath), [folderPath])
  const [state, dispatch] = useReducer(workspaceReducer, memory.recall(folderPath, epicId), initialWorkspaceState)
  const [reloadToken, setReloadToken] = useState<object>({})
  const stateRef = useRef(state)
  stateRef.current = state
  const changedRef = useRef(input.onChanged)
  changedRef.current = input.onChanged
  const reload = useCallback(() => setReloadToken({}), [])
  useEffect(() => {
    memory.remember(folderPath, epicId, state.chosenView)
  }, [memory, folderPath, epicId, state.chosenView])
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
  }, [runner, epicId, refreshToken, reloadToken, clock])
  const actions = useMemo(
    () =>
      createWorkspaceActions({
        runner,
        epicId,
        getState: () => stateRef.current,
        dispatch,
        reload,
        onChanged: () => changedRef.current()
      }),
    [runner, epicId, reload]
  )
  return { state, dispatch, actions, runner, reload }
}
