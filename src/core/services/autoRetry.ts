/**
 * The orchestrator's own retries. Once a ticket uses up its plan's `retryLimit` (plus any grants), the orchestrator
 * may give it one more attempt itself (`retry_ticket`, capability `ticket.auto_retry`), saying why it failed and what
 * it does differently, up to the plan's `autoRetryLimit` per ticket over every run of its epic. After that only the
 * person's `grant_retry` adds attempts. The person's grants never use up that budget: it counts orchestrator retries
 * only. The budget and the tried approaches are the epic's, not the run's, so canceling the run and starting a new one
 * gives the orchestrator no fresh retries and lets it repeat no approach (the person's grants stay per run).
 *
 * Every retry is a `ticket.retry_granted` event whose payload names `grantedBy: 'orchestrator'`; the extra attempt
 * itself goes into `retry_grants` exactly as the person's grant does, so readiness, scorecards and verification read
 * one total. The person's Acknowledge is a `ticket.auto_retry_acknowledged` event: it records that they read the
 * retry and never gates a claim or the run. Both live in this machine's event log, beside the run's retry grants.
 */
import { autoRetryLimitOf } from '../../shared/domain/bundle'
import { isActiveRunState } from '../../shared/domain/status'
import type { AutoRetryView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { fail } from '../errors'
import { LIMITS } from '../schemas'
import { maskSecretText } from '../storedSecrets'
import { appendEvent } from './events'
import { executionOf, loadRunContext } from './execution'
import { enqueueOutbox } from './outbox'
import { setRunState } from './reports'
import { requireOwnedRun } from './runs'

const RETRY_GRANTED_EVENT = 'ticket.retry_granted'
const AUTO_RETRY_ACKNOWLEDGED_EVENT = 'ticket.auto_retry_acknowledged'
const ORCHESTRATOR_GRANT = 'orchestrator'

/** The fewest characters a reason or an approach may have once trimmed: a word or two says nothing. */
const MIN_RETRY_TEXT = 20

interface RetryTicketInput {
  runId: string
  ticketId: string
  failureReason: string
  newApproach: string
}

interface AutoRetryPayload {
  grantedBy?: unknown
  autoRetry?: unknown
  failureReason?: unknown
  newApproach?: unknown
}

interface AutoRetryEvent {
  seq: number
  at: string
  runId: string
  ticketId: string
  number: number
  failureReason: string
  newApproach: string
}

/** The trimmed text, refused when it is too short or too long to say why or what changes. */
function retryText(field: 'failureReason' | 'newApproach', value: string): string {
  const text = value.trim()
  const what = field === 'failureReason' ? 'The failure reason' : 'The new approach'
  if (text.length < MIN_RETRY_TEXT) {
    fail('invalid_input', `${what} needs at least ${MIN_RETRY_TEXT} characters: say honestly ${field === 'failureReason' ? 'why the ticket failed' : 'what you will do differently'}.`, {
      field,
      minimum: MIN_RETRY_TEXT
    })
  }
  if (text.length > LIMITS.shortText) {
    fail('invalid_input', `${what} can have at most ${LIMITS.shortText} characters.`, { field, maximum: LIMITS.shortText })
  }
  return maskSecretText(text)
}

/** An approach as compared with earlier ones: case, spacing and punctuation do not make it a different approach. */
export function approachKey(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function autoRetryOf(row: { seq: number; at: string; run_id: string; ticket_id: string; payload_json: string }): AutoRetryEvent | null {
  const payload = parseJson<AutoRetryPayload>(row.payload_json, {})
  if (payload.grantedBy !== ORCHESTRATOR_GRANT || typeof payload.autoRetry !== 'number') {
    return null
  }
  return {
    seq: row.seq,
    at: row.at,
    runId: row.run_id,
    ticketId: row.ticket_id,
    number: payload.autoRetry,
    failureReason: typeof payload.failureReason === 'string' ? payload.failureReason : '',
    newApproach: typeof payload.newApproach === 'string' ? payload.newApproach : ''
  }
}

type RetryEventRow = { seq: number; at: string; run_id: string; ticket_id: string; payload_json: string }

function orchestratorRetries(rows: RetryEventRow[]): AutoRetryEvent[] {
  return rows.map(autoRetryOf).filter((event): event is AutoRetryEvent => event !== null)
}

/** The orchestrator's retries of one ticket in one run, oldest first. */
function autoRetriesInRun(ctx: Ctx, runId: string, ticketId: string): AutoRetryEvent[] {
  return orchestratorRetries(
    ctx.db.all<RetryEventRow>(
      'SELECT seq, at, run_id, ticket_id, payload_json FROM events WHERE kind = ? AND run_id = ? AND ticket_id = ? ORDER BY seq',
      RETRY_GRANTED_EVENT,
      runId,
      ticketId
    )
  )
}

/**
 * The orchestrator's retries of one ticket over every run of its epic, oldest first: what its budget and its tried
 * approaches count. `retryTicket` always records the event with the run's epic, so none is missed.
 */
function autoRetriesInEpic(ctx: Ctx, epicId: string, ticketId: string): AutoRetryEvent[] {
  return orchestratorRetries(
    ctx.db.all<RetryEventRow>(
      'SELECT seq, at, run_id, ticket_id, payload_json FROM events WHERE kind = ? AND epic_id = ? AND ticket_id = ? ORDER BY seq',
      RETRY_GRANTED_EVENT,
      epicId,
      ticketId
    )
  )
}

/** Refused with `conflict` unless the ticket is held by its retry limit right now. */
function requireAtRetryLimit(ctx: Ctx, runId: string, ticketId: string, key: string): void {
  const execution = executionOf(loadRunContext(ctx, runId))
  const ticket = execution.tickets.find((item) => item.ticketId === ticketId)
  if (!ticket?.blockers.some((blocker) => blocker.kind === 'retry_limit')) {
    fail('conflict', `${key} is not held by its retry limit, so there is nothing to retry. Claim it, review it or wait for it instead.`, {
      ticketId,
      state: ticket?.state ?? null
    })
  }
}

/**
 * The earlier orchestrator retries of the ticket in any run of the epic, once the plan's budget has room for another
 * (`retry_escalation_required` otherwise) and `newApproach` is not one of theirs (`conflict` otherwise).
 */
function requireNewApproachWithinBudget(
  ctx: Ctx,
  ticket: { epicId: string; ticketId: string; key: string },
  limit: number,
  newApproach: string
): AutoRetryEvent[] {
  const earlier = autoRetriesInEpic(ctx, ticket.epicId, ticket.ticketId)
  if (earlier.length >= limit) {
    fail(
      'retry_escalation_required',
      `${ticket.key} has had ${earlier.length} orchestrator ${earlier.length === 1 ? 'retry' : 'retries'} in this epic's runs, the most the plan allows (${limit}). Tell the person why it keeps failing; only their Grant retry in the desktop app adds attempts now.`,
      { ticketId: ticket.ticketId, autoRetries: earlier.length, autoRetryLimit: limit }
    )
  }
  const key = approachKey(newApproach)
  if (earlier.some((event) => approachKey(event.newApproach) === key)) {
    fail('conflict', `This approach was already tried for ${ticket.key} in a run of this epic. Retry from a genuinely different angle.`, {
      ticketId: ticket.ticketId
    })
  }
  return earlier
}

/**
 * Orchestrator only: one more attempt for a ticket its retry limit holds, in a run this machine owns, with an honest
 * reason and an approach no run of the epic has tried for the ticket. A run waiting at its checkpoint resumes, as with the
 * person's grant. Returns the retry's number and how many more the plan allows.
 */
export function retryTicket(ctx: Ctx, input: RetryTicketInput): { autoRetry: number; autoRetriesLeft: number } {
  requireCapability(ctx.session, 'ticket.auto_retry')
  const failureReason = retryText('failureReason', input.failureReason)
  const newApproach = retryText('newApproach', input.newApproach)
  return ctx.db.tx(() => {
    const run = requireOwnedRun(ctx, input.runId)
    if (!isActiveRunState(run.state)) {
      fail('run_not_active', `Run #${run.number} is ${run.state}.`, { runId: run.id, state: run.state })
    }
    const { bundle } = loadRunContext(ctx, run.id)
    const ticket =
      bundle.tickets.find((item) => item.id === input.ticketId) ??
      fail('not_found', `Ticket ${input.ticketId} is not part of this run's plan revision.`, { ticketId: input.ticketId })
    requireAtRetryLimit(ctx, run.id, ticket.id, ticket.key)
    const limit = autoRetryLimitOf(bundle.policies)
    const earlier = requireNewApproachWithinBudget(ctx, { epicId: run.epic_id, ticketId: ticket.id, key: ticket.key }, limit, newApproach)
    ctx.db.run(
      `INSERT INTO retry_grants (run_id, ticket_id, extra) VALUES (?, ?, 1)
       ON CONFLICT (run_id, ticket_id) DO UPDATE SET extra = extra + 1`,
      run.id,
      ticket.id
    )
    if (run.state === 'awaiting_checkpoint') {
      setRunState(ctx, run.id, 'running')
    }
    const grant = ctx.db.get<{ extra: number }>('SELECT extra FROM retry_grants WHERE run_id = ? AND ticket_id = ?', run.id, ticket.id)
    const autoRetry = earlier.length + 1
    appendEvent(ctx, {
      kind: RETRY_GRANTED_EVENT,
      epicId: run.epic_id,
      runId: run.id,
      ticketId: ticket.id,
      payload: { extra: grant?.extra ?? 1, grantedBy: ORCHESTRATOR_GRANT, failureReason, newApproach, autoRetry }
    })
    enqueueOutbox(ctx, { kind: 'run_history', epicId: run.epic_id, runId: run.id })
    return { autoRetry, autoRetriesLeft: limit - autoRetry }
  })
}

/** When each orchestrator retry (by its event's seq) was acknowledged, the first time only. */
function acknowledgements(ctx: Ctx, runIds: readonly string[], ticketId: string): Map<number, string> {
  const acknowledged = new Map<number, string>()
  if (runIds.length === 0) {
    return acknowledged
  }
  const rows = ctx.db.all<{ at: string; payload_json: string }>(
    `SELECT at, payload_json FROM events WHERE kind = ? AND ticket_id = ? AND run_id IN (${runIds.map(() => '?').join(', ')}) ORDER BY seq`,
    AUTO_RETRY_ACKNOWLEDGED_EVENT,
    ticketId,
    ...runIds
  )
  for (const row of rows) {
    const retrySeq = parseJson<{ retrySeq?: unknown }>(row.payload_json, {}).retrySeq
    if (typeof retrySeq === 'number' && !acknowledged.has(retrySeq)) {
      acknowledged.set(retrySeq, row.at)
    }
  }
  return acknowledged
}

/** The orchestrator's retries of a ticket over the epic's runs on this machine, oldest first. */
export function listAutoRetries(ctx: Ctx, epicId: string, ticketId: string): AutoRetryView[] {
  requireCapability(ctx.session, 'read')
  const runs = ctx.db.all<{ id: string; number: number }>('SELECT id, number FROM runs WHERE epic_id = ? ORDER BY number', epicId)
  const numbers = new Map(runs.map((run) => [run.id, run.number]))
  const acknowledged = acknowledgements(ctx, [...numbers.keys()], ticketId)
  return runs
    .flatMap((run) => autoRetriesInRun(ctx, run.id, ticketId))
    .map((event) => ({
      runId: event.runId,
      runNumber: numbers.get(event.runId) ?? 0,
      ticketId: event.ticketId,
      number: event.number,
      failureReason: event.failureReason,
      newApproach: event.newApproach,
      at: event.at,
      acknowledgedAt: acknowledged.get(event.seq) ?? null
    }))
}

/**
 * Desktop only: records that the person read an orchestrator retry. It changes no attempt, claim or run state;
 * acknowledging again keeps the first time.
 */
export function acknowledgeAutoRetry(ctx: Ctx, input: { runId: string; ticketId: string; number: number }): AutoRetryView {
  requireCapability(ctx.session, 'ticket.retry_acknowledge')
  return ctx.db.tx(() => {
    const run =
      ctx.db.get<{ id: string; epic_id: string; number: number }>('SELECT id, epic_id, number FROM runs WHERE id = ?', input.runId) ??
      fail('not_found', `Run ${input.runId} not found.`, { runId: input.runId })
    const retry =
      autoRetriesInRun(ctx, run.id, input.ticketId).find((event) => event.number === input.number) ??
      fail('not_found', `Run #${run.number} has no orchestrator retry ${input.number} of ticket ${input.ticketId}.`, {
        runId: run.id,
        ticketId: input.ticketId,
        number: input.number
      })
    let acknowledgedAt = acknowledgements(ctx, [run.id], retry.ticketId).get(retry.seq) ?? null
    if (acknowledgedAt === null) {
      appendEvent(ctx, {
        kind: AUTO_RETRY_ACKNOWLEDGED_EVENT,
        epicId: run.epic_id,
        runId: run.id,
        ticketId: retry.ticketId,
        payload: { retrySeq: retry.seq, autoRetry: retry.number }
      })
      acknowledgedAt = ctx.clock.nowIso()
    }
    return {
      runId: run.id,
      runNumber: run.number,
      ticketId: retry.ticketId,
      number: retry.number,
      failureReason: retry.failureReason,
      newApproach: retry.newApproach,
      at: retry.at,
      acknowledgedAt
    }
  })
}
