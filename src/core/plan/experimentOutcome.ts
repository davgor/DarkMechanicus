/**
 * An experiment's corrective work assessed against the experiment itself (`ExperimentOutcome`,
 * `src/shared/domain/experiments.ts`). Pure: the caller supplies the frozen definition, its events, the corrective
 * tickets found by their correction markers, the frozen scorecards of the experiment's epic and of the follow-up epics
 * holding its work (by report id, and where each scope starts) and the planned sizes of tickets. Only frozen values are
 * read: the baseline as the definition froze it, each result as its event recorded it, and guardrails from the frozen
 * grade a result cites. Nothing is regraded.
 *
 * A result is placed first: it must cite a frozen grade here, at the baseline's level, other than the baseline's own,
 * whose window starts once the corrective work landed and falls within the experiment's window (counted in the epic
 * holding that grade). A guardrail breached on a placed result decides: the result, and the experiment, are
 * `regressed`, whatever the measure did and even when its value is missing or estimated. Otherwise the result is
 * compared with the baseline when the two are comparable: observed values in one unit, one policy for scores, one task
 * scope (an additive measure of a run, sprint or epic per ticket in scope, with the same mix of planned sizes; a
 * ticket's total only with a ticket of the same planned size); else it is `insufficient_evidence`, with every reason.
 * An unreadable guardrail keeps an apparent improvement from counting, and so does a result citing a frozen grade this
 * machine cannot read (not here, failing its seal, or not what the result states): that grade may hold a breach.
 * Without a breach the outcome is the latest result that could be compared.
 */
import type { TicketSize } from '../../shared/domain/bundle'
import {
  EXPERIMENT_MEASURES,
  type ExperimentChange,
  type ExperimentComparison,
  type ExperimentCorrectionTicket,
  type ExperimentEvent,
  type ExperimentGuardrail,
  type ExperimentGuardrailCheck,
  type ExperimentLanding,
  type ExperimentMeasure,
  type ExperimentOutcome,
  type ExperimentOutcomeClass,
  type ExperimentReading,
  type ExperimentStatus,
  type ExperimentScopeStarts,
  type ExperimentWindow,
  type RetroExperiment
} from '../../shared/domain/experiments'
import type { FrozenGrade, ScorecardSnapshot } from '../../shared/domain/spaceGrades'
import { ownAssessment, readMeasure, resultProblem, sealedAssessment } from './experiments'

/** Where the scopes of one frozen scorecard start (their first dispatch): what window positions are counted from. */
export type ScorecardStarts = ExperimentScopeStarts

export interface OutcomeInput {
  experiment: RetroExperiment
  status: ExperimentStatus
  /** Every event of the experiment, in number order. */
  events: ExperimentEvent[]
  /**
   * A frozen scorecard of the experiment's epic or of a follow-up epic holding its work, by report id (undefined: not
   * here, or not one of those epics; null: the report predates scorecards).
   */
  scorecard: (reportId: string) => ScorecardSnapshot | null | undefined
  /** Every frozen scorecard of those epics. */
  starts: ScorecardStarts[]
  corrections: ExperimentCorrectionTicket[]
  /** A ticket's planned size in a plan revision; null when unsized or unknown here. */
  sizeOf: (planRevisionId: string, ticketId: string) => TicketSize | null
}

const OBSERVATIONAL_CAVEAT =
  'Observational: the baseline and the result measure different work in different windows, so a difference is not proof that the corrective work caused it.'

type ResultEvent = Extract<ExperimentEvent, { kind: 'result' }>
type SizeMix = NonNullable<ExperimentReading['sizeMix']>
type Verdict = { classification: ExperimentOutcomeClass; reasons: string[] }

/** A frozen grade with the scorecard holding it. */
interface Located {
  card: ScorecardSnapshot
  grade: FrozenGrade
}

interface Context {
  input: OutcomeInput
  source: Located | null
  baseline: ExperimentReading
  landing: ExperimentLanding
}

/** Six decimals: differences of sums and ratios compare without floating-point noise. */
const exact = (value: number): number => Math.round(value * 1e6) / 1e6

const isScore = (measure: ExperimentMeasure): boolean => EXPERIMENT_MEASURES[measure].unit === 'points'

/** An additive measure (a count, duration or token total) of a run, sprint or epic grade is compared per ticket in scope. */
function perTicketBasis(experiment: RetroExperiment): boolean {
  return !isScore(experiment.baseline.measure) && experiment.source.subject.level !== 'ticket'
}

/** The tickets a grade's scope counted: the ticket itself, or an aggregate's counted outcomes (each ticket once). */
function scopeTickets(located: Located): string[] {
  const { card, grade } = located
  if (grade.subject.level === 'ticket') return [grade.subject.id]
  const detail = 'detail' in grade && typeof grade.detail === 'string' ? card.details[grade.detail] : undefined
  return [...new Set((detail?.outcomes ?? []).filter((outcome) => outcome.counted).map((outcome) => outcome.ticketId))]
}

/** How many tickets of each planned size an aggregate scope counted, under the plan its scorecard was graded with. */
function sizeMixOf(input: OutcomeInput, located: Located): SizeMix {
  const mix: SizeMix = {}
  for (const ticketId of scopeTickets(located)) {
    const size = input.sizeOf(located.card.planRevisionId, ticketId) ?? 'unsized'
    mix[size] = (mix[size] ?? 0) + 1
  }
  return mix
}

function locateSource(input: OutcomeInput): Located | null {
  const { source } = input.experiment
  const card = input.scorecard(source.reportId)
  if (card == null) return null
  const found = source.revision === 'own' ? ownAssessment(card, source.subject) : sealedAssessment(card, source.assessmentId)
  return found === null ? null : { card, grade: found.grade }
}

type Side = Omit<ExperimentReading, 'sampleSize' | 'perTicket' | 'size' | 'sizeMix' | 'window'>

/** `value / sampleSize` for an additive measure of a run, sprint or epic; null otherwise or without tickets. */
function perTicketOf(input: OutcomeInput, value: number | null, sampleSize: number | null): number | null {
  return perTicketBasis(input.experiment) && value !== null && sampleSize !== null && sampleSize > 0 ? value / sampleSize : null
}

/** One side of a comparison, with its scope's sample size, per-ticket figure, planned size (or size mix) and window. */
function readingOf(input: OutcomeInput, side: Side, located: Located | null): ExperimentReading {
  const sampleSize = located === null ? null : scopeTickets(located).length
  const ticket = located !== null && located.grade.subject.level === 'ticket'
  return {
    ...side,
    sampleSize,
    perTicket: perTicketOf(input, side.value, sampleSize),
    size: ticket ? input.sizeOf(located.card.planRevisionId, located.grade.subject.id) : null,
    sizeMix: located === null || ticket ? null : sizeMixOf(input, located),
    window: located === null ? null : { from: located.grade.dispatchedAt, to: located.card.cutoff }
  }
}

/** The value the expected change aims at from `base`. */
function targetFrom(base: number, change: ExperimentChange): number {
  const delta = change.unit === 'percent' ? (base * change.amount) / 100 : change.amount
  return change.direction === 'increase' ? base + delta : base - delta
}

// ---------------------------------------------------------------------------------------------------------------
// Landing and the window

function acceptedAt(ticket: ExperimentCorrectionTicket): string {
  return ticket.accepted?.at ?? ''
}

/**
 * When the corrective work landed: its last work ticket accepted, or (no ticket here) its `completed` status. A ticket
 * held only in a draft of another epic than the experiment's is listed but does not count: a draft is local and
 * unreviewed, so it never holds the landing back.
 */
function landingOf(corrections: ExperimentCorrectionTicket[], events: ExperimentEvent[], sourceEpicId: string): ExperimentLanding {
  const work = corrections.filter((ticket) => ticket.role === 'work' && (ticket.revisionNumber !== null || ticket.epicId === sourceEpicId))
  if (work.length > 0) {
    const open = work.filter((ticket) => ticket.accepted === null)
    if (open.length > 0) return { at: null, by: null, detail: `corrective work ${open.map((ticket) => ticket.key).join(', ')} is not accepted yet` }
    const last = work.reduce((latest, ticket) => (acceptedAt(ticket) > acceptedAt(latest) ? ticket : latest))
    const carried = last.projectId === undefined ? '' : ` in project ${last.projectId}, as carried from that project's records (sealed: an edit that is not resealed shows, but this machine cannot verify the time)`
    return { at: acceptedAt(last), by: 'corrective_tickets', detail: `its last corrective ticket ${last.key} was accepted at ${acceptedAt(last)}${carried}` }
  }
  const completed = events.find((event) => event.kind === 'status' && event.status === 'completed')
  if (completed !== undefined) {
    return { at: completed.recordedAt, by: 'completed_status', detail: `no corrective ticket is found here; it was marked completed at ${completed.recordedAt}` }
  }
  const drafted = corrections.filter((ticket) => ticket.role === 'work' && !work.includes(ticket))
  if (drafted.length > 0) return { at: null, by: null, detail: `corrective work ${drafted.map((ticket) => ticket.key).join(', ')} is only in an unsaved draft of another epic` }
  return { at: null, by: null, detail: 'no corrective ticket is found here and it is not marked completed' }
}

/** Keys of the scopes that started at or after `from`, each once (its earliest start), in start order. */
function orderedFrom(entries: { key: string; at: string | null }[], from: string): string[] {
  const earliest = new Map<string, string>()
  for (const { key, at } of entries) {
    if (at !== null && at >= from && (earliest.get(key) ?? '\uffff') > at) earliest.set(key, at)
  }
  return [...earliest].sort(([keyA, atA], [keyB, atB]) => (atA === atB ? keyA.localeCompare(keyB) : atA.localeCompare(atB))).map(([key]) => key)
}

/**
 * The 0-based place of the after-scope among the window's units that started once the work landed, counted in the
 * epic that holds the after-scope (a follow-up epic counts its own sprints, runs and tickets); -1 when not among them.
 */
function windowPlace(window: ExperimentWindow, after: Located, allStarts: ScorecardStarts[], landedAt: string): number {
  const starts = allStarts.filter((item) => item.epicId === after.card.epicId)
  if (window.basis === 'sprints') {
    return orderedFrom(starts.map((item) => ({ key: `${item.runId}/${item.sprintId}`, at: item.sprint })), landedAt).indexOf(`${after.card.runId}/${after.card.sprintId}`)
  }
  if (window.basis === 'runs') {
    return orderedFrom(starts.map((item) => ({ key: item.runId, at: item.run })), landedAt).indexOf(after.card.runId)
  }
  const order = orderedFrom(starts.flatMap((item) => item.tickets.map((ticket) => ({ key: ticket.ticketId, at: ticket.dispatchedAt }))), landedAt)
  const places = scopeTickets(after).map((ticketId) => order.indexOf(ticketId))
  return places.length === 0 || places.includes(-1) ? -1 : Math.max(...places)
}

/** Why the after-assessment's window is not the experiment's (empty: it is). */
function windowProblems(context: Context, after: Located): string[] {
  const landedAt = context.landing.at
  if (landedAt === null) return [`the corrective work has not landed (${context.landing.detail})`]
  const from = after.grade.dispatchedAt
  if (from === null) return ['the after-assessment has no dispatch, so its window has no start']
  if (from < landedAt) return [`its window starts at ${from}, before the corrective work landed at ${landedAt}`]
  const { basis, count } = context.input.experiment.window
  const place = windowPlace(context.input.experiment.window, after, context.input.starts, landedAt)
  if (place < 0) return [`its scope is not among the ${basis} that started after the corrective work landed`]
  return place < count ? [] : [`it is ${basis.slice(0, -1)} ${place + 1} after the corrective work landed; the experiment measures the next ${count}`]
}

// ---------------------------------------------------------------------------------------------------------------
// One result

interface After {
  reading: ExperimentReading
  located: Located | null
  problems: string[]
}

/**
 * The result as a reading, with the frozen grade it cites when this machine holds it. The result must be exactly what
 * that grade holds (`resultProblem`): an event imported while its scorecard was not here (`importer.ts`) is checked
 * once the scorecard arrives, and one that does not match is not placed.
 */
function afterOf(context: Context, event: ResultEvent): After {
  const { result } = event
  const side = { value: result.value, unit: result.unit, state: result.state, assessment: result.assessment }
  if (result.assessment === null) {
    return { reading: readingOf(context.input, side, null), located: null, problems: ['it is a stated value that names no frozen assessment, so its window, scope and guardrails cannot be checked'] }
  }
  const card = context.input.scorecard(result.assessment.reportId)
  const found = card == null ? null : sealedAssessment(card, result.assessment.assessmentId)
  if (card == null || found === null) {
    return { reading: readingOf(context.input, side, null), located: null, problems: [`the scorecard of report ${result.assessment.reportId} it cites is not here`] }
  }
  const mismatch = resultProblem(result, context.input.experiment.baseline.measure, () => card)
  if (mismatch !== null) {
    return { reading: readingOf(context.input, side, null), located: null, problems: [`the result ${mismatch}, so it is not read`] }
  }
  const located = { card, grade: found.grade }
  return { reading: readingOf(context.input, side, located), located, problems: [] }
}

/** Why the result is not placed where the experiment measures: the baseline's own grade, another level, another window. */
function placementProblems(context: Context, after: Located): string[] {
  const { source } = context.input.experiment
  return [
    ...(after.grade.assessmentId === source.assessmentId ? ["the result is the baseline's own assessment"] : []),
    ...(after.grade.subject.level === source.subject.level ? [] : [`the result is a ${after.grade.subject.level} grade, the baseline a ${source.subject.level} grade`]),
    ...windowProblems(context, after)
  ]
}

/** Why the two values cannot be compared as numbers: missing or estimated, another unit. */
function valueProblems(baseline: ExperimentReading, after: ExperimentReading): string[] {
  return [
    ...(after.value === null ? [`the result has no value (${after.state})`] : []),
    ...(after.state === 'estimated' ? ['the result is estimated, not measured'] : []),
    ...(baseline.state === 'estimated' ? ['the baseline is estimated, not measured'] : []),
    ...(after.unit === baseline.unit ? [] : [`the result is in ${after.unit}, the baseline in ${baseline.unit}`])
  ]
}

/** Why the after-grade is not the same kind of measurement: another policy for a score, another task scope. */
function scopeProblems(context: Context, after: Located, reading: ExperimentReading): string[] {
  const { experiment } = context.input
  const policy = after.card.policy.hash
  return [
    ...(isScore(experiment.baseline.measure) && policy !== experiment.source.policyHash ? [`the result was graded under policy ${policy}, the baseline under ${experiment.source.policyHash}`] : []),
    ...sizeProblems(context, after, reading)
  ]
}

function mixText(mix: SizeMix | null): string {
  if (mix === null) return 'unknown'
  return Object.entries(mix).sort(([a], [b]) => a.localeCompare(b)).map(([size, count]) => `${count} ${size}`).join(', ') || 'no tickets'
}

/** Whether two size mixes hold the same share of every planned size (3 medium matches 4 medium; 2 small + 1 large does not match 3 medium). */
function sameMix(a: SizeMix, b: SizeMix): boolean {
  const total = (mix: SizeMix): number => Object.values(mix).reduce((sum, count) => sum + count, 0)
  const sizes = new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof SizeMix>
  return [...sizes].every((size) => (a[size] ?? 0) * total(b) === (b[size] ?? 0) * total(a))
}

/** A per-ticket comparison needs counted tickets on both sides with the same mix of planned sizes. */
function mixProblems(before: ExperimentReading, after: Located, reading: ExperimentReading): string[] {
  if (before.perTicket === null || scopeTickets(after).length === 0) return ['a per-ticket comparison needs counted tickets in both scopes']
  if (before.sizeMix !== null && reading.sizeMix !== null && sameMix(before.sizeMix, reading.sizeMix)) return []
  return [`the scopes' planned size mixes differ (baseline ${mixText(before.sizeMix)}; result ${mixText(reading.sizeMix)}), so their per-ticket figures are not comparable`]
}

/** Per-ticket figures need the same size mix (`mixProblems`); a ticket's total, a ticket of the same planned size; a score neither. */
function sizeProblems(context: Context, after: Located, reading: ExperimentReading): string[] {
  const { experiment } = context.input
  const before = context.baseline
  if (perTicketBasis(experiment)) return mixProblems(before, after, reading)
  if (isScore(experiment.baseline.measure) || (before.size !== null && before.size === reading.size)) return []
  return [`a ticket's ${experiment.baseline.measure} compares only with a ticket of the same planned size (baseline ${before.size ?? 'unsized'}, result ${reading.size ?? 'unsized'})`]
}

function guardrailCheck(guardrail: ExperimentGuardrail, after: Located | null, policyHash: string): ExperimentGuardrailCheck {
  const unknown = (detail: string): ExperimentGuardrailCheck => ({ ...guardrail, after: null, verdict: 'unknown', detail })
  if (after === null) return unknown(`${guardrail.measure} cannot be read: the result cites no frozen assessment here`)
  if (isScore(guardrail.measure) && after.card.policy.hash !== policyHash) return unknown(`${guardrail.measure} was graded under another policy than the baseline`)
  const reading = readMeasure(after.card, after.grade, guardrail.measure)
  if ('missing' in reading) return unknown(`${guardrail.measure} was not measured (${reading.missing})`)
  if (reading.state === 'estimated') return unknown(`${guardrail.measure} is estimated, not measured`)
  const held = guardrail.comparator === 'at_least' ? reading.value >= guardrail.threshold : reading.value <= guardrail.threshold
  const bound = `${guardrail.comparator === 'at_least' ? 'at least' : 'at most'} ${guardrail.threshold} ${guardrail.unit}`
  return { ...guardrail, after: reading.value, verdict: held ? 'held' : 'breached', detail: `${guardrail.measure} ${reading.value} ${guardrail.unit}, ${held ? 'within' : 'past'} ${bound}` }
}

interface Figures {
  before: number | null
  measured: number | null
  target: number | null
}

function figuresOf(context: Context, after: ExperimentReading): Figures {
  const { experiment } = context.input
  if (!perTicketBasis(experiment)) {
    return { before: context.baseline.value, measured: after.value, target: targetFrom(experiment.baseline.value, experiment.expectedChange) }
  }
  const sample = context.baseline.sampleSize
  const target = sample === null || sample === 0 ? null : targetFrom(experiment.baseline.value, experiment.expectedChange) / sample
  return { before: context.baseline.perTicket, measured: after.perTicket, target }
}

/** improved, unchanged or regressed by the measure against the expected change (no guardrail was breached). */
function classify(context: Context, figures: Figures, guardrails: ExperimentGuardrailCheck[]): Verdict {
  const { before, measured, target } = figures
  if (before === null || measured === null || target === null) return { classification: 'insufficient_evidence', reasons: ['the baseline or the result has no comparable figure'] }
  const expected = exact(Math.abs(target - before))
  if (expected === 0) return { classification: 'insufficient_evidence', reasons: [`the expected change from a baseline of ${before} is zero`] }
  const progress = exact(context.input.experiment.expectedChange.direction === 'increase' ? measured - before : before - measured)
  const moved = `moved ${Math.abs(progress)} ${progress < 0 ? 'away from' : 'toward'} the target (${expected} expected)`
  if (progress >= expected) return improvedUnlessUnread(guardrails, moved)
  if (-progress >= expected) return { classification: 'regressed', reasons: [`it ${moved}: at least the expected change the other way`] }
  return { classification: 'unchanged', reasons: [`it ${moved}: less than the expected change either way`] }
}

function improvedUnlessUnread(guardrails: ExperimentGuardrailCheck[], moved: string): Verdict {
  const unread = guardrails.filter((check) => check.verdict === 'unknown')
  if (unread.length === 0) return { classification: 'improved', reasons: [`it ${moved}, and every guardrail held`] }
  return { classification: 'insufficient_evidence', reasons: [`it ${moved}, but a guardrail could not be read, so it cannot count as an improvement`, ...unread.map((check) => check.detail)] }
}

interface Judged {
  /** The result cites a grade here at the baseline's level, other than the baseline's own, in the experiment's window. */
  placed: boolean
  guardrails: ExperimentGuardrailCheck[]
  problems: string[]
  figures: Figures
}

/**
 * A breach on a placed result decides whatever else is wrong with the result's value; the rest of the problems are
 * kept as context. Without a counted breach, any problem makes it insufficient evidence; else the measure decides.
 */
function verdictOf(context: Context, judged: Judged): Verdict {
  const { guardrails, problems } = judged
  const breached = judged.placed ? guardrails.filter((check) => check.verdict === 'breached') : []
  if (breached.length > 0) {
    return {
      classification: 'regressed',
      reasons: [
        ...breached.map((check) => `guardrail breached: ${check.detail}`),
        'a breached guardrail is never an improvement, whatever the measure did',
        ...problems.map((problem) => `also: ${problem}`)
      ]
    }
  }
  return problems.length > 0 ? { classification: 'insufficient_evidence', reasons: problems } : classify(context, judged.figures, guardrails)
}

/** The result's difference from the baseline, absolute and in percent of the baseline (null when either is missing, or the baseline is 0). */
function changeOf(figures: Figures): Pick<ExperimentComparison, 'difference' | 'percentChange'> {
  const { before, measured } = figures
  const difference = before === null || measured === null ? null : exact(measured - before)
  return { difference, percentChange: difference === null || before === null || before === 0 ? null : exact((difference / before) * 100) }
}

/** One result compared with the baseline; `unread` when it cites a frozen grade this machine cannot read. */
function compare(context: Context, event: ResultEvent): { comparison: ExperimentComparison; unread: boolean } {
  const after = afterOf(context, event)
  const { located } = after
  const placement = located === null ? after.problems : placementProblems(context, located)
  const problems = [...placement, ...valueProblems(context.baseline, after.reading), ...(located === null ? [] : scopeProblems(context, located, after.reading))]
  const figures = figuresOf(context, after.reading)
  const guardrails = context.input.experiment.guardrails.map((guardrail) => guardrailCheck(guardrail, located, context.input.experiment.source.policyHash))
  const carried = event.result.crossRepo
  const verdict = verdictOf(context, { placed: located !== null && placement.length === 0, guardrails, problems, figures })
  // Only the scorecard is regraded here: the rest of a carried result is the target's word, sealed but not verifiable.
  const carriedNote = `its scorecard is regraded here; the corrective tickets' accepted times, scope starts and planned sizes are as carried from project ${carried?.projectId ?? ''} (sealed: an edit shows unless it was resealed)`
  const comparison: ExperimentComparison = {
    eventId: event.id,
    eventNumber: event.number,
    recordedAt: event.recordedAt,
    note: event.note,
    after: after.reading,
    evidence: event.result.evidence,
    basis: perTicketBasis(context.input.experiment) ? 'per_ticket' : 'value',
    ...figures,
    ...changeOf(figures),
    guardrails,
    ...verdict,
    ...(carried === undefined
      ? {}
      : { reasons: [...verdict.reasons, carriedNote], crossRepo: { projectId: carried.projectId, key: carried.key, epicId: carried.epicId, epicTitle: carried.epicTitle } })
  }
  return { comparison, unread: event.result.assessment !== null && located === null }
}

// ---------------------------------------------------------------------------------------------------------------
// The outcome

type Decision = Pick<ExperimentOutcome, 'classification' | 'decidedBy' | 'reasons'>

const breachedIn = (comparison: ExperimentComparison): boolean =>
  comparison.classification === 'regressed' && comparison.guardrails.some((check) => check.verdict === 'breached')

/**
 * A counted breach decides; then an abandoned experiment is not assessed; then the latest comparable result decides,
 * except that it is never `improved` while a result cites a frozen grade this machine cannot read (`unread`: not here,
 * failing its seal, or not matching the result): that grade may hold a breach, and a breach is never an improvement.
 */
function decision(status: ExperimentStatus, comparisons: ExperimentComparison[], unread: ExperimentComparison[], landing: ExperimentLanding): Decision {
  const latest = [...comparisons].reverse()
  const breach = latest.find(breachedIn)
  const decide = (comparison: ExperimentComparison): Decision => ({
    classification: comparison.classification,
    decidedBy: comparison.eventId,
    reasons: [`result #${comparison.eventNumber}: ${comparison.reasons.join('; ')}`]
  })
  if (breach !== undefined) return decide(breach)
  const insufficient = (reasons: string[]): Decision => ({ classification: 'insufficient_evidence', decidedBy: null, reasons })
  if (status === 'abandoned') return insufficient(['the experiment was abandoned, so no result is assessed as its outcome'])
  const decided = latest.find((comparison) => comparison.classification !== 'insufficient_evidence')
  if (decided?.classification === 'improved' && unread.length > 0) {
    return insufficient([
      `result #${decided.eventNumber} would count as improved, but the frozen grade cited by ${unread.map((comparison) => `result #${comparison.eventNumber}`).join(', ')} cannot be read here, so a guardrail breach there cannot be ruled out`,
      ...unread.map((comparison) => `result #${comparison.eventNumber}: ${comparison.reasons.join('; ')}`)
    ])
  }
  if (decided !== undefined) return decide(decided)
  if (comparisons.length === 0) return insufficient(['no measured result is recorded', ...(landing.at === null ? [landing.detail] : [])])
  return insufficient(comparisons.map((comparison) => `result #${comparison.eventNumber}: ${comparison.reasons.join('; ')}`))
}

/**
 * The experiment's outcome: its corrective work and where it landed, the frozen baseline, target and guardrails, and
 * every result event compared with the baseline; a counted guardrail breach decides, else the latest comparable result.
 */
export function experimentOutcome(input: OutcomeInput): ExperimentOutcome {
  const { experiment } = input
  const source = locateSource(input)
  const baseline = readingOf(input, { value: experiment.baseline.value, unit: experiment.baseline.unit, state: experiment.baseline.state, assessment: experiment.source }, source)
  const landing = landingOf(input.corrections, input.events, experiment.source.epicId)
  const context: Context = { input, source, baseline, landing }
  const results = input.events.filter((event): event is ResultEvent => event.kind === 'result').map((event) => compare(context, event))
  const comparisons = results.map((result) => result.comparison)
  const unread = results.filter((result) => result.unread).map((result) => result.comparison)
  return {
    experimentId: experiment.id,
    status: input.status,
    ...decision(input.status, comparisons, unread, landing),
    baseline,
    target: { ...experiment.expectedChange, value: exact(targetFrom(experiment.baseline.value, experiment.expectedChange)) },
    guardrails: experiment.guardrails,
    window: experiment.window,
    landing,
    corrections: { tickets: input.corrections, runIds: [...new Set(input.corrections.flatMap((ticket) => (ticket.accepted === null ? [] : [ticket.accepted.runId])))] },
    comparisons,
    evidence: 'observational',
    caveat: OBSERVATIONAL_CAVEAT
  }
}
