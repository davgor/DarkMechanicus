/**
 * The stored form of a scorecard snapshot (`ScorecardSnapshot`): how a grade is frozen into it, the schema every
 * snapshot is checked against when it is written, read back or imported, the hash that seals it, and the read that
 * regrades it.
 *
 * A snapshot keeps each grade's input (its seven component inputs, pooled by content hash) and a compact result, not
 * the explanations: those follow deterministically from the input and the policy. Reading a snapshot regrades every
 * stored input under the stored policy (found by hash in the registry, never the current one) and requires exactly
 * the stored result back, so a hand-edited input, result or policy is refused, and the explanations a reader sees are
 * the ones the approved grade had. `snapshotHash` must be the content hash of every other field.
 */
import { z } from 'zod'
import { VERIFICATION_REASONS } from '../../shared/domain/performance'
import {
  COMPONENT_MISSING_REASONS,
  type EvidenceRef,
  GRADE_LETTERS,
  GRADE_OUTCOMES,
  GRADE_STATUS_REASONS,
  GRADE_STATUSES,
  type GradeSubject,
  MEASUREMENT_STATES,
  SPACE_COMPONENTS,
  type SpaceComponent,
  type SpaceGrade,
  type SpaceGradeInput,
  VERIFICATION_STATES
} from '../../shared/domain/space'
import type {
  AggregateDetail,
  FrozenAggregate,
  FrozenComponentInput,
  FrozenGrade,
  FrozenResult,
  RequiredOutcome,
  ScorecardSnapshot,
  ScorecardView
} from '../../shared/domain/spaceGrades'
import { TIMING_ANOMALY_KINDS, TIMING_QUANTITIES, WAIT_CLASSES } from '../../shared/domain/timing'
import { canonicalJson, contentHash } from '../canonical'
import { fail } from '../errors'
import { derivedStableId, type IdKind, isStableId } from '../ids'
import { parseInput } from '../schemas'
import { measurementSchema } from './contract'
import { gradeSpace, spacePolicyByHash } from './rubric'

// ---------------------------------------------------------------------------------------------------------------
// Freezing

/** The snapshot id of a report revision: one snapshot per revision. */
export function snapshotIdOf(reportId: string): string {
  return derivedStableId('assessment', `scorecard\u0000${reportId}`)
}

/** A frozen grade's own assessment id: the snapshot's and the subject's. */
function assessmentIdOf(snapshotId: string, subject: GradeSubject): string {
  return derivedStableId('assessment', `${snapshotId}\u0000${subject.level}\u0000${subject.id}`)
}

function resultOf(grade: SpaceGrade): FrozenResult {
  const { inputHash, status, outcome, statusReasons, score, uncappedScore, displayScore, letter, coverage } = grade
  const components = grade.components.map(({ component, state, score: points, missingReason }) => ({ component, state, score: points, missingReason }))
  return { inputHash, status, outcome, statusReasons, score, uncappedScore, displayScore, letter, coverage, components }
}

/** Adds a value to a pool keyed by content hash and returns its key: identical values are stored once. */
export function pooled<T>(pool: Record<string, T>, value: T): string {
  const key = contentHash(value)
  pool[key] ??= value
  return key
}

/** A grade frozen into a snapshot: its components into the pool, its result in compact form. */
export function freezeGrade(snapshotId: string, input: SpaceGradeInput, grade: SpaceGrade, pool: Record<string, FrozenComponentInput>): FrozenGrade {
  const inputs = Object.fromEntries(SPACE_COMPONENTS.map((component) => [component, pooled(pool, input.components[component])])) as Record<SpaceComponent, string>
  return { subject: input.subject, assessmentId: assessmentIdOf(snapshotId, input.subject), dispatchedAt: input.dispatchedAt, inputs, result: resultOf(grade) }
}

/** The seal of a snapshot: the content hash of every field but `snapshotHash`. */
export function snapshotHashOf(snapshot: Omit<ScorecardSnapshot, 'snapshotHash'> & { snapshotHash?: string }): string {
  const { snapshotHash: _sealed, ...content } = snapshot
  return contentHash(content)
}

// ---------------------------------------------------------------------------------------------------------------
// Schema

const isoTime = z.iso.datetime({ offset: true })
const idOf = (kind: IdKind) => z.string().refine((value) => isStableId(value, kind), { message: `Expected a ${kind} id` })
const hash = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const ms = z.number().min(0).max(1e15)
const count = z.number().int().min(0)
const points = z.number().min(0).max(100)
const many = <T extends z.ZodType>(item: T) => z.array(item).max(10_000)

const quantitySchema = z.strictObject({
  quantity: z.enum(TIMING_QUANTITIES),
  unit: z.literal('milliseconds'),
  aggregation: z.enum(['single', 'union', 'sum']),
  ms: ms.nullable(),
  state: z.enum(['observed', 'estimated', 'partial', 'missing']),
  coverage: z.strictObject({ covered: ms, of: ms, unit: z.enum(['milliseconds', 'attempts']) }),
  open: z.boolean()
})

const windowEnd = z.enum(['submitted', 'failed', 'canceled', 'lease_expired', 'accepted', 'next_sprint', 'run_ended', 'cutoff'])

const windowShape = {
  elapsed: quantitySchema,
  startedAt: isoTime.nullable(),
  endedAt: isoTime.nullable(),
  inFlight: quantitySchema,
  activeWallClock: quantitySchema,
  effort: quantitySchema,
  overhead: quantitySchema
}

const timingSchema = z.strictObject({
  runId: idOf('run'),
  asOf: isoTime,
  basis: z.strictObject({ window: z.literal('activation'), totals: z.literal('current_plan') }),
  run: z.strictObject({ ...windowShape, unattributedEffort: quantitySchema }),
  sprint: z
    .strictObject({
      ...windowShape,
      sprintId: idOf('sprint'),
      ticketIds: many(idOf('ticket')),
      checkpointWait: quantitySchema,
      unattributedOverhead: quantitySchema
    })
    .nullable(),
  tickets: many(
    z.strictObject({
      ticketId: idOf('ticket'),
      sprintId: idOf('sprint').nullable(),
      readyAt: isoTime.nullable(),
      firstClaimAt: isoTime.nullable(),
      acceptedAt: isoTime.nullable(),
      endedBy: windowEnd,
      cycleTime: quantitySchema,
      leadTime: quantitySchema,
      active: quantitySchema,
      effort: quantitySchema,
      overhead: quantitySchema
    })
  ),
  anomalies: many(z.strictObject({ kind: z.enum(TIMING_ANOMALY_KINDS), subject: z.string().max(20_000), detail: z.string().max(20_000) }))
})

const ticketOfRun = z.strictObject({ runId: idOf('run'), ticketId: idOf('ticket') })

const efficiencySchema = z.strictObject({
  runId: idOf('run'),
  effort: z.strictObject({
    effortMs: ms.nullable(),
    state: z.enum(['observed', 'estimated', 'partial', 'missing']),
    coverage: z.strictObject({ covered: ms, of: ms, unit: z.enum(['milliseconds', 'attempts']) }),
    overheadMs: ms.nullable()
  }),
  time: z.strictObject({
    actual: measurementSchema,
    overheadMs: ms.nullable(),
    excludedWaitsMs: z.partialRecord(z.enum(WAIT_CLASSES), ms).nullable(),
    unreportedAttemptIds: many(idOf('attempt')),
    openAttemptIds: many(idOf('attempt'))
  }),
  tokens: z.strictObject({ actual: measurementSchema, unreportedAttemptIds: many(idOf('attempt')), openAttemptIds: many(idOf('attempt')) }),
  retries: count.nullable()
})

const detailSchema = z.strictObject({
  runIds: many(idOf('run')),
  measuredRunIds: many(idOf('run')),
  outcomes: many(
    z.strictObject({
      runId: idOf('run'),
      ticketId: idOf('ticket'),
      role: z.enum(['integrated', 'work', 'optional']),
      state: z.enum(VERIFICATION_STATES),
      reason: z.enum(VERIFICATION_REASONS),
      attemptId: idOf('attempt').nullable(),
      movedOut: z.boolean(),
      counted: z.boolean()
    })
  ),
  rollups: z.strictObject({
    T: z.strictObject({ overhead: many(ticketOfRun), partial: z.boolean() }),
    K: z.strictObject({ overhead: many(ticketOfRun), partial: z.boolean() })
  }),
  efficiency: many(efficiencySchema)
})

const resultSchema = z.strictObject({
  inputHash: hash,
  status: z.enum(GRADE_STATUSES),
  outcome: z.enum(GRADE_OUTCOMES),
  statusReasons: z.array(z.enum(GRADE_STATUS_REASONS)).max(GRADE_STATUS_REASONS.length),
  score: points.nullable(),
  uncappedScore: points.nullable(),
  displayScore: z.string().max(16).nullable(),
  letter: z.enum(GRADE_LETTERS).nullable(),
  coverage: z.number().min(0).max(1),
  components: z
    .array(
      z.strictObject({
        component: z.enum(SPACE_COMPONENTS),
        state: z.enum(MEASUREMENT_STATES),
        score: points.nullable(),
        missingReason: z.enum(COMPONENT_MISSING_REASONS).nullable()
      })
    )
    .length(SPACE_COMPONENTS.length)
})

const subjectSchema = z.strictObject({ level: z.enum(['ticket', 'sprint', 'run', 'epic']), id: z.string().min(1).max(64) })
const refsSchema = z.strictObject(Object.fromEntries(SPACE_COMPONENTS.map((component) => [component, hash])) as Record<SpaceComponent, typeof hash>)
const gradeShape = { subject: subjectSchema, assessmentId: idOf('assessment'), dispatchedAt: isoTime.nullable(), inputs: refsSchema, result: resultSchema }
const frozenGradeSchema = z.strictObject(gradeShape)
const frozenAggregateSchema = z.strictObject({ ...gradeShape, detail: hash })

const scorecardShape = z.strictObject({
  format: z.literal('darkmechanicus.scorecard'),
  formatVersion: z.literal(1),
  snapshotId: idOf('assessment'),
  epicId: idOf('epic'),
  runId: idOf('run'),
  sprintId: idOf('sprint'),
  report: z.strictObject({ reportId: idOf('report'), reportRevision: z.number().int().min(1), contentHash: hash }),
  planRevisionId: idOf('revision'),
  cutoff: isoTime,
  policy: z.strictObject({ policyId: z.string().min(1).max(64), version: z.number().int().min(1), hash }),
  sprint: frozenAggregateSchema,
  run: frozenAggregateSchema,
  epic: frozenAggregateSchema.nullable(),
  tickets: many(frozenGradeSchema),
  // Checked when read: every grade is regraded from these, which validates each against the grade input schema.
  inputs: z.record(hash, z.custom<FrozenComponentInput>()),
  details: z.record(hash, detailSchema),
  timing: timingSchema,
  sources: z.strictObject({ runIds: many(idOf('run')), ticketIds: many(idOf('ticket')), attemptIds: many(idOf('attempt')) }),
  anomalies: many(z.strictObject({ kind: z.literal('dispatch_mismatch'), detail: z.string().max(2_000) })),
  snapshotHash: hash
})
type ScorecardShape = z.infer<typeof scorecardShape>

const subjectKey = (subject: GradeSubject): string => `${subject.level}:${subject.id}`

/** The problems with a snapshot's own identity: its id, the subjects it names and their assessment ids. */
function identityProblems(snapshot: ScorecardShape): string[] {
  const expected: [FrozenGrade, GradeSubject][] = [
    [snapshot.sprint, { level: 'sprint', id: snapshot.sprintId }],
    [snapshot.run, { level: 'run', id: snapshot.runId }],
    ...(snapshot.epic === null ? [] : ([[snapshot.epic, { level: 'epic', id: snapshot.epicId }]] as [FrozenGrade, GradeSubject][]))
  ]
  const problems: string[] = []
  if (snapshot.snapshotId !== snapshotIdOf(snapshot.report.reportId)) problems.push('the snapshot id is not its report revision\'s')
  if (expected.some(([grade, subject]) => subjectKey(grade.subject) !== subjectKey(subject))) problems.push('a sprint, run or epic grade names another subject than the snapshot')
  const tickets = new Set(snapshot.tickets.map((grade) => grade.subject.id))
  if (snapshot.tickets.some((grade) => grade.subject.level !== 'ticket') || tickets.size !== snapshot.tickets.length) problems.push('the ticket grades are not distinct tickets')
  if ([...tickets].some((id) => !isStableId(id, 'ticket'))) problems.push('a ticket grade names no ticket id')
  const grades = [...expected.map(([grade]) => grade), ...snapshot.tickets]
  if (grades.some((grade) => grade.assessmentId !== assessmentIdOf(snapshot.snapshotId, grade.subject))) problems.push('an assessment id is not derived from the snapshot and its subject')
  return problems
}

/** The problems with a snapshot's pools: a key that is not its value's hash, a dangling or an unused entry. */
function poolProblems(snapshot: ScorecardShape): string[] {
  const grades = [snapshot.sprint, snapshot.run, ...(snapshot.epic === null ? [] : [snapshot.epic]), ...snapshot.tickets]
  const usedInputs = new Set(grades.flatMap((grade) => Object.values(grade.inputs)))
  const usedDetails = new Set([snapshot.sprint, snapshot.run, ...(snapshot.epic === null ? [] : [snapshot.epic])].map((grade) => grade.detail))
  const problems: string[] = []
  for (const [pool, used, what] of [
    [snapshot.inputs, usedInputs, 'input'],
    [snapshot.details, usedDetails, 'detail']
  ] as const) {
    const keys = Object.keys(pool)
    if (keys.some((key) => contentHash(pool[key]) !== key)) problems.push(`an ${what} is stored under another hash than its own`)
    if ([...used].some((key) => !Object.hasOwn(pool, key))) problems.push(`a grade names an ${what} the snapshot does not hold`)
    if (keys.some((key) => !used.has(key))) problems.push(`the snapshot holds an ${what} no grade names`)
  }
  return problems
}

export const scorecardSnapshotSchema = scorecardShape.superRefine((snapshot, ctx) => {
  if (snapshotHashOf(snapshot) !== snapshot.snapshotHash) {
    ctx.addIssue({ code: 'custom', path: ['snapshotHash'], message: 'The snapshot hash does not match its content: a snapshot is never edited' })
  }
  const policy = spacePolicyByHash(snapshot.policy.hash)
  if (policy === null || policy.policyId !== snapshot.policy.policyId || policy.version !== snapshot.policy.version) {
    ctx.addIssue({ code: 'custom', path: ['policy'], message: `Policy ${snapshot.policy.policyId} v${snapshot.policy.version} (${snapshot.policy.hash}) is not one this build grades under` })
  }
  for (const message of [...identityProblems(snapshot), ...poolProblems(snapshot)]) {
    ctx.addIssue({ code: 'custom', message })
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Reading

/** The input a frozen grade was computed from, rebuilt from the pool (of a sealed snapshot or a draft). */
export function frozenInput(snapshot: Pick<ScorecardSnapshot, 'inputs' | 'cutoff'>, grade: FrozenGrade): SpaceGradeInput {
  const components = Object.fromEntries(SPACE_COMPONENTS.map((component) => [component, snapshot.inputs[grade.inputs[component]]]))
  return { subject: grade.subject, cutoff: snapshot.cutoff, dispatchedAt: grade.dispatchedAt, components: components as unknown as SpaceGradeInput['components'] }
}

/** A frozen grade regraded under the snapshot's own policy; it must give back exactly the frozen result. */
function regraded(snapshot: ScorecardSnapshot, grade: FrozenGrade): SpaceGrade {
  const policy = spacePolicyByHash(snapshot.policy.hash) ?? fail('invalid_input', `Policy ${snapshot.policy.hash} is not one this build grades under.`)
  const full = gradeSpace(frozenInput(snapshot, grade), policy)
  if (canonicalJson(resultOf(full)) !== canonicalJson(grade.result)) {
    fail('invalid_input', `The frozen ${grade.subject.level} grade of ${grade.subject.id} does not follow from its stored input under policy ${snapshot.policy.hash}.`, {
      subject: grade.subject
    })
  }
  return { ...full, assessmentId: grade.assessmentId }
}

/** Every grade of a snapshot as read: regraded from its stored input, with its explanations. */
export function readScorecard(snapshot: ScorecardSnapshot): ScorecardView {
  const aggregate = (grade: ScorecardSnapshot['sprint']) => ({ grade: regraded(snapshot, grade), detail: snapshot.details[grade.detail] ?? fail('invalid_input', 'A frozen aggregate names a missing detail.') })
  return {
    snapshot,
    sprint: aggregate(snapshot.sprint),
    run: aggregate(snapshot.run),
    epic: snapshot.epic === null ? null : aggregate(snapshot.epic),
    tickets: snapshot.tickets.map((grade) => regraded(snapshot, grade))
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Agreement of the recorded parts with the grades

/** How an aggregate's P input cites a counted outcome; `derivedProblems` requires exactly these citations back. */
export function outcomeEvidence(outcome: RequiredOutcome): EvidenceRef {
  return { kind: 'ticket', id: outcome.ticketId, detail: `${outcome.state} (${outcome.reason})${outcome.movedOut ? ', since moved out of this sprint' : ''}` }
}

const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

const failed = (checks: readonly [boolean, string][]): string[] => checks.filter(([ok]) => !ok).map(([, problem]) => problem)

/** What an aggregate's detail records of T or K (efficiency, roll-up) that its regraded input does not agree with. */
function resourceProblems(input: SpaceGradeInput, detail: AggregateDetail, component: 'T' | 'K'): string[] {
  const resource = input.components[component]
  const rollup = detail.rollups[component]
  const scopes = detail.efficiency.map((scope) => (component === 'T' ? scope.time : scope.tokens))
  const only = scopes.length === 1 ? scopes[0] : undefined
  const offered = resource.baseline.state === 'selected' && resource.baseline.baseline.kind === 'rollup' ? resource.baseline.baseline : null
  return failed([
    [only === undefined || rollup.partial || sameJson(only.actual, resource.actual), 'actual is not its efficiency\'s'],
    [resource.unreportedAttempts === scopes.reduce((sum, scope) => sum + scope.unreportedAttemptIds.length, 0), 'unreported attempts are not its efficiency\'s'],
    [offered === null || rollup.partial === offered.uncovered.length > 0, 'roll-up is marked otherwise than the baseline it was offered']
  ]).map((problem) => `the ${input.subject.level} grade's ${component} ${problem}`)
}

/** What an aggregate's detail (outcomes, roll-ups, efficiency) records that its regraded input does not agree with. */
function aggregateProblems(snapshot: ScorecardSnapshot, grade: FrozenAggregate, detail: AggregateDetail): string[] {
  const input = frozenInput(snapshot, grade)
  const name = `the ${grade.subject.level} grade's`
  const cited = input.components.P.verification.evidence.filter((entry) => entry.kind === 'ticket')
  return [
    ...failed([
      [sameJson(cited, detail.outcomes.filter((outcome) => outcome.counted).map(outcomeEvidence)), `${name} counted outcomes are not the ones its P input cites`],
      [sameJson(detail.efficiency.map((scope) => scope.runId), detail.measuredRunIds), `${name} efficiency is not its measured runs'`]
    ]),
    ...resourceProblems(input, detail, 'T'),
    ...resourceProblems(input, detail, 'K')
  ]
}

/** What the snapshot's tickets and source ids record that the sprint's and run's details do not agree with. */
function scopeProblems(snapshot: ScorecardSnapshot, sprint: AggregateDetail, run: AggregateDetail, epic: AggregateDetail | null): string[] {
  const tickets = snapshot.tickets.map((grade) => grade.subject.id)
  const sources = new Set(snapshot.sources.ticketIds)
  const attempts = new Set(snapshot.sources.attemptIds)
  const own = [sprint, run].flatMap((detail) => detail.efficiency.filter((scope) => scope.runId === snapshot.runId))
  return failed([
    [sameJson(sprint.runIds, [snapshot.runId]) && sameJson(run.runIds, [snapshot.runId]), 'the sprint or run grade names other runs'],
    [sameJson(snapshot.sources.runIds, epic === null ? [snapshot.runId] : epic.runIds), 'the source runs are not the graded runs'],
    [sameJson(tickets, sprint.outcomes.filter((outcome) => !outcome.movedOut).map((outcome) => outcome.ticketId)), 'the ticket grades are not the sprint\'s tickets'],
    [sprint.outcomes.every((outcome) => outcome.runId === snapshot.runId), 'a sprint outcome belongs to another run'],
    [run.outcomes.every((outcome) => outcome.movedOut || sources.has(outcome.ticketId)), 'a ticket of the run is not among the source tickets'],
    [snapshot.sources.ticketIds.every((id) => run.outcomes.some((outcome) => outcome.ticketId === id)), 'a source ticket has no outcome in the run'],
    [[...sprint.outcomes, ...run.outcomes].every((outcome) => outcome.attemptId === null || attempts.has(outcome.attemptId)), 'an outcome stands on an attempt not among the sources'],
    [
      attempts.size === snapshot.sources.attemptIds.length && attempts.size >= (frozenInput(snapshot, snapshot.run).components.A.activity.attempts ?? 0),
      'the source attempts repeat or are fewer than the run\'s work attempts'
    ],
    [
      own.every((scope) => [...scope.time.unreportedAttemptIds, ...scope.time.openAttemptIds, ...scope.tokens.unreportedAttemptIds, ...scope.tokens.openAttemptIds].every((id) => attempts.has(id))),
      'the efficiency names an attempt not among the sources'
    ]
  ])
}

/** What the snapshot's frozen timing records that its ticket list and the sprint's, run's and tickets' grades do not agree with. */
function timingProblems(snapshot: ScorecardSnapshot, sprint: AggregateDetail, run: AggregateDetail): string[] {
  const { timing } = snapshot
  const tickets = snapshot.tickets.map((grade) => grade.subject.id)
  const sameSet = (a: readonly string[], b: readonly string[]): boolean => sameJson([...new Set(a)].sort(), [...new Set(b)].sort())
  const effortOf = (ticketId: string): number | null | undefined => timing.tickets.find((ticket) => ticket.ticketId === ticketId)?.effort.ms
  return failed([
    [timing.runId === snapshot.runId && timing.asOf === snapshot.cutoff, 'the timing is not the run\'s at the cutoff'],
    [timing.sprint === null || (timing.sprint.sprintId === snapshot.sprintId && sameSet(timing.sprint.ticketIds, tickets)), 'the sprint timing is not the graded sprint\'s'],
    [sameSet(timing.tickets.map((ticket) => ticket.ticketId), tickets), 'the ticket timing is not the graded tickets\''],
    [timing.sprint === null || sprint.efficiency[0]?.effort.effortMs === timing.sprint.effort.ms, 'the sprint timing\'s effort is not the sprint grade\'s'],
    [run.efficiency[0]?.effort.effortMs === timing.run.effort.ms, 'the run timing\'s effort is not the run grade\'s'],
    [
      snapshot.tickets.every((grade) => {
        const actual = frozenInput(snapshot, grade).components.T.actual
        return actual.state === 'missing' || actual.value === effortOf(grade.subject.id)
      }),
      'a ticket\'s timing effort is not its T actual'
    ]
  ])
}

/**
 * What a snapshot records beside its grades (tickets, outcomes, roll-ups, efficiency, source ids, timing) that does
 * not agree with the grades' own inputs: each part is checked against the regraded inputs it was frozen with, so a
 * re-sealed edit to any of them is refused like an edited grade.
 */
function derivedProblems(snapshot: ScorecardSnapshot): string[] {
  const detailOf = (grade: FrozenAggregate): AggregateDetail => snapshot.details[grade.detail] ?? fail('invalid_input', 'A frozen aggregate names a missing detail.')
  const aggregates = [snapshot.sprint, snapshot.run, ...(snapshot.epic === null ? [] : [snapshot.epic])]
  const [sprint, run] = [detailOf(snapshot.sprint), detailOf(snapshot.run)]
  return [
    ...aggregates.flatMap((grade) => aggregateProblems(snapshot, grade, detailOf(grade))),
    ...scopeProblems(snapshot, sprint, run, snapshot.epic === null ? null : detailOf(snapshot.epic)),
    ...timingProblems(snapshot, sprint, run)
  ]
}

/**
 * A snapshot checked against its schema, seal, identity and pools, regraded (every frozen result must follow from its
 * stored input under its stored policy), and its recorded tickets, outcomes, efficiency, sources and timing checked
 * against those inputs. Fails with `invalid_input` otherwise. The value is returned as given.
 */
export function parseScorecardSnapshot(value: unknown): ScorecardSnapshot {
  const snapshot = parseInput<ScorecardSnapshot>(scorecardSnapshotSchema, value, 'scorecard snapshot')
  readScorecard(snapshot)
  const problems = derivedProblems(snapshot)
  if (problems.length > 0) {
    fail('invalid_input', `Invalid scorecard snapshot: ${problems.join('; ')}; a snapshot's recorded parts must agree with its grades.`, { problems })
  }
  return snapshot
}
