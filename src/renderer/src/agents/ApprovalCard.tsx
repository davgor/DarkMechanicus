import { memo, useId, useState } from 'react'
import type { ApprovalDecision, ApprovalRequestItem, ChatItem } from '../../../shared/agents/chat'
import { errorMessage } from '../api/dm'
import { Button } from '../components/Button'
import { classNames } from '../components/classNames'
import { StatePill } from '../components/StatePill'
import { answerView, approvalDetail, type ApprovalDetail, type DiffPreview } from './approvalModel'

type DecisionItem = Extract<ChatItem, { kind: 'approval_decision' }>

function Diff({ diff }: { diff: DiffPreview }): JSX.Element {
  return (
    <>
      <p className="chat-approval-diff-text">{diff.text}</p>
      <pre className="chat-approval-diff" aria-label="Changed lines">
        {diff.lines.map((line, index) => (
          <span key={index} className={line.sign === '-' ? 'chat-diff-line chat-diff-removed' : 'chat-diff-line chat-diff-added'}>
            {`${line.sign} ${line.text}`}
          </span>
        ))}
        {diff.hidden > 0 ? <span className="chat-diff-line chat-diff-more">{`… and ${diff.hidden} more changed ${diff.hidden === 1 ? 'line' : 'lines'}`}</span> : null}
      </pre>
    </>
  )
}

function Fact({ label, children }: { label: string; children: string | string[] }): JSX.Element {
  return (
    <dl className="chat-approval-fact">
      <dt>{label}</dt>
      <dd className="mono">{typeof children === 'string' ? children : children.map((value) => <span key={value}>{value}</span>)}</dd>
    </dl>
  )
}

/** The request's own words, and nothing the vendor did not send: all of it plain text. */
function Details({ detail }: { detail: ApprovalDetail }): JSX.Element {
  const structured = detail.command !== null || detail.files.length > 0 || detail.diff !== null
  return (
    <>
      {structured ? null : <p className="chat-approval-summary">{detail.summary}</p>}
      {detail.command === null ? null : <pre className="chat-approval-command">{detail.command}</pre>}
      {detail.workingDirectory === null ? null : <Fact label="Working directory">{detail.workingDirectory}</Fact>}
      {detail.files.length === 0 ? null : <Fact label={detail.files.length === 1 ? 'File' : 'Files'}>{detail.files}</Fact>}
      {detail.diff === null ? null : <Diff diff={detail.diff} />}
      {detail.note === null ? null : <p className="chat-approval-note">{detail.note}</p>}
    </>
  )
}

interface AnswerButtonsProps {
  describedBy: string
  busy: boolean
  onAnswer(decision: ApprovalDecision): void
}

/** Plain buttons, none focused or marked as the default: Enter does nothing until the person has moved to one on purpose. */
function AnswerButtons({ describedBy, busy, onAnswer }: AnswerButtonsProps): JSX.Element {
  return (
    <div className="chat-approval-actions" role="group" aria-label="Answer">
      <Button size="sm" aria-describedby={describedBy} disabled={busy} onClick={() => onAnswer('allow_once')}>
        Allow once
      </Button>
      <Button size="sm" aria-describedby={describedBy} disabled={busy} onClick={() => onAnswer('allow_chat')}>
        Allow for this chat
      </Button>
      <Button size="sm" variant="danger" aria-describedby={describedBy} disabled={busy} onClick={() => onAnswer('deny')}>
        Deny
      </Button>
    </div>
  )
}

interface Answering {
  busy: boolean
  error: string | null
}

/** Sends one answer; while it is in flight the buttons are off, and a failure is kept so it can be shown. */
function useAnswering(requestId: string, onAnswer: (requestId: string, decision: ApprovalDecision) => Promise<void>): [Answering, (decision: ApprovalDecision) => void] {
  const [state, setState] = useState<Answering>({ busy: false, error: null })
  const answer = (decision: ApprovalDecision): void => {
    setState({ busy: true, error: null })
    onAnswer(requestId, decision).then(
      () => setState({ busy: false, error: null }),
      (failure: unknown) => setState({ busy: false, error: errorMessage(failure) })
    )
  }
  return [state, answer]
}

interface ApprovalCardProps {
  request: ApprovalRequestItem
  /** The decision stored for the request; null while it waits. */
  answer: DecisionItem | null
  /** The chat's folder: where a command runs unless the request says otherwise. */
  folder: string
  /** Sends the person's decision; rejects with why it was not accepted. */
  onAnswer(requestId: string, decision: ApprovalDecision): Promise<void>
}

/**
 * An approval request in the transcript: what the agent wants to do, with Allow once, Allow for
 * this chat and Deny while it waits, and the decision (cancelled and automatic ones included) once
 * it is answered.
 */
export const ApprovalCard = memo(function ApprovalCard({ request, answer, folder, onAnswer }: ApprovalCardProps): JSX.Element {
  const titleId = useId()
  const detail = approvalDetail(request, folder)
  const [answering, send] = useAnswering(request.requestId, onAnswer)
  const view = answer === null ? null : answerView(answer)
  return (
    <li className="chat-approval">
      <article className={classNames('chat-approval-card', view !== null && 'is-answered')} aria-label={`Approval request: ${detail.heading}`}>
        <div className="chat-approval-head">
          <p className="chat-msg-who">Approval</p>
          {view === null ? <StatePill state="awaiting_checkpoint" label="Needs your answer" /> : <StatePill state={view.state} label={view.label} />}
        </div>
        <p id={titleId} className="chat-approval-title">
          {detail.heading}
        </p>
        <Details detail={detail} />
        {view === null ? <AnswerButtons describedBy={titleId} busy={answering.busy} onAnswer={send} /> : null}
        {view?.detail == null ? null : <p className="chat-approval-answer-detail">{view.detail}</p>}
        {answering.error === null ? null : (
          <p role="alert" className="form-error">
            {answering.error}
          </p>
        )}
      </article>
    </li>
  )
})
