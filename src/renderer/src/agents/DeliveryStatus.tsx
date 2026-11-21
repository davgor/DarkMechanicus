import type { ChatMailState } from '../../../shared/agents/chatApi'
import { StatePill } from '../components/StatePill'

/** Context insertion is observed separately from human seen state and explicit agent acknowledgement. */
export function DeliveryStatus({ state }: { state: ChatMailState | null }): JSX.Element {
  return (
    <section className="agent-mail-wake" aria-label="Automatic message delivery">
      {state === null ? <p className="muted">Message delivery is unavailable because this chat has no mailbox.</p> : (
        <>
          <p className="agent-mail-wake-state">
            <StatePill state={state.delivery.problem === null ? 'ready' : 'blocked'} label="Automatic delivery" />
            {' '}{state.delivery.deliveredCount} delivered into context; {state.delivery.pendingCount} pending.
          </p>
          {state.delivery.problem === null ? null : <p role="alert">{state.delivery.problem}</p>}
        </>
      )}
      <p className="agent-mail-wake-notice">
        New messages automatically activate their existing recipient, including stopped chats, and deliver full bodies
        at a safe host boundary. This may spend model tokens. Context delivery is not handling or acknowledgement:
        the agent explicitly acknowledges only messages it has handled. Unavailable runtimes leave delivery pending.
      </p>
    </section>
  )
}
