import { memo, useState } from 'react'
import type { ChatItem } from '../../../shared/agents/chat'
import type { AgentAuthStatus, AgentKind } from '../../../shared/desktop/api'
import { errorMessage } from '../api/dm'
import { Button } from '../components/Button'
import { classNames } from '../components/classNames'
import { StatePill } from '../components/StatePill'
import type { PillState } from '../components/StatePill'
import type { SignInCardState } from './chatViewModel'
import { agentName } from './agentText'
import { SignInPrompt } from './SignInPrompt'

type AuthRequiredItem = Extract<ChatItem, { kind: 'auth_required' }>

const PILLS: Readonly<Record<SignInCardState, { state: PillState; label: string }>> = {
  signed_out: { state: 'awaiting_checkpoint', label: 'Needs sign-in' },
  checking: { state: 'waiting', label: 'Checking' },
  retry: { state: 'accepted', label: 'Signed in' },
  retried: { state: 'accepted', label: 'Retried' },
  past: { state: 'canceled', label: 'Earlier' }
}

interface Retrying {
  busy: boolean
  error: string | null
}

/** Sends the cut-short message once; while it is in flight Retry is off, and a refusal is kept so the card can show it. */
function useRetrying(onRetry: () => Promise<void>): [Retrying, () => void] {
  const [state, setState] = useState<Retrying>({ busy: false, error: null })
  const retry = (): void => {
    setState({ busy: true, error: null })
    onRetry().then(
      () => setState({ busy: false, error: null }),
      (failure: unknown) => setState({ busy: false, error: errorMessage(failure) })
    )
  }
  return [state, retry]
}

function RetryAction({ onRetry }: { onRetry: () => Promise<void> }): JSX.Element {
  const [retrying, retry] = useRetrying(onRetry)
  return (
    <>
      <p className="chat-approval-note">Signed in again. The message that was cut short has not been sent yet.</p>
      <div className="chat-approval-actions">
        <Button size="sm" variant="primary" busy={retrying.busy} onClick={retry}>
          Retry
        </Button>
      </div>
      {retrying.error === null ? null : (
        <p role="alert" className="form-error">
          {retrying.error}
        </p>
      )}
    </>
  )
}

interface ActionsProps {
  item: AuthRequiredItem
  state: SignInCardState
  onSignedIn(): void
  /** The sign-in prompt asked the agent's state itself. */
  onAgentStatus(kind: AgentKind, status: AgentAuthStatus): void
  onRetry(): Promise<void>
}

/** What the card offers for its state: Sign in, a wait, Retry, or the note that the turn was retried. */
function Actions({ item, state, onSignedIn, onAgentStatus, onRetry }: ActionsProps): JSX.Element | null {
  const name = agentName(item.agent)
  switch (state) {
    case 'signed_out':
      return <SignInPrompt kind={item.agent} onSignedIn={onSignedIn} onStatus={(status) => onAgentStatus(item.agent, status)} />
    case 'checking':
      return (
        <p className="note" role="status">
          {`Checking whether ${name} is signed in…`}
        </p>
      )
    case 'retry':
      return <RetryAction onRetry={onRetry} />
    case 'retried':
      return (
        <p className="chat-approval-answer-detail" role="status">
          {`Turn retried. ${name} is answering your message again.`}
        </p>
      )
    case 'past':
      return null
  }
}

interface SignedOutCardProps extends Omit<ActionsProps, 'state'> {
  /** What the card offers; only the latest card of a chat is ever more than `past`. */
  state: SignInCardState
}

/**
 * An `auth_required` item in the transcript: the agent's CLI said its sign-in is gone. While it is, the
 * card offers Sign in (which checks the status until it says signed in); once signed in it offers Retry,
 * which sends the message that was cut short, once; then it says the turn was retried.
 */
export const SignedOutCard = memo(function SignedOutCard({ item, state, onSignedIn, onAgentStatus, onRetry }: SignedOutCardProps): JSX.Element {
  const name = agentName(item.agent)
  const pill = PILLS[state]
  return (
    <li className="chat-approval">
      <article className={classNames('chat-approval-card', state === 'past' && 'is-answered')} aria-label={`Signed out of ${name}`}>
        <div className="chat-approval-head">
          <p className="chat-msg-who">Sign-in</p>
          <StatePill state={pill.state} label={pill.label} />
        </div>
        <p className="chat-approval-title">{`Signed out of ${name}`}</p>
        <p className="chat-approval-summary">{item.message}</p>
        <Actions item={item} state={state} onSignedIn={onSignedIn} onAgentStatus={onAgentStatus} onRetry={onRetry} />
      </article>
    </li>
  )
})
