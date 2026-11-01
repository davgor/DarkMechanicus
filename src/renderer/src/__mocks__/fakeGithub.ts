/**
 * `window.github` for renderer tests. Signed out until a test sets `account` or signs in. `signIn`
 * answers `signInResult` at once when a test sets it, else stays pending until `finishSignIn`; a call
 * while one is pending gets the same promise, and a successful one broadcasts the account before it
 * answers, as main does. `changeAccount` is main reporting a change; sign-out ends a pending sign-in
 * with `cancelled` and broadcasts too.
 */
import type { GitResult } from '../../../shared/git/api'
import type { GithubAccountView, GithubApi } from '../../../shared/github/api'

type FakeGithubCall = 'getAccount' | 'signIn' | 'signOut'

type SignInAnswer = GitResult<GithubAccountView>

export class FakeGithub implements GithubApi {
  readonly calls: FakeGithubCall[] = []
  account: GithubAccountView | null = null
  /** What `signIn` answers at once; null keeps it pending until `finishSignIn`. */
  signInResult: SignInAnswer | null = null
  private pending: { promise: Promise<SignInAnswer>; finish(result: SignInAnswer): void } | null = null
  private readonly accountListeners = new Set<(account: GithubAccountView | null) => void>()

  /** Main broadcasting an account change. */
  changeAccount(account: GithubAccountView | null): void {
    this.account = account
    for (const listener of this.accountListeners) {
      listener(account)
    }
  }

  /** Ends the pending sign-in with `result`. */
  finishSignIn(result: SignInAnswer): void {
    const pending = this.pending
    this.pending = null
    pending?.finish(result)
  }

  getAccount(): Promise<GitResult<GithubAccountView | null>> {
    this.calls.push('getAccount')
    return Promise.resolve({ ok: true, data: this.account })
  }

  signIn(): Promise<SignInAnswer> {
    this.calls.push('signIn')
    if (this.pending === null) {
      let finish: (result: SignInAnswer) => void = () => undefined
      const promise = new Promise<SignInAnswer>((resolve) => {
        finish = (result) => {
          if (result.ok) this.changeAccount(result.data)
          resolve(result)
        }
      })
      this.pending = { promise, finish }
      if (this.signInResult !== null) this.finishSignIn(this.signInResult)
      return promise
    }
    return this.pending.promise
  }

  signOut(): Promise<GitResult<null>> {
    this.calls.push('signOut')
    this.finishSignIn({ ok: false, error: { code: 'cancelled', message: 'Sign-in was cancelled.' } })
    this.changeAccount(null)
    return Promise.resolve({ ok: true, data: null })
  }

  onAccountChanged(listener: (account: GithubAccountView | null) => void): () => void {
    this.accountListeners.add(listener)
    return () => this.accountListeners.delete(listener)
  }
}
