import { memo, useLayoutEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import type { ApprovalDecision } from '../../../shared/agents/chat'
import type { AgentAuthStatus, AgentKind } from '../../../shared/desktop/api'
import { Markdown } from '../markdown/Markdown'
import { ApprovalCard } from './ApprovalCard'
import { decisionText, modelChangeText, resetText, signInCardState, type ChatAuth, type SignInCardState, type TranscriptEntry } from './chatViewModel'
import { SignedOutCard } from './SignedOutCard'
import { ThreadBlock } from './ThreadBlock'
import { transcriptTree, type TreeRow } from './threadModel'
import { ToolCallRow } from './ToolCallRow'

type Labels = ReadonlyMap<string, string>

interface MessageProps {
  who: 'You' | 'Assistant'
  streaming?: boolean
  children: ReactNode
}

function Message({ who, streaming = false, children }: MessageProps): JSX.Element {
  return (
    <li className={`chat-msg chat-msg-${who === 'You' ? 'user' : 'assistant'}`}>
      <article aria-label={who} aria-busy={streaming || undefined}>
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

function ErrorRow({ message, code }: { message: string; code: string | undefined }): JSX.Element {
  return (
    <li className="chat-error-row">
      <article aria-label="Error" className="chat-error">
        <p className="chat-msg-who">Error</p>
        <p className="chat-error-text">{message}</p>
        {code === undefined ? null : <p className="chat-error-code">{code}</p>}
      </article>
    </li>
  )
}

/** The inline notices: model changes, context resets, and a decision whose request is not in the transcript. */
function NoticeRow({ entry, labels }: { entry: TranscriptEntry; labels: Labels }): JSX.Element | null {
  switch (entry.kind) {
    case 'model_change':
      return <Notice>{modelChangeText(entry.from, entry.to, labels)}</Notice>
    case 'context_reset':
      return <Notice>{resetText(entry.reason, entry.message)}</Notice>
    case 'approval_decision':
      return <Notice>{decisionText(entry)}</Notice>
    default:
      return null
  }
}

/** What the approval cards need: where commands run, and how an answer is sent. */
interface Approvals {
  folder: string
  onAnswer(requestId: string, decision: ApprovalDecision): Promise<void>
}

/** What a sign-in card reports and asks for: the agent was seen signed in, the status its prompt found, and the cut-short turn sent again. */
interface SignInAnswers {
  onSignedIn(): void
  onAgentStatus(kind: AgentKind, status: AgentAuthStatus): void
  onRetryTurn(): Promise<void>
}

interface RowProps extends Approvals, SignInAnswers {
  entry: TreeRow['entry']
  answer: TreeRow['answer']
  /** The thread blocks that hang under this entry (a call that spawned subagents). */
  threads: TreeRow['threads']
  labels: Labels
  /** What an `auth_required` entry offers; the entries of every other kind never read it. */
  signIn: SignInCardState
}

/** One transcript entry. Only text from the agent goes through the Markdown renderer; everything else is plain text. */
function EntryRow({ entry, answer, labels, folder, onAnswer, signIn, onSignedIn, onAgentStatus, onRetryTurn }: RowProps): JSX.Element | null {
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
    case 'streaming_text':
      return (
        <Message who="Assistant" streaming>
          <Markdown source={entry.text} />
        </Message>
      )
    case 'tool_call':
      return <ToolCallRow call={entry} />
    case 'error':
      return <ErrorRow message={entry.message} code={entry.code} />
    case 'approval_request':
      return <ApprovalCard request={entry} answer={answer} folder={folder} onAnswer={onAnswer} />
    case 'auth_required':
      return <SignedOutCard item={entry} state={signIn} onSignedIn={onSignedIn} onAgentStatus={onAgentStatus} onRetry={onRetryTurn} />
    default:
      return <NoticeRow entry={entry} labels={labels} />
  }
}

/**
 * One row of the transcript, with the thread blocks under it. The rows inside a block are rendered by the
 * same component, so a subagent's items (and the threads it started) look like the chat's own; only the
 * chat's own latest sign-in card can still be acted on.
 */
const TranscriptRow = memo(function TranscriptRow(props: RowProps): JSX.Element {
  const renderRow = (row: TreeRow): JSX.Element => (
    <TranscriptRow {...props} key={row.entry.id} entry={row.entry} answer={row.answer} threads={row.threads} signIn="past" />
  )
  return (
    <>
      <EntryRow {...props} />
      {props.threads.map((node) => (
        <ThreadBlock key={node.item.id} node={node} renderRow={renderRow} />
      ))}
    </>
  )
})

/** How close to the bottom, in pixels, still counts as following the conversation. */
const FOLLOW_SLACK = 48

/** Keeps the newest entry in view while the person is at the bottom, and leaves them be once they scroll up. */
function useFollowBottom(dependency: unknown): { ref: RefObject<HTMLDivElement>; onScroll(): void } {
  const ref = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const onScroll = (): void => {
    const box = ref.current
    if (box !== null) {
      following.current = box.scrollHeight - box.scrollTop - box.clientHeight <= FOLLOW_SLACK
    }
  }
  useLayoutEffect(() => {
    const box = ref.current
    if (box !== null && following.current) {
      box.scrollTop = box.scrollHeight
    }
  }, [dependency])
  return { ref, onScroll }
}

/** The id of the latest `auth_required` entry of the chat's own thread: the only card that can still be acted on. */
function latestAuthId(entries: readonly TranscriptEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry?.kind === 'auth_required' && entry.threadId === undefined) {
      return entry.id
    }
  }
  return null
}

/** The last entry of the chat's own thread: what a running turn is answering after. */
function lastOwn(entries: readonly TranscriptEntry[]): TranscriptEntry | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (entry !== undefined && entry.threadId === undefined) {
      return entry
    }
  }
  return undefined
}

interface ChatTranscriptProps extends Approvals, SignInAnswers {
  phase: 'loading' | 'ready' | 'failed'
  entries: readonly TranscriptEntry[]
  auth: ChatAuth
  labels: Labels
  /** A turn is running. */
  running: boolean
  openError: string | null
  onRetry(): void
}

function Body(props: ChatTranscriptProps & { rows: readonly TreeRow[] }): JSX.Element {
  if (props.phase === 'loading') {
    return <p className="chat-empty">Loading the conversation…</p>
  }
  if (props.phase === 'failed') {
    return (
      <div className="chat-empty">
        <p role="alert" className="form-error">
          {props.openError}
        </p>
        <button type="button" className="btn btn-sm" onClick={props.onRetry}>
          Try again
        </button>
      </div>
    )
  }
  if (props.entries.length === 0) {
    return <p className="chat-empty">No messages yet. Write the first one below.</p>
  }
  const last = lastOwn(props.entries)
  const latest = latestAuthId(props.entries)
  const current = signInCardState(props.auth)
  return (
    <ol className="chat-rows">
      {props.rows.map((row) => (
        <TranscriptRow
          key={row.entry.id}
          entry={row.entry}
          answer={row.answer}
          threads={row.threads}
          labels={props.labels}
          folder={props.folder}
          onAnswer={props.onAnswer}
          signIn={row.entry.id === latest ? current : 'past'}
          onSignedIn={props.onSignedIn}
          onAgentStatus={props.onAgentStatus}
          onRetryTurn={props.onRetryTurn}
        />
      ))}
      {props.running && last?.kind !== 'streaming_text' ? <li className="chat-working">Working…</li> : null}
    </ol>
  )
}

/** The scrolling conversation: stored items and live ones in the order they happened. */
export function ChatTranscript(props: ChatTranscriptProps): JSX.Element {
  const follow = useFollowBottom(props.entries)
  const rows = useMemo(() => transcriptTree(props.entries), [props.entries])
  return (
    <div ref={follow.ref} onScroll={follow.onScroll} className="chat-transcript" role="log" aria-label="Transcript" aria-live="polite" tabIndex={0}>
      <Body {...props} rows={rows} />
    </div>
  )
}
