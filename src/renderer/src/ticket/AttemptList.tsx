import { useState } from 'react'
import type { AttemptView } from '../../../shared/domain/views'
import type { ReviewInput } from '../epic/workspaceActions'
import { StatePill } from '../epic/StatePill'
import { attemptCards, type AttemptCard } from './ticketView'

type Review = (input: ReviewInput) => Promise<string | null>

function RejectForm(props: { attemptId: string; onReview: Review; onDone(error: string | null): void; onCancel(): void }): JSX.Element {
  const [reason, setReason] = useState('')
  const submit = async (): Promise<void> => {
    props.onDone(await props.onReview({ attemptId: props.attemptId, decision: 'reject', reason: reason.trim() }))
  }
  return (
    <div className="tp-reject">
      <label className="tp-field">
        <span>Reason for rejecting</span>
        <textarea value={reason} rows={2} onChange={(event) => setReason(event.target.value)} />
      </label>
      <div className="tp-row-actions">
        <button type="button" className="btn btn-danger" disabled={reason.trim() === ''} onClick={() => void submit()}>
          Reject attempt
        </button>
        <button type="button" className="btn btn-ghost" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function ReviewControls(props: { card: AttemptCard; onReview: Review }): JSX.Element | null {
  const [rejecting, setRejecting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { card, onReview } = props
  const run = async (input: ReviewInput): Promise<void> => setError(await onReview(input))
  if (!card.canReview && !card.canAbandon) {
    return null
  }
  return (
    <div className="tp-review">
      {card.canReview && !rejecting ? (
        <div className="tp-row-actions">
          <button type="button" className="btn btn-primary" onClick={() => void run({ attemptId: card.id, decision: 'accept' })}>
            Accept
          </button>
          <button type="button" className="btn" onClick={() => setRejecting(true)}>
            Reject…
          </button>
        </div>
      ) : null}
      {rejecting ? (
        <RejectForm attemptId={card.id} onReview={onReview} onDone={setError} onCancel={() => setRejecting(false)} />
      ) : null}
      {card.canAbandon ? (
        <button type="button" className="btn" onClick={() => void run({ attemptId: card.id, decision: 'abandon' })}>
          Mark abandoned
        </button>
      ) : null}
      {error === null ? null : <p role="alert" className="tp-error">{error}</p>}
    </div>
  )
}

function Outputs({ card }: { card: AttemptCard }): JSX.Element {
  return (
    <>
      {card.summary === '' ? null : <p className="tp-attempt-summary">{card.summary}</p>}
      {card.commits.length === 0 ? null : (
        <p className="tp-attempt-line">
          Commits: <span className="ew-mono">{card.commits.join(' · ')}</span>
        </p>
      )}
      {card.files.length === 0 ? null : (
        <ul className="tp-files" aria-label="Changed files">
          {card.files.map((file) => (
            <li key={file} className="ew-mono">
              {file}
            </li>
          ))}
          {card.moreFiles === 0 ? null : <li>and {card.moreFiles} more</li>}
        </ul>
      )}
    </>
  )
}

function Details({ card }: { card: AttemptCard }): JSX.Element {
  return (
    <>
      <p className="tp-attempt-line">{card.worker}</p>
      {card.rationale === '' ? null : <p className="tp-attempt-line ew-muted">{card.rationale}</p>}
      {card.lease === '' ? null : <p className="tp-attempt-line ew-mono">{card.lease}</p>}
      <Outputs card={card} />
      {card.failure === '' ? null : <p className="tp-attempt-line tp-failure">{card.failure}</p>}
      {card.decision === '' ? null : <p className="tp-attempt-line">{card.decision}</p>}
      {card.reasons.length === 0 ? null : (
        <ul className="tp-reasons">
          {card.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
    </>
  )
}

function AttemptCardView({ card, onReview }: { card: AttemptCard; onReview: Review }): JSX.Element {
  return (
    <li className={card.superseded ? 'tp-attempt is-superseded' : 'tp-attempt'} aria-label={`Attempt ${card.heading}`}>
      <div className="tp-attempt-head">
        <span className="ew-mono">{card.heading}</span>
        <StatePill tone={card.tone} label={card.state} />
        {card.kindLabel === '' ? null : <span className="ew-chip">{card.kindLabel}</span>}
        {card.superseded ? <span className="ew-chip">superseded</span> : null}
      </div>
      <Details card={card} />
      <ReviewControls card={card} onReview={onReview} />
    </li>
  )
}

export function AttemptList(props: { attempts: AttemptView[]; now: number; onReview: Review }): JSX.Element {
  const cards = attemptCards(props.attempts, props.now)
  if (cards.length === 0) {
    return <p className="ew-muted">No attempts yet.</p>
  }
  return (
    <ul className="tp-attempts">
      {cards.map((card) => (
        <AttemptCardView key={card.id} card={card} onReview={props.onReview} />
      ))}
    </ul>
  )
}
