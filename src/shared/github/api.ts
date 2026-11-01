/**
 * The `window.github` contract between the renderer and main. Renderer-safe: no Node imports.
 * The token never crosses it: main imports it from the GitHub CLI, keeps it encrypted and decrypts it
 * only when it calls GitHub.
 */
import type { GitResult } from '../git/api'

export interface GithubAccountView {
  login: string
  name: string | null
}

/** One of the signed-in account's repositories, as the clone dialog lists it. */
export interface GithubRepository {
  /** `owner/name`. */
  fullName: string
  owner: string
  name: string
  private: boolean
  fork: boolean
  description: string | null
  /** The HTTPS URL to clone. */
  cloneUrl: string
  /** ISO time of the last push; null for a repository nobody pushed to. */
  pushedAt: string | null
}

interface ListRepositoriesRequest {
  /** Asks GitHub again instead of answering from the five-minute cache. */
  refresh?: boolean
}

export const GITHUB_ACCOUNT_CHANGED_CHANNEL = 'github:accountChanged'

export interface GithubApi {
  getAccount(): Promise<GitResult<GithubAccountView | null>>
  /**
   * Signs in with this computer's GitHub CLI login (`gh auth token --hostname github.com`), checked with
   * GitHub; also broadcast through `onAccountChanged`. A call while one runs gets the same answer.
   */
  signIn(): Promise<GitResult<GithubAccountView>>
  /** Deletes Dark Mechanicus's copy of the account and token; the GitHub CLI login is untouched. */
  signOut(): Promise<GitResult<null>>
  /**
   * The account's repositories (as owner, collaborator and organization member), most recently pushed first, up to
   * 1,000. Cached for five minutes unless `refresh` is set; `auth_required` while signed out.
   */
  listRepositories(request?: ListRepositoriesRequest): Promise<GitResult<GithubRepository[]>>
  onAccountChanged(listener: (account: GithubAccountView | null) => void): () => void
}
