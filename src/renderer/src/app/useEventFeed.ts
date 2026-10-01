import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { Dispatch } from 'react'
import { runCommand } from '../api/dm'
import { createEventPoller } from './eventPoller'
import type { EventPoller } from './eventPoller'
import { EMPTY_TOKENS, routeEvents, tokenReducer } from './eventRouting'
import type { TokenAction, Tokens } from './eventRouting'
import type { Scheduler } from './scheduler'
import { useLatest } from './useLatest'

export const SELECTED_POLL_MS = 1500
export const BACKGROUND_POLL_MS = 5000

interface FeedOptions {
  /** Folders to watch: the selected one plus those expanded in the sidebar. */
  paths: readonly string[]
  selectedPath: string | null
  scheduler: Scheduler
  onError(error: unknown): void
}

interface EventFeed {
  tokens: Tokens
  /** Forces a refresh of a folder's epic list and storage status, e.g. after a local mutation. */
  bumpFolder(path: string): void
}

interface Polling {
  paths: readonly string[]
  selectedPath: string | null
  scheduler: Scheduler
  pollers: Map<string, EventPoller>
  dispatch: Dispatch<TokenAction>
  onError(error: unknown): void
}

function pollerFor(path: string, polling: Polling): EventPoller {
  const known = polling.pollers.get(path)
  if (known) {
    return known
  }
  const created = createEventPoller({
    fetchPage: (request) => runCommand(path, 'listEvents', request),
    onEvents: (events) => polling.dispatch({ type: 'events', path, route: routeEvents(events) }),
    onReady: () => polling.dispatch({ type: 'bump', path }),
    onError: polling.onError
  })
  polling.pollers.set(path, created)
  return created
}

/** Starts one interval per watched folder and returns a function that stops them all. */
function startPolling(polling: Polling): () => void {
  for (const known of Array.from(polling.pollers.keys())) {
    if (!polling.paths.includes(known)) {
      polling.pollers.delete(known)
    }
  }
  const stops = polling.paths.map((path) => {
    const poller = pollerFor(path, polling)
    const every = path === polling.selectedPath ? SELECTED_POLL_MS : BACKGROUND_POLL_MS
    void poller.tick()
    return polling.scheduler.every(every, () => void poller.tick())
  })
  return () => stops.forEach((stop) => stop())
}

/**
 * Watches the event log of each active folder. New events bump the per-epic and per-folder
 * refresh tokens; consumers refetch when a token they depend on changes and never reset their
 * own unsaved state.
 */
export function useEventFeed(options: FeedOptions): EventFeed {
  const [tokens, dispatch] = useReducer(tokenReducer, EMPTY_TOKENS)
  const pollers = useRef(new Map<string, EventPoller>())
  const onError = useLatest(options.onError)
  const { paths, selectedPath, scheduler } = options
  const pathsKey = paths.join('\n')

  useEffect(
    () =>
      startPolling({
        paths,
        selectedPath,
        scheduler,
        pollers: pollers.current,
        dispatch,
        onError: (error) => onError.current(error)
      }),
    // `paths` is represented by its joined key so a new array with the same members is not a change.
    [pathsKey, selectedPath, scheduler, onError]
  )

  const bumpFolder = useCallback((path: string) => dispatch({ type: 'bump', path }), [])
  return { tokens, bumpFolder }
}
