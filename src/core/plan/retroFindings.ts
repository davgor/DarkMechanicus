/**
 * Retro findings (`src/shared/domain/retroFindings.ts`) derived from one frozen scorecard snapshot. Pure and
 * deterministic: it reads the snapshot alone (its stored component inputs, results and aggregate details), never a
 * clock or a later record, and orders everything by fixed keys, so the same snapshot always gives the same findings.
 *
 * What is a finding, per frozen grade:
 * - `failed_verification` (ticket P): verification failed, or attributed regressions were charged.
 * - `delivery_gap` (sprint A): fewer feature tickets delivered than committed, with the undelivered outcomes and why.
 * - `coordination_problem` (ticket C): failed handoff checks, rejected submissions or coordination defects.
 * - `corrective_concentration` (ticket E): one ticket holds most of the sprint's corrective effort and corrective
 *   effort is a large share of its own. Productive effort (planned tests, useful investigation) and unclassified
 *   effort are never counted as waste.
 * - `budget_overrun` (ticket T, K): the actual is past its selected baseline by the overrun threshold or more.
 * - `missing_instrumentation` (sprint, per component): tickets whose P, E, T or K has no value because a host,
 *   adapter or review did not record it. A missing rating or budget is not a gap of the work and is not listed.
 *
 * Causes are never claimed: each finding lists hypotheses, each tagged with the concern it would be. A proposal outline
 * (what to measure, the direction, guardrails read from the same grade, where the work goes) is given only for a finding
 * with exactly one candidate concern, no contradicting signal, enough data and a readable measure; it never holds work.
 */
import { EXPERIMENT_MEASURES, type ExperimentDestinationKind, type ExperimentDirection, type ExperimentMeasure, type ImprovementConcern } from '../../shared/domain/experiments'
import type { VerificationReason } from '../../shared/domain/performance'
import {
  FINDING_KINDS,
  type FindingContradiction,
  type FindingCoverage,
  type FindingHypothesis,
  type FindingKind,
  type FindingMagnitude,
  type FindingOrigins,
  type ProposalOutline,
  type ProposalWithheldReason,
  type RetroFinding,
  type RetroFindingsView,
  type RetroFindingThresholds
} from '../../shared/domain/retroFindings'
import {
  type ComponentMissingReason,
  type EvidenceRef,
  type GradeSubject,
  type Measurement,
  SPACE_COMPONENT_LABELS,
  type SpaceComponent,
  type SpaceGradeInput
} from '../../shared/domain/space'
import type { FrozenGrade, ScorecardSnapshot } from '../../shared/domain/spaceGrades'
import { frozenInput } from '../space/snapshot'
import { readMeasure } from './experiments'

/** The thresholds a gap must pass to be a finding (policy of this module; shown with every view). */
const RETRO_FINDING_THRESHOLDS: RetroFindingThresholds = { overrun: 0.25, correctiveShare: 0.5, correctiveOfOwn: 0.25, sparseCoverage: 0.5 }

/** A ticket's display key and title, as the run's plan names it; null for a ticket the plan does not hold. */
type TicketNames = (ticketId: string) => { key: string; title: string } | null

/** How statements name a ticket: its key and title (`DM-3 "Add the importer"`), or its id when the plan has no name. */
type NameOf = (ticketId: string) => string

function nameOf(names: TicketNames): NameOf {
  return (ticketId) => {
    const found = names(ticketId)
    return found === null || found.key === '' ? ticketId : found.title === '' ? found.key : `${found.key} "${found.title}"`
  }
}

/** How a snapshot is read: the thresholds a gap must pass, and how statements name tickets. */
interface Reading {
  thresholds: RetroFindingThresholds
  name: NameOf
}

/** A finding before ranking, contradiction marking and proposal outlining. */
interface Draft {
  id: string
  kind: FindingKind
  grade: FrozenGrade
  component: SpaceComponent
  statement: string
  magnitude: FindingMagnitude
  severity: number
  coverage: FindingCoverage
  evidence: EvidenceRef[]
  extra: { attemptIds: string[]; ticketIds: string[] }
  hypotheses: FindingHypothesis[]
  /** The measure a change would be read from and the way it should move; null when nothing measures it. */
  target: { measure: ExperimentMeasure; direction: ExperimentDirection } | null
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6
const percent = (ratio: number): string => `${Math.round(ratio * 1000) / 10}%`
const minutes = (ms: number): string => `${Math.round(ms / 6000) / 10} min`
const valueOf = (measurement: Measurement): number | null => (measurement.state === 'missing' ? null : measurement.value)
const stateOf = (...measurements: Measurement[]): 'observed' | 'estimated' => (measurements.some((item) => item.state === 'estimated') ? 'estimated' : 'observed')
const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort()

function idOf(kind: FindingKind, subject: GradeSubject, component?: SpaceComponent): string {
  return [kind, subject.level, subject.id, ...(component === undefined ? [] : [component])].join(':')
}

function componentScore(grade: FrozenGrade, component: SpaceComponent): number | null {
  return grade.result.components.find((item) => item.component === component)?.score ?? null
}

function gradeCoverage(grade: FrozenGrade, items: FindingCoverage['items'] = null): FindingCoverage {
  return { grade: grade.result.coverage, items }
}

/** Each cited record once, in a fixed order. */
function uniqueEvidence(refs: EvidenceRef[]): EvidenceRef[] {
  const byKey = new Map(refs.map((ref) => [`${ref.kind}\u0000${ref.id}\u0000${ref.detail ?? ''}`, ref]))
  return [...byKey.keys()].sort().map((key) => byKey.get(key) as EvidenceRef)
}

function originsOf(evidence: EvidenceRef[], extra: Draft['extra']): FindingOrigins {
  const of = (kind: EvidenceRef['kind']) => evidence.filter((ref) => ref.kind === kind)
  const criteria = new Map(of('criterion').map((ref) => [`${ref.id}:${ref.detail ?? ''}`, { ticketId: ref.id, criterionId: ref.detail ?? '' }]))
  const checks = new Map(of('check').map((ref) => [`${ref.id}:${ref.detail ?? ''}`, { attemptId: ref.id, name: ref.detail ?? '' }]))
  return {
    attemptIds: sorted([...of('attempt').map((ref) => ref.id), ...of('check').map((ref) => ref.id), ...extra.attemptIds]),
    criteria: [...criteria.keys()].sort().map((key) => criteria.get(key) as FindingOrigins['criteria'][number]),
    observationIds: sorted(of('observation').map((ref) => ref.id)),
    checks: [...checks.keys()].sort().map((key) => checks.get(key) as FindingOrigins['checks'][number]),
    ticketIds: sorted([...of('ticket').map((ref) => ref.id), ...of('criterion').map((ref) => ref.id), ...extra.ticketIds])
  }
}

const NONE = { attemptIds: [], ticketIds: [] }

// ---------------------------------------------------------------------------------------------------------------
// Ticket findings

/** "1 submission", "2 submissions". */
const counted = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

const FAILED_HYPOTHESES = {
  code: { concern: 'code_defect', hypothesis: 'Hypothesis: the delivered change did not do what the failed check or criterion asked.' },
  plan: { concern: 'plan_context', hypothesis: 'Hypothesis: the criterion as written did not say what the review expected, so the work aimed elsewhere.' },
  regression: { concern: 'code_defect', hypothesis: 'Hypothesis: the change introduced the attributed regressions it is charged with.' }
} as const satisfies Record<string, FindingHypothesis>

/** A failure cited by checks alone points at the change; one citing criteria may also be the criteria's wording. */
function verificationHypotheses(failed: boolean, evidence: EvidenceRef[]): FindingHypothesis[] {
  if (!failed) return [FAILED_HYPOTHESES.regression]
  const checksOnly = evidence.some((ref) => ref.kind === 'check') && !evidence.some((ref) => ref.kind === 'criterion')
  return checksOnly ? [FAILED_HYPOTHESES.code] : [FAILED_HYPOTHESES.code, FAILED_HYPOTHESES.plan]
}

function verificationMagnitude(failed: boolean, score: number, regressions: number): FindingMagnitude {
  const extra = regressions === 0 ? '' : `; ${counted(regressions, 'attributed regression')}`
  return failed
    ? { measure: 'P.score', value: score, unit: 'points', reference: 100, ratio: round(score / 100), state: 'observed', text: `verification failed (P ${score} of 100)${extra}` }
    : { measure: 'P.regressions', value: regressions, unit: 'count', reference: null, ratio: null, state: 'observed', text: counted(regressions, 'attributed regression') }
}

function failedVerification(grade: FrozenGrade, input: SpaceGradeInput, name: NameOf): Draft | null {
  const { P } = input.components
  const attributed = P.regressions.filter((item) => item.attribution === 'attributed')
  const failed = P.verification.state === 'failed'
  if (!failed && attributed.length === 0) return null
  const regressions = attributed.map((item): EvidenceRef => ({ kind: 'observation', id: item.observationId, detail: `${item.severity} regression` }))
  const magnitude = verificationMagnitude(failed, componentScore(grade, 'P') ?? 0, attributed.length)
  return {
    id: idOf('failed_verification', grade.subject),
    kind: 'failed_verification',
    grade,
    component: 'P',
    statement: failed
      ? `Ticket ${name(grade.subject.id)}: required verification failed (${counted(P.verification.evidence.length, 'cited record')}): ${magnitude.text}.`
      : `Ticket ${name(grade.subject.id)}: ${magnitude.text} charged by the cutoff.`,
    magnitude,
    severity: failed ? 1 : round(Math.min(1, attributed.length / 4)),
    coverage: gradeCoverage(grade),
    evidence: [...P.verification.evidence, ...regressions],
    extra: NONE,
    hypotheses: verificationHypotheses(failed, P.verification.evidence),
    target: failed ? { measure: 'P.score', direction: 'increase' } : { measure: 'P.regressions', direction: 'decrease' }
  }
}

interface HandoffCounts {
  failedChecks: number
  checks: number
  rejected: number
  defects: number
}

function handoffCounts(C: SpaceGradeInput['components']['C']): HandoffCounts {
  const checks = C.handoffChecks === null ? 0 : C.handoffChecks.passed + C.handoffChecks.failed
  return { failedChecks: C.handoffChecks?.failed ?? 0, checks, rejected: C.rejected?.submissions ?? 0, defects: C.coordinationDefects }
}

/** The measure a coordination finding is read from: defects first, then rejections, then failed checks. */
function handoffMagnitude(counts: HandoffCounts, text: string): FindingMagnitude {
  const base = { unit: 'count' as const, state: 'observed' as const, text, reference: null, ratio: null }
  if (counts.defects > 0) return { ...base, measure: 'C.coordination_defects', value: counts.defects }
  if (counts.rejected > 0) return { ...base, measure: 'C.rejected_submissions', value: counts.rejected }
  return { ...base, measure: 'C.failed_checks', value: counts.failedChecks, reference: counts.checks, ratio: round(counts.failedChecks / counts.checks) }
}

function handoffHypotheses(counts: HandoffCounts, defectText: string): FindingHypothesis[] {
  const defects: FindingHypothesis[] = [
    { concern: 'orchestration_tooling', hypothesis: `Hypothesis: the handoff between orchestrator, workers and reviewers lost or misrouted work (${defectText}).` }
  ]
  const handoffs: FindingHypothesis[] = [
    { concern: 'code_defect', hypothesis: 'Hypothesis: the submitted work did not meet its criteria when it was handed off.' },
    { concern: 'plan_context', hypothesis: 'Hypothesis: the ticket text or context let the worker and the reviewer read the criteria differently.' }
  ]
  return [...(counts.defects > 0 ? defects : []), ...(counts.failedChecks > 0 || counts.rejected > 0 ? handoffs : [])]
}

function handoffParts(counts: HandoffCounts, defectText: string): string[] {
  return [
    ...(counts.failedChecks > 0 ? [`${counts.failedChecks} of ${counts.checks} handoff checks failed`] : []),
    ...(counts.rejected > 0 ? [`${counted(counts.rejected, 'submission')} rejected`] : []),
    ...(counts.defects > 0 ? [defectText] : [])
  ]
}

function coordinationProblem(grade: FrozenGrade, input: SpaceGradeInput, name: NameOf): Draft | null {
  const { C } = input.components
  const counts = handoffCounts(C)
  if (counts.failedChecks === 0 && counts.rejected === 0 && counts.defects === 0) return null
  const defectText = `${counted(counts.defects, 'coordination defect')} recorded`
  const parts = handoffParts(counts, defectText)
  const score = componentScore(grade, 'C')
  const rate = counts.checks > 0 ? counts.failedChecks / counts.checks : 0
  const severity = Math.max((100 - (score ?? 100)) / 100, rate, Math.min(1, (counts.rejected + counts.defects) / 4))
  const magnitude = handoffMagnitude(counts, parts.join(', '))
  return {
    id: idOf('coordination_problem', grade.subject),
    kind: 'coordination_problem',
    grade,
    component: 'C',
    statement: `Ticket ${name(grade.subject.id)}: ${parts.join(', ')}${score === null ? '' : ` (C ${score} of 100)`}.`,
    magnitude,
    severity: round(severity),
    // Counts of one ticket's handoffs: no items with and without data, so only the grade's coverage applies.
    coverage: gradeCoverage(grade),
    evidence: C.evidence,
    extra: NONE,
    hypotheses: handoffHypotheses(counts, defectText),
    target: { measure: magnitude.measure as ExperimentMeasure, direction: 'decrease' }
  }
}

/** What may explain an overrun, by the corrective effort the ticket recorded (none: productive work, not waste). */
function overrunHypotheses(corrective: number | null): FindingHypothesis[] {
  if (corrective === 0) {
    return [
      {
        concern: 'plan_context',
        hypothesis:
          'Hypothesis: the budget or size did not fit the work. No corrective effort was recorded, so the overrun went into productive work, exploration included, which is not waste.'
      }
    ]
  }
  const plan: FindingHypothesis = { concern: 'plan_context', hypothesis: 'Hypothesis: the budget or size did not fit the work as planned.' }
  return corrective === null
    ? [plan, { concern: 'unavailable_evidence', hypothesis: 'Hypothesis: rework took part of it, but effort was not classified, so rework cannot be told from productive work.' }]
    : [plan, { concern: 'code_defect', hypothesis: `Hypothesis: rework on the change (${minutes(corrective)} of corrective effort) spent part of the budget.` }]
}

const RESOURCE = {
  T: { label: 'active time', measure: 'T.actual_ms', unit: 'milliseconds', score: 'T.score', show: minutes },
  K: { label: 'tokens', measure: 'K.actual_tokens', unit: 'tokens', score: 'K.score', show: (value: number) => `${value} tokens` }
} as const

/** A resource's actual over its selected baseline: [actual, baseline value], or null when either is not measured. */
function resourceRatio(resource: SpaceGradeInput['components']['T']): { actual: number; baseline: number } | null {
  const actual = valueOf(resource.actual)
  if (resource.baseline.state !== 'selected' || resource.unreportedAttempts > 0 || actual === null || resource.baseline.baseline.value <= 0) return null
  return { actual, baseline: resource.baseline.baseline.value }
}

function budgetOverrun(grade: FrozenGrade, input: SpaceGradeInput, component: 'T' | 'K', reading: Reading): Draft | null {
  const { thresholds, name } = reading
  const resource = input.components[component]
  const pair = resourceRatio(resource)
  if (pair === null || pair.actual / pair.baseline - 1 < thresholds.overrun || resource.baseline.state !== 'selected') return null
  const { baseline } = resource.baseline
  const over = pair.actual / pair.baseline - 1
  const spec = RESOURCE[component]
  return {
    id: idOf('budget_overrun', grade.subject, component),
    kind: 'budget_overrun',
    grade,
    component,
    statement: `Ticket ${name(grade.subject.id)}: ${spec.label} ${spec.show(pair.actual)} against a ${baseline.kind} baseline of ${spec.show(pair.baseline)} (${percent(over)} over).`,
    magnitude: {
      measure: spec.measure,
      value: pair.actual,
      unit: spec.unit,
      reference: pair.baseline,
      ratio: round(pair.actual / pair.baseline),
      state: stateOf(resource.actual),
      text: `${percent(over)} over its ${baseline.kind} baseline`
    },
    severity: round(Math.min(1, over)),
    coverage: gradeCoverage(grade),
    evidence: [...resource.evidence, { kind: 'baseline', id: baseline.baselineId, detail: null }],
    extra: NONE,
    hypotheses: overrunHypotheses(valueOf(input.components.E.correctiveMs)),
    target: { measure: spec.score, direction: 'increase' }
  }
}

/** One ticket holding most of the sprint's corrective effort, with corrective effort a large share of its own. */
function correctiveConcentration(snapshot: ScorecardSnapshot, reading: Reading): Draft[] {
  const { thresholds, name } = reading
  const rows = snapshot.tickets.map((grade) => {
    const { E } = frozenInput(snapshot, grade).components
    return { grade, E, corrective: valueOf(E.correctiveMs), productive: valueOf(E.productiveMs), unclassified: valueOf(E.unclassifiedMs) }
  })
  const measured = rows.filter((row) => row.corrective !== null)
  const total = measured.reduce((sum, row) => sum + (row.corrective ?? 0), 0)
  if (measured.length < 2 || total <= 0) return []
  return measured.flatMap((row): Draft[] => {
    const corrective = row.corrective ?? 0
    const own = corrective + (row.productive ?? 0) + (row.unclassified ?? 0)
    const share = corrective / total
    const ofOwn = own === 0 ? 0 : corrective / own
    // A strict majority: an even split between two tickets concentrates nothing.
    if (corrective <= 0 || share <= thresholds.correctiveShare || ofOwn < thresholds.correctiveOfOwn) return []
    const productive = row.productive === null ? 'not measured' : minutes(row.productive)
    const unclassified = row.unclassified === null ? 'not measured' : minutes(row.unclassified)
    return [
      {
        id: idOf('corrective_concentration', row.grade.subject),
        kind: 'corrective_concentration',
        grade: row.grade,
        component: 'E',
        statement:
          `Ticket ${name(row.grade.subject.id)}: ${minutes(corrective)} of corrective effort, ${percent(share)} of the sprint's ${minutes(total)} and ${percent(ofOwn)} of its own recorded effort ` +
          `(productive ${productive}, unclassified ${unclassified}; neither is counted as waste: productive effort includes planned tests and useful investigation).`,
        magnitude: {
          measure: 'E.corrective_ms',
          value: corrective,
          unit: 'milliseconds',
          reference: total,
          ratio: round(share),
          state: stateOf(row.E.correctiveMs),
          text: `${percent(share)} of the sprint's corrective effort`
        },
        severity: round(ofOwn),
        coverage: gradeCoverage(row.grade, { measured: measured.length, total: rows.length }),
        evidence: row.E.evidence,
        extra: NONE,
        hypotheses: [
          { concern: 'code_defect', hypothesis: 'Hypothesis: the rework went into fixing defects in the change itself.' },
          { concern: 'plan_context', hypothesis: 'Hypothesis: criteria or context changed or were unclear while the ticket was in flight, so finished work was redone.' }
        ],
        target: { measure: 'E.corrective_ms', direction: 'decrease' }
      }
    ]
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Sprint findings

/**
 * What an undelivered outcome's reason points to (hypotheses to check, not causes). A confirmed failure reads as the
 * failed ticket's own verification finding reads it (`verificationHypotheses`): a failure cited by checks alone points
 * at the change, one citing criteria may also be the criteria's wording.
 */
const UNDELIVERED_HYPOTHESES: Readonly<Record<Exclude<VerificationReason, 'reviewed' | 'confirmed_failure'>, FindingHypothesis>> = {
  run_ended: { concern: 'orchestration_tooling', hypothesis: 'Hypothesis: the run ended before this work could finish' },
  no_attempt: { concern: 'plan_context', hypothesis: 'Hypothesis: the sprint held more than fit, or sequencing and scope changes held this work back' },
  carried_forward: { concern: 'plan_context', hypothesis: 'Hypothesis: the sprint held more than fit, or sequencing and scope changes held this work back' },
  in_progress: { concern: 'plan_context', hypothesis: 'Hypothesis: the sprint held more than fit, or sequencing and scope changes held this work back' },
  awaiting_review: { concern: 'plan_context', hypothesis: 'Hypothesis: the sprint held more than fit, or sequencing and scope changes held this work back' },
  awaiting_retry: { concern: 'plan_context', hypothesis: 'Hypothesis: the sprint held more than fit, or sequencing and scope changes held this work back' },
  worker_claims_only: { concern: 'unavailable_evidence', hypothesis: 'Hypothesis: the work may be done, but no reviewed evidence shows it' },
  required_evidence_missing: { concern: 'unavailable_evidence', hypothesis: 'Hypothesis: the work may be done, but no reviewed evidence shows it' },
  legacy_review_basis_unknown: { concern: 'unavailable_evidence', hypothesis: 'Hypothesis: the work may be done, but no reviewed evidence shows it' },
  retry_grants_unknown: { concern: 'unavailable_evidence', hypothesis: 'Hypothesis: the work may have been granted another try on the machine that ran it, which these records do not show' }
}

/** Reasons that leave a committed item's delivery state without reviewed evidence (no data to read it from). */
const UNEVIDENCED_REASONS: readonly VerificationReason[] = ['worker_claims_only', 'required_evidence_missing', 'legacy_review_basis_unknown', 'retry_grants_unknown']

type Outcome = ScorecardSnapshot['details'][string]['outcomes'][number]

/** The hypotheses an undelivered outcome points to; a confirmed failure's are its ticket's verification hypotheses. */
function outcomeHypotheses(snapshot: ScorecardSnapshot, outcome: Outcome): FindingHypothesis[] {
  if (outcome.reason === 'reviewed') return []
  if (outcome.reason !== 'confirmed_failure') return [UNDELIVERED_HYPOTHESES[outcome.reason]]
  const grade = snapshot.tickets.find((item) => item.subject.id === outcome.ticketId)
  // Without the ticket's grade nothing says the failure was cited by checks alone, so both readings stay open.
  return verificationHypotheses(true, grade === undefined ? [] : frozenInput(snapshot, grade).components.P.verification.evidence)
}

/** One hypothesis per distinct explanation the undelivered outcomes point to, each naming its tickets. */
function undeliveredHypotheses(snapshot: ScorecardSnapshot, open: Outcome[], added: number, name: NameOf): FindingHypothesis[] {
  const byHypothesis = new Map<string, { item: FindingHypothesis; cited: string[] }>()
  const note = (item: FindingHypothesis, text: string): void => {
    const key = `${item.concern}\u0000${item.hypothesis}`
    byHypothesis.set(key, { item, cited: [...(byHypothesis.get(key)?.cited ?? []), text] })
  }
  for (const outcome of open) {
    for (const item of outcomeHypotheses(snapshot, outcome)) note(item, `${name(outcome.ticketId)} ${outcome.reason}`)
  }
  if (added > 0) note(UNDELIVERED_HYPOTHESES.no_attempt, `${added} items added after dispatch`)
  return [...byHypothesis.keys()].sort().map((key) => {
    const { item, cited } = byHypothesis.get(key) as { item: FindingHypothesis; cited: string[] }
    return { concern: item.concern, hypothesis: `${item.hypothesis.replace(/\.$/, '')} (${cited.join(', ')}).` }
  })
}

function deliveryGap(snapshot: ScorecardSnapshot, name: NameOf): Draft | null {
  const grade = snapshot.sprint
  const { A } = frozenInput(snapshot, grade).components
  const committed = A.committed ?? 0
  if (committed === 0 || A.delivered >= committed) return null
  const open = (snapshot.details[grade.detail]?.outcomes ?? [])
    .filter((outcome) => outcome.role === 'work' && outcome.state !== 'verified')
    .sort((a, b) => a.ticketId.localeCompare(b.ticketId) || a.runId.localeCompare(b.runId))
  const gap = committed - A.delivered
  const listed = open.map((outcome) => `${name(outcome.ticketId)} (${outcome.state}, ${outcome.reason})`)
  const added = A.added > 0 ? `; ${A.added} added after dispatch` : ''
  return {
    id: idOf('delivery_gap', grade.subject),
    kind: 'delivery_gap',
    grade,
    component: 'A',
    statement:
      `Sprint ${grade.subject.id}: delivered ${A.delivered} of ${committed} committed items (${gap} short, ${percent(gap / committed)})${added}` +
      `${listed.length > 0 ? `. Not delivered: ${listed.join(', ')}` : ''}.`,
    magnitude: {
      measure: 'A.delivered',
      value: A.delivered,
      unit: 'count',
      reference: committed,
      ratio: round(A.delivered / committed),
      state: 'observed',
      text: `${gap} of ${committed} committed items not delivered`
    },
    severity: round(gap / committed),
    // Of the committed items, those whose delivery state rests on reviewed evidence.
    coverage: gradeCoverage(grade, { measured: committed - open.filter((outcome) => UNEVIDENCED_REASONS.includes(outcome.reason)).length, total: committed }),
    evidence: A.evidence,
    extra: { attemptIds: open.flatMap((outcome) => (outcome.attemptId === null ? [] : [outcome.attemptId])), ticketIds: open.map((outcome) => outcome.ticketId) },
    hypotheses: undeliveredHypotheses(snapshot, open, A.added, name),
    target: { measure: 'A.delivered', direction: 'increase' }
  }
}

/** The components a host, adapter or review instruments. */
type InstrumentedComponent = 'P' | 'E' | 'T' | 'K'

/** Missing reasons that mean a host, adapter or review did not record something (not a missing rating or budget). */
const INSTRUMENT_REASONS: Readonly<Record<InstrumentedComponent, readonly ComponentMissingReason[]>> = {
  P: ['verification_missing'],
  E: ['not_reported', 'host_unavailable', 'partial_coverage', 'zero_observation', 'insufficient_classification'],
  T: ['not_reported', 'host_unavailable', 'partial_coverage', 'partial_telemetry'],
  K: ['not_reported', 'host_unavailable', 'partial_coverage', 'partial_telemetry']
}

const INSTRUMENT_WHAT: Readonly<Record<InstrumentedComponent, string>> = {
  P: 'reviews did not record evidence for these outcomes',
  E: 'effort was not reported or not classified for these tickets',
  T: 'the host or adapter did not report active time for every attempt of these tickets',
  K: 'the host or adapter did not report tokens for every attempt of these tickets'
}

/** Only dispatched tickets can lack instrumentation: a ticket never worked is a delivery gap, not a measuring one. */
function missingInstrumentation(snapshot: ScorecardSnapshot): Draft[] {
  const dispatched = snapshot.tickets.filter((grade) => grade.dispatchedAt !== null)
  const total = dispatched.length
  const detail = snapshot.details[snapshot.sprint.detail]
  return (['P', 'E', 'T', 'K'] as const).flatMap((component): Draft[] => {
    const reasons = INSTRUMENT_REASONS[component]
    const missing = dispatched
      .map((grade) => ({ grade, result: grade.result.components.find((item) => item.component === component) }))
      .filter((row) => row.result?.score === null && row.result.missingReason !== null && reasons.includes(row.result.missingReason))
      .sort((a, b) => a.grade.subject.id.localeCompare(b.grade.subject.id))
    if (missing.length === 0) return []
    const unreported =
      component === 'T' || component === 'K'
        ? (detail?.efficiency ?? []).flatMap((item) => (component === 'T' ? item.time.unreportedAttemptIds : item.tokens.unreportedAttemptIds))
        : []
    const reasonText = sorted(missing.map((row) => row.result?.missingReason ?? '')).join(', ')
    const label = SPACE_COMPONENT_LABELS[component]
    return [
      {
        id: idOf('missing_instrumentation', snapshot.sprint.subject, component),
        kind: 'missing_instrumentation',
        grade: snapshot.sprint,
        component,
        statement:
          `Sprint ${snapshot.sprint.subject.id}: ${label} (${component}) has no value for ${missing.length} of ${total} tickets (${reasonText})` +
          `${unreported.length > 0 ? `; ${unreported.length} attempt${unreported.length === 1 ? '' : 's'} reported nothing` : ''}.`,
        magnitude: {
          measure: null,
          value: missing.length,
          unit: 'count',
          reference: total,
          ratio: round(missing.length / total),
          state: 'observed',
          text: `${missing.length} of ${total} tickets unmeasured`
        },
        severity: round(missing.length / total),
        coverage: gradeCoverage(snapshot.sprint, { measured: total - missing.length, total }),
        evidence: missing.map((row): EvidenceRef => ({ kind: 'ticket', id: row.grade.subject.id, detail: row.result?.missingReason ?? null })),
        extra: { attemptIds: unreported, ticketIds: [] },
        hypotheses: [{ concern: 'unavailable_evidence', hypothesis: `Hypothesis: ${INSTRUMENT_WHAT[component]}.` }],
        target: null
      }
    ]
  })
}

// ---------------------------------------------------------------------------------------------------------------
// Contradictions, proposals, ranking

/** A rejection with no corrective effort recorded, or a failed verification a person rated highly. */
function ticketContradictions(grade: FrozenGrade, input: SpaceGradeInput, has: (id: string) => boolean, name: NameOf): FindingContradiction[] {
  const { subject } = grade
  const found: FindingContradiction[] = []
  const coordination = idOf('coordination_problem', subject)
  const rejected = input.components.C.rejected?.submissions ?? 0
  if (has(coordination) && rejected > 0 && valueOf(input.components.E.correctiveMs) === 0) {
    found.push({ subject, findingIds: [coordination], detail: `C shows ${counted(rejected, 'rejected submission')}, but E records no corrective effort for ${name(subject.id)}.` })
  }
  const verification = idOf('failed_verification', subject)
  const satisfaction = componentScore(grade, 'S') ?? 0
  if (has(verification) && satisfaction >= 80) {
    found.push({ subject, findingIds: [verification], detail: `S rates ${name(subject.id)} ${satisfaction} of 100 while its verification failed.` })
  }
  return found
}

/** Active time past its baseline while tokens sit well under theirs, or the other way round. */
function resourceContradiction(grade: FrozenGrade, input: SpaceGradeInput, has: (id: string) => boolean, reading: Reading): FindingContradiction[] {
  const { thresholds, name } = reading
  const ratioOf = (component: 'T' | 'K'): number | null => {
    const pair = resourceRatio(input.components[component])
    return pair === null ? null : pair.actual / pair.baseline
  }
  const [time, tokens] = [ratioOf('T'), ratioOf('K')]
  const over = (value: number | null) => value !== null && value - 1 >= thresholds.overrun
  const under = (value: number | null) => value !== null && value <= 1 / (1 + thresholds.overrun)
  if (!((over(time) && under(tokens)) || (over(tokens) && under(time)))) return []
  const { subject } = grade
  const ids = [idOf('budget_overrun', subject, 'T'), idOf('budget_overrun', subject, 'K')].filter(has)
  return [{ subject, findingIds: ids, detail: `Active time and tokens of ${name(subject.id)} sit on opposite sides of their baselines (T ${percent(time ?? 0)}, K ${percent(tokens ?? 0)} of baseline).` }]
}

/** Measures of one subject that point opposite ways: the findings involved keep their facts and lose their outline. */
function contradictions(snapshot: ScorecardSnapshot, drafts: Draft[], reading: Reading): FindingContradiction[] {
  const ids = new Set(drafts.map((draft) => draft.id))
  const has = (id: string): boolean => ids.has(id)
  return snapshot.tickets.flatMap((grade) => {
    const input = frozenInput(snapshot, grade)
    return [...ticketContradictions(grade, input, has, reading.name), ...resourceContradiction(grade, input, has, reading)]
  })
}

const DESTINATIONS: Readonly<Record<ImprovementConcern, ExperimentDestinationKind>> = {
  code_defect: 'source_repository',
  plan_context: 'source_repository',
  orchestration_tooling: 'darkmechanicus_source',
  unavailable_evidence: 'darkmechanicus_source'
}

const GUARDRAIL_MEASURES: readonly ExperimentMeasure[] = ['P.score', 'A.delivered']

const PLANNER_NEEDS = [
  'proposedWork: specific, sized corrective work the planner authors (each item says what changes and has a size)',
  'expectedChange.amount and window',
  'a hypothesis in your own words, labeled as one'
]

/** Where the outline is read: the snapshot, whether the finding is contradicted, and whether data is sparse. */
interface OutlineContext {
  snapshot: ScorecardSnapshot
  contradicted: boolean
  sparse: boolean
}

function instrumentationOutline(source: ProposalOutline['source']): ProposalOutline {
  return {
    concern: 'unavailable_evidence',
    destination: DESTINATIONS.unavailable_evidence,
    source,
    baseline: null,
    direction: 'increase',
    guardrails: [],
    needs: ['record it as a discovery (instrumentation work): nothing measures it yet, and an experiment needs a measured baseline', PLANNER_NEEDS[0] ?? '']
  }
}

/** Why no outline is given, before reading any measure; null when one may be. */
function withheldBefore(context: OutlineContext, concern: ImprovementConcern | null): ProposalWithheldReason | null {
  if (context.contradicted) return 'contradictory_signals'
  if (concern === null) return 'multiple_candidate_causes'
  return context.sparse ? 'sparse_data' : null
}

function outlineOf(context: OutlineContext, draft: Draft, concern: ImprovementConcern | null): { proposal: ProposalOutline | null; withheld: ProposalWithheldReason | null } {
  const { snapshot } = context
  const source = { reportId: snapshot.report.reportId, assessmentId: draft.grade.assessmentId }
  if (draft.kind === 'missing_instrumentation') return { proposal: instrumentationOutline(source), withheld: null }
  const withheld = withheldBefore(context, concern)
  if (withheld !== null || concern === null) return { proposal: null, withheld: withheld ?? 'multiple_candidate_causes' }
  const { target } = draft
  const reading = target === null ? null : readMeasure(snapshot, draft.grade, target.measure)
  if (target === null || reading === null || 'missing' in reading) return { proposal: null, withheld: 'no_baseline' }
  // A guardrail holds the measure at its current value; at zero, "at least 0" always holds and guards nothing.
  const guardrails = GUARDRAIL_MEASURES.filter((measure) => measure !== target.measure).flatMap((measure) => {
    const value = readMeasure(snapshot, draft.grade, measure)
    return 'missing' in value || value.value <= 0 ? [] : [{ measure, unit: EXPERIMENT_MEASURES[measure].unit, comparator: 'at_least' as const, threshold: value.value }]
  })
  const proposal: ProposalOutline = {
    concern,
    destination: DESTINATIONS[concern],
    source,
    baseline: { measure: target.measure, unit: EXPERIMENT_MEASURES[target.measure].unit, value: reading.value, state: reading.state },
    direction: target.direction,
    guardrails,
    needs: guardrails.length === 0 ? [...PLANNER_NEEDS, 'guardrails: no guardrail measure has a value above zero in this grade to hold'] : PLANNER_NEEDS
  }
  return { proposal, withheld: null }
}

/**
 * Too little was measured to size a change: no tickets, a sprint grade the grader found too sparse, or fewer than
 * `sparseCoverage` of the sprint's tickets graded on at least `sparseCoverage` of their components.
 */
function isSparse(snapshot: ScorecardSnapshot, thresholds: RetroFindingThresholds): boolean {
  const measured = snapshot.tickets.filter((grade) => grade.result.coverage >= thresholds.sparseCoverage).length
  return (
    snapshot.tickets.length === 0 ||
    snapshot.sprint.result.statusReasons.includes('insufficient_coverage') ||
    measured / snapshot.tickets.length < thresholds.sparseCoverage
  )
}

const ALWAYS_NOTES = [
  'Each finding states what the frozen scorecard measured. Its hypotheses are hypotheses: the metrics do not prove a cause.',
  'No finding chooses a model, a reasoning tier or a larger budget for any work.',
  'Productive effort (planned tests, useful investigation) and unclassified effort are never counted as waste; only corrective effort is.',
  'A proposal outline holds no work: the planner authors specific, sized corrective work from it, and unsized or vague work cannot be scheduled.',
  'A component missing only for a rating (no_rating) or a budget (no_eligible_baseline) is not a gap of the work and is not listed.'
]

/** Every draft of a snapshot: the sprint's delivery gap, each ticket's findings, concentration and instrumentation. */
function draftsOf(snapshot: ScorecardSnapshot, reading: Reading): Draft[] {
  const { name } = reading
  const ticketDrafts = snapshot.tickets.flatMap((grade) => {
    const input = frozenInput(snapshot, grade)
    return [failedVerification(grade, input, name), coordinationProblem(grade, input, name), budgetOverrun(grade, input, 'T', reading), budgetOverrun(grade, input, 'K', reading)]
  })
  return [deliveryGap(snapshot, name), ...ticketDrafts, ...correctiveConcentration(snapshot, reading), ...missingInstrumentation(snapshot)].filter((draft) => draft !== null)
}

function findingOf(draft: Draft, rank: number, against: FindingContradiction[], context: OutlineContext): RetroFinding {
  const concerns = sorted(draft.hypotheses.map((item) => item.concern)) as ImprovementConcern[]
  const concern = concerns.length === 1 ? (concerns[0] ?? null) : null
  const evidence = uniqueEvidence(draft.evidence)
  return {
    id: draft.id,
    rank,
    kind: draft.kind,
    subject: draft.grade.subject,
    assessmentId: draft.grade.assessmentId,
    component: draft.component,
    statement: draft.statement,
    magnitude: draft.magnitude,
    severity: draft.severity,
    coverage: draft.coverage,
    origins: originsOf(evidence, draft.extra),
    evidence,
    hypotheses: draft.hypotheses,
    concern,
    contradictedBy: sorted(against.map((item) => item.detail)),
    ...outlineOf({ ...context, contradicted: against.length > 0 }, draft, concern)
  }
}

function notesOf(view: Pick<RetroFindingsView, 'status' | 'findings' | 'contradictions' | 'thresholds'>, sparse: boolean): string[] {
  const { status, findings, thresholds } = view
  const contradicted = view.contradictions.length
  const share = percent(thresholds.sparseCoverage)
  return [
    ...ALWAYS_NOTES,
    ...(status === 'no_meaningful_issue' ? ['No measured gap passed the thresholds: there is nothing to correct, and no improvement work is proposed.'] : []),
    ...(sparse ? [`Too little of the sprint was measured to size a change (fewer than ${share} of its tickets graded on ${share} of their components), so only instrumentation is outlined.`] : []),
    ...(contradicted > 0 ? ['Some signals disagree; the findings they touch keep their facts and carry no outline.'] : []),
    ...(findings.some((item) => item.withheld === 'multiple_candidate_causes') ? ['Where several concerns could explain a gap, each is listed as a hypothesis and none is chosen.'] : [])
  ]
}

/**
 * The findings of one frozen scorecard, ranked: deterministic for a given snapshot (and ticket names). Statements,
 * hypotheses and contradictions name tickets by key and title when `names` knows them (the run's plan), else by id.
 */
export function deriveRetroFindings(
  snapshot: ScorecardSnapshot,
  options: { names?: TicketNames; thresholds?: RetroFindingThresholds } = {}
): RetroFindingsView {
  const thresholds = options.thresholds ?? RETRO_FINDING_THRESHOLDS
  const reading: Reading = { thresholds, name: nameOf(options.names ?? (() => null)) }
  const drafts = draftsOf(snapshot, reading)
  const contradicted = contradictions(snapshot, drafts, reading)
  const sparse = isSparse(snapshot, thresholds)
  const context: OutlineContext = { snapshot, contradicted: false, sparse }
  const findings = drafts
    .sort((a, b) => b.severity - a.severity || FINDING_KINDS.indexOf(a.kind) - FINDING_KINDS.indexOf(b.kind) || a.id.localeCompare(b.id))
    .map((draft, index) => findingOf(draft, index + 1, contradicted.filter((item) => item.findingIds.includes(draft.id)), context))
  const status = sparse ? 'insufficient_data' : findings.length === 0 ? 'no_meaningful_issue' : 'findings'
  return {
    runId: snapshot.runId,
    sprintId: snapshot.sprintId,
    reportId: snapshot.report.reportId,
    reportRevision: snapshot.report.reportRevision,
    snapshotId: snapshot.snapshotId,
    cutoff: snapshot.cutoff,
    policyHash: snapshot.policy.hash,
    status,
    findings,
    contradictions: contradicted,
    thresholds,
    notes: notesOf({ status, findings, contradictions: contradicted, thresholds }, sparse)
  }
}
