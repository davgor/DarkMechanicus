import { useEffect, useState } from 'react'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { ProjectView, TicketDetailView } from '../../../shared/domain/views'
import { errorMessage } from '../api/dm'
import type { Runner } from '../epic/runner'
import { StateLabel } from '../epic/StatePill'
import type { Tone } from '../graph/ticketStates'
import {
  coverageView,
  definitionOfDoneRows,
  repositoryDefinitionGroups,
  type CoverageGroup,
  type DefinitionOfDoneRow,
  type RepositoryDefinitionGroup
} from './acceptanceView'
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

function DefinitionList({ rows }: { rows: DefinitionOfDoneRow[] }): JSX.Element {
  return (
    <ul className="tp-dod">
      {rows.map((row) => (
        <DefinitionRow key={row.name} row={row} />
      ))}
    </ul>
  )
}

/** In a folder of repositories: each touched repository's checks under its name, or a line saying it has none. */
function RepositoryDefinitions(props: { groups: RepositoryDefinitionGroup[] }): JSX.Element {
  if (props.groups.length === 0) {
    return <p className="ew-muted">This sprint touches no repository yet.</p>
  }
  return (
    <>
      {props.groups.map((group) => (
        <div key={group.repo} role="group" aria-label={group.repo} className="tp-cover">
          <span className="tp-cover-head ew-mono">{group.repo}</span>
          {group.rows.length === 0 ? (
            <p className="ew-muted">This repository has no Definition of Done.</p>
          ) : (
            <DefinitionList rows={group.rows} />
          )}
        </div>
      ))}
    </>
  )
}

interface DefinitionProps {
  detail: TicketDetailView
  bundle: PlanBundle
}

function DefinitionBody(props: DefinitionProps & { state: ProjectState }): JSX.Element {
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
  if (project.repositories !== null) {
    return <RepositoryDefinitions groups={repositoryDefinitionGroups(project.repositories, props.detail.ticket, props.detail.attempts, props.bundle)} />
  }
  const rows = definitionOfDoneRows(project.definitionOfDone, props.detail.ticket, props.detail.attempts)
  if (rows.length === 0) {
    return <p className="ew-muted">This project has no Definition of Done.</p>
  }
  return <DefinitionList rows={rows} />
}

function definitionHeading(project: ProjectView | null, props: DefinitionProps): string {
  if (project === null) {
    return 'DEFINITION OF DONE'
  }
  const count =
    project.repositories === null
      ? project.definitionOfDone.length
      : repositoryDefinitionGroups(project.repositories, props.detail.ticket, [], props.bundle).reduce((sum, group) => sum + group.rows.length, 0)
  if (count === 0) {
    return 'DEFINITION OF DONE'
  }
  return `DEFINITION OF DONE · ${count} ${count === 1 ? 'CHECK' : 'CHECKS'}`
}

/** The Definition of Done (per touched repository in a folder of repositories): the checks this node's worker must run and report, each by name. */
export function DefinitionOfDone(props: DefinitionProps & { runner: Runner }): JSX.Element {
  const state = useProject(props.runner)
  return (
    <section className="tp-section" aria-label="Definition of Done">
      <h3 className="ew-eyebrow">{definitionHeading(state.project, props)}</h3>
      <DefinitionBody state={state} detail={props.detail} bundle={props.bundle} />
    </section>
  )
}
