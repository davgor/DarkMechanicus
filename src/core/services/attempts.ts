/**
 * Ticket attempts: transactional claims (lease + fencing token + secret), heartbeats, submissions,
 * review decisions, failures with the plan's failure policy, reconciliation of expired leases, and
 * carry-forward of work completed earlier.
 */
import { join } from 'node:path'
import type { ClaimTicketInput, HeartbeatAttemptInput, SubmitAttemptInput } from '../../shared/domain/api'
import type { EpicBranch, ReasoningEffort, TicketContent } from '../../shared/domain/bundle'
import type { DomainErrorCode } from '../../shared/domain/errors'
import {
  type AttemptState,
  isActiveRunState,
  isLeasedAttemptState,
  OPEN_ATTEMPT_STATES,
  ORCHESTRATOR_FALLBACK_LABEL,
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
  PacketRepository,
  SprintIncrement,
  TicketExecutionView,
  WorkerInfo
} from '../../shared/domain/views'
import { requireCapability } from '../authz'
import { CLAIM_TOKEN_MASK, maskClaimTokens } from '../claimTokenMask'
import { addSeconds } from '../clock'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'
import { fail } from '../errors'
import { isAcceptanceTicket } from '../plan/acceptance'
import { matchProfile } from '../plan/capabilities'
import { LIMITS } from '../schemas'
import type { ExecutionSnapshot } from '../plan/readiness'
import { appendEvent, appendProgressNote } from './events'
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
import { isRepositoryFolder } from './epicBranches'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { incrementRefusal, touchedRepositories } from './increments'
import { enqueueOutbox } from './outbox'
import { failRunRow, leaseTimeGivenBack, PAUSABLE_STATES, pauseRunRow, requireOwnedRun } from './runs'
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

/** How often a claim holder heartbeats: a third of its lease, but never more often than every 10 seconds. */
export function heartbeatIntervalSeconds(leaseSeconds: number): number {
  return Math.max(MIN_HEARTBEAT_SECONDS, Math.floor(leaseSeconds / 3))
}

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

/** In a folder of repositories, added instead when a touched repository has a Definition of Done. */
const REPOSITORY_DEFINITION_OF_DONE_INSTRUCTIONS =
  'This is a sprint acceptance node: in each entry of repositories, run every check in its definitionOfDone in that repository and report each one in the evidence.checks of submit_attempt as "<repository name>: <check name>" (for example "api: lint"), with status passed, failed or skipped. The definition_of_done gate of the checkpoint is met only when the accepted attempt reports every one of them as passed.'

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

export function normalizeOutputs(outputs: OutputsInput): AttemptOutputs {
  return {
    summary: outputs.summary,
    artifacts: outputs.artifacts ?? [],
    commits: outputs.commits ?? [],
    changedFiles: outputs.changedFiles ?? [],
    branch: outputs.branch ?? null
  }
}

export function normalizeEvidence(evidence: Partial<AttemptEvidence> | undefined): AttemptEvidence {
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
    label: ORCHESTRATOR_FALLBACK_LABEL,
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
  /** The packet's repository fields: from `repositoryPart`, computed before the attempt is made. */
  repositories: RepositoryPart | undefined
}

type RepositoryPart = Pick<ExecutionPacket, 'repository' | 'repositories'>

/** Repository `name` of the folder with its path and bound epic branch, refusing a claim when it is missing or unbound. */
function packetRepository(ctx: Ctx, bound: EpicBranch[], name: string, ticketKey: string): PacketRepository {
  const entry = ctx.repositoryEntries()?.find((candidate) => candidate.name === name)
  if (entry === undefined || entry.missing === true) {
    fail('invalid_input', `${ticketKey} targets repository ${JSON.stringify(name)}, which is missing from this project.`, {
      ticketKey,
      repository: name
    })
  }
  const branch =
    bound.find((candidate) => candidate.repository === name) ??
    fail('invalid_input', `${ticketKey} targets repository ${JSON.stringify(name)}, which has no epic branch bound.`, {
      ticketKey,
      repository: name
    })
  return { name, path: join(ctx.projectRoot, name), branch }
}

/** The touched repositories of an acceptance node's sprint, each with its own Definition of Done when it has one. */
function acceptanceRepositories(ctx: Ctx, bound: EpicBranch[], sprintId: string, ticketKey: string): PacketRepository[] {
  const entries = ctx.repositoryEntries() ?? []
  return touchedRepositories(ctx, sprintId).map((name) => {
    const repository = packetRepository(ctx, bound, name, ticketKey)
    const definitionOfDone = entries.find((entry) => entry.name === name)?.definitionOfDone ?? []
    return definitionOfDone.length === 0 ? repository : { ...repository, definitionOfDone }
  })
}

/**
 * In a folder of repositories, the repository a work ticket targets, or the touched repositories of an acceptance
 * node's sprint; nothing for a single repository. Refuses (`invalid_input`) a work ticket that names no repository,
 * or whose repository is missing or unbound, so no packet goes out without a path.
 */
function repositoryPart(ctx: Ctx, epicId: string, ticket: TicketContent, sprintId: string): RepositoryPart | undefined {
  if (!isRepositoryFolder(ctx)) {
    return undefined
  }
  const row = ctx.db.get<{ repository_branches_json: string | null }>('SELECT repository_branches_json FROM epics WHERE id = ?', epicId)
  const bound = parseJson<EpicBranch[]>(row?.repository_branches_json, [])
  if (isAcceptanceTicket(ticket)) {
    return { repositories: acceptanceRepositories(ctx, bound, sprintId, ticket.key) }
  }
  if (ticket.repo === undefined) {
    fail('invalid_input', `${ticket.key} names no repository; a work ticket in a folder of repositories must target one.`, {
      ticketKey: ticket.key
    })
  }
  return { repository: packetRepository(ctx, bound, ticket.repo, ticket.key) }
}

/** The instruction for the Definition of Done an acceptance node carries: the project's, its repositories', or none. */
function definitionOfDoneLines(definitionOfDone: readonly unknown[], repositories: PacketRepository[] | undefined): string[] {
  if (definitionOfDone.length > 0) {
    return [DEFINITION_OF_DONE_INSTRUCTIONS]
  }
  return repositories?.some((repository) => repository.definitionOfDone !== undefined) === true ? [REPOSITORY_DEFINITION_OF_DONE_INSTRUCTIONS] : []
}

/**
 * The worker's reporting text, plus what an acceptance node's Definition of Done or a work ticket's repository
 * adds, and the project's Definition of Done for the packet. That list belongs to a single repository's sprint
 * acceptance node only: a folder of repositories (`repositories` defined) has none of its own, and its node's
 * `repositories` entries carry theirs instead.
 */
function reportingPart(ctx: Ctx, ticket: TicketContent, repositories: RepositoryPart | undefined): Pick<ExecutionPacket, 'reporting' | 'definitionOfDone'> {
  const definitionOfDone = isAcceptanceTicket(ticket) && repositories === undefined ? ctx.definitionOfDone() : []
  const lines = [REPORTING.instructions, ...definitionOfDoneLines(definitionOfDone, repositories?.repositories)]
  const repository = repositories?.repository
  if (repository !== undefined) {
    lines.push(`Work only in a worktree of repository.path (${repository.path}), on that repository's branch ${repository.branch.name}.`)
  }
  return {
    reporting: lines.length === 1 ? REPORTING : { ...REPORTING, instructions: lines.join(' ') },
    ...(definitionOfDone.length === 0 ? {} : { definitionOfDone })
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
    heartbeatIntervalSeconds: heartbeatIntervalSeconds(parts.leaseSeconds),
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
    ...reportingPart(ctx, ticket, parts.repositories),
    ...parts.repositories
  }
}

function claimReadyTicket(ctx: Ctx, context: RunContext, input: ClaimTicketInput): ClaimResultView {
  const { run, bundle } = context
  const ticket = ticketOf(bundle, input.ticketId)
  const view = claimableView(executionOf(context), ticket)
  const repositories = repositoryPart(ctx, run.epic_id, ticket, view.sprintId)
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
    leaseSeconds,
    outputs: null,
    evidence: null,
    increment: null,
    decision: null
  })
  advanceTicketStatus(ctx, { epicId: run.epic_id, ticketId: ticket.id }, 'in_progress')
  recordAttempt(ctx, row, run.epic_id, {
    kind: 'attempt.claimed',
    payload: { number: row.number, worker: worker.label, modelId: worker.modelId, ...(fallback === null ? {} : { fallback }) }
  })
  const packetParts = { context, row, view, secret, leaseSeconds, effort: worker.effort ?? null, repositories }
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

/** What a claim check reads of an attempt: a plan ticket's or a Kanban card's. */
interface HeldClaim {
  id: string
  claimSecret: string | null
  state: AttemptState
  /** A newer attempt of the same ticket or card took this one's place. */
  superseded: boolean
}

function tokenMatches(claim: HeldClaim, token: string): boolean {
  const separator = token.indexOf('.')
  if (separator === -1 || claim.claimSecret === null) {
    return false
  }
  return token.slice(0, separator) === claim.id && token.slice(separator + 1) === claim.claimSecret
}

/**
 * A late write must carry the attempt's token (`<attemptId>.<secret>`), be its latest attempt, and hold a live
 * lease. `expired` tells the writer what follows an expired lease.
 */
export function verifyClaimToken(claim: HeldClaim, token: string, expired: string): void {
  const details = { attemptId: claim.id }
  if (!tokenMatches(claim, token)) {
    fail('stale_claim', 'The claim token does not match this attempt.', details)
  }
  if (claim.superseded) {
    fail('stale_claim', 'A newer attempt superseded this claim.', details)
  }
  if (claim.state === 'lease_expired') {
    fail('expired_claim', expired, details)
  }
  if (!isLeasedAttemptState(claim.state)) {
    fail('stale_claim', `This attempt is ${claim.state}; its claim is no longer active.`, details)
  }
}

/** A plan attempt's claim is superseded when it was marked so, or when its ticket has a later attempt in the run. */
function verifyClaim(ctx: Ctx, row: AttemptRow, token: string): void {
  const latest = ctx.db.get<{ number: number }>(
    'SELECT MAX(number) AS number FROM attempts WHERE run_id = ? AND ticket_id = ?',
    row.run_id,
    row.ticket_id
  )
  const superseded = row.superseded_at !== null || row.number < (latest?.number ?? row.number)
  verifyClaimToken(
    { id: row.id, claimSecret: row.claim_secret, state: row.state, superseded },
    token,
    'The claim lease expired; the orchestrator must reconcile this attempt.'
  )
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

/**
 * Free text a claim holder sends (a progress note) is masked before it is stored: the claim token it proved (any
 * shape), and anything else shaped like a plan attempt's token.
 */
export function maskNote(text: string, claimToken: string): string {
  return maskClaimTokens(text.split(claimToken).join(CLAIM_TOKEN_MASK))
}

function recordProgress(
  ctx: Ctx,
  row: AttemptRow,
  claimToken: string,
  progress: NonNullable<HeartbeatAttemptInput['progress']>
): void {
  appendProgressNote(ctx, {
    attemptId: row.id,
    epicId: requireRun(ctx, row.run_id).epic_id,
    runId: row.run_id,
    ticketId: row.ticket_id,
    note: maskNote(progress.note, claimToken),
    step: progress.step === undefined ? undefined : maskNote(progress.step, claimToken)
  })
}

/**
 * The length of the lease the attempt holds, in whole seconds: what its claim or its last heartbeat granted, read
 * back as the time from that grant to the lease's end, less the time resumes gave back since. Null when the attempt
 * holds no lease or the length does not come out positive.
 */
function heldLeaseSeconds(ctx: Ctx, row: AttemptRow): number | null {
  if (row.lease_expires_at === null) {
    return null
  }
  const grantedAt = row.heartbeat_at ?? row.created_at
  const grantedMs = Date.parse(row.lease_expires_at) - Date.parse(grantedAt) - leaseTimeGivenBack(ctx, row, grantedAt)
  const seconds = Math.round(grantedMs / 1000)
  return seconds > 0 ? seconds : null
}

/**
 * Extends the claim's lease from now by `leaseSeconds`, or without it by the length of the lease the claim holds,
 * so a claim made longer than the plan default keeps that length. The plan default is the last resort.
 */
export function heartbeatAttempt(ctx: Ctx, input: HeartbeatAttemptInput): AttemptView {
  requireCapability(ctx.session, 'attempt.heartbeat')
  settleLeases(ctx, input.attemptId)
  return ctx.db.tx(() => {
    const row = loadAttempt(ctx, input.attemptId)
    verifyClaim(ctx, row, input.claimToken)
    const now = ctx.clock.nowIso()
    const leaseSeconds =
      input.leaseSeconds ?? heldLeaseSeconds(ctx, row) ?? loadBundle(ctx, row.revision_id).policies.leaseSeconds
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
    if (input.progress !== undefined) {
      recordProgress(ctx, row, input.claimToken, input.progress)
    }
    return attemptView(loadAttempt(ctx, row.id))
  })
}

function storeSubmission(
  ctx: Ctx,
  row: AttemptRow,
  submission: { outputs: OutputsInput; evidence?: Partial<AttemptEvidence>; increment?: SubmittedIncrement }
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

/** What a submission stores in `increment_json`: one verdict for a single repository, one per touched repository for a folder. */
type SubmittedIncrement = SprintIncrement | SprintIncrement[]

/**
 * The verdict to store with a submission that names an increment (or a folder of repositories' increments). Only a
 * sprint's acceptance node names one, in the shape the project takes (`incrementRefusal`), and the command layer must
 * already have verified it: an unverified increment is never stored as if it passed.
 */
function verdictOf(ctx: Ctx, row: AttemptRow, input: SubmitAttemptInput, verified: SubmittedIncrement | undefined): SubmittedIncrement | undefined {
  if (input.increment === undefined && input.increments === undefined) {
    return undefined
  }
  const bundle = loadBundle(ctx, requireRun(ctx, row.run_id).revision_id)
  const ticket = ticketOf(bundle, row.ticket_id)
  if (!isAcceptanceTicket(ticket)) {
    fail('invalid_input', `${ticket.key} is a work ticket; only a sprint's acceptance node names an increment.`, {
      ticketId: ticket.id
    })
  }
  const sprint = bundle.sprints.find((item) => item.ticketIds.includes(ticket.id))
  const refusal = sprint === undefined ? null : incrementRefusal(ctx, sprint.id, input)
  if (refusal !== null) {
    fail('invalid_input', `${ticket.key}: ${refusal.message}`, { ticketId: ticket.id, ...refusal.details })
  }
  return verifiedAsNamed(input, verified) ?? fail('internal', 'The increment was not verified before it was stored.', { attemptId: row.id })
}

/**
 * `verified` when it answers what the submission named: a single repository's one verdict, or a verdict for every
 * named repository and only those, in name order. Undefined otherwise.
 */
function verifiedAsNamed(input: SubmitAttemptInput, verified: SubmittedIncrement | undefined): SubmittedIncrement | undefined {
  if (input.increments === undefined) {
    return Array.isArray(verified) ? undefined : verified
  }
  const repos = input.increments.map((item) => item.repo).sort()
  const matches = Array.isArray(verified) && verified.length === repos.length && verified.every((verdict, index) => verdict.repo === repos[index])
  return matches ? verified : undefined
}

/** The submitted event's summary of the stored verdict: each repository's commit and outcome for a folder of repositories. */
function submittedPayload(increment: SubmittedIncrement | undefined): Record<string, unknown> | undefined {
  if (increment === undefined) {
    return undefined
  }
  if (!Array.isArray(increment)) {
    return { increment: { commit: increment.commit, passed: increment.passed } }
  }
  return {
    increments: increment.map((verdict) => ({ repo: verdict.repo, commit: verdict.commit, passed: verdict.passed })),
    passed: increment.every((verdict) => verdict.passed)
  }
}

/**
 * Worker (or orchestrator) reports results with the claim token. Submission never unlocks dependents.
 * `verified` is the server's verdict on the increment the submission names (an acceptance node's), or each touched
 * repository's in a folder of repositories; it is stored whether it passed or not, so a failed one keeps the sprint's
 * gate unmet and says why (one failed repository fails the node's increment).
 */
export function submitAttempt(ctx: Ctx, input: SubmitAttemptInput, verified?: SubmittedIncrement): AttemptView {
  requireCapability(ctx.session, 'attempt.submit')
  settleLeases(ctx, input.attemptId)
  return withIdempotency(ctx, { command: 'submitAttempt', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const row = loadAttempt(ctx, input.attemptId)
    verifyClaim(ctx, row, input.claimToken)
    const increment = verdictOf(ctx, row, input, verified)
    storeSubmission(ctx, row, { ...input, increment })
    const run = requireRun(ctx, row.run_id)
    recordAttempt(ctx, row, run.epic_id, { kind: 'attempt.submitted', payload: submittedPayload(increment) })
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
