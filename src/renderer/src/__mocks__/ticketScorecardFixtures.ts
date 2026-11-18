/**
 * Test-only read models for the ticket Scorecard tab (DM-180). Each builder returns the core's shape with only the
 * fields the tab reads filled in; tests pass the numbers they assert on. Not shared with other slices.
 */
import type { AttemptUsageView, UsageCellView } from '../../../shared/domain/metrics'
import type { BaselineComparison, Measurement, SpaceComponent, SpaceComponentResult, SpaceGrade } from '../../../shared/domain/space'
import type { GradeSummary, SubjectReassessment, TicketGradeView } from '../../../shared/domain/spaceGrades'
import type { CollaborationDeduction } from '../../../shared/domain/spaceSignals'
import type { TicketTiming, TimingQuantity } from '../../../shared/domain/timing'
import type { AttemptView } from '../../../shared/domain/views'

export const FOLDER = 'C:/work/alpha'
export const EPIC = 'ep_scorecard'
export const RUN_1 = 'run_one'
export const RUN_2 = 'run_two'
export const TICKET_A = 'tk_api'
export const TICKET_B = 'tk_guide'
export const SPRINT = 'sp_one'
export const CUTOFF = '2026-03-04T10:00:00.000Z'

export function quantity(ms: number | null, patch: Partial<TimingQuantity> = {}): TimingQuantity {
  return { quantity: 'measured_active', unit: 'milliseconds', aggregation: 'union', ms, state: ms === null ? 'missing' : 'observed', coverage: 'complete', open: false, ...patch } as TimingQuantity
}

export function baseline(patch: Partial<BaselineComparison> = {}): BaselineComparison {
  return { baselineId: 'bl_tokens', kind: 'budget', value: 50_000, version: 3, frozenAt: '2026-03-01T09:00:00.000Z', sampleSize: null, refusedReason: null, ...patch } as BaselineComparison
}

export function component(key: SpaceComponent, patch: Partial<SpaceComponentResult> = {}): SpaceComponentResult {
  return {
    component: key,
    state: 'observed',
    required: key === 'P',
    score: 80,
    baseWeight: 1 / 7,
    effectiveWeight: 1 / 7,
    rule: `${key.toLowerCase()}_rule_v1`,
    missingReason: null,
    inherited: false,
    inputs: {},
    diagnostics: {},
    evidence: [],
    explanation: { normalization: `${key} normalized`, cutoff: CUTOFF, baseline: null, caps: [] },
    ...patch
  } as SpaceComponentResult
}

const KEYS: SpaceComponent[] = ['S', 'P', 'A', 'C', 'E', 'T', 'K']

export function spaceGrade(patch: Partial<SpaceGrade> = {}): SpaceGrade {
  return {
    assessmentId: null,
    policy: { policyId: 'balanced', version: 2, hash: 'sha256:0123456789abcdef0123' },
    subject: { level: 'ticket', id: TICKET_A },
    cutoff: CUTOFF,
    dispatchedAt: '2026-03-02T09:00:00.000Z',
    inputHash: 'sha256:feed',
    status: 'final',
    outcome: 'verified',
    statusReasons: [],
    score: 80,
    uncappedScore: 80,
    displayScore: '80.0',
    letter: 'B',
    coverage: 1,
    scoredComponents: 7,
    caps: [],
    components: KEYS.map((key) => component(key)),
    baselineIds: [],
    explanation: { composite: 'Σ wᵢ·scoreᵢ ÷ Σ wᵢ = 80', cap: null, letter: '80 ≥ 80 → B', status: ['Final: every required input is in.'], missing: [], rounding: {}, evidence: [] },
    ...patch
  } as unknown as SpaceGrade
}

interface AttemptRow {
  attemptId: string
  number: number
  outcome: string
  superseded?: boolean
  effortMs: number | null
}

interface TicketGradeOptions {
  runId?: string
  ticketId?: string
  grade?: SpaceGrade
  tokens?: Measurement
  tokensReported?: number | null
  time?: Measurement
  overheadMs?: number | null
  attempts?: AttemptRow[]
  retries?: number | null
  classification?: { denominator: Measurement; observationIds: string[]; correctiveMs: number | null; productiveMs: number | null; unclassifiedMs: number | null; correctiveByCause?: Record<string, number> }
  deductions?: CollaborationDeduction[]
  sprintId?: string | null
}

const TICKET_DEFAULTS: Required<TicketGradeOptions> = {
  runId: RUN_1,
  ticketId: TICKET_A,
  grade: spaceGrade(),
  tokens: { state: 'observed', value: 42_000 },
  tokensReported: 42_000,
  time: { state: 'observed', value: 750_000 },
  overheadMs: 90_000,
  attempts: [{ attemptId: 'at_1', number: 1, outcome: 'accepted', effortMs: 600_000 }],
  retries: 0,
  classification: { denominator: { state: 'observed', value: 600_000 }, observationIds: ['ob_1'], correctiveMs: 60_000, productiveMs: 540_000, unclassifiedMs: 0 },
  deductions: [],
  sprintId: SPRINT
}

/** A ticket's grade view; options left out take `TICKET_DEFAULTS` (pass a key only to change it). */
export function ticketGrade(options: TicketGradeOptions = {}): TicketGradeView {
  const o = { ...TICKET_DEFAULTS, ...options }
  return {
    runId: o.runId,
    ticketId: o.ticketId,
    cutoff: CUTOFF,
    input: {},
    grade: o.grade,
    sources: {
      signals: {
        S: { input: { ticketRating: null, sprintRating: null }, ratings: [], rescue: [], plannedReview: [], rescueMinutes: 0, plannedReviewMinutes: 0 },
        C: { deductions: o.deductions }
      },
      performance: {},
      efficiency: {
        scope: { level: 'ticket', sprintId: o.sprintId },
        tokens: { actual: o.tokens, reportedValue: o.tokensReported, unreportedAttemptIds: [], openAttemptIds: [] },
        time: { actual: o.time, overheadValue: o.overheadMs },
        classification: {
          correctiveByCause: {},
          ...o.classification,
          retries: { attempts: o.attempts.map((row) => ({ superseded: false, ...row })), retries: o.retries }
        }
      }
    },
    anomalies: []
  } as unknown as TicketGradeView
}

export function ticketTiming(ticketId: string, attempts: { attemptId: string; elapsedMs: number | null; activeMs: number | null }[]): TicketTiming {
  const waits = { queue: quantity(30_000), build_test: quantity(null), blocked: quantity(0), review: quantity(120_000), human_approval: quantity(null) }
  return {
    ticketId,
    sprintId: SPRINT,
    carriedForward: false,
    cycleTime: quantity(3_600_000),
    leadTime: quantity(3_900_000),
    waits,
    unknown: quantity(null),
    active: quantity(750_000),
    waitBeforeDispatch: quantity(300_000),
    effort: { total: quantity(840_000), byRole: { worker: 750_000, orchestrator: 0, reviewer: 90_000, other: 0 }, overhead: quantity(90_000) },
    attempts: attempts.map((attempt) => ({ attemptId: attempt.attemptId, ticketId, elapsed: quantity(attempt.elapsedMs), active: quantity(attempt.activeMs) })),
    segments: []
  } as unknown as TicketTiming
}

export function tokenCell(value: number | null, coverage: UsageCellView['coverage'] = 'observed'): UsageCellView {
  return { metric: 'tokens_total', unit: 'tokens', coverage, value } as UsageCellView
}

export function attemptUsage(attemptId: string, ticketId: string, cell: UsageCellView): AttemptUsageView {
  return { attemptId, ticketId, number: 1, state: 'accepted', usage: [cell] } as AttemptUsageView
}

function summary(letter: GradeSummary['letter'], displayScore: string | null, status: GradeSummary['status']): GradeSummary {
  return { subject: { level: 'ticket', id: TICKET_A }, assessmentId: null, status, score: null, displayScore, letter, coverage: 1, inputHash: 'h', policyHash: 'p' } as GradeSummary
}

export function subjectReassessment(patch: Partial<SubjectReassessment> = {}): SubjectReassessment {
  return {
    subject: { level: 'ticket', id: TICKET_A },
    membership: 'kept',
    approved: summary('B', '81.0', 'final'),
    sameWindow: summary('B', '80.5', 'final'),
    current: summary('C', '74.2', 'provisional'),
    windows: {
      approved: { from: '2026-03-02T09:00:00.000Z', to: '2026-03-03T09:00:00.000Z' },
      current: { from: '2026-03-02T09:00:00.000Z', to: CUTOFF },
      comparable: true,
      note: 'both windows start at the first dispatch (2026-03-02T09:00:00.000Z); the current one runs 2026-03-03T09:00:00.000Z → 2026-03-04T10:00:00.000Z longer'
    },
    differences: [],
    ...patch
  } as SubjectReassessment
}

export function attemptView(id: string, runId: string, createdAt: string, patch: Partial<AttemptView> = {}): AttemptView {
  return { id, runId, ticketId: TICKET_A, number: 1, kind: 'work', state: 'accepted', createdAt, updatedAt: createdAt, ...patch } as AttemptView
}
