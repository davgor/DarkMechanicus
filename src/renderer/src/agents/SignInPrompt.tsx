import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentAuthStatus, AgentKind } from '../../../shared/desktop/api'
import { errorMessage } from '../api/dm'
import { useLatest } from '../app/useLatest'
import { Button } from '../components/Button'
import { signInOutcome } from './agentOutcomes'
import type { AgentOutcome } from './agentOutcomes'
import { agentName } from './agentText'

/** How often a started sign-in asks the app for the agent's status, until it is signed in or dismissed. */
export const SIGN_IN_POLL_MS = 3000

/** What the prompt shows: Sign in, then (once the CLI's own login is running) a wait for the status to say signed in. */
type Step =
  | { step: 'idle'; problem: AgentOutcome | null }
  | { step: 'starting' }
  | { step: 'waiting'; started: AgentOutcome }
  | { step: 'signed_in' }

interface Handlers {
  /** Every status the prompt asks for, so the screen that holds the agent's state stays current. */
  onStatus?(status: AgentAuthStatus): void
  /** The status says signed in; called once. */
  onSignedIn?(): void
}

const problemOf = (detail: string): AgentOutcome => ({ tone: 'error', title: 'Could not start sign-in', detail, output: [] })

/** Asks the status once per interval while `active`; a check that fails is retried on the next one, and checks never overlap. */
function usePolling(kind: AgentKind, active: boolean, onStatus: Handlers['onStatus'], onSignedIn: () => void): void {
  const report = useLatest(onStatus)
  const done = useLatest(onSignedIn)
  useEffect(() => {
    if (!active) {
      return undefined
    }
    let live = true
    let checking = false
    const timer = setInterval(() => {
      if (checking) {
        return
      }
      checking = true
      window.dm.agentStatus(kind).then(
        (status) => {
          checking = false
          if (!live) {
            return
          }
          report.current?.(status)
          if (status.state === 'signed_in') {
            live = false
            done.current()
          }
        },
        () => {
          // The next interval asks again.
          checking = false
        }
      )
    }, SIGN_IN_POLL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [kind, active, report, done])
}

interface SignIn {
  state: Step
  start(): void
  dismiss(): void
}

function useSignIn(kind: AgentKind, handlers: Handlers): SignIn {
  const [state, setState] = useState<Step>({ step: 'idle', problem: null })
  const latest = useLatest(handlers)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const signedIn = useCallback(() => {
    setState({ step: 'signed_in' })
    latest.current.onSignedIn?.()
  }, [latest])
  usePolling(kind, state.step === 'waiting', handlers.onStatus, signedIn)
  const start = useCallback(() => {
    setState({ step: 'starting' })
    window.dm.signInAgent(kind).then(
      (result) => {
        if (!mounted.current) return
        const outcome = signInOutcome(result)
        setState(result.outcome === 'started' ? { step: 'waiting', started: outcome } : { step: 'idle', problem: outcome })
      },
      (error: unknown) => {
        if (mounted.current) setState({ step: 'idle', problem: problemOf(errorMessage(error)) })
      }
    )
  }, [kind])
  const dismiss = useCallback(() => setState({ step: 'idle', problem: null }), [])
  return { state, start, dismiss }
}

interface SignInPromptProps extends Handlers {
  kind: AgentKind
  /** Another action on the agent (a download, Find) is running, so Sign in waits. */
  disabled?: boolean
  /** The attention of the state it answers: primary while the agent is signed out. */
  variant?: 'primary' | 'default'
  size?: 'md' | 'sm'
}

function Waiting({ started, onDismiss }: { started: AgentOutcome; onDismiss(): void }): JSX.Element {
  return (
    <div className="sign-in-note" role="status">
      <p className="sign-in-note-title">{started.title}</p>
      {started.detail === null ? null : <p className="note">{started.detail}</p>}
      <Button size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </div>
  )
}

function Problem({ problem }: { problem: AgentOutcome }): JSX.Element {
  return (
    <div className="sign-in-note" role="alert">
      <p className="sign-in-note-title tone-error">{problem.title}</p>
      {problem.detail === null ? null : <p className="note">{problem.detail}</p>}
    </div>
  )
}

/**
 * Sign in for an agent that needs it, wherever it is needed. Pressing it starts the CLI's own login
 * (naming only the kind; the vendor's page does the signing in) and then asks `agents:status` every
 * few seconds until it says signed in, or until the person dismisses the prompt or leaves the screen.
 */
export function SignInPrompt({ kind, disabled = false, variant = 'primary', size = 'sm', ...handlers }: SignInPromptProps): JSX.Element {
  const { state, start, dismiss } = useSignIn(kind, handlers)
  const name = agentName(kind)
  return (
    <div className="sign-in" role="group" aria-label={`Sign in to ${name}`}>
      {state.step === 'waiting' ? <Waiting started={state.started} onDismiss={dismiss} /> : null}
      {state.step === 'signed_in' ? (
        <p className="sign-in-note tone-ok" role="status">
          {`Signed in to ${name}.`}
        </p>
      ) : null}
      {state.step === 'idle' && state.problem !== null ? <Problem problem={state.problem} /> : null}
      {state.step === 'idle' || state.step === 'starting' ? (
        <Button variant={variant} size={size} busy={state.step === 'starting'} disabled={disabled} onClick={start}>
          Sign in
        </Button>
      ) : null}
    </div>
  )
}

interface CheckAgainProps {
  kind: AgentKind
  /** Why the state could not be told, in the app's own words. */
  reason: string
  onStatus?(status: AgentAuthStatus): void
  disabled?: boolean
  size?: 'md' | 'sm'
}

type Check = { checking: boolean; error: string | null }

/** Asks the status once more, for a state the app could not tell. */
function useCheckAgain(kind: AgentKind, onStatus: ((status: AgentAuthStatus) => void) | undefined): [Check, () => void] {
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
    window.dm.agentStatus(kind).then(
      (status) => {
        latest.current?.(status)
        if (mounted.current) setCheck({ checking: false, error: null })
      },
      (error: unknown) => {
        if (mounted.current) setCheck({ checking: false, error: errorMessage(error) })
      }
    )
  }, [kind, latest])
  return [check, run]
}

/** An unknown sign-in state: the reason it is unknown, and a way to ask again. */
export function CheckAgain({ kind, reason, onStatus, disabled = false, size = 'sm' }: CheckAgainProps): JSX.Element {
  const [check, run] = useCheckAgain(kind, onStatus)
  return (
    <div className="sign-in" role="group" aria-label={`Sign-in state of ${agentName(kind)}`}>
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
  kind: AgentKind
  /** The agent's state as the screen knows it; undefined while it is still being asked. */
  status: AgentAuthStatus | undefined
  disabled?: boolean
}

/** What a state that needs attention offers: Sign in when the agent is signed out, its reason and Check again when the state is unknown; nothing otherwise. */
export function SignInOffer({ kind, status, disabled, onStatus, onSignedIn }: SignInOfferProps): JSX.Element | null {
  if (status?.state === 'signed_out') {
    return <SignInPrompt kind={kind} disabled={disabled} onStatus={onStatus} onSignedIn={onSignedIn} />
  }
  if (status?.state === 'unknown') {
    return <CheckAgain kind={kind} reason={status.reason} disabled={disabled} onStatus={onStatus} />
  }
  return null
}
