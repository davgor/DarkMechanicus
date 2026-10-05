import './orchestratorFeed.css'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { BoundThread } from '../../../shared/agents/chatApi'
import type { RunTimelineView } from '../../../shared/domain/activity'
import { isActiveRunState } from '../../../shared/domain/status'
import type { RunView } from '../../../shared/domain/views'
import { isApproval, StreamApproval, StreamBody } from '../agents/StreamRow'
import { mergeByTime } from '../agents/threadStream'
import { useBoundThread } from '../agents/useBoundThread'
import { streamEntries, useThreadStream, type StreamEntry, type ThreadStream } from '../agents/useThreadStream'
import { useRunTimeline } from '../app/useActivityTimeline'
import { Icon } from '../components/Icon'
import { streamMeta, feedRows, orchestratorLabel, type FeedRow } from './orchestratorFeedView'
import { useReducedMotion } from './useReducedMotion'
import type { WorkspaceHandle } from './useWorkspace'
import { planFor } from './workspaceState'

interface ChipProps {
  label: string
  open: boolean
  controls: string
  onToggle(): void
}

/** The orchestrator's entry in the run bar: an hourglass (still when the person prefers reduced motion) and the session's name. */
function Chip({ label, open, controls, onToggle, chipRef }: ChipProps & { chipRef: RefObject<HTMLButtonElement> }): JSX.Element {
  const reduced = useReducedMotion()
  return (
    <button
      ref={chipRef}
      type="button"
      className="of-chip"
      data-motion={reduced ? 'still' : 'turning'}
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      title="Open the live run feed"
      onClick={onToggle}
    >
      <Icon name="hourglass" className="of-hourglass" />
      <span>{label}</span>
    </button>
  )
}

interface RowProps {
  row: FeedRow
  /** Opens the ticket panel; null when the shown plan does not hold the ticket. */
  onOpenTicket: ((ticketId: string) => void) | null
}

function TicketRef({ row, onOpenTicket }: RowProps): JSX.Element | null {
  if (row.ticket === null) {
    return null
  }
  const { id, key } = row.ticket
  return onOpenTicket === null ? (
    <span className="ew-mono">{key}</span>
  ) : (
    <button type="button" className="ew-link ew-mono" onClick={() => onOpenTicket(id)}>
      {key}
    </button>
  )
}

function FeedItem({ row, onOpenTicket }: RowProps): JSX.Element {
  return (
    <li className={`of-row ew-tone-${row.tone}`}>
      <span className="ew-dot" aria-hidden="true" />
      <div className="of-row-body">
        <p className="of-line">
          <span className="of-label">{row.label}</span>
          <TicketRef row={row} onOpenTicket={onOpenTicket} />
          <span>{row.text}</span>
        </p>
        {row.details.map((detail) => (
          <p key={detail.name} className="of-detail">
            <span className="of-detail-name">{detail.name}</span>
            <span>{detail.value}</span>
          </p>
        ))}
        <p className="of-meta">{`${row.who} · ${row.when}`}</p>
      </div>
    </li>
  )
}

interface FeedProps {
  id: string
  /** The tracked folder the run belongs to. */
  folder: string
  now: number
  run: RunView
  view: RunTimelineView | null
  failed: boolean
  rows: FeedRow[]
  onOpenTicket(ticketId: string): void
  /** Opens the chat that orchestrates the run. */
  onOpenChat(chatId: string): void
  /** Ticket ids the shown plan holds; entries about others show their key without a link. */
  linkable: ReadonlySet<string>
  onClose(): void
}

/** One row of the orchestrator's chat, in the feed's own row layout; a request waiting for the person is a card they can answer. */
function ChatFeedItem({ entry, now }: { entry: StreamEntry; now: number }): JSX.Element {
  const { row } = entry
  if (isApproval(row)) {
    return <StreamApproval row={row} entry={entry} />
  }
  return (
    <li className={`of-row ew-tone-${row.tone}`} data-kind={`chat_${row.kind}`}>
      <span className="ew-dot" aria-hidden="true" />
      <div className="of-row-body">
        <StreamBody row={row} />
        <p className="of-meta">{streamMeta(row.at, now)}</p>
      </div>
    </li>
  )
}


/** What to say while there are no rows: nothing yet, still loading, or the first read failed. */
function emptyText(view: RunTimelineView | null, failed: boolean): string {
  if (view !== null) {
    return 'Nothing has happened in this run yet.'
  }
  return failed ? 'The run feed could not be read.' : 'Loading the run feed…'
}

/** The run's rows, newest first, with the rows of the orchestrator's chat (when it has one) among them by time. */
function FeedBody(props: FeedProps & { stream: ThreadStream | null }): JSX.Element {
  const { view, failed, rows, linkable, onOpenTicket, stream } = props
  const newestFirst = useMemo(() => [...streamEntries(stream)].reverse(), [stream])
  const merged = mergeByTime(rows, (row) => row.at, newestFirst, 'newest_first')
  if (merged.length === 0) {
    return <p className="ew-muted of-empty">{emptyText(view, failed)}</p>
  }
  return (
    <div role="log" aria-label="Run activity">
      <ol className="of-rows">
        {merged.map((entry) =>
          entry.source === 'record' ? (
            <FeedItem
              key={entry.item.id}
              row={entry.item}
              onOpenTicket={entry.item.ticket !== null && linkable.has(entry.item.ticket.id) ? onOpenTicket : null}
            />
          ) : (
            <ChatFeedItem key={`chat:${entry.row.row.id}`} entry={entry.row} now={props.now} />
          )
        )}
      </ol>
    </div>
  )
}

/** The feed with the orchestrator's chat followed: the chat is opened once and its pushes keep the rows current. */
function BoundFeedBody({ thread, ...props }: FeedProps & { thread: BoundThread }): JSX.Element {
  const stream = useThreadStream(thread)
  return (
    <>
      {stream.error === null ? null : (
        <p role="alert" className="of-error">
          {stream.error}
        </p>
      )}
      <FeedBody {...props} stream={stream} />
    </>
  )
}

function FeedLog({ thread, ...props }: FeedProps & { thread: BoundThread | null }): JSX.Element {
  return thread === null ? <FeedBody {...props} stream={null} /> : <BoundFeedBody {...props} thread={thread} />
}

/**
 * The live run feed: a non-modal drawer under the run bar. Escape or Close puts it away. A run that a chat
 * orchestrates also shows that chat's main thread, with a link to the chat; the chat is followed only while
 * the drawer is open.
 */
function Drawer(props: FeedProps): JSX.Element {
  const panel = useRef<HTMLElement>(null)
  const thread = useBoundThread({ folder: props.folder, runId: props.run.id }, props.view?.cursor)
  useEffect(() => panel.current?.focus(), [])
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      props.onClose()
    }
  }
  const live = props.view?.isLive ?? true
  return (
    <section ref={panel} id={props.id} className="of-drawer" role="region" aria-label="Orchestrator feed" tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="of-head">
        <h2 className="of-title">{`Run #${props.run.number}`}</h2>
        <span className={live ? 'of-live ew-tone-running' : 'of-live ew-tone-neutral'}>
          <span className="ew-dot" aria-hidden="true" />
          {live ? 'Live' : 'Run ended'}
        </span>
        {thread === null ? null : (
          <button type="button" className="ew-link of-open" onClick={() => props.onOpenChat(thread.chatId)}>
            Open chat
          </button>
        )}
        <button type="button" className="ew-icon-btn of-close" aria-label="Close feed" onClick={props.onClose}>
          ×
        </button>
      </header>
      <FeedLog {...props} thread={thread} />
    </section>
  )
}

/** The chip and its drawer; follows the run's timeline for as long as the run is active. */
function ActiveEntry({ ws, run }: { ws: WorkspaceHandle; run: RunView }): JSX.Element {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const chip = useRef<HTMLButtonElement>(null)
  const id = useId()
  const view = useRunTimeline({ path: ws.folder.path, runId: run.id, scheduler: ws.scheduler, onError: () => setFailed(true) })
  const keys = new Map(run.tickets.map((item) => [item.ticketId, item.key]))
  const linkable = new Set(planFor(ws.data, ws.state.view)?.bundle.tickets.map((item) => item.id))
  const close = (): void => {
    setOpen(false)
    chip.current?.focus()
  }
  return (
    <>
      <Chip chipRef={chip} label={orchestratorLabel(view)} open={open} controls={id} onToggle={() => (open ? close() : setOpen(true))} />
      {open ? (
        <Drawer
          id={id}
          folder={ws.folder.path}
          now={ws.now}
          run={run}
          view={view}
          failed={failed}
          rows={feedRows(view, keys, ws.now)}
          linkable={linkable}
          onOpenTicket={(ticketId) => {
            setOpen(false)
            ws.dispatch({ type: 'select_ticket', ticketId })
          }}
          onOpenChat={ws.orchestration.onOpenChat}
          onClose={close}
        />
      ) : null}
    </>
  )
}

/** The orchestrator chip for the run bar: shown only while the run is active. */
export function OrchestratorEntry({ ws, run }: { ws: WorkspaceHandle; run: RunView }): JSX.Element | null {
  return isActiveRunState(run.state) ? <ActiveEntry ws={ws} run={run} /> : null
}
