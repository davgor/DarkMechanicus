import { useEffect, useState, type ReactNode } from 'react'
import { isAcceptanceTicket } from '../../../core/plan/acceptance'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { CheckStatus, EventView, TicketDetailView } from '../../../shared/domain/views'
import { errorMessage } from '../api/dm'
import type { Runner } from '../epic/runner'
import { StateLabel } from '../epic/StatePill'
import { InlineMarkdown, Markdown } from '../markdown/Markdown'
import { CoverageCriteria, CriteriaItems, DefinitionOfDone } from './AcceptanceSections'
import { loadHistory } from './ticketData'
import { capabilityRows, criteriaChecklist, evidenceView, historyItems, linkRows, sizeAndEffortRows, type EvidenceView, type LinkRow } from './ticketView'

function LinkList(props: { title: string; rows: LinkRow[]; onSelect(ticketId: string): void }): JSX.Element | null {
  if (props.rows.length === 0) {
    return null
  }
  return (
    <section className="tp-section" aria-label={props.title}>
      <h3 className="ew-eyebrow">{props.title}</h3>
      <ul className="tp-links">
        {props.rows.map((row) => (
          <li key={row.ticketId}>
            <button type="button" className="tp-link" onClick={() => props.onSelect(row.ticketId)}>
              <span className="ew-mono">{row.key}</span>
              <span className="tp-link-title">{row.title}</span>
              <StateLabel tone={row.tone} label={row.label} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

function CriteriaChecklist({ detail }: { detail: TicketDetailView }): JSX.Element {
  const checklist = criteriaChecklist(detail.ticket, detail.attempts)
  return (
    <section className="tp-section" aria-label="Acceptance criteria">
      <h3 className="ew-eyebrow">{checklist.heading}</h3>
      <CriteriaItems items={checklist.items} />
    </section>
  )
}

function CapabilityProfile({ detail }: { detail: TicketDetailView }): JSX.Element {
  const ticket = detail.ticket
  const capability = ticket.capability
  const allRows = [...sizeAndEffortRows(ticket, capability), ...capabilityRows(capability)]
  return (
    <section className="tp-section" aria-label="Capability profile">
      <h3 className="ew-eyebrow">CAPABILITY PROFILE</h3>
      <dl className="tp-profile">
        {allRows.map((row) => (
          <div key={row.label} className="tp-profile-row">
            <dt>{row.label}</dt>
            <dd>
              {row.value}
              {row.note === '' ? null : <span className="ew-muted"> · {row.note}</span>}
            </dd>
          </div>
        ))}
      </dl>
      <div className="tp-chips">
        {capability.skills.map((skill) => (
          <span key={skill} className="ew-chip">
            {skill}
          </span>
        ))}
      </div>
    </section>
  )
}

interface OverviewTabProps {
  detail: TicketDetailView
  /** The plan the ticket is read from: an acceptance node names the tickets it covers by id. */
  bundle: PlanBundle
  runner: Runner
  onSelect(ticketId: string): void
}

/** A sprint's acceptance node shows its criteria by covered ticket, then the project's Definition of Done. */
function Criteria({ detail, bundle, runner, onSelect }: OverviewTabProps): JSX.Element {
  if (!isAcceptanceTicket(detail.ticket)) {
    return <CriteriaChecklist detail={detail} />
  }
  return (
    <>
      <CoverageCriteria detail={detail} bundle={bundle} onSelect={onSelect} />
      <DefinitionOfDone runner={runner} detail={detail} bundle={bundle} />
    </>
  )
}

export function OverviewTab(props: OverviewTabProps): JSX.Element {
  const detail = props.detail
  return (
    <>
      {detail.ticket.body.trim() === '' ? <p className="ew-muted">No description.</p> : <Markdown source={detail.ticket.body} />}
      <Criteria {...props} />
      <CapabilityProfile detail={detail} />
      <LinkList title="REQUIRES" rows={linkRows(detail.prerequisites)} onSelect={props.onSelect} />
      <LinkList title="UNLOCKS" rows={linkRows(detail.dependents)} onSelect={props.onSelect} />
      <LinkList title="RELATED" rows={linkRows(detail.relations.map((item) => item.ticket))} onSelect={props.onSelect} />
    </>
  )
}

/** One check or criterion result: a status icon, then its title over a wrapping detail line. */
interface EvidenceRow {
  key: string
  tone: CheckStatus
  status: string
  icon: string
  title: ReactNode
  detail: string
}

function EvidenceList(props: { heading: string; label: string; rows: EvidenceRow[] }): JSX.Element | null {
  if (props.rows.length === 0) {
    return null
  }
  return (
    <section className="tp-section">
      <h3 className="ew-eyebrow">{props.heading}</h3>
      <ul className="tp-checks" aria-label={props.label}>
        {props.rows.map((row) => (
          <li key={row.key} className={`tp-check is-${row.tone}`}>
            <span className="tp-check-icon" aria-label={row.status}>
              {row.icon}
            </span>
            <div className="tp-check-body">
              <span>{row.title}</span>
              <span className="tp-check-detail">{row.detail}</span>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** An attempt's evidence: where it came from, its checks, its criteria results and its notes. */
export function EvidenceSections({ evidence }: { evidence: EvidenceView }): JSX.Element {
  const checks = evidence.checks.map(
    (check): EvidenceRow => ({ key: check.name, tone: check.status, status: check.status, icon: check.icon, title: check.name, detail: check.detail })
  )
  const criteria = evidence.criteria.map(
    (result): EvidenceRow => ({
      key: result.text,
      tone: result.met ? 'passed' : 'failed',
      status: result.met ? 'met' : 'not met',
      icon: result.met ? '✓' : '✗',
      title: <InlineMarkdown source={result.text} />,
      detail: result.note
    })
  )
  return (
    <>
      <p className="ew-eyebrow">{evidence.source.toUpperCase()}</p>
      <EvidenceList heading="CHECKS" label="Checks" rows={checks} />
      <EvidenceList heading="CRITERIA" label="Criteria results" rows={criteria} />
      {evidence.notes.trim() === '' ? null : (
        <section className="tp-section">
          <h3 className="ew-eyebrow">NOTES</h3>
          <Markdown source={evidence.notes} />
        </section>
      )}
    </>
  )
}

export function EvidenceTab({ detail }: { detail: TicketDetailView }): JSX.Element {
  const evidence = evidenceView(detail.ticket, detail.attempts)
  return evidence === null ? <p className="ew-muted">No evidence recorded yet.</p> : <EvidenceSections evidence={evidence} />
}

function useHistory(runner: Runner, epicId: string, reloadKey: unknown): { events: EventView[] | null; error: string | null } {
  const [result, setResult] = useState<{ events: EventView[] | null; error: string | null }>({ events: null, error: null })
  useEffect(() => {
    let active = true
    loadHistory(runner, epicId).then(
      (events) => {
        if (active) {
          setResult({ events, error: null })
        }
      },
      (error: unknown) => {
        if (active) {
          setResult({ events: null, error: errorMessage(error) })
        }
      }
    )
    return () => {
      active = false
    }
  }, [runner, epicId, reloadKey])
  return result
}

export function HistoryTab(props: { runner: Runner; epicId: string; ticketId: string; now: number; reloadKey: unknown }): JSX.Element {
  const history = useHistory(props.runner, props.epicId, props.reloadKey)
  if (history.error !== null) {
    return <p role="alert" className="tp-error">{history.error}</p>
  }
  const items = history.events === null ? null : historyItems(history.events, props.ticketId, props.now)
  if (items === null) {
    return <p className="ew-muted">Loading history…</p>
  }
  return items.length === 0 ? (
    <p className="ew-muted">No events for this ticket yet.</p>
  ) : (
    <ol className="tp-history">
      {items.map((item) => (
        <li key={item.seq}>
          <span className="tp-history-title">{item.title}</span>
          <span className="ew-muted"> · {item.when}</span>
          {item.detail === '' ? null : <p className="tp-history-detail">{item.detail}</p>}
        </li>
      ))}
    </ol>
  )
}
