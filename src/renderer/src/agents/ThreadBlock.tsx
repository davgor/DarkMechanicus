import { memo, useEffect, useRef, useState, type Dispatch, type ReactNode, type RefObject, type SetStateAction } from 'react'
import type { ThreadBinding } from '../../../shared/agents/chatApi'
import { Icon } from '../components/Icon'
import { StatePill } from '../components/StatePill'
import { useChatContext, useResolvedTarget, type ThreadFocus } from './ChatContext'
import { Hourglass } from './Hourglass'
import { threadStateView, type ThreadNode, type TreeRow } from './threadModel'

type AttemptBinding = Extract<ThreadBinding, { kind: 'attempt' }>

/**
 * What a thread bound to an attempt shows: the ticket's key, and, when the epic and ticket are known and the
 * view can navigate, a button to that ticket's Activity tab for the attempt. The key comes from the main
 * process's binding or, failing that, from a lookup; until then (and when it cannot be found) the chip only
 * says it is an attempt.
 */
function AttemptLink({ binding }: { binding: AttemptBinding }): JSX.Element {
  const { navigation } = useChatContext()
  const { epicId, runId, ticketId, attemptId, ticketKey } = binding
  const target = useResolvedTarget({ epicId, runId, ticketId, attemptId, ticketKey })
  const key = target.ticketKey
  if (key === null) {
    return <span className="chat-thread-bound">Attempt</span>
  }
  if (navigation === null || target.epicId === null || target.ticketId === null) {
    return <span className="chat-thread-bound">{key}</span>
  }
  const { epicId: epic, ticketId: ticket } = target
  return (
    <button
      type="button"
      className="chat-thread-bound chat-thread-link"
      aria-label={`${key} Activity`}
      title={`Open the Activity tab of ${key} for this attempt`}
      onClick={() => navigation.openTicket({ epicId: epic, ticketId: ticket, attemptId })}
    >
      <span className="chat-thread-key">{key}</span>
      <span className="chat-thread-hint" aria-hidden="true">
        Activity
      </span>
    </button>
  )
}

/** The binding of this thread to an attempt, if it has one: only attempts are shown on a thread (the main thread's run binding is not). */
function BoundTicket({ threadId }: { threadId: string }): JSX.Element | null {
  const { bindings } = useChatContext()
  const binding = bindings.find((candidate): candidate is AttemptBinding => candidate.kind === 'attempt' && candidate.threadId === threadId)
  return binding === undefined ? null : <AttemptLink binding={binding} />
}

/** Whether the shell asked for this thread, or one inside it, to be shown. */
function asked(focus: ThreadFocus | null, threadId: string): boolean {
  return focus?.open.has(threadId) === true
}

/**
 * Open from the start when a request waits in the thread or the shell asked for it; opened again whenever a
 * request starts waiting in it or the shell asks again. The person can close it at any time.
 */
function useOpen(node: ThreadNode, focus: ThreadFocus | null): [boolean, Dispatch<SetStateAction<boolean>>] {
  const waiting = node.pending > 0
  const [open, setOpen] = useState(() => waiting || asked(focus, node.item.id))
  const request = asked(focus, node.item.id) ? (focus?.request ?? null) : null
  useEffect(() => {
    if (waiting) setOpen(true)
  }, [waiting])
  useEffect(() => {
    if (request !== null) setOpen(true)
  }, [request])
  return [open, setOpen]
}

/** Scrolls the block into view when the shell asked for exactly this thread. */
function useScrollTo(threadId: string, focus: ThreadFocus | null): RefObject<HTMLLIElement> {
  const ref = useRef<HTMLLIElement>(null)
  const request = focus?.threadId === threadId ? focus.request : null
  useEffect(() => {
    if (request !== null) {
      ref.current?.scrollIntoView?.({ block: 'center' })
    }
  }, [request])
  return ref
}

interface ThreadBlockProps {
  node: ThreadNode
  /** Renders one row of the thread with the transcript's own row component, so its items look like the rest of the chat. */
  renderRow(row: TreeRow): ReactNode
}

/**
 * The work of a subagent, as a block under the tool call that spawned it: its label and state (an hourglass
 * while it runs), the ticket it works on when it is bound to an attempt, and, once opened, its own items,
 * which stream in live. It opens by itself when a request waits for an answer inside it, so the person never
 * has to look for the question.
 */
export const ThreadBlock = memo(function ThreadBlock({ node, renderRow }: ThreadBlockProps): JSX.Element {
  const { item } = node
  const { focus } = useChatContext()
  const [open, setOpen] = useOpen(node, focus)
  const ref = useScrollTo(item.id, focus)
  const state = threadStateView(item.state)
  return (
    <li ref={ref} className="chat-thread" data-state={item.state} data-focused={focus?.threadId === item.id ? 'true' : undefined} aria-label={`Thread: ${item.label}`}>
      <div className="chat-thread-head">
        <button type="button" className="chat-thread-toggle" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
          {item.state === 'running' ? <Hourglass /> : null}
          <span className="chat-thread-label">{item.label}</span>
          <StatePill state={state.pill} label={state.label} />
          {node.pending > 0 ? <StatePill state="awaiting_checkpoint" label="Needs your answer" /> : null}
        </button>
        <BoundTicket threadId={item.id} />
      </div>
      {open ? <ol className="chat-thread-rows">{node.rows.map(renderRow)}</ol> : null}
    </li>
  )
})
