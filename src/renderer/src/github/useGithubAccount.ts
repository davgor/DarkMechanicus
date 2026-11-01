import { useEffect, useState } from 'react'
import type { GithubAccountView } from '../../../shared/github/api'

interface GithubAccountState {
  account: GithubAccountView | null
  /** False until main has answered (or reported a change), so the UI does not flash "signed out". */
  loaded: boolean
}

const UNLOADED: GithubAccountState = { account: null, loaded: false }

/**
 * The signed-in GitHub account: loaded once from `getAccount`, then kept current by `onAccountChanged`.
 * A change that arrives before the first answer wins over that (older) answer.
 */
export function useGithubAccount(): GithubAccountState {
  const [state, setState] = useState<GithubAccountState>(UNLOADED)
  useEffect(() => {
    let live = true
    let changed = false
    const off = window.github.onAccountChanged((account) => {
      changed = true
      setState({ account, loaded: true })
    })
    void window.github.getAccount().then(
      (result) => {
        if (live && !changed) setState({ account: result.ok ? result.data : null, loaded: true })
      },
      () => {
        if (live && !changed) setState({ account: null, loaded: true })
      }
    )
    return () => {
      live = false
      off()
    }
  }, [])
  return state
}
