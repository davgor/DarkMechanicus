import { useEffect, useRef, useState } from 'react'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { GitErrorShape } from '../../../shared/git/api'
import { useLatest } from '../app/useLatest'
import { targetPath } from './cloneTarget'

export interface RunningClone {
  id: string
  /** The clone parent it runs in: its progress events carry it, and its cancel names it. */
  parent: string
  phase: string | null
  percent: number | null
}

/** What a failed clone shows: the sign-in prompt for auth, the taken path, else the message with git's detail. */
export type CloneFailure =
  | { kind: 'auth' }
  | { kind: 'exists'; path: string }
  | { kind: 'other'; message: string; detail: string | null }

interface CloneModel {
  /** The folder clones go into; null until one is chosen, undefined while it loads. */
  parent: string | null | undefined
  chooseParent(): void
  running: RunningClone | null
  failure: CloneFailure | null
  start(url: string, name: string): void
  /** Stops the running clone, if any; it then ends `cancelled`, which shows nothing. */
  cancel(): void
}

/** Null for a cancel, which shows nothing. */
function failureOf(error: GitErrorShape, target: string): CloneFailure | null {
  switch (error.code) {
    case 'cancelled':
      return null
    case 'auth_required':
    case 'auth_failed':
      return { kind: 'auth' }
    case 'target_exists':
      return { kind: 'exists', path: target }
    default:
      return { kind: 'other', message: error.message, detail: error.detail ?? null }
  }
}

const NO_ANSWER: GitErrorShape = { code: 'git_failed', message: 'Git did not answer.' }

/** The clone parent, loaded once and changed with the native folder dialog; failures leave it unset. */
function useCloneParent(): [string | null | undefined, () => void] {
  const [parent, setParent] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    void window.git.getCloneParent().then((result) => {
      if (live) setParent(result.ok ? result.data : null)
    })
    return () => {
      live = false
    }
  }, [])
  const choose = (): void => {
    void window.git.chooseCloneParent().then((result) => {
      if (result.ok && result.data !== null) setParent(result.data)
    })
  }
  return [parent, choose]
}

/** Follows the progress of the running clone only. */
function useCloneProgress(setRunning: (update: (previous: RunningClone | null) => RunningClone | null) => void): void {
  useEffect(
    () =>
      window.git.onProgress((event) => {
        setRunning((previous) =>
          previous === null || previous.id !== event.operationId || previous.parent !== event.folder
            ? previous
            : { ...previous, phase: event.phase, percent: event.percent }
        )
      }),
    [setRunning]
  )
}

/** Clones into the clone parent with a new operation id each time: progress, cancel, and the outcome. */
export function useClone(onCloned: (folder: TrackedFolderView) => void): CloneModel {
  const [parent, chooseParent] = useCloneParent()
  const [running, setRunning] = useState<RunningClone | null>(null)
  const [failure, setFailure] = useState<CloneFailure | null>(null)
  const runningRef = useRef<RunningClone | null>(null)
  runningRef.current = running
  const cloned = useLatest(onCloned)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  useCloneProgress(setRunning)

  const start = (url: string, name: string): void => {
    if (typeof parent !== 'string' || runningRef.current !== null) return
    const clone: RunningClone = { id: crypto.randomUUID(), parent, phase: null, percent: null }
    runningRef.current = clone
    setRunning(clone)
    setFailure(null)
    const settle = (error: GitErrorShape | null, folder?: TrackedFolderView): void => {
      if (!live.current) return
      setRunning(null)
      if (folder !== undefined) cloned.current(folder)
      else if (error !== null) setFailure(failureOf(error, targetPath(parent, name)))
    }
    window.git.clone({ operationId: clone.id, url, name }).then(
      (result) => (result.ok ? settle(null, result.data) : settle(result.error)),
      () => settle(NO_ANSWER)
    )
  }
  const cancel = (): void => {
    const current = runningRef.current
    if (current !== null) void window.git.cancelOperation(current.parent, current.id)
  }
  return { parent, chooseParent, running, failure, start, cancel }
}
