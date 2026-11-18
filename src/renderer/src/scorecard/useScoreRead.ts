import { useEffect, useRef, useState } from 'react'
import { runCommand } from '../api/dm'
import type { Scheduler } from '../app/scheduler'
import { useLatest } from '../app/useLatest'
import { type CommandRunner, createScoreReader, loadScore, type ScoreIdentity, type ScoreReader, type ScoreReadState, scoreKey, type ScoreViewOf, shownState } from './scoreReads'

/** How often a shown scorecard is read again while nothing announces a change: grades move with usage reports too. */
export const SCORE_POLL_MS = 15_000

interface ScoreReadOptions<I extends ScoreIdentity> {
  /** The tracked folder whose records are read; null shows nothing. */
  folder: string | null
  /** The scorecard to show; null shows nothing. */
  identity: I | null
  /** Change it to read again now (for example the sequence of the last event about this run or report). */
  version: number | string
  scheduler: Scheduler
  /** False for a reading taken only on request (a dated reassessment): regaining focus does not read it again. */
  refreshOnFocus?: boolean
}

/**
 * Follows one scorecard through the desktop command channel: loads it when the identity changes (dropping any answer
 * for the previous one), reads it again when `version` changes, every `SCORE_POLL_MS` and (unless `refreshOnFocus` is
 * false) when the window regains focus, and keeps the last good data through a failed refresh. It returns only state
 * about the current identity: in the render where the identity changes it is `loading`, never the previous one's data.
 */
export function useScoreRead<I extends ScoreIdentity>(options: ScoreReadOptions<I>): ScoreReadState<ScoreViewOf<I>> {
  const [state, setState] = useState<ScoreReadState<ScoreViewOf<I>>>({ status: 'idle' })
  const reader = useRef<ScoreReader<ScoreViewOf<I>> | null>(null)
  reader.current ??= createScoreReader<ScoreViewOf<I>>({ onChange: setState, now: Date.now })
  const { folder, identity, version, scheduler, refreshOnFocus = true } = options
  const latest = useLatest(identity)
  const key = folder === null || identity === null ? null : scoreKey(folder, identity)

  useEffect(() => {
    const current = latest.current
    if (key === null || folder === null || current === null) {
      void reader.current?.select(null, () => Promise.reject(new Error('Nothing is selected.')))
      return
    }
    const run: CommandRunner = (name, input) => runCommand(folder, name, input)
    void reader.current?.select(key, () => loadScore(run, current))
  }, [key, folder, latest])

  // The first render's version is already read by the selection above; only a change asks again.
  const readVersion = useRef(version)
  useEffect(() => {
    if (readVersion.current === version) {
      return
    }
    readVersion.current = version
    void reader.current?.refresh()
  }, [version])

  useEffect(() => {
    if (key === null) {
      return undefined
    }
    const refresh = (): void => {
      void reader.current?.refresh()
    }
    const stop = scheduler.every(SCORE_POLL_MS, refresh)
    if (refreshOnFocus) window.addEventListener('focus', refresh)
    return () => {
      stop()
      window.removeEventListener('focus', refresh)
    }
  }, [key, scheduler, refreshOnFocus])

  return shownState(state, key)
}
