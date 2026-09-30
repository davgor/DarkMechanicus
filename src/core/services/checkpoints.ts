import type { CheckpointMode, Criterion, PlanBundle, SprintDef } from '../../shared/domain/bundle'
import { isActiveRunState, isOpenAttemptState, type AttemptState } from '../../shared/domain/status'
import type {
  ApprovalView,
  CheckpointView,
  CriterionResult,
  EpicOutcome,
  GateCondition,
  GateConditionId,
  SprintReportView
} from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { bool, toJson } from '../db/database'
import { fail } from '../errors'
import { indexBundle, sortedSprints, ticketLabel, type BundleIndex } from '../plan/graph'
import { appendEvent } from './events'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { enqueueOutbox } from './outbox'
import { latestReport, loadBundle, loadRun, requireOwnedRun, setRunState, type RunRow } from './reports'

/** The only action an approval grant can authorize. */
const ADVANCE_ACTION = 'advance_sprint'
const HUMAN_REQUIRED = 'A person must approve this checkpoint in the desktop app'

interface AttemptRow {
  ticket_id: string
  state: AttemptState
  superseded_at: string | null
}

interface GrantRow {
  id: string
  issued_at: string
}

/** Everything the gate conditions and the authorization of the active sprint depend on. */
interface Evaluation {
  run: RunRow
  sprint: SprintDef
  /** The sprint after the active one; null on the final sprint. */
  next: SprintDef | null
  sprintCount: number
  report: SprintReportView | null
  /** Gate conditions except the authorization. */
  gates: GateCondition[]
  /** The unconsumed grant whose binding matches this exact checkpoint. */
  grant: GrantRow | null
}

interface GateInput {
  index: BundleIndex
  bundle: PlanBundle
  sprint: SprintDef
  report: SprintReportView | null
  attempts: AttemptRow[]
}

function attemptCount(count: number): string {
  return count === 1 ? '1 attempt' : `${count} attempts`
}

/** How a ticket's latest attempt keeps it from counting as accepted in this run. */
const ATTEMPT_PHRASES: Record<AttemptState, (attempts: number) => string> = {
  claimed: () => 'is claimed',
  running: () => 'is still running',
  submitted: () => 'is awaiting review',
  accepted: () => 'changed in an adopted revision and needs new work',
  rejected: (attempts) => `was rejected after ${attemptCount(attempts)}`,
  failed: (attempts) => `failed after ${attemptCount(attempts)}`,
  canceled: () => 'was canceled',
  lease_expired: () => 'needs reconciliation after its lease expired'
}

function condition(id: GateConditionId, label: string, problems: string[], metDetail: string): GateCondition {
  return problems.length === 0
    ? { id, label, met: true, detail: metDetail }
    : { id, label, met: false, detail: problems.join('; ') }
}

function reportGate(sprint: SprintDef, report: SprintReportView | null): GateCondition {
  const problems = report === null ? [`No report for Sprint ${sprint.ordinal} yet`] : []
  return condition('report_submitted', 'Sprint report submitted', problems, 'Required by checkpoint policy')
}

function leaseGate(input: GateInput): GateCondition {
  const problems = input.sprint.ticketIds.flatMap((id) =>
    input.attempts
      .filter((attempt) => attempt.ticket_id === id && isOpenAttemptState(attempt.state))
      .map((attempt) => `${ticketLabel(input.index, id)} ${ATTEMPT_PHRASES[attempt.state](0)}`)
  )
  return condition('no_active_leases', 'No worker still holds a lease', problems, 'All claims released or expired')
}

function pendingReason(key: string, attempts: AttemptRow[]): string {
  const latest = attempts.at(-1)
  return latest === undefined ? `${key} not started` : `${key} ${ATTEMPT_PHRASES[latest.state](attempts.length)}`
}

function requiredGate(input: GateInput): GateCondition {
  const required = input.sprint.ticketIds.filter((id) => input.index.tickets.get(id)?.optional !== true)
  const accepted = new Set(
    input.attempts
      .filter((attempt) => attempt.state === 'accepted' && attempt.superseded_at === null)
      .map((attempt) => attempt.ticket_id)
  )
  const problems = required
    .filter((id) => !accepted.has(id))
    .map((id) => pendingReason(ticketLabel(input.index, id), input.attempts.filter((attempt) => attempt.ticket_id === id)))
  const total = required.length
  return condition('required_accepted', 'Every required ticket accepted', problems, `${total} of ${total} required tickets accepted`)
}

function noteSuffix(note: string): string {
  return note === '' ? '' : `: ${note}`
}

/** Criteria that are not reported, or reported unmet (any unmet entry counts). */
function criteriaProblems(criteria: Criterion[], results: CriterionResult[]): string[] {
  return criteria.flatMap((criterion) => {
    const reported = results.filter((result) => result.criterionId === criterion.id)
    const unmet = reported.find((result) => !result.met)
    if (reported.length === 0) {
      return [`${criterion.id} "${criterion.text}" not reported`]
    }
    return unmet === undefined ? [] : [`${criterion.id} "${criterion.text}" not met${noteSuffix(unmet.note)}`]
  })
}

function metCount(count: number, noun: string, none: string): string {
  return count === 0 ? none : `${count} of ${count} ${noun}`
}

function exitGate(sprint: SprintDef, report: SprintReportView | null): GateCondition {
  const criteria = sprint.exitCriteria
  const problems = criteriaProblems(criteria, report === null ? [] : report.report.exitCriteria)
  const metDetail = metCount(criteria.length, 'exit criteria reported met', 'This sprint has no exit criteria')
  return condition('exit_criteria', 'Exit criteria reported met', problems, metDetail)
}

function outcomeGate(bundle: PlanBundle, report: SprintReportView | null): GateCondition {
  const outcome = report === null ? null : report.report.epicOutcome
  const criteria = bundle.epic.successCriteria
  const problems =
    outcome === null
      ? ['The final sprint report must include the epic outcome']
      : criteriaProblems(criteria, outcome.successCriteria)
  const metDetail = metCount(criteria.length, 'success criteria met', 'Epic outcome recorded')
  return condition('epic_outcome', 'Epic success criteria met', problems, metDetail)
}

function evaluateGates(input: GateInput, isFinal: boolean): GateCondition[] {
  const gates = [reportGate(input.sprint, input.report), leaseGate(input), requiredGate(input), exitGate(input.sprint, input.report)]
  return isFinal ? [...gates, outcomeGate(input.bundle, input.report)] : gates
}

function activeSprintIndex(run: RunRow, sprints: SprintDef[]): number {
  const index = sprints.findIndex((sprint) => sprint.id === run.active_sprint_id)
  if (index < 0) {
    fail('run_not_active', `Run #${run.number} has no active sprint.`, { runId: run.id })
  }
  return index
}

/** The newest unconsumed grant bound to exactly this project, epic, run, revision, sprint, and report. */
function findGrant(ctx: Ctx, run: RunRow, sprint: SprintDef, report: SprintReportView): GrantRow | null {
  const grant = ctx.db.get<GrantRow>(
    `SELECT id, issued_at FROM approvals
     WHERE project_id = ? AND epic_id = ? AND run_id = ? AND revision_id = ? AND sprint_id = ?
       AND report_id = ? AND report_hash = ? AND action = ? AND consumed_at IS NULL
     ORDER BY issued_at DESC, id DESC LIMIT 1`,
    ctx.projectId,
    run.epic_id,
    run.id,
    run.revision_id,
    sprint.id,
    report.id,
    report.contentHash,
    ADVANCE_ACTION
  )
  return grant ?? null
}

function evaluate(ctx: Ctx, run: RunRow): Evaluation {
  const bundle = loadBundle(ctx, run.revision_id)
  const sprints = sortedSprints(bundle)
  const index = activeSprintIndex(run, sprints)
  const sprint = sprints[index]
  const next = sprints[index + 1] ?? null
  const report = latestReport(ctx, run.id, sprint.id)
  const attempts = ctx.db.all<AttemptRow>(
    'SELECT ticket_id, state, superseded_at FROM attempts WHERE run_id = ? ORDER BY ticket_id, number',
    run.id
  )
  const gates = evaluateGates({ index: indexBundle(bundle), bundle, sprint, report, attempts }, next === null)
  const grant = report === null ? null : findGrant(ctx, run, sprint, report)
  return { run, sprint, next, sprintCount: sprints.length, report, gates, grant }
}

/** `auto` only takes effect when the person authorized automatic continuation on this run. */
function autoAuthorized(evaluation: Evaluation): boolean {
  return evaluation.sprint.checkpoint.mode === 'auto' && evaluation.run.auto_continue === 1
}

function authorizationDetail(evaluation: Evaluation): string {
  if (evaluation.sprint.checkpoint.mode === 'human') {
    return HUMAN_REQUIRED
  }
  return autoAuthorized(evaluation)
    ? 'Automatic continuation authorized for this run'
    : 'Automatic continuation requested by the plan but not authorized for this run'
}

function authorizationCondition(evaluation: Evaluation): GateCondition {
  const detail = evaluation.grant === null ? authorizationDetail(evaluation) : 'Approved in the desktop app'
  const met = evaluation.grant !== null || autoAuthorized(evaluation)
  return { id: 'approval', label: 'Advance authorized', met, detail }
}

function checkpointView(evaluation: Evaluation): CheckpointView {
  const { run, sprint, grant } = evaluation
  const authorization = authorizationCondition(evaluation)
  const gatesMet = evaluation.gates.every((gate) => gate.met)
  return {
    runId: run.id,
    sprintId: sprint.id,
    sprintOrdinal: sprint.ordinal,
    sprintCount: evaluation.sprintCount,
    isFinalSprint: evaluation.next === null,
    policy: sprint.checkpoint.mode,
    autoContinueAuthorized: run.auto_continue === 1,
    report: evaluation.report,
    conditions: [...evaluation.gates, authorization],
    gatesMet,
    canAdvance: gatesMet && authorization.met && run.state === 'awaiting_checkpoint',
    approval: grant === null ? null : { id: grant.id, issuedAt: grant.issued_at, valid: true }
  }
}

/** Gate conditions and authorization for the run's active sprint. */
export function getCheckpoint(ctx: Ctx, input: { runId: string }): CheckpointView {
  requireCapability(ctx.session, 'read')
  return checkpointView(evaluate(ctx, loadRun(ctx, input.runId)))
}

function requireGatesMet(evaluation: Evaluation): SprintReportView {
  const unmet = evaluation.gates.filter((gate) => !gate.met)
  if (evaluation.report === null || unmet.length > 0) {
    fail(
      'gate_blocked',
      `Sprint ${evaluation.sprint.ordinal} can't advance yet: ${unmet.map((gate) => gate.detail).join('; ')}`,
      { conditions: evaluation.gates }
    )
  }
  return evaluation.report
}

function issueGrant(ctx: Ctx, evaluation: Evaluation, report: SprintReportView): ApprovalView {
  const { run, sprint } = evaluation
  const approval = { id: ctx.ids.next('approval'), runId: run.id, sprintId: sprint.id, reportId: report.id, issuedAt: ctx.clock.nowIso() }
  ctx.db.run(
    `INSERT INTO approvals (id, project_id, epic_id, run_id, revision_id, sprint_id, report_id, report_hash, action,
       issued_by, issued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    approval.id,
    ctx.projectId,
    run.epic_id,
    run.id,
    run.revision_id,
    sprint.id,
    report.id,
    report.contentHash,
    ADVANCE_ACTION,
    ctx.session.id,
    approval.issuedAt
  )
  return approval
}

/**
 * Desktop only: issues a one-use grant bound to this exact checkpoint (project, epic, run, pinned
 * revision, sprint, report id and hash, action). Grants are machine-local and never exported.
 */
export function approveCheckpoint(ctx: Ctx, input: { runId: string; reportId: string }): ApprovalView {
  requireCapability(ctx.session, 'checkpoint.approve')
  return ctx.db.tx(() => {
    const run = loadRun(ctx, input.runId)
    if (run.state !== 'awaiting_checkpoint') {
      fail('run_not_active', `Run #${run.number} is ${run.state}; only a run awaiting its checkpoint can be approved.`, {
        runId: run.id,
        state: run.state
      })
    }
    const evaluation = evaluate(ctx, run)
    if (evaluation.report === null || evaluation.report.id !== input.reportId) {
      fail('conflict', 'The report changed; review the latest revision.', {
        reportId: input.reportId,
        latestReportId: evaluation.report === null ? null : evaluation.report.id
      })
    }
    requireGatesMet(evaluation)
    const approval = issueGrant(ctx, evaluation, evaluation.report)
    appendEvent(ctx, {
      kind: 'checkpoint.approved',
      epicId: run.epic_id,
      runId: run.id,
      payload: { approvalId: approval.id, sprintId: approval.sprintId, reportId: approval.reportId }
    })
    return approval
  })
}

export interface AdvanceResult {
  runId: string
  outcome: 'advanced' | 'completed'
  activeSprintId: string | null
}

interface Decision {
  policy: CheckpointMode
  approvalId: string | null
}

/** A matching grant is consumed in the advancing transaction; otherwise only authorized `auto` passes. */
function authorize(ctx: Ctx, evaluation: Evaluation): Decision {
  const { grant } = evaluation
  if (grant !== null) {
    ctx.db.run('UPDATE approvals SET consumed_at = ?, consumed_by = ? WHERE id = ?', ctx.clock.nowIso(), ctx.session.id, grant.id)
    return { policy: 'human', approvalId: grant.id }
  }
  if (autoAuthorized(evaluation)) {
    return { policy: 'auto', approvalId: null }
  }
  return fail('approval_required', `${HUMAN_REQUIRED}.`, {
    runId: evaluation.run.id,
    sprintId: evaluation.sprint.id,
    policy: evaluation.sprint.checkpoint.mode
  })
}

interface Step {
  evaluation: Evaluation
  report: SprintReportView
  decision: Decision
}

function recordCheckpoint(ctx: Ctx, step: Step, outcome: AdvanceResult['outcome']): string {
  const id = ctx.ids.next('checkpoint')
  ctx.db.run(
    `INSERT INTO checkpoints (id, run_id, sprint_id, report_id, outcome, policy, approval_id, decided_by, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    step.evaluation.run.id,
    step.evaluation.sprint.id,
    step.report.id,
    outcome,
    step.decision.policy,
    step.decision.approvalId,
    ctx.session.id,
    ctx.clock.nowIso()
  )
  return id
}

function moveToSprint(ctx: Ctx, step: Step, next: SprintDef): AdvanceResult {
  const { run, sprint } = step.evaluation
  const checkpointId = recordCheckpoint(ctx, step, 'advanced')
  ctx.db.run(
    `UPDATE runs SET active_sprint_id = ?, state = 'running', updated_at = ?, revision = revision + 1 WHERE id = ?`,
    next.id,
    ctx.clock.nowIso(),
    run.id
  )
  appendEvent(ctx, {
    kind: 'checkpoint.advanced',
    epicId: run.epic_id,
    runId: run.id,
    payload: { checkpointId, fromSprintId: sprint.id, toSprintId: next.id, ...step.decision }
  })
  return { runId: run.id, outcome: 'advanced', activeSprintId: next.id }
}

function completeEpic(ctx: Ctx, run: RunRow, report: SprintReportView): void {
  const now = ctx.clock.nowIso()
  const reported = report.report.epicOutcome ?? { summary: '', successCriteria: [] }
  const outcome: EpicOutcome = { summary: reported.summary, successCriteria: reported.successCriteria, recordedAt: now, runId: run.id }
  ctx.db.run(
    `UPDATE epics SET status = 'completed', completed_at = ?, outcome_json = ?, revision = revision + 1, updated_at = ?
     WHERE id = ?`,
    now,
    toJson(outcome),
    now,
    run.epic_id
  )
}

/** Final sprint: the run and the epic complete together, recording the reported epic outcome. */
function completeRun(ctx: Ctx, step: Step): AdvanceResult {
  const { run, sprint } = step.evaluation
  const now = ctx.clock.nowIso()
  const checkpointId = recordCheckpoint(ctx, step, 'completed')
  ctx.db.run(
    `UPDATE runs SET state = 'completed', active_sprint_id = NULL, ended_at = ?, updated_at = ?, revision = revision + 1
     WHERE id = ?`,
    now,
    now,
    run.id
  )
  completeEpic(ctx, run, step.report)
  appendEvent(ctx, { kind: 'run.completed', epicId: run.epic_id, runId: run.id, payload: { checkpointId, sprintId: sprint.id } })
  appendEvent(ctx, { kind: 'epic.completed', epicId: run.epic_id, runId: run.id, payload: { runId: run.id } })
  enqueueOutbox(ctx, { kind: 'epic_state', epicId: run.epic_id })
  return { runId: run.id, outcome: 'completed', activeSprintId: null }
}

function advanceMessage(run: RunRow): string {
  return run.state === 'running'
    ? 'Submit the sprint report before advancing.'
    : `Run #${run.number} is ${run.state}; only a run awaiting its checkpoint can advance.`
}

function advance(ctx: Ctx, runId: string): AdvanceResult {
  const run = loadRun(ctx, runId)
  requireOwnedRun(ctx, run)
  if (run.state !== 'awaiting_checkpoint') {
    fail('run_not_active', advanceMessage(run), { runId: run.id, state: run.state })
  }
  const evaluation = evaluate(ctx, run)
  const report = requireGatesMet(evaluation)
  const step = { evaluation, report, decision: authorize(ctx, evaluation) }
  enqueueOutbox(ctx, { kind: 'run_history', epicId: run.epic_id, runId: run.id })
  return evaluation.next === null ? completeRun(ctx, step) : moveToSprint(ctx, step, evaluation.next)
}

/**
 * Moves the run past its checkpoint: requires every gate, then consumes the exact matching grant
 * (human policy) or the run's auto-continue authorization (auto policy) in the same transaction.
 * The final sprint completes the run and the epic. A repeated idempotency key returns the original outcome.
 */
export function advanceSprint(ctx: Ctx, input: { runId: string; idempotencyKey?: string }): AdvanceResult {
  requireCapability(ctx.session, 'checkpoint.advance')
  ctx.assertBranch()
  const scope = { command: 'advanceSprint', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => advance(ctx, input.runId))
}

/** The desktop's single click: issue and consume a grant atomically. */
export function approveAndAdvance(
  ctx: Ctx,
  input: { runId: string; reportId: string; idempotencyKey?: string }
): AdvanceResult {
  requireCapability(ctx.session, 'checkpoint.approve')
  requireCapability(ctx.session, 'checkpoint.advance')
  ctx.assertBranch()
  const scope = { command: 'approveAndAdvance', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => {
    approveCheckpoint(ctx, { runId: input.runId, reportId: input.reportId })
    return advanceSprint(ctx, { runId: input.runId })
  })
}

function requireActiveRun(ctx: Ctx, runId: string): RunRow {
  const run = loadRun(ctx, runId)
  if (!isActiveRunState(run.state)) {
    fail('run_not_active', `Run #${run.number} is ${run.state}.`, { runId: run.id, state: run.state })
  }
  return run
}

/** Desktop only: the run-local authorization that lets `auto` checkpoints advance. Never exported. */
export function authorizeAutoContinue(ctx: Ctx, input: { runId: string; enabled: boolean }): void {
  requireCapability(ctx.session, 'run.authorize_auto')
  ctx.db.tx(() => {
    const run = requireActiveRun(ctx, input.runId)
    ctx.db.run('UPDATE runs SET auto_continue = ?, updated_at = ? WHERE id = ?', bool(input.enabled), ctx.clock.nowIso(), run.id)
    appendEvent(ctx, {
      kind: 'run.auto_continue_changed',
      epicId: run.epic_id,
      runId: run.id,
      payload: { enabled: input.enabled }
    })
  })
}

/** Desktop only: one more attempt for a ticket in this run; a run waiting at its checkpoint resumes. */
export function grantRetry(ctx: Ctx, input: { runId: string; ticketId: string }): void {
  requireCapability(ctx.session, 'ticket.retry_grant')
  ctx.db.tx(() => {
    const run = requireActiveRun(ctx, input.runId)
    if (!loadBundle(ctx, run.revision_id).tickets.some((ticket) => ticket.id === input.ticketId)) {
      fail('not_found', `Ticket ${input.ticketId} is not part of this run's plan revision.`, { ticketId: input.ticketId })
    }
    ctx.db.run(
      `INSERT INTO retry_grants (run_id, ticket_id, extra) VALUES (?, ?, 1)
       ON CONFLICT (run_id, ticket_id) DO UPDATE SET extra = extra + 1`,
      run.id,
      input.ticketId
    )
    if (run.state === 'awaiting_checkpoint') {
      setRunState(ctx, run.id, 'running')
    }
    const grant = ctx.db.get<{ extra: number }>(
      'SELECT extra FROM retry_grants WHERE run_id = ? AND ticket_id = ?',
      run.id,
      input.ticketId
    )
    appendEvent(ctx, {
      kind: 'ticket.retry_granted',
      epicId: run.epic_id,
      runId: run.id,
      ticketId: input.ticketId,
      payload: { extra: grant?.extra ?? 1 }
    })
    enqueueOutbox(ctx, { kind: 'run_history', epicId: run.epic_id, runId: run.id })
  })
}
