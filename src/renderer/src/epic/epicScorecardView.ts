/**
 * Text and rows for the epic Scorecard, from the core's read models as they are. Nothing here grades: the epic grade
 * is the core's (computed from the epic's raw measures, never an average of sprint or ticket letters), and every total
 * is either the core's own or a plain sum of effort, which is a sum by definition. Elapsed time is never summed across
 * parallel work: wall time is the union of the runs' windows. A value the core has no number for reads "unavailable".
 */
import type { ScopeEfficiencyView } from '../../../shared/domain/efficiency'
import type { BaselineComparison, DeliveryInput, EfficiencyInput, Measurement, SpaceGrade, SpaceGradeInput } from '../../../shared/domain/space'
import type { ScopeItem } from '../../../shared/domain/spaceSignals'
import type { FrozenAggregate, ObservationWindow, RequiredOutcome, ScorecardAggregateView, ScorecardSnapshot, SubjectReassessment } from '../../../shared/domain/spaceGrades'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { OutcomeBucket, TimingQuantity } from '../../../shared/domain/timing'
import type { RunView } from '../../../shared/domain/views'
import type { FactRow } from '../scorecard/ScorecardParts'
import type { EpicAssessment, EpicCardView, EpicRunTiming, SprintAssessment } from '../scorecard/scoreReads'
import { amountText, durationText, localTime, measurementText, MISSING_REASON_LABELS, quantityText, summaryText } from '../scorecard/scorecardFormat'
import { outcomeText, planTicketNames, ticketLabel, type TicketNames } from '../scorecard/outcomeLabels'

interface TicketRef {
  runId: string
  ticketId: string
}

/** Every ticket the read plans name (and the plan shown), so outcomes of removed tickets keep their key and title. */
export function epicTicketNames(card: EpicCardView, shown: PlanBundle | null): TicketNames {
  return planTicketNames([...card.runs.flatMap((entry) => (entry.read.ok ? [entry.read.value.bundle] : [])), ...(shown === null ? [] : [shown])])
}

/** `Run #N` as the app names runs, the id when the run could not be read. */
export function runLabel(card: EpicCardView, runId: string): string {
  const read = card.runs.find((entry) => entry.runId === runId)?.read
  return read?.ok === true ? `Run #${read.value.run.number}` : `Run ${runId}`
}

// ---------------------------------------------------------------------------------------------------------------
// The graded epic, live or frozen, in one shape

/** One run's share of the epic's usage, as the core read it (the grade's measured runs, or an unmeasured run's own read). */
interface RunMeasure {
  runId: string
  effortMs: number | null
  overheadMs: number | null
  activeTime: Measurement
  tokens: Measurement
  /** As far as reported when the actual is missing (a lower bound); null when nothing numeric was, or not kept (frozen). */
  reported: { activeTime: number | null; tokens: number | null }
  retries: number | null
  /** Corrective effort by cause; null when the source does not keep it (a frozen snapshot keeps the totals only). */
  correctiveByCause: Partial<Record<string, number>> | null
}

/** A run scope's efficiency read as its share of the epic's usage. */
function scopeMeasure(runId: string, scope: ScopeEfficiencyView): RunMeasure {
  return {
    runId,
    effortMs: scope.classification.denominator.effortMs,
    overheadMs: scope.classification.denominator.overheadMs,
    activeTime: scope.time.actual,
    tokens: scope.tokens.actual,
    reported: { activeTime: scope.time.reportedValue, tokens: scope.tokens.reportedValue },
    retries: scope.classification.retries.retries,
    correctiveByCause: scope.classification.correctiveByCause
  }
}

interface RollupFacts {
  partial: boolean
  /** Executed work tickets whose grade accepted no baseline; null when the source does not list them (frozen). */
  uncovered: TicketRef[] | null
}

/** What every graded section reads, whether the epic grade is live or frozen. */
export interface GradedEpic {
  grade: SpaceGrade
  frozen: boolean
  delivery: DeliveryInput
  efficiency: EfficiencyInput
  /** The committed, removed and added items by name; null when frozen (the snapshot keeps the counts). */
  scope: { committed: ScopeItem[]; removed: ScopeItem[]; added: ScopeItem[] } | null
  outcomes: RequiredOutcome[]
  rollups: { T: RollupFacts; K: RollupFacts }
  measures: RunMeasure[]
  resources: { T: Measurement; K: Measurement }
  rejectedSubmissions: number
}

type Inputs = SpaceGradeInput['components']

/** A property only each component's input has: a stored input is read as that component's only when it holds it. */
const INPUT_SHAPES = { A: 'committed', C: 'coordinationDefects', E: 'correctiveMs', T: 'actual', K: 'actual' } as const

/** One stored input of a frozen aggregate, narrowed to its component's shape; null when it is absent or does not fit. */
function storedInput<C extends keyof typeof INPUT_SHAPES>(snapshot: ScorecardSnapshot, aggregate: FrozenAggregate, component: C): Inputs[C] | null {
  const input = snapshot.inputs[aggregate.inputs[component]]
  if (input === undefined || !(INPUT_SHAPES[component] in input)) return null
  // The `in` check above is the shape test: only this component's input holds that property.
  const typed = input as Inputs[C]
  return typed
}

/** A frozen aggregate (the epic's or a sprint's) with its stored inputs; null when they cannot be read as such. */
function frozenGraded(snapshot: ScorecardSnapshot, frozen: FrozenAggregate, view: ScorecardAggregateView): GradedEpic | null {
  const [A, C, E, T, K] = [storedInput(snapshot, frozen, 'A'), storedInput(snapshot, frozen, 'C'), storedInput(snapshot, frozen, 'E'), storedInput(snapshot, frozen, 'T'), storedInput(snapshot, frozen, 'K')]
  if (A === null || C === null || E === null || T === null || K === null) return null
  const detail = view.detail
  return {
    grade: view.grade,
    frozen: true,
    delivery: A,
    efficiency: E,
    scope: null,
    outcomes: detail.outcomes,
    rollups: { T: { partial: detail.rollups.T.partial, uncovered: null }, K: { partial: detail.rollups.K.partial, uncovered: null } },
    measures: detail.efficiency.map((entry) => ({
      runId: entry.runId,
      effortMs: entry.effort.effortMs,
      overheadMs: entry.effort.overheadMs,
      activeTime: entry.time.actual,
      tokens: entry.tokens.actual,
      reported: { activeTime: null, tokens: null },
      retries: entry.retries,
      correctiveByCause: null
    })),
    resources: { T: T.actual, K: K.actual },
    rejectedSubmissions: C.rejected?.submissions ?? 0
  }
}

/** A live aggregate grade (the epic's or a sprint's) as the core read it. */
function liveGraded(view: Extract<EpicAssessment, { state: 'live' }>['view']): GradedEpic {
  const { components } = view.input
  return {
    grade: view.grade,
    frozen: false,
    delivery: components.A,
    efficiency: components.E,
    scope: { committed: view.sources.signals.A.committed, removed: view.sources.signals.A.removed, added: view.sources.signals.A.added },
    outcomes: view.outcomes,
    rollups: {
      T: { partial: view.rollups.T.partial, uncovered: view.rollups.T.uncovered },
      K: { partial: view.rollups.K.partial, uncovered: view.rollups.K.uncovered }
    },
    measures: view.sources.efficiency.map((scope, index) => scopeMeasure(view.measuredRunIds[index] ?? '', scope)),
    resources: { T: components.T.actual, K: components.K.actual },
    rejectedSubmissions: components.C.rejected?.submissions ?? 0
  }
}

/** The epic's graded facts; null for a legacy or never-frozen completed epic (nothing graded, nothing shown). */
export function gradedEpic(assessment: EpicAssessment): GradedEpic | null {
  switch (assessment.state) {
    case 'live':
      return liveGraded(assessment.view)
    case 'frozen':
      return assessment.snapshot.epic === null ? null : frozenGraded(assessment.snapshot, assessment.snapshot.epic, assessment.view)
    default:
      return null
  }
}

/** A sprint's graded facts, live or frozen; null for a legacy or unreported sprint. */
export function gradedSprint(assessment: SprintAssessment): GradedEpic | null {
  switch (assessment.state) {
    case 'live':
      return liveGraded(assessment.view)
    case 'frozen':
      return frozenGraded(assessment.snapshot, assessment.snapshot.sprint, assessment.view)
    default:
      return null
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Original scope and outcomes

/** The original scope frozen at first dispatch, what of it was delivered, and how the plan changed since. */
export function scopeRows(graded: GradedEpic): FactRow[] {
  const { committed, delivered, added, removed } = graded.delivery
  const names = (items: ScopeItem[] | undefined): string => (items === undefined || items.length === 0 ? '' : `: ${items.map((item) => item.label).join(', ')}`)
  return [
    { label: 'Committed before dispatch', value: committed === null ? 'unavailable (no scope frozen before dispatch)' : `${committed} ticket(s)` },
    { label: 'Delivered of that scope', value: committed === null ? 'unavailable' : `${delivered} of ${committed} (accepted, every committed criterion verified)` },
    { label: 'Removed after dispatch', value: `${removed} (still counted as committed)${names(graded.scope?.removed)}` },
    { label: 'Added after dispatch', value: `${added} (shown apart, never counted as delivered scope)${names(graded.scope?.added)}` }
  ]
}

const counted = (outcomes: readonly RequiredOutcome[]): RequiredOutcome[] => outcomes.filter((outcome) => outcome.counted)

/** How many counted outcomes of a role are verified, of how many. */
function outcomeTally(outcomes: readonly RequiredOutcome[], role: RequiredOutcome['role']): { verified: number; of: number } {
  const own = counted(outcomes).filter((outcome) => outcome.role === role)
  return { verified: own.filter((outcome) => outcome.state === 'verified').length, of: own.length }
}

/**
 * Why the epic stands where it does, in words: accepted feature tickets beside the outcomes that decide the epic. A
 * confirmed failure of any counted outcome fails the epic however many tickets were accepted.
 */
export function outcomeConclusion(graded: GradedEpic, names: TicketNames): string {
  const work = outcomeTally(graded.outcomes, 'work')
  const integrated = outcomeTally(graded.outcomes, 'integrated')
  const head = `${work.verified} of ${work.of} feature ticket(s) and ${integrated.verified} of ${integrated.of} integrated outcome(s) are verified`
  const failed = counted(graded.outcomes).filter((outcome) => outcome.state === 'failed')
  const open = counted(graded.outcomes).filter((outcome) => outcome.state === 'pending' || outcome.state === 'missing')
  const list = (items: RequiredOutcome[]): string => items.map((outcome) => ticketLabel(names, outcome.ticketId)).join(', ')
  const subject = graded.grade.subject.level
  switch (graded.grade.outcome) {
    case 'failed':
      return `${head}, yet the ${subject} failed: ${list(failed) || 'a mandatory check failed'}. A confirmed failure of a required or integrated outcome caps the grade at F, so completed tickets alone do not make the ${subject} a success.`
    case 'unverified':
      return `${head}, but the ${subject} is not verified: ${open.length} counted outcome(s) are pending or lack reviewed evidence${open.length === 0 ? '' : ` (${list(open)})`}. Completed tickets alone do not prove it succeeded.`
    case 'verified':
      return `${head}: every counted outcome, integrated ones included, is verified.`
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Resources

const asMeasurement = (ms: number | null): Measurement => (ms === null ? { state: 'missing', reason: 'not_reported' } : { state: 'observed', value: ms })

/** One covered run's usage, or why the card holds none for it (a frozen card keeps only the measured runs'). */
export type RunUsage = { runId: string; measure: RunMeasure } | { runId: string; measure: null; reason: string }

/**
 * Every run the card covers with its usage: the grade's own for the runs it measured, an open epic's unmeasured run's
 * own read (a run that executed no work may still have recorded overhead), else named with why there is none.
 */
export function runUsages(card: EpicCardView, graded: GradedEpic | null): RunUsage[] {
  return card.runs.map(({ runId, read }): RunUsage => {
    const measured = graded?.measures.find((measure) => measure.runId === runId)
    if (measured !== undefined) return { runId, measure: measured }
    if (!read.ok) return { runId, measure: null, reason: 'its read failed' }
    const usage = read.value.usage
    if (usage === null) return { runId, measure: null, reason: 'no usage was frozen for it' }
    return usage.ok ? { runId, measure: scopeMeasure(runId, usage.value) } : { runId, measure: null, reason: `its usage read failed (${usage.error.message})` }
  })
}

interface Share {
  amount: number | null
  estimated: boolean
  /** Why this run's part is missing or only a lower bound. */
  note: string | null
}

type Pick = (measure: RunMeasure) => { value: Measurement; reported: number | null }

function shareOf(card: EpicCardView, usage: RunUsage, unit: 'tokens' | 'milliseconds', pick: Pick): Share {
  const label = runLabel(card, usage.runId)
  if (usage.measure === null) return { amount: null, estimated: false, note: `${label}: ${usage.reason}` }
  const { value, reported } = pick(usage.measure)
  if (value.state !== 'missing') return { amount: value.value, estimated: value.state === 'estimated', note: null }
  const counted = reported === null ? '' : `, ${amountText(reported, unit)} of it reported and counted`
  return { amount: reported, estimated: false, note: `${label}: ${MISSING_REASON_LABELS[value.reason]}${counted}` }
}

/**
 * A quantity summed over every covered run (tokens, or time summed over actors, which is a sum by definition): the
 * whole of each run, every attempt and its overhead included. A run without a number is named and the total reads as
 * a lower bound (never as if that run used 0); estimated when any part is.
 */
function runSum(card: EpicCardView, usages: readonly RunUsage[], unit: 'tokens' | 'milliseconds', pick: Pick): string {
  if (usages.length === 0) return 'unavailable (no run)'
  const shares = usages.map((usage) => shareOf(card, usage, unit, pick))
  const amounts = shares.flatMap((share) => (share.amount === null ? [] : [share.amount]))
  const notes = shares.flatMap((share) => (share.note === null ? [] : [share.note]))
  if (amounts.length === 0) return `unavailable (${notes.join('; ')})`
  const total = amountText(amounts.reduce((sum, amount) => sum + amount, 0), unit)
  const estimated = shares.some((share) => share.estimated)
  if (notes.length > 0) return `≥ ${estimated ? '≈ ' : ''}${total} (a lower bound${estimated ? ', estimated in part' : ''}: ${notes.join('; ')})`
  return estimated ? `≈ ${total} (estimated in part)` : total
}

/** Retries over the runs: a run with no attempt has none to retry (the core's null); a run without usage is named. */
function retriesText(card: EpicCardView, usages: readonly RunUsage[]): string {
  const unread = usages.filter((usage) => usage.measure === null).map((usage) => `${runLabel(card, usage.runId)} unavailable`)
  const idle = usages.filter((usage) => usage.measure !== null && usage.measure.retries === null).map((usage) => `${runLabel(card, usage.runId)} ran no attempt`)
  if (unread.length === usages.length) return 'unavailable'
  const total = usages.reduce((sum, usage) => sum + (usage.measure?.retries ?? 0), 0)
  const notes = ['a diagnostic, never scored as waste', ...idle, ...unread].join('; ')
  return `${unread.length === 0 ? '' : '≥ '}${total} (${notes})`
}

/**
 * The epic's totals over every run it covers: each run's whole usage (every attempt, retried, abandoned or superseded,
 * and its overhead, also in a run that executed no work), effort summed over actors, and the E split. The T and K
 * actuals the grade compares (which leave out a partial roll-up's uncovered tickets) are shown with the comparisons.
 */
export function totalRows(card: EpicCardView, graded: GradedEpic): FactRow[] {
  const usages = runUsages(card, graded)
  const counted = usages.map((usage) => (usage.measure === null ? `${runLabel(card, usage.runId)} (no usage: ${usage.reason})` : runLabel(card, usage.runId)))
  return [
    { label: 'Tokens (every attempt and overhead)', value: runSum(card, usages, 'tokens', (measure) => ({ value: measure.tokens, reported: measure.reported.tokens })) },
    { label: 'Active time (every actor, waits excluded)', value: runSum(card, usages, 'milliseconds', (measure) => ({ value: measure.activeTime, reported: measure.reported.activeTime })) },
    { label: 'Effort (every actor, parallel work added up)', value: runSum(card, usages, 'milliseconds', (measure) => ({ value: asMeasurement(measure.effortMs), reported: null })) },
    { label: 'Overhead inside that effort (orchestration, review, verification)', value: runSum(card, usages, 'milliseconds', (measure) => ({ value: asMeasurement(measure.overheadMs), reported: null })) },
    { label: 'Corrective effort (E, as classified in the runs the grade measured)', value: measurementText(graded.efficiency.correctiveMs, 'milliseconds') },
    { label: 'Productive effort (E, as classified in those runs)', value: measurementText(graded.efficiency.productiveMs, 'milliseconds') },
    { label: 'Unclassified effort (E, in those runs)', value: measurementText(graded.efficiency.unclassifiedMs, 'milliseconds') },
    { label: 'Retried attempts', value: retriesText(card, usages) },
    { label: 'Runs counted', value: counted.length === 0 ? 'none' : counted.join(', ') }
  ]
}

/** A run's window: from its timing (live, or frozen with its last report), else its own server lifecycle once ended. */
interface Window {
  runId: string
  start: number
  end: number
  /** Its active wall clock (a union); null when only the lifecycle window is known or nothing was measured. */
  activeMs: number | null
  /**
   * Set when the window was still open at its timing's cutoff: its activity runs only to then. A frozen window of a
   * run that has since ended runs to the run's lifecycle end (`ended`); otherwise the window too stops at the cutoff.
   */
  open: { asOf: string; frozen: boolean; ended: string | null } | null
}

function lifecycleWindow(runId: string, run: RunView): Window | string {
  if (run.startedAt === null) return 'it never started'
  if (run.endedAt === null) return 'it has not ended and no timing was frozen for it'
  return { runId, start: Date.parse(run.startedAt), end: Date.parse(run.endedAt), activeMs: null, open: null }
}

function windowOf(entry: EpicCardView['runs'][number]): Window | string {
  if (!entry.read.ok) return 'its read failed'
  const { timing, run } = entry.read.value
  if (!timing.ok) return 'its timing read failed'
  if (timing.value.state === 'none') return lifecycleWindow(entry.runId, run)
  const frozen = timing.value.state === 'frozen'
  const window = timing.value.state === 'live' ? timing.value.timing : timing.value.timing.run
  if (window.startedAt === null) return 'it never started'
  const ended = frozen ? run.endedAt : null
  const open = window.endedAt === null ? { asOf: timing.value.timing.asOf, frozen, ended } : null
  const end = window.endedAt ?? (ended === null ? timing.value.timing.asOf : new Date(Math.max(Date.parse(ended), Date.parse(timing.value.timing.asOf))).toISOString())
  return { runId: entry.runId, start: Date.parse(window.startedAt), end: Date.parse(end), activeMs: window.activeWallClock.ms, open }
}

/** Milliseconds covered by the union of the windows (overlapping time counted once). */
function unionMs(windows: readonly Window[]): number {
  const sorted = [...windows].sort((a, b) => a.start - b.start)
  let total = 0
  let reach = Number.NEGATIVE_INFINITY
  for (const window of sorted) {
    const from = Math.max(window.start, reach)
    if (window.end > from) total += window.end - from
    reach = Math.max(reach, window.end)
  }
  return total
}

/** Why a window still open at its cutoff limits the total; null when it limits nothing (`wall` false: its activity). */
function openNote(card: EpicCardView, window: Window, wall: boolean): string | null {
  if (window.open === null) return null
  const label = runLabel(card, window.runId)
  const { asOf, frozen, ended } = window.open
  if (!frozen) return `${label} is still running: as of ${localTime(asOf)}`
  if (ended === null) return `${label}: as of its last report, ${localTime(asOf)}; it went on after it`
  // The window runs to the run's end; only the activity after its last report was never frozen.
  return wall ? null : `${label}: activity as of its last report, ${localTime(asOf)}; the run ended ${localTime(ended)}`
}

/** A duration with what limits it: a lower bound (`≥`) whenever any run is missing or still open at its cutoff. */
function qualified(ms: number, notes: readonly string[]): string {
  return notes.length === 0 ? durationText(ms) : `≥ ${durationText(ms)} (${notes.join('; ')})`
}

/**
 * Wall time across the runs: the union of their windows, never a sum of parallel time. A completed epic's run with no
 * frozen timing counts with its own server lifecycle (immutable once it ended); a window still open at its timing's
 * cutoff makes the total "as of" that time, except a frozen window of a run that has since ended, which runs to the
 * run's lifecycle end (only its activity stops at its last report). Active wall clock adds up only
 * when no two run windows overlap (each run's own figure is already a union); otherwise it is not combined.
 */
export function wallRows(card: EpicCardView): FactRow[] {
  if (card.runs.length === 0) return [{ label: 'Wall time', value: 'unavailable (no run)' }]
  const read = card.runs.map((entry) => ({ runId: entry.runId, window: windowOf(entry) }))
  const windows = read.flatMap((entry) => (typeof entry.window === 'string' ? [] : [entry.window]))
  const missing = read.flatMap((entry) => (typeof entry.window === 'string' ? [`${runLabel(card, entry.runId)}: ${entry.window}`] : []))
  if (windows.length === 0) return [{ label: 'Wall time (union of run windows)', value: `unavailable (${missing.join('; ')})` }]
  const open = windows.flatMap((window) => openNote(card, window, true) ?? [])
  const union = unionMs(windows)
  const disjoint = union === windows.reduce((sum, window) => sum + (window.end - window.start), 0)
  // One note per run: a run with no activity measured is named for that alone, else for activity cut at its cutoff.
  const activeNotes = windows.flatMap((window) => (window.activeMs === null ? [`${runLabel(card, window.runId)}: no activity measured or frozen`] : (openNote(card, window, false) ?? [])))
  const unmeasured = windows.filter((window) => window.activeMs === null)
  const active = windows.reduce((sum, window) => sum + (window.activeMs ?? 0), 0)
  const activeText = unmeasured.length === windows.length ? `unavailable (${[...activeNotes, ...missing].join('; ')})` : qualified(active, [...activeNotes, ...missing])
  return [
    { label: 'Wall time (union of run windows)', value: qualified(union, [...open, ...missing]) },
    { label: 'Someone measurably working (active wall clock)', value: disjoint ? activeText : 'not combined (run windows overlap)' }
  ]
}

const BUCKET_LABELS: Readonly<Record<OutcomeBucket, string>> = {
  accepted: 'accepted',
  rejected: 'rejected (retried)',
  awaiting_review: 'awaiting review',
  failed: 'failed',
  canceled: 'canceled (abandoned)',
  lease_expired: 'lease expired (abandoned)',
  open: 'still open',
  superseded: 'superseded by a plan change',
  unscoped: 'run and sprint overhead (no attempt)'
}

/** A run with no frozen timing: its own server lifecycle, and that its activity was never frozen. */
function lifecycleRows(run: RunView): FactRow[] {
  const window = run.startedAt !== null && run.endedAt !== null ? `${durationText(Date.parse(run.endedAt) - Date.parse(run.startedAt))} (${localTime(run.startedAt)} → ${localTime(run.endedAt)})` : 'unavailable (it has not both started and ended)'
  return [
    { label: 'Run lifecycle (server start → end)', value: window },
    { label: 'Measured activity', value: 'unavailable (no report of this run froze its timing)' }
  ]
}

/** A frozen timing quantity: one still open at the run's last report is a lower bound as of that report, never "running". */
function frozenQuantity(quantity: TimingQuantity, asOf: string): string {
  if (!quantity.open || quantity.ms === null || quantity.state === 'missing') return quantityText(quantity)
  const estimated = quantity.state === 'observed' ? '' : `${quantity.state}; `
  return `≥ ${durationText(quantity.ms)} (${estimated}open at its last report, ${localTime(asOf)}; a lower bound)`
}

/** One run's wall-clock and effort figures, live or as frozen with its last report, else its lifecycle. */
export function runTimingRows(run: RunView, timing: EpicRunTiming): FactRow[] {
  if (timing.state === 'none') return lifecycleRows(run)
  const live = timing.state === 'live'
  const window = live ? timing.timing : timing.timing.run
  const text = (quantity: TimingQuantity): string => (live ? quantityText(quantity) : frozenQuantity(quantity, timing.timing.asOf))
  const rows: FactRow[] = [
    { label: 'Window (start → end)', value: text(window.elapsed) },
    { label: 'Any attempt open (union)', value: text(window.inFlight) },
    { label: 'Active wall clock (union)', value: text(window.activeWallClock) },
    { label: 'Effort (every actor, summed)', value: text(live ? timing.timing.effort.total : timing.timing.run.effort) },
    { label: 'Overhead effort', value: text(live ? timing.timing.effort.overhead : timing.timing.run.overhead) }
  ]
  if (timing.state === 'frozen') return [...rows, { label: 'Frozen with', value: `report revision ${timing.reportRevision}, as of ${localTime(timing.timing.asOf)}` }]
  const buckets = Object.entries(timing.timing.effortByOutcome).map(([bucket, total]) => `${BUCKET_LABELS[bucket as OutcomeBucket]}: ${total.attempts} attempt(s), ${durationText(total.effortMs)}${total.unreported > 0 ? `, ${total.unreported} reported nothing` : ''}`)
  return [...rows, { label: 'Effort by how attempts ended', value: buckets.length === 0 ? 'none yet' : buckets.join(' · ') }]
}

/** The run's own usage as counted in the totals, or why there is none. */
export function runUsageRows(usage: RunUsage): FactRow[] {
  if (usage.measure === null) return [{ label: 'Usage', value: `unavailable (${usage.reason})` }]
  const { measure } = usage
  return [
    { label: 'Tokens', value: measurementText(measure.tokens, 'tokens') },
    { label: 'Active time', value: measurementText(measure.activeTime, 'milliseconds') },
    { label: 'Effort', value: measure.effortMs === null ? 'unavailable (no effort reported)' : durationText(measure.effortMs) },
    { label: 'Retried attempts', value: measure.retries === null ? 'unavailable' : String(measure.retries) }
  ]
}

// ---------------------------------------------------------------------------------------------------------------
// Failure causes

interface FailureCause {
  text: string
  ticketId: string | null
}

/** Corrective effort by cause over the measured runs, largest first; null when the source keeps no causes. */
function correctiveCauses(measures: readonly RunMeasure[]): FailureCause[] | null {
  const kept = measures.map((measure) => measure.correctiveByCause).filter((byCause): byCause is Partial<Record<string, number>> => byCause !== null)
  if (kept.length < measures.length) return null
  const totals = new Map<string, number>()
  for (const byCause of kept) {
    for (const [cause, ms] of Object.entries(byCause)) totals.set(cause, (totals.get(cause) ?? 0) + (ms ?? 0))
  }
  return [...totals].sort((a, b) => b[1] - a[1]).map(([cause, ms]) => ({ text: `Corrective effort, cause ${cause.replaceAll('_', ' ')}: ${durationText(ms)}`, ticketId: null }))
}

/**
 * The causes that decide or weigh most on the epic: confirmed failures of counted outcomes (integrated first, each
 * caps the grade at F), counted outcomes still unverified, rejected submissions and corrective effort by cause.
 */
export function failureCauses(graded: GradedEpic, names: TicketNames): FailureCause[] {
  const order = (outcome: RequiredOutcome): number => (outcome.role === 'integrated' ? 0 : 1)
  const failed = counted(graded.outcomes)
    .filter((outcome) => outcome.state === 'failed')
    .sort((a, b) => order(a) - order(b))
    .map((outcome) => ({ text: `${ticketLabel(names, outcome.ticketId)} — ${outcomeText(outcome, false)}; caps the grade at F`, ticketId: outcome.ticketId }))
  const open = counted(graded.outcomes)
    .filter((outcome) => outcome.state === 'pending' || outcome.state === 'missing')
    .sort((a, b) => order(a) - order(b))
    .map((outcome) => ({ text: `${ticketLabel(names, outcome.ticketId)} — ${outcomeText(outcome, false)}`, ticketId: outcome.ticketId }))
  const rejected = graded.rejectedSubmissions === 0 ? [] : [{ text: `${graded.rejectedSubmissions} submission(s) rejected by review (their passed checks count as failed in C)`, ticketId: null }]
  return [...failed, ...open, ...rejected, ...(correctiveCauses(graded.measures) ?? [])]
}

// ---------------------------------------------------------------------------------------------------------------
// Comparisons

export interface Comparison {
  label: string
  comparable: boolean
  text: string
}

/** The roll-up T or K is compared with and the actual, or why the two cannot be compared. */
function rollupPair(graded: GradedEpic, component: 'T' | 'K', names: TicketNames): { gap: string } | { baseline: BaselineComparison; actual: number } {
  const baseline = graded.grade.components.find((result) => result.component === component)?.explanation.baseline ?? null
  const rollup = graded.rollups[component]
  const actual = graded.resources[component]
  if (actual.state === 'missing') return { gap: `the actual is unavailable (${MISSING_REASON_LABELS[actual.reason]})` }
  if (rollup.partial) {
    const uncovered = rollup.uncovered === null ? '' : `: ${rollup.uncovered.map((ref) => ticketLabel(names, ref.ticketId)).join(', ')}`
    return { gap: `insufficient: executed work ticket(s) without a baseline of their own leave the roll-up partial${uncovered}` }
  }
  if (baseline === null) return { gap: 'insufficient: no executed ticket’s grade accepted a budget or cohort baseline to roll up' }
  if (baseline.refusedReason !== null) return { gap: `the grader refused the roll-up (${baseline.refusedReason.replaceAll('_', ' ')})` }
  return { baseline, actual: actual.value }
}

/**
 * T and K beside their roll-up: the baselines the epic's own ticket grades accepted (a budget, or a cohort of
 * compatible prior tickets), each ticket once. Shown only when the roll-up is complete and the grader accepted it.
 */
export function resourceComparisons(graded: GradedEpic, names: TicketNames): Comparison[] {
  return (['T', 'K'] as const).map((component) => {
    const unit = component === 'K' ? 'tokens' : 'milliseconds'
    const label = component === 'K' ? 'Tokens (K) against the roll-up' : 'Active time (T) against the roll-up'
    const pair = rollupPair(graded, component, names)
    if ('gap' in pair) return { label, comparable: false, text: `Not compared: ${pair.gap}.` }
    const { baseline, actual } = pair
    const share = baseline.value === 0 ? '' : ` (${Math.round((actual / baseline.value) * 100)}% of it)`
    const text = `${measurementText(graded.resources[component], unit)} against a roll-up of ${baseline.sampleSize ?? 0} ticket baseline(s), ${amountText(baseline.value, unit)}${share}.`
    return { label, comparable: true, text }
  })
}

/** The two observation windows in the one local time format (the core's own note carries raw ISO times). */
function windowsText(windows: SubjectReassessment['windows']): string {
  const span = (window: ObservationWindow): string => `${window.from === null ? 'no dispatch' : localTime(window.from)} → ${localTime(window.to)}`
  return `frozen window ${span(windows.approved)}; current window ${span(windows.current)}`
}

/** The frozen epic grade beside its reassessment: compared only on comparable windows under one policy. */
export function reassessmentComparison(subject: SubjectReassessment): Comparison {
  const label = 'Frozen epic grade against the records now'
  const { approved, current } = subject
  if (approved === null || current === null) return { label, comparable: false, text: `Not compared: ${approved === null ? 'nothing was frozen for the epic' : 'the epic is no longer graded'}.` }
  if (!subject.windows.comparable) return { label, comparable: false, text: `Not compared: the observation windows start at different dispatches (${windowsText(subject.windows)}).` }
  if (approved.policyHash !== current.policyHash) return { label, comparable: false, text: 'Not compared: the policy changed since the grade was frozen; the same-window regrade shows the policy’s effect.' }
  return { label, comparable: true, text: `Frozen ${summaryText(approved)} · same window regraded now ${summaryText(subject.sameWindow)} · now ${summaryText(current)} (both from the first dispatch; ${windowsText(subject.windows)}).` }
}

