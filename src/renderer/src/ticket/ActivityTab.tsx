import { useEffect, useMemo, useState } from 'react'
import type { BoundThread } from '../../../shared/agents/chatApi'
import type { AttemptTimelineView } from '../../../shared/domain/activity'
import type { AttemptView } from '../../../shared/domain/views'
import { errorMessage } from '../api/dm'
import type { Scheduler } from '../app/scheduler'
import { useAttemptTimeline } from '../app/useActivityTimeline'
import { isApproval, StreamApproval, StreamBody } from '../agents/StreamRow'
import { mergeByTime } from '../agents/threadStream'
import { useBoundThread } from '../agents/useBoundThread'
import { streamEntries, useThreadStream, type StreamEntry, type ThreadStream } from '../agents/useThreadStream'
import { StatePill } from '../epic/StatePill'
import { ATTEMPT_LABELS, ATTEMPT_TONES } from '../graph/ticketStates'
import { activityItems, attemptWindow, clockTime, endedSummary, latestAttemptId, type ActivityItem } from './activityView'
import { useFollowScroll } from './useFollowScroll'

interface ActivityTabProps {
  /** The tracked folder the attempt belongs to. */
  folderPath: string
  /** The ticket's attempts: they name the one shown and fill the picker. */
  attempts: AttemptView[]
  /** The attempt to show; null shows the ticket's latest. */
  attemptId: string | null
  onChoose(attemptId: string): void
  /** Opens a chat; with a thread (a `thread` item's id) the chat opens with that thread expanded. */
  onOpenChat(chatId: string, threadId?: string): void
  scheduler: Scheduler
}

function optionLabel(item: AttemptView): string {
  return `#${item.number} · ${item.worker.label} · ${ATTEMPT_LABELS[item.state]}`
}

/** A choice between the ticket's attempts, newest first; a ticket with one attempt has nothing to choose. */
function AttemptPicker(props: { attempts: AttemptView[]; shown: string; onChoose(attemptId: string): void }): JSX.Element | null {
  const { attempts, shown } = props
  if (attempts.length < 2 || !attempts.some((item) => item.id === shown)) {
    return null
  }
  const ordered = [...attempts].sort((a, b) => b.number - a.number)
  return (
    <label className="tp-field">
      <span>Attempt</span>
      <select value={shown} onChange={(event) => props.onChoose(event.target.value)}>
        {ordered.map((item) => (
          <option key={item.id} value={item.id}>
            {optionLabel(item)}
          </option>
        ))}
      </select>
    </label>
  )
}

interface HeadingProps {
  attempt: AttemptView | undefined
  view: AttemptTimelineView | null
  /** Opens the chat the attempt's worker runs in; null when the attempt is not worked in a chat. */
  onOpenChat: (() => void) | null
}

function Heading(props: HeadingProps): JSX.Element {
  const { attempt, view } = props
  const state = view?.state ?? attempt?.state
  return (
    <div className="tp-attempt-head">
      <span className="ew-mono">{attempt === undefined ? 'Attempt' : `Attempt #${attempt.number}`}</span>
      {state === undefined ? null : <StatePill tone={ATTEMPT_TONES[state]} label={ATTEMPT_LABELS[state].toUpperCase()} />}
      {view?.isLive === true ? <span className="ew-muted tp-activity-live">Updating live</span> : null}
      {props.onOpenChat === null ? null : (
        <button type="button" className="ew-link tp-activity-open" onClick={props.onOpenChat}>
          Open chat
        </button>
      )}
    </div>
  )
}

function Row({ item }: { item: ActivityItem }): JSX.Element {
  return (
    <li className={`tp-activity-item ew-tone-${item.tone}`} data-kind={item.kind}>
      <span className="ew-dot" aria-hidden="true" />
      <div className="tp-activity-text">
        <p className="tp-activity-title">{item.title}</p>
        {item.detail === '' ? null : <p className="tp-activity-detail">{item.detail}</p>}
      </div>
      {item.when === '' ? null : (
        <time className="ew-mono ew-muted tp-activity-when" dateTime={item.at}>
          {item.when}
        </time>
      )}
    </li>
  )
}

/** One row of the followed chat thread, in the list's own row layout; a request waiting for the person is a card they can answer. */
function ChatRow({ entry }: { entry: StreamEntry }): JSX.Element {
  const { row } = entry
  if (isApproval(row)) {
    return <StreamApproval row={row} entry={entry} />
  }
  return (
    <li className={`tp-activity-item ew-tone-${row.tone}`} data-kind={`chat_${row.kind}`}>
      <span className="ew-dot" aria-hidden="true" />
      <StreamBody row={row} />
      {row.at === null ? null : (
        <time className="ew-mono ew-muted tp-activity-when" dateTime={row.at}>
          {clockTime(row.at)}
        </time>
      )}
    </li>
  )
}

/**
 * The entries, oldest first, in a log that follows its newest row until the person scrolls up. The rows of the
 * attempt's chat thread, when it has one, are listed among them by time.
 */
function Log({ view, stream }: { view: AttemptTimelineView; stream: ThreadStream | null }): JSX.Element {
  const items = useMemo(() => activityItems(view.entries), [view.entries])
  const chat = useMemo(() => streamEntries(stream), [stream])
  const merged = useMemo(() => mergeByTime(items, (item) => item.at, chat, 'oldest_first'), [items, chat])
  const follow = useFollowScroll<HTMLDivElement>(merged)
  return (
    <div className="tp-activity-logbox">
      <div ref={follow.ref} className="tp-activity-log" role="log" aria-label="Attempt timeline" tabIndex={0} onScroll={follow.onScroll}>
        {merged.length === 0 ? (
          <p className="ew-muted">No activity recorded yet.</p>
        ) : (
          <ol className="tp-activity-list">
            {merged.map((entry) =>
              entry.source === 'record' ? (
                <Row key={entry.item.id} item={entry.item} />
              ) : (
                <ChatRow key={`chat:${entry.row.row.id}`} entry={entry.row} />
              )
            )}
          </ol>
        )}
      </div>
      {follow.away ? (
        <button type="button" className="btn tp-activity-jump" onClick={follow.jump}>
          Jump to latest
        </button>
      ) : null}
    </div>
  )
}

function Ended({ view }: { view: AttemptTimelineView }): JSX.Element | null {
  const ended = endedSummary(view)
  if (ended === null) {
    return null
  }
  return (
    <div className={`tp-activity-ended ew-tone-${ended.tone}`} role="status">
      <p className="tp-activity-title">Attempt ended: {ended.label}</p>
      {ended.detail === '' ? null : <p className="tp-activity-detail">{ended.detail}</p>}
    </div>
  )
}

interface TimelineProps {
  folderPath: string
  attemptId: string
  attempt: AttemptView | undefined
  onOpenChat(chatId: string, threadId?: string): void
  scheduler: Scheduler
}

/**
 * The log with the attempt's chat thread followed: the chat is read once (never opened) and its pushes keep the
 * rows current. A thread that served other attempts too shows only the rows from this attempt's window.
 */
function BoundLog({ view, thread }: { view: AttemptTimelineView; thread: BoundThread }): JSX.Element {
  const stream = useThreadStream(thread, attemptWindow(view))
  return (
    <>
      {stream.error === null ? null : <p role="alert" className="tp-error">{stream.error}</p>}
      <Log view={view} stream={stream} />
    </>
  )
}

/** The log, with the attempt's chat thread followed when it has one. */
function LogOf({ view, thread }: { view: AttemptTimelineView; thread: BoundThread | null }): JSX.Element {
  return thread === null ? <Log view={view} stream={null} /> : <BoundLog view={view} thread={thread} />
}

/**
 * Follows one attempt: its history, then each new entry while it is open; polling stops when it closes. An
 * attempt whose worker runs in a chat thread also shows that thread, merged in, with a link to the chat; the
 * lookup is asked again as the timeline moves until a thread is bound. Any other attempt shows the timeline alone.
 */
function Timeline(props: TimelineProps): JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const view = useAttemptTimeline({
    path: props.folderPath,
    attemptId: props.attemptId,
    scheduler: props.scheduler,
    onError: (failure) => setError(errorMessage(failure))
  })
  useEffect(() => setError(null), [view])
  const thread = useBoundThread({ folder: props.folderPath, attemptId: props.attemptId }, view?.cursor)
  const open = thread === null ? null : () => props.onOpenChat(thread.chatId, thread.threadId ?? undefined)
  return (
    <>
      <Heading attempt={props.attempt} view={view} onOpenChat={open} />
      {error === null ? null : <p role="alert" className="tp-error">{error}</p>}
      {view === null && error === null ? <p className="ew-muted">Loading activity…</p> : null}
      {view === null ? null : <LogOf view={view} thread={thread} />}
      {view === null ? null : <Ended view={view} />}
    </>
  )
}

/** What the attempt did and said, newest at the bottom; it keeps up with a live attempt and says how a closed one ended. */
export function ActivityTab(props: ActivityTabProps): JSX.Element {
  const shown = props.attemptId ?? latestAttemptId(props.attempts)
  if (shown === null) {
    return <p className="ew-muted">No attempts yet.</p>
  }
  return (
    <section className="tp-activity" aria-label="Attempt activity">
      <AttemptPicker attempts={props.attempts} shown={shown} onChoose={props.onChoose} />
      <Timeline
        key={shown}
        folderPath={props.folderPath}
        attemptId={shown}
        attempt={props.attempts.find((item) => item.id === shown)}
        onOpenChat={props.onOpenChat}
        scheduler={props.scheduler}
      />
    </section>
  )
}
