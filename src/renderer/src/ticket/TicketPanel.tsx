import '../epic/tones.css'
import './ticket.css'
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react'
import type { EvidenceRef } from '../../../shared/domain/space'
import type { PlanView, TicketDetailView } from '../../../shared/domain/views'
import { errorMessage } from '../api/dm'
import type { Scheduler } from '../app/scheduler'
import type { Runner } from '../epic/runner'
import { StatePill } from '../epic/StatePill'
import type { ReviewInput } from '../epic/workspaceActions'
import type { EvidenceOpener } from '../scorecard/ScorecardParts'
import { ActivityTab } from './ActivityTab'
import { AttemptList } from './AttemptList'
import { CommentsTab } from './CommentsTab'
import { DeleteTicketConfirm } from './DeleteTicket'
import { EvidenceTab, HistoryTab, OverviewTab } from './panelTabs'
import { ScorecardTab } from './ScorecardTab'
import { metaLine, statePill } from './ticketView'

export interface TicketPanelProps {
  runner: Runner
  /** The tracked folder the ticket belongs to; the Activity tab follows its attempts there. */
  folderPath: string
  /** The folder's attachment key (`TrackedFolderView.attachmentKey`): the Evidence tab's images are addressed by it. */
  folderKey: string
  /** Set when the person asked for the live activity of an attempt: the panel shows its Activity tab for it. */
  activity: { attemptId: string } | null
  /** Set when another screen asked for the ticket's Scorecard tab (a Metrics dashboard gap), on `runId`'s grade (null: the newest attempt's run). */
  scorecard: { runId: string | null } | null
  /** Paces the Activity tab's polling of an open attempt. */
  scheduler: Scheduler
  epicId: string
  ticketId: string
  plan: PlanView
  /** Changes whenever the workspace reloads, so the panel refetches. */
  reloadKey: unknown
  now: number
  /** The epic is unfinished: offer "Edit in draft", "Delete ticket…" and adding comments. */
  canEdit: boolean
  onEditInDraft(): void
  /** Deletes the ticket from the saved plan; resolves to the refusal's reason, or null once it is gone. */
  onDelete(): Promise<string | null>
  onClose(): void
  onSelectTicket(ticketId: string): void
  onReview(input: ReviewInput): Promise<string | null>
  /** Opens a chat; with a thread the chat opens with that thread expanded. The Activity tab links to the chat an attempt runs in. */
  onOpenChat(chatId: string, threadId?: string): void
}

type TabId = 'overview' | 'attempts' | 'activity' | 'evidence' | 'comments' | 'history' | 'scorecard'

const TAB_IDS: TabId[] = ['overview', 'attempts', 'activity', 'evidence', 'comments', 'history', 'scorecard']

interface DetailState {
  detail: TicketDetailView | null
  error: string | null
}

function useTicketDetail(props: TicketPanelProps): DetailState {
  const { runner, epicId, ticketId, reloadKey } = props
  const view = props.plan.view
  const [state, setState] = useState<DetailState>({ detail: null, error: null })
  useEffect(() => {
    let active = true
    runner('getTicket', { epicId, ticketId, view }).then(
      (detail) => {
        if (active) {
          setState({ detail, error: null })
        }
      },
      (error: unknown) => {
        if (active) {
          setState({ detail: null, error: errorMessage(error) })
        }
      }
    )
    return () => {
      active = false
    }
  }, [runner, epicId, ticketId, view, reloadKey])
  return state
}

/** The tab an arrow, Home or End key moves to, or null for any other key. */
function targetTab(key: string, current: TabId): TabId | null {
  const index = TAB_IDS.indexOf(current)
  const count = TAB_IDS.length
  const targets: Record<string, number> = { ArrowRight: (index + 1) % count, ArrowLeft: (index + count - 1) % count, Home: 0, End: count - 1 }
  const target = Object.hasOwn(targets, key) ? targets[key] : undefined
  return target === undefined ? null : (TAB_IDS[target] ?? null)
}

function tabLabel(id: TabId, attempts: number): string {
  return { overview: 'Overview', attempts: `Attempts (${attempts})`, activity: 'Activity', evidence: 'Evidence', comments: 'Comments', history: 'History', scorecard: 'Scorecard' }[id]
}

/** The tab strip: Tab reaches the open tab, the arrow keys, Home and End move between tabs and open them. */
function Tabs(props: { tab: TabId; attempts: number; panelId: string; onTab(tab: TabId): void }): JSX.Element {
  const strip = useRef<HTMLDivElement>(null)
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = targetTab(event.key, props.tab)
    if (next === null) {
      return
    }
    event.preventDefault()
    props.onTab(next)
    strip.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus()
  }
  return (
    <div ref={strip} className="tp-tabs" role="tablist" aria-label="Ticket sections" onKeyDown={onKeyDown}>
      {TAB_IDS.map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          id={`${props.panelId}-tab-${id}`}
          data-tab={id}
          aria-selected={props.tab === id}
          aria-controls={props.panelId}
          tabIndex={props.tab === id ? 0 : -1}
          onClick={() => props.onTab(id)}
        >
          {tabLabel(id, props.attempts)}
        </button>
      ))}
    </div>
  )
}

/**
 * Which tab is open; which attempt the Activity tab follows (null: the ticket's latest); the attempt a scorecard
 * citation opened in the Attempts or Evidence tab; and the run the Scorecard tab reads (null: the newest attempt's).
 */
interface PanelFocus {
  tab: TabId
  attemptId: string | null
  citedAttemptId: string | null
  scoreRunId: string | null
}

/** The tab a request opens: Activity for an attempt, Scorecard for a run's grade; null when nothing was asked. */
function requestedFocus(activity: TicketPanelProps['activity'], scorecard: TicketPanelProps['scorecard']): Partial<PanelFocus> | null {
  if (activity !== null) return { tab: 'activity', attemptId: activity.attemptId }
  if (scorecard !== null) return { tab: 'scorecard', scoreRunId: scorecard.runId }
  return null
}

/** Opens on the Activity or Scorecard tab when asked to, and comes back to it every time the request is made again. */
function usePanelFocus(activity: TicketPanelProps['activity'], scorecard: TicketPanelProps['scorecard']): [PanelFocus, (focus: Partial<PanelFocus>) => void] {
  const [focus, setFocus] = useState<PanelFocus>(() => ({
    tab: 'overview',
    attemptId: null,
    citedAttemptId: null,
    scoreRunId: null,
    ...requestedFocus(activity, scorecard)
  }))
  useEffect(() => {
    const requested = requestedFocus(activity, scorecard)
    if (requested !== null) {
      setFocus((held) => ({ ...held, ...requested }))
    }
  }, [activity, scorecard])
  return [focus, (change) => setFocus((held) => ({ ...held, ...change }))]
}

/** Where a scorecard citation opens in this panel: one of its tabs, another ticket, or nowhere (no view of it here). */
type CitationTarget = { label: string; focus: Partial<PanelFocus> } | { label: string; ticketId: string } | null

function citationTarget(ref: EvidenceRef, detail: TicketDetailView): CitationTarget {
  const ownAttempt = detail.attempts.some((attempt) => attempt.id === ref.id)
  switch (ref.kind) {
    case 'attempt':
      return ownAttempt ? { label: 'Attempts', focus: { tab: 'attempts', citedAttemptId: ref.id } } : null
    case 'check':
      return ownAttempt ? { label: 'Evidence', focus: { tab: 'evidence', citedAttemptId: ref.id } } : null
    case 'criterion':
    case 'ticket':
      return ref.id === detail.ticket.id ? { label: 'Overview', focus: { tab: 'overview' } } : { label: 'ticket', ticketId: ref.id }
    case 'comment':
      return { label: 'Comments', focus: { tab: 'comments' } }
    default:
      return null
  }
}

function citationOpener(detail: TicketDetailView, panel: TicketPanelProps, setFocus: (focus: Partial<PanelFocus>) => void): EvidenceOpener {
  return {
    target: (ref) => citationTarget(ref, detail)?.label ?? null,
    open: (ref) => {
      const target = citationTarget(ref, detail)
      if (target === null) {
        return
      }
      if ('ticketId' in target) {
        panel.onSelectTicket(target.ticketId)
      } else {
        setFocus(target.focus)
      }
    }
  }
}

interface TabBodyProps {
  focus: PanelFocus
  detail: TicketDetailView
  panel: TicketPanelProps
  onFocus(focus: Partial<PanelFocus>): void
}

function TabBody(props: TabBodyProps): JSX.Element {
  const { detail, panel, focus } = props
  switch (focus.tab) {
    case 'overview':
      return <OverviewTab detail={detail} bundle={panel.plan.bundle} runner={panel.runner} folderKey={panel.folderKey} onSelect={panel.onSelectTicket} />
    case 'attempts':
      return <AttemptList attempts={detail.attempts} now={panel.now} onReview={panel.onReview} focusAttemptId={focus.citedAttemptId} />
    case 'activity':
      return (
        <ActivityTab
          folderPath={panel.folderPath}
          attempts={detail.attempts}
          attemptId={focus.attemptId}
          onChoose={(attemptId) => props.onFocus({ attemptId })}
          onOpenChat={panel.onOpenChat}
          scheduler={panel.scheduler}
        />
      )
    case 'evidence':
      return <EvidenceTab detail={detail} folderKey={panel.folderKey} attemptId={focus.citedAttemptId} />
    case 'comments':
      return (
        <CommentsTab
          runner={panel.runner}
          epicId={panel.epicId}
          ticketId={detail.ticket.id}
          now={panel.now}
          reloadKey={panel.reloadKey}
          canComment={panel.canEdit}
          folderKey={panel.folderKey}
        />
      )
    case 'history':
      return (
        <HistoryTab runner={panel.runner} epicId={panel.epicId} ticketId={panel.ticketId} now={panel.now} reloadKey={panel.reloadKey} />
      )
    case 'scorecard':
      return <ScorecardBody {...props} />
  }
}

function ScorecardBody({ detail, panel, focus, onFocus }: TabBodyProps): JSX.Element {
  return (
    <ScorecardTab
      folderPath={panel.folderPath}
      epicId={panel.epicId}
      ticketId={panel.ticketId}
      attempts={detail.attempts}
      runId={focus.scoreRunId}
      onChooseRun={(scoreRunId) => onFocus({ scoreRunId })}
      scheduler={panel.scheduler}
      reloadKey={panel.reloadKey}
      opener={citationOpener(detail, panel, onFocus)}
    />
  )
}

function PanelHead(props: { panel: TicketPanelProps; detail: TicketDetailView; tab: TabId; panelId: string; onTab(tab: TabId): void }): JSX.Element {
  const { panel, detail } = props
  const [deleting, setDeleting] = useState(false)
  const pill = statePill(detail)
  const sprint = panel.plan.bundle.sprints.find((item) => item.id === detail.sprintId)
  return (
    <div className="tp-head">
      <div className="tp-head-row">
        <span className="ew-mono tp-key">{detail.ticket.key}</span>
        {detail.ticket.repo === undefined ? null : (
          <span className="ew-mono tp-repo" aria-label="Repository">
            {detail.ticket.repo}
          </span>
        )}
        <StatePill tone={pill.tone} label={pill.label} />
        <span className="tp-head-actions">
          {panel.canEdit ? (
            <>
              <button type="button" className="btn btn-ghost" onClick={panel.onEditInDraft}>
                Edit in draft
              </button>
              <button type="button" className="btn btn-ghost tp-danger-link" onClick={() => setDeleting(true)}>
                Delete ticket…
              </button>
            </>
          ) : null}
          <button type="button" className="ew-icon-btn" aria-label="Close ticket" onClick={panel.onClose}>
            ×
          </button>
        </span>
      </div>
      <h2 className="tp-title">{detail.ticket.title}</h2>
      <p className="tp-meta">{metaLine(detail, sprint?.goal ?? '', panel.plan.revisionNumber)}</p>
      {deleting && panel.canEdit ? (
        <DeleteTicketConfirm ticketKey={detail.ticket.key} onDelete={panel.onDelete} onKeep={() => setDeleting(false)} />
      ) : null}
      <Tabs tab={props.tab} attempts={detail.attempts.length} panelId={props.panelId} onTab={props.onTab} />
    </div>
  )
}

/** Read view of one ticket: Markdown, criteria, capability profile, links, attempts, evidence, comments, history. */
export function TicketPanel(props: TicketPanelProps): JSX.Element {
  const { detail, error } = useTicketDetail(props)
  const [focus, setFocus] = usePanelFocus(props.activity, props.scorecard)
  const panelId = useId()
  const key = props.plan.bundle.tickets.find((item) => item.id === props.ticketId)?.key ?? props.ticketId
  if (detail === null) {
    return (
      <aside className="tp" aria-label={`Ticket ${key}`}>
        <div className="tp-head tp-head-row">
          <span className="ew-mono tp-key">{key}</span>
          <button type="button" className="ew-icon-btn" aria-label="Close ticket" onClick={props.onClose}>
            ×
          </button>
        </div>
        {error === null ? <p className="ew-muted tp-body">Loading ticket…</p> : <p role="alert" className="tp-error tp-body">{error}</p>}
      </aside>
    )
  }
  return (
    <aside className="tp" aria-label={`Ticket ${key}`}>
      <PanelHead panel={props} detail={detail} tab={focus.tab} panelId={panelId} onTab={(tab) => setFocus({ tab, citedAttemptId: null })} />
      <div className="tp-body" role="tabpanel" id={panelId} aria-labelledby={`${panelId}-tab-${focus.tab}`}>
        <TabBody focus={focus} detail={detail} panel={props} onFocus={setFocus} />
      </div>
    </aside>
  )
}
