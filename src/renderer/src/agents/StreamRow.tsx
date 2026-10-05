import './chatThreads.css'
import './chatView.css'
import './threadStream.css'
import { StatePill } from '../components/StatePill'
import { Markdown } from '../markdown/Markdown'
import { ApprovalCard } from './ApprovalCard'
import { Hourglass } from './Hourglass'
import type { StreamRow } from './threadStream'
import type { StreamEntry } from './useThreadStream'

type ApprovalRow = Extract<StreamRow, { kind: 'approval' }>
/** A row a host wraps in its own list item; an approval is its own item. */
type BodyRow = Exclude<StreamRow, { kind: 'approval' }>

export function isApproval(row: StreamRow): row is ApprovalRow {
  return row.kind === 'approval'
}

function Message({ row }: { row: Extract<StreamRow, { kind: 'message' }> }): JSX.Element {
  return (
    <div className="ts-body" aria-busy={row.streaming || undefined}>
      <p className="ts-who">{row.who}</p>
      {row.who === 'You' ? <p className="ts-user">{row.text}</p> : <Markdown source={row.text} />}
    </div>
  )
}

/**
 * What a row says, without the list item around it: the same words in the Activity tab and in the feed. What
 * the agent wrote goes through the Markdown renderer (no HTML is ever injected); everything else is plain text.
 */
export function StreamBody({ row }: { row: BodyRow }): JSX.Element {
  switch (row.kind) {
    case 'message':
      return <Message row={row} />
    case 'tool':
      return (
        <p className="ts-line">
          <span className="ts-name">{row.title}</span>
          {row.summary === '' ? null : <span className="ts-summary">{row.summary}</span>}
          <StatePill state={row.status.state} label={row.status.label} />
        </p>
      )
    case 'thread':
      return (
        <p className="ts-line">
          {row.state.pill === 'running' ? <Hourglass /> : null}
          <span className="ts-name">Subagent</span>
          <span className="ts-summary">{row.label}</span>
          <StatePill state={row.state.pill} label={row.state.label} />
        </p>
      )
    case 'error':
      return <p className="ts-error">{row.message}</p>
  }
}

/** A request in a followed thread, answerable where it is shown. */
export function StreamApproval({ row, entry }: { row: ApprovalRow; entry: StreamEntry }): JSX.Element {
  return <ApprovalCard request={row.request} answer={row.answer} folder={entry.stream.folder} onAnswer={entry.stream.answer} />
}
