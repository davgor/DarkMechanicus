import { useCallback, useState } from 'react'
import type { RepoState } from '../../../shared/git/status'
import { callGit } from '../api/git'
import type { Scheduler } from '../app/scheduler'
import { useRefreshTick } from '../app/useRefreshTick'
import { useResource } from '../app/useResource'
import type { Resource } from '../app/useResource'

/** How often the repository state is read again while the view is open. */
const REPO_REFRESH_MS = 5000

interface RepoStateModel {
  state: Resource<RepoState>
  /** The message of the last failed read, for the error state. */
  error: string | null
  /** Changes whenever the state is read again, so what depends on it (a diff) can follow. */
  version: number
  /** Reads the state again now. */
  refresh(): void
}

interface Options {
  folder: string
  scheduler: Scheduler
}

/**
 * The folder's repository state through `window.git`. It is read again every 5 seconds, when the window
 * regains focus, and on `refresh()`; an answer for a folder that is no longer shown is dropped.
 */
export function useRepoState({ folder, scheduler }: Options): RepoStateModel {
  const tick = useRefreshTick({ scheduler, everyMs: REPO_REFRESH_MS, enabled: true })
  const [manual, setManual] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const version = tick + manual
  const state = useResource<RepoState>({
    key: folder,
    version,
    load: () => callGit(window.git.getState(folder)).then((value) => {
      setError(null)
      return value
    }),
    onError: (failure) => setError(failure instanceof Error ? failure.message : 'Git did not answer.')
  })
  const refresh = useCallback(() => setManual((previous) => previous + 1), [])
  return { state, error, version, refresh }
}
