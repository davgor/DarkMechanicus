import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { Dispatch } from 'react'
import { runCommand } from '../api/dm'
import { createEventPoller, type EventPoller } from './eventPoller'
import { EMPTY_TOKENS, routeEvents, tokenReducer, type TokenAction, type Tokens } from './eventRouting'
import type { Scheduler } from './scheduler'
import { useLatest } from './useLatest'

export const SELECTED_POLL_MS = 1500
export const BACKGROUND_POLL_MS = 5000

interface FeedOptions {
  paths: readonly string[]
  /** Opaque verified store identity by canonical path. */
  identities?: ReadonlyMap<string, string>
  selectedPath: string | null
  scheduler: Scheduler
  onError(error: unknown): void
}

interface FeedPoller {
  identity: string
  poller: EventPoller
}

function createFeedPoller(path: string, identity: string, dispatch: Dispatch<TokenAction>, onError: (error: unknown) => void): FeedPoller {
  return { identity, poller: createEventPoller({
    fetchHead: () => runCommand(path, 'getEventHead', undefined),
    fetchPage: (request) => runCommand(path, 'listEvents', request),
    onEvents: (events) => dispatch({ type: 'events', path, route: routeEvents(events) }),
    onReady: () => dispatch({ type: 'baseline', path, identity }),
    onError
  }) }
}

/** Watch only visible or selected projects. A closed/rebound project's replies are fenced. */
export function useEventFeed({ paths, identities, selectedPath, scheduler, onError }: FeedOptions): {
  tokens: Tokens
  bumpFolder(path: string): void
  pollNow(path: string): void
} {
  const [tokens, dispatch] = useReducer(tokenReducer, EMPTY_TOKENS)
  const pollers = useRef(new Map<string, FeedPoller>())
  const report = useLatest(onError)
  const key = JSON.stringify(paths.map(path => [path, identities?.get(path) ?? path]))

  useEffect(() => {
    const watched = new Map<string, string>(JSON.parse(key) as [string, string][])
    for (const [path, entry] of pollers.current) {
      if (watched.get(path) === entry.identity) continue
      entry.poller.stop()
      pollers.current.delete(path)
      dispatch({ type: 'remove', path })
    }
    const stops = Array.from(watched, ([path, identity]) => {
      let entry = pollers.current.get(path)
      if (entry === undefined) {
        entry = createFeedPoller(path, identity, dispatch, (error) => report.current(error))
        pollers.current.set(path, entry)
        void entry.poller.tick()
      }
      const poller = entry.poller
      const every = path === selectedPath ? SELECTED_POLL_MS : BACKGROUND_POLL_MS
      return scheduler.every(every, () => void poller.tick())
    })
    return () => stops.forEach(stop => stop())
  }, [key, selectedPath, scheduler, report])

  useEffect(() => {
    const current = pollers.current
    return () => {
      for (const entry of current.values()) entry.poller.stop()
      current.clear()
    }
  }, [])

  const bumpFolder = useCallback((path: string) => {
    if (pollers.current.has(path)) dispatch({ type: 'bump', path })
  }, [])
  const pollNow = useCallback((path: string) => { void pollers.current.get(path)?.poller.tick() }, [])
  return { tokens, bumpFolder, pollNow }
}
