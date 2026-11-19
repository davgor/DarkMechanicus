/**
 * Scorecards frozen with sprint report revisions, and dated reassessments of them.
 *
 * When a sprint report is submitted, the sprint's, run's and (in the final sprint's report) epic's grades and every
 * ticket grade of the sprint are computed once, at the submission's server time, and stored with the report revision
 * (`sprint_reports.scorecard_json`, canonical JSON) together with the policy, the plan revision, the report's content
 * hash, every grade's inputs (the baselines compared against included), the timing and efficiency inputs as they
 * stood and the source ids. The snapshot is exported as its own record beside the run history
 * (`history/<runId>/scorecards/<reportId>.json`), which names it by hash. It keeps inputs and compact results, not
 * explanations: a read regrades the stored inputs under the stored policy and must get the stored results back. A
 * restart, an export and import, an adoption, later records and a later policy leave it byte for byte. Reading the
 * scope again later is a reassessment: dated, compared with the snapshot over the same window, never a rewrite.
 */
import type { GetReportScorecardInput, ReportIdentity, ReportScorecardView } from '../../shared/domain/scoreReads'
import { SPACE_COMPONENTS, type SpaceComponent, type SpaceComponentResult, type SpaceGrade, type SpaceGradeInput } from '../../shared/domain/space'
import type {
  AggregateDetail,
  AggregateGradeView,
  ComponentDifference,
  ComponentReading,
  DifferenceCause,
  FrozenAggregate,
  FrozenComponentInput,
  FrozenEfficiency,
  FrozenGrade,
  FrozenTiming,
  GradeSummary,
  ReassessedMembership,
  ScorecardDraft,
  ScorecardReassessment,
  ScorecardSnapshot,
  ScorecardSummary,
  ScorecardView,
  SubjectReassessment
} from '../../shared/domain/spaceGrades'
import type { EffortTotals, RunTiming, TicketTiming, WindowTiming } from '../../shared/domain/timing'
import { requireCapability } from '../authz'
import { canonicalJson } from '../canonical'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { fail } from '../errors'
import { CURRENT_SPACE_POLICY, gradeSpace, policyRef } from '../space/rubric'
import { freezeGrade, frozenInput, parseScorecardSnapshot, pooled, readScorecard, snapshotHashOf, snapshotIdOf } from '../space/snapshot'
import { loadBundle, requireRun } from './execution'
import { cutoffOf } from './performance'
import { epicAggregate, gradeRunTickets, runAggregate, sprintAggregate } from './spaceGrades'
import { projectRunTiming } from './timing'

// ---------------------------------------------------------------------------------------------------------------
// Freezing

function frozenWindow(window: WindowTiming): Omit<FrozenTiming['run'], 'unattributedEffort'> {
  const { elapsed, startedAt, endedAt, inFlight, activeWallClock, effort } = window
  return { elapsed, startedAt, endedAt, inFlight, activeWallClock, effort: effort.total, overhead: effort.overhead }
}

function frozenTicket(ticket: TicketTiming): FrozenTiming['tickets'][number] {
  const { ticketId, sprintId, readyAt, firstClaimAt, acceptedAt, endedBy, cycleTime, leadTime, active } = ticket
  const effort: EffortTotals = ticket.effort
  return { ticketId, sprintId, readyAt, firstClaimAt, acceptedAt, endedBy, cycleTime, leadTime, active, effort: effort.total, overhead: effort.overhead }
}

/** The run's timing as projected at the cutoff, cut down to the sprint's and the run's totals and the sprint's tickets. */
function frozenTiming(timing: RunTiming, sprintId: string): FrozenTiming {
  const sprint = timing.sprints.find((entry) => entry.sprintId === sprintId)
  return {
    runId: timing.runId,
    asOf: timing.asOf,
    basis: { window: 'activation', totals: 'current_plan' },
    run: { ...frozenWindow(timing), unattributedEffort: timing.unattributedEffort.total },
    sprint:
      sprint === undefined
        ? null
        : {
            ...frozenWindow(sprint),
            sprintId,
            ticketIds: sprint.ticketIds,
            checkpointWait: sprint.checkpointWait,
            unattributedOverhead: sprint.unattributedOverhead
          },
    tickets: timing.tickets.filter((ticket) => ticket.sprintId === sprintId).map(frozenTicket),
    anomalies: timing.anomalies
  }
}

function frozenEfficiency(view: AggregateGradeView): FrozenEfficiency[] {
  return view.sources.efficiency.map((scope, index) => ({
    runId: view.measuredRunIds[index] ?? '',
    effort: scope.classification.denominator,
    time: {
      actual: scope.time.actual,
      overheadMs: scope.time.overheadValue,
      excludedWaitsMs: scope.time.excludedWaitsMs,
      unreportedAttemptIds: scope.time.unreportedAttemptIds,
      openAttemptIds: scope.time.openAttemptIds
    },
    tokens: { actual: scope.tokens.actual, unreportedAttemptIds: scope.tokens.unreportedAttemptIds, openAttemptIds: scope.tokens.openAttemptIds },
    retries: scope.classification.retries.retries
  }))
}

function detailOf(view: AggregateGradeView): AggregateDetail {
  return {
    runIds: view.runIds,
    measuredRunIds: view.measuredRunIds,
    outcomes: view.outcomes,
    rollups: {
      T: { overhead: view.rollups.T.overhead, partial: view.rollups.T.partial },
      K: { overhead: view.rollups.K.overhead, partial: view.rollups.K.partial }
    },
    efficiency: frozenEfficiency(view)
  }
}

interface DraftScorecardInput {
  runId: string
  sprintId: string
  report: { reportId: string; reportRevision: number }
  /** The report's submission time: every grade is read at it. */
  cutoff: string
}

interface FreezeScorecardInput extends Omit<DraftScorecardInput, 'report'> {
  report: { reportId: string; reportRevision: number; contentHash: string }
}

/**
 * The grades of a report revision, computed once at its submission (call it inside the submission's transaction),
 * before the report's content is hashed: nothing here reads the report's text. Every ticket of the run is graded
 * once, with the run's records loaded once, and each level rolls those up. `sealScorecard` finishes it.
 */
export function draftScorecard(ctx: Ctx, input: DraftScorecardInput): ScorecardDraft {
  const run = requireRun(ctx, input.runId)
  const grading = gradeRunTickets(ctx, run.id, input.cutoff)
  const bundle = loadBundle(ctx, run.revision_id)
  const final = bundle.sprints.length > 0 && bundle.sprints.reduce((last, sprint) => (sprint.ordinal > last.ordinal ? sprint : last)).id === input.sprintId
  const sprint = sprintAggregate(ctx, grading, input.sprintId)
  const runView = runAggregate(ctx, grading)
  const epic = final ? epicAggregate(ctx, run.epic_id, grading.cutoff, [grading]) : null
  const snapshotId = snapshotIdOf(input.report.reportId)
  const inputs: Record<string, FrozenComponentInput> = {}
  const details: Record<string, AggregateDetail> = {}
  const aggregate = (view: AggregateGradeView): FrozenAggregate => ({ ...freezeGrade(snapshotId, view.input, view.grade, inputs), detail: pooled(details, detailOf(view)) })
  const frozenSprint = aggregate(sprint)
  const frozenRun = aggregate(runView)
  const frozenEpic = epic === null ? null : aggregate(epic)
  const tickets = sprint.tickets.map((ticket) => freezeGrade(snapshotId, ticket.input, ticket.grade, inputs))
  const attemptIds = grading.attempts.map((row) => row.id)
  return {
    format: 'darkmechanicus.scorecard',
    formatVersion: 1,
    snapshotId,
    epicId: run.epic_id,
    runId: run.id,
    sprintId: input.sprintId,
    report: input.report,
    planRevisionId: run.revision_id,
    cutoff: grading.cutoff,
    policy: policyRef(grading.policy),
    sprint: frozenSprint,
    run: frozenRun,
    epic: frozenEpic,
    tickets,
    inputs,
    details,
    timing: frozenTiming(projectRunTiming(ctx, { runId: run.id, asOf: grading.cutoff }), input.sprintId),
    sources: { runIds: epic?.runIds ?? [run.id], ticketIds: grading.tickets.map((ticket) => ticket.ticketId), attemptIds },
    anomalies: [...runView.anomalies, ...(epic?.anomalies.filter((entry) => !runView.anomalies.includes(entry)) ?? [])]
  }
}

/** A drafted scorecard stamped with its report revision's content hash, sealed and checked: what is stored. */
export function sealScorecard(draft: ScorecardDraft, contentHash: string): ScorecardSnapshot {
  const content: Omit<ScorecardSnapshot, 'snapshotHash'> = { ...draft, report: { ...draft.report, contentHash } }
  // Round-tripped through JSON so the value returned is exactly what is stored (no undefined keys), then checked.
  return parseScorecardSnapshot(JSON.parse(canonicalJson({ ...content, snapshotHash: snapshotHashOf(content) })))
}

/** The scorecard of a report revision whose content hash is already known: drafted and sealed at once. */
export function freezeScorecard(ctx: Ctx, input: FreezeScorecardInput): ScorecardSnapshot {
  const { contentHash, ...report } = input.report
  return sealScorecard(draftScorecard(ctx, { ...input, report }), contentHash)
}

/** How a snapshot is stored: canonical JSON, so every copy of it has the same bytes. */
export function storedScorecard(snapshot: ScorecardSnapshot): string {
  return canonicalJson(snapshot)
}

function frozenSummary(snapshot: ScorecardSnapshot, grade: FrozenGrade): GradeSummary {
  const { inputHash, status, score, displayScore, letter, coverage } = grade.result
  return { subject: grade.subject, assessmentId: grade.assessmentId, status, score, displayScore, letter, coverage, inputHash, policyHash: snapshot.policy.hash }
}

/**
 * What a report view shows of its stored snapshot: the sprint, run and epic grades at a glance, read from the stored
 * results. The snapshot was checked (schema, seal, regrade) when it was written or imported, so this does not regrade.
 */
export function storedSummary(stored: string | null): ScorecardSummary | null {
  if (stored === null) return null
  const snapshot = JSON.parse(stored) as ScorecardSnapshot
  const grades = [snapshot.sprint, snapshot.run, ...(snapshot.epic === null ? [] : [snapshot.epic])].map((grade) => frozenSummary(snapshot, grade))
  const { snapshotId, snapshotHash, cutoff, policy } = snapshot
  return { snapshotId, snapshotHash, cutoff, policy, grades, ticketCount: snapshot.tickets.length }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading and reassessing

interface StoredReport {
  id: string
  run_id: string
  sprint_id: string
  report_revision: number
  scorecard_json: string | null
  created_at: string
}

/** The report revision `input` names; a given `reportRevision` that is not that revision's is `not_found`. */
function storedReport(ctx: Ctx, input: GetReportScorecardInput): StoredReport {
  const { reportId, reportRevision } = input
  const report =
    ctx.db.get<StoredReport>('SELECT id, run_id, sprint_id, report_revision, scorecard_json, created_at FROM sprint_reports WHERE id = ?', reportId) ??
    fail('not_found', `Report ${reportId} not found.`, { reportId })
  if (reportRevision !== undefined && reportRevision !== report.report_revision) {
    fail('not_found', `Report ${reportId} is revision ${report.report_revision}, not revision ${reportRevision}.`, { reportId, reportRevision })
  }
  return report
}

/** A stored snapshot as written; null for a report submitted before scorecards were frozen (it stays ungraded). */
function snapshotOf(stored: string | null): ScorecardSnapshot | null {
  return stored === null ? null : parseScorecardSnapshot(parseJson<unknown>(stored, null))
}

/**
 * The scorecard frozen with a report revision, pinned to that revision: the snapshot exactly as stored, with every
 * frozen grade regraded from its stored input under its stored policy (explanations included). A legacy report reads
 * as `legacy` and stays ungraded; no live grade stands in for it.
 */
export function getReportScorecard(ctx: Ctx, input: GetReportScorecardInput): ReportScorecardView {
  requireCapability(ctx.session, 'read')
  const stored = storedReport(ctx, input)
  const report: ReportIdentity = { reportId: stored.id, runId: stored.run_id, sprintId: stored.sprint_id, reportRevision: stored.report_revision, submittedAt: stored.created_at }
  const snapshot = snapshotOf(stored.scorecard_json)
  if (snapshot === null) {
    return { state: 'legacy', report, reason: 'The report was submitted before scorecards were frozen with reports; it stays ungraded.' }
  }
  return { state: 'frozen', report, scorecard: readScorecard(snapshot) }
}

function readingOf(grade: SpaceGrade | null, component: SpaceComponent): ComponentReading | null {
  if (grade === null) return null
  const entry = grade.components.find((item) => item.component === component)
  return { state: entry?.state ?? 'missing', score: entry?.score ?? null, missingReason: entry?.missingReason ?? null }
}

/** Whether two readings differ; a reading absent on either side is no comparison. */
function differs(a: ComponentReading | null, b: ComponentReading | null): boolean {
  return a !== null && b !== null && (a.score !== b.score || a.state !== b.state || a.missingReason !== b.missingReason)
}

/** Which input values of a component differ between two grades, by name, for the explanation. */
function changedInputs(a: SpaceComponentResult | undefined, b: SpaceComponentResult | undefined): string[] {
  const keys = new Set([...Object.keys(a?.inputs ?? {}), ...Object.keys(b?.inputs ?? {})])
  return [...keys].filter((key) => a?.inputs[key] !== b?.inputs[key]).map((key) => `${key} ${String(a?.inputs[key] ?? '—')} → ${String(b?.inputs[key] ?? '—')}`)
}

/** The four readings of one subject: approved, approved input under the current policy, same window now, and now. */
interface Readings {
  approved: SpaceGrade | null
  recast: SpaceGrade | null
  sameWindow: SpaceGrade | null
  current: SpaceGrade | null
  startMoved: boolean
}

/** Why one component's readings differ: the policy, the records at the approved cutoff, or what came after it. */
function causesOf(readings: Readings, component: SpaceComponent): DifferenceCause[] {
  const approved = readingOf(readings.approved, component)
  const recast = readingOf(readings.recast, component)
  const same = readingOf(readings.sameWindow, component)
  const now = readingOf(readings.current, component)
  const causes: DifferenceCause[] = []
  if (differs(approved, recast)) causes.push('policy_changed')
  if (differs(recast, same)) causes.push('records_at_cutoff_changed')
  if (differs(same, now)) causes.push(readings.startMoved ? 'window_start_moved' : 'later_records')
  return causes
}

/** The inputs that changed at the approved cutoff and since, by name. */
function differenceDetail(readings: Readings, component: SpaceComponent): string {
  const find = (grade: SpaceGrade | null) => grade?.components.find((entry) => entry.component === component)
  const atCutoff = changedInputs(find(readings.recast), find(readings.sameWindow))
  const later = changedInputs(find(readings.sameWindow), find(readings.current))
  const parts = [...(atCutoff.length === 0 ? [] : [`at the approved cutoff: ${atCutoff.join('; ')}`]), ...(later.length === 0 ? [] : [`since the approved cutoff: ${later.join('; ')}`])]
  return parts.join('. ').slice(0, 2_000)
}

function componentDifference(readings: Readings, component: SpaceComponent): ComponentDifference | null {
  const causes = causesOf(readings, component)
  if (causes.length === 0) return null
  return {
    component,
    approved: readingOf(readings.approved, component),
    sameWindow: readingOf(readings.sameWindow, component),
    current: readingOf(readings.current, component),
    causes,
    detail: differenceDetail(readings, component)
  }
}

function summaryOf(grade: SpaceGrade | null): GradeSummary | null {
  if (grade === null) return null
  const { subject, assessmentId, status, score, displayScore, letter, coverage, inputHash } = grade
  return { subject, assessmentId, status, score, displayScore, letter, coverage, inputHash, policyHash: grade.policy.hash }
}

interface Frozen {
  grade: SpaceGrade
  input: SpaceGradeInput
}

/** An observation window: from a reading's first dispatch to its cutoff (empty when there is no reading). */
function windowOf(grade: SpaceGrade | null): { from: string | null; to: string } {
  return grade === null ? { from: null, to: '' } : { from: grade.dispatchedAt, to: grade.cutoff }
}

/** The approved and current observation windows; comparable when both start at the same first dispatch. */
function windowsOf(reference: SpaceGrade | null, current: SpaceGrade | null): SubjectReassessment['windows'] {
  const approved = windowOf(reference)
  const now = windowOf(current)
  const comparable = current === null || reference === null || approved.from === now.from
  const note = comparable
    ? `both windows start at the first dispatch (${now.from ?? 'none'}); the current one runs ${approved.to} → ${now.to} longer`
    : `not comparable: the approved window starts at ${approved.from ?? 'no dispatch'}, the current one at ${now.from ?? 'no dispatch'}`
  return { approved, current: now, comparable, note }
}

function compareSubject(membership: ReassessedMembership, frozen: Frozen | null, sameWindow: SpaceGrade | null, current: SpaceGrade | null): SubjectReassessment {
  const approved = frozen === null ? null : frozen.grade
  const windows = windowsOf(approved ?? sameWindow, current)
  const readings: Readings = { approved, recast: frozen === null ? null : gradeSpace(frozen.input, CURRENT_SPACE_POLICY), sameWindow, current, startMoved: !windows.comparable }
  const subject = (approved ?? current ?? sameWindow ?? fail('internal', 'A reassessed subject has no reading.')).subject
  return {
    subject,
    membership,
    approved: summaryOf(approved),
    sameWindow: summaryOf(sameWindow),
    current: summaryOf(current),
    windows,
    differences: SPACE_COMPONENTS.flatMap((component) => componentDifference(readings, component) ?? [])
  }
}

/** Every grade of a report's scope read at one cutoff, keyed `level:id`: the aggregates and every ticket of the run. */
interface ScopeGrades {
  grades: Map<string, SpaceGrade>
  /** The sprint's tickets at that cutoff (current-plan membership). */
  members: Set<string>
}

function gradesAt(ctx: Ctx, report: StoredReport, cutoff: string, withEpic: boolean): ScopeGrades {
  const run = requireRun(ctx, report.run_id)
  const grading = gradeRunTickets(ctx, run.id, cutoff)
  const sprint = sprintAggregate(ctx, grading, report.sprint_id)
  const aggregates = [sprint.grade, runAggregate(ctx, grading).grade, ...(withEpic ? [epicAggregate(ctx, run.epic_id, grading.cutoff, [grading]).grade] : [])]
  const grades = [...aggregates, ...grading.tickets.map((ticket) => ticket.grade)]
  return { grades: new Map(grades.map((grade) => [`${grade.subject.level}:${grade.subject.id}`, grade])), members: new Set(sprint.tickets.map((ticket) => `ticket:${ticket.ticketId}`)) }
}

/** Whether a `level:id` key names a run, sprint or epic grade. */
const AGGREGATE_LEVELS: Readonly<Record<string, true>> = { sprint: true, run: true, epic: true }
const isAggregateKey = (key: string): boolean => AGGREGATE_LEVELS[key.slice(0, key.indexOf(':'))] === true

function membershipOf(key: string, frozen: ReadonlyMap<string, Frozen> | null, current: ScopeGrades): ReassessedMembership {
  if (frozen === null) return 'legacy'
  const scoped = isAggregateKey(key) || current.members.has(key)
  if (!frozen.has(key)) return 'joined'
  return scoped ? 'kept' : 'left'
}

function frozenGrades(view: ScorecardView | null): Map<string, Frozen> | null {
  if (view === null) return null
  const { snapshot } = view
  const pairs: [FrozenGrade, SpaceGrade][] = [
    [snapshot.sprint, view.sprint.grade],
    [snapshot.run, view.run.grade],
    ...(snapshot.epic === null || view.epic === null ? [] : ([[snapshot.epic, view.epic.grade]] as [FrozenGrade, SpaceGrade][])),
    ...snapshot.tickets.map((grade, index): [FrozenGrade, SpaceGrade] => [grade, view.tickets[index] ?? fail('internal', 'A frozen ticket grade was not read.')])
  ]
  return new Map(pairs.map(([stored, grade]) => [`${grade.subject.level}:${grade.subject.id}`, { grade, input: frozenInput(snapshot, stored) }]))
}

/**
 * A dated reassessment of a report's scorecard as of `cutoff` (default now, never later). The approved snapshot is
 * returned untouched; each of its subjects (a legacy report's: the sprint, run and tickets) is regraded over the
 * approved window (the snapshot's cutoff, or a legacy report's submission time) and up to the reassessment's cutoff,
 * and every component that differs says whether the policy, the records at the approved cutoff or later records moved
 * it. A frozen ticket an adoption has since moved out of the sprint is still listed (`left`), graded at run level
 * while the run still holds it; a ticket that joined the sprint later is listed as `joined`.
 */
export function reassessReportScorecard(ctx: Ctx, input: GetReportScorecardInput & { cutoff?: string }): ScorecardReassessment {
  requireCapability(ctx.session, 'read')
  return ctx.db.tx(() => {
    const report = storedReport(ctx, input)
    const approved = snapshotOf(report.scorecard_json)
    const frozen = frozenGrades(approved === null ? null : readScorecard(approved))
    const assessedAt = cutoffOf(ctx, input.cutoff)
    const withEpic = approved?.epic !== null && approved?.epic !== undefined
    const sameWindow = gradesAt(ctx, report, approved?.cutoff ?? report.created_at, withEpic)
    const current = gradesAt(ctx, report, assessedAt, withEpic)
    const aggregates = [...current.grades.keys()].filter(isAggregateKey)
    const keys = [...new Set([...aggregates, ...(frozen?.keys() ?? []), ...current.members])]
    const subjects = keys.map((key) =>
      compareSubject(membershipOf(key, frozen, current), frozen?.get(key) ?? null, sameWindow.grades.get(key) ?? null, current.grades.get(key) ?? null)
    )
    return { reportId: report.id, reportRevision: report.report_revision, legacy: approved === null, approved, assessedAt, policy: policyRef(CURRENT_SPACE_POLICY), subjects }
  })
}
