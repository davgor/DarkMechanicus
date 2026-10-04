/**
 * Ticket attempts: transactional claims (lease + fencing token + secret), heartbeats, submissions,
 * review decisions, failures with the plan's failure policy, reconciliation of expired leases, and
 * carry-forward of work completed earlier.
 */
import type { ClaimTicketInput, SubmitAttemptInput } from '../../shared/domain/api'
import type { EpicBranch, ReasoningEffort, TicketContent } from '../../shared/domain/bundle'
import type { DomainErrorCode } from '../../shared/domain/errors'
import {
  isActiveRunState,
  isLeasedAttemptState,
  OPEN_ATTEMPT_STATES,
  type TicketExecutionState
} from '../../shared/domain/status'
import type {
  AssignmentFallback,
  AttemptDecision,
  AttemptEvidence,
  AttemptFailure,
  AttemptOutputs,
  AttemptView,
  Blocker,
  ClaimResultView,
  CriterionResult,
  ExecutionPacket,
  HostCatalog,
  SprintIncrement,
  TicketExecutionView,
  WorkerInfo
} from '../../shared/domain/views'
import { requireCapability } from '../authz'
import { addSeconds } from '../clock'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'
import { fail } from '../errors'
import { isAcceptanceTicket } from '../plan/acceptance'
import { matchProfile } from '../plan/capabilities'
import { LIMITS } from '../schemas'
import type { ExecutionSnapshot } from '../plan/readiness'
import { appendEvent } from './events'
import {
  advanceTicketStatus,
  type AttemptRow,
  attemptView,
  executionOf,
  expireLeases,
  guardUnique,
  insertAttempt,
  loadAttempt,
  loadBundle,
  loadHostCatalog,
  loadRunContext,
  OPEN_ATTEMPT_COLUMNS,
  recordCarryForward,
  requireRun,
  type RunContext,
  type RunRow,
  ticketOf
} from './execution'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { enqueueOutbox } from './outbox'
import { failRunRow, PAUSABLE_STATES, pauseRunRow, requireOwnedRun } from './runs'
import { indexDocument } from './searchIndex'

type OutputsInput = SubmitAttemptInput['outputs']

interface Rejection {
  code: DomainErrorCode
  message(key: string): string
}

/** Why a ticket in each non-claimable execution state cannot be claimed. */
const CLAIM_REJECTIONS: Partial<Record<TicketExecutionState, Rejection>> = {
  running: { code: 'already_claimed', message: (key) => `${key} already has an open attempt in this run.` },
  submitted: { code: 'already_claimed', message: (key) => `${key} has a submission awaiting review.` },
  accepted: { code: 'conflict', message: (key) => `${key} is already accepted in this run.` },
  waiting: { code: 'unmet_prerequisite', message: (key) => `${key} is waiting for its prerequisites to be accepted.` },
  blocked: { code: 'unmet_prerequisite', message: (key) => `${key} is blocked; see its blockers.` },
  later_sprint: { code: 'unmet_prerequisite', message: (key) => `${key} belongs to a later sprint.` },
  needs_reconciliation: {
    code: 'needs_reconciliation',
    message: (key) => `${key}'s last lease expired; reconcile that attempt before claiming it again.`
  },
  failed: { code: 'retry_limit_reached', message: (key) => `${key} has used all of its attempts in this run.` }
}

const MIN_HEARTBEAT_SECONDS = 10

const REPORTING: ExecutionPacket['reporting'] = {
  heartbeatTool: 'heartbeat_attempt',
  submitTool: 'submit_attempt',
  failTool: 'fail_attempt',
  instructions: [
    'Work only on this ticket and stay within its acceptance criteria.',
    'Call heartbeat_attempt with the claim token at least every heartbeatIntervalSeconds, or the lease expires.',
    'When finished, call submit_attempt with outputs (summary, artifacts, commits, changed files, branch) and evidence for each acceptance criterion.',
    'If you cannot finish, call fail_attempt with the reason. Submitting does not accept the work: a reviewer decides.'
  ].join(' ')
}

/** Added to an acceptance node's reporting instructions when the project has a Definition of Done. */
const DEFINITION_OF_DONE_INSTRUCTIONS =
  'This is a sprint acceptance node: run every check in definitionOfDone and report each one in the evidence.checks of submit_attempt under its exact name, with status passed, failed or skipped. The definition_of_done gate of the checkpoint is met only when the accepted attempt reports every one of them as passed.'

const EMPTY_EVIDENCE: AttemptEvidence = { checks: [], criteria: [], notes: '' }

function recordAttempt(
  ctx: Ctx,
  row: AttemptRow,
  epicId: string,
  event: { kind: string; payload?: Record<string, unknown> }
): void {
  appendEvent(ctx, {
    kind: event.kind,
    epicId,
    runId: row.run_id,
    ticketId: row.ticket_id,
    payload: { attemptId: row.id, ...event.payload }
  })
  enqueueOutbox(ctx, { kind: 'run_history', epicId, runId: row.run_id })
}

function normalizeOutputs(outputs: OutputsInput): AttemptOutputs {
  return {
    summary: outputs.summary,
    artifacts: outputs.artifacts ?? [],
    commits: outputs.commits ?? [],
    changedFiles: outputs.changedFiles ?? [],
    branch: outputs.branch ?? null
  }
}

function normalizeEvidence(evidence: Partial<AttemptEvidence> | undefined): AttemptEvidence {
  return { checks: evidence?.checks ?? [], criteria: evidence?.criteria ?? [], notes: evidence?.notes ?? '' }
}

/** Re-indexes the attempt for history search and returns its current row. */
function indexAttempt(ctx: Ctx, run: RunRow, attemptId: string): AttemptRow {
  const row = loadAttempt(ctx, attemptId)
  const view = attemptView(row)
  const ticket = loadBundle(ctx, row.revision_id).tickets.find((item) => item.id === row.ticket_id)
  indexDocument(ctx.db, {
    docType: 'attempt',
    docId: row.id,
    epicId: run.epic_id,
    runId: run.id,
    ticketId: row.ticket_id,
    title: `${ticket?.key ?? row.ticket_id} attempt #${row.number}`,
    body: [view.outputs?.summary, view.evidence?.notes, view.decision?.notes]
      .filter((part): part is string => Boolean(part))
      .join('\n\n')
  })
  return row
}

/** A ticket held back by a failed row check says so, since "waiting for its prerequisites" alone would mislead. */
function rejectionMessage(rejection: Rejection, key: string, view: TicketExecutionView): string {
  const held = view.blockers.find(
    (blocker): blocker is Extract<Blocker, { kind: 'row_check_failed' }> => blocker.kind === 'row_check_failed'
  )
  if (held === undefined) {
    return rejection.message(key)
  }
  return `${rejection.message(key)} Row ${held.row} of a prerequisite's sprint failed its row check; record a passing check with record_row_check to release it.`
}

function claimableView(snapshot: ExecutionSnapshot, ticket: TicketContent): TicketExecutionView {
  const view =
    snapshot.tickets.find((item) => item.ticketId === ticket.id) ??
    fail('not_found', `${ticket.key} is not scheduled in any sprint of the pinned plan.`, { ticketId: ticket.id })
  const rejection = CLAIM_REJECTIONS[view.state]
  if (rejection) {
    fail(rejection.code, rejectionMessage(rejection, ticket.key, view), {
      ticketId: ticket.id,
      state: view.state,
      blockers: view.blockers
    })
  }
  const capacity = view.blockers.find(
    (blocker): blocker is Extract<Blocker, { kind: 'concurrency' }> => blocker.kind === 'concurrency'
  )
  if (capacity) {
    fail('capacity_exceeded', 'The sprint is at its concurrency limit; wait for running work to finish.', {
      ticketId: ticket.id,
      limit: capacity.limit
    })
  }
  return view
}

function runCatalog(ctx: Ctx, run: RunRow): HostCatalog | null {
  return run.host_catalog_id === null ? null : (loadHostCatalog(ctx, run.host_catalog_id)?.catalog ?? null)
}

const FALLBACK_LABEL = 'Orchestrator (fallback)'

/**
 * Why the model named on a claim cannot take the ticket on the run's host catalog, or null when it
 * can (or when there is no model or catalog to check against). A claim is never refused for this:
 * the orchestrator collects the ticket instead, so a gap in the catalog cannot strand it.
 */
function assignmentFallback(ticket: TicketContent, catalog: HostCatalog | null, modelId: string | null | undefined): AssignmentFallback | null {
  if (!modelId || catalog === null) {
    return null
  }
  const match = matchProfile(ticket.capability, catalog)
  if (match.eligible.some((item) => item.modelId === modelId)) {
    return null
  }
  const reasons = match.rejected.find((item) => item.modelId === modelId)?.failures ?? [`Model "${modelId}" is not in the host catalog.`]
  return { requestedModelId: modelId, reasons }
}

/** The orchestrator, recorded as the worker of a ticket its named model could not take, with the reasons why. */
function fallbackWorker(ctx: Ctx, input: ClaimTicketInput['worker'], catalog: HostCatalog | null, why: Fallback): WorkerInfo {
  const requested = input.rationale ? ` Requested rationale: ${input.rationale}` : ''
  const rationale = `${input.label} on "${why.fallback.requestedModelId}" could not take ${why.ticketKey}: ${why.fallback.reasons.join(' ')} The orchestrator collected it.${requested}`
  return {
    sessionId: ctx.session.id,
    label: FALLBACK_LABEL,
    modelId: null,
    hostId: input.hostId ?? catalog?.hostId ?? null,
    catalogRevision: input.catalogRevision ?? catalog?.catalogRevision ?? null,
    rationale: rationale.slice(0, LIMITS.shortText),
    effort: null
  }
}

interface Fallback {
  ticketKey: string
  fallback: AssignmentFallback
}

/**
 * An effort named on a claim must be one the model declares it can run at. A model that declares no
 * efforts accepts any, and without a model or a run catalog there is nothing to check against.
 */
function checkWorkerEffort(catalog: HostCatalog | null, worker: ClaimTicketInput['worker']): void {
  const { modelId, effort } = worker
  if (!modelId || !effort || catalog === null) {
    return
  }
  const declared = catalog.models.find((model) => model.id === modelId)?.efforts ?? []
  if (declared.length > 0 && !declared.includes(effort)) {
    const message = `Model "${modelId}" does not run at "${effort}" effort; it declares ${declared.join(', ')}.`
    fail('unsupported_capability', message, { modelId, effort, declaredEfforts: declared })
  }
}

function workerInfo(ctx: Ctx, worker: ClaimTicketInput['worker'], catalog: HostCatalog | null): WorkerInfo {
  return {
    sessionId: ctx.session.id,
    label: worker.label,
    modelId: worker.modelId ?? null,
    hostId: worker.hostId ?? catalog?.hostId ?? null,
    catalogRevision: worker.catalogRevision ?? catalog?.catalogRevision ?? null,
    rationale: worker.rationale ?? null,
    effort: worker.effort ?? null
  }
}

function predecessorsOf(context: RunContext, view: TicketExecutionView): ExecutionPacket['predecessors'] {
  return view.prerequisites.map((prerequisite) => {
    const accepted = context.attempts.find((row) => row.id === prerequisite.acceptedAttemptId)
    return {
      ticketId: prerequisite.ticketId,
      key: prerequisite.key,
      title: ticketOf(context.bundle, prerequisite.ticketId).title,
      outputs: parseJson<AttemptOutputs | null>(accepted?.outputs_json, null)
    }
  })
}

interface PacketParts {
  context: RunContext
  row: AttemptRow
  view: TicketExecutionView
  secret: string
  leaseSeconds: number
  effort: ReasoningEffort | null
}

/** What a sprint acceptance node's packet adds when the project has a Definition of Done; nothing for any other ticket. */
function definitionOfDonePart(ctx: Ctx, ticket: TicketContent): Pick<ExecutionPacket, 'definitionOfDone' | 'reporting'> | undefined {
  const definition = isAcceptanceTicket(ticket) ? ctx.definitionOfDone() : []
  if (definition.length === 0) {
    return undefined
  }
  return {
    definitionOfDone: definition,
    reporting: { ...REPORTING, instructions: `${REPORTING.instructions} ${DEFINITION_OF_DONE_INSTRUCTIONS}` }
  }
}

function executionPacket(ctx: Ctx, parts: PacketParts): ExecutionPacket {
  const { context, row, view } = parts
  const sprint = context.bundle.sprints.find((item) => item.id === view.sprintId)
  const epic = ctx.db.get<{ branch_json: string | null }>('SELECT branch_json FROM epics WHERE id = ?', context.run.epic_id)
  const ticket = ticketOf(context.bundle, row.ticket_id)
  return {
    runId: context.run.id,
    attemptId: row.id,
    claimToken: `${row.id}.${parts.secret}`,
    fencingToken: row.fencing_token,
    leaseExpiresAt: row.lease_expires_at ?? '',
    heartbeatIntervalSeconds: Math.max(MIN_HEARTBEAT_SECONDS, Math.floor(parts.leaseSeconds / 3)),
    epic: {
      id: context.run.epic_id,
      title: context.bundle.epic.title,
      branch: parseJson<EpicBranch | null>(epic?.branch_json, null)
    },
    revisionId: context.run.revision_id,
    sprint: { id: view.sprintId, ordinal: sprint?.ordinal ?? 0, goal: sprint?.goal ?? '' },
    ticket,
    ticketContentHash: row.ticket_content_hash,
    effort: parts.effort,
    predecessors: predecessorsOf(context, view),
    reporting: REPORTING,
    ...definitionOfDonePart(ctx, ticket)
  }
}

function claimReadyTicket(ctx: Ctx, context: RunContext, input: ClaimTicketInput): ClaimResultView {
  const { run, bundle } = context
  const ticket = ticketOf(bundle, input.ticketId)
  const view = claimableView(executionOf(context), ticket)
  const catalog = runCatalog(ctx, run)
  const fallback = assignmentFallback(ticket, catalog, input.worker.modelId)
  if (fallback === null) {
    checkWorkerEffort(catalog, input.worker)
  }
  const worker =
    fallback === null
      ? workerInfo(ctx, input.worker, catalog)
      : fallbackWorker(ctx, input.worker, catalog, { ticketKey: ticket.key, fallback })
  const leaseSeconds = input.leaseSeconds ?? bundle.policies.leaseSeconds
  const secret = ctx.ids.secret()
  const row = insertAttempt(ctx, {
    run,
    ticket,
    kind: 'work',
    state: 'claimed',
    worker,
    claimSecret: secret,
    leaseExpiresAt: addSeconds(ctx.clock.nowIso(), leaseSeconds),
    outputs: null,
    decision: null
  })
  advanceTicketStatus(ctx, { epicId: run.epic_id, ticketId: ticket.id }, 'in_progress')
  recordAttempt(ctx, row, run.epic_id, {
    kind: 'attempt.claimed',
    payload: { number: row.number, worker: worker.label, modelId: worker.modelId, ...(fallback === null ? {} : { fallback }) }
  })
  const packetParts = { context, row, view, secret, leaseSeconds, effort: worker.effort ?? null }
  const packet = executionPacket(ctx, packetParts)
  return { attempt: attemptView(row), packet: fallback === null ? packet : { ...packet, fallback } }
}

/**
 * Claims a ready ticket in one transaction: re-computes readiness (after expiring overdue leases),
 * checks capacity and the worker model, and creates a leased attempt. The partial unique index on
 * open attempts turns a concurrent duplicate claim into `already_claimed`.
 */
export function claimTicket(ctx: Ctx, input: ClaimTicketInput): ClaimResultView {
  requireCapability(ctx.session, 'attempt.claim')
  ctx.assertBranch()
  return withIdempotency(ctx, { command: 'claimTicket', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    expireLeases(ctx, input.runId)
    const run = requireOwnedRun(ctx, input.runId)
    if (run.state !== 'running') {
      fail('run_not_active', `The run is ${run.state}; tickets can only be claimed while it is running.`, {
        runId: run.id,
        state: run.state
      })
    }
    return claimReadyTicket(ctx, loadRunContext(ctx, run.id), input)
  })
}

function tokenMatches(row: AttemptRow, token: string): boolean {
  const separator = token.indexOf('.')
  if (separator === -1 || row.claim_secret === null) {
    return false
  }
  return token.slice(0, separator) === row.id && token.slice(separator + 1) === row.claim_secret
}

/** A late write must carry this attempt's token, be its ticket's latest attempt, and hold a live lease. */
function verifyClaim(ctx: Ctx, row: AttemptRow, token: string): void {
  const details = { attemptId: row.id }
  if (!tokenMatches(row, token)) {
    fail('stale_claim', 'The claim token does not match this attempt.', details)
  }
  const latest = ctx.db.get<{ number: number }>(
    'SELECT MAX(number) AS number FROM attempts WHERE run_id = ? AND ticket_id = ?',
    row.run_id,
    row.ticket_id
  )
  if (row.superseded_at !== null || row.number < (latest?.number ?? row.number)) {
    fail('stale_claim', 'A newer attempt superseded this claim.', details)
  }
  if (row.state === 'lease_expired') {
    fail('expired_claim', 'The claim lease expired; the orchestrator must reconcile this attempt.', details)
  }
  if (!isLeasedAttemptState(row.state)) {
    fail('stale_claim', `This attempt is ${row.state}; its claim is no longer active.`, details)
  }
}

/**
 * Expires overdue leases of the attempt's run in their own transaction, so an expiry is recorded
 * even when the command that noticed it then fails with `expired_claim`.
 */
function settleLeases(ctx: Ctx, attemptId: string): void {
  const row = ctx.db.get<{ run_id: string }>('SELECT run_id FROM attempts WHERE id = ?', attemptId)
  if (row) {
    expireLeases(ctx, row.run_id)
  }
}

export function heartbeatAttempt(
  ctx: Ctx,
  input: { attemptId: string; claimToken: string; leaseSeconds?: number }
): AttemptView {
  requireCapability(ctx.session, 'attempt.heartbeat')
  settleLeases(ctx, input.attemptId)
  return ctx.db.tx(() => {
    const row = loadAttempt(ctx, input.attemptId)
    verifyClaim(ctx, row, input.claimToken)
    const now = ctx.clock.nowIso()
    const leaseSeconds = input.leaseSeconds ?? loadBundle(ctx, row.revision_id).policies.leaseSeconds
    ctx.db.run(
      "UPDATE attempts SET state = 'running', lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE id = ?",
      addSeconds(now, leaseSeconds),
      now,
      now,
      row.id
    )
    if (row.state === 'claimed') {
      recordAttempt(ctx, row, requireRun(ctx, row.run_id).epic_id, { kind: 'attempt.running' })
    }
    return attemptView(loadAttempt(ctx, row.id))
  })
}

function storeSubmission(
  ctx: Ctx,
  row: AttemptRow,
  submission: { outputs: OutputsInput; evidence?: Partial<AttemptEvidence>; increment?: SprintIncrement }
): void {
  const now = ctx.clock.nowIso()
  ctx.db.run(
    `UPDATE attempts SET state = 'submitted', outputs_json = ?, evidence_json = ?, increment_json = ?,
       submitted_at = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
    toJson(normalizeOutputs(submission.outputs)),
    toJson(normalizeEvidence(submission.evidence)),
    submission.increment === undefined ? null : toJson(submission.increment),
    now,
    now,
    row.id
  )
}

/**
 * The verdict to store with a submission that names an increment. Only a sprint's acceptance node names one,
 * and the command layer must already have verified it: an unverified increment is never stored as if it passed.
 */
function verdictOf(ctx: Ctx, row: AttemptRow, input: SubmitAttemptInput, verified: SprintIncrement | undefined): SprintIncrement | undefined {
  if (input.increment === undefined) {
    return undefined
  }
  const bundle = loadBundle(ctx, requireRun(ctx, row.run_id).revision_id)
  const ticket = ticketOf(bundle, row.ticket_id)
  if (!isAcceptanceTicket(ticket)) {
    fail('invalid_input', `${ticket.key} is a work ticket; only a sprint's acceptance node names an increment.`, {
      ticketId: ticket.id
    })
  }
  return verified ?? fail('internal', 'The increment was not verified before it was stored.', { attemptId: row.id })
}

/**
 * Worker (or orchestrator) reports results with the claim token. Submission never unlocks dependents.
 * `verified` is the server's verdict on the increment the submission names (an acceptance node's); it is
 * stored whether it passed or not, so a failed one keeps the sprint's gate unmet and says why.
 */
export function submitAttempt(ctx: Ctx, input: SubmitAttemptInput, verified?: SprintIncrement): AttemptView {
  requireCapability(ctx.session, 'attempt.submit')
  settleLeases(ctx, input.attemptId)
  return withIdempotency(ctx, { command: 'submitAttempt', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const row = loadAttempt(ctx, input.attemptId)
    verifyClaim(ctx, row, input.claimToken)
    const increment = verdictOf(ctx, row, input, verified)
    storeSubmission(ctx, row, { ...input, increment })
    const run = requireRun(ctx, row.run_id)
    const payload = increment === undefined ? undefined : { increment: { commit: increment.commit, passed: increment.passed } }
    recordAttempt(ctx, row, run.epic_id, { kind: 'attempt.submitted', payload })
    return attemptView(indexAttempt(ctx, run, row.id))
  })
}

/** A submitted attempt of a live run owned by this machine. */
function reviewable(ctx: Ctx, attemptId: string): { row: AttemptRow; run: RunRow } {
  const row = loadAttempt(ctx, attemptId)
  if (row.state !== 'submitted') {
    fail('unauthorized_transition', `Only submitted attempts can be reviewed; this attempt is ${row.state}.`, {
      attemptId,
      state: row.state
    })
  }
  const run = requireRun(ctx, row.run_id)
  if (!isActiveRunState(run.state)) {
    fail('run_not_active', `The run is ${run.state}; its submissions can no longer be decided.`, {
      runId: run.id,
      state: run.state
    })
  }
  return { row, run: requireOwnedRun(ctx, run.id) }
}

function mergeCriteria(evidence: AttemptEvidence, criteria: CriterionResult[]): AttemptEvidence {
  const incoming = new Map(criteria.map((item) => [item.criterionId, item]))
  const known = new Set(evidence.criteria.map((item) => item.criterionId))
  return {
    ...evidence,
    criteria: [
      ...evidence.criteria.map((item) => incoming.get(item.criterionId) ?? item),
      ...criteria.filter((item) => !known.has(item.criterionId))
    ]
  }
}

/** Accepts a submission: completes the ticket and unlocks its dependents. */
export function acceptAttempt(
  ctx: Ctx,
  input: { attemptId: string; notes?: string; criteria?: CriterionResult[]; idempotencyKey?: string }
): AttemptView {
  requireCapability(ctx.session, 'attempt.review')
  return withIdempotency(ctx, { command: 'acceptAttempt', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const { row, run } = reviewable(ctx, input.attemptId)
    const now = ctx.clock.nowIso()
    const decision: AttemptDecision = { outcome: 'accepted', notes: input.notes ?? '', reasons: [], decidedBy: ctx.session.label }
    const evidence = mergeCriteria(parseJson<AttemptEvidence>(row.evidence_json, EMPTY_EVIDENCE), input.criteria ?? [])
    ctx.db.run(
      "UPDATE attempts SET state = 'accepted', decision_json = ?, evidence_json = ?, decided_at = ?, updated_at = ? WHERE id = ?",
      toJson(decision),
      toJson(evidence),
      now,
      now,
      row.id
    )
    advanceTicketStatus(ctx, { epicId: run.epic_id, ticketId: row.ticket_id }, 'completed')
    recordAttempt(ctx, row, run.epic_id, { kind: 'attempt.accepted' })
    return attemptView(indexAttempt(ctx, run, row.id))
  })
}

/**
 * Applies the plan's `onTicketFailure` once the ticket has used every try (retry limit + grants):
 * `pause_run` pauses the run, `fail_run` ends it, `continue_independent` leaves it running.
 */
function applyFailurePolicy(ctx: Ctx, row: AttemptRow): void {
  const context = loadRunContext(ctx, row.run_id)
  const view = executionOf(context).tickets.find((item) => item.ticketId === row.ticket_id)
  if (view?.state !== 'failed') {
    return
  }
  const { run, bundle } = context
  const reason = `ticket_failed:${view.key}`
  if (bundle.policies.onTicketFailure === 'pause_run' && PAUSABLE_STATES.includes(run.state)) {
    pauseRunRow(ctx, run, reason)
  }
  if (bundle.policies.onTicketFailure === 'fail_run' && isActiveRunState(run.state)) {
    failRunRow(ctx, run, reason)
  }
}

/** Rejects a submission; the ticket stays retryable until it reaches its retry limit. */
export function rejectAttempt(
  ctx: Ctx,
  input: { attemptId: string; reasons: string[]; notes?: string; idempotencyKey?: string }
): AttemptView {
  requireCapability(ctx.session, 'attempt.review')
  return withIdempotency(ctx, { command: 'rejectAttempt', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const { row, run } = reviewable(ctx, input.attemptId)
    const now = ctx.clock.nowIso()
    const decision: AttemptDecision = {
      outcome: 'rejected',
      notes: input.notes ?? '',
      reasons: input.reasons,
      decidedBy: ctx.session.label
    }
    ctx.db.run(
      "UPDATE attempts SET state = 'rejected', decision_json = ?, decided_at = ?, updated_at = ? WHERE id = ?",
      toJson(decision),
      now,
      now,
      row.id
    )
    recordAttempt(ctx, row, run.epic_id, { kind: 'attempt.rejected', payload: { reasons: input.reasons } })
    applyFailurePolicy(ctx, row)
    return attemptView(indexAttempt(ctx, run, row.id))
  })
}

/** Workers must prove the claim with its token; orchestrators and reviewers may omit it. */
function verifyReporter(ctx: Ctx, row: AttemptRow, claimToken: string | undefined): void {
  if (claimToken !== undefined) {
    verifyClaim(ctx, row, claimToken)
  } else if (ctx.session.role === 'worker') {
    fail('unauthorized', 'Worker sessions must present the claim token to fail an attempt.', { attemptId: row.id })
  }
}

export function failAttempt(
  ctx: Ctx,
  input: {
    attemptId: string
    claimToken?: string
    failure: Partial<AttemptFailure> & { reason: string }
    idempotencyKey?: string
  }
): AttemptView {
  requireCapability(ctx.session, 'attempt.fail')
  settleLeases(ctx, input.attemptId)
  return withIdempotency(ctx, { command: 'failAttempt', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const row = loadAttempt(ctx, input.attemptId)
    const run = requireOwnedRun(ctx, row.run_id)
    verifyReporter(ctx, row, input.claimToken)
    if (!OPEN_ATTEMPT_STATES.includes(row.state)) {
      fail('unauthorized_transition', `Only claimed, running, or submitted attempts can fail; this attempt is ${row.state}.`, {
        attemptId: row.id,
        state: row.state
      })
    }
    const failure: AttemptFailure = {
      reason: input.failure.reason,
      details: input.failure.details ?? '',
      retryable: input.failure.retryable ?? true
    }
    ctx.db.run(
      "UPDATE attempts SET state = 'failed', failure_json = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ?",
      toJson(failure),
      ctx.clock.nowIso(),
      row.id
    )
    recordAttempt(ctx, row, run.epic_id, { kind: 'attempt.failed', payload: { reason: failure.reason } })
    applyFailurePolicy(ctx, row)
    return attemptView(loadAttempt(ctx, row.id))
  })
}

interface ReconcileInput {
  attemptId: string
  resolution: 'abandon' | 'resubmit'
  outputs?: OutputsInput
  evidence?: Partial<AttemptEvidence>
  notes?: string
}

function abandonAttempt(ctx: Ctx, target: { row: AttemptRow; run: RunRow }, input: ReconcileInput): void {
  const now = ctx.clock.nowIso()
  const failure: AttemptFailure = { reason: 'lease expired', details: input.notes ?? '', retryable: true }
  ctx.db.run(
    'UPDATE attempts SET reconciled_at = ?, failure_json = ?, updated_at = ? WHERE id = ?',
    now,
    toJson(failure),
    now,
    target.row.id
  )
}

function resubmitAttempt(ctx: Ctx, target: { row: AttemptRow; run: RunRow }, input: ReconcileInput): void {
  const outputs =
    input.outputs ?? fail('invalid_input', 'Resubmitting an expired attempt needs its outputs.', { attemptId: target.row.id })
  guardUnique(
    () => storeSubmission(ctx, target.row, { outputs, evidence: input.evidence }),
    OPEN_ATTEMPT_COLUMNS,
    () =>
      fail('conflict', 'Another attempt for this ticket is already open; abandon this one instead.', {
        attemptId: target.row.id
      })
  )
  ctx.db.run('UPDATE attempts SET reconciled_at = ? WHERE id = ?', ctx.clock.nowIso(), target.row.id)
  indexAttempt(ctx, target.run, target.row.id)
}

const RESOLUTIONS: Record<ReconcileInput['resolution'], typeof abandonAttempt> = {
  abandon: abandonAttempt,
  resubmit: resubmitAttempt
}

/**
 * Resolves an expired lease: `abandon` counts it as a used try (the failure policy applies at the
 * limit); `resubmit` records outputs the worker produced anyway as a submission awaiting review.
 */
export function reconcileAttempt(ctx: Ctx, input: ReconcileInput): AttemptView {
  requireCapability(ctx.session, 'attempt.reconcile')
  settleLeases(ctx, input.attemptId)
  return ctx.db.tx(() => {
    const row = loadAttempt(ctx, input.attemptId)
    const run = requireOwnedRun(ctx, row.run_id)
    if (!isActiveRunState(run.state)) {
      fail('run_not_active', `The run is ${run.state}; there is nothing left to reconcile.`, { runId: run.id, state: run.state })
    }
    if (row.state !== 'lease_expired' || row.reconciled_at !== null) {
      fail('conflict', 'Only an unreconciled expired attempt can be reconciled.', { attemptId: row.id, state: row.state })
    }
    RESOLUTIONS[input.resolution](ctx, { row, run }, input)
    recordAttempt(ctx, row, run.epic_id, { kind: 'attempt.reconciled', payload: { resolution: input.resolution } })
    if (input.resolution === 'abandon') {
      applyFailurePolicy(ctx, row)
    }
    return attemptView(loadAttempt(ctx, row.id))
  })
}

/** Records explicit carry-forward of a ticket completed earlier (by status or an earlier run's acceptance). */
export function carryForwardTicket(ctx: Ctx, input: { runId: string; ticketId: string; note: string }): AttemptView {
  requireCapability(ctx.session, 'attempt.carry_forward')
  return ctx.db.tx(() => {
    const run = requireOwnedRun(ctx, input.runId)
    if (!isActiveRunState(run.state)) {
      fail('run_not_active', `The run is ${run.state}; carry-forward needs an active run.`, { runId: run.id, state: run.state })
    }
    return attemptView(recordCarryForward(ctx, { run, bundle: loadBundle(ctx, run.revision_id) }, input))
  })
}
