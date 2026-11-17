// A real in-memory workspace for P-input (verification and escaped defect) tests: a started run whose attempts are
// claimed, submitted and reviewed through the real attempt services, and escaped-defect records built for the real
// ledger (`recordObservations`).
import { acceptAttempt, failAttempt, rejectAttempt } from '../core/services/attempts'
import type { ObservationInput } from '../core/services/observations'
import type { CheckResult, CriterionResult } from '../shared/domain/views'
import { makeBundle, makeTicket, tid } from './bundles'
import { claim, startedRun, submitClaim } from './execution'
import { createTestCtx, type TestCtx, withRole } from './testContext'

const DEFINITION_OF_DONE = [
  { name: 'typecheck', command: 'npm run typecheck', description: 'Types' },
  { name: 'test', command: 'npm test', description: 'Unit tests' },
  { name: 'build', command: 'npm run build', description: 'Build' }
]

export const COMMIT = { build: 'b'.repeat(40), fix: 'f'.repeat(40), other: 'c'.repeat(40) }

export interface PerformanceWorld {
  ctx: TestCtx
  reviewer: TestCtx
  worker: TestCtx
  epicId: string
  runId: string
  sprintId: string
}

/**
 * Sprint 1 holds work tickets 1-5 (1 and 5 optional, so the acceptance node 6 does not wait for them) and its
 * acceptance node 6; sprint 2 holds ticket 7. Work tickets have criteria c1 and c2; the project's Definition of Done
 * is typecheck, test and build. The retry limit is 2. The clock starts at 2026-11-15T09:00:00.000Z.
 */
export function performanceWorld(): PerformanceWorld {
  const ctx = createTestCtx({ definitionOfDone: DEFINITION_OF_DONE })
  ctx.clock.set('2026-11-15T09:00:00.000Z')
  const base = makeBundle([[1, 2, 3, 4, 5, 6], [7]])
  const criteria = [
    { id: 'c1', text: 'It works' },
    { id: 'c2', text: 'It is documented' }
  ]
  const bundle = {
    ...base,
    policies: { ...base.policies, retryLimit: 2 },
    tickets: [1, 2, 3, 4, 5, 6, 7].map((n) =>
      n === 6
        ? makeTicket(6, { kind: 'acceptance', title: 'Sprint 1 acceptance', acceptanceCriteria: [{ id: 'c1', text: 'Ticket 2 verified', covers: tid(2) }] })
        : makeTicket(n, { acceptanceCriteria: criteria, optional: n === 1 || n === 5 })
    )
  }
  const run = startedRun(ctx, { bundle })
  return {
    ctx,
    reviewer: withRole(ctx, 'reviewer'),
    worker: withRole(ctx, 'worker'),
    epicId: run.epicId,
    runId: run.runId,
    sprintId: bundle.sprints[0]?.id ?? ''
  }
}

const minutes = (w: PerformanceWorld, n: number): void => w.ctx.clock.advanceSeconds(n * 60)

/** Claims and submits ticket `n` with the worker's claims (5 minutes of work, then 1); returns the attempt id. */
export function submit(w: PerformanceWorld, n: number, evidence: { checks?: CheckResult[]; criteria?: CriterionResult[] }): string {
  const claimed = claim(w.ctx, w.runId, n)
  minutes(w, 5)
  submitClaim(w.worker, claimed, { evidence: { checks: evidence.checks ?? [], criteria: evidence.criteria ?? [], notes: '' } })
  minutes(w, 1)
  return claimed.attempt.id
}

export function accept(w: PerformanceWorld, attemptId: string, criteria?: CriterionResult[]): void {
  acceptAttempt(w.reviewer, { attemptId, notes: 'reviewed', ...(criteria === undefined ? {} : { criteria }) })
  minutes(w, 1)
}

export function reject(w: PerformanceWorld, attemptId: string, reason: string): void {
  rejectAttempt(w.reviewer, { attemptId, reasons: [reason] })
  minutes(w, 1)
}

export function failClaimed(w: PerformanceWorld, n: number, reason: string): string {
  const claimed = claim(w.ctx, w.runId, n)
  minutes(w, 2)
  failAttempt(w.worker, { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken, failure: { reason, details: '', retryable: true } })
  minutes(w, 1)
  return claimed.attempt.id
}

export const met = (criterionId: string, note = 'checked'): CriterionResult => ({ criterionId, met: true, note })
export const unmet = (criterionId: string, note = 'not met'): CriterionResult => ({ criterionId, met: false, note })
export const passed = (name: string): CheckResult => ({ name, status: 'passed', detail: 'ok' })
export const failedCheck = (name: string): CheckResult => ({ name, status: 'failed', detail: '2 failing' })
export const skipped = (name: string): CheckResult => ({ name, status: 'skipped', detail: 'left to the acceptance node' })

export interface ReportFields {
  severity: string
  attribution: 'attributed' | 'candidate' | 'unassigned'
  phase?: string
  origin?: { ticket: number; attemptId?: string }
  defectKey?: string
  observationId?: string
  source?: ObservationInput['source']
  scope?: ObservationInput['scope']
  /** The source build commit; null leaves it out. */
  sourceBuild?: string | null
}

function reportEvidence(fields: ReportFields): ObservationInput['evidence'] {
  const build = fields.sourceBuild === null ? [] : [{ kind: 'commit' as const, id: fields.sourceBuild ?? COMMIT.build, detail: 'source build' }]
  const origin = fields.origin
  const ticket = origin === undefined ? [] : [{ kind: 'ticket' as const, id: tid(origin.ticket), detail: 'origin' }]
  const attempt = origin?.attemptId === undefined ? [] : [{ kind: 'attempt' as const, id: origin.attemptId, detail: 'origin' }]
  return [...build, ...ticket, ...attempt]
}

const epicScope = (w: PerformanceWorld): ObservationInput['scope'] => ({ level: 'epic', epicId: w.epicId, sprintId: null, runId: null, ticketId: null, attemptId: null })

/** A defect report recorded by a person in the desktop app, at epic scope unless `scope` says otherwise. */
export function defectReport(w: PerformanceWorld, fields: ReportFields): ObservationInput {
  return {
    ...(fields.observationId === undefined ? {} : { observationId: fields.observationId }),
    metric: 'escaped_defect',
    unit: 'count',
    scope: fields.scope ?? epicScope(w),
    source: fields.source ?? { kind: 'human', actor: 'desktop' },
    measurement: { state: 'observed', value: 1 },
    accumulation: 'event',
    sequence: null,
    observedAt: w.ctx.clock.nowIso(),
    attributes: {
      defectEvent: 'report',
      severity: fields.severity,
      attribution: fields.attribution,
      discoveryPhase: fields.phase ?? 'sprint_review',
      ...(fields.defectKey === undefined ? {} : { defectKey: fields.defectKey })
    },
    evidence: reportEvidence(fields)
  }
}

/** A person's follow-up record (duplicate, reassessment, fix, withdrawal) citing the report `defectId`. */
export function defectFollowUp(
  w: PerformanceWorld,
  event: 'duplicate' | 'reassessment' | 'fix' | 'withdrawal',
  defectId: string,
  extra: { attributes?: Record<string, string>; evidence?: ObservationInput['evidence']; observationId?: string } = {}
): ObservationInput {
  return {
    ...(extra.observationId === undefined ? {} : { observationId: extra.observationId }),
    metric: 'escaped_defect',
    unit: 'count',
    scope: epicScope(w),
    source: { kind: 'human', actor: 'desktop' },
    measurement: { state: 'observed', value: 0 },
    accumulation: 'event',
    sequence: null,
    observedAt: w.ctx.clock.nowIso(),
    attributes: { defectEvent: event, ...extra.attributes },
    evidence: [{ kind: 'observation', id: defectId, detail: 'defect' }, ...(extra.evidence ?? [])]
  }
}
