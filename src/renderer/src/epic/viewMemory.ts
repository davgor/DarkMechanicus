import { createContext, useContext } from 'react'
import type { ForgeMemberStatus } from '../../../shared/desktop/forgeWorld'
import type { KanbanBoardView } from '../../../shared/domain/kanban'
import type { EditorState } from '../ticket/ticketForm'
import type { PlanViewKind, WorkspaceState } from './workspaceState'

const MAX_REMEMBERED_VIEWS = 32
const MAX_CACHED_WORKSPACES = 4
const MAX_CACHED_TICKETS = 2000
const MAX_BOARDS = 3
const MAX_FORGE_STATUSES = 32
const MAX_CACHED_CARDS = 2000

/** Data and UI state from the last successful read of this view. Transient actions never survive navigation. */
type WorkspaceSnapshot = Pick<WorkspaceState, 'data' | 'loadedAt' | 'view' | 'layout' | 'selectedTicketId' | 'checkpointOpen' | 'scorecardOpen'>

interface ViewMemory {
  recall(identity: string, epicId: string): PlanViewKind | null
  remember(identity: string, epicId: string, view: PlanViewKind | null): void
  workspace(identity: string, epicId: string): WorkspaceSnapshot | undefined
  saveWorkspace(identity: string, epicId: string, state: WorkspaceState): void
  editor(identity: string, epicId: string, ticketId: string): EditorState | undefined
  saveEditor(identity: string, epicId: string, ticketId: string, state: EditorState): void
  discardEditors(identity: string, epicId: string): void
  forgeStatus(identity: string): ForgeMemberStatus | undefined
  saveForgeStatus(identity: string, status: ForgeMemberStatus): void
  board(identity: string): KanbanBoardView | undefined
  saveBoard(identity: string, board: KanbanBoardView): void
  retain(identities: ReadonlySet<string>): void
}

interface Entry<T> { identity: string; epicId: string; value: T }
const keyOf = (...parts: string[]): string => JSON.stringify(parts)

function remember<T>(map: Map<string, Entry<T>>, key: string, entry: Entry<T>, limit: number): void {
  map.delete(key)
  map.set(key, entry)
  if (map.size > limit) {
    const first = map.keys().next().value
    if (first !== undefined) map.delete(first)
  }
}

function viewChoices(views: Map<string, Entry<PlanViewKind>>): Pick<ViewMemory, 'recall' | 'remember'> {
  return {
    recall: (identity, epicId) => views.get(keyOf(identity, epicId))?.value ?? null,
    remember(identity, epicId, view) {
      const key = keyOf(identity, epicId)
      if (view === null) views.delete(key)
      else remember(views, key, { identity, epicId, value: view }, MAX_REMEMBERED_VIEWS)
    }
  }
}

function localReadiness(forge: Map<string, Entry<ForgeMemberStatus>>): Pick<ViewMemory, 'forgeStatus' | 'saveForgeStatus'> {
  return {
    forgeStatus: identity => forge.get(identity)?.value,
    saveForgeStatus(identity, status) {
      if (status.readiness === 'ready') remember(forge, identity, { identity, epicId: '', value: status }, MAX_FORGE_STATUSES)
      else forge.delete(identity)
    }
  }
}

export function createViewMemory(): ViewMemory {
  const views = new Map<string, Entry<PlanViewKind>>()
  const workspaces = new Map<string, Entry<WorkspaceSnapshot>>()
  const editors = new Map<string, Entry<EditorState>>()
  const forge = new Map<string, Entry<ForgeMemberStatus>>()
  const boards = new Map<string, Entry<KanbanBoardView>>()
  return {
    ...viewChoices(views),
    workspace: (identity, epicId) => workspaces.get(keyOf(identity, epicId))?.value,
    saveWorkspace(identity, epicId, state) {
      const { data, loadedAt, view, layout, selectedTicketId, checkpointOpen, scorecardOpen } = state
      const key = keyOf(identity, epicId)
      if (data === null) {
        workspaces.delete(key)
        return
      }
      const tickets = (data.saved?.bundle.tickets.length ?? 0) + (data.draft?.bundle.tickets.length ?? 0)
      if (tickets > MAX_CACHED_TICKETS) {
        workspaces.delete(key)
        return
      }
      const value = { data, loadedAt, view, layout, selectedTicketId, checkpointOpen, scorecardOpen }
      remember(workspaces, key, { identity, epicId, value }, MAX_CACHED_WORKSPACES)
    },
    editor: (identity, epicId, ticketId) => editors.get(keyOf(identity, epicId, ticketId))?.value,
    saveEditor(identity, epicId, ticketId, state) {
      const key = keyOf(identity, epicId, ticketId)
      // An unapplied edit is user data. Only applying, reverting or removing its draft clears it.
      if (state.touched && !state.awaitingSync) editors.set(key, { identity, epicId, value: state })
      else editors.delete(key)
    },
    discardEditors(identity, epicId) {
      for (const [key, entry] of editors) if (entry.identity === identity && entry.epicId === epicId) editors.delete(key)
    },
    ...localReadiness(forge),
    board: identity => boards.get(identity)?.value,
    saveBoard(identity, board) {
      const size = Object.values(board.lanes).reduce((sum, cards) => sum + cards.length, 0)
      if (size <= MAX_CACHED_CARDS) remember(boards, identity, { identity, epicId: '', value: board }, MAX_BOARDS)
      else boards.delete(identity)
    },
    retain(identities) {
      for (const map of [views, workspaces, editors, boards, forge]) {
        for (const [key, entry] of map) if (!identities.has(entry.identity)) map.delete(key)
      }
    }
  }
}

export const ViewMemoryContext = createContext<ViewMemory | null>(null)
const standaloneMemory = new WeakMap<object, ViewMemory>()

export function useViewMemory(): ViewMemory {
  const provided = useContext(ViewMemoryContext)
  if (provided !== null) return provided
  let memory = standaloneMemory.get(window.dm)
  if (memory === undefined) {
    memory = createViewMemory()
    standaloneMemory.set(window.dm, memory)
  }
  return memory
}
