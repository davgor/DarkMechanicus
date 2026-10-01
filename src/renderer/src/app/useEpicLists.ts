import { useEffect, useReducer, useRef } from 'react'
import { errorMessage, runCommand } from '../api/dm'
import type { EpicSummaryView } from '../../../shared/domain/views'
import { folderToken } from './eventRouting'
import type { Tokens } from './eventRouting'
import { useLatest } from './useLatest'

export interface EpicListState {
  status: 'loading' | 'ready' | 'error'
  epics: EpicSummaryView[]
  error: string | null
}

const LOADING: EpicListState = { status: 'loading', epics: [], error: null }

type Lists = Record<string, EpicListState>

type ListAction =
  | { type: 'loading'; path: string }
  | { type: 'loaded'; path: string; epics: EpicSummaryView[] }
  | { type: 'failed'; path: string; message: string }

function listsReducer(lists: Lists, action: ListAction): Lists {
  const previous = lists[action.path]
  switch (action.type) {
    case 'loading':
      return previous ? lists : { ...lists, [action.path]: LOADING }
    case 'loaded':
      return { ...lists, [action.path]: { status: 'ready', epics: action.epics, error: null } }
    case 'failed':
      return {
        ...lists,
        [action.path]: { status: 'error', epics: previous?.epics ?? [], error: action.message }
      }
  }
}

/** The list for a folder, or a loading placeholder before its first response. */
export function listFor(lists: Lists, path: string): EpicListState {
  return lists[path] ?? LOADING
}

interface ListOptions {
  paths: readonly string[]
  tokens: Tokens
  onError(error: unknown): void
}

/**
 * Keeps the epic list of every active folder current: fetches when a folder becomes active or its
 * refresh token changes, keeps the previous list on screen meanwhile, and drops stale responses.
 */
export function useEpicLists(options: ListOptions): Lists {
  const [lists, dispatch] = useReducer(listsReducer, {})
  const fetched = useRef(new Map<string, number>())
  const latest = useRef(new Map<string, object>())
  const onError = useLatest(options.onError)
  const { paths, tokens } = options
  const stateKey = paths.map((path) => `${path}\0${folderToken(tokens, path)}`).join('\n')

  useEffect(() => {
    const load = async (path: string): Promise<void> => {
      const ticket = {}
      latest.current.set(path, ticket)
      dispatch({ type: 'loading', path })
      try {
        const epics = await runCommand(path, 'listEpics', undefined)
        if (latest.current.get(path) === ticket) {
          dispatch({ type: 'loaded', path, epics })
        }
      } catch (error) {
        if (latest.current.get(path) === ticket) {
          dispatch({ type: 'failed', path, message: errorMessage(error) })
          onError.current(error)
        }
      }
    }
    for (const path of paths) {
      const token = folderToken(tokens, path)
      if (fetched.current.get(path) !== token) {
        fetched.current.set(path, token)
        void load(path)
      }
    }
    // The joined key stands in for `paths` and `tokens`, which are new objects on every render.
  }, [stateKey, onError])

  return lists
}
