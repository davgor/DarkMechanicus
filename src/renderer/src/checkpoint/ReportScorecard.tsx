/**
 * A sprint report's Scorecard tab, shared by the checkpoint review and a completed epic's history. A report revision
 * shows the scorecard frozen with it, pinned to that revision: approved, awaiting approval or historical, and never
 * replaced by a live grade. A sprint without a report shows its live, provisional grade. A later reassessment is a
 * separate, dated reading below the snapshot, with its own policy and the cause of every difference. Everything shown
 * is the core's read model; nothing here grades.
 */
import { useState } from 'react'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { ReportIdentity } from '../../../shared/domain/scoreReads'
import type { EvidenceRef } from '../../../shared/domain/space'
import type { ScorecardReassessment, SubjectReassessment } from '../../../shared/domain/spaceGrades'
import type { RunView } from '../../../shared/domain/views'
import type { Scheduler } from '../app/scheduler'
import { StateLabel, StatePill } from '../epic/StatePill'
import { ComponentBreakdown, type EvidenceOpener, Facts, Freshness, GradeHeadline, ScoreError, ScoreReadNotice, Section } from '../scorecard/ScorecardParts'
import type { ReportCardView } from '../scorecard/scoreReads'
import { localTime, shortHash, summaryText } from '../scorecard/scorecardFormat'
import { useScoreRead } from '../scorecard/useScoreRead'
import { outcomeText, type TicketNames } from '../scorecard/outcomeLabels'
import { GradingPolicyDetails } from '../scorecard/GradingPolicy'
import { SprintFeedback } from './SprintFeedback'
import {
  coverageRows,
  differenceText,
  failureCauses,
  identityRows,
  levelRows,
  modeView,
  orderedSubjects,
  OUTCOME_TONES,
  outcomeConclusion,
  overheadRows,
  resourceRows,
  type ScorecardTarget,
  type SprintCard,
  sprintCard,
  subjectLabel,
  subjectRows,
  ticketFacts,
  type TicketLine,
  ticketNames,
  ticketTimeRows,
  timeRows
} from './reportScorecardView'

/** Where the tab reads: the tracked folder, the workspace's timers, and a version that moves when the workspace reloads. */
export interface ReportScoreSource {
  folderPath: string
  scheduler: Scheduler
  version: number | string
}

/** A frozen snapshot is read when shown, on focus and on request, a dated reassessment only on request; neither is polled. */
const NEVER: Scheduler = { after: () => () => undefined, every: () => () => undefined }

interface CardContext {
  names: TicketNames
  opener: EvidenceOpener
  onSelectTicket(ticketId: string): void
  onRetry(): void
}

/** Opens the ticket a citation is about (an attempt or check through the run's attempts) when the plan shown holds it. */
export function reportOpener(run: RunView, names: TicketNames, onSelectTicket: (ticketId: string) => void): EvidenceOpener {
  const ticketOf = (ref: EvidenceRef): string | null => {
    const ticketId = ref.kind === 'attempt' || ref.kind === 'check' ? run.attempts.find((attempt) => attempt.id === ref.id)?.ticketId : ref.kind === 'ticket' || ref.kind === 'criterion' ? ref.id : undefined
    return ticketId !== undefined && names.has(ticketId) ? ticketId : null
  }
  return {
    target: (ref) => (ticketOf(ref) === null ? null : 'ticket'),
    open: (ref) => {
      const ticketId = ticketOf(ref)
      if (ticketId !== null) onSelectTicket(ticketId)
    }
  }
}

/** A ticket by its key and title, opening its panel when the plan shown holds it; its id otherwise. */
function TicketName({ ctx, ticketId }: { ctx: CardContext; ticketId: string }): JSX.Element {
  const name = ctx.names.get(ticketId)
  if (name === undefined) {
    return <span className="ew-mono">{ticketId}</span>
  }
  return (
    <span className="cp-sc-ticket">
      <button type="button" className="ew-link ew-mono cp-key" onClick={() => ctx.onSelectTicket(ticketId)}>
        {name.key}
      </button>
      <span>{name.title}</span>
    </span>
  )
}

function OutcomeSection({ card, ctx }: { card: SprintCard; ctx: CardContext }): JSX.Element {
  return (
    <Section title="SPRINT OUTCOME" label="Sprint outcome">
      <p role="note" className={`cp-sc-conclusion is-${card.sprint.outcome}`}>
        {outcomeConclusion(card, ctx.names)}
      </p>
      <ul className="cp-sc-list" aria-label="Ticket outcomes">
        {card.outcomes.map((outcome) => (
          <li key={`${outcome.runId}:${outcome.ticketId}`}>
            <TicketName ctx={ctx} ticketId={outcome.ticketId} />
            <StateLabel tone={OUTCOME_TONES[outcome.state]} label={outcomeText(outcome, true)} />
          </li>
        ))}
      </ul>
    </Section>
  )
}

function ResourcesSection({ card, ctx }: { card: SprintCard; ctx: CardContext }): JSX.Element {
  return (
    <Section title="TOKENS AND TIME" label="Tokens and time">
      <p className="sc-note">
        Tokens and active time as the sprint grade read them: overhead (orchestration, review) included, waits excluded. Effort is summed over every actor, so it
        can exceed wall-clock time.
      </p>
      <Facts label="Resource totals" rows={resourceRows(card)} />
      {card.timing.ok ? <Facts label="Sprint time" rows={timeRows(card.timing.value)} /> : <ScoreError error={card.timing.error} onRetry={ctx.onRetry} />}
    </Section>
  )
}

function FailureSection({ card, ctx }: { card: SprintCard; ctx: CardContext }): JSX.Element {
  const causes = failureCauses(card)
  return (
    <Section title="FAILURE CAUSES AND OVERHEAD" label="Failure causes">
      {causes.length === 0 ? <p className="sc-note">Nothing failed, and nothing held the grade back.</p> : null}
      <ul className="cp-sc-list">
        {causes.map((cause, index) => (
          // Two causes can read alike (two rejected tickets), so the position identifies the entry.
          <li key={`${index}:${cause.text}`}>
            {cause.ticketId === null ? null : <TicketName ctx={ctx} ticketId={cause.ticketId} />}
            <span>{cause.text}</span>
          </li>
        ))}
      </ul>
      <Facts label="Overhead" rows={overheadRows(card, ctx.names)} />
    </Section>
  )
}

function TicketRow({ ticket, frozenAt, ctx }: { ticket: TicketLine; frozenAt: string | null; ctx: CardContext }): JSX.Element {
  const [open, setOpen] = useState(false)
  const region = `cp-sc-ticket-${ticket.ticketId}`
  return (
    <li>
      <div className="cp-sc-ticket-head">
        <TicketName ctx={ctx} ticketId={ticket.ticketId} />
        <strong>{summaryText(ticket.grade)}</strong>
        <span className="sc-note">{ticketFacts(ticket).join(' · ')}</span>
        <button type="button" className="btn btn-ghost" aria-expanded={open} aria-controls={region} onClick={() => setOpen((held) => !held)}>
          {open ? 'Hide grade' : 'Show grade'}
        </button>
      </div>
      {open ? (
        <div id={region} role="region" aria-label={`Grade of ${ctx.names.get(ticket.ticketId)?.key ?? ticket.ticketId}`} className="cp-sc-ticket-detail">
          <GradeHeadline grade={ticket.grade} />
          {ticket.outcome === null ? null : <p className="sc-note">Outcome: {outcomeText(ticket.outcome, true)}</p>}
          <Facts label="Ticket time" rows={ticketTimeRows(ticket.times, frozenAt)} />
          <ComponentBreakdown grade={ticket.grade} opener={ctx.opener} />
        </div>
      ) : null}
    </li>
  )
}

function TicketsSection({ card, ctx }: { card: SprintCard; ctx: CardContext }): JSX.Element {
  const frozenAt = card.timing.ok ? card.timing.value.frozenAt : null
  return (
    <Section title={`TICKET GRADES (${card.tickets.length})`} label="Ticket grades">
      <p className="sc-note">Each ticket is graded on its own measures; the sprint grade is recomputed from the sprint&apos;s raw measures, never averaged from these.</p>
      {card.tickets.length === 0 ? <p className="ew-muted">No ticket of this sprint was graded.</p> : null}
      <ul className="cp-sc-list cp-sc-tickets">
        {card.tickets.map((ticket) => (
          <TicketRow key={ticket.ticketId} ticket={ticket} frozenAt={frozenAt} ctx={ctx} />
        ))}
      </ul>
    </Section>
  )
}

function CardSections({ card, ctx }: { card: SprintCard; ctx: CardContext }): JSX.Element {
  return (
    <>
      <GradeHeadline grade={card.sprint} />
      <OutcomeSection card={card} ctx={ctx} />
      <ComponentBreakdown grade={card.sprint} opener={ctx.opener} />
      <ResourcesSection card={card} ctx={ctx} />
      <Section title="MEASUREMENT COVERAGE" label="Measurement coverage">
        <Facts label="Coverage" rows={coverageRows(card, ctx.names)} />
      </Section>
      <FailureSection card={card} ctx={ctx} />
      <TicketsSection card={card} ctx={ctx} />
      <Section title="GRADES AT EACH LEVEL" label="Grades at each level">
        <Facts label="Levels" rows={levelRows(card)} />
      </Section>
    </>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// Reassessment

function SubjectItem({ subject, assessedAt, names }: { subject: SubjectReassessment; assessedAt: string; names: TicketNames }): JSX.Element {
  const changed = subject.differences.length
  return (
    <li>
      <details open={changed > 0 && subject.subject.level !== 'ticket'}>
        <summary>
          <strong>{subjectLabel(subject.subject, names)}</strong> · approved {summaryText(subject.approved)} · reassessed {summaryText(subject.current)} ·{' '}
          {changed === 0 ? 'no difference' : `${changed} difference(s)`}
        </summary>
        <Facts label={`Readings of ${subjectLabel(subject.subject, names)}`} rows={subjectRows(subject, assessedAt)} />
        {changed === 0 ? null : (
          <ul className="sc-deductions" aria-label="Differences">
            {subject.differences.map((difference) => (
              <li key={difference.component}>
                <span className="ew-mono">{difference.component}</span> {differenceText(difference)}
              </li>
            ))}
          </ul>
        )}
      </details>
    </li>
  )
}

function ReassessmentBody({ value, names }: { value: ScorecardReassessment; names: TicketNames }): JSX.Element {
  const approved = value.approved
  const policy = `${value.policy.policyId} v${value.policy.version} · ${shortHash(value.policy.hash)}`
  const samePolicy = approved !== null && approved.policy.hash === value.policy.hash
  return (
    <>
      <div className="cp-sc-mode">
        <StatePill tone="attention" label={`Reassessment · ${localTime(value.assessedAt)}`} />
      </div>
      <Facts
        label="Reassessment provenance"
        rows={[
          { label: 'Reassessed at', value: localTime(value.assessedAt) },
          { label: 'Graded under', value: approved === null ? policy : `${policy} (${samePolicy ? 'the snapshot’s policy' : 'a different policy from the snapshot’s'})` },
          {
            label: 'Compared with',
            value:
              approved === null
                ? 'nothing: the report predates scorecards, so no grade was approved'
                : `snapshot ${approved.snapshotId}, frozen ${localTime(approved.cutoff)} under ${approved.policy.policyId} v${approved.policy.version} · ${shortHash(approved.policy.hash)}`
          },
          { label: 'Provenance', value: 'regraded by the Dark Mechanicus core from this folder’s records when you asked; not stored, not approved' }
        ]}
      />
      <ul className="cp-sc-list cp-sc-subjects" aria-label="Reassessed subjects">
        {orderedSubjects(value.subjects).map((subject) => (
          <SubjectItem key={`${subject.subject.level}:${subject.subject.id}`} subject={subject} assessedAt={value.assessedAt} names={names} />
        ))}
      </ul>
    </>
  )
}

function Reassessment({ source, report, names }: { source: ReportScoreSource; report: ReportIdentity; names: TicketNames }): JSX.Element {
  // Each request is a new reading, dated by the server when it is read (never the renderer's clock).
  const [request, setRequest] = useState<number | null>(null)
  const state = useScoreRead({
    folder: source.folderPath,
    identity: request === null ? null : { kind: 'reassessment', reportId: report.reportId, reportRevision: report.reportRevision, request },
    version: 0,
    scheduler: NEVER,
    // A reading is dated when you asked for it: regaining focus must not take another one in its place.
    refreshOnFocus: false
  })
  const ask = (): void => setRequest((count) => (count ?? 0) + 1)
  return (
    <Section title="LATER REASSESSMENT" label="Later reassessment">
      <p className="sc-note">
        A reassessment is a separate, dated reading of this report&apos;s scope from the records as they stand when you ask. It never replaces the snapshot above:
        late metrics, ratings, defects and newer rubric versions show up only here, each difference with its cause.
      </p>
      <div>
        <button type="button" className="btn" onClick={ask}>
          {request === null ? 'Reassess now' : 'Reassess again'}
        </button>
      </div>
      {request === null ? null : state.status === 'ready' ? <ReassessmentBody value={state.data} names={names} /> : <ScoreReadNotice state={state} what="the reassessment" onRetry={ask} />}
    </Section>
  )
}

// ---------------------------------------------------------------------------------------------------------------
// The tab

function cutoffOf(data: ReportCardView): string {
  switch (data.state) {
    case 'live':
      return data.sprint.cutoff
    case 'frozen':
      return data.scorecard.snapshot.cutoff
    case 'legacy':
      return data.report.submittedAt
  }
}

interface ReportScorecardProps {
  source: ReportScoreSource
  target: ScorecardTarget
  /** The run the report belongs to (its number, and the attempts citations open through). */
  run: RunView
  /** The plan the run executed, for ticket keys and titles; null when it could not be read. */
  bundle: PlanBundle | null
  onSelectTicket(ticketId: string): void
}

/** The policy the grade follows and the person's optional sprint rating, under the sprint's scorecard. */
function SprintInputs({ props, data, ctx }: { props: ReportScorecardProps; data: ReportCardView; ctx: CardContext }): JSX.Element {
  const ordinal = props.bundle?.sprints.find((sprint) => sprint.id === props.target.sprintId)?.ordinal
  return (
    <>
      <GradingPolicyDetails folderPath={props.source.folderPath} />
      <SprintFeedback
        source={props.source}
        epicId={props.run.epicId}
        runId={props.target.runId}
        sprintId={props.target.sprintId}
        sprintLabel={ordinal === undefined ? 'this sprint' : `Sprint ${ordinal}`}
        frozen={data.state !== 'live'}
        onRecorded={ctx.onRetry}
      />
    </>
  )
}

function ReadyCard({ props, data, ctx }: { props: ReportScorecardProps; data: ReportCardView; ctx: CardContext }): JSX.Element {
  const mode = modeView(data, props.target.report?.standing ?? null)
  const card = sprintCard(data)
  return (
    <>
      <div className="cp-sc-mode">
        <StatePill tone={mode.tone} label={mode.label} />
      </div>
      <p className="sc-note">{mode.note}</p>
      {data.state === 'live' ? null : (
        <Facts label="Pinned report" rows={identityRows(data.report, data.state === 'frozen' ? data.scorecard.snapshot : null, data.report.runId === props.run.id ? props.run.number : null)} />
      )}
      {card === null ? null : <CardSections card={card} ctx={ctx} />}
      <SprintInputs props={props} data={data} ctx={ctx} />
      {data.state === 'live' ? null : <Reassessment key={`${data.report.reportId}:${data.report.reportRevision}`} source={props.source} report={data.report} names={ctx.names} />}
    </>
  )
}

/** The Scorecard tab of one sprint report (or, before the report, of its sprint). */
export function ReportScorecard(props: ReportScorecardProps): JSX.Element {
  const { target, source } = props
  const [asked, setAsked] = useState(0)
  const report = target.report
  const state = useScoreRead({
    folder: source.folderPath,
    identity: { kind: 'reportCard', runId: target.runId, sprintId: target.sprintId, report: report === null ? null : { reportId: report.reportId, reportRevision: report.reportRevision } },
    version: `${source.version}:${asked}`,
    scheduler: report === null ? source.scheduler : NEVER
  })
  const refresh = (): void => setAsked((count) => count + 1)
  const names = ticketNames(props.bundle)
  const ctx: CardContext = { names, opener: reportOpener(props.run, names, props.onSelectTicket), onSelectTicket: props.onSelectTicket, onRetry: refresh }
  return (
    <div className="sc-tab cp-scorecard">
      {state.status !== 'ready' ? (
        <ScoreReadNotice state={state} what="the sprint scorecard" onRetry={refresh} />
      ) : (
        <>
          <Freshness loadedAt={state.loadedAt} cutoff={cutoffOf(state.data)} refreshError={state.refreshError} onRefresh={refresh} polled={report === null} />
          <ReadyCard props={props} data={state.data} ctx={ctx} />
        </>
      )}
    </div>
  )
}
