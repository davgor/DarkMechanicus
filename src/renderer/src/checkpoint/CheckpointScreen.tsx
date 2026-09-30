import '../epic/tones.css'
import './checkpoint.css'
import { useState } from 'react'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { CheckpointView, FollowUpProposal, RunView } from '../../../shared/domain/views'
import { Markdown } from '../markdown/Markdown'
import { gateView, reportView, type CriterionLine, type GateView, type ReportRow, type ReportSections } from './gateView'

export interface CheckpointScreenProps {
  checkpoint: CheckpointView
  run: RunView
  /** The plan the run executes (for keys, titles, goals and criteria text). */
  bundle: PlanBundle | null
  now: number
  busy: boolean
  onApprove(reportId: string): void
  onRetry(ticketId: string): void
  onAutoContinue(enabled: boolean): void
  onAddFollowUp(proposal: FollowUpProposal): Promise<boolean>
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
        {props.rows.map((row) => (
          <li key={row.key} className={props.failed ? 'cp-row is-failed' : 'cp-row'}>
            {row.ticketId === null ? (
              <span className="ew-mono cp-key">{row.key}</span>
            ) : (
              <button type="button" className="ew-link ew-mono cp-key" onClick={() => props.onSelect(row.ticketId ?? '')}>
                {row.key}
              </button>
            )}
            <span className="cp-row-title">{row.title}</span>
            {row.detail === '' ? null : <span className="ew-mono cp-row-detail">{row.detail}</span>}
          </li>
        ))}
      </ul>
    </section>
  )
}

function Criteria(props: { title: string; lines: CriterionLine[] }): JSX.Element | null {
  if (props.lines.length === 0) {
    return null
  }
  return (
    <section className="cp-section" aria-label={props.title}>
      <h3 className="ew-eyebrow">{props.title}</h3>
      <ul className="cp-checks">
        {props.lines.map((line) => (
          <li key={line.text} className={line.met ? 'is-passed' : 'is-failed'}>
            <span className="cp-icon" aria-label={line.met ? 'met' : 'not met'}>
              {line.met ? '✓' : '✗'}
            </span>
            <span>{line.text}</span>
            <span className="ew-muted">{line.note}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Checks({ report }: { report: ReportSections }): JSX.Element | null {
  if (report.checks.length === 0) {
    return null
  }
  return (
    <section className="cp-section" aria-label="Checks">
      <h3 className="ew-eyebrow">CHECKS</h3>
      <ul className="cp-checks">
        {report.checks.map((check) => (
          <li key={check.name} className={`is-${check.status}`}>
            <span className="cp-icon" aria-label={check.status}>
              {check.icon}
            </span>
            <span>{check.name}</span>
            <span className="ew-mono ew-muted">{check.detail}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function FollowUps(props: { proposals: FollowUpProposal[]; busy: boolean; onAdd(proposal: FollowUpProposal): Promise<boolean> }): JSX.Element | null {
  const [added, setAdded] = useState<string[]>([])
  if (props.proposals.length === 0) {
    return null
  }
  const add = async (proposal: FollowUpProposal): Promise<void> => {
    const ok = await props.onAdd(proposal)
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
          {added.includes(proposal.title) ? (
            <span className="ew-chip">Added to draft</span>
          ) : (
            <button type="button" className="btn" disabled={props.busy} onClick={() => void add(proposal)}>
              + Add to draft
            </button>
          )}
        </div>
      ))}
    </section>
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
  const report = reportView(source, { run: props.run, bundle: props.bundle, now: props.now })
  return (
    <article className="cp-report" aria-label="Sprint report">
      <span className="ew-eyebrow">{report.header}</span>
      <Markdown source={report.summary} className="cp-summary" />
      <Rows title="ACCEPTED" rows={report.accepted} failed={false} onSelect={props.onSelectTicket} />
      <Rows title="FAILED" rows={report.failed} failed onSelect={props.onSelectTicket} />
      <Checks report={report} />
      <Criteria title="EXIT CRITERIA" lines={report.exitCriteria} />
      <Criteria title="EPIC OUTCOME" lines={report.outcome?.criteria ?? []} />
      <FollowUps proposals={report.followUps} busy={props.busy} onAdd={props.onAddFollowUp} />
      {report.risks.length === 0 ? null : (
        <section className="cp-section" aria-label="Risks">
          <h3 className="ew-eyebrow">RISKS</h3>
          <ul className="cp-risks">
            {report.risks.map((risk) => (
              <li key={risk}>{risk}</li>
            ))}
          </ul>
        </section>
      )}
    </article>
  )
}

function GateActions(props: { gate: GateView; screen: CheckpointScreenProps }): JSX.Element {
  const { gate, screen } = props
  const reportId = screen.checkpoint.report?.id ?? ''
  return (
    <div className="cp-gate-actions">
      <button type="button" className="btn btn-primary" disabled={!gate.approveEnabled || screen.busy} onClick={() => screen.onApprove(reportId)}>
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

function Gate(props: CheckpointScreenProps): JSX.Element {
  const gate = gateView({ checkpoint: props.checkpoint, run: props.run, bundle: props.bundle })
  return (
    <aside className="cp-gate" aria-label="Checkpoint gate">
      <span className="ew-eyebrow">CHECKPOINT GATE</span>
      <h2 className="cp-gate-title">{gate.title}</h2>
      <ul className="cp-conditions">
        {gate.conditions.map((condition) => (
          <li key={condition.id} className={condition.met ? 'is-passed' : 'is-failed'}>
            <span className="cp-icon" aria-label={condition.met ? 'met' : 'not met'}>
              {condition.met ? '✓' : '✗'}
            </span>
            <span className="cp-condition-text">
              <span>{condition.label}</span>
              <span className="ew-muted">{condition.detail}</span>
            </span>
          </li>
        ))}
      </ul>
      <GateActions gate={gate} screen={props} />
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
