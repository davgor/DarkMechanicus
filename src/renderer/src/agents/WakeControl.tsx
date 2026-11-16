import { useContext } from 'react'
import type { ChatMailState } from '../../../shared/agents/chatApi'
import { Button } from '../components/Button'
import { StatePill } from '../components/StatePill'
import { useLiveTerminal } from './liveTerminals'
import { AgentMailContext } from './useAgentMail'
import { useMailAction } from './useInboxPages'

interface WakeControlProps {
  folder: string
  chatId: string
  /** Null once the chat has no mailbox (deleted, or not an OMP chat): no wake can be allowed. */
  state: ChatMailState | null
}

/** The wake credit as it stands, in words that claim no more than main knows. */
function WakeStatus({ state }: { state: ChatMailState }): JSX.Element {
  const { wake } = state
  if (wake.armed) {
    return (
      <p className="agent-mail-wake-state">
        <StatePill state="ready" label="Wake allowed" /> One wake is allowed{wake.armedAt === null ? '' : ` since ${new Date(wake.armedAt).toLocaleString()}`}. It is used once, not again.
      </p>
    )
  }
  if (wake.lastAttempt !== null) {
    return (
      <p className="agent-mail-wake-state">
        <StatePill state="completed" label="Wake attempted" /> The last allowed wake was attempted{' '}
        <time dateTime={wake.lastAttempt.at}>{new Date(wake.lastAttempt.at).toLocaleString()}</time>: its reminder was
        queued. That does not show its agent read or processed anything. No wake is allowed now.
      </p>
    )
  }
  return (
    <p className="agent-mail-wake-state">
      <StatePill state="waiting" label="No wake allowed" /> New mail does not wake its agent by itself.
    </p>
  )
}

/**
 * **Allow one inbox wake**: the person arms the chat's single wake credit, with the revision they were shown and a
 * fresh nonce per click, so a repeated or delayed click never adds a second credit, and nothing re-arms it but
 * another click. A stopped chat keeps the credit and its mail until the person starts it; nothing here starts it.
 */
export function WakeControl({ folder, chatId, state }: WakeControlProps): JSX.Element {
  const store = useContext(AgentMailContext)
  const live = useLiveTerminal(chatId)
  const action = useMailAction()
  // aria-disabled, not disabled: the focused button keeps focus, so Escape and Tab still reach the dialog.
  const blocked = state === null || state.wake.armed || action.busy
  const allow = (): void => {
    if (blocked || state === null) return
    const request = { folder, chatId, expectedRevision: state.wake.revision, requestNonce: crypto.randomUUID() }
    action.run(
      () => window.dm.chats.mail.allowWake(request),
      (next) => store?.apply(next),
      () => void window.dm.chats.mail.state({ folder, chatId }).then((result) => result.ok && store?.apply(result.data))
    )
  }
  return (
    <section className="agent-mail-wake" aria-label="Inbox wake">
      {state === null ? <p className="muted">No wake can be allowed for a chat without a mailbox.</p> : <WakeStatus state={state} />}
      <p className="agent-mail-wake-notice">
        Allowing a wake may spend model tokens. It queues one fixed, trusted reminder for this chat’s agent to check its
        inbox; it does not send your words and does not prove the agent read or processed anything. It never starts a
        stopped chat: the allowed wake and the mail wait until you start it. If the app or agent stops between the wake
        being claimed and the reminder reaching the agent, the wake can be used up without waking it; allow another then.
      </p>
      {live || state === null ? null : <p className="muted">This window has not seen this chat’s terminal running; if it is stopped, nothing here starts it.</p>}
      <Button size="sm" aria-disabled={blocked} onClick={allow}>
        Allow one inbox wake
      </Button>
      {action.error === null ? null : <p role="alert">No wake was allowed: {action.error}</p>}
    </section>
  )
}
