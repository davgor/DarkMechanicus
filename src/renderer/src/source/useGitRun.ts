import { useCallback, useState } from 'react'
import type { GitResult } from '../../../shared/git/api'
import { GitCommandError, callGit } from '../api/git'

interface GitRun {
  busy: boolean
  /** The last failure's message, shown until the next run. */
  failure: string | null
  /**
   * Runs one `window.git` call. `onDone` gets its data; `onFailure` may handle a failure itself by returning
   * true (otherwise its message is shown).
   */
  run<T>(call: () => Promise<GitResult<T>>, onDone: (data: T) => void, onFailure?: (error: GitCommandError) => boolean): void
}

/** Busy and failure state for the dialogs and rows that change the repository. */
export function useGitRun(): GitRun {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const run = useCallback<GitRun['run']>((call, onDone, onFailure) => {
    setBusy(true)
    setFailure(null)
    callGit(call()).then(
      (data) => {
        setBusy(false)
        onDone(data)
      },
      (error: unknown) => {
        setBusy(false)
        if (!(error instanceof GitCommandError && onFailure?.(error) === true)) {
          setFailure(error instanceof Error ? error.message : 'Git did not answer.')
        }
      }
    )
  }, [])
  return { busy, failure, run }
}
