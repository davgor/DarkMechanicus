/**
 * The signed-in account's repositories for the clone dialog (`GithubClient.listRepositories`), kept for five
 * minutes per account unless a refresh is asked. Signed out, the list is `auth_required`, cached or not.
 */
import type { GithubRepository } from '../../shared/github/api'
import type { GithubClient } from './client'
import { GithubError } from './errors'

export const REPOSITORY_CACHE_MS = 5 * 60 * 1000

export interface RepositoryList {
  /** The account's repositories: from the cache when younger than five minutes and `refresh` is false. */
  list(refresh: boolean): Promise<GithubRepository[]>
}

interface Cached {
  login: string
  at: number
  repositories: GithubRepository[]
}

export function createRepositoryList(deps: {
  client: Pick<GithubClient, 'listRepositories'>
  session: { getAccount(): { login: string } | null }
  now?: () => number
}): RepositoryList {
  const now = deps.now ?? Date.now
  let cached: Cached | null = null
  return {
    list: async (refresh) => {
      const login = deps.session.getAccount()?.login
      if (login === undefined) {
        cached = null
        throw new GithubError('auth_required')
      }
      const at = now()
      if (!refresh && cached !== null && cached.login === login && at - cached.at < REPOSITORY_CACHE_MS) {
        return cached.repositories
      }
      const repositories = await deps.client.listRepositories()
      // An account that changed while GitHub answered gets no cache from the answer.
      cached = deps.session.getAccount()?.login === login ? { login, at, repositories } : null
      return repositories
    }
  }
}
