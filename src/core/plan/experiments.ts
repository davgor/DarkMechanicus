/**
 * Structured improvement experiments of a sprint retro (`src/shared/domain/experiments.ts`): turning what a reporter
 * wrote into the stored, fully resolved form, the stored record's schema, reading a measure out of a frozen scorecard,
 * and checking a stored experiment (or result) against the scorecard it cites. Pure: the caller supplies the epic's
 * frozen scorecards, the scorecard drafted for the report being submitted and the experiments written before.
 */
import { z } from 'zod'
import {
  EXPERIMENT_CHANGE_UNITS,
  EXPERIMENT_DIRECTIONS,
  EXPERIMENT_MEASURE_NAMES,
  EXPERIMENT_MEASURES,
  EXPERIMENT_STATUSES,
  EXPERIMENT_UNITS,
  EXPERIMENT_WINDOW_BASES,
  GUARDRAIL_COMPARATORS,
  IMPROVEMENT_CONCERNS,
  type ExperimentAssessmentInput,
  type ExperimentAssessmentRef,
  type ExperimentBaseline,
  type ExperimentChange,
  type ExperimentDestination,
  type ExperimentEvent,
  type ExperimentMeasure,
  type ExperimentResult,
  type ExperimentUnit,
  type OwnAssessmentRef,
  type RetroExperiment,
  type RetroExperimentInput,
  type SealedAssessmentInput,
  type SealedAssessmentRef
} from '../../shared/domain/experiments'
import type { CorrectionRestatement } from '../../shared/domain/corrections'
import {
  type EvidenceRef,
  GRADE_SUBJECT_LEVELS,
  type GradeSubject,
  type Measurement,
  type ResourceInput,
  type SpaceGradeInput
} from '../../shared/domain/space'
import { TICKET_SIZES, type TicketSize } from '../../shared/domain/bundle'
import type { FrozenGrade, ScorecardDraft, ScorecardSnapshot } from '../../shared/domain/spaceGrades'
import { canonicalJson, contentHash } from '../canonical'
import { fail } from '../errors'
import { type IdKind, isStableId } from '../ids'
import { LIMITS, parseInput, retroExperimentInput } from '../schemas'
import { evidenceRefSchema } from '../space/contract'
import { textProblem } from '../space/ledger'
import { frozenInput, scorecardSnapshotSchema } from '../space/snapshot'

// ---------------------------------------------------------------------------------------------------------------
// Stored form

const idOf = (kind: IdKind) => z.string().refine((value) => isStableId(value, kind), { message: `Expected a ${kind} id` })
const isoTime = z.iso.datetime({ offset: true })
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const quantity = z.number().min(0).max(1e15)
const stated = (max: number) => z.string().max(max).refine((text) => text.trim() !== '', 'Expected some text')

/**
 * Free text a caller writes beside a measurement (an evidence detail, an event note) follows the metric ledger's rule:
 * one line of at most 200 characters, with no token, credential or machine-local path.
 */
const ledgerText = z.string().superRefine((text, ctx) => {
  const problem = textProblem(text)
  if (problem !== null) ctx.addIssue({ code: 'custom', message: `The text ${problem}` })
})
const evidenceRef = evidenceRefSchema.superRefine((ref, ctx) => {
  const problem = ref.detail === null ? null : textProblem(ref.detail)
  if (problem !== null) ctx.addIssue({ code: 'custom', path: ['detail'], message: `The detail ${problem}` })
})
const evidence = z.array(evidenceRef).max(LIMITS.listItems)

const identityShape = {
  epicId: idOf('epic'),
  runId: idOf('run'),
  sprintId: idOf('sprint'),
  reportId: idOf('report'),
  reportRevision: z.number().int().min(1),
  snapshotId: idOf('assessment'),
  policyHash: sha256,
  assessmentId: idOf('assessment'),
  subject: z.strictObject({ level: z.enum(GRADE_SUBJECT_LEVELS), id: z.string().min(1).max(64) }),
  inputHash: z.string().min(1).max(200)
}

/** A grade of an earlier report revision's sealed scorecard, with its seals: identities and hashes, nothing machine-local. */
const sealedAssessmentRefSchema = z.strictObject({ revision: z.literal('earlier'), ...identityShape, reportContentHash: sha256, snapshotHash: sha256 })

/** A grade of the scorecard frozen with the holding report revision: no seals (they would be circular). */
const assessmentRefSchema = z.discriminatedUnion('revision', [sealedAssessmentRefSchema, z.strictObject({ revision: z.literal('own'), ...identityShape })])

const measureFields = { measure: z.enum(EXPERIMENT_MEASURE_NAMES), unit: z.enum(EXPERIMENT_UNITS) }
const measureUnitMatches = (ref: { measure: ExperimentMeasure; unit: ExperimentUnit }): boolean => EXPERIMENT_MEASURES[ref.measure].unit === ref.unit
const unitMessage = { message: "The unit is not the measure's unit" }

/** An experiment as stored in a retro (`SprintRetro.experiments`); parsed on import and on every export. */
const retroExperimentSchema = z.strictObject({
  id: idOf('experiment'),
  source: assessmentRefSchema,
  // Optional: an experiment written before concerns were recorded keeps its stored bytes.
  concern: z.enum(IMPROVEMENT_CONCERNS).optional(),
  issue: z.strictObject({ summary: stated(LIMITS.shortText), evidence: evidence.min(1) }),
  hypothesis: stated(LIMITS.markdown),
  destination: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('source_repository'), repository: z.string().min(1).max(100).nullable() }),
    z.strictObject({ kind: z.literal('darkmechanicus_source') })
  ]),
  proposedWork: z
    .array(z.strictObject({ title: stated(LIMITS.title), body: z.string().max(LIMITS.markdown), size: z.enum(TICKET_SIZES).optional() }))
    .min(1)
    .max(LIMITS.listItems),
  baseline: z.strictObject({ ...measureFields, value: quantity, state: z.enum(['observed', 'estimated']) }).refine(measureUnitMatches, unitMessage),
  expectedChange: z.strictObject({ direction: z.enum(EXPERIMENT_DIRECTIONS), amount: quantity.positive(), unit: z.enum(EXPERIMENT_CHANGE_UNITS) }),
  guardrails: z
    .array(z.strictObject({ ...measureFields, comparator: z.enum(GUARDRAIL_COMPARATORS), threshold: quantity }).refine(measureUnitMatches, unitMessage))
    .min(1)
    .max(20),
  window: z.strictObject({ basis: z.enum(EXPERIMENT_WINDOW_BASES), count: z.number().int().min(1).max(100) })
})

/** The retro's experiments as stored: absent when there are none, so an empty list is never written (or imported). */
export const retroExperimentsSchema = z
  .array(retroExperimentSchema)
  .min(1)
  .max(50)
  .superRefine((experiments, ctx) => {
    const duplicate = repeated(experiments.map((experiment) => experiment.id))
    if (duplicate !== undefined) ctx.addIssue({ code: 'custom', message: `Experiment ${duplicate} is listed twice` })
  })

const eventBase = {
  id: idOf('experimentEvent'),
  experimentId: idOf('experiment'),
  runId: idOf('run'),
  number: z.number().int().min(1),
  source: z.strictObject({ reportId: idOf('report'), experimentHash: sha256 }),
  note: ledgerText,
  recordedBy: z.strictObject({
    role: z.enum(['desktop', 'planner', 'orchestrator', 'worker', 'reviewer', 'reader']),
    label: z.string().max(LIMITS.label)
  }),
  recordedAt: isoTime
}

const ticketList = z.array(z.strictObject({ ticketId: idOf('ticket'), dispatchedAt: isoTime.nullable() })).max(LIMITS.tickets)

/**
 * What a result read from a correction epic in another project carries (`CrossRepoResultEvidence`): shape only here;
 * the scorecard's seal and grading are checked where the event is recorded or imported.
 */
const crossRepoEvidenceSchema = z.strictObject({
  projectId: idOf('project'),
  key: z.string().min(1).max(200),
  epicId: idOf('epic'),
  epicTitle: z.string().max(LIMITS.title),
  scorecard: scorecardSnapshotSchema,
  starts: z
    .array(z.strictObject({ epicId: idOf('epic'), runId: idOf('run'), sprintId: idOf('sprint'), sprint: isoTime.nullable(), run: isoTime.nullable(), tickets: ticketList }))
    .max(LIMITS.tickets),
  corrections: z
    .array(
      z.strictObject({
        epicId: idOf('epic'),
        epicTitle: z.string().max(LIMITS.title),
        ticketId: idOf('ticket'),
        key: z.string().min(1).max(100),
        title: z.string().max(LIMITS.title),
        role: z.enum(['work', 'fireguard']),
        workIndex: z.number().int().min(0).nullable(),
        revisionNumber: z.number().int().min(1).nullable(),
        accepted: z.strictObject({ runId: idOf('run'), attemptId: idOf('attempt'), at: isoTime }).nullable()
      })
    )
    .max(LIMITS.listItems * 2),
  sizes: z.record(z.string().max(100), z.enum(TICKET_SIZES).nullable()),
  readAt: isoTime,
  seal: z.string().regex(/^sha256:[0-9a-f]{64}$/)
})

/** One later event of an experiment as stored and exported with its run's history. */
export const experimentEventSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...eventBase, kind: z.literal('status'), status: z.enum(EXPERIMENT_STATUSES).exclude(['proposed']) }),
  z.strictObject({
    ...eventBase,
    kind: z.literal('result'),
    result: z.strictObject({
      value: quantity.nullable(),
      unit: z.enum(EXPERIMENT_UNITS),
      state: z.enum(['observed', 'estimated', 'missing']),
      assessment: sealedAssessmentRefSchema.nullable(),
      evidence,
      crossRepo: crossRepoEvidenceSchema.optional()
    })
  })
]) satisfies z.ZodType<ExperimentEvent>

/** The content hash of an experiment's definition: an event names the exact definition it is about. */
export function experimentHash(experiment: RetroExperiment): string {
  return contentHash(experiment)
}

function repeated(values: string[]): string | undefined {
  const seen = new Set<string>()
  return values.find((value) => (seen.has(value) ? true : (seen.add(value), false)))
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a frozen scorecard (sealed, or drafted for the report being submitted)

/** Every grade of a scorecard: sprint, run, epic (final sprint only) and each ticket. */
export function gradesOf(card: ScorecardDraft): FrozenGrade[] {
  return [card.sprint, card.run, ...(card.epic === null ? [] : [card.epic]), ...card.tickets]
}

function identityOf(card: ScorecardDraft, grade: FrozenGrade): Omit<OwnAssessmentRef, 'revision'> {
  return {
    epicId: card.epicId,
    runId: card.runId,
    sprintId: card.sprintId,
    reportId: card.report.reportId,
    reportRevision: card.report.reportRevision,
    snapshotId: card.snapshotId,
    policyHash: card.policy.hash,
    assessmentId: grade.assessmentId,
    subject: grade.subject,
    inputHash: grade.result.inputHash
  }
}

/** A grade of a sealed scorecard by assessment id, with the reference that cites it; null when it has none. */
export function sealedAssessment(snapshot: ScorecardSnapshot, assessmentId: string): { ref: SealedAssessmentRef; grade: FrozenGrade } | null {
  const grade = gradesOf(snapshot).find((item) => item.assessmentId === assessmentId)
  if (grade === undefined) return null
  return { ref: { revision: 'earlier', ...identityOf(snapshot, grade), reportContentHash: snapshot.report.contentHash, snapshotHash: snapshot.snapshotHash }, grade }
}

/** A grade of the holding revision's own scorecard by subject, with the reference that cites it; null when it has none. */
export function ownAssessment(card: ScorecardDraft, subject: GradeSubject): { ref: OwnAssessmentRef; grade: FrozenGrade } | null {
  const grade = gradesOf(card).find((item) => item.subject.level === subject.level && item.subject.id === subject.id)
  return grade === undefined ? null : { ref: { revision: 'own', ...identityOf(card, grade) }, grade }
}

/** A measure's value in a frozen grade, or why it has none. */
type MeasureReading = { value: number; state: 'observed' | 'estimated' } | { missing: string }

function fromMeasurement(measurement: Measurement): MeasureReading {
  return measurement.state === 'missing' ? { missing: measurement.reason } : { value: measurement.value, state: measurement.state }
}

const observed = (value: number): MeasureReading => ({ value, state: 'observed' })

type ScoreMeasure = Extract<ExperimentMeasure, `${string}.score`>
type InputMeasure = Exclude<ExperimentMeasure, ScoreMeasure>
type ComponentInputs = SpaceGradeInput['components']

function isScoreMeasure(measure: ExperimentMeasure): measure is ScoreMeasure {
  return measure.endsWith('.score')
}

/** A resource total is no baseline while attempts that ran reported nothing: the total is partial. */
function resourceTotal(resource: ResourceInput): MeasureReading {
  return resource.unreportedAttempts > 0 ? { missing: 'partial_coverage' } : fromMeasurement(resource.actual)
}

/** How each quantity measure is read from a grade's stored component inputs. */
const INPUT_READERS: Readonly<Record<InputMeasure, (inputs: ComponentInputs) => MeasureReading>> = {
  // Only attributed regressions are charged to the subject.
  'P.regressions': (inputs) => observed(inputs.P.regressions.filter((item) => item.attribution === 'attributed').length),
  'A.committed': (inputs) => (inputs.A.committed === null ? { missing: 'scope_not_frozen' } : observed(inputs.A.committed)),
  'A.delivered': (inputs) => observed(inputs.A.delivered),
  'A.added': (inputs) => observed(inputs.A.added),
  'C.failed_checks': (inputs) => (inputs.C.handoffChecks === null ? { missing: 'no_handoffs' } : observed(inputs.C.handoffChecks.failed)),
  'C.rejected_submissions': (inputs) => observed(inputs.C.rejected?.submissions ?? 0),
  'C.coordination_defects': (inputs) => observed(inputs.C.coordinationDefects),
  'E.corrective_ms': (inputs) => fromMeasurement(inputs.E.correctiveMs),
  'E.productive_ms': (inputs) => fromMeasurement(inputs.E.productiveMs),
  'E.unclassified_ms': (inputs) => fromMeasurement(inputs.E.unclassifiedMs),
  'T.actual_ms': (inputs) => resourceTotal(inputs.T),
  'K.actual_tokens': (inputs) => resourceTotal(inputs.K)
}

/** A score from a grade's frozen result: the grade's own (estimated unless final) or one component's. */
function scoreReading(grade: FrozenGrade, measure: ScoreMeasure): MeasureReading {
  if (measure === 'grade.score') {
    const { score, status } = grade.result
    return score === null ? { missing: `the grade is ${status}` } : { value: score, state: status === 'final' ? 'observed' : 'estimated' }
  }
  const result = grade.result.components.find((item) => item.component === EXPERIMENT_MEASURES[measure].component)
  if (result === undefined || result.score === null) return { missing: result?.missingReason ?? 'not graded' }
  return { value: result.score, state: result.state === 'estimated' ? 'estimated' : 'observed' }
}

/** Reads one measure out of a frozen grade: a score from its result, a quantity from its stored component input. */
export function readMeasure(card: ScorecardDraft, grade: FrozenGrade, measure: ExperimentMeasure): MeasureReading {
  return isScoreMeasure(measure) ? scoreReading(grade, measure) : INPUT_READERS[measure](frozenInput(card, grade).components)
}

// ---------------------------------------------------------------------------------------------------------------
// Checking a stored experiment or result against the scorecard it cites (import)

/** A report's sealed scorecard by report id, when the importing machine has it (stored, or arriving now). */
export type ScorecardLookup = (reportId: string) => ScorecardSnapshot | undefined

/** The grade a stored source cites, looked up in the scorecard it names, or why it cannot be. */
function citedGrade(
  experiment: RetroExperiment,
  holding: { id: string; reportRevision: number },
  scorecardFor: ScorecardLookup
): { card: ScorecardSnapshot; found: { ref: ExperimentAssessmentRef; grade: FrozenGrade } | null } | string {
  const { source } = experiment
  const own = source.revision === 'own'
  if (own && (source.reportId !== holding.id || source.reportRevision !== holding.reportRevision)) return 'cites its own scorecard but names another report revision'
  if (!own && source.reportId === holding.id) return 'cites its own report revision as an earlier one'
  const card = scorecardFor(source.reportId)
  if (card === undefined) return `cites the scorecard of report ${source.reportId}, which is not here`
  return { card, found: own ? ownAssessment(card, source.subject) : sealedAssessment(card, source.assessmentId) }
}

/**
 * Why a stored experiment's source or baseline does not follow from the frozen scorecard it cites, or null: the
 * source must be exactly the reference that scorecard gives for the grade (identities, policy, input hash, and an
 * earlier revision's seals), and the baseline exactly the value and state read from that grade.
 */
export function sourceProblem(experiment: RetroExperiment, holding: { id: string; reportRevision: number }, scorecardFor: ScorecardLookup): string | null {
  const cited = citedGrade(experiment, holding, scorecardFor)
  if (typeof cited === 'string') return cited
  const { source, baseline } = experiment
  if (cited.found === null) return `cites assessment ${source.assessmentId}, which the scorecard of report ${source.reportId} does not hold`
  if (canonicalJson(cited.found.ref) !== canonicalJson(source)) return `does not match the frozen assessment ${source.assessmentId} it cites`
  const reading = readMeasure(cited.card, cited.found.grade, baseline.measure)
  return 'missing' in reading || reading.value !== baseline.value || reading.state !== baseline.state
    ? `states a baseline ${baseline.measure} the assessment ${source.assessmentId} does not hold`
    : null
}

/** Why a stored result read from an assessment does not match that frozen assessment, or null. */
export function resultProblem(result: ExperimentResult, measure: ExperimentMeasure, scorecardFor: ScorecardLookup): string | null {
  const { assessment } = result
  if (assessment === null) return null
  const card = scorecardFor(assessment.reportId)
  if (card === undefined) return `reads the scorecard of report ${assessment.reportId}, which is not here yet; the run history is imported once it is`
  const found = sealedAssessment(card, assessment.assessmentId)
  if (found === null || canonicalJson(found.ref) !== canonicalJson(assessment)) return `does not match the frozen assessment ${assessment.assessmentId} it cites`
  const reading = readMeasure(card, found.grade, measure)
  const matches = 'missing' in reading ? result.value === null && result.state === 'missing' : result.value === reading.value && result.state === reading.state
  return matches ? null : `states a value the assessment ${assessment.assessmentId} does not hold`
}

// ---------------------------------------------------------------------------------------------------------------
// Normalizing what a reporter wrote

/** An experiment written before, in its latest definition, and the report revision that holds it. */
export interface KnownExperiment {
  runId: string
  sprintId: string
  reportId: string
  experiment: RetroExperiment
}

/** What normalizing experiments needs from the report being written and the epic's stored records. */
export interface ExperimentContext {
  epicId: string
  runId: string
  /** The sprint the report is for. */
  sprintId: string
  /** Mints a new experiment id. */
  mint: () => string
  /**
   * The frozen scorecard of a report revision of the epic: undefined when the epic has no such report, null when the
   * report was submitted before scorecards were frozen.
   */
  scorecard: (reportId: string) => ScorecardSnapshot | null | undefined
  /** The scorecard drafted for the report being submitted (its grades are final, its seal still to come). */
  own: ScorecardDraft | null
  /** The latest definition of an experiment already written in one of the epic's reports; null when there is none. */
  known: (experimentId: string) => KnownExperiment | null
  /** The repositories of a folder of repositories, by name; null in a single repository. */
  repositories: string[] | null
}

/** A cited grade, its reference and the scorecard holding it. */
interface ResolvedAssessment<R extends ExperimentAssessmentRef> {
  ref: R
  grade: FrozenGrade
  card: ScorecardDraft
}

/** Resolves a grade of an earlier revision's sealed scorecard of the epic, or refuses it naming where it was written. */
export function resolveSealed(input: SealedAssessmentInput, scorecard: ExperimentContext['scorecard'], path: string): ResolvedAssessment<SealedAssessmentRef> {
  const snapshot = scorecard(input.reportId)
  if (snapshot === undefined) {
    fail('invalid_input', `Unknown report ${input.reportId} at ${path}.reportId: the epic has no report revision with that id.`, { path, reportId: input.reportId })
  }
  if (snapshot === null) {
    fail('invalid_input', `Report ${input.reportId} at ${path}.reportId was submitted before scorecards were frozen, so it has no assessment to cite.`, {
      path,
      reportId: input.reportId
    })
  }
  const found =
    sealedAssessment(snapshot, input.assessmentId) ??
    fail('invalid_input', `Unknown assessment ${input.assessmentId} at ${path}.assessmentId: the scorecard of report ${input.reportId} has no such grade.`, {
      path,
      reportId: input.reportId,
      assessmentId: input.assessmentId
    })
  return { ...found, card: snapshot }
}

/** Resolves an experiment's source: a grade of this submission's own scorecard by subject, or of an earlier one. */
function resolveSource(input: ExperimentAssessmentInput, context: ExperimentContext, path: string): ResolvedAssessment<ExperimentAssessmentRef> {
  if (!('subject' in input)) return resolveSealed(input, context.scorecard, path)
  const { subject } = input
  const card = context.own ?? fail('invalid_input', `Invalid source at ${path}.subject: only a report being submitted cites its own scorecard by subject.`, { path })
  const found =
    ownAssessment(card, subject) ??
    fail('invalid_input', `Unknown subject at ${path}.subject: this report's scorecard grades no ${subject.level} ${subject.id}.`, { path, subject })
  return { ...found, card }
}

function requireUnit(ref: { measure: ExperimentMeasure; unit: ExperimentUnit }, path: string): void {
  const unit = EXPERIMENT_MEASURES[ref.measure].unit
  if (ref.unit !== unit) {
    fail('invalid_input', `Invalid unit at ${path}.unit: ${ref.measure} is measured in ${unit}, not ${ref.unit}.`, { path, measure: ref.measure, unit: ref.unit, expected: unit })
  }
}

/** Why a change cannot be reached from its baseline, or null: below zero, past 100 points, or a fractional count. */
function unreachable(change: ExperimentChange, baseline: ExperimentBaseline): string | null {
  if (change.unit === 'count' && !Number.isInteger(change.amount)) return 'a count changes by whole items'
  const delta = change.unit === 'percent' ? (baseline.value * change.amount) / 100 : change.amount
  const target = change.direction === 'increase' ? baseline.value + delta : baseline.value - delta
  if (target < 0) return `a decrease of ${change.amount} ${change.unit} from ${baseline.value} goes below zero`
  return baseline.unit === 'points' && target > 100 ? `an increase of ${change.amount} ${change.unit} from ${baseline.value} goes past 100 points` : null
}

/** The change is in the baseline's unit or in percent, and reachable from the baseline. */
function requireReachable(change: ExperimentChange, baseline: ExperimentBaseline, path: string): void {
  if (change.unit !== 'percent' && change.unit !== baseline.unit) {
    fail('invalid_input', `Invalid unit at ${path}.unit: the change is in the baseline's unit (${baseline.unit}) or in percent, not ${change.unit}.`, { path, unit: change.unit })
  }
  const problem = unreachable(change, baseline)
  if (problem !== null) {
    fail('invalid_input', `Invalid expected change at ${path}: ${problem}.`, { path })
  }
}

function destinationOf(input: RetroExperimentInput['destination'], repositories: string[] | null, path: string): ExperimentDestination {
  if (input.kind === 'darkmechanicus_source') return { kind: 'darkmechanicus_source' }
  const repository = input.repository ?? null
  if (repositories === null && repository !== null) {
    fail('invalid_input', `Invalid destination at ${path}.repository: this project is a single repository, so a destination names no repository.`, { path })
  }
  if (repositories !== null && (repository === null || !repositories.includes(repository))) {
    fail('invalid_input', `Invalid destination at ${path}.repository: name one repository of this folder (${repositories.join(', ')}).`, { path, repository })
  }
  return { kind: 'source_repository', repository }
}

/**
 * A new experiment gets a minted id; a restated one must be this sprint's, from an earlier revision, with its source
 * (the same report revision and assessment: a restatement names its original source by report id, never by subject).
 */
function experimentIdOf(input: RetroExperimentInput, source: ExperimentAssessmentRef, context: ExperimentContext, path: string): string {
  if (input.id === undefined) return context.mint()
  const known = context.known(input.id)
  if (known === null) {
    fail('invalid_input', `Unknown experiment ${input.id} at ${path}.id: give an id only to restate an experiment of an earlier revision of this sprint's report.`, { path, experimentId: input.id })
  }
  if (known.runId !== context.runId || known.sprintId !== context.sprintId) {
    fail('invalid_input', `Experiment ${input.id} at ${path}.id belongs to another sprint's report (${known.reportId}); write a new experiment instead.`, {
      path,
      experimentId: input.id,
      reportId: known.reportId
    })
  }
  const original = known.experiment.source
  if (original.reportId !== source.reportId || original.assessmentId !== source.assessmentId) {
    fail(
      'invalid_input',
      `Experiment ${input.id} at ${path}.source was drawn from assessment ${original.assessmentId} of report ${original.reportId}; a restated experiment keeps its source (cite it by that report id and assessment id).`,
      { path, experimentId: input.id }
    )
  }
  return input.id
}

function normalizeOne(raw: RetroExperimentInput, context: ExperimentContext, path: string): RetroExperiment {
  const input = parseInput(retroExperimentInput, raw, path) as RetroExperimentInput
  const { ref: source, grade, card } = resolveSource(input.source, context, `${path}.source`)
  const id = experimentIdOf(input, source, context, path)
  requireUnit(input.baseline, `${path}.baseline`)
  const reading = readMeasure(card, grade, input.baseline.measure)
  if ('missing' in reading) {
    fail('invalid_input', `Invalid baseline at ${path}.baseline: ${input.baseline.measure} has no value in assessment ${source.assessmentId} (${reading.missing}).`, {
      path: `${path}.baseline`,
      measure: input.baseline.measure
    })
  }
  const baseline: ExperimentBaseline = { measure: input.baseline.measure, unit: input.baseline.unit, ...reading }
  requireNotExploration(input, path)
  requireReachable(input.expectedChange, baseline, `${path}.expectedChange`)
  const guardrails = input.guardrails.map((guardrail, index) => {
    const at = `${path}.guardrails[${index}]`
    requireUnit(guardrail, at)
    if (guardrail.unit === 'points' && guardrail.threshold > 100) {
      fail('invalid_input', `Invalid guardrail at ${at}.threshold: points run from 0 to 100.`, { path: at })
    }
    return { measure: guardrail.measure, unit: guardrail.unit, comparator: guardrail.comparator, threshold: guardrail.threshold }
  })
  return {
    id,
    source,
    concern: input.concern,
    issue: { summary: input.issue.summary, evidence: evidenceOf(input.issue.evidence, `${path}.issue.evidence`) },
    hypothesis: input.hypothesis,
    destination: destinationOf(input.destination, context.repositories, `${path}.destination`),
    proposedWork: input.proposedWork.map((item) => workOf(item)),
    baseline,
    expectedChange: { direction: input.expectedChange.direction, amount: input.expectedChange.amount, unit: input.expectedChange.unit },
    guardrails,
    window: { basis: input.window.basis, count: input.window.count }
  }
}

function workOf(item: { title: string; body?: string; size?: TicketSize }): RetroExperiment['proposedWork'][number] {
  const work = { title: item.title, body: item.body ?? '' }
  return item.size === undefined ? work : { ...work, size: item.size }
}

/**
 * Productive effort includes planned tests and useful investigation, so cutting it is no correction: an experiment
 * never sets out to decrease `E.productive_ms` (valid exploration is not waste). Corrective effort is what it reduces.
 */
function requireNotExploration(input: RetroExperimentInput, path: string): void {
  if (input.baseline.measure === 'E.productive_ms' && input.expectedChange.direction === 'decrease') {
    fail(
      'invalid_input',
      `Invalid expected change at ${path}.expectedChange: E.productive_ms counts planned tests and useful investigation, which is not waste; aim a decrease at E.corrective_ms instead.`,
      { path: `${path}.expectedChange`, measure: input.baseline.measure }
    )
  }
}

/** The fewest characters a work item's body has before it counts as saying what changes. */
const SPECIFIC_WORK_MIN_CHARS = 40

/** The fewest words a specific body has (a long single token or a run of symbols says nothing). */
const SPECIFIC_WORK_MIN_WORDS = 6

/** The fewest distinct terms beyond filler words a specific body names: what changes, where, by how much. */
const SPECIFIC_WORK_MIN_TERMS = 3

/**
 * A body that is still to be written starts with one of these markers on its own ("TODO: …", "TBD."); a body that
 * names one as the thing it changes ("TODO comments in imports.ts are deleted", "Placeholder text of …") is fine.
 */
const PLACEHOLDER = /^[\s*_#>-]*(?:(?:tbd|tba|todo|fixme|placeholder)\s*(?:$|[:.!?…(—–-])|lorem ipsum\b)/i

/**
 * A body that opens by putting the decision off ("To be decided after …", "To be determined.") does not say what
 * changes yet. Only a leading "to be decided" or "to be determined" counts: "To be defined in limits.ts: …", "previously
 * to be decided, is set to 3", "exits as soon as oxlint reports" or "Replace the TBD markers in …" describe a change.
 */
const DEFERRED = /^[\s*_#>-]*to be (?:decided|determined)\b/i

/** Words that say nothing about what changes on their own, generic scope words ("the quality of the whole project") included. */
const FILLER = new Set(
  (
    'a an the and or but nor so to of in on at by for from with into onto as is are be been was were it its this that these those ' +
    'we our us you your they them their he she his her i me my all any some more most much many other such same then than also ' +
    'just very really etc do does did done make makes made get gets fix fixes fixed improve improves improved better best good ' +
    'stuff thing things work works issue issues problem problems change changes changed needed need needs should would could will can ' +
    'had has have having before after now again there here ' +
    'quality code codebase project projects whole overall general generally everything everywhere anything something somehow various lot lots'
  ).split(' ')
)

function wordsOf(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * Why a work item's body does not say what changes, or null when it does: shorter than `SPECIFIC_WORK_MIN_CHARS`
 * characters or `SPECIFIC_WORK_MIN_WORDS` words, starting with a placeholder marker (TBD, TODO, …) or by putting the
 * decision off ("To be decided …"), naming fewer than `SPECIFIC_WORK_MIN_TERMS` distinct terms beyond filler and generic
 * scope words (a repeated word, a generic "fix the issues" or "improve the quality of the whole project"), or naming
 * nothing its title does not already say. A concise concrete change ("Raise the reviewer timeout from 10 to 20
 * minutes.") is specific.
 */
export function vagueness(work: { title: string; body: string }): string | null {
  const body = work.body.trim()
  if (body.length < SPECIFIC_WORK_MIN_CHARS) return `its body is under ${SPECIFIC_WORK_MIN_CHARS} characters`
  if (PLACEHOLDER.test(body)) return 'its body starts with a placeholder (TBD, TODO, FIXME, …)'
  if (DEFERRED.test(body)) return 'its body opens by putting the decision off ("To be decided …")'
  const words = wordsOf(body)
  if (words.length < SPECIFIC_WORK_MIN_WORDS) return `its body has fewer than ${SPECIFIC_WORK_MIN_WORDS} words`
  const terms = new Set(words.filter((word) => word.length > 1 && !FILLER.has(word)))
  if (terms.size < SPECIFIC_WORK_MIN_TERMS) {
    return `its body names ${terms.size} distinct term(s) beyond filler words, fewer than ${SPECIFIC_WORK_MIN_TERMS}`
  }
  const title = new Set(wordsOf(work.title))
  if ([...terms].every((term) => title.has(term))) return 'its body only restates its title'
  return null
}

/**
 * Why an experiment's proposed work cannot be scheduled, started or completed yet, one line per problem (empty: it
 * can be). Each piece of work must be sized (`size`) and specific (`vagueness`: a body that says what changes); a vague
 * or unsized payload is restated with the missing parts in a later report revision first (`restatementOf`).
 */
export function executionProblems(experiment: RetroExperiment): string[] {
  return experiment.proposedWork.flatMap((work, index) => {
    const at = `proposedWork[${index}] "${work.title}"`
    const vague = vagueness(work)
    return [
      ...(work.size === undefined ? [`${at} has no size`] : []),
      ...(vague === null ? [] : [`${at} is vague: it does not say what changes (${vague})`])
    ]
  })
}

/**
 * A stored experiment as the next revision of its sprint's report restates it: by its id, from its original source
 * `{ reportId, assessmentId }` (never by subject, which would mint a new experiment and strand the original's events),
 * with every planning field as stored. An experiment the next revision leaves out is withdrawn, so a resubmission
 * restates each one it keeps; edit the returned input (size and describe the work) before submitting.
 */
export function restatementOf(experiment: RetroExperiment): CorrectionRestatement {
  return {
    id: experiment.id,
    source: { reportId: experiment.source.reportId, assessmentId: experiment.source.assessmentId },
    ...(experiment.concern === undefined ? {} : { concern: experiment.concern }),
    issue: { summary: experiment.issue.summary, evidence: experiment.issue.evidence.map(({ kind, id, detail }) => ({ kind, id, detail })) },
    hypothesis: experiment.hypothesis,
    destination:
      experiment.destination.kind === 'darkmechanicus_source'
        ? { kind: 'darkmechanicus_source' }
        : { kind: 'source_repository', repository: experiment.destination.repository },
    proposedWork: experiment.proposedWork.map((work) => ({ title: work.title, body: work.body, ...(work.size === undefined ? {} : { size: work.size }) })),
    baseline: { measure: experiment.baseline.measure, unit: experiment.baseline.unit },
    expectedChange: { ...experiment.expectedChange },
    guardrails: experiment.guardrails.map((guardrail) => ({ ...guardrail })),
    window: { ...experiment.window }
  }
}

/**
 * Evidence as written, each id checked against its kind and each detail against the ledger's text rule (no token,
 * credential or machine-local path); an unwritten detail is stored as null.
 */
export function evidenceOf(input: { kind: EvidenceRef['kind']; id: string; detail?: string | null }[], path: string): EvidenceRef[] {
  return input.map((item, index) => parseInput(evidenceRef, { kind: item.kind, id: item.id, detail: item.detail ?? null }, `${path}[${index}]`))
}

/**
 * The stored form of a retro's experiments: each validated in full (every planning field present), its source
 * resolved (a grade of the scorecard drafted for this very submission, by subject, or of an earlier revision's sealed
 * scorecard of the epic) and frozen with its identities, its baseline read from that grade, its units checked against
 * its measures and its destination against the project. A new experiment gets a minted id; an id is accepted only to
 * restate an experiment of an earlier revision of the same sprint's report, with the same source. An id listed twice,
 * or anything unresolved, fails the whole report with `invalid_input`, naming the field.
 */
export function normalizeExperiments(inputs: RetroExperimentInput[], context: ExperimentContext): RetroExperiment[] {
  const duplicate = repeated(inputs.flatMap((input) => (input.id === undefined ? [] : [input.id])))
  if (duplicate !== undefined) {
    fail('invalid_input', `Experiment ${duplicate} is listed twice in retro.experiments: restate each experiment once.`, { experimentId: duplicate })
  }
  return inputs.map((input, index) => normalizeOne(input, context, `retro.experiments[${index}]`))
}
