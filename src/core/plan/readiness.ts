/**
 * Server-side readiness: derives each ticket's execution state in a run from the pinned plan,
 * the run's attempts, and retry grants. Pure — no database, clock, or ids.
 */
import type { PlanBundle, SprintDef, TicketContent } from '../../shared/domain/bundle'
import {
  type AttemptKind,
  type AttemptState,
  isLeasedAttemptState,
  type RunState,
  type TicketExecutionState
} from '../../shared/domain/status'
import type { Blocker, PrerequisiteOutcome, TicketExecutionView } from '../../shared/domain/views'
import { sortedSprints } from './graph'

export interface AttemptSnapshot {
  id: string
  ticketId: string
  number: number
  kind: AttemptKind
  state: AttemptState
  reconciled: boolean
  superseded: boolean
}

export interface ReadinessInput {
  bundle: PlanBundle
  activeSprintId: string | null
  runState: RunState
  attempts: AttemptSnapshot[]
  retryGrants: Record<string, number>
}

export interface ExecutionSnapshot {
  tickets: TicketExecutionView[]
  capacity: { limit: number | null; inUse: number }
}

interface TicketAttempts {
  latest: AttemptSnapshot
  accepted: AttemptSnapshot | null
  workCount: number
  counted: number
}

interface Evaluation {
  state: TicketExecutionState
  blockers: Blocker[]
}

interface Readiness {
  input: ReadinessInput
  tickets: Map<string, TicketContent>
  sprintOrdinal: Map<string, number>
  requires: Map<string, string[]>
  activeOrdinal: number
  attempts: Map<string, TicketAttempts>
  memo: Map<string, Evaluation>
}

/** Latest-attempt states that decide the ticket outright. */
const LATEST_STATE: Partial<Record<AttemptState, TicketExecutionState>> = {
  submitted: 'submitted',
  claimed: 'running',
  running: 'running'
}

/** A prerequisite in one of these states cannot progress without intervention. */
const BLOCKING_PREREQUISITE = new Set<TicketExecutionState>(['failed', 'blocked'])

/** Pending states that also carry a `run_state` blocker while the run has not started a sprint. */
const QUEUED_PENDING = new Set<TicketExecutionState>(['waiting', 'blocked', 'later_sprint'])

/**
 * Attempts that consume one try: failed, rejected, or an expired lease that was reconciled.
 * (Carry-forward attempts are always accepted, so they never count.)
 */
function isCountedFailure(attempt: AttemptSnapshot): boolean {
  return (
    attempt.state === 'failed' ||
    attempt.state === 'rejected' ||
    (attempt.state === 'lease_expired' && attempt.reconciled)
  )
}

function addAttempt(summary: TicketAttempts | undefined, attempt: AttemptSnapshot): TicketAttempts {
  const entry = summary ?? { latest: attempt, accepted: null, workCount: 0, counted: 0 }
  if (attempt.number > entry.latest.number) {
    entry.latest = attempt
  }
  if (attempt.state === 'accepted') {
    entry.accepted = attempt
  }
  entry.workCount += attempt.kind === 'work' ? 1 : 0
  entry.counted += isCountedFailure(attempt) ? 1 : 0
  return entry
}

function summarizeAttempts(attempts: AttemptSnapshot[]): Map<string, TicketAttempts> {
  const byTicket = new Map<string, TicketAttempts>()
  for (const attempt of attempts.filter((item) => !item.superseded)) {
    byTicket.set(attempt.ticketId, addAttempt(byTicket.get(attempt.ticketId), attempt))
  }
  return byTicket
}

function requirementsOf(bundle: PlanBundle, tickets: Map<string, TicketContent>): Map<string, string[]> {
  const requires = new Map<string, string[]>()
  for (const edge of bundle.edges.filter((item) => tickets.has(item.from))) {
    requires.set(edge.to, [...(requires.get(edge.to) ?? []), edge.from])
  }
  return requires
}

function latestEvaluation(latest: AttemptSnapshot): Evaluation | null {
  const decided = LATEST_STATE[latest.state]
  if (decided !== undefined) {
    return { state: decided, blockers: [] }
  }
  if (latest.state === 'lease_expired' && !latest.reconciled) {
    return { state: 'needs_reconciliation', blockers: [{ kind: 'lease_expired', attemptId: latest.id }] }
  }
  return null
}

function attemptEvaluation(model: Readiness, ticketId: string): Evaluation | null {
  const summary = model.attempts.get(ticketId)
  if (!summary) {
    return null
  }
  if (summary.accepted) {
    return { state: 'accepted', blockers: [] }
  }
  const byLatest = latestEvaluation(summary.latest)
  if (byLatest) {
    return byLatest
  }
  const limit = model.input.bundle.policies.retryLimit + (model.input.retryGrants[ticketId] ?? 0)
  if (summary.counted >= limit) {
    return { state: 'failed', blockers: [{ kind: 'retry_limit', attempts: summary.counted, limit }] }
  }
  return null
}

function prerequisiteEvaluation(model: Readiness, ticketId: string): Evaluation {
  const blockers: Blocker[] = []
  let blocked = false
  for (const prerequisiteId of model.requires.get(ticketId) ?? []) {
    const { state } = evaluate(model, prerequisiteId)
    if (state !== 'accepted') {
      blockers.push({ kind: 'prerequisite', ticketId: prerequisiteId, key: keyOf(model, prerequisiteId), state })
      blocked = blocked || BLOCKING_PREREQUISITE.has(state)
    }
  }
  if (blocked) {
    return { state: 'blocked', blockers }
  }
  return blockers.length > 0 ? { state: 'waiting', blockers } : { state: 'ready', blockers }
}

function scheduleEvaluation(model: Readiness, ticketId: string): Evaluation {
  const ordinal = model.sprintOrdinal.get(ticketId) ?? model.activeOrdinal
  if (ordinal > model.activeOrdinal) {
    return { state: 'later_sprint', blockers: [] }
  }
  if (ordinal < model.activeOrdinal) {
    return { state: 'blocked', blockers: [] }
  }
  return prerequisiteEvaluation(model, ticketId)
}

/** Memoized per ticket; the placeholder makes an (invalid) cycle terminate as `blocked`. */
function evaluate(model: Readiness, ticketId: string): Evaluation {
  const known = model.memo.get(ticketId)
  if (known) {
    return known
  }
  model.memo.set(ticketId, { state: 'blocked', blockers: [] })
  const evaluation = attemptEvaluation(model, ticketId) ?? scheduleEvaluation(model, ticketId)
  model.memo.set(ticketId, evaluation)
  return evaluation
}

function keyOf(model: Readiness, ticketId: string): string {
  return model.tickets.get(ticketId)?.key ?? ticketId
}

function capacityOf(
  model: Readiness,
  activeSprint: SprintDef | undefined
): ExecutionSnapshot['capacity'] {
  const caps = [activeSprint?.concurrencyCap ?? null, model.input.bundle.policies.maxConcurrency].filter(
    (cap): cap is number => cap !== null
  )
  const inFlight = (activeSprint?.ticketIds ?? []).filter((ticketId) => {
    const latest = model.attempts.get(ticketId)?.latest
    return latest !== undefined && isLeasedAttemptState(latest.state)
  })
  return { limit: caps.length === 0 ? null : Math.min(...caps), inUse: inFlight.length }
}

function runBlockers(
  model: Readiness,
  state: TicketExecutionState,
  capacity: ExecutionSnapshot['capacity']
): Blocker[] {
  const { runState, activeSprintId } = model.input
  const queued = activeSprintId === null
  if (state !== 'ready') {
    return queued && QUEUED_PENDING.has(state) ? [{ kind: 'run_state', state: runState }] : []
  }
  const blockers: Blocker[] = []
  if (runState !== 'running' || queued) {
    blockers.push({ kind: 'run_state', state: runState })
  }
  if (capacity.limit !== null && capacity.inUse >= capacity.limit) {
    blockers.push({ kind: 'concurrency', limit: capacity.limit })
  }
  return blockers
}

function prerequisiteOutcomes(model: Readiness, ticketId: string): PrerequisiteOutcome[] {
  return (model.requires.get(ticketId) ?? []).map((prerequisiteId) => ({
    ticketId: prerequisiteId,
    key: keyOf(model, prerequisiteId),
    state: evaluate(model, prerequisiteId).state,
    acceptedAttemptId: model.attempts.get(prerequisiteId)?.accepted?.id ?? null
  }))
}

function ticketView(
  model: Readiness,
  ticket: TicketContent,
  sprint: SprintDef,
  capacity: ExecutionSnapshot['capacity']
): TicketExecutionView {
  const evaluation = evaluate(model, ticket.id)
  const summary = model.attempts.get(ticket.id)
  return {
    ticketId: ticket.id,
    key: ticket.key,
    sprintId: sprint.id,
    state: evaluation.state,
    attemptCount: summary?.workCount ?? 0,
    latestAttemptId: summary?.latest.id ?? null,
    blockers: [...evaluation.blockers, ...runBlockers(model, evaluation.state, capacity)],
    prerequisites: prerequisiteOutcomes(model, ticket.id)
  }
}

/**
 * Computes every ticket's execution state for the run's active sprint. A queued run (no active
 * sprint yet) is evaluated as if sprint 1 were active, with a `run_state` blocker on pending work.
 */
export function computeExecution(input: ReadinessInput): ExecutionSnapshot {
  const sprints = sortedSprints(input.bundle)
  const activeSprint = sprints.find((sprint) => sprint.id === input.activeSprintId) ?? sprints[0]
  const tickets = new Map(input.bundle.tickets.map((ticket) => [ticket.id, ticket]))
  const model: Readiness = {
    input,
    tickets,
    sprintOrdinal: new Map(sprints.flatMap((sprint) => sprint.ticketIds.map((id) => [id, sprint.ordinal] as const))),
    requires: requirementsOf(input.bundle, tickets),
    activeOrdinal: activeSprint?.ordinal ?? 1,
    attempts: summarizeAttempts(input.attempts),
    memo: new Map()
  }
  const capacity = capacityOf(model, activeSprint)
  const views = sprints.flatMap((sprint) =>
    sprint.ticketIds.flatMap((ticketId) => {
      const ticket = tickets.get(ticketId)
      return ticket ? [ticketView(model, ticket, sprint, capacity)] : []
    })
  )
  return { tickets: views, capacity }
}
