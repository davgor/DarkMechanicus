import { memo } from 'react'
import { formatCallsign } from '../../../shared/agents/callsign'
import type { ApprovalRequestItem, ChatItem } from '../../../shared/agents/chat'
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

interface ApprovalRecordProps {
  request: ApprovalRequestItem
  /** The decision stored for the request (a cancelled one for a request nothing answered); null when none was. */
  answer: DecisionItem | null
  /** The chat's folder: where a command ran unless the request said otherwise. */
  folder: string
}

/**
 * Who asked, from the callsign main stamped on the request; a request raised in a thread before callsigns existed
 * says only that a subagent asked. The thread's own label is the agent's words and is never shown here.
 */
function askedBy(request: ApprovalRequestItem): string | null {
  if (request.callsign !== undefined) return `Asked by ${formatCallsign(request.callsign)}`
  return request.threadId === undefined ? null : 'Asked by a subagent'
}

/**
 * An approval request a chat stored before chats became terminals, as a record: what the agent asked to do and
 * the decision stored for it. Nothing here can be answered: the agent that asked is gone.
 */
export const ApprovalRecord = memo(function ApprovalRecord({ request, answer, folder }: ApprovalRecordProps): JSX.Element {
  const detail = approvalDetail(request, folder)
  const asker = askedBy(request)
  const view = answer === null ? null : answerView(answer)
  return (
    <article className={classNames('chat-approval-card', 'is-answered')} aria-label={`Approval request: ${detail.heading}`}>
      <div className="chat-approval-head">
        <p className="chat-msg-who">Approval</p>
        {view === null ? <StatePill state="canceled" label="Not answered" /> : <StatePill state={view.state} label={view.label} />}
      </div>
      <p className="chat-approval-title">{detail.heading}</p>
      {asker === null ? null : <p className="chat-approval-thread">{asker}</p>}
      <Details detail={detail} />
      {view?.detail == null ? null : <p className="chat-approval-answer-detail">{view.detail}</p>}
    </article>
  )
})
