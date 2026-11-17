/**
 * Text and rows for a sprint report's Scorecard tab, from the core's read models as they are. Nothing here grades: the
 * sprint, run, epic and ticket grades are the core's, frozen with the report revision (`getReportScorecard`) or, for a
 * sprint without a report, read live (`getSprintGrade`). Both are brought into one shape so the tab lays them out the
 * same way; what each one is (approved, awaiting approval, historical, live) is said beside it, never blurred. A value
 * the core has no number for reads "unavailable", never 0.
 */
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { ReportIdentity } from '../../../shared/domain/scoreReads'
import type {
  CollaborationInput,
  EfficiencyInput,
  Measurement,
  ResourceInput,
  SpaceGrade,
  SpaceGradeInput,
  VerificationState
} from '../../../shared/domain/space'
import type {
  AggregateGradeView,
  DifferenceCause,
  FrozenEfficiency,
  FrozenGrade,
  ReassessedMembership,
  RequiredOutcome,
  ScorecardSnapshot,
  ScorecardView,
  SubjectReassessment
} from '../../../shared/domain/spaceGrades'
import type { RunTiming, TimingAnomaly, TimingQuantity, WindowTiming } from '../../../shared/domain/timing'
import type { Tone } from '../graph/ticketStates'
import type { FactRow } from '../scorecard/ScorecardParts'
import type { ReadPart, ReportCardView } from '../scorecard/scoreReads'
import { satisfactionLabel } from '../scorecard/feedbackForm'
import { amountText, durationText, localTime, measurementText, MISSING_REASON_LABELS, percentText, quantityText, shortHash, STATUS_REASON_LABELS, summaryText } from '../scorecard/scorecardFormat'
import { planTicketNames, REASON_LABELS, STATE_LABELS, ticketLabel, type TicketNames } from '../scorecard/outcomeLabels'

// ---------------------------------------------------------------------------------------------------------------
// What the tab reads and what it stands for

/**
 * What a report's snapshot stands for where it is shown: a checkpoint's report not yet approved, one approved at this
 * checkpoint, or a report of a completed run's history (the run has passed that checkpoint).
 */
type ReportStanding = 'awaiting_approval' | 'approved' | 'historical'

/** The scorecard a report view reads: the report revision it is pinned to, or (no report yet) the sprint's live grade. */
export interface ScorecardTarget {
  runId: string
  sprintId: string
  report: { reportId: string; reportRevision: number; standing: ReportStanding } | null
}

interface ModeView {
  label: string
  tone: Tone
  note: string
}

/** What the scorecard shown is, and why it can or cannot change. */
export function modeView(card: ReportCardView, standing: ReportStanding | null): ModeView {
  if (card.state === 'live') {
    return {
      label: 'Live · provisional',
      tone: 'running',
      note: 'No report has been submitted for this sprint yet, so nothing is frozen: this is the sprint graded now from the records so far, and it changes as work lands. Submitting the report freezes its own snapshot.'
    }
  }
  const revision = `report revision ${card.report.reportRevision}`
  if (card.state === 'legacy') {
    return {
      label: 'Ungraded (legacy)',
      tone: 'neutral',
      note: `${card.reason} This ${revision} stays ungraded: no live grade stands in for it. A reassessment below grades its scope only as a separate, dated reading.`
    }
  }
  const frozen = `Frozen when ${revision} was submitted (${localTime(card.report.submittedAt)}), from the records up to then.`
  const never = 'Late metrics, ratings, defects and newer rubric versions never change it: they appear only in a dated reassessment below.'
  switch (standing ?? 'historical') {
    case 'awaiting_approval':
      return { label: 'Snapshot · awaiting approval', tone: 'review', note: `${frozen} Approving the checkpoint approves this snapshot as it is. ${never}` }
    case 'approved':
      return { label: 'Approved snapshot', tone: 'accepted', note: `${frozen} It was approved at this checkpoint. ${never}` }
    case 'historical':
      return { label: 'Historical snapshot', tone: 'accepted', note: `${frozen} The run has since passed this checkpoint. ${never}` }
  }
}

/** The report revision the scorecard is pinned to, and (frozen) the snapshot that belongs to it. */
export function identityRows(report: ReportIdentity, snapshot: ScorecardSnapshot | null, runNumber: number | null): FactRow[] {
  const rows: FactRow[] = [
    { label: 'Report revision', value: `${report.reportRevision} (pinned: a later revision has its own scorecard)` },
    { label: 'Report', value: report.reportId },
    { label: 'Submitted', value: localTime(report.submittedAt) },
    { label: 'Run', value: runNumber === null ? report.runId : `Run #${runNumber}` }
  ]
  if (snapshot === null) {
    return [...rows, { label: 'Snapshot', value: 'none: this report predates scorecards' }]
  }
  return [
    ...rows,
    { label: 'Snapshot', value: `${snapshot.snapshotId} · ${shortHash(snapshot.snapshotHash)}` },
    { label: 'Report content', value: shortHash(snapshot.report.contentHash) },
    { label: 'Graded under', value: `${snapshot.policy.policyId} v${snapshot.policy.version} · ${shortHash(snapshot.policy.hash)}` },
    { label: 'Plan revision', value: snapshot.planRevisionId }
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// The sprint's scorecard, frozen or live, in one shape

type Inputs = SpaceGradeInput['components']

/** The inputs of a grade the tab explains beyond its components: collaboration, effort, time and tokens. */
interface GradeInputs {
  C: CollaborationInput | null
  E: EfficiencyInput | null
  T: ResourceInput | null
  K: ResourceInput | null
}

/** A ticket's times as the timing projection read them (frozen with the report, or at the live grade's cutoff). */
interface TicketTimes {
  cycleTime: TimingQuantity
  leadTime: TimingQuantity
  active: TimingQuantity
  effort: TimingQuantity
  overhead: TimingQuantity
}

interface WindowTimes {
  elapsed: TimingQuantity
  startedAt: string | null
  endedAt: string | null
  inFlight: TimingQuantity
  activeWallClock: TimingQuantity
  effort: TimingQuantity
  overhead: TimingQuantity
}

interface CardTiming {
  asOf: string
  /** The report's cutoff when the timing was frozen with it (an interval open then ran on after it); null when live. */
  frozenAt: string | null
  sprint: (WindowTimes & { checkpointWait: TimingQuantity; unattributedOverhead: TimingQuantity }) | null
  run: WindowTimes & { unattributedEffort: TimingQuantity }
  anomalies: TimingAnomaly[]
}

export interface TicketLine {
  ticketId: string
  grade: SpaceGrade
  inputs: GradeInputs
  /** The ticket's outcome in the sprint grade; null when the grade holds none for it. */
  outcome: RequiredOutcome | null
  times: TicketTimes | null
}

interface TicketRef {
  runId: string
  ticketId: string
}

interface RollupFacts {
  /** Whether the grade was offered a roll-up baseline at all (false: no executed ticket's grade accepted one). */
  baseline: boolean
  partial: boolean
  overhead: TicketRef[]
  /** Executed work tickets whose grade accepted no baseline; null when the source does not list them (frozen). */
  uncovered: TicketRef[] | null
}

/** What every section of the tab reads, whether the scorecard is frozen with the report or live. */
export interface SprintCard {
  sprint: SpaceGrade
  inputs: GradeInputs
  /** Frozen with the report: the run so far at the cutoff; null for a live sprint grade (read alone). */
  run: SpaceGrade | null
  /** Only in the final sprint's report: the epic so far. */
  epic: SpaceGrade | null
  outcomes: RequiredOutcome[]
  rollups: { T: RollupFacts; K: RollupFacts }
  /** Each measured run's effort, time and tokens, as the sprint grade read them. */
  measures: FrozenEfficiency[]
  timing: ReadPart<CardTiming>
  tickets: TicketLine[]
}

/** A property only each component's input holds: a stored input is read as that component's only when it has it. */
const INPUT_SHAPES = { C: 'coordinationDefects', E: 'correctiveMs', T: 'unreportedAttempts', K: 'unreportedAttempts' } as const

function storedInput<C extends keyof typeof INPUT_SHAPES>(snapshot: ScorecardSnapshot, grade: FrozenGrade, component: C): Inputs[C] | null {
  const input = snapshot.inputs[grade.inputs[component]]
  if (input === undefined || !(INPUT_SHAPES[component] in input)) {
    return null
  }
  // The `in` check above is the shape test: only this component's input holds that property.
  const typed = input as Inputs[C]
  return typed
}

function frozenInputs(snapshot: ScorecardSnapshot, grade: FrozenGrade): GradeInputs {
  return { C: storedInput(snapshot, grade, 'C'), E: storedInput(snapshot, grade, 'E'), T: storedInput(snapshot, grade, 'T'), K: storedInput(snapshot, grade, 'K') }
}

function liveInputs(input: SpaceGradeInput): GradeInputs {
  const { C, E, T, K } = input.components
  return { C, E, T, K }
}

/** The sprint's own outcome per ticket (the run the snapshot or grade belongs to). */
function outcomesByTicket(outcomes: readonly RequiredOutcome[], runId: string): Map<string, RequiredOutcome> {
  return new Map(outcomes.filter((outcome) => outcome.runId === runId).map((outcome) => [outcome.ticketId, outcome]))
}

/** A report revision's frozen scorecard: every grade, input, outcome and time exactly as frozen with it. */
function frozenCard(view: ScorecardView): SprintCard {
  const { snapshot } = view
  const detail = view.sprint.detail
  const grades = new Map(view.tickets.map((grade) => [grade.subject.id, grade]))
  const times = new Map(snapshot.timing.tickets.map((ticket) => [ticket.ticketId, ticket]))
  const outcomes = outcomesByTicket(detail.outcomes, snapshot.runId)
  const tickets = snapshot.tickets.flatMap((frozen): TicketLine[] => {
    const grade = grades.get(frozen.subject.id)
    const id = frozen.subject.id
    return grade === undefined ? [] : [{ ticketId: id, grade, inputs: frozenInputs(snapshot, frozen), outcome: outcomes.get(id) ?? null, times: times.get(id) ?? null }]
  })
  const timing = snapshot.timing
  const inputs = frozenInputs(snapshot, snapshot.sprint)
  return {
    sprint: view.sprint.grade,
    inputs,
    run: view.run.grade,
    epic: view.epic?.grade ?? null,
    outcomes: detail.outcomes,
    rollups: {
      T: { baseline: inputs.T?.baseline.state === 'selected', partial: detail.rollups.T.partial, overhead: detail.rollups.T.overhead, uncovered: null },
      K: { baseline: inputs.K?.baseline.state === 'selected', partial: detail.rollups.K.partial, overhead: detail.rollups.K.overhead, uncovered: null }
    },
    measures: detail.efficiency,
    timing: { ok: true, value: { asOf: timing.asOf, frozenAt: snapshot.cutoff, sprint: timing.sprint, run: timing.run, anomalies: timing.anomalies } },
    tickets
  }
}

function windowTimes(window: WindowTiming): WindowTimes {
  const { elapsed, startedAt, endedAt, inFlight, activeWallClock, effort } = window
  return { elapsed, startedAt, endedAt, inFlight, activeWallClock, effort: effort.total, overhead: effort.overhead }
}

function liveTiming(timing: RunTiming, sprintId: string): CardTiming {
  const sprint = timing.sprints.find((entry) => entry.sprintId === sprintId)
  return {
    asOf: timing.asOf,
    frozenAt: null,
    sprint: sprint === undefined ? null : { ...windowTimes(sprint), checkpointWait: sprint.checkpointWait, unattributedOverhead: sprint.unattributedOverhead },
    run: { ...windowTimes(timing), unattributedEffort: timing.unattributedEffort.total },
    anomalies: timing.anomalies
  }
}

/** The measured runs' efficiency as the live grade read it, in the shape a snapshot freezes it in. */
function liveMeasures(view: AggregateGradeView): FrozenEfficiency[] {
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

/** A sprint without a report: its live grade, the run's grade inside it, and the run's timing at the grade's cutoff. */
function liveCard(card: Extract<ReportCardView, { state: 'live' }>): SprintCard {
  const view = card.sprint
  const timing: ReadPart<CardTiming> = card.timing.ok ? { ok: true, value: liveTiming(card.timing.value, card.sprintId) } : card.timing
  const times = new Map(card.timing.ok ? card.timing.value.tickets.map((ticket) => [ticket.ticketId, ticket]) : [])
  const outcomes = outcomesByTicket(view.outcomes, card.runId)
  const tickets = view.tickets
    .filter((ticket) => ticket.runId === card.runId)
    .map((ticket): TicketLine => {
      const time = times.get(ticket.ticketId)
      return {
        ticketId: ticket.ticketId,
        grade: ticket.grade,
        inputs: liveInputs(ticket.input),
        outcome: outcomes.get(ticket.ticketId) ?? null,
        times: time === undefined ? null : { cycleTime: time.cycleTime, leadTime: time.leadTime, active: time.active, effort: time.effort.total, overhead: time.effort.overhead }
      }
    })
  return {
    sprint: view.grade,
    inputs: liveInputs(view.input),
    run: null,
    epic: null,
    outcomes: view.outcomes,
    rollups: {
      T: { baseline: view.rollups.T.baseline !== null, partial: view.rollups.T.partial, overhead: view.rollups.T.overhead, uncovered: view.rollups.T.uncovered },
      K: { baseline: view.rollups.K.baseline !== null, partial: view.rollups.K.partial, overhead: view.rollups.K.overhead, uncovered: view.rollups.K.uncovered }
    },
    measures: liveMeasures(view),
    timing,
    tickets
  }
}

/** The card a read holds; null for a legacy report (nothing graded, nothing shown in its place). */
export function sprintCard(card: ReportCardView): SprintCard | null {
  switch (card.state) {
    case 'frozen':
      return frozenCard(card.scorecard)
    case 'live':
      return liveCard(card)
    case 'legacy':
      return null
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Names

/** The tickets of the plan the run executed, by id (none when that plan could not be read). */
export function ticketNames(bundle: PlanBundle | null): TicketNames {
  return planTicketNames(bundle === null ? [] : [bundle])
}

// ---------------------------------------------------------------------------------------------------------------
// Sprint outcome

export const OUTCOME_TONES: Readonly<Record<VerificationState, Tone>> = { verified: 'accepted', failed: 'failed', pending: 'running', missing: 'attention' }

/** How many counted outcomes of a role are verified, of how many; null when the role counts none. */
function tally(outcomes: readonly RequiredOutcome[], role: RequiredOutcome['role'], noun: string): string | null {
  const own = outcomes.filter((outcome) => outcome.counted && outcome.role === role)
  return own.length === 0 ? null : `${own.filter((outcome) => outcome.state === 'verified').length} of ${own.length} ${noun}`
}

/** The sprint's outcome in words: what is verified, and why the outcome is failed, unverified or verified. */
export function outcomeConclusion(card: SprintCard, names: TicketNames): string {
  const counted = card.outcomes.filter((outcome) => outcome.counted)
  if (counted.length === 0) {
    return 'No outcome counts toward this sprint yet (nothing was decided or awaits a decision), so the sprint is not verified.'
  }
  const parts = [tally(counted, 'work', 'feature ticket(s)'), tally(counted, 'integrated', 'integrated outcome(s)')].filter((part): part is string => part !== null)
  const head = `${parts.join(' and ')} verified`
  const list = (state: VerificationState[]): string =>
    counted
      .filter((outcome) => state.includes(outcome.state))
      .map((outcome) => ticketLabel(names, outcome.ticketId))
      .join(', ')
  switch (card.sprint.outcome) {
    case 'failed':
      return `${head}, yet the sprint failed: ${list(['failed']) || 'a mandatory check failed'}. A confirmed failure of a required or integrated outcome caps the grade at F.`
    case 'unverified': {
      const open = list(['pending', 'missing'])
      return open === '' ? `${head}, but the sprint is not verified.` : `${head}, but the sprint is not verified: ${open} pending or without reviewed evidence.`
    }
    case 'verified':
      return `${head}: every counted outcome, integrated ones included, is verified.`
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Resources

/**
 * A T or K actual summed over the measured runs: unavailable as soon as one has no number (never read as 0), and a
 * lower bound naming how many attempts reported nothing when any did, never a complete total.
 */
function measureSum(measures: readonly FrozenEfficiency[], pick: (measure: FrozenEfficiency) => { actual: Measurement; unreportedAttemptIds: string[] }, unit: 'tokens' | 'milliseconds'): string {
  if (measures.length === 0) {
    return 'unavailable (no run executed work)'
  }
  const parts = measures.map((measure) => pick(measure).actual)
  const missing = parts.find((part) => part.state === 'missing')
  if (missing !== undefined) {
    return measurementText(missing, unit)
  }
  const unreported = measures.reduce((sum, measure) => sum + pick(measure).unreportedAttemptIds.length, 0)
  const known = parts.filter((part): part is Exclude<Measurement, { state: 'missing' }> => part.state !== 'missing')
  const total = known.reduce((sum, part) => sum + part.value, 0)
  const estimated = parts.some((part) => part.state === 'estimated')
  if (unreported > 0) {
    return `≥ ${estimated ? '≈ ' : ''}${amountText(total, unit)} (a lower bound${estimated ? ', estimated in part' : ''}: ${unreported} attempt(s) reported nothing)`
  }
  if (parts.length === 1) {
    return measurementText(parts[0] as Measurement, unit)
  }
  return measurementText(estimated ? { state: 'estimated', value: total, method: 'some runs estimated' } : { state: 'observed', value: total }, unit)
}

/** Effort summed over the measured runs; a lower bound when some attempt reported no activity. */
function effortText(measures: readonly FrozenEfficiency[]): string {
  const efforts = measures.map((measure) => measure.effort)
  const reported = efforts.map((effort) => effort.effortMs).filter((ms): ms is number => ms !== null)
  if (efforts.length === 0 || reported.length < efforts.length) {
    return 'unavailable (no effort reported)'
  }
  const total = durationText(reported.reduce((sum, ms) => sum + ms, 0))
  const covered = efforts.reduce((sum, effort) => sum + effort.coverage.covered, 0)
  const of = efforts.reduce((sum, effort) => sum + effort.coverage.of, 0)
  return covered < of ? `≥ ${total} (a lower bound: ${covered} of ${of} attempt(s) reported activity)` : total
}

function overheadText(measures: readonly FrozenEfficiency[]): string {
  const values = measures.map((measure) => measure.effort.overheadMs)
  const reported = values.filter((value): value is number => value !== null)
  if (values.length === 0 || reported.length < values.length) {
    return 'unavailable (no review or orchestration span reported)'
  }
  return durationText(reported.reduce((sum, value) => sum + value, 0))
}

/**
 * A T or K actual as its grade read it. When some attempt reported nothing the number covers only the attempts that
 * did: it reads as a lower bound naming how many reported nothing, never as a complete total.
 */
function resourceText(input: ResourceInput | null, unit: 'tokens' | 'milliseconds'): string {
  if (input === null) {
    return 'unavailable'
  }
  const { actual, unreportedAttempts } = input
  if (unreportedAttempts === 0 || actual.state === 'missing') {
    return measurementText(actual, unit)
  }
  const estimated = actual.state === 'estimated'
  return `≥ ${estimated ? '≈ ' : ''}${amountText(actual.value, unit)} (a lower bound${estimated ? ', estimated in part' : ''}: ${unreportedAttempts} attempt(s) reported nothing)`
}

const ids = (measures: readonly FrozenEfficiency[], pick: (measure: FrozenEfficiency) => string[]): string[] => [...new Set(measures.flatMap(pick))]

/** Tokens, active time and effort the sprint grade read, with what the actual includes. */
export function resourceRows(card: SprintCard): FactRow[] {
  const { measures, inputs } = card
  const retries = measures.map((measure) => measure.retries)
  const counted = retries.filter((value): value is number => value !== null)
  return [
    { label: 'Tokens (K actual, overhead included)', value: inputs.K === null ? measureSum(measures, (measure) => measure.tokens, 'tokens') : resourceText(inputs.K, 'tokens') },
    { label: 'Active time (T actual, waits excluded)', value: inputs.T === null ? measureSum(measures, (measure) => measure.time, 'milliseconds') : resourceText(inputs.T, 'milliseconds') },
    { label: 'Effort (every actor, summed)', value: effortText(measures) },
    { label: 'Overhead (orchestration, review)', value: overheadText(measures) },
    { label: 'Corrective effort (E)', value: inputs.E === null ? 'unavailable' : measurementText(inputs.E.correctiveMs, 'milliseconds') },
    { label: 'Productive effort', value: inputs.E === null ? 'unavailable' : measurementText(inputs.E.productiveMs, 'milliseconds') },
    { label: 'Retries (a diagnostic, never waste)', value: retries.length === 0 || counted.length < retries.length ? 'unavailable' : String(counted.reduce((sum, value) => sum + value, 0)) }
  ]
}

/**
 * A timing quantity as the tab shows it. Frozen with a report, an interval still open at the report's cutoff ran on
 * after it: it reads as of the report, not as still running. A live one still running is a lower bound.
 */
function timeText(quantity: TimingQuantity, frozenAt: string | null): string {
  if (frozenAt === null || !quantity.open || quantity.ms === null) {
    return quantityText(quantity)
  }
  const state = quantity.state === 'observed' ? '' : `${quantity.state}; `
  return `${durationText(quantity.ms)} (${state}as of the report, ${localTime(frozenAt)}: still open then)`
}

/** Wall-clock and effort time of the sprint's window from the timing projection; waits are shown apart. */
export function timeRows(timing: CardTiming): FactRow[] {
  const sprint = timing.sprint
  if (sprint === null) {
    return [{ label: 'Sprint window', value: 'unavailable (the timing holds no window for this sprint)' }]
  }
  const at = timing.frozenAt
  return [
    { label: 'Sprint elapsed (activation → next sprint or cutoff)', value: timeText(sprint.elapsed, at) },
    { label: 'Work in flight (wall clock)', value: timeText(sprint.inFlight, at) },
    { label: 'Active (wall clock)', value: timeText(sprint.activeWallClock, at) },
    { label: 'Effort (summed over actors)', value: timeText(sprint.effort, at) },
    { label: 'Overhead in that effort', value: timeText(sprint.overhead, at) },
    { label: 'Waiting for checkpoint approval', value: timeText(sprint.checkpointWait, at) },
    { label: 'Run overhead in the window (no sprint’s)', value: timeText(sprint.unattributedOverhead, at) },
    { label: 'Run effort outside every sprint', value: timeText(timing.run.unattributedEffort, at) }
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Measurement coverage

function coverageText(quantity: TimingQuantity): string {
  if (quantity.state === 'missing') {
    return 'unavailable (nothing reported)'
  }
  const { covered, of, unit } = quantity.coverage
  return unit === 'attempts' ? `${covered} of ${of} attempt(s) reported` : `${of === 0 ? '0.0%' : percentText(covered / of)} of the window classified`
}

function attemptList(list: string[]): string {
  return list.length === 0 ? 'none' : `${list.length} (${list.join(', ')})`
}

function rollupText(facts: RollupFacts, names: TicketNames): string {
  const uncovered = facts.uncovered === null || facts.uncovered.length === 0 ? '' : ` (${facts.uncovered.map((ref) => ticketLabel(names, ref.ticketId)).join(', ')})`
  if (!facts.baseline) {
    return `no eligible baseline: no executed work ticket’s grade accepted one${uncovered}, so nothing is compared`
  }
  if (facts.partial) {
    return `partial: some executed work ticket has no baseline${uncovered}; its cost is left out of the comparison`
  }
  return 'complete: every executed work ticket brought a baseline'
}

/** How much of the sprint the measurements cover: components scored, attempts reported, baselines rolled up. */
export function coverageRows(card: SprintCard, names: TicketNames): FactRow[] {
  const missing = card.sprint.components.filter((component) => component.score === null)
  const graded = card.tickets.filter((ticket) => ticket.grade.letter !== null).length
  const effort = card.timing.ok ? card.timing.value.sprint?.effort : undefined
  return [
    { label: 'Grade coverage', value: `${percentText(card.sprint.coverage)} of base weight · ${card.sprint.scoredComponents} of ${card.sprint.components.length} components scored` },
    {
      label: 'Components without a score',
      value: missing.length === 0 ? 'none' : missing.map((component) => `${component.component} (${component.missingReason === null ? component.state : MISSING_REASON_LABELS[component.missingReason]})`).join(' · ')
    },
    { label: 'Tickets graded', value: `${graded} of ${card.tickets.length} with a letter` },
    { label: 'Attempts that reported no tokens', value: attemptList(ids(card.measures, (measure) => measure.tokens.unreportedAttemptIds)) },
    { label: 'Attempts that reported no active time', value: attemptList(ids(card.measures, (measure) => measure.time.unreportedAttemptIds)) },
    { label: 'Attempts still open at the cutoff', value: attemptList(ids(card.measures, (measure) => measure.tokens.openAttemptIds)) },
    { label: 'Effort reported', value: effort === undefined ? 'unavailable' : coverageText(effort) },
    { label: 'T baseline roll-up', value: rollupText(card.rollups.T, names) },
    { label: 'K baseline roll-up', value: rollupText(card.rollups.K, names) },
    { label: 'Timing anomalies', value: card.timing.ok ? String(card.timing.value.anomalies.length) : 'unavailable (timing read failed)' }
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Failure causes

interface FailureCause {
  /** The ticket it is about, when it is about one. */
  ticketId: string | null
  text: string
}

/** What failed or kept the sprint from a final grade, worst first: failed outcomes, unverified ones, then the rest. */
export function failureCauses(card: SprintCard): FailureCause[] {
  const counted = card.outcomes.filter((outcome) => outcome.counted)
  const outcomeCauses = (state: VerificationState): FailureCause[] =>
    counted.filter((outcome) => outcome.state === state).map((outcome) => ({ ticketId: outcome.ticketId, text: `${STATE_LABELS[outcome.state]}: ${REASON_LABELS[outcome.reason]}` }))
  const c = card.inputs.C
  const e = card.inputs.E
  const collaboration: FailureCause[] = c === null ? [] : [
    ...(c.rejected === undefined || c.rejected.submissions === 0 ? [] : [{ ticketId: null, text: `${c.rejected.submissions} submission(s) rejected in review` }]),
    ...(c.handoffChecks === null || c.handoffChecks.failed === 0 ? [] : [{ ticketId: null, text: `${c.handoffChecks.failed} handoff check(s) failed` }]),
    ...(c.coordinationDefects === 0 ? [] : [{ ticketId: null, text: `${c.coordinationDefects} coordination defect(s) recorded` }])
  ]
  const corrective: FailureCause[] =
    e !== null && e.correctiveMs.state !== 'missing' && e.correctiveMs.value > 0 ? [{ ticketId: null, text: `${durationText(e.correctiveMs.value)} of effort classified corrective` }] : []
  const status: FailureCause[] = card.sprint.statusReasons.map((reason) => ({ ticketId: null, text: `Status ${card.sprint.status}: ${STATUS_REASON_LABELS[reason]}` }))
  return [...outcomeCauses('failed'), ...outcomeCauses('missing'), ...outcomeCauses('pending'), ...collaboration, ...corrective, ...status]
}

/**
 * Overhead beside the causes: the overhead tickets the T and K roll-ups count as overhead (they have no baseline of
 * their own), the orchestration and review effort the grade read, and run overhead that fell in the sprint's window.
 */
export function overheadRows(card: SprintCard, names: TicketNames): FactRow[] {
  const tickets = [...new Set([...card.rollups.T.overhead, ...card.rollups.K.overhead].map((ref) => ticketLabel(names, ref.ticketId)))]
  const sprint = card.timing.ok ? card.timing.value.sprint : null
  const frozenAt = card.timing.ok ? card.timing.value.frozenAt : null
  return [
    { label: 'Overhead tickets (their cost counts as overhead in T and K)', value: tickets.length === 0 ? 'none' : tickets.join(', ') },
    { label: 'Orchestration and review effort', value: overheadText(card.measures) },
    { label: 'Run overhead in the sprint’s window (no ticket’s)', value: sprint === null ? 'unavailable' : timeText(sprint.unattributedOverhead, frozenAt) }
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Tickets

/** A ticket's line at a glance: its coverage, tokens and active time as its own grade read them, and where its S came from. */
export function ticketFacts(ticket: TicketLine): string[] {
  return [
    `coverage ${percentText(ticket.grade.coverage)}`,
    `tokens ${resourceText(ticket.inputs.K, 'tokens')}`,
    `active ${resourceText(ticket.inputs.T, 'milliseconds')}`,
    satisfactionLabel(ticket.grade)
  ]
}

export function ticketTimeRows(times: TicketTimes | null, frozenAt: string | null): FactRow[] {
  if (times === null) {
    return [{ label: 'Times', value: 'unavailable (the timing holds no entry for this ticket)' }]
  }
  return [
    { label: 'Cycle time (first claim → end)', value: timeText(times.cycleTime, frozenAt) },
    { label: 'Lead time (ready → end)', value: timeText(times.leadTime, frozenAt) },
    { label: 'Measured active (worker)', value: timeText(times.active, frozenAt) },
    { label: 'Effort (all actors)', value: timeText(times.effort, frozenAt) },
    { label: 'Effort by others (overhead)', value: timeText(times.overhead, frozenAt) }
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Run and epic at a glance

/** The sprint grade beside the run and epic grades frozen with the same report (a live read holds the sprint only). */
export function levelRows(card: SprintCard): FactRow[] {
  if (card.run === null) {
    return [{ label: 'Sprint (live)', value: summaryText(card.sprint) }]
  }
  return [
    { label: 'Sprint', value: summaryText(card.sprint) },
    { label: 'Run (so far, at the cutoff)', value: summaryText(card.run) },
    { label: 'Epic (so far)', value: card.epic === null ? 'not frozen with this report: only the final sprint’s report freezes the epic' : summaryText(card.epic) }
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Reassessment

const CAUSE_LABELS: Readonly<Record<DifferenceCause, string>> = {
  policy_changed: 'a newer rubric policy grades the same input differently',
  records_at_cutoff_changed: 'records at the approved cutoff changed since (imported later with earlier times)',
  later_records: 'records after the approval (late metrics, ratings, defects or decisions)',
  window_start_moved: 'the reassessed window starts at another dispatch'
}

const MEMBERSHIP_LABELS: Readonly<Record<ReassessedMembership, string>> = {
  kept: 'frozen with the report, still in the sprint',
  left: 'frozen with the report, since moved out of the sprint (still shown)',
  joined: 'joined the sprint after the report (nothing approved for it)',
  legacy: 'the report predates scorecards (nothing approved)'
}

/** A ticket's membership in the sprint; the sprint, run and epic are the report's own scopes. */
function membershipText(subject: SubjectReassessment): string {
  if (subject.subject.level === 'ticket' || subject.membership !== 'kept') {
    return MEMBERSHIP_LABELS[subject.membership]
  }
  return `the report’s own ${subject.subject.level}, frozen with it`
}

export function subjectLabel(subject: SubjectReassessment['subject'], names: TicketNames): string {
  return subject.level === 'ticket' ? ticketLabel(names, subject.id) : `${subject.level.charAt(0).toUpperCase()}${subject.level.slice(1)}`
}

/** Approved, same window regraded now, and now: three readings, each named. */
export function subjectRows(subject: SubjectReassessment, assessedAt: string): FactRow[] {
  return [
    { label: 'Approved (frozen)', value: subject.approved === null ? 'nothing approved' : `${summaryText(subject.approved)} · as of ${localTime(subject.windows.approved.to)}` },
    { label: 'Same window, regraded now', value: summaryText(subject.sameWindow) },
    { label: `Reassessed (${localTime(assessedAt)})`, value: summaryText(subject.current) },
    { label: 'Membership', value: membershipText(subject) },
    { label: 'Windows', value: subject.windows.note }
  ]
}

export function differenceText(difference: SubjectReassessment['differences'][number]): string {
  return `${difference.detail} — ${difference.causes.map((cause) => CAUSE_LABELS[cause]).join('; ')}`
}

/** Subjects with something to say first: any difference, then the aggregates, then the rest. */
export function orderedSubjects(subjects: readonly SubjectReassessment[]): SubjectReassessment[] {
  const rank = (subject: SubjectReassessment): number => (subject.differences.length > 0 ? 0 : 1) * 10 + (subject.subject.level === 'ticket' ? 1 : 0)
  return [...subjects].sort((a, b) => rank(a) - rank(b))
}
