/**
 * The transcript a chat stored before chats became terminals, read-only: what was said, what was run, the
 * approval requests with the decision stored for each, the sign-ins that were lost and the subagent threads.
 * Nothing here can be answered or sent; a message can only be copied. Only text from the agent goes through the
 * Markdown renderer; everything else is plain text. Mail cards (`MailCard`) sit between the chat's own rows where
 * the stream placed them; they are never stored items.
 */
import { Fragment, memo, useMemo, type ReactNode } from 'react'
import { IDLE_STOP_CODE, type ErrorProblem } from '../../../shared/agents/chat'
import { ChatImages, type ChatImageSrc } from '../agentChat/ChatImages'
import { CopyButton } from '../agentChat/CopyButton'
import { MailCard } from '../agentChat/MailCard'
import type { MailLine, TranscriptLine } from '../agentChat/useAgentChat'
import { Markdown } from '../markdown/Markdown'
import { ApprovalRecord } from './ApprovalRecord'
import { decisionText, problemNotice, resetText, STOPPED_TEXT, type TranscriptEntry } from './chatViewModel'
import { ThreadBlock } from './ThreadBlock'
import { transcriptTree, type TreeRow } from './threadModel'
import { ToolCallRow } from './ToolCallRow'

interface MessageProps {
  who: 'You' | 'Assistant'
  /** The stored, already-masked text: the person's words, or the agent's raw Markdown. Copy writes exactly this. */
  text: string
  children: ReactNode
  /** The message's images, shown under the bubble. */
  images?: ReactNode
}

/**
 * One message, laid out like a chat client: the person's as a right-aligned bubble whose Copy shows on hover or
 * keyboard focus, the agent's as plain full-width text with an action row under it. The speaker is named for
 * assistive technology only.
 */
function Message({ who, text, children, images }: MessageProps): JSX.Element {
  const user = who === 'You'
  return (
    <li className={`chat-msg chat-msg-${user ? 'user' : 'assistant'}`}>
      <article aria-label={who} className={user ? 'chat-bubble' : undefined}>
        <p className="chat-msg-who sr-only">{who}</p>
        {children}
      </article>
      {images}
      <div className="chat-msg-actions">
        <CopyButton text={text} title="Copy message" />
      </div>
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
  /** Where the images on messages and tool calls load from; without it (terminal transcripts) none are shown. */
  imageSrc: ChatImageSrc | undefined
}

/** One transcript entry, read-only. */
function EntryRow({ entry, answer, folder, agentName, imageSrc }: RowProps): JSX.Element | null {
  switch (entry.kind) {
    case 'user_message':
      return (
        <Message who="You" text={entry.text}
          images={imageSrc && entry.images ? <ChatImages from="you" images={entry.images} imageSrc={imageSrc} /> : null}>
          <p className="chat-user-text">{entry.text}</p>
        </Message>
      )
    case 'assistant_text':
      return (
        <Message who="Assistant" text={entry.text}>
          <Markdown source={entry.text} />
        </Message>
      )
    case 'tool_call':
      return <ToolCallRow call={entry} imageSrc={imageSrc} />
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
  /** The chat's items, with any mail cards placed among them (`useMailTranscript`'s stream). */
  entries: readonly TranscriptLine[]
  /** Set by GUI chats, whose items carry images; terminal transcripts leave it out and show none. */
  imageSrc?: ChatImageSrc
}

const NO_MAIL: readonly MailLine[] = []

/**
 * Each mail card by the top-level row it goes before (`null`: after every row). An item that is no row of its own (a
 * thread under its call, a decision on its request) passes its cards on to the next row.
 */
function placeMail(entries: readonly TranscriptLine[], rows: readonly TreeRow[]): Map<string | null, MailLine[]> {
  const rowIds = new Set(rows.map((row) => row.entry.id))
  const before = new Map<string | null, MailLine[]>()
  let pending: MailLine[] = []
  for (const entry of entries) {
    if (entry.kind === 'mail') pending.push(entry)
    else if (pending.length > 0 && rowIds.has(entry.id)) {
      before.set(entry.id, pending)
      pending = []
    }
  }
  if (pending.length > 0) before.set(null, pending)
  return before
}

/** The stored conversation, in the order it happened. */
export function ChatTranscript({ agentName, folder, entries, imageSrc }: ChatTranscriptProps): JSX.Element {
  const items = useMemo(() => entries.filter((entry): entry is TranscriptEntry => entry.kind !== 'mail'), [entries])
  const rows = useMemo(() => transcriptTree(items), [items])
  const before = useMemo(() => placeMail(entries, rows), [entries, rows])
  const cards = (anchor: string | null): JSX.Element[] => (before.get(anchor) ?? NO_MAIL).map((line) => <MailCard key={line.id} mail={line.mail} />)
  return (
    <div className="chat-transcript" role="log" aria-label="Transcript" tabIndex={0}>
      <ol className="chat-rows">
        {rows.map((row) => (
          <Fragment key={row.entry.id}>
            {cards(row.entry.id)}
            <TranscriptRow entry={row.entry} answer={row.answer} threads={row.threads} folder={folder} agentName={agentName} imageSrc={imageSrc} />
          </Fragment>
        ))}
        {cards(null)}
      </ol>
    </div>
  )
}
