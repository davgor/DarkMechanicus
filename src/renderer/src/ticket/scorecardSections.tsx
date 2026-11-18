/**
 * The ticket-specific sections of the Scorecard tab: usage and time with their attribution, the attempts, corrections,
 * a person's feedback with its provenance, and the frozen report grade beside its reassessment. Each shows the core's
 * read model as it is; a value the core has no number for reads "unavailable", never 0.
 */
import type { ReactNode } from 'react'
import { WAIT_CLASSES, type TicketTiming, type TimingQuantity } from '../../../shared/domain/timing'
import type { CollaborationDeduction, HumanFeedbackEntry } from '../../../shared/domain/spaceSignals'
import type { TicketGradeView } from '../../../shared/domain/spaceGrades'
import type { AttemptUsageView } from '../../../shared/domain/metrics'
import { ACTIVITY_LABELS, CAUSE_LABELS, INTERVENTION_LABELS, minutesText, ticketSatisfactionText } from '../scorecard/feedbackForm'
import { type EvidenceOpener, EvidenceList, type FactRow as Row, Facts, ScoreError, Section } from '../scorecard/ScorecardParts'
import type { ReadPart, TicketReportRead } from '../scorecard/scoreReads'
import { durationText, localTime, measurementText, provenanceText, quantityText, summaryText, usageCellText, windowsText } from '../scorecard/scorecardFormat'

const WAIT_LABELS = { queue: 'Queue', build_test: 'Build and test', blocked: 'Blocked', review: 'Review', human_approval: 'Human approval' } as const

function usageRows(grade: TicketGradeView): Row[] {
  const { tokens, time } = grade.sources.efficiency
  return [
    { label: 'Tokens (K)', value: measurementText(tokens.actual, 'tokens') },
    { label: 'Tokens reported so far', value: tokens.reportedValue === null ? 'unavailable (nothing reported)' : measurementText({ state: 'observed', value: tokens.reportedValue }, 'tokens') },
    { label: 'Active time (T)', value: measurementText(time.actual, 'milliseconds') },
    { label: 'Active time by others', value: time.overheadValue === null ? 'unavailable (no review or orchestration span reported)' : durationText(time.overheadValue) },
    { label: 'Attempts that reported nothing', value: tokens.unreportedAttemptIds.join(', ') || 'none' },
    { label: 'Attempts still open', value: tokens.openAttemptIds.join(', ') || 'none' }
  ]
}

function timingRows(timing: TicketTiming): Row[] {
  // A role with no span reported reads as absent, not as 0: overhead has its own quantity (missing when unreported).
  const reporting = Object.entries(timing.effort.byRole).filter(([, ms]) => ms > 0)
  const byRole = reporting.length === 0 ? 'unavailable' : reporting.map(([role, ms]) => `${role} ${durationText(ms)}`).join(' · ')
  return [
    { label: 'Cycle time (first claim → end)', value: quantityText(timing.cycleTime) },
    { label: 'Lead time (ready → end)', value: quantityText(timing.leadTime) },
    { label: 'Measured active (worker, union)', value: quantityText(timing.active) },
    { label: 'Waiting before dispatch', value: quantityText(timing.waitBeforeDispatch) },
    ...WAIT_CLASSES.map((wait) => ({ label: `Wait: ${WAIT_LABELS[wait]}`, value: quantityText(timing.waits[wait]) })),
    { label: 'Unclassified time', value: quantityText(timing.unknown) },
    { label: 'Effort (all actors, summed)', value: quantityText(timing.effort.total) },
    { label: 'Effort by role (roles that reported)', value: byRole },
    { label: 'Effort by others (overhead)', value: quantityText(timing.effort.overhead) }
  ]
}

/** Tokens and active time as the grade read them, then elapsed, wait and effort time from the run's timing. */
export function UsageAndTime(props: { grade: TicketGradeView; runLabel: string; timing: ReadPart<TicketTiming>; onRetry(): void }): JSX.Element {
  const { grade, timing, onRetry } = props
  return (
    <Section title="USAGE AND TIME" label="Usage and time">
      <p className="sc-note">
        Attributed to this ticket&apos;s attempts in <span title={grade.runId}>{props.runLabel}</span> through the host&apos;s session links and the
        agents&apos; own reports; run overhead (orchestration, review) belongs to the run&apos;s scorecard. Waits are shown, never counted as active.
      </p>
      <Facts label="Usage" rows={usageRows(grade)} />
      {timing.ok ? <Facts label="Time" rows={timingRows(timing.value)} /> : <ScoreError error={timing.error} onRetry={onRetry} />}
    </Section>
  )
}

interface AttemptRowData {
  attemptId: string
  heading: string
  facts: string[]
}

interface AttemptSources {
  grade: TicketGradeView
  timing: ReadPart<TicketTiming>
  usage: ReadPart<AttemptUsageView[]>
  /** When the composed read ran: per-attempt usage is the run's usage table as of then, not as of the grade's cutoff. */
  readAt: number
}

function attemptRows({ grade, timing, usage }: AttemptSources): AttemptRowData[] {
  const timed = new Map(timing.ok ? timing.value.attempts.map((attempt) => [attempt.attemptId, attempt]) : [])
  const used = new Map(usage.ok ? usage.value.map((attempt) => [attempt.attemptId, attempt]) : [])
  // A failed read and a value the read holds no number for are both unavailable; the failure itself is shown once.
  const timeText = (quantity: TimingQuantity | undefined): string => (quantity === undefined ? 'unavailable' : quantityText(quantity))
  return grade.sources.efficiency.classification.retries.attempts.map((attempt) => {
    const time = timed.get(attempt.attemptId)
    const tokens = used.get(attempt.attemptId)?.usage.find((cell) => cell.metric === 'tokens_total')
    const tokenText = !usage.ok ? 'read failed' : tokens === undefined ? 'unavailable' : usageCellText(tokens)
    return {
      attemptId: attempt.attemptId,
      heading: `#${attempt.number} · ${attempt.outcome.replaceAll('_', ' ')}${attempt.superseded ? ' · superseded' : ''}`,
      facts: [
        `elapsed ${timeText(time?.elapsed)}`,
        `active ${timeText(time?.active)}`,
        `effort ${attempt.effortMs === null ? 'unavailable' : durationText(attempt.effortMs)}`,
        `tokens ${tokenText}`
      ]
    }
  })
}

/** Every attempt of the ticket that ran in this run, with its own time and tokens, each opening its attempt card. */
export function AttemptsSection(props: AttemptSources & { opener: EvidenceOpener; onRetry(): void }): JSX.Element {
  const rows = attemptRows(props)
  const retries = props.grade.sources.efficiency.classification.retries.retries
  return (
    <Section title={`ATTEMPTS IN THIS RUN (${rows.length})`} label="Attempts in this run">
      {rows.length === 0 ? <p className="ew-muted">No attempt of this ticket ran in this run yet.</p> : null}
      <ul className="sc-attempts">
        {rows.map((row) => (
          <li key={row.attemptId}>
            <button type="button" className="sc-link" onClick={() => props.opener.open({ kind: 'attempt', id: row.attemptId, detail: null })}>
              Attempt {row.heading}
            </button>
            <span className="sc-note">{row.facts.join(' · ')}</span>
          </li>
        ))}
      </ul>
      <p className="sc-note">Retries: {retries === null ? 'unavailable' : retries} (a diagnostic, never scored as waste).</p>
      {props.usage.ok ? <p className="sc-note">Tokens as of {localTime(props.readAt)}, from the run&apos;s usage table when this was read.</p> : null}
      {props.timing.ok ? null : <p className="sc-note">Elapsed and active time per attempt are unavailable: the timing read failed (see Usage and time).</p>}
      {props.usage.ok ? null : <ScoreError error={props.usage.error} onRetry={props.onRetry} />}
    </Section>
  )
}

function deductionText(deduction: CollaborationDeduction): string {
  switch (deduction.kind) {
    case 'failed_handoff_check':
      return `Handoff check ${deduction.check} failed: missing ${deduction.missing.join(', ')}${deduction.missingCount > deduction.missing.length ? ` and ${deduction.missingCount - deduction.missing.length} more` : ''}`
    case 'coordination_defect':
      return `${deduction.count} coordination defect(s)${deduction.reportedBy === null ? '' : ` reported by ${deduction.reportedBy}`}`
    case 'rejected_submission':
      return `Submission rejected by ${deduction.decidedBy} at ${localTime(deduction.decidedAt)} (${deduction.checks} check(s) count failed)`
  }
}

const NO_EFFORT = 'unavailable (no effort reported)'

function correctiveRows(grade: TicketGradeView): Row[] {
  const classification = grade.sources.efficiency.classification
  const S = grade.sources.signals.S
  // With no effort measured and no classification record, every split is unknown: never a 0.
  const nothing = classification.denominator.state === 'missing' && classification.observationIds.length === 0
  const ms = (value: number | null): string => (nothing ? NO_EFFORT : value === null ? 'unavailable' : durationText(value))
  const causes = Object.entries(classification.correctiveByCause).map(([cause, value]) => `${cause} ${durationText(value)}`)
  const timeRow = (entries: HumanFeedbackEntry[], minutes: number): string => {
    if (entries.length === 0) {
      return 'none recorded'
    }
    const without = entries.filter((entry) => entry.value === null).length
    return `${entries.length} recorded, ${minutes} min given${without === 0 ? '' : ` (${without} without minutes, not counted as 0)`}`
  }
  return [
    { label: 'Corrective effort (E, as classified)', value: ms(classification.correctiveMs) },
    { label: 'Corrective by cause', value: nothing ? NO_EFFORT : causes.length === 0 ? 'none classified' : causes.join(' · ') },
    { label: 'Productive effort (as classified)', value: ms(classification.productiveMs) },
    { label: 'Unclassified effort', value: ms(classification.unclassifiedMs) },
    { label: 'Rescue by a person', value: timeRow(S.rescue, S.rescueMinutes) },
    { label: 'Planned review or playtesting', value: timeRow(S.plannedReview, S.plannedReviewMinutes) }
  ]
}

/** Corrective work: the corrective share's inputs, every collaboration deduction with its records, rescue time. */
export function CorrectionsSection({ grade, opener }: { grade: TicketGradeView; opener: EvidenceOpener }): JSX.Element {
  const deductions = grade.sources.signals.C.deductions
  return (
    <Section title="CORRECTIONS" label="Corrections">
      <Facts label="Corrective effort" rows={correctiveRows(grade)} />
      {deductions.length === 0 ? <p className="sc-note">No handoff failure, rejected submission or coordination defect recorded.</p> : null}
      <ul className="sc-deductions">
        {deductions.map((deduction) => (
          <li key={`${deduction.kind}:${'observationId' in deduction ? deduction.observationId : deduction.attemptId}`}>
            <span>{deductionText(deduction)}</span>
            <EvidenceList refs={deduction.evidence} opener={opener} />
          </li>
        ))}
      </ul>
    </Section>
  )
}

function entryText(entry: HumanFeedbackEntry): string {
  if (entry.activity !== null) {
    return `${ACTIVITY_LABELS[entry.activity]} · ${minutesText(entry.value)}`
  }
  if (entry.intervention !== null) {
    const reason = entry.cause === null ? 'no reason given' : CAUSE_LABELS[entry.cause]
    return `Rescue · ${INTERVENTION_LABELS[entry.intervention]} · ${reason} · ${minutesText(entry.value)}`
  }
  const whose = entry.scope.level === 'sprint' ? `Sprint rating${entry.sharedWithTickets === true ? ', shared with its tickets' : ', not shared'}` : 'Ticket rating'
  return `${whose}: ${entry.value ?? '—'} of 5`
}

function FeedbackItem({ entry }: { entry: HumanFeedbackEntry }): JSX.Element {
  return (
    <li>
      <span>
        {entryText(entry)} · by {entry.person} at {localTime(entry.recordedAt)}
      </span>
      <span className="sc-note">Recorded by: {provenanceText(entry.recordedBy)}</span>
    </li>
  )
}

/**
 * What people said about the ticket: how its S stands (its own rating, the sprint's it inherits, or none, never a
 * made-up one), every rating, rescue and planned review entry with where it was recorded (provenance, not
 * verification), and the person's own optional inputs (`children`).
 */
export function FeedbackSection({ grade, children }: { grade: TicketGradeView; children?: ReactNode }): JSX.Element {
  const S = grade.sources.signals.S
  const entries = [...S.ratings, ...S.rescue, ...S.plannedReview]
  return (
    <Section title="PEOPLE'S FEEDBACK" label="People's feedback">
      <p className="sc-note">{ticketSatisfactionText(S)}</p>
      {entries.length === 0 ? <p className="sc-note">No rating, rescue or planned review recorded for this ticket.</p> : null}
      <ul className="sc-feedback">
        {entries.map((entry) => (
          <FeedbackItem key={entry.observationId} entry={entry} />
        ))}
      </ul>
      {children}
    </Section>
  )
}

function ReportBody({ report }: { report: Extract<TicketReportRead, { state: 'reassessed' }> }): JSX.Element {
  const subject = report.subject
  if (report.reassessment.legacy || subject === null) {
    return (
      <p className="sc-note">
        {report.reassessment.legacy ? 'This report predates scorecards: it stays ungraded, so there is no original grade to compare.' : 'This report froze no grade for this ticket.'}
      </p>
    )
  }
  const rows: Row[] = [
    { label: `Original (frozen ${localTime(subject.windows.approved.to)})`, value: summaryText(subject.approved) },
    { label: 'Same window, regraded now', value: summaryText(subject.sameWindow) },
    { label: `Reassessed (${localTime(report.reassessment.assessedAt)})`, value: summaryText(subject.current) },
    { label: 'Membership', value: subject.membership },
    { label: 'Windows', value: windowsText(subject.windows) }
  ]
  return (
    <>
      <Facts label="Original and reassessed grades" rows={rows} />
      <ul className="sc-deductions" aria-label="Differences">
        {subject.differences.map((difference) => (
          <li key={difference.component}>
            <span className="ew-mono">{difference.component}</span> {difference.detail} ({difference.causes.map((cause) => cause.replaceAll('_', ' ')).join(', ')})
          </li>
        ))}
      </ul>
    </>
  )
}

/** The grade frozen into this sprint's report beside the same scope reassessed now, or why there is none. */
export function ReportSection({ report, onRetry }: { report: ReadPart<TicketReportRead>; onRetry(): void }): JSX.Element {
  const title = report.ok && report.value.state === 'reassessed' ? `ORIGINAL AND REASSESSED · REPORT REVISION ${report.value.reportRevision}` : 'ORIGINAL AND REASSESSED'
  return (
    <Section title={title} label="Original and reassessed grades">
      {!report.ok ? <ScoreError error={report.error} onRetry={onRetry} /> : null}
      {report.ok && report.value.state === 'none' ? (
        <p className="sc-note">No sprint report for this ticket&apos;s sprint in this run yet: the grade above is live, and nothing has been frozen.</p>
      ) : null}
      {report.ok && report.value.state === 'reassessed' ? <ReportBody report={report.value} /> : null}
    </Section>
  )
}
