import { useEffect, useState } from 'react'
import type { AttemptTimelineView, RunTimelineView } from '../../../shared/domain/activity'
import { runCommand } from '../api/dm'
import {
  createActivityPoller,
  mergeAttemptTimeline,
  mergeRunTimeline,
  type TimelinePage
} from './activityPoller'
import type { Scheduler } from './scheduler'
import { useLatest } from './useLatest'

/** How often a live timeline is polled; the same pace as the selected folder's event feed. */
export const TIMELINE_POLL_MS = 1500

interface Source<V extends TimelinePage> {
  /** Names the timeline being followed; a new key starts over, null follows nothing. */
  key: string | null
  fetchPage(request: { sinceSeq: number; limit: number }): Promise<V>
  size(page: V): number
  merge(held: V | null, page: V): V
}

interface Follow {
  scheduler: Scheduler
  onError(error: unknown): void
}

/** Follows one timeline: replays its history, then polls with the cursor until a page says it is no longer live. */
function useTimeline<V extends TimelinePage>(source: Source<V>, follow: Follow): V | null {
  const [view, setView] = useState<V | null>(null)
  const latest = useLatest(source)
  const onError = useLatest(follow.onError)
  const { scheduler } = follow
  const { key } = source

  useEffect(() => {
    setView(null)
    if (key === null) {
      return undefined
    }
    let active = true
    const poller = createActivityPoller<V>({
      fetchPage: (request) => latest.current.fetchPage(request),
      size: (page) => latest.current.size(page),
      onPage: (page) => {
        if (active) {
          setView((held) => latest.current.merge(held, page))
        }
      },
      onError: (error) => onError.current(error)
    })
    let stop = (): void => undefined
    const step = (): void => {
      void poller.tick().then(() => {
        if (poller.done()) {
          stop()
        }
      })
    }
    step()
    stop = scheduler.every(TIMELINE_POLL_MS, step)
    return () => {
      active = false
      stop()
    }
  }, [key, scheduler, latest, onError])

  return view
}

interface AttemptFollow extends Follow {
  path: string | null
  attemptId: string | null
}

/** The attempt's timeline, kept current while the attempt is live; null until the first page arrives. */
export function useAttemptTimeline(options: AttemptFollow): AttemptTimelineView | null {
  const { path, attemptId } = options
  const key = path === null || attemptId === null ? null : `${path}\n${attemptId}`
  const source: Source<AttemptTimelineView> = {
    key,
    fetchPage: (request) => runCommand(path ?? '', 'getAttemptTimeline', { attemptId: attemptId ?? '', ...request }),
    size: (page) => page.entries.length,
    merge: mergeAttemptTimeline
  }
  return useTimeline(source, options)
}

interface RunFollow extends Follow {
  path: string | null
  runId: string | null
}

/** The run's timeline grouped by session, kept current while the run is active; null until the first page arrives. */
export function useRunTimeline(options: RunFollow): RunTimelineView | null {
  const { path, runId } = options
  const key = path === null || runId === null ? null : `${path}\n${runId}`
  const source: Source<RunTimelineView> = {
    key,
    fetchPage: (request) => runCommand(path ?? '', 'getRunTimeline', { runId: runId ?? '', ...request }),
    size: (page) => page.groups.reduce((total, group) => total + group.entries.length, 0),
    merge: mergeRunTimeline
  }
  return useTimeline(source, options)
}
