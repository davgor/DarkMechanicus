import '../epic/tones.css'
import './ticket.css'
import { useEffect, useState } from 'react'
import type { PlanView, TicketDetailView } from '../../../shared/domain/views'
import { errorMessage } from '../api/dm'
import type { Runner } from '../epic/runner'
import { StatePill } from '../epic/StatePill'
import type { ReviewInput } from '../epic/workspaceActions'
import { AttemptList } from './AttemptList'
import { CommentsTab } from './CommentsTab'
import { DeleteTicketConfirm } from './DeleteTicket'
import { EvidenceTab, HistoryTab, OverviewTab } from './panelTabs'
import { metaLine, statePill } from './ticketView'

export interface TicketPanelProps {
  runner: Runner
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
}

type TabId = 'overview' | 'attempts' | 'evidence' | 'comments' | 'history'

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

function Tabs(props: { tab: TabId; attempts: number; onTab(tab: TabId): void }): JSX.Element {
  const tabs: [TabId, string][] = [
    ['overview', 'Overview'],
    ['attempts', `Attempts (${props.attempts})`],
    ['evidence', 'Evidence'],
    ['comments', 'Comments'],
    ['history', 'History']
  ]
  return (
    <div className="tp-tabs" role="tablist" aria-label="Ticket sections">
      {tabs.map(([id, label]) => (
        <button key={id} type="button" role="tab" aria-selected={props.tab === id} onClick={() => props.onTab(id)}>
          {label}
        </button>
      ))}
    </div>
  )
}

function TabBody(props: { tab: TabId; detail: TicketDetailView; panel: TicketPanelProps }): JSX.Element {
  const { detail, panel } = props
  switch (props.tab) {
    case 'overview':
      return <OverviewTab detail={detail} bundle={panel.plan.bundle} runner={panel.runner} onSelect={panel.onSelectTicket} />
    case 'attempts':
      return <AttemptList attempts={detail.attempts} now={panel.now} onReview={panel.onReview} />
    case 'evidence':
      return <EvidenceTab detail={detail} />
    case 'comments':
      return (
        <CommentsTab
          runner={panel.runner}
          epicId={panel.epicId}
          ticketId={detail.ticket.id}
          now={panel.now}
          reloadKey={panel.reloadKey}
          canComment={panel.canEdit}
        />
      )
    case 'history':
      return (
        <HistoryTab runner={panel.runner} epicId={panel.epicId} ticketId={panel.ticketId} now={panel.now} reloadKey={panel.reloadKey} />
      )
  }
}

function PanelHead(props: { panel: TicketPanelProps; detail: TicketDetailView; tab: TabId; onTab(tab: TabId): void }): JSX.Element {
  const { panel, detail } = props
  const [deleting, setDeleting] = useState(false)
  const pill = statePill(detail)
  const sprint = panel.plan.bundle.sprints.find((item) => item.id === detail.sprintId)
  return (
    <div className="tp-head">
      <div className="tp-head-row">
        <span className="ew-mono tp-key">{detail.ticket.key}</span>
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
      <Tabs tab={props.tab} attempts={detail.attempts.length} onTab={props.onTab} />
    </div>
  )
}

/** Read view of one ticket: Markdown, criteria, capability profile, links, attempts, evidence, comments, history. */
export function TicketPanel(props: TicketPanelProps): JSX.Element {
  const { detail, error } = useTicketDetail(props)
  const [tab, setTab] = useState<TabId>('overview')
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
      <PanelHead panel={props} detail={detail} tab={tab} onTab={setTab} />
      <div className="tp-body" role="tabpanel">
        <TabBody tab={tab} detail={detail} panel={props} />
      </div>
    </aside>
  )
}
