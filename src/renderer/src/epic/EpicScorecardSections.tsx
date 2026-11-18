/**
 * The sections of the epic Scorecard: original scope and outcomes, the per-sprint drill-down, total resources, the
 * failure causes that weigh most, and the comparisons that are compatible enough to show. Each shows the core's read
 * models as they are; a value the core has no number for reads "unavailable", never 0.
 */
import { useState } from 'react'
import type { RequiredOutcome } from '../../../shared/domain/spaceGrades'
import { ComponentBreakdown, type EvidenceOpener, Facts, GradeHeadline, ScoreError, Section } from '../scorecard/ScorecardParts'
import type { EpicCardView, EpicRunRead, EpicSprintRead, ReadPart, SprintAssessment } from '../scorecard/scoreReads'
import { summaryText } from '../scorecard/scorecardFormat'
import { outcomeText, ticketLabel, type TicketNames } from '../scorecard/outcomeLabels'
import {
  type Comparison,
  failureCauses,
  type GradedEpic,
  gradedSprint,
  outcomeConclusion,
  reassessmentComparison,
  resourceComparisons,
  runLabel,
  runTimingRows,
  runUsageRows,
  runUsages,
  type RunUsage,
  scopeRows,
  totalRows,
  wallRows
} from './epicScorecardView'

/** What every section reads beside its own data. */
export interface CardContext {
  card: EpicCardView
  names: TicketNames
  /** Opens a ticket of the plan shown; null when that plan does not hold it. */
  ticketAction(ticketId: string): (() => void) | null
  opener: EvidenceOpener
  onRetry(): void
}

/** A ticket (or a line about it) that opens the ticket when the plan shown holds it. */
function TicketLink({ ctx, ticketId, text }: { ctx: CardContext; ticketId: string; text?: string }): JSX.Element {
  const action = ctx.ticketAction(ticketId)
  const label = text ?? ticketLabel(ctx.names, ticketId)
  return action === null ? (
    <span>{label}</span>
  ) : (
    <button type="button" className="sc-link" onClick={action}>
      {label}
    </button>
  )
}

function OutcomeList({ ctx, outcomes }: { ctx: CardContext; outcomes: RequiredOutcome[] }): JSX.Element {
  return (
    <ul className="es-list" aria-label="Ticket outcomes">
      {outcomes.map((outcome) => (
        <li key={`${outcome.runId}:${outcome.ticketId}`}>
          <TicketLink ctx={ctx} ticketId={outcome.ticketId} />
          <span className="sc-note">
            {outcomeText(outcome, true)} · {runLabel(ctx.card, outcome.runId)}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** The scope frozen at dispatch, what of it was delivered, and why the outcome is what it is. */
function ScopeAndOutcomes({ ctx, graded }: { ctx: CardContext; graded: GradedEpic }): JSX.Element {
  return (
    <>
      <Facts label="Original scope" rows={scopeRows(graded)} />
      <p role="note" className={`es-conclusion is-${graded.grade.outcome}`}>
        {outcomeConclusion(graded, ctx.names)}
      </p>
      <OutcomeList ctx={ctx} outcomes={graded.outcomes} />
    </>
  )
}

export function OutcomeSection({ ctx, graded }: { ctx: CardContext; graded: GradedEpic }): JSX.Element {
  return (
    <Section title="ORIGINAL SCOPE AND OUTCOMES" label="Original scope and outcomes">
      <p className="sc-note">
        The scope committed before the first dispatch stays the denominator; scope added later is shown apart. Integrated outcomes (acceptance
        nodes and administrative tickets) and required tickets decide the epic: one confirmed failure fails it.
      </p>
      <ScopeAndOutcomes ctx={ctx} graded={graded} />
    </Section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Sprints

function sprintSummary(assessment: ReadPart<SprintAssessment>): string {
  if (!assessment.ok) return 'read failed'
  const value = assessment.value
  switch (value.state) {
    case 'frozen':
      return `${summaryText(value.view.grade)} · frozen with report revision ${value.report.reportRevision}`
    case 'live':
      return `${summaryText(value.view.grade)} · live, no report yet`
    case 'legacy':
      return 'ungraded · its report predates scorecards (legacy)'
    case 'not_reported':
      return 'not assessed · no report was submitted'
  }
}

function SprintDetail({ ctx, sprint }: { ctx: CardContext; sprint: EpicSprintRead }): JSX.Element {
  const assessment = sprint.assessment
  if (!assessment.ok) return <ScoreError error={assessment.error} onRetry={ctx.onRetry} />
  const graded = gradedSprint(assessment.value)
  if (assessment.value.state === 'legacy') return <p className="sc-note">{assessment.value.reason} No grade stands in for it.</p>
  if (graded === null) return <p className="sc-note">Nothing was assessed for this sprint.</p>
  return (
    <>
      <GradeHeadline grade={graded.grade} />
      <ScopeAndOutcomes ctx={ctx} graded={graded} />
      <ComponentBreakdown grade={graded.grade} opener={ctx.opener} />
    </>
  )
}

function SprintRow({ ctx, runId, sprint }: { ctx: CardContext; runId: string; sprint: EpicSprintRead }): JSX.Element {
  const [open, setOpen] = useState(false)
  const id = `es-sprint-${runId}-${sprint.sprintId}`
  return (
    <li>
      <button type="button" className="es-sprint-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen((held) => !held)}>
        <strong>
          Sprint {sprint.ordinal}
          {sprint.goal === '' ? '' : ` · ${sprint.goal}`}
        </strong>
        <span className="es-sprint-summary">{sprintSummary(sprint.assessment)}</span>
      </button>
      {open ? (
        <div id={id} className="es-sprint-detail" role="region" aria-label={`Sprint ${sprint.ordinal} of ${runLabel(ctx.card, runId)}`}>
          <SprintDetail ctx={ctx} sprint={sprint} />
        </div>
      ) : null}
    </li>
  )
}

function RunSprints({ ctx, runId, read }: { ctx: CardContext; runId: string; read: ReadPart<EpicRunRead> }): JSX.Element {
  return (
    <div className="es-run">
      <h4>
        <span title={runId}>{runLabel(ctx.card, runId)}</span>
        {read.ok ? ` · ${read.value.run.state.replaceAll('_', ' ')} · plan revision ${read.value.run.revisionNumber}` : ''}
      </h4>
      {read.ok ? (
        <ul className="es-sprints">
          {read.value.sprints.map((sprint) => (
            <SprintRow key={sprint.sprintId} ctx={ctx} runId={runId} sprint={sprint} />
          ))}
        </ul>
      ) : (
        <ScoreError error={read.error} onRetry={ctx.onRetry} />
      )}
    </div>
  )
}

/** Every sprint of every run the assessment covers, each opening to its own grade, scope and outcomes. */
export function SprintsSection({ ctx }: { ctx: CardContext }): JSX.Element {
  return (
    <Section title="SPRINTS" label="Sprints">
      <p className="sc-note">
        Each sprint is graded from its own measures; the epic grade is computed from the epic&apos;s raw measures, never by averaging these letters.
        Open a sprint for its grade, scope and outcomes.
      </p>
      {ctx.card.runs.length === 0 ? <p className="ew-muted">No run has executed this epic yet.</p> : null}
      {ctx.card.runs.map((entry) => (
        <RunSprints key={entry.runId} ctx={ctx} runId={entry.runId} read={entry.read} />
      ))}
    </Section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Resources

function RunResources({ ctx, read, usage }: { ctx: CardContext; read: ReadPart<EpicRunRead>; usage: RunUsage }): JSX.Element {
  const label = runLabel(ctx.card, usage.runId)
  return (
    <div className="es-run">
      <h4 title={usage.runId}>
        {label}
        {read.ok ? ` · ${read.value.run.state.replaceAll('_', ' ')}` : ''}
      </h4>
      {!read.ok ? <ScoreError error={read.error} onRetry={ctx.onRetry} /> : null}
      {read.ok && read.value.timing.ok ? <Facts label={`${label} timing`} rows={runTimingRows(read.value.run, read.value.timing.value)} /> : null}
      {read.ok && !read.value.timing.ok ? <ScoreError error={read.value.timing.error} onRetry={ctx.onRetry} /> : null}
      <Facts label={`${label} usage`} rows={runUsageRows(usage)} />
    </div>
  )
}

/** The epic's totals and each run's: every attempt (retried, abandoned, superseded) and all overhead included. */
export function ResourcesSection({ ctx, graded }: { ctx: CardContext; graded: GradedEpic | null }): JSX.Element {
  const usages = runUsages(ctx.card, graded)
  return (
    <Section title="TOTAL RESOURCES" label="Total resources">
      <p className="sc-note">
        Every attempt counts, including rejected, failed, cancelled, abandoned and superseded ones, and so does administrative and overhead work
        (orchestration, review, acceptance nodes and administrative tickets), in every run, also one that executed no work. A run without a
        number is named and the total reads as a lower bound. Wall time is the union of the run windows, never a sum of parallel time; effort adds
        up every actor&apos;s activity and can exceed it.
      </p>
      {graded === null ? <p className="sc-note">No graded totals: nothing was frozen for this epic.</p> : <Facts label="Epic totals" rows={totalRows(ctx.card, graded)} />}
      <Facts label="Wall time" rows={wallRows(ctx.card)} />
      {/* runUsages maps card.runs one to one, so every run has its usage at its own index. */}
      {ctx.card.runs.map((entry, index) => (
        <RunResources key={entry.runId} ctx={ctx} read={entry.read} usage={usages[index]} />
      ))}
    </Section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Failure causes and comparisons

export function FailureSection({ ctx, graded }: { ctx: CardContext; graded: GradedEpic }): JSX.Element {
  const causes = failureCauses(graded, ctx.names)
  return (
    <Section title="HIGH-IMPACT FAILURE CAUSES" label="High-impact failure causes">
      {causes.length === 0 ? <p className="sc-note">No failed or unverified counted outcome, rejected submission or corrective effort recorded.</p> : null}
      <ul className="es-list">
        {causes.map((cause) => (
          <li key={cause.text}>{cause.ticketId === null ? <span>{cause.text}</span> : <TicketLink ctx={ctx} ticketId={cause.ticketId} text={cause.text} />}</li>
        ))}
      </ul>
    </Section>
  )
}

function ComparisonItem({ comparison }: { comparison: Comparison }): JSX.Element {
  return (
    <li>
      <span className={`ew-chip es-chip ${comparison.comparable ? 'is-comparable' : 'is-not-compared'}`}>{comparison.comparable ? 'Comparable' : 'Not compared'}</span>
      <strong>{comparison.label}</strong>
      <span>{comparison.text}</span>
    </li>
  )
}

function noReassessment(card: EpicCardView): string {
  switch (card.assessment.state) {
    case 'live':
      return 'No frozen epic grade yet: it freezes with the final sprint’s report, and only then can the records be compared with it.'
    case 'legacy':
      return 'The final report predates scorecards: there is no frozen grade to compare.'
    default:
      return 'No epic grade was frozen, so there is nothing to compare.'
  }
}

function Reassessment({ ctx }: { ctx: CardContext }): JSX.Element {
  const read = ctx.card.reassessment
  if (read === null) return <p className="sc-note">{noReassessment(ctx.card)}</p>
  if (!read.ok) return <ScoreError error={read.error} onRetry={ctx.onRetry} />
  const subject = read.value.subject
  if (subject === null) return <p className="sc-note">The reassessment holds no epic grade.</p>
  const comparison = reassessmentComparison(subject)
  return (
    <>
      <ul className="es-list">
        <ComparisonItem comparison={comparison} />
      </ul>
      {comparison.comparable && subject.differences.length > 0 ? (
        <ul className="sc-deductions" aria-label="Differences">
          {subject.differences.map((difference) => (
            <li key={difference.component}>
              <span className="ew-mono">{difference.component}</span> {difference.detail} ({difference.causes.map((cause) => cause.replaceAll('_', ' ')).join(', ')})
            </li>
          ))}
        </ul>
      ) : null}
    </>
  )
}

/** Comparisons shown only between compatible readings: complete roll-ups, comparable windows, one policy. */
export function ComparisonsSection({ ctx, graded }: { ctx: CardContext; graded: GradedEpic | null }): JSX.Element {
  return (
    <Section title="COMPARISONS" label="Comparisons">
      <p className="sc-note">
        A comparison is shown only between compatible readings: T and K against a complete roll-up of the baselines the epic&apos;s own ticket
        grades accepted (budgets, or cohorts of comparable prior tickets), and the frozen grade against the records now only over comparable
        observation windows under the same policy. Otherwise it says why not.
      </p>
      {graded === null ? null : (
        <ul className="es-list" aria-label="Resource comparisons">
          {resourceComparisons(graded, ctx.names).map((comparison) => (
            <ComparisonItem key={comparison.label} comparison={comparison} />
          ))}
        </ul>
      )}
      <Reassessment ctx={ctx} />
    </Section>
  )
}
