/**
 * The balanced SPACE rubric's policies (v1 and v2, kept by id and content hash) and its reference grader.
 *
 * `gradeSpace` is the single implementation of docs/space-grading.md: seven components with equal base weight,
 * each normalized to 0–100 by a named rule, combined at canonical precision, then banded A ≥ 90, B ≥ 80, C ≥ 70,
 * D ≥ 60, F < 60. Missing values are never imputed: a missing component drops out with its weight shown as 0,
 * and the grade says whether it is final, provisional or ungraded. Every component and the final result carry an
 * explanation (the rule with its numbers, the cutoff, the baseline, the caps and the evidence), so a grade can be
 * recomputed by hand. Later grading work extends this function rather than adding a second calculator.
 */
import type {
  Baseline,
  BaselineComparison,
  BaselineMetric,
  BaselineRejection,
  ComponentMissingReason,
  ComponentValues,
  EvidenceRef,
  GradeCap,
  GradeExplanation,
  GradeLetter,
  GradeOutcome,
  GradeStatus,
  GradeStatusReason,
  HumanRatingInput,
  Measurement,
  MeasurementState,
  ResourceInput,
  SpaceComponent,
  SpaceComponentResult,
  SpaceGrade,
  SpaceGradeInput,
  SpacePolicy,
  VerificationState
} from '../../shared/domain/space'
import { contentHash } from '../canonical'
import { fail } from '../errors'
import { baselineDefect } from './baselines'
import { parseGradeInput, parseSpacePolicy } from './contract'

/** Dark Mechanicus's SPACE-informed grading policy, version 1. Not an official SPACE formula. */
export const SPACE_POLICY_V1: SpacePolicy = {
  policyId: 'dm-space',
  version: 1,
  components: [
    { component: 'S', weight: 1, required: false, signal: 'direct', rule: 'S.rating.v1' },
    { component: 'P', weight: 1, required: true, signal: 'direct', rule: 'P.verified-less-regressions.v1' },
    { component: 'A', weight: 1, required: true, signal: 'direct', rule: 'A.delivered-over-committed.v1' },
    { component: 'C', weight: 1, required: true, signal: 'proxy', rule: 'C.handoff-pass-rate.v1' },
    { component: 'E', weight: 1, required: true, signal: 'proxy', rule: 'E.corrective-share.v1' },
    { component: 'T', weight: 1, required: true, signal: 'direct', rule: 'T.baseline-ratio.v1' },
    { component: 'K', weight: 1, required: true, signal: 'direct', rule: 'K.baseline-ratio.v1' }
  ],
  bands: [
    { letter: 'A', min: 90 },
    { letter: 'B', min: 80 },
    { letter: 'C', min: 70 },
    { letter: 'D', min: 60 },
    { letter: 'F', min: 0 }
  ],
  precision: { canonicalDecimals: 6, displayDecimals: 1, displayRounding: 'floor' },
  minScoredComponents: 4,
  mandatoryFailureCeiling: 59,
  regressionPenalty: { critical: 50, high: 30, medium: 15, low: 5 },
  coordinationDefectPenalty: 10,
  correctiveShareSlope: 150,
  minClassificationCoverage: 0.8,
  resourceCurve: { intercept: 150, slope: 50 },
  minCohortSampleSize: 5
}

/**
 * Version 2 changes only C's rule, to `C.handoff-pass-rate.v2`: every check of a submission the review rejected counts
 * failed, so another rejected attempt can never raise a grade. Every other rule and number is version 1's.
 */
export const SPACE_POLICY_V2: SpacePolicy = {
  ...SPACE_POLICY_V1,
  version: 2,
  components: SPACE_POLICY_V1.components.map((entry) => (entry.component === 'C' ? { ...entry, rule: 'C.handoff-pass-rate.v2' } : entry))
}

/** The policy new grades are computed under. */
export const CURRENT_SPACE_POLICY = SPACE_POLICY_V2

/**
 * Every policy this build can grade under, by content hash. A frozen grade names its policy by hash, so a later
 * reading regrades a stored input under exactly the policy it was graded with, never the current one.
 */
const POLICIES_BY_HASH: ReadonlyMap<string, SpacePolicy> = new Map([SPACE_POLICY_V1, SPACE_POLICY_V2].map((policy) => [contentHash(policy), policy]))

/** The registered policy with this content hash, or null when this build does not know it. */
export function spacePolicyByHash(hash: string): SpacePolicy | null {
  return POLICIES_BY_HASH.get(hash) ?? null
}

/** The policy's name as a grade or snapshot records it. */
export function policyRef(policy: SpacePolicy): { policyId: string; version: number; hash: string } {
  return { policyId: policy.policyId, version: policy.version, hash: contentHash(policy) }
}

/** What one normalization rule produced, before weights are applied. */
interface Normalized {
  state: MeasurementState
  /** Unquantized 0–100 score; null exactly when missing. */
  score: number | null
  missingReason: ComponentMissingReason | null
  inherited: boolean
  inputs: ComponentValues
  diagnostics: ComponentValues
  evidence: EvidenceRef[]
  /** The rule with this grade's numbers and its result, or why there is no score. */
  normalization: string
  /** T and K: the baseline offered and the grader's judgement of it. */
  baseline: BaselineComparison | null
}

/** Why a component has no score, in words; the explanation adds the numbers. */
const MISSING_TEXT: Readonly<Record<ComponentMissingReason, string>> = {
  no_rating: 'no rating a person gave or shared with this subject',
  verification_pending: 'verification is pending (no reviewed outcome yet)',
  verification_missing: 'required verification is missing (no reviewed evidence)',
  scope_not_frozen: 'no scope was frozen before dispatch',
  zero_scope: 'the frozen scope commits nothing (never read as 100)',
  not_reported: 'not reported',
  host_unavailable: 'the host cannot report it',
  partial_coverage: 'only partly covered (a report is still open or incomplete)',
  no_handoffs: 'no handoff was checked',
  zero_observation: 'the measure is zero (never an automatic score)',
  insufficient_classification: 'too little effort is classified',
  partial_telemetry: 'some attempts ran without reporting, so the total is partial',
  no_eligible_baseline: 'no baseline passed every check'
}

/** What a missing component may add to its reason: diagnostics, a detail for the explanation, the baseline offered. */
interface MissingExtras {
  diagnostics?: ComponentValues
  detail?: string
  baseline?: BaselineComparison | null
}

function missing(reason: ComponentMissingReason, inputs: ComponentValues, evidence: EvidenceRef[], extras: MissingExtras = {}): Normalized {
  return {
    state: 'missing',
    score: null,
    missingReason: reason,
    inherited: false,
    inputs,
    diagnostics: extras.diagnostics ?? {},
    evidence,
    normalization: `no score: ${MISSING_TEXT[reason]}${extras.detail ?? ''}`,
    baseline: extras.baseline ?? null
  }
}

const clamp100 = (value: number): number => Math.min(100, Math.max(0, value))

/** Canonical integer units of a value (10^-canonicalDecimals each). Every score and band comparison uses these. */
function toUnits(value: number, policy: SpacePolicy): number {
  return Math.round(value * 10 ** policy.precision.canonicalDecimals)
}

function fromUnits(units: number, policy: SpacePolicy): number {
  return units / 10 ** policy.precision.canonicalDecimals
}

/** A number as an explanation shows it: at canonical precision, so the text agrees with the stored values. */
function num(value: number, policy: SpacePolicy): string {
  return String(fromUnits(toUnits(value, policy), policy))
}

/** The most terms an explanation lists before it says how many more there are, so a long list stays readable and fits. */
const MAX_LISTED_TERMS = 12

/** Terms joined by `separator`, the first `MAX_LISTED_TERMS` of them, then "… and N more". */
function listTerms(terms: readonly string[], separator: string): string {
  const shown = terms.slice(0, MAX_LISTED_TERMS).join(separator)
  return terms.length > MAX_LISTED_TERMS ? `${shown}${separator}… and ${terms.length - MAX_LISTED_TERMS} more` : shown
}

/** A rule's raw result and its 0–100 score, saying so when clamping changed it. */
function clampedText(raw: number, policy: SpacePolicy): string {
  const clamped = clamp100(raw)
  return clamped === raw ? num(raw, policy) : `${num(clamped, policy)} (${num(raw, policy)} clamped to 0–100)`
}

/** Canonical units of a score in points, refusing anything that is not a number of points from 0 to 100. */
function scoreUnits(points: number, policy: SpacePolicy): number {
  if (!Number.isFinite(points) || points < 0 || points > 100) {
    throw new RangeError(`A score is a number of points from 0 to 100, not ${points}`)
  }
  return toUnits(points, policy)
}

/** The band a score in points reaches: the first whose minimum it reaches, compared at canonical precision. */
function bandOf(points: number, policy: SpacePolicy): { letter: GradeLetter; min: number } {
  const units = scoreUnits(points, policy)
  return policy.bands.find((entry) => units >= toUnits(entry.min, policy)) ?? { letter: 'F', min: 0 }
}

/**
 * The letter for a score in points (0–100), as `SpaceGrade.score` holds it. The score is compared at canonical
 * precision: the first band whose minimum it reaches.
 */
export function letterFor(points: number, policy: SpacePolicy = CURRENT_SPACE_POLICY): GradeLetter {
  return bandOf(points, policy).letter
}

/** A score in points (0–100) as display text, rounded down at display precision so it never reads as a higher band. */
export function displayScore(points: number, policy: SpacePolicy = CURRENT_SPACE_POLICY): string {
  const { canonicalDecimals, displayDecimals } = policy.precision
  const step = 10 ** (canonicalDecimals - displayDecimals)
  return (Math.floor(scoreUnits(points, policy) / step) / 10 ** displayDecimals).toFixed(displayDecimals)
}

/**
 * The rating S uses. A sprint grade uses the sprint's own rating. A ticket grade uses the ticket's own rating; a
 * ticket without one, and every run or epic grade, uses a sprint rating only when the person shared it, as
 * inherited context.
 */
function chosenRating(input: SpaceGradeInput): { rating: HumanRatingInput; inherited: boolean } | null {
  const { ticketRating, sprintRating } = input.components.S
  if (input.subject.level === 'sprint') {
    return sprintRating === null ? null : { rating: sprintRating, inherited: false }
  }
  if (input.subject.level === 'ticket' && ticketRating !== null) {
    return { rating: ticketRating, inherited: false }
  }
  return sprintRating?.sharedWithTickets === true ? { rating: sprintRating, inherited: true } : null
}

/** S with no usable rating, naming a sprint rating that exists but was not shared. */
function unrated(input: SpaceGradeInput['components']['S']): Normalized {
  const { ticketRating, sprintRating } = input
  const inputs: ComponentValues = { ticketRating: ticketRating?.value ?? null, sprintRating: sprintRating?.value ?? null }
  const detail = sprintRating === null ? '' : ` (the sprint rating ${sprintRating.value} was not shared with this subject)`
  return missing('no_rating', inputs, [], { detail })
}

/** S.rating.v1: (rating − 1) × 25. A ticket's own rating wins; a shared sprint rating is inherited and labeled. */
function normalizeSatisfaction(input: SpaceGradeInput): Normalized {
  const chosen = chosenRating(input)
  if (chosen === null) {
    return unrated(input.components.S)
  }
  const { rating, inherited } = chosen
  const scope = rating === input.components.S.ticketRating ? 'ticket' : 'sprint'
  const source = inherited ? 'the shared sprint rating, inherited' : `the ${scope} rating`
  return {
    state: 'observed',
    score: (rating.value - 1) * 25,
    missingReason: null,
    inherited,
    inputs: { rating: rating.value, ratingScope: scope },
    diagnostics: {},
    evidence: [{ kind: 'observation', id: rating.observationId, detail: inherited ? 'inherited sprint rating' : null }],
    normalization: `(${rating.value} − 1) × 25 = ${(rating.value - 1) * 25}, from ${source}`,
    baseline: null
  }
}

/** P.verified-less-regressions.v1: 100 − severity penalties of attributed regressions; a confirmed failure is 0. */
function normalizePerformance(input: SpaceGradeInput, policy: SpacePolicy): Normalized {
  const { verification, regressions } = input.components.P
  const attributed = regressions.filter((entry) => entry.attribution === 'attributed')
  const penalty = attributed.reduce((sum, entry) => sum + policy.regressionPenalty[entry.severity], 0)
  const inputs: ComponentValues = { verification: verification.state, attributedRegressions: attributed.length, regressionPenalty: penalty }
  const unassigned = regressions.length - attributed.length
  const diagnostics: ComponentValues = { unassignedRegressions: unassigned }
  const evidence: EvidenceRef[] = [
    ...verification.evidence,
    ...attributed.map((entry): EvidenceRef => ({ kind: 'observation', id: entry.observationId, detail: entry.severity }))
  ]
  if (verification.state === 'pending' || verification.state === 'missing') {
    return missing(verification.state === 'pending' ? 'verification_pending' : 'verification_missing', inputs, evidence, { diagnostics })
  }
  const shown = unassigned > 0 ? `; ${unassigned} unassigned regression(s) shown, not charged` : ''
  if (verification.state === 'failed') {
    return {
      state: 'observed',
      score: 0,
      missingReason: null,
      inherited: false,
      inputs,
      diagnostics,
      evidence,
      normalization: `confirmed mandatory failure: P = 0, and the grade is capped at ${num(policy.mandatoryFailureCeiling, policy)} (F)${shown}`,
      baseline: null
    }
  }
  const terms = attributed.map((entry) => `${entry.severity} ${policy.regressionPenalty[entry.severity]}`)
  const charged = attributed.length === 0 ? '0 (no attributed regression)' : `(${listTerms(terms, ' + ')})`
  return {
    state: 'observed',
    score: clamp100(100 - penalty),
    missingReason: null,
    inherited: false,
    inputs,
    diagnostics,
    evidence,
    normalization: `verified: 100 − ${charged} = ${clampedText(100 - penalty, policy)}${shown}`,
    baseline: null
  }
}

/** A.delivered-over-committed.v1: 100 × delivered ÷ frozen committed scope. Activity volume is shown, never scored. */
function normalizeDelivery(input: SpaceGradeInput, policy: SpacePolicy): Normalized {
  const { committed, delivered, added, removed, activity, evidence } = input.components.A
  const inputs: ComponentValues = { committed, delivered }
  const diagnostics: ComponentValues = { added, removed, ...activity }
  if (committed === null) {
    return missing('scope_not_frozen', inputs, evidence, { diagnostics })
  }
  if (committed === 0) {
    return missing('zero_scope', inputs, evidence, { diagnostics })
  }
  const score = (100 * delivered) / committed
  return {
    state: 'observed',
    score,
    missingReason: null,
    inherited: false,
    inputs,
    diagnostics,
    evidence,
    normalization: `100 × ${delivered} delivered ÷ ${committed} committed = ${num(score, policy)}; ${added} added and ${removed} removed item(s), attempts, commits and changed lines are shown, never scored`,
    baseline: null
  }
}

/** The C rules this grader implements, by the rule id the policy names; the policy hash therefore fixes C's behaviour. */
const COLLABORATION_RULES = ['C.handoff-pass-rate.v1', 'C.handoff-pass-rate.v2'] as const

function collaborationRule(policy: SpacePolicy): (typeof COLLABORATION_RULES)[number] {
  const rule = policy.components.find((entry) => entry.component === 'C')?.rule
  const known = COLLABORATION_RULES.find((entry) => entry === rule)
  if (known === undefined) {
    fail('invalid_input', `Policy ${policy.policyId} v${policy.version} names C rule ${String(rule)}, which this grader does not implement.`, { rule })
  }
  return known
}

/** The checks C counts under its rule, the values it shows, and what the explanation adds about rejections. */
interface CollaborationTally {
  tally: { passed: number; failed: number } | null
  inputs: ComponentValues
  note: string
}

const NO_REJECTIONS = { submissions: 0, passedChecks: 0 }

/**
 * - v1 counts each derived check as it found.
 * - v2 counts a submission the review rejected as a failed handoff: every check it passed on its own counts failed
 *   (`rejected.passedChecks` of them), so another rejected attempt only ever adds failed checks and never raises C.
 */
function collaborationTally(input: SpaceGradeInput, policy: SpacePolicy): CollaborationTally {
  const { handoffChecks, rejected, coordinationDefects } = input.components.C
  const v2 = collaborationRule(policy) === 'C.handoff-pass-rate.v2'
  const turned = (v2 ? rejected : undefined) ?? NO_REJECTIONS
  const shown: ComponentValues = v2 ? { rejectedSubmissions: turned.submissions } : {}
  if (handoffChecks === null) {
    return { tally: null, inputs: { handoffsPassed: null, handoffsFailed: null, ...shown, coordinationDefects }, note: '' }
  }
  const tally = { passed: handoffChecks.passed - turned.passedChecks, failed: handoffChecks.failed + turned.passedChecks }
  return {
    tally,
    inputs: { handoffsPassed: tally.passed, handoffsFailed: tally.failed, ...shown, coordinationDefects },
    note: turned.submissions > 0 ? `; ${turned.submissions} rejected submission(s): their ${turned.passedChecks} passed check(s) count failed` : ''
  }
}

/** C.handoff-pass-rate: 100 × passed ÷ checked handoffs − a penalty per recorded coordination defect. */
function normalizeCollaboration(input: SpaceGradeInput, policy: SpacePolicy): Normalized {
  const { coordinationDefects, evidence } = input.components.C
  const { tally, inputs, note } = collaborationTally(input, policy)
  if (tally === null) {
    return missing('not_reported', inputs, evidence, { detail: ' (a submission has no derived handoff checks)' })
  }
  const checked = tally.passed + tally.failed
  if (checked === 0) {
    return missing('no_handoffs', inputs, evidence)
  }
  const raw = (100 * tally.passed) / checked - policy.coordinationDefectPenalty * coordinationDefects
  return {
    state: 'observed',
    score: clamp100(raw),
    missingReason: null,
    inherited: false,
    inputs,
    diagnostics: {},
    evidence,
    normalization: `100 × ${tally.passed} passed ÷ ${checked} checked − ${num(policy.coordinationDefectPenalty, policy)} × ${coordinationDefects} coordination defect(s) = ${clampedText(raw, policy)}${note}`,
    baseline: null
  }
}

const valueOf = (measurement: Measurement): number | null => (measurement.state === 'missing' ? null : measurement.value)

/** E.corrective-share.v1: 100 − slope × corrective ÷ classified effort, once enough effort is classified. */
function normalizeEfficiency(input: SpaceGradeInput, policy: SpacePolicy): Normalized {
  const { correctiveMs, productiveMs, unclassifiedMs, retries, evidence } = input.components.E
  const inputs: ComponentValues = {
    correctiveMs: valueOf(correctiveMs),
    productiveMs: valueOf(productiveMs),
    unclassifiedMs: valueOf(unclassifiedMs)
  }
  const diagnostics: ComponentValues = { retries }
  const named = { corrective: correctiveMs, productive: productiveMs, unclassified: unclassifiedMs }
  const absent = Object.entries(named).find(([, entry]) => entry.state === 'missing')
  if (absent !== undefined && absent[1].state === 'missing') {
    return missing(absent[1].reason, inputs, evidence, { diagnostics, detail: ` (the ${absent[0]} effort)` })
  }
  const corrective = valueOf(correctiveMs) ?? 0
  const productive = valueOf(productiveMs) ?? 0
  const classified = corrective + productive
  const total = classified + (valueOf(unclassifiedMs) ?? 0)
  if (classified === 0) {
    return missing('zero_observation', inputs, evidence, { diagnostics, detail: ' (no effort is classified)' })
  }
  const coverage = classified / total
  inputs.classificationCoverage = fromUnits(toUnits(coverage, policy), policy)
  const classifiedText = `${num(100 * coverage, policy)}% of ${num(total, policy)} ms classified`
  if (coverage < policy.minClassificationCoverage) {
    const needed = `${num(100 * policy.minClassificationCoverage, policy)}%`
    return missing('insufficient_classification', inputs, evidence, { diagnostics, detail: ` (${classifiedText}; at least ${needed} is needed)` })
  }
  const share = corrective / classified
  inputs.correctiveShare = fromUnits(toUnits(share, policy), policy)
  const estimated = [correctiveMs, productiveMs, unclassifiedMs].some((entry) => entry.state === 'estimated')
  const raw = 100 - policy.correctiveShareSlope * share
  return {
    state: estimated ? 'estimated' : 'observed',
    score: clamp100(raw),
    missingReason: null,
    inherited: false,
    inputs,
    diagnostics,
    evidence,
    normalization:
      `100 − ${num(policy.correctiveShareSlope, policy)} × ${num(corrective, policy)} corrective ÷ (${num(corrective, policy)} + ${num(productive, policy)} productive) ms` +
      ` = ${clampedText(raw, policy)}; ${classifiedText}${estimated ? '; estimated' : ''}; retries are shown, never scored`,
    baseline: null
  }
}

const NO_BASELINE: ComponentValues = { baselineId: null, baselineKind: null, baselineValue: null, baselineSampleSize: null }

/** The baseline metric each resource component compares. */
const RESOURCE_METRIC: Readonly<Record<'T' | 'K', BaselineMetric>> = { T: 'active_ms', K: 'tokens' }

/** The unit each resource component's numbers are shown in. */
const RESOURCE_UNIT: Readonly<Record<'T' | 'K', string>> = { T: 'ms', K: 'tokens' }

/**
 * The baseline T or K may use: the selected one, only if it passes every baseline check again for this grade (its
 * metric, its level: a budget or cohort only for a ticket grade and a roll-up of ticket baselines only for a run,
 * sprint or epic grade; its ticket, frozen strictly before the input's dispatch time, at least one unit, the cohort
 * minimum, and, for a ticket grade, a cohort that does not contain the ticket itself). A roll-up that leaves executed
 * work tickets uncovered is partial: it is compared only with an estimated actual that leaves those tickets out, so
 * the component (and the grade) reads provisional; against an observed actual it is refused (`incomplete_rollup`).
 * The grader never trusts a baseline because it is labeled selected.
 */
function acceptedBaseline(
  component: 'T' | 'K',
  input: SpaceGradeInput,
  policy: SpacePolicy
): { baseline: Baseline | null; refused: BaselineRejection | null } {
  const resource = input.components[component]
  const selection = resource.baseline
  if (selection.state !== 'selected') {
    return { baseline: null, refused: null }
  }
  const ticketId = input.subject.level === 'ticket' ? input.subject.id : null
  const candidate = selection.baseline
  const defect = baselineDefect(candidate, { metric: RESOURCE_METRIC[component], ticketId, dispatchedAt: input.dispatchedAt }, policy)
  const refused = defect ?? useDefect(candidate, resource, ticketId)
  return refused === null ? { baseline: candidate, refused: null } : { baseline: null, refused }
}

/**
 * What only this grade can check about a baseline: a partial roll-up compared with an observed actual
 * (`incomplete_rollup`), and a ticket cohort that contains the ticket itself (`contains_subject`).
 */
function useDefect(candidate: Baseline, resource: ResourceInput, ticketId: string | null): BaselineRejection | null {
  if (candidate.kind === 'rollup') {
    return candidate.uncovered.length > 0 && resource.actual.state === 'observed' ? 'incomplete_rollup' : null
  }
  return ticketId !== null && candidate.kind === 'cohort' && candidate.memberTicketIds.includes(ticketId) ? 'contains_subject' : null
}

function comparisonOf(offered: Baseline, refused: BaselineRejection | null): BaselineComparison {
  return {
    baselineId: offered.baselineId,
    kind: offered.kind,
    value: offered.value,
    version: offered.version,
    frozenAt: offered.frozenAt,
    sampleSize: offered.kind === 'cohort' ? offered.sampleSize : offered.kind === 'rollup' ? offered.members.length : null,
    refusedReason: refused
  }
}

function resourceInputs(resource: ResourceInput, baseline: Baseline | null): ComponentValues {
  return {
    actual: valueOf(resource.actual),
    actualState: resource.actual.state,
    unreportedAttempts: resource.unreportedAttempts,
    ...(baseline === null
      ? NO_BASELINE
      : {
          baselineId: baseline.baselineId,
          baselineKind: baseline.kind,
          baselineValue: baseline.value,
          baselineSampleSize: baseline.kind === 'cohort' ? baseline.sampleSize : baseline.kind === 'rollup' ? baseline.members.length : null
        })
  }
}

/** Why no baseline applies, naming the candidates the selection or the grader refused. */
function noBaselineDetail(resource: ResourceInput, refused: BaselineRejection | null): string {
  const offered = resource.baseline
  if (offered.state === 'selected' && refused !== null) {
    const uncovered = offered.baseline.kind === 'rollup' && refused === 'incomplete_rollup' ? offered.baseline.uncovered.map((entry) => entry.ticketId) : []
    const naming = uncovered.length === 0 ? '' : `; executed work ticket(s) without a baseline: ${listTerms(uncovered, ', ')}`
    return ` (the grader refused ${offered.baseline.baselineId}: ${refused}${naming})`
  }
  const listed = offered.rejected.slice(0, 3).map((entry) => `${entry.baselineId}: ${entry.reason}`)
  const more = offered.rejected.length > 3 ? `, and ${offered.rejected.length - 3} more` : ''
  return listed.length === 0 ? ' (no candidate)' : ` (refused ${listed.join(', ')}${more})`
}

/** The baseline T or K was offered, as judged, and the diagnostics naming a refusal. */
function offeredBaseline(resource: ResourceInput, refused: BaselineRejection | null): { offered: BaselineComparison | null; diagnostics: ComponentValues } {
  if (resource.baseline.state !== 'selected') {
    return { offered: null, diagnostics: {} }
  }
  const offered = comparisonOf(resource.baseline.baseline, refused)
  return { offered, diagnostics: refused === null ? {} : { refusedBaselineId: offered.baselineId, refusedReason: refused } }
}

/** What T or K compared against, in words, with when it was frozen relative to the dispatch it had to precede. */
function baselineText(baseline: Baseline, dispatchedAt: string | null): string {
  if (baseline.kind === 'rollup') {
    const uncovered = baseline.uncovered.length === 0 ? '' : `; partial: ${baseline.uncovered.length} executed work ticket(s) without a baseline are left out (${listTerms(baseline.uncovered.map((entry) => entry.ticketId), ', ')})`
    return `the sum of ${baseline.members.length} ticket baseline(s), each counted once and frozen before its own ticket's first dispatch (latest ${baseline.frozenAt}); overhead is in the actual only${uncovered}`
  }
  const against = baseline.kind === 'budget' ? `budget v${baseline.version}` : `the cohort median of ${baseline.sampleSize} tickets`
  return `${against}, frozen ${baseline.frozenAt}, before dispatch ${dispatchedAt ?? '—'}`
}

/** The T or K rule written out with its numbers: the curve, the ratio, the baseline and its freeze, the result. */
function resourceText(component: 'T' | 'K', compared: { actual: Exclude<Measurement, { state: 'missing' }>; baseline: Baseline }, dispatchedAt: string | null, policy: SpacePolicy): string {
  const { actual, baseline } = compared
  const ratio = actual.value / baseline.value
  const raw = policy.resourceCurve.intercept - policy.resourceCurve.slope * ratio
  const estimated = actual.state === 'estimated' ? `; estimated (${actual.method})` : ''
  return (
    `${num(policy.resourceCurve.intercept, policy)} − ${num(policy.resourceCurve.slope, policy)} × ${num(actual.value, policy)} ÷ ${num(baseline.value, policy)} ${RESOURCE_UNIT[component]}` +
    ` (ratio ${num(ratio, policy)} against ${baselineText(baseline, dispatchedAt)}) = ${clampedText(raw, policy)}${estimated}`
  )
}

/** T/K baseline-ratio.v1: clamp(intercept − slope × actual ÷ baseline, 0, 100); at or under baseline scores 100. */
function normalizeResource(component: 'T' | 'K', input: SpaceGradeInput, policy: SpacePolicy): Normalized {
  const resource = input.components[component]
  const { actual, unreportedAttempts, evidence } = resource
  const { baseline, refused } = acceptedBaseline(component, input, policy)
  const inputs = resourceInputs(resource, baseline)
  const { offered, diagnostics } = offeredBaseline(resource, refused)
  const cited: EvidenceRef[] = baseline === null ? evidence : [...evidence, { kind: 'baseline', id: baseline.baselineId, detail: baseline.kind }]
  const extras = (detail: string): MissingExtras => ({ diagnostics, detail, baseline: offered })
  if (actual.state === 'missing') {
    return missing(actual.reason, inputs, cited, extras(' (the actual)'))
  }
  if (unreportedAttempts > 0) {
    return missing('partial_telemetry', inputs, cited, extras(` (${unreportedAttempts} attempt(s) reported nothing)`))
  }
  if (actual.value === 0) {
    return missing('zero_observation', inputs, cited, extras(''))
  }
  if (baseline === null) {
    return missing('no_eligible_baseline', inputs, cited, extras(noBaselineDetail(resource, refused)))
  }
  const ratio = actual.value / baseline.value
  inputs.ratio = fromUnits(toUnits(ratio, policy), policy)
  return {
    state: actual.state,
    score: clamp100(policy.resourceCurve.intercept - policy.resourceCurve.slope * ratio),
    missingReason: null,
    inherited: false,
    inputs,
    diagnostics,
    evidence: cited,
    normalization: resourceText(component, { actual, baseline }, input.dispatchedAt, policy),
    baseline: offered
  }
}

/** The seven component results with base and effective weights, and the canonical units of the scored ones. */
function weighComponents(normalized: Record<SpaceComponent, Normalized>, input: SpaceGradeInput, failed: boolean, policy: SpacePolicy) {
  const totalWeight = policy.components.reduce((sum, entry) => sum + entry.weight, 0)
  const scored = policy.components.filter((entry) => normalized[entry.component].score !== null)
  const scoredWeight = scored.reduce((sum, entry) => sum + entry.weight, 0)
  const weightedUnits = scored.reduce((sum, entry) => sum + entry.weight * toUnits(normalized[entry.component].score ?? 0, policy), 0)
  const components = policy.components.map((entry): SpaceComponentResult => {
    const result = normalized[entry.component]
    return {
      component: entry.component,
      state: result.state,
      required: entry.required,
      score: result.score === null ? null : fromUnits(toUnits(result.score, policy), policy),
      baseWeight: entry.weight / totalWeight,
      effectiveWeight: result.score === null ? 0 : entry.weight / scoredWeight,
      rule: entry.rule,
      missingReason: result.missingReason,
      inherited: result.inherited,
      inputs: result.inputs,
      diagnostics: result.diagnostics,
      evidence: result.evidence,
      explanation: {
        normalization: result.normalization,
        cutoff: input.cutoff,
        baseline: result.baseline,
        caps: entry.component === 'P' && failed ? ['mandatory_failure'] : []
      }
    }
  })
  return { components, coverage: scoredWeight / totalWeight, scoredCount: scored.length, scoredWeight, weightedUnits }
}

const OUTCOMES: Readonly<Record<VerificationState, GradeOutcome>> = {
  verified: 'verified',
  failed: 'failed',
  pending: 'unverified',
  missing: 'unverified'
}

/** The status rules of docs/space-grading.md, in order, with every reason that applies. */
function gradeStatus(
  verification: VerificationState,
  components: SpaceComponentResult[],
  scoredCount: number,
  policy: SpacePolicy
): { outcome: GradeOutcome; status: GradeStatus; statusReasons: GradeStatusReason[] } {
  const outcome = OUTCOMES[verification]
  const tooSparse = outcome === 'verified' && scoredCount < policy.minScoredComponents
  const requiredMissing = components.some((entry) => entry.required && entry.component !== 'P' && entry.state === 'missing')
  const estimated = components.some((entry) => entry.state === 'estimated')
  const reasons: [GradeStatusReason, boolean][] = [
    ['mandatory_failure', outcome === 'failed'],
    ['verification_missing', verification === 'missing'],
    ['verification_pending', verification === 'pending'],
    ['insufficient_coverage', tooSparse],
    ['required_component_missing', requiredMissing],
    ['estimated_input', estimated]
  ]
  const status: GradeStatus =
    outcome === 'unverified' || tooSparse ? 'ungraded' : requiredMissing || estimated ? 'provisional' : 'final'
  return { outcome, status, statusReasons: reasons.filter(([, applies]) => applies).map(([reason]) => reason) }
}

/** The capped and uncapped composite, its display text and letter; all null when ungraded. */
function scoreFields(
  status: GradeStatus,
  failed: boolean,
  weighed: { scoredWeight: number; weightedUnits: number },
  policy: SpacePolicy
): Pick<SpaceGrade, 'score' | 'uncappedScore' | 'displayScore' | 'letter'> {
  if (status === 'ungraded') {
    return { score: null, uncappedScore: null, displayScore: null, letter: null }
  }
  const uncapped = Math.round(weighed.weightedUnits / weighed.scoredWeight)
  const capped = failed ? Math.min(uncapped, toUnits(policy.mandatoryFailureCeiling, policy)) : uncapped
  const score = fromUnits(capped, policy)
  return {
    score,
    uncappedScore: fromUnits(uncapped, policy),
    displayScore: displayScore(score, policy),
    letter: failed ? 'F' : letterFor(score, policy)
  }
}

/** What each status means, shown first in the status explanation. */
const STATUS_TEXT: Readonly<Record<GradeStatus, string>> = {
  final: 'final: the outcome is decided (verified or confirmed failed) and every required component is observed',
  provisional: 'provisional: a score and letter, not final until every required component is observed',
  ungraded: 'ungraded: no score and no letter'
}

/** The status, then one line per status reason. */
function statusLines(
  status: GradeStatus,
  reasons: readonly GradeStatusReason[],
  components: readonly SpaceComponentResult[],
  policy: SpacePolicy
): string[] {
  const names = (pick: (entry: SpaceComponentResult) => boolean): string =>
    components
      .filter(pick)
      .map((entry) => entry.component)
      .join(', ')
  const scored = components.filter((entry) => entry.state !== 'missing').length
  const text: Readonly<Record<GradeStatusReason, string>> = {
    mandatory_failure: `a mandatory check or criterion is confirmed failed: P is 0 and the score is capped at ${num(policy.mandatoryFailureCeiling, policy)}, letter F`,
    verification_missing: 'required verification is missing (no reviewed evidence): ungraded whatever the other components say',
    verification_pending: 'verification is pending: ungraded whatever the other components say',
    insufficient_coverage: `only ${scored} of ${components.length} components scored, fewer than ${policy.minScoredComponents}`,
    required_component_missing: `required component(s) ${names((entry) => entry.required && entry.component !== 'P' && entry.state === 'missing')} missing`,
    estimated_input: `component(s) ${names((entry) => entry.state === 'estimated')} estimated`
  }
  return [STATUS_TEXT[status], ...reasons.map((reason) => text[reason])]
}

/** Every record the components and caps cite, without repeats, in component order. */
function citedEvidence(components: readonly SpaceComponentResult[], caps: readonly GradeCap[]): EvidenceRef[] {
  const seen = new Set<string>()
  const cited: EvidenceRef[] = []
  for (const ref of [...components.flatMap((entry) => entry.evidence), ...caps.flatMap((cap) => cap.evidence)]) {
    const key = `${ref.kind}\u0000${ref.id}\u0000${ref.detail ?? ''}`
    if (!seen.has(key)) {
      seen.add(key)
      cited.push(ref)
    }
  }
  return cited
}

/** How the result follows from the components: the composite, the cap, the band, the status and what is missing. */
function explainGrade(
  fields: Pick<SpaceGrade, 'score' | 'uncappedScore' | 'letter' | 'status' | 'statusReasons' | 'caps'>,
  components: SpaceComponentResult[],
  weights: Readonly<Record<SpaceComponent, number>>,
  policy: SpacePolicy
): GradeExplanation {
  const scored = components.filter((entry) => entry.score !== null)
  const scoredWeight = scored.reduce((sum, entry) => sum + weights[entry.component], 0)
  const terms = scored.map((entry) => `${weights[entry.component] === 1 ? '' : `${weights[entry.component]} × `}${entry.component} ${entry.score}`)
  const { score, uncappedScore, letter } = fields
  const failed = fields.caps.length > 0
  const ceiling = num(policy.mandatoryFailureCeiling, policy)
  let letterText: string | null = null
  if (score !== null && letter !== null) {
    const band = bandOf(score, policy)
    const above = policy.bands[policy.bands.indexOf(band) - 1]
    const bandText = band.min > 0 || above === undefined ? `${score} ≥ ${num(band.min, policy)} → ${band.letter}` : `${score} < ${num(above.min, policy)} → F`
    letterText = failed ? `confirmed mandatory failure → F (the capped score ${bandText})` : bandText
  }
  return {
    composite: uncappedScore === null ? null : `(${terms.join(' + ')}) ÷ ${scoredWeight} = ${uncappedScore}`,
    cap: failed && uncappedScore !== null && score !== null ? `confirmed mandatory failure: min(${uncappedScore}, ${ceiling}) = ${score}` : null,
    letter: letterText,
    status: statusLines(fields.status, fields.statusReasons, components, policy),
    missing: components.flatMap((entry) => (entry.missingReason === null ? [] : [{ component: entry.component, reason: entry.missingReason }])),
    rounding: {
      canonicalDecimals: policy.precision.canonicalDecimals,
      canonical: 'half_up',
      displayDecimals: policy.precision.displayDecimals,
      display: policy.precision.displayRounding
    },
    evidence: citedEvidence(components, fields.caps)
  }
}

/**
 * Grades one subject under a policy. Pure and deterministic: the same input and policy give the same grade,
 * byte for byte once serialized, and the grade names both by content hash (`inputHash`, `policy.hash`). The
 * input and policy are validated first (`invalid_input` otherwise), so every grade it returns parses with
 * `parseGrade`. Nothing a worker states about an overall grade is an input: only the seven component inputs are.
 */
export function gradeSpace(rawInput: SpaceGradeInput, rawPolicy: SpacePolicy = CURRENT_SPACE_POLICY): SpaceGrade {
  const input = parseGradeInput(rawInput)
  const policy = parseSpacePolicy(rawPolicy)
  const verification = input.components.P.verification
  const failed = verification.state === 'failed'
  const normalized: Record<SpaceComponent, Normalized> = {
    S: normalizeSatisfaction(input),
    P: normalizePerformance(input, policy),
    A: normalizeDelivery(input, policy),
    C: normalizeCollaboration(input, policy),
    E: normalizeEfficiency(input, policy),
    T: normalizeResource('T', input, policy),
    K: normalizeResource('K', input, policy)
  }
  const weighed = weighComponents(normalized, input, failed, policy)
  const { outcome, status, statusReasons } = gradeStatus(verification.state, weighed.components, weighed.scoredCount, policy)
  const baselineIds = [normalized.T.inputs.baselineId, normalized.K.inputs.baselineId].filter((id): id is string => typeof id === 'string')
  const caps: GradeCap[] = failed ? [{ kind: 'mandatory_failure', ceiling: policy.mandatoryFailureCeiling, letter: 'F', evidence: verification.evidence }] : []
  const fields = scoreFields(status, failed, weighed, policy)
  const weights = Object.fromEntries(policy.components.map((entry) => [entry.component, entry.weight])) as Record<SpaceComponent, number>
  return {
    assessmentId: null,
    policy: policyRef(policy),
    subject: input.subject,
    cutoff: input.cutoff,
    dispatchedAt: input.dispatchedAt,
    inputHash: contentHash(input),
    status,
    outcome,
    statusReasons,
    ...fields,
    coverage: weighed.coverage,
    scoredComponents: weighed.scoredCount,
    caps,
    components: weighed.components,
    baselineIds: [...new Set(baselineIds)],
    explanation: explainGrade({ ...fields, status, statusReasons, caps }, weighed.components, weights, policy)
  }
}
