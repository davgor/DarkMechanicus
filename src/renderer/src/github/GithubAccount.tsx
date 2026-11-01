import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { GithubAccountView } from '../../../shared/github/api'
import { callGithub } from '../api/github'
import { useToasts } from '../app/toasts'
import { SignInDialog } from './SignInDialog'
import { useGithubAccount } from './useGithubAccount'

interface GithubAccountContextValue {
  account: GithubAccountView | null
  loaded: boolean
  /** Opens the one app-wide sign-in dialog. */
  openSignIn(): void
  signOut(): void
}

const GithubAccountContext = createContext<GithubAccountContextValue | null>(null)

/** The app-wide GitHub account and sign-in actions. */
export function useGithub(): GithubAccountContextValue {
  const value = useContext(GithubAccountContext)
  if (value === null) {
    throw new Error('useGithub must be used inside a GithubAccountProvider')
  }
  return value
}

interface GithubAccountProviderProps {
  children: ReactNode
}

/** Loads the account once for every view, and owns the sign-in dialog the footer and prompts open. */
export function GithubAccountProvider({ children }: GithubAccountProviderProps): JSX.Element {
  const { account, loaded } = useGithubAccount()
  const toasts = useToasts()
  const [signingIn, setSigningIn] = useState(false)
  const openSignIn = useCallback(() => setSigningIn(true), [])
  const signOut = useCallback(() => {
    callGithub(window.github.signOut()).catch(toasts.reportError)
  }, [toasts])
  const onSignedIn = useCallback(
    (signedIn: GithubAccountView) => {
      setSigningIn(false)
      toasts.push('success', `Signed in as @${signedIn.login}`)
    },
    [toasts]
  )
  const value = useMemo(() => ({ account, loaded, openSignIn, signOut }), [account, loaded, openSignIn, signOut])
  return (
    <GithubAccountContext.Provider value={value}>
      {children}
      {signingIn ? <SignInDialog onClose={() => setSigningIn(false)} onSignedIn={onSignedIn} /> : null}
    </GithubAccountContext.Provider>
  )
}
