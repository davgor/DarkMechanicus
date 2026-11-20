import { useState } from 'react'
import type { AutoRetryView } from '../../../shared/domain/views'
import { errorMessage } from '../api/dm'
import type { Runner } from '../epic/runner'

/** One retry's identity: the run and its number in that run. */
function retryKey(retry: AutoRetryView): string {
  return `${retry.runId}#${retry.number}`
}

/** "Retry 2 by the orchestrator", with the run named when the ticket has retries in more than one run. */
function retryTitle(retry: AutoRetryView, manyRuns: boolean): string {
  return `Retry ${retry.number} by the orchestrator${manyRuns ? ` (run #${retry.runNumber})` : ''}`
}

/** How many orchestrator retries the person has not read yet. */
export function unreadAutoRetries(retries: readonly AutoRetryView[]): number {
  return retries.filter((retry) => retry.acknowledgedAt === null).length
}

/** Unread orchestrator retries as an info count beside the ticket's state: information, never something to act on. */
export function AutoRetryCount(props: { retries: readonly AutoRetryView[] }): JSX.Element | null {
  const unread = unreadAutoRetries(props.retries)
  if (unread === 0) {
    return null
  }
  return (
    <span className="ew-chip tp-retry-count" role="status">
      {unread === 1 ? '1 orchestrator retry to read' : `${unread} orchestrator retries to read`}
    </span>
  )
}

/** One retry: why it failed, what changes, and Acknowledge until the person has read it. */
function RetryItem(props: { retry: AutoRetryView; title: string; pending: boolean; onAcknowledge(): void }): JSX.Element {
  const { retry } = props
  return (
    <li className="tp-retry">
      <p className="tp-retry-title">{props.title}</p>
      <p>
        <span className="tp-retry-label">Why it failed: </span>
        {retry.failureReason}
      </p>
      <p>
        <span className="tp-retry-label">What&apos;s different this time: </span>
        {retry.newApproach}
      </p>
      {retry.acknowledgedAt === null ? (
        <button type="button" className="btn btn-ghost" disabled={props.pending} onClick={props.onAcknowledge}>
          Acknowledge
        </button>
      ) : (
        <p className="ew-muted">Acknowledged</p>
      )}
    </li>
  )
}

/**
 * The orchestrator's own retries of the ticket: why it failed and what is different this time, each with an
 * Acknowledge button. Acknowledging only records that the person read it; leaving one unread blocks nothing.
 */
export function AutoRetries(props: { runner: Runner; retries: readonly AutoRetryView[]; onAcknowledged(retry: AutoRetryView): void }): JSX.Element | null {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (props.retries.length === 0) {
    return null
  }
  const manyRuns = new Set(props.retries.map((retry) => retry.runId)).size > 1
  const acknowledge = (retry: AutoRetryView): void => {
    setPending(retryKey(retry))
    setError(null)
    props.runner('acknowledgeAutoRetry', { runId: retry.runId, ticketId: retry.ticketId, number: retry.number }).then(
      (acknowledged) => {
        setPending(null)
        props.onAcknowledged(acknowledged)
      },
      (failure: unknown) => {
        setPending(null)
        setError(errorMessage(failure))
      }
    )
  }
  return (
    <section className="tp-retries" aria-label="Orchestrator retries">
      <ul>
        {props.retries.map((retry) => (
          <RetryItem
            key={retryKey(retry)}
            retry={retry}
            title={retryTitle(retry, manyRuns)}
            pending={pending === retryKey(retry)}
            onAcknowledge={() => acknowledge(retry)}
          />
        ))}
      </ul>
      {error === null ? null : (
        <p role="alert" className="tp-error">
          {error}
        </p>
      )}
    </section>
  )
}
