/**
 * A Skitarii chat's mail, for the person to watch (`docs/architecture.md`, "Skitarii mail in the renderer"): **Messages** in the chat's header
 * with what the person has not seen and what the chat's agent has not acknowledged, counted apart, and the inbox it
 * opens. The inbox reads the chat's retained messages as plain text (never markup, links or terminal sequences),
 * with each sender's stable id, when it arrived, what it replies to and where it stands for the person and for the
 * agent. A sender that is a chat of this folder opens on an explicit click only. Reading acknowledges nothing for
 * the agent and **Mark shown messages seen** moves the person's own cursor only. Automatic delivery status shows
 * proven full-body context insertion and truthful pending blockers, independently of explicit agent acknowledgement.
 */
import { useContext, useEffect, useRef, useState } from 'react'
import type { ChatRecord } from '../../../shared/agents/chat'
import type { ChatMailState } from '../../../shared/agents/chatApi'
import type { AgentMailMessageView } from '../../../shared/domain/agentMail'
import { plural } from '../app/plural'
import type { Scheduler } from '../app/scheduler'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { StatePill } from '../components/StatePill'
import { classNames } from '../components/classNames'
import { useLiveTerminal } from './liveTerminals'
import { AgentMailContext, useChatMail } from './useAgentMail'
import { useInboxPages, useMailAction, type InboxPages } from './useInboxPages'
import { DeliveryStatus } from './DeliveryStatus'
import { inertText } from './inertText'
import './agentInbox.css'

interface AgentInboxProps {
  folder: string
  chat: ChatRecord
  /** The folder's chats: a sender that is one of them opens from its message. */
  peers: readonly ChatRecord[]
  scheduler: Scheduler
  /** Opens a chat of this folder; without it no sender opens. */
  onOpenChat?(chatId: string): void
}

/** How long new-mail alerts wait for more before one is read out, so a burst is announced once. */
export const MAIL_ALERT_COALESCE_MS = 1500

/** The header's **Messages** button: what the person has not seen and what the agent has not acknowledged, apart. */
function MailButton({ state, onOpen }: { state: ChatMailState; onOpen(): void }): JSX.Element {
  const unseen = `${state.unseenCount} unseen by you`
  const pending = `${state.pendingCount} unacknowledged by its agent`
  return (
    <Button
      size="sm"
      className="agent-mail-button"
      aria-haspopup="dialog"
      aria-label={`Messages: ${unseen}, ${pending}`}
      onClick={onOpen}
    >
      Messages
      <span className={classNames('mail-count', state.unseenCount > 0 && 'is-unseen')}>{state.unseenCount} unseen</span>
      <span className={classNames('mail-count', state.pendingCount > 0 && 'is-pending')}>{state.pendingCount} awaiting agent</span>
    </Button>
  )
}

/** A polite announcement when mail arrives, once per burst; it never moves focus, so the terminal keeps its keys. */
function MailAlert({ unseen, scheduler }: { unseen: number; scheduler: Scheduler }): JSX.Element {
  const [text, setText] = useState('')
  const last = useRef(unseen)
  useEffect(() => {
    const before = last.current
    last.current = unseen
    if (unseen <= before) return undefined
    return scheduler.after(MAIL_ALERT_COALESCE_MS, () => setText(`${plural(unseen, 'message')} unseen by you`))
  }, [unseen, scheduler])
  return (
    <span className="sr-only" aria-live="polite" data-testid="mail-alert">
      {text}
    </span>
  )
}

function MailSummary({ state }: { state: ChatMailState }): JSX.Element {
  return (
    <dl className="agent-mail-summary">
      <div>
        <dt>Unseen by you</dt>
        <dd>{state.unseenCount}</dd>
      </div>
      <div>
        <dt>Unacknowledged by its agent</dt>
        <dd>{state.pendingCount}</dd>
      </div>
      <div>
        <dt>Retained</dt>
        <dd>{state.retainedCount}</dd>
      </div>
    </dl>
  )
}

interface SenderProps {
  message: AgentMailMessageView
  peer: ChatRecord | null
  onOpenChat?(chatId: string): void
}

/** Whether the sender's terminal runs, as this window last heard: a stopped peer still opens. */
function PeerLiveness({ peer }: { peer: ChatRecord }): JSX.Element {
  const live = useLiveTerminal(peer.id)
  // The page knows a PTY is live only once it attached it since it loaded, so "not seen running", never "stopped".
  return live ? <StatePill state="running" label="Terminal running" /> : <StatePill state="paused" label="Terminal not seen running" />
}

function Sender({ message, peer, onOpenChat }: SenderProps): JSX.Element {
  const name = inertText(message.from.name)
  if (message.from.deleted) return <span className="agent-mail-sender">{name} (chat deleted)</span>
  if (peer === null || onOpenChat === undefined) return <span className="agent-mail-sender">{name} (not a chat of this folder)</span>
  return (
    <span className="agent-mail-sender">
      <Button size="sm" variant="ghost" aria-label={`Open chat ${peer.title}`} onClick={() => onOpenChat(peer.id)}>
        {name}
      </Button>
      <PeerLiveness peer={peer} />
    </span>
  )
}

interface MessageItemProps extends SenderProps {
  seen: boolean
}

function MessageItem({ message, seen, peer, onOpenChat }: MessageItemProps): JSX.Element {
  return (
    <li className="agent-mail-message" aria-label={`Message ${message.seq} from ${inertText(message.from.name)}`}>
      <div className="agent-mail-meta">
        <Sender message={message} peer={peer} onOpenChat={onOpenChat} />
        <span className="mono agent-mail-id" title="The sender’s stable id">
          {message.from.endpointId}
        </span>
        <time dateTime={message.acceptedAt}>{new Date(message.acceptedAt).toLocaleString()}</time>
        <span className="mono agent-mail-id">#{message.seq}</span>
      </div>
      {message.inReplyTo === null ? null : (
        <p className="agent-mail-reply">
          Reply to message <span className="mono">{message.inReplyTo}</span> this chat sent
        </p>
      )}
      <ul className="agent-mail-states" aria-label="Message state">
        <li className={seen ? undefined : 'is-unseen'}>{seen ? 'Seen by you' : 'Unseen by you'}</li>
        <li>
          {message.acknowledgedAt === null ? (
            'Unacknowledged by its agent'
          ) : (
            <>
              Acknowledged by its agent <time dateTime={message.acknowledgedAt}>{new Date(message.acknowledgedAt).toLocaleString()}</time>
            </>
          )}
        </li>
      </ul>
      <pre className="agent-mail-body">{inertText(message.body)}</pre>
    </li>
  )
}

interface MessageListProps {
  folder: string
  pages: InboxPages
  state: ChatMailState | null
  peers: readonly ChatRecord[]
  onOpenChat?(chatId: string): void
}

function MessageList({ folder, pages, state, peers, onOpenChat }: MessageListProps): JSX.Element {
  if (pages.status === 'loading') return <p role="status">Loading messages…</p>
  if (pages.status === 'error') {
    return (
      <div className="agent-mail-error">
        <p role="alert">Could not load messages: {pages.error}</p>
        <Button size="sm" onClick={pages.reload}>
          Try again
        </Button>
      </div>
    )
  }
  if (pages.messages.length === 0) {
    return <p className="muted">No messages retained. Acknowledged messages are kept {state?.retentionDays ?? 7} days.</p>
  }
  const seenThrough = state?.humanSeenSeq ?? 0
  return (
    <ol className="agent-mail-list" aria-label="Messages">
      {pages.messages.map((message) => (
        <MessageItem
          key={message.id}
          message={message}
          seen={message.seq <= seenThrough}
          peer={peers.find((chat) => chat.folder === folder && chat.endpointId === message.from.endpointId) ?? null}
          onOpenChat={onOpenChat}
        />
      ))}
    </ol>
  )
}

interface SeenControlProps {
  folder: string
  chatId: string
  pages: InboxPages
  state: ChatMailState | null
}

/** Moves the person's seen cursor to the newest message shown; the agent's acknowledgements stay as they are. */
function SeenControl({ folder, chatId, pages, state }: SeenControlProps): JSX.Element | null {
  const store = useContext(AgentMailContext)
  const action = useMailAction()
  const shown = pages.messages.reduce((highest, message) => Math.max(highest, message.seq), 0)
  if (state === null || pages.messages.length === 0) return null
  // aria-disabled, not disabled: the focused button keeps focus, so Escape and Tab still reach the dialog.
  const blocked = action.busy || shown <= state.humanSeenSeq
  const markSeen = (): void => {
    if (!blocked) action.run(() => window.dm.chats.mail.markSeen({ folder, chatId, throughSeq: shown }), (next) => store?.apply(next))
  }
  return (
    <div className="agent-mail-seen">
      <Button size="sm" aria-disabled={blocked} onClick={markSeen}>
        Mark shown messages seen
      </Button>
      <p className="muted">Changes only your unseen count. Its agent acknowledges messages itself.</p>
      {action.error === null ? null : <p role="alert">Could not mark seen: {action.error}</p>}
    </div>
  )
}

interface InboxDialogProps extends AgentInboxProps {
  state: ChatMailState | null
  onClose(): void
}

function InboxDialog({ folder, chat, peers, state, onOpenChat, onClose }: InboxDialogProps): JSX.Element {
  const pages = useInboxPages(folder, chat.id)
  const open = onOpenChat === undefined ? undefined : (chatId: string) => {
    onClose()
    onOpenChat(chatId)
  }
  return (
    <Dialog
      title={`Messages to ${chat.title}`}
      description="What other Skitarii chats sent this chat. Reading here acknowledges nothing; its agent reads and replies with its own tools."
      onClose={onClose}
      actions={
        <>
          <Button onClick={pages.reload}>Refresh</Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {state === null ? <p role="alert">This chat no longer has a mailbox.</p> : <MailSummary state={state} />}
      <MessageList folder={folder} pages={pages} state={state} peers={peers} onOpenChat={open} />
      {pages.hasMore ? (
        <Button size="sm" busy={pages.busy} onClick={pages.more}>
          Load more messages
        </Button>
      ) : null}
      <SeenControl folder={folder} chatId={chat.id} pages={pages} state={state} />
      <DeliveryStatus state={state} />
    </Dialog>
  )
}

/** The chat-scoped **Messages** action for the header, its new-mail announcement, and the inbox it opens. */
export function AgentInbox(props: AgentInboxProps): JSX.Element | null {
  const { state } = useChatMail(props.folder, props.chat.id)
  const [open, setOpen] = useState(false)
  if (state === null && !open) return null
  return (
    <div className="agent-mail">
      {state === null ? null : <MailButton state={state} onOpen={() => setOpen(true)} />}
      {state === null ? null : <MailAlert unseen={state.unseenCount} scheduler={props.scheduler} />}
      {open ? <InboxDialog {...props} state={state} onClose={() => setOpen(false)} /> : null}
    </div>
  )
}
