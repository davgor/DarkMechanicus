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
  onAccountChanged(listener: (account: GithubAccountView | null) => void): () => void
}
