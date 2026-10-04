import '../epic/tones.css'
import './checkpoint.css'
import { useState } from 'react'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { CheckpointView, FollowUpProposal, PlanView, RunView } from '../../../shared/domain/views'
import { Markdown } from '../markdown/Markdown'
import {
  gateView,
  reportView,
  type CriterionLine,
  type GateRow,
  type GateView,
  type IncrementSection,
  type NextSprintItem,
  type ReportCheck,
  type ReportRow,
  type ReportSections
} from './gateView'
import { RedraftSection, RefusalAlert } from './RedraftSection'
import { redraftPanel, type RedraftRefusal } from './redraftView'
import { Retro, type NextSprintActions } from './RetroSections'
import { TicketKey } from './TicketKey'

export interface CheckpointScreenProps {
  checkpoint: CheckpointView
  run: RunView
  /** The plan the run executes (for keys, titles, goals and criteria text). */
  bundle: PlanBundle | null
  /** The epic's draft; when it holds changes they are the redraft this checkpoint approves with the retro. */
  draft: PlanView | null
  now: number
  busy: boolean
  onApprove(reportId: string): void
  /** Approves the report together with the redraft; resolves with what refused it, or null when it went through. */
  onApproveWithRedraft(reportId: string, expectedDraftRevision: number): Promise<RedraftRefusal | null>
  onRetry(ticketId: string): void
  onAutoContinue(enabled: boolean): void
  /** Puts a follow-up, a retro discovery or a retro leftover into the draft's next sprint. */
  onAddFollowUp(item: NextSprintItem): Promise<boolean>
  onEditDraft(): void
  onSelectTicket(ticketId: string): void
}

function Rows(props: { title: string; rows: ReportRow[]; failed: boolean; onSelect(ticketId: string): void }): JSX.Element | null {
  if (props.rows.length === 0) {
    return null
  }
  return (
    <section className="cp-section" aria-label={props.title}>
      <h3 className="ew-eyebrow">
        {props.title} · {props.rows.length}
      </h3>
      <ul className="cp-rows">
        {props.rows.map((row, index) => (
          // Entries can share a ticket key or have none, so the position identifies the row.
          <li key={`${index}:${row.key}`} className={props.failed ? 'cp-row is-failed' : 'cp-row'}>
            <TicketKey ticket={row} onSelect={props.onSelect} />
            <span className={row.key === '' ? 'cp-row-title is-keyless' : 'cp-row-title'}>{row.title}</span>
            {row.detail === '' ? null : <span className="ew-mono cp-row-detail">{row.detail}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

function CriteriaList({ lines }: { lines: CriterionLine[] }): JSX.Element | null {
  if (lines.length === 0) {
    return null
  }
  return (
    <ul className="cp-checks">
      {lines.map((line) => (
        <li key={line.text} className={line.met ? 'is-passed' : 'is-failed'}>
          <span className="cp-icon" aria-label={line.met ? 'met' : 'not met'}>
            {line.met ? '✓' : '✗'}
          </span>
          <span className="cp-check-name">{line.text}</span>
          <span className="ew-muted">{line.note}</span>
        </li>
      ))}
    </ul>
  )
}

function Criteria(props: { title: string; lines: CriterionLine[] }): JSX.Element | null {
  if (props.lines.length === 0) {
    return null
  }
  return (
    <section className="cp-section" aria-label={props.title}>
      <h3 className="ew-eyebrow">{props.title}</h3>
      <CriteriaList lines={props.lines} />
    </section>
  )
}

/** The epic outcome a final-sprint report proposes: its summary above the success criteria it reached. */
function EpicOutcome({ outcome }: { outcome: ReportSections['outcome'] }): JSX.Element | null {
  if (outcome === null || (outcome.summary.trim() === '' && outcome.criteria.length === 0)) {
    return null
  }
  return (
    <section className="cp-section" aria-label="EPIC OUTCOME">
      <h3 className="ew-eyebrow">EPIC OUTCOME</h3>
      {outcome.summary.trim() === '' ? null : <Markdown source={outcome.summary} className="cp-summary" />}
      <CriteriaList lines={outcome.criteria} />
    </section>
  )
}

function CheckList(props: { label?: string; checks: ReportCheck[] }): JSX.Element {
  return (
    <ul className="cp-checks" aria-label={props.label}>
      {props.checks.map((check, index) => (
        // Two checks can share a name, so the position identifies the entry.
        <li key={`${index}:${check.name}`} className={`is-${check.status}`}>
          <span className="cp-icon" aria-label={check.status}>
            {check.icon}
          </span>
          <span className="cp-check-name">{check.name}</span>
          <span className="ew-mono ew-muted">{check.detail}</span>
        </li>
      ))}
    </ul>
  )
}

function Checks({ report }: { report: ReportSections }): JSX.Element | null {
  if (report.checks.length === 0) {
    return null
  }
  return (
    <section className="cp-section" aria-label="Checks">
      <h3 className="ew-eyebrow">CHECKS</h3>
      <CheckList checks={report.checks} />
    </section>
  )
}

/** Why an increment did not pass, one failed line per reason. */
function IncrementReasons({ reasons }: { reasons: string[] }): JSX.Element | null {
  if (reasons.length === 0) {
    return null
  }
  return (
    <ul className="cp-checks" aria-label="Increment problems">
      {reasons.map((reason, index) => (
        <li key={`${index}:${reason}`} className="is-failed">
          <span className="cp-icon" aria-label="not met">
            ✗
          </span>
          <span className="cp-check-name">{reason}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The commit that landed the sprint on the epic branch and what the server checked about it: the same rows as the
 * changes below, then the checks and, if it did not pass, the reasons.
 */
function Increment({ increment }: { increment: IncrementSection | null }): JSX.Element | null {
  if (increment === null) {
    return null
  }
  return (
    <section className="cp-section" aria-label="INCREMENT">
      <h3 className="ew-eyebrow">{increment.heading}</h3>
      <ul className="cp-rows">
        <li className={increment.passed ? 'cp-row' : 'cp-row is-failed'}>
          <span className="ew-mono cp-key">commit</span>
          <span className="ew-mono cp-row-title" title={increment.fullCommit}>
            {increment.commit}
          </span>
          <span className="ew-mono cp-row-detail">
            {increment.passed ? '✓' : '✗'} {increment.verdict}
          </span>
        </li>
        <li className="cp-row">
          <span className="ew-mono cp-key">branch</span>
          <span className="ew-mono cp-row-title">{increment.branch}</span>
        </li>
        <li className="cp-row">
          <span className="ew-mono cp-key">after</span>
          <span className="ew-mono cp-row-title">{increment.base}</span>
        </li>
      </ul>
      <IncrementReasons reasons={increment.reasons} />
      {increment.checks.length === 0 ? null : <CheckList label="Increment checks" checks={increment.checks} />}
    </section>
  )
}

function FollowUpAction(props: { added: boolean; busy: boolean; onAdd(): void }): JSX.Element {
  return props.added ? (
    <span className="ew-chip">Added to draft</span>
  ) : (
    <button type="button" className="btn" disabled={props.busy} onClick={props.onAdd}>
      + Add to draft
    </button>
  )
}

/** "+ Add to draft" on proposed follow-ups; a report without actions lists them read-only. */
function FollowUps(props: { proposals: FollowUpProposal[]; adder: NextSprintActions | undefined }): JSX.Element | null {
  const [added, setAdded] = useState<string[]>([])
  const adder = props.adder
  if (props.proposals.length === 0) {
    return null
  }
  const add = async (target: NextSprintActions, proposal: FollowUpProposal): Promise<void> => {
    const ok = await target.onAdd(proposal)
    setAdded((current) => (ok ? [...current, proposal.title] : current))
  }
  return (
    <section className="cp-section" aria-label="Proposed follow-ups">
      <h3 className="ew-eyebrow">PROPOSED FOLLOW-UPS</h3>
      {props.proposals.map((proposal) => (
        <div key={proposal.title} className="cp-followup">
          <span className="cp-followup-text">
            <span>{proposal.title}</span>
            <span className="ew-muted">{proposal.body}</span>
          </span>
          {adder === undefined ? null : (
            <FollowUpAction added={added.includes(proposal.title)} busy={adder.busy} onAdd={() => void add(adder, proposal)} />
          )}
        </div>
      ))}
    </section>
  )
}

function Risks({ risks }: { risks: string[] }): JSX.Element | null {
  if (risks.length === 0) {
    return null
  }
  return (
    <section className="cp-section" aria-label="Risks">
      <h3 className="ew-eyebrow">RISKS</h3>
      <ul className="cp-risks">
        {risks.map((risk) => (
          <li key={risk}>{risk}</li>
        ))}
      </ul>
    </section>
  )
}

interface SprintReportProps {
  label: string
  report: ReportSections
  /**
   * Offers "+ Add to draft" on proposed follow-ups, "+ Add to next sprint" on the retro's discoveries and
   * "Move to next sprint" on its leftovers; without it the report is read-only.
   */
  followUps?: NextSprintActions
  onSelectTicket(ticketId: string): void
}

/** The files and commits the sprint changed, one row each in the same layout as the ticket rows. */
function Changes(props: { changes: ReportSections['changes'] }): JSX.Element | null {
  const rows = [
    ...props.changes.files.map((text) => ({ kind: 'file', text })),
    ...props.changes.commits.map((text) => ({ kind: 'commit', text }))
  ]
  if (rows.length === 0) {
    return null
  }
  return (
    <section className="cp-section" aria-label="Changes">
      <h3 className="ew-eyebrow">CHANGES</h3>
      <ul className="cp-rows">
        {rows.map((row, index) => (
          <li key={`${index}:${row.kind}`} className="cp-row">
            <span className="ew-mono cp-key">{row.kind}</span>
            <span className="ew-mono cp-row-title">{row.text}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** One sprint report, shared by the checkpoint review and the completed epic's overview. */
export function SprintReport(props: SprintReportProps): JSX.Element {
  const { report } = props
  return (
    <article className="cp-report" aria-label={props.label}>
      <span className="ew-eyebrow">{report.header}</span>
      <Markdown source={report.summary} className="cp-summary" />
      <Retro retro={report.retro} actions={props.followUps} onSelectTicket={props.onSelectTicket} />
      <Rows title="ACCEPTED" rows={report.accepted} failed={false} onSelect={props.onSelectTicket} />
      <Rows title="FAILED" rows={report.failed} failed onSelect={props.onSelectTicket} />
      <Rows title="BLOCKED" rows={report.blocked} failed={false} onSelect={props.onSelectTicket} />
      <Increment increment={report.increment} />
      <Changes changes={report.changes} />
      <Checks report={report} />
      <Criteria title="EXIT CRITERIA" lines={report.exitCriteria} />
      <EpicOutcome outcome={report.outcome} />
      <FollowUps proposals={report.followUps} adder={props.followUps} />
      <Risks risks={report.risks} />
    </article>
  )
}

function Report(props: CheckpointScreenProps): JSX.Element {
  const source = props.checkpoint.report
  if (source === null) {
    return (
      <article className="cp-report" aria-label="Sprint report">
        <p className="ew-muted">No sprint report yet. The orchestrator writes it when the sprint&apos;s required work is done.</p>
      </article>
    )
  }
  return (
    <SprintReport
      label="Sprint report"
      report={reportView(source, { run: props.run, bundle: props.bundle, now: props.now })}
      followUps={{
        busy: props.busy,
        draft: props.draft?.bundle ?? null,
        checkpointOrdinal: props.checkpoint.sprintOrdinal,
        onAdd: props.onAddFollowUp
      }}
      onSelectTicket={props.onSelectTicket}
    />
  )
}

function GateActions(props: { gate: GateView; screen: CheckpointScreenProps; onApprove(): void }): JSX.Element {
  const { gate, screen } = props
  return (
    <div className="cp-gate-actions">
      <button type="button" className="btn btn-primary" disabled={!gate.approveEnabled || screen.busy} onClick={props.onApprove}>
        {gate.approveLabel}
      </button>
      {gate.blockedNote === null ? null : <p className="ew-muted">{gate.blockedNote}</p>}
      {gate.retries.map((retry) => (
        <button key={retry.ticketId} type="button" className="btn" disabled={screen.busy} onClick={() => screen.onRetry(retry.ticketId)}>
          {retry.label}
        </button>
      ))}
      <button type="button" className="btn btn-ghost" onClick={screen.onEditDraft}>
        Edit draft to change the gate
      </button>
    </div>
  )
}

/** How a gate row looks: the plan gate shows as met by the approval while a redraft waits for it. */
function conditionLook(condition: GateRow): { className: string; icon: string; label: string } {
  if (condition.resolvedByApproval === true) {
    return { className: 'is-pending', icon: '→', label: 'met by approving' }
  }
  return condition.met
    ? { className: 'is-passed', icon: '✓', label: 'met' }
    : { className: 'is-failed', icon: '✗', label: 'not met' }
}

function Conditions({ conditions }: { conditions: GateRow[] }): JSX.Element {
  return (
    <ul className="cp-conditions">
      {conditions.map((condition) => {
        const look = conditionLook(condition)
        return (
          <li key={condition.id} className={look.className}>
            <span className="cp-icon" aria-label={look.label}>
              {look.icon}
            </span>
            <span className="cp-condition-text">
              <span>{condition.label}</span>
              <span className="ew-muted">{condition.detail}</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function Gate(props: CheckpointScreenProps): JSX.Element {
  const panel = redraftPanel(props.draft, props.run, props.checkpoint.sprintId)
  const gate = gateView({ checkpoint: props.checkpoint, run: props.run, bundle: props.bundle, redraft: panel })
  const [refusal, setRefusal] = useState<RedraftRefusal | null>(null)
  const reportId = props.checkpoint.report?.id ?? ''
  const approve = (): void => {
    if (panel === null) {
      props.onApprove(reportId)
      return
    }
    setRefusal(null)
    void props.onApproveWithRedraft(reportId, panel.draftRevision).then(setRefusal)
  }
  return (
    <aside className="cp-gate" aria-label="Checkpoint gate">
      <span className="ew-eyebrow">CHECKPOINT GATE</span>
      <h2 className="cp-gate-title">{gate.title}</h2>
      <Conditions conditions={gate.conditions} />
      {panel === null ? null : <RedraftSection panel={panel} />}
      {refusal === null ? null : <RefusalAlert refusal={refusal} onDismiss={() => setRefusal(null)} />}
      <GateActions gate={gate} screen={props} onApprove={approve} />
      <label className="cp-auto">
        <input
          type="checkbox"
          checked={gate.autoContinue.checked}
          disabled={!gate.autoContinue.available || props.busy}
          onChange={(event) => props.onAutoContinue(event.target.checked)}
        />
        <span>
          <span>Allow automatic continuation for this run</span>
          <span className="ew-muted">{gate.autoContinue.note}</span>
        </span>
      </label>
    </aside>
  )
}

/** Sprint report and checkpoint gate, shown instead of the graph while a checkpoint is reviewed. */
export function CheckpointScreen(props: CheckpointScreenProps): JSX.Element {
  return (
    <div className="cp" aria-label="Sprint checkpoint">
      <Report {...props} />
      <Gate {...props} />
    </div>
  )
}
