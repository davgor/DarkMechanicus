/**
 * The transcript a chat stored before chats became terminals, read-only: what was said, what was run, the
 * approval requests with the decision stored for each, the sign-ins that were lost and the subagent threads.
 * Nothing here can be answered or sent. Only text from the agent goes through the Markdown renderer; everything
 * else is plain text.
 */
import { memo, useMemo, type ReactNode } from 'react'
import { IDLE_STOP_CODE, type ErrorProblem } from '../../../shared/agents/chat'
import { Markdown } from '../markdown/Markdown'
import { ApprovalRecord } from './ApprovalRecord'
import { decisionText, problemNotice, resetText, STOPPED_TEXT, type TranscriptEntry } from './chatViewModel'
import { ThreadBlock } from './ThreadBlock'
import { transcriptTree, type TreeRow } from './threadModel'
import { ToolCallRow } from './ToolCallRow'

function Message({ who, children }: { who: 'You' | 'Assistant'; children: ReactNode }): JSX.Element {
  return (
    <li className={`chat-msg chat-msg-${who === 'You' ? 'user' : 'assistant'}`}>
      <article aria-label={who}>
        <p className="chat-msg-who">{who}</p>
        {children}
      </article>
    </li>
  )
}

function Notice({ children }: { children: ReactNode }): JSX.Element {
  return (
    <li className="chat-notice">
      <span>{children}</span>
    </li>
  )
}

interface ErrorRowProps {
  message: string
  code: string | undefined
  /** Set when the error was a state of the person's account: it gets its own title and advice. */
  problem: ErrorProblem | undefined
}

function ErrorRow({ message, code, problem }: ErrorRowProps): JSX.Element {
  const notice = problem === undefined ? null : problemNotice(problem)
  const title = notice === null ? 'Error' : notice.title
  return (
    <li className="chat-error-row">
      <article aria-label={title} className="chat-error">
        <p className="chat-msg-who">{title}</p>
        <p className="chat-error-text">{message}</p>
        {notice === null ? null : <p className="chat-error-advice">{notice.advice}</p>}
        {code === undefined ? null : <p className="chat-error-code">{code}</p>}
      </article>
    </li>
  )
}

/** A model switch, by the ids the chat stored. */
function modelChangeText(from: string | null, to: string): string {
  return from === null ? `Model set to ${to}.` : `Model changed from ${from} to ${to}.`
}

/** The words of an entry that is a notice in the transcript; null for one that is not. */
function noticeText(entry: TranscriptEntry, agentName: string): string | null {
  switch (entry.kind) {
    case 'auth_required':
      return `${agentName} was signed out: ${entry.message}`
    case 'model_change':
      return modelChangeText(entry.from, entry.to)
    case 'context_reset':
      return resetText(entry.reason, entry.message)
    case 'turn_stopped':
      return STOPPED_TEXT
    case 'approval_decision':
      return decisionText(entry)
    default:
      return null
  }
}

interface RowProps {
  /** The chat's agent's display name, which a lost sign-in names. */
  agentName: string
  /** The chat's folder: where an approval request's command ran unless it said otherwise. */
  folder: string
  entry: TreeRow['entry']
  answer: TreeRow['answer']
  /** The thread blocks that hang under this entry (a call that spawned subagents). */
  threads: TreeRow['threads']
}

/** One transcript entry, read-only. */
function EntryRow({ entry, answer, folder, agentName }: RowProps): JSX.Element | null {
  switch (entry.kind) {
    case 'user_message':
      return (
        <Message who="You">
          <p className="chat-user-text">{entry.text}</p>
        </Message>
      )
    case 'assistant_text':
      return (
        <Message who="Assistant">
          <Markdown source={entry.text} />
        </Message>
      )
    case 'tool_call':
      return <ToolCallRow call={entry} />
    case 'error':
      // An idle stop failed nothing: it says why the agent was not running, like the other notices.
      return entry.code === IDLE_STOP_CODE ? <Notice>{entry.message}</Notice> : <ErrorRow message={entry.message} code={entry.code} problem={entry.problem} />
    case 'approval_request':
      return (
        <li className="chat-approval">
          <ApprovalRecord request={entry} answer={answer} folder={folder} />
        </li>
      )
    default: {
      const text = noticeText(entry, agentName)
      return text === null ? null : <Notice>{text}</Notice>
    }
  }
}

/**
 * One row of the transcript, with the thread blocks under it. The rows inside a block are rendered by the
 * same component, so a subagent's items (and the threads it started) look like the chat's own.
 */
const TranscriptRow = memo(function TranscriptRow(props: RowProps): JSX.Element {
  const renderRow = (row: TreeRow): JSX.Element => <TranscriptRow {...props} key={row.entry.id} entry={row.entry} answer={row.answer} threads={row.threads} />
  return (
    <>
      <EntryRow {...props} />
      {props.threads.map((node) => (
        <ThreadBlock key={node.item.id} node={node} renderRow={renderRow} />
      ))}
    </>
  )
})

interface ChatTranscriptProps {
  /** The chat's agent's display name. */
  agentName: string
  /** The chat's folder. */
  folder: string
  entries: readonly TranscriptEntry[]
}

/** The stored conversation, in the order it happened. */
export function ChatTranscript({ agentName, folder, entries }: ChatTranscriptProps): JSX.Element {
  const rows = useMemo(() => transcriptTree(entries), [entries])
  return (
    <div className="chat-transcript" role="log" aria-label="Transcript" tabIndex={0}>
      <ol className="chat-rows">
        {rows.map((row) => (
          <TranscriptRow key={row.entry.id} entry={row.entry} answer={row.answer} threads={row.threads} folder={folder} agentName={agentName} />
        ))}
      </ol>
    </div>
  )
}
