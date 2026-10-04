import { useEffect, useState } from 'react'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { ProjectView, TicketDetailView } from '../../../shared/domain/views'
import { errorMessage } from '../api/dm'
import type { Runner } from '../epic/runner'
import { StateLabel } from '../epic/StatePill'
import type { Tone } from '../graph/ticketStates'
import { coverageView, definitionOfDoneRows, type CoverageGroup, type DefinitionOfDoneRow } from './acceptanceView'
import type { CriterionItem } from './ticketView'

/** The checkbox list of a ticket's criteria; the evidence ticks it, never the reader. */
export function CriteriaItems({ items }: { items: CriterionItem[] }): JSX.Element {
  return (
    <ul className="tp-criteria">
      {items.map((item) => (
        <li key={item.id} className={item.verified ? 'is-verified' : undefined}>
          <input type="checkbox" checked={item.verified} readOnly disabled aria-label={item.text} />
          <span>{item.text}</span>
        </li>
      ))}
    </ul>
  )
}

function GroupHead(props: { group: CoverageGroup; onSelect(ticketId: string): void }): JSX.Element {
  const { group } = props
  const ticketId = group.ticketId
  if (ticketId === null) {
    return <span className="tp-cover-head ew-eyebrow">{group.title}</span>
  }
  return (
    <button type="button" className="tp-link tp-cover-head" onClick={() => props.onSelect(ticketId)}>
      <span className="ew-mono">{group.key}</span>
      <span className="tp-link-title">{group.title}</span>
    </button>
  )
}

function CoverageGroupView(props: { group: CoverageGroup; onSelect(ticketId: string): void }): JSX.Element {
  const { group } = props
  const name = group.ticketId === null ? group.title : `Covers ${group.key} ${group.title}`.trim()
  return (
    <div role="group" aria-label={name} className="tp-cover">
      <GroupHead group={group} onSelect={props.onSelect} />
      {group.uncovered ? <p className="ew-muted tp-cover-none">No criterion covers this ticket yet.</p> : <CriteriaItems items={group.items} />}
    </div>
  )
}

/** The node's criteria grouped by the ticket each one covers. */
export function CoverageCriteria(props: {
  detail: TicketDetailView
  bundle: PlanBundle
  onSelect(ticketId: string): void
}): JSX.Element {
  const view = coverageView(props.detail.ticket, props.detail.attempts, props.bundle)
  return (
    <section className="tp-section" aria-label="Acceptance criteria">
      <h3 className="ew-eyebrow">{view.heading}</h3>
      {view.groups.map((group) => (
        <CoverageGroupView key={group.ticketId ?? 'sprint'} group={group} onSelect={props.onSelect} />
      ))}
    </section>
  )
}

interface ProjectState {
  project: ProjectView | null
  error: string | null
}

function useProject(runner: Runner): ProjectState {
  const [state, setState] = useState<ProjectState>({ project: null, error: null })
  useEffect(() => {
    let active = true
    runner('getProject', undefined).then(
      (project) => {
        if (active) {
          setState({ project, error: null })
        }
      },
      (error: unknown) => {
        if (active) {
          setState({ project: null, error: errorMessage(error) })
        }
      }
    )
    return () => {
      active = false
    }
  }, [runner])
  return state
}

const STATUS_TONES: Record<NonNullable<DefinitionOfDoneRow['status']>, Tone> = {
  passed: 'accepted',
  failed: 'failed',
  skipped: 'waiting',
  'not reported': 'blocked'
}

function DefinitionRow({ row }: { row: DefinitionOfDoneRow }): JSX.Element {
  return (
    <li className="tp-dod-row">
      <span className="tp-dod-name">{row.name}</span>
      {row.status === null ? null : (
        <span className="tp-dod-state">
          <StateLabel tone={STATUS_TONES[row.status]} label={row.status.toUpperCase()} />
        </span>
      )}
      <code className="tp-dod-command ew-mono">{row.command}</code>
      {row.description === '' ? null : <span className="tp-dod-description ew-muted">{row.description}</span>}
    </li>
  )
}

function DefinitionBody(props: { state: ProjectState; detail: TicketDetailView }): JSX.Element {
  const { project, error } = props.state
  if (error !== null) {
    return (
      <p role="alert" className="tp-error">
        Could not load the Definition of Done. {error}
      </p>
    )
  }
  if (project === null) {
    return <p className="ew-muted">Loading the Definition of Done…</p>
  }
  const rows = definitionOfDoneRows(project.definitionOfDone, props.detail.ticket, props.detail.attempts)
  if (rows.length === 0) {
    return <p className="ew-muted">This project has no Definition of Done.</p>
  }
  return (
    <ul className="tp-dod">
      {rows.map((row) => (
        <DefinitionRow key={row.name} row={row} />
      ))}
    </ul>
  )
}

function definitionHeading(project: ProjectView | null): string {
  const count = project?.definitionOfDone.length ?? 0
  if (project === null || count === 0) {
    return 'DEFINITION OF DONE'
  }
  return `DEFINITION OF DONE · ${count} ${count === 1 ? 'CHECK' : 'CHECKS'}`
}

/** The project's Definition of Done: the checks this node's worker must run and report, each by name. */
export function DefinitionOfDone(props: { runner: Runner; detail: TicketDetailView }): JSX.Element {
  const state = useProject(props.runner)
  return (
    <section className="tp-section" aria-label="Definition of Done">
      <h3 className="ew-eyebrow">{definitionHeading(state.project)}</h3>
      <DefinitionBody state={state} detail={props.detail} />
    </section>
  )
}
