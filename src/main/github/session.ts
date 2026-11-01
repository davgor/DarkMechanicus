/**
 * The main-side GitHub session: the stored account, its token for main's own GitHub and git calls,
 * and signing in and out, which tell the windows (`onAccountChanged`) with the login and name only.
 * The sync, clone and pull request code takes `Pick<GithubSession, 'getAccount' | 'getToken'>`.
 */
import type { GithubAccountView } from '../../shared/github/api'
import type { AccountStore, GithubAccount } from './accountStore'

export interface GithubSession {
  getAccount(): GithubAccount | null
  /** Main-only. Decrypts on every call; never pass the result to IPC, a log line or an error. */
  getToken(): string | null
  /** Whether a token can be stored encrypted on this computer. */
  canStoreToken(): boolean
  signIn(account: GithubAccount, token: string): void
  /** Signs out on this computer (the token stays valid on GitHub until revoked there). */
  signOut(): void
}

export function createGithubSession(deps: {
  store: AccountStore
  onAccountChanged(account: GithubAccountView | null): void
}): GithubSession {
  const { store, onAccountChanged } = deps
  return {
    getAccount: () => store.getAccount(),
    getToken: () => store.getToken(),
    canStoreToken: () => store.canEncrypt(),
    signIn: (account, token) => {
      store.save(account, token)
      onAccountChanged({ login: account.login, name: account.name })
    },
    signOut: () => {
      store.signOut()
      onAccountChanged(null)
    }
  }
}
