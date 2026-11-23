import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { errorMessage, runCommand } from '../api/dm'
import type { KanbanBoardView } from '../../../shared/domain/kanban'
import { useViewMemory } from '../epic/viewMemory'
import { useLatest } from '../app/useLatest'

/** Done cards fetched per page, and per Show more. */
const DONE_PAGE = 20
/** The most Done cards one `listKanbanCards` call returns. */
const DONE_LIMIT_MAX = 100

interface KanbanBoardState {
  status: 'loading' | 'ready' | 'error'
  /** The last board read; Done holds every page loaded so far. Null before the first response. */
  board: KanbanBoardView | null
  /** Why the last read failed; the previous board stays on screen. */
  error: string | null
  /** A Show more request is in flight. */
  loadingMore: boolean
}

export interface KanbanBoardModel extends KanbanBoardState {
  /** Fetches the next page of Done and appends it. */
  showMore(): void
  /** Reads the board again now, keeping the Done pages already shown. */
  reload(): void
}

const LOADING: KanbanBoardState = { status: 'loading', board: null, error: null, loadingMore: false }

interface Paging {
  path: string
  current: MutableRefObject<KanbanBoardState>
  report: MutableRefObject<((error: unknown) => void) | undefined>
  latest: MutableRefObject<object>
  setState(update: (previous: KanbanBoardState) => KanbanBoardState): void
}

function useDonePaging({ path, current, report, latest, setState }: Paging): () => void {
  return useCallback(() => {
    const cursor = current.current.board?.doneNextCursor ?? null
    if (cursor === null || current.current.loadingMore) return
    const ticket = latest.current
    setState(previous => ({ ...previous, loadingMore: true }))
    void runCommand(path, 'listKanbanCards', { doneLimit: DONE_PAGE, doneCursor: cursor }).then(
      page => {
        if (latest.current !== ticket) return
        setState(previous => {
          if (previous.board === null) return previous
          const lanes = { ...previous.board.lanes, done: [...previous.board.lanes.done, ...page.lanes.done] }
          return { ...previous, board: { ...page, lanes }, loadingMore: false }
        })
      },
      error => {
        if (latest.current !== ticket) return
        setState(previous => ({ ...previous, loadingMore: false }))
        report.current?.(error)
      }
    )
  }, [path, current, report, latest, setState])
}

/**
 * One folder's board, kept current like `useEpicLists`: read on mount and whenever the folder's
 * event token moves (card writes emit workspace events) or `reload` is called. A refresh asks for as
 * many Done cards as are shown, so paging survives it; stale responses are dropped.
 */
export function useKanbanBoard(path: string, refreshToken: number, onError?: (error: unknown) => void, projectIdentity?: string): KanbanBoardModel {
  const memory = useViewMemory()
  const identity = projectIdentity ?? path
  const [stored, setStored] = useState<{ identity: string; state: KanbanBoardState } | null>(null)
  const cached = projectIdentity === undefined ? undefined : memory.board(identity)
  const state = stored?.identity === identity ? stored.state : cached === undefined ? LOADING : { ...LOADING, status: 'ready' as const, board: cached }
  const setState = useCallback((update: (previous: KanbanBoardState) => KanbanBoardState) => {
    setStored(previous => ({ identity, state: update(previous?.identity === identity ? previous.state : state) }))
  }, [identity, state])
  const [reloads, setReloads] = useState(0)
  const current = useLatest(state)
  const report = useLatest(onError)
  // Every read takes a new ticket; a response whose ticket is no longer the latest is dropped.
  const latest = useRef<object>({})

  useEffect(() => {
    const ticket = {}
    latest.current = ticket
    const shown = current.current.board?.lanes.done.length ?? 0
    const doneLimit = Math.min(DONE_LIMIT_MAX, Math.max(DONE_PAGE, shown))
    runCommand(path, 'listKanbanCards', { doneLimit }).then(
      (board) => {
        if (latest.current !== ticket) return
        if (projectIdentity !== undefined) memory.saveBoard(identity, board)
        setStored({ identity, state: { status: 'ready', board, error: null, loadingMore: false } })
      },
      (error: unknown) => {
        if (latest.current !== ticket) return
        setStored({ identity, state: { ...current.current, status: 'error', error: errorMessage(error), loadingMore: false } })
        report.current?.(error)
      }
    )
    return () => { latest.current = {} }
  }, [path, identity, projectIdentity, refreshToken, reloads, current, report, memory])

  const showMore = useDonePaging({ path, current, report, latest, setState })

  const reload = useCallback((): void => setReloads((count) => count + 1), [])

  return { ...state, showMore, reload }
}
