import { useEffect, useState } from 'react'
import type { GitResult } from '../../../shared/git/api'
import type { PullRequestInfo, PullRequestSummary } from '../../../shared/github/pullRequests'
import { useGithub } from '../github/GithubAccount'

/** `hidden`: the repository is not on GitHub. `signed-out`: it is, and GitHub needs an account to list its pull requests. */
export type PullRequestsState =
  | { kind: 'loading' }
  | { kind: 'hidden' }
  | { kind: 'signed-out' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; current: PullRequestSummary | null; open: PullRequestSummary[] }

export interface PullRequestsModel {
  state: PullRequestsState
  /** Asks GitHub again, past main's cache. */
  refresh(): void
}

function stateOf(result: GitResult<PullRequestInfo>): PullRequestsState {
  if (!result.ok) {
    return result.error.code === 'auth_required' ? { kind: 'signed-out' } : { kind: 'error', message: result.error.message }
  }
  const { repository, current, open } = result.data
  return repository === null ? { kind: 'hidden' } : { kind: 'ready', current, open }
}

/** On GitHub, whether or not the person is signed in. */
export function isOnGithub(state: PullRequestsState): boolean {
  return state.kind === 'ready' || state.kind === 'signed-out'
}

/** The folder's pull requests, read again when the account or the branch changes, and on `refresh`. */
export function usePullRequests(folderPath: string, branch: string | null): PullRequestsModel {
  const { account } = useGithub()
  const key = `${folderPath}\u0000${account?.login ?? ''}\u0000${branch ?? ''}`
  const [loaded, setLoaded] = useState<{ key: string; state: PullRequestsState } | null>(null)
  const [round, setRound] = useState({ count: 0, refresh: false })
  useEffect(() => {
    let current = true
    const settle = (state: PullRequestsState): void => {
      if (current) setLoaded({ key, state })
    }
    window.git.getPullRequests(folderPath, round.refresh ? { refresh: true } : undefined).then(
      (result) => settle(stateOf(result)),
      (error: unknown) => settle({ kind: 'error', message: error instanceof Error ? error.message : 'Git did not answer.' })
    )
    return () => {
      current = false
    }
  }, [key, folderPath, round])
  return {
    state: loaded !== null && loaded.key === key ? loaded.state : { kind: 'loading' },
    refresh: () => setRound((previous) => ({ count: previous.count + 1, refresh: true }))
  }
}
