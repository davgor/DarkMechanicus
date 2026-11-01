import { useCallback, useEffect, useRef, useState } from 'react'
import { callGit, GitCommandError } from '../api/git'
import type { Scheduler } from '../app/scheduler'
import { useLatest } from '../app/useLatest'

/** How often the open Source control tab fetches in the background. */
export const BACKGROUND_FETCH_MS = 10 * 60 * 1000

export type SyncOperation = 'fetch' | 'pull' | 'push'

export interface RunningSync {
  id: string
  operation: SyncOperation
  phase: string | null
  percent: number | null
}

/** What a failed operation shows: Pull for a rejected push, the sign-in prompt for auth, else git's message. */
export type SyncFailure =
  | { kind: 'rejected' }
  | { kind: 'auth'; revoked: boolean }
  | { kind: 'other'; message: string; detail: string | null }

interface SyncModel {
  running: RunningSync | null
  failure: SyncFailure | null
  /** The last background fetch's error, shown quietly; null once one succeeds. */
  warning: string | null
  run(operation: SyncOperation): void
  cancel(): void
  dismiss(): void
}

interface Options {
  folderPath: string
  scheduler: Scheduler
  signedIn: boolean
  /** The sync remote is HTTPS github.com, so the account's credentials apply and nothing else can prompt. */
  githubHttps: boolean
  onRefresh(): void
}

/** Null for outcomes that show nothing: success, a cancel, or merge conflicts (Changes lists them after the refresh). */
function failureOf(error: GitCommandError | null, signedIn: boolean): SyncFailure | null {
  if (error === null) {
    return null
  }
  switch (error.code) {
    case 'cancelled':
    case 'merge_conflicts':
      return null
    case 'rejected_non_fast_forward':
      return { kind: 'rejected' }
    case 'auth_required':
    case 'auth_failed':
      return { kind: 'auth', revoked: error.code === 'auth_failed' && signedIn }
    default:
      return { kind: 'other', message: error.message, detail: error.detail ?? null }
  }
}

/** Settles to the failure (any thrown error becomes a `git_failed` one), or null on success. */
function attempt(folderPath: string, operation: SyncOperation, operationId: string): Promise<GitCommandError | null> {
  return callGit(window.git[operation](folderPath, { operationId })).then(
    () => null,
    (error: unknown) =>
      error instanceof GitCommandError
        ? error
        : new GitCommandError({ code: 'git_failed', message: error instanceof Error ? error.message : 'Git did not answer.' })
  )
}

/** Shows progress of the operation with this id only. */
function useProgress(folderPath: string, setRunning: (update: (previous: RunningSync | null) => RunningSync | null) => void): void {
  useEffect(
    () =>
      window.git.onProgress((event) => {
        setRunning((previous) =>
          previous === null || previous.id !== event.operationId || event.folder !== folderPath ? previous : { ...previous, phase: event.phase, percent: event.percent }
        )
      }),
    [folderPath, setRunning]
  )
}

/** Fetches every 10 minutes while enabled; failures only set the warning. */
function useBackgroundFetch(options: Options, busy: () => boolean, setWarning: (warning: string | null) => void): void {
  const latest = useLatest(options)
  const enabled = options.signedIn && options.githubHttps
  useEffect(() => {
    if (!enabled) {
      return undefined
    }
    return options.scheduler.every(BACKGROUND_FETCH_MS, () => {
      if (busy()) {
        return
      }
      const { folderPath } = latest.current
      void attempt(folderPath, 'fetch', crypto.randomUUID()).then((error) => {
        if (error?.code !== 'cancelled') {
          setWarning(error === null ? null : error.message)
        }
        latest.current.onRefresh()
      })
    })
  }, [enabled, options.scheduler, busy, latest, setWarning])
}

/** Fetch, pull and push for one folder: the running operation and its progress, cancel, errors and background fetch. */
export function useSync(options: Options): SyncModel {
  const { folderPath, signedIn, onRefresh } = options
  const [running, setRunning] = useState<RunningSync | null>(null)
  const [failure, setFailure] = useState<SyncFailure | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const runningRef = useRef<RunningSync | null>(null)
  runningRef.current = running
  const busy = useCallback(() => runningRef.current !== null, [])
  useProgress(folderPath, setRunning)
  useBackgroundFetch(options, busy, setWarning)
  const run = (operation: SyncOperation): void => {
    if (runningRef.current !== null) {
      return
    }
    const id = crypto.randomUUID()
    runningRef.current = { id, operation, phase: null, percent: null }
    setRunning(runningRef.current)
    setFailure(null)
    void attempt(folderPath, operation, id).then((error) => {
      runningRef.current = null
      setRunning(null)
      setFailure(failureOf(error, signedIn))
      onRefresh()
    })
  }
  const cancel = (): void => {
    if (running !== null) {
      void window.git.cancelOperation(folderPath, running.id)
    }
  }
  return { running, failure, warning, run, cancel, dismiss: () => setFailure(null) }
}
