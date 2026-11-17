/**
 * Runtime validation of the SPACE contract (`src/shared/domain/space.ts`): observations, baselines, the grading
 * policy, grade inputs and grades. Every serialized SPACE record, including the checked-in fixtures under
 * `fixtures/`, parses here, and every parser is typed against the shared contract so the two cannot drift.
 */
import { z } from 'zod'
import { REASONING_LEVELS, TICKET_SIZES, WORK_TYPES } from '../../shared/domain/bundle'
import {
  ACCUMULATIONS,
  BASELINE_METRICS,
  BASELINE_REJECTIONS,
  BASELINE_UNITS,
  COMPONENT_MISSING_REASONS,
  EVIDENCE_KINDS,
  GRADE_LETTERS,
  GRADE_OUTCOMES,
  GRADE_STATUS_REASONS,
  GRADE_STATUSES,
  GRADE_SUBJECT_LEVELS,
  HUMAN_INTERVENTIONS,
  HUMAN_REVIEW_ACTIVITIES,
  MEASUREMENT_STATES,
  METRIC_DEFINITIONS,
  METRIC_KINDS,
  METRIC_SCOPE_LEVELS,
  METRIC_SOURCES,
  METRIC_UNITS,
  OBSERVATION_MISSING_REASONS,
  REGRESSION_SEVERITIES,
  SCOPE_REQUIRED_IDS,
  SIGNAL_KINDS,
  SPACE_COMPONENTS,
  USAGE_COVERAGES,
  VERIFICATION_STATES,
  WORKFLOW_CAUSES,
  type Baseline,
  type BaselineSubject,
  type EvidenceKind,
  type GradeStatusReason,
  type GradeSubjectLevel,
  type MetricObservation,
  type MetricScope,
  type MetricUnit,
  type SpaceGrade,
  type SpaceGradeInput,
  type SpacePolicy
} from '../../shared/domain/space'
import { type IdKind, isStableId } from '../ids'
import { CRITERION_ID_PATTERN } from '../plan/normalize'
import { commitHash, parseInput } from '../schemas'

const isoTime = z.iso.datetime({ offset: true })

/** Whether `value` is an ISO 8601 date-time with an offset, the only time form the contracts accept. */
export function isIsoTime(value: unknown): value is string {
  return isoTime.safeParse(value).success
}

const idOf = (kind: IdKind) => z.string().refine((value) => isStableId(value, kind), { message: `Expected a ${kind} id` })
/** No Dark Mechanicus measure nears 10^15 tokens or milliseconds; the bound keeps every derived ratio finite. */
const quantity = z.number().min(0).max(1e15)
const count = z.number().int().min(0)
const label = z.string().min(1).max(200)

/** The stable-id kind each evidence kind cites; criterion and check cite a ticket and an attempt. */
const EVIDENCE_ID_KIND: Readonly<Record<Exclude<EvidenceKind, 'commit'>, IdKind>> = {
  observation: 'metricObservation',
  baseline: 'baseline',
  attempt: 'attempt',
  run: 'run',
  ticket: 'ticket',
  sprint: 'sprint',
  report: 'report',
  comment: 'comment',
  criterion: 'ticket',
  check: 'attempt'
}

export const evidenceRefSchema = z
  .strictObject({ kind: z.enum(EVIDENCE_KINDS), id: z.string().max(64), detail: z.string().max(200).nullable() })
  .superRefine((ref, ctx) => {
    const idOk = ref.kind === 'commit' ? commitHash.safeParse(ref.id).success : isStableId(ref.id, EVIDENCE_ID_KIND[ref.kind])
    if (!idOk) {
      ctx.addIssue({ code: 'custom', path: ['id'], message: `Expected the id of a ${ref.kind}` })
    }
    if (ref.kind === 'criterion' && !(ref.detail !== null && CRITERION_ID_PATTERN.test(ref.detail))) {
      ctx.addIssue({ code: 'custom', path: ['detail'], message: 'A criterion reference names its criterion id (c1)' })
    }
    if (ref.kind === 'check' && !ref.detail) {
      ctx.addIssue({ code: 'custom', path: ['detail'], message: 'A check reference names the check' })
    }
  })
const evidenceList = z.array(evidenceRefSchema).max(500)
/** What a grade input or result cites: a run, sprint or epic grade cites every handoff check and outcome in scope. */
const gradeEvidence = z.array(evidenceRefSchema).max(20_000)

/** The ids each level may set beyond its required ones: never anything more specific than the level. */
const SCOPE_ALLOWED_IDS: Readonly<Record<MetricScope['level'], readonly (keyof Omit<MetricScope, 'level'>)[]>> = {
  project: [],
  epic: ['epicId'],
  sprint: ['epicId', 'sprintId'],
  run: ['epicId', 'sprintId', 'runId'],
  ticket: ['epicId', 'sprintId', 'runId', 'ticketId'],
  attempt: ['epicId', 'sprintId', 'runId', 'ticketId', 'attemptId']
}

const metricScopeSchema = z
  .strictObject({
    level: z.enum(METRIC_SCOPE_LEVELS),
    epicId: idOf('epic').nullable(),
    sprintId: idOf('sprint').nullable(),
    runId: idOf('run').nullable(),
    ticketId: idOf('ticket').nullable(),
    attemptId: idOf('attempt').nullable()
  })
  .superRefine((scope, ctx) => {
    for (const key of ['epicId', 'sprintId', 'runId', 'ticketId', 'attemptId'] as const) {
      const set = scope[key] !== null
      if (SCOPE_REQUIRED_IDS[scope.level].includes(key) && !set) {
        ctx.addIssue({ code: 'custom', path: [key], message: `A scope at ${scope.level} level names its ${key}` })
      }
      if (!SCOPE_ALLOWED_IDS[scope.level].includes(key) && set) {
        ctx.addIssue({ code: 'custom', path: [key], message: `A scope at ${scope.level} level cannot name a ${key}` })
      }
    }
  })

export const measurementSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('observed'), value: quantity }),
  z.strictObject({ state: z.literal('estimated'), value: quantity, method: label }),
  z.strictObject({ state: z.literal('missing'), reason: z.enum(OBSERVATION_MISSING_REASONS) })
])

const attributes = z
  .record(z.string().min(1).max(64), z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]))
  .refine((value) => Object.keys(value).length <= 20, 'An observation has at most 20 attributes')

/** The values each discrete unit allows; other units take any non-negative number. */
const UNIT_VALUE_RULES: Partial<Record<MetricUnit, { valid: (value: number) => boolean; message: string }>> = {
  rating_1_5: { valid: (value) => Number.isInteger(value) && value >= 1 && value <= 5, message: 'A rating is a whole number from 1 to 5' },
  pass_fail: { valid: (value) => value === 0 || value === 1, message: 'A pass/fail value is 1 or 0' },
  count: { valid: Number.isInteger, message: 'A count is a whole number' },
  tokens: { valid: Number.isInteger, message: 'Tokens are whole numbers' }
}

type ProvenanceFields = Pick<MetricObservation, 'metric' | 'source' | 'intervention' | 'usage' | 'attributes'>

/** Who may record a human intervention, which metric needs one, and which metrics carry a parent/child usage scope. */
const PROVENANCE_RULES: { path: string[]; broken: (obs: ProvenanceFields) => boolean; message: (obs: ProvenanceFields) => string }[] = [
  {
    path: ['intervention'],
    broken: (obs) => obs.intervention !== undefined && obs.source.kind !== 'human' && obs.source.kind !== 'server',
    message: () => 'Only a person or the server records a human intervention'
  },
  {
    path: ['intervention'],
    broken: (obs) => obs.metric === 'rescue_minutes' && obs.intervention === undefined,
    message: () => 'Rescue time names the intervention it measures'
  },
  {
    path: ['intervention'],
    broken: (obs) => obs.metric === 'human_review_minutes' && obs.intervention !== undefined,
    message: () => 'Planned review or playtesting is not an intervention: rescue time records those'
  },
  {
    path: ['attributes', 'activity'],
    broken: (obs) => obs.metric === 'human_review_minutes' && !HUMAN_REVIEW_ACTIVITIES.some((activity) => activity === obs.attributes.activity),
    message: () => `Planned human time names its activity: ${HUMAN_REVIEW_ACTIVITIES.join(' or ')}`
  },
  {
    path: ['usage'],
    broken: (obs) => obs.usage !== undefined && !['T', 'K'].includes(METRIC_DEFINITIONS[obs.metric].component ?? ''),
    message: (obs) => `${obs.metric} is not token or active-time usage`
  },
  {
    path: ['usage', 'parentActor'],
    broken: (obs) => obs.usage !== undefined && obs.usage.parentActor !== null && obs.usage.parentActor === obs.source.actor,
    message: () => 'A source is not its own parent'
  }
]

export const metricObservationSchema = z
  .strictObject({
    observationId: idOf('metricObservation'),
    metric: z.enum(METRIC_KINDS),
    unit: z.enum(METRIC_UNITS),
    scope: metricScopeSchema,
    source: z.strictObject({ kind: z.enum(METRIC_SOURCES), actor: z.string().min(1).max(200).nullable() }),
    measurement: measurementSchema,
    accumulation: z.enum(ACCUMULATIONS),
    sequence: count.nullable(),
    observedAt: isoTime,
    recordedAt: isoTime,
    attributes,
    evidence: evidenceList,
    cause: z.enum(WORKFLOW_CAUSES).optional(),
    intervention: z.enum(HUMAN_INTERVENTIONS).optional(),
    usage: z
      .strictObject({ coverage: z.enum(USAGE_COVERAGES), parentActor: z.string().min(1).max(200).nullable() })
      .optional()
  })
  .superRefine((obs, ctx) => {
    const def = METRIC_DEFINITIONS[obs.metric]
    if (obs.unit !== def.unit) {
      ctx.addIssue({ code: 'custom', path: ['unit'], message: `${obs.metric} is measured in ${def.unit}` })
    }
    if (!def.sources.includes(obs.source.kind)) {
      ctx.addIssue({ code: 'custom', path: ['source', 'kind'], message: `${obs.metric} cannot come from source kind ${obs.source.kind}` })
    }
    if (!def.accumulations.includes(obs.accumulation)) {
      ctx.addIssue({ code: 'custom', path: ['accumulation'], message: `${obs.metric} is not reported as ${obs.accumulation}` })
    }
    if (obs.accumulation === 'cumulative' && obs.sequence === null) {
      ctx.addIssue({ code: 'custom', path: ['sequence'], message: 'A cumulative report carries its stream sequence' })
    }
    const rule = UNIT_VALUE_RULES[def.unit]
    if (rule !== undefined && obs.measurement.state !== 'missing' && !rule.valid(obs.measurement.value)) {
      ctx.addIssue({ code: 'custom', path: ['measurement', 'value'], message: rule.message })
    }
    PROVENANCE_RULES.filter((check) => check.broken(obs)).forEach((check) => {
      ctx.addIssue({ code: 'custom', path: check.path, message: check.message(obs) })
    })
  })

const cohortKeySchema = z.strictObject({
  workType: z.enum(WORK_TYPES),
  size: z.enum(TICKET_SIZES),
  risk: z.enum(REASONING_LEVELS)
})

const baselineCommon = {
  baselineId: idOf('baseline'),
  metric: z.enum(BASELINE_METRICS),
  unit: z.enum(METRIC_UNITS),
  version: z.number().int().min(1),
  value: quantity,
  frozenAt: isoTime
}

const rollupMemberSchema = z.strictObject({
  runId: idOf('run'),
  ticketId: idOf('ticket'),
  baselineId: idOf('baseline'),
  kind: z.enum(['budget', 'cohort']),
  value: quantity,
  frozenAt: isoTime,
  dispatchedAt: isoTime
})

interface RollupShape {
  value: number
  frozenAt: string
  members: { runId: string; ticketId: string; value: number; frozenAt: string }[]
  uncovered: { runId: string; ticketId: string }[]
}

/**
 * Why a roll-up disagrees with its own members: a ticket named twice (a ticket's baseline counts once per scope, even
 * when it ran in several runs of an epic), a value other than their sum, a freeze other than their latest.
 */
function rollupProblems(rollup: RollupShape): [string, string][] {
  const keys = [...rollup.members, ...rollup.uncovered].map((entry) => entry.ticketId)
  const latest = rollup.members.reduce<string | null>((max, member) => (max === null || Date.parse(member.frozenAt) > Date.parse(max) ? member.frozenAt : max), null)
  const problems: [string, string][] = []
  if (new Set(keys).size !== keys.length) {
    problems.push(['members', 'A roll-up names each ticket once, as a member or as uncovered'])
  }
  if (rollup.members.reduce((sum, member) => sum + member.value, 0) !== rollup.value) {
    problems.push(['value', 'A roll-up is the sum of its members'])
  }
  if (latest !== null && Date.parse(latest) !== Date.parse(rollup.frozenAt)) {
    problems.push(['frozenAt', 'A roll-up is frozen at its latest member freeze'])
  }
  return problems
}

const baselineSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ ...baselineCommon, kind: z.literal('budget'), ticketId: idOf('ticket'), revisionId: idOf('revision') }),
    z.strictObject({
      ...baselineCommon,
      kind: z.literal('cohort'),
      cohort: cohortKeySchema,
      statistic: z.literal('median'),
      sampleSize: z.number().int().min(1),
      spread: z.strictObject({ p25: quantity, p75: quantity }).nullable(),
      memberTicketIds: z.array(idOf('ticket')).max(10_000)
    }),
    z.strictObject({
      ...baselineCommon,
      kind: z.literal('rollup'),
      members: z.array(rollupMemberSchema).max(10_000),
      uncovered: z.array(z.strictObject({ runId: idOf('run'), ticketId: idOf('ticket') })).max(10_000)
    })
  ])
  .superRefine((baseline, ctx) => {
    if (baseline.unit !== BASELINE_UNITS[baseline.metric]) {
      ctx.addIssue({ code: 'custom', path: ['unit'], message: `${baseline.metric} is measured in ${BASELINE_UNITS[baseline.metric]}` })
    }
    if (baseline.kind === 'cohort' && baseline.memberTicketIds.length > baseline.sampleSize) {
      ctx.addIssue({ code: 'custom', path: ['memberTicketIds'], message: 'A cohort lists at most sampleSize members' })
    }
    if (baseline.kind === 'rollup') {
      rollupProblems(baseline).forEach(([path, message]) => ctx.addIssue({ code: 'custom', path: [path], message }))
    }
  })

const rejectionList = z.array(z.strictObject({ baselineId: idOf('baseline'), reason: z.enum(BASELINE_REJECTIONS) })).max(1_000)

/** A selected baseline is at least one unit, so a resource ratio is always finite. */
const baselineSelectionSchema = z
  .discriminatedUnion('state', [
    z.strictObject({ state: z.literal('selected'), baseline: baselineSchema, rejected: rejectionList }),
    z.strictObject({ state: z.literal('missing'), reason: z.literal('no_eligible_baseline'), rejected: rejectionList })
  ])
  .superRefine((selection, ctx) => {
    if (selection.state === 'selected' && selection.baseline.value < 1) {
      ctx.addIssue({ code: 'custom', path: ['baseline', 'value'], message: 'A selected baseline is at least one unit' })
    }
  })

const baselineSubjectSchema = z.strictObject({
  ticketId: idOf('ticket'),
  metric: z.enum(BASELINE_METRICS),
  cohort: cohortKeySchema,
  dispatchedAt: isoTime
})

const score = z.number().min(0).max(100)

const spacePolicySchema = z
  .strictObject({
    policyId: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    version: z.number().int().min(1),
    components: z
      .array(
        z.strictObject({
          component: z.enum(SPACE_COMPONENTS),
          weight: z.number().int().min(1).max(100),
          required: z.boolean(),
          signal: z.enum(SIGNAL_KINDS),
          rule: label
        })
      )
      .length(SPACE_COMPONENTS.length),
    bands: z.array(z.strictObject({ letter: z.enum(GRADE_LETTERS), min: score })).length(GRADE_LETTERS.length),
    precision: z.strictObject({
      canonicalDecimals: z.number().int().min(0).max(9),
      displayDecimals: z.number().int().min(0).max(6),
      displayRounding: z.literal('floor')
    }),
    minScoredComponents: z.number().int().min(1).max(SPACE_COMPONENTS.length),
    mandatoryFailureCeiling: score,
    regressionPenalty: z.strictObject({ critical: score, high: score, medium: score, low: score }),
    coordinationDefectPenalty: score,
    correctiveShareSlope: z.number().min(0).max(1_000),
    minClassificationCoverage: z.number().min(0).max(1),
    resourceCurve: z.strictObject({ intercept: z.number().min(100).max(1_000), slope: z.number().gt(0).max(1_000) }),
    minCohortSampleSize: z.number().int().min(1)
  })
  .superRefine((policy, ctx) => {
    policy.components.forEach((entry, index) => {
      if (entry.component !== SPACE_COMPONENTS[index]) {
        ctx.addIssue({ code: 'custom', path: ['components', index], message: `Components are listed in the order ${SPACE_COMPONENTS.join(', ')}` })
      }
    })
    policy.bands.forEach((band, index) => {
      const previous = policy.bands[index - 1]
      if (band.letter !== GRADE_LETTERS[index] || (previous !== undefined && band.min >= previous.min)) {
        ctx.addIssue({ code: 'custom', path: ['bands', index], message: 'Bands run A to F with strictly falling minimums' })
      }
    })
    if (policy.bands.at(-1)?.min !== 0) {
      ctx.addIssue({ code: 'custom', path: ['bands'], message: 'The F band starts at 0' })
    }
    const fMin = policy.bands.at(-2)?.min ?? 0
    if (policy.mandatoryFailureCeiling >= fMin) {
      ctx.addIssue({ code: 'custom', path: ['mandatoryFailureCeiling'], message: 'The failure ceiling lies inside the F band' })
    }
    if (policy.precision.displayDecimals > policy.precision.canonicalDecimals) {
      ctx.addIssue({ code: 'custom', path: ['precision', 'displayDecimals'], message: 'Display precision cannot exceed canonical precision' })
    }
  })

const rating = z.number().int().min(1).max(5)
const humanRating = z.strictObject({ observationId: idOf('metricObservation'), source: z.literal('human'), value: rating })

const resourceInput = z.strictObject({
  actual: measurementSchema,
  unreportedAttempts: count,
  baseline: baselineSelectionSchema,
  evidence: gradeEvidence
})

/** The stable-id kind each grade level names. */
const SUBJECT_ID_KIND: Readonly<Record<GradeSubjectLevel, IdKind>> = { ticket: 'ticket', run: 'run', sprint: 'sprint', epic: 'epic' }

const gradeSubjectSchema = z
  .strictObject({ level: z.enum(GRADE_SUBJECT_LEVELS), id: z.string() })
  .refine((subject) => isStableId(subject.id, SUBJECT_ID_KIND[subject.level]), {
    path: ['id'],
    message: 'The subject id is the stable id of its level (tk_, rn_, sp_ or ep_)'
  })

/** The baseline metric each resource component compares. */
const RESOURCE_METRIC = { T: 'active_ms', K: 'tokens' } as const

const spaceGradeInputSchema = z
  .strictObject({
    subject: gradeSubjectSchema,
    cutoff: isoTime,
    dispatchedAt: isoTime.nullable(),
    components: z.strictObject({
      S: z.strictObject({
        ticketRating: humanRating.nullable(),
        sprintRating: humanRating.extend({ sharedWithTickets: z.boolean() }).nullable()
      }),
      P: z.strictObject({
        verification: z.strictObject({ state: z.enum(VERIFICATION_STATES), evidence: gradeEvidence }),
        regressions: z
          .array(
            z.strictObject({
              observationId: idOf('metricObservation'),
              severity: z.enum(REGRESSION_SEVERITIES),
              attribution: z.enum(['attributed', 'unassigned'])
            })
          )
          .max(1_000)
      }),
      A: z
        .strictObject({
          committed: count.nullable(),
          delivered: count,
          added: count,
          removed: count,
          activity: z.strictObject({ attempts: count.nullable(), commits: count.nullable(), changedLines: count.nullable() }),
          evidence: gradeEvidence
        })
        .refine((a) => a.committed === null || a.delivered <= a.committed, 'Delivered cannot exceed the committed scope'),
      C: z
        .strictObject({
          handoffChecks: z.strictObject({ passed: count, failed: count }).nullable(),
          rejected: z.strictObject({ submissions: count, passedChecks: count }).optional(),
          coordinationDefects: count,
          evidence: gradeEvidence
        })
        .refine(
          (c) => c.rejected === undefined || (c.handoffChecks !== null && c.rejected.passedChecks <= c.handoffChecks.passed),
          'A rejected submission passed no more checks than the handoff tally holds'
        ),
      E: z.strictObject({
        correctiveMs: measurementSchema,
        productiveMs: measurementSchema,
        unclassifiedMs: measurementSchema,
        retries: count.nullable(),
        evidence: gradeEvidence
      }),
      T: resourceInput,
      K: resourceInput
    })
  })
  .superRefine((input, ctx) => {
    if (input.subject.level !== 'ticket' && input.components.S.ticketRating !== null) {
      ctx.addIssue({ code: 'custom', path: ['components', 'S', 'ticketRating'], message: 'Only a ticket-level input has a ticket rating' })
    }
    for (const component of ['T', 'K'] as const) {
      const selection = input.components[component].baseline
      if (selection.state === 'selected' && selection.baseline.metric !== RESOURCE_METRIC[component]) {
        ctx.addIssue({
          code: 'custom',
          path: ['components', component, 'baseline', 'baseline', 'metric'],
          message: `${component} compares against a baseline of ${RESOURCE_METRIC[component]}`
        })
      }
    }
  })

const componentValues = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))

/** `sha256:` and 64 lowercase hex digits, as `contentHash` writes it. */
const contentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const explanationText = z.string().min(1).max(2_000)
const capKind = z.literal('mandatory_failure')

const componentExplanationSchema = z.strictObject({
  normalization: explanationText,
  cutoff: isoTime,
  baseline: z
    .strictObject({
      baselineId: idOf('baseline'),
      kind: z.enum(['budget', 'cohort', 'rollup']),
      value: quantity,
      version: z.number().int().min(1),
      frozenAt: isoTime,
      sampleSize: z.number().int().min(1).nullable(),
      refusedReason: z.enum(BASELINE_REJECTIONS).nullable()
    })
    .nullable(),
  caps: z.array(capKind).max(1)
})

const gradeExplanationSchema = z.strictObject({
  composite: explanationText.nullable(),
  cap: explanationText.nullable(),
  letter: explanationText.nullable(),
  status: z.array(explanationText).min(1).max(GRADE_STATUS_REASONS.length + 1),
  missing: z.array(z.strictObject({ component: z.enum(SPACE_COMPONENTS), reason: z.enum(COMPONENT_MISSING_REASONS) })).max(SPACE_COMPONENTS.length),
  rounding: z.strictObject({
    canonicalDecimals: z.number().int().min(0).max(9),
    canonical: z.literal('half_up'),
    displayDecimals: z.number().int().min(0).max(6),
    display: z.literal('floor')
  }),
  evidence: z.array(evidenceRefSchema).max(20_000)
})

const gradeShape = z.strictObject({
  assessmentId: idOf('assessment').nullable(),
  policy: z.strictObject({ policyId: z.string().min(1), version: z.number().int().min(1), hash: contentHashSchema }),
  subject: gradeSubjectSchema,
  cutoff: isoTime,
  dispatchedAt: isoTime.nullable(),
  inputHash: contentHashSchema,
  status: z.enum(GRADE_STATUSES),
  outcome: z.enum(GRADE_OUTCOMES),
  statusReasons: z.array(z.enum(GRADE_STATUS_REASONS)),
  score: score.nullable(),
  uncappedScore: score.nullable(),
  displayScore: z.string().regex(/^\d{1,3}(\.\d+)?$/).nullable(),
  letter: z.enum(GRADE_LETTERS).nullable(),
  coverage: z.number().min(0).max(1),
  scoredComponents: z.number().int().min(0).max(SPACE_COMPONENTS.length),
  caps: z.array(z.strictObject({ kind: capKind, ceiling: score, letter: z.literal('F'), evidence: gradeEvidence })),
  components: z
    .array(
      z.strictObject({
        component: z.enum(SPACE_COMPONENTS),
        state: z.enum(MEASUREMENT_STATES),
        required: z.boolean(),
        score: score.nullable(),
        baseWeight: z.number().min(0).max(1),
        effectiveWeight: z.number().min(0).max(1),
        rule: label,
        missingReason: z.enum(COMPONENT_MISSING_REASONS).nullable(),
        inherited: z.boolean(),
        inputs: componentValues,
        diagnostics: componentValues,
        evidence: gradeEvidence,
        explanation: componentExplanationSchema
      })
    )
    .length(SPACE_COMPONENTS.length),
  baselineIds: z.array(idOf('baseline')),
  explanation: gradeExplanationSchema
})
type GradeShape = z.infer<typeof gradeShape>

/** Why the score fields disagree with the status, or null. */
function scoreProblem(grade: GradeShape): string | null {
  const ungraded = grade.status === 'ungraded'
  if ([grade.score, grade.uncappedScore, grade.displayScore, grade.letter].some((value) => (value === null) !== ungraded)) {
    return 'Score, uncapped score, display score and letter are null exactly when ungraded'
  }
  if (grade.score !== null && grade.uncappedScore !== null && grade.score > grade.uncappedScore) {
    return 'A capped score cannot exceed its uncapped score'
  }
  if (grade.outcome === 'failed' && grade.letter !== null && grade.letter !== 'F') {
    return 'A failed outcome grades F'
  }
  return grade.scoredComponents === grade.components.filter((entry) => entry.state !== 'missing').length
    ? null
    : 'scoredComponents counts the components that are not missing'
}

/** The status its reasons imply: ungraded, then provisional, then final (docs/space-grading.md). */
function impliedStatus(grade: GradeShape): GradeShape['status'] {
  const has = (reason: GradeStatusReason) => grade.statusReasons.includes(reason)
  if (grade.outcome === 'unverified' || has('insufficient_coverage')) {
    return 'ungraded'
  }
  return has('required_component_missing') || has('estimated_input') ? 'provisional' : 'final'
}

/** Why the outcome, reasons, caps and status disagree with each other or with the components, or null. */
function statusProblem(grade: GradeShape): string | null {
  const has = (reason: GradeStatusReason) => grade.statusReasons.includes(reason)
  const failed = grade.outcome === 'failed'
  const verificationReasons = grade.statusReasons.filter((reason) => reason === 'verification_missing' || reason === 'verification_pending')
  const requiredMissing = grade.components.some((entry) => entry.required && entry.component !== 'P' && entry.state === 'missing')
  const rules: [boolean, string][] = [
    [GRADE_STATUS_REASONS.filter(has).join() === grade.statusReasons.join(), 'Status reasons are distinct and in contract order'],
    [failed === has('mandatory_failure') && failed === grade.caps.length > 0, 'A failed outcome, and only it, has the mandatory_failure reason and cap'],
    [(grade.outcome === 'unverified') === (verificationReasons.length === 1), 'An unverified outcome, and only it, has one verification reason'],
    [!has('insufficient_coverage') || grade.outcome === 'verified', 'Only a verified outcome can be ungraded for coverage'],
    [has('required_component_missing') === requiredMissing, 'required_component_missing matches the missing required components'],
    [has('estimated_input') === grade.components.some((entry) => entry.state === 'estimated'), 'estimated_input matches the estimated components'],
    [grade.status === impliedStatus(grade), 'The status does not follow from its outcome and reasons']
  ]
  return rules.find(([ok]) => !ok)?.[1] ?? null
}

/** Why the explanations disagree with the grade they explain, or null. */
function explanationProblem(grade: GradeShape): string | null {
  const { explanation } = grade
  const ungraded = grade.status === 'ungraded'
  const failed = grade.outcome === 'failed'
  const missing = grade.components.filter((entry) => entry.missingReason !== null).map((entry) => `${entry.component}:${entry.missingReason}`)
  const rules: [boolean, string][] = [
    [[explanation.composite, explanation.letter].every((text) => (text === null) === ungraded), 'The composite and letter explanations are null exactly when ungraded'],
    [(explanation.cap !== null) === (failed && !ungraded), 'A cap explanation appears exactly when a failed outcome is scored'],
    [explanation.missing.map((entry) => `${entry.component}:${entry.reason}`).join() === missing.join(), 'The missing list names every missing component with its reason'],
    [grade.components.every((entry) => entry.explanation.cutoff === grade.cutoff), 'Every component explanation names the grade cutoff'],
    [
      grade.components.every((entry) => entry.explanation.caps.length === (entry.component === 'P' && failed ? 1 : 0)),
      'Only P carries the mandatory-failure cap, exactly when the outcome failed'
    ]
  ]
  return rules.find(([ok]) => !ok)?.[1] ?? null
}

const spaceGradeSchema = gradeShape.superRefine((grade, ctx) => {
  for (const [path, message] of [
    ['score', scoreProblem(grade)],
    ['status', statusProblem(grade)],
    ['explanation', explanationProblem(grade)]
  ] as const) {
    if (message !== null) {
      ctx.addIssue({ code: 'custom', path: [path], message })
    }
  }
  grade.components.forEach((entry, index) => {
    if (entry.component !== SPACE_COMPONENTS[index]) {
      ctx.addIssue({ code: 'custom', path: ['components', index], message: `Components are listed in the order ${SPACE_COMPONENTS.join(', ')}` })
    }
    if ((entry.state === 'missing') !== (entry.score === null) || (entry.state === 'missing') !== (entry.missingReason !== null)) {
      ctx.addIssue({ code: 'custom', path: ['components', index], message: 'A component has a score exactly when it is not missing' })
    }
    if (entry.state === 'missing' && entry.effectiveWeight !== 0) {
      ctx.addIssue({ code: 'custom', path: ['components', index, 'effectiveWeight'], message: 'A missing component carries no weight' })
    }
  })
})

export function parseObservation(value: unknown): MetricObservation {
  return parseInput<MetricObservation>(metricObservationSchema, value, 'metric observation')
}

export function parseBaselineSubject(value: unknown): BaselineSubject {
  return parseInput<BaselineSubject>(baselineSubjectSchema, value, 'baseline subject')
}

export function parseBaseline(value: unknown): Baseline {
  return parseInput<Baseline>(baselineSchema, value, 'baseline')
}

export function parseSpacePolicy(value: unknown): SpacePolicy {
  return parseInput<SpacePolicy>(spacePolicySchema, value, 'SPACE policy')
}

export function parseGradeInput(value: unknown): SpaceGradeInput {
  return parseInput<SpaceGradeInput>(spaceGradeInputSchema, value, 'SPACE grade input')
}

export function parseGrade(value: unknown): SpaceGrade {
  return parseInput<SpaceGrade>(spaceGradeSchema, value, 'SPACE grade')
}
