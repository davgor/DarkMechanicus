import { useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { AgentAuthStatus, AgentId } from '../../../shared/desktop/api'
import { errorMessage } from '../api/dm'
import { useLatest } from '../app/useLatest'
import { Button } from '../components/Button'
import { SignInContext } from './signInContext'

interface Handlers {
  /** The status checked once the CLI's login has ended, so the screen that holds the agent's state stays current. */
  onStatus?(status: AgentAuthStatus): void
  /** That status says signed in. */
  onSignedIn?(): void
}

interface SignInPromptProps extends Handlers {
  /** The agent's id; the only thing sign-in and the status checks send. */
  agent: AgentId
  /** What to call the agent: the connected agent's display name. */
  name: string
  /** Another action on the agent (a download, Find) is running, so Sign in waits. */
  disabled?: boolean
  /** The attention of the state it answers: primary while the agent is signed out. */
  variant?: 'primary' | 'default'
  size?: 'md' | 'sm'
}

/**
 * Sign in for an agent that needs it, wherever it is needed. Pressing it opens the agent's sign-in view in this
 * window (`SignInContext`): the CLI's own login runs in a terminal there (naming only the agent id; the vendor's page
 * does the signing in), the status is checked once it ends, and Back returns here.
 */
export function SignInPrompt({ agent, name, disabled = false, variant = 'primary', size = 'sm', onStatus, onSignedIn }: SignInPromptProps): JSX.Element {
  const openSignIn = useContext(SignInContext)
  return (
    <div className="sign-in" role="group" aria-label={`Sign in to ${name}`}>
      <Button variant={variant} size={size} disabled={disabled || openSignIn === null} onClick={() => openSignIn?.({ agent, name, onStatus, onSignedIn })}>
        Sign in
      </Button>
    </div>
  )
}

interface CheckAgainProps {
  agent: AgentId
  name: string
  /** Why the state could not be told, in the app's own words. */
  reason: string
  onStatus?(status: AgentAuthStatus): void
  disabled?: boolean
  size?: 'md' | 'sm'
}

type Check = { checking: boolean; error: string | null }

/** Asks the status once more, for a state the app could not tell. */
function useCheckAgain(agent: AgentId, onStatus: ((status: AgentAuthStatus) => void) | undefined): [Check, () => void] {
  const [check, setCheck] = useState<Check>({ checking: false, error: null })
  const latest = useLatest(onStatus)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const run = useCallback(() => {
    setCheck({ checking: true, error: null })
    window.dm.agentStatus(agent).then(
      (status) => {
        latest.current?.(status)
        if (mounted.current) setCheck({ checking: false, error: null })
      },
      (error: unknown) => {
        if (mounted.current) setCheck({ checking: false, error: errorMessage(error) })
      }
    )
  }, [agent, latest])
  return [check, run]
}

/** An unknown sign-in state: the reason it is unknown, and a way to ask again. */
export function CheckAgain({ agent, name, reason, onStatus, disabled = false, size = 'sm' }: CheckAgainProps): JSX.Element {
  const [check, run] = useCheckAgain(agent, onStatus)
  return (
    <div className="sign-in" role="group" aria-label={`Sign-in state of ${name}`}>
      <p className="note">{reason}</p>
      {check.error === null ? null : (
        <p role="alert" className="form-error">
          {check.error}
        </p>
      )}
      <Button size={size} busy={check.checking} disabled={disabled} onClick={run}>
        Check again
      </Button>
    </div>
  )
}

interface SignInOfferProps extends Handlers {
  agent: AgentId
  name: string
  /** The agent's state as the screen knows it; undefined while it is still being asked. */
  status: AgentAuthStatus | undefined
  disabled?: boolean
}

/** What a state that needs attention offers: Sign in when the agent is signed out, its reason and Check again when the state is unknown; nothing otherwise. */
export function SignInOffer({ agent, name, status, disabled, onStatus, onSignedIn }: SignInOfferProps): JSX.Element | null {
  if (status?.state === 'signed_out') {
    return <SignInPrompt agent={agent} name={name} disabled={disabled} onStatus={onStatus} onSignedIn={onSignedIn} />
  }
  if (status?.state === 'unknown') {
    return <CheckAgain agent={agent} name={name} reason={status.reason} disabled={disabled} onStatus={onStatus} />
  }
  return null
}
