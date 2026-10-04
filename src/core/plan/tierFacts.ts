/**
 * Tier facts: for each ticket of a sprint, what it was planned at and what it took, computed from the run's
 * attempts so a retro can judge whether the developers were sized right. Pure.
 *
 * Escalation is the one judgement in here. An attempt counts as an escalation of an earlier one when it ran
 * on a model of a higher tier (cost tier, then highest reasoning level, as `compareTier` orders them) or at a
 * higher effort. Either is enough, and the later attempt need not directly follow the earlier one. Only what
 * was recorded is compared: two models are ranked when the host catalog lists both, and two efforts when both
 * were recorded. An attempt with no model and no effort (an orchestrator fallback) is listed and counted but
 * never ranked, and one on a model the catalog does not list can only be compared by effort.
 */
import { REASONING_EFFORTS, type PlanBundle, type ReasoningEffort, type TicketContent } from '../../shared/domain/bundle'
import type { TicketTierFacts, TierFactAttempt } from '../../shared/domain/retro'
import { ORCHESTRATOR_FALLBACK_LABEL, type AttemptKind, type AttemptState } from '../../shared/domain/status'
import type { HostCatalog, HostModel, WorkerInfo } from '../../shared/domain/views'
import { compareTier } from './modelTiers'

/** The columns of an attempt that tier facts read. */
export interface TierFactsAttempt {
  id: string
  ticketId: string
  number: number
  kind: AttemptKind
  state: AttemptState
  worker: Pick<WorkerInfo, 'label' | 'modelId' | 'effort'>
}

interface TierFactsInput {
  bundle: PlanBundle
  sprintId: string
  attempts: TierFactsAttempt[]
  /** The catalog models are ranked by; without one, only efforts are compared. */
  catalog: HostCatalog | null
}

type Models = Map<string, HostModel>

function attemptFact(attempt: TierFactsAttempt): TierFactAttempt {
  const { modelId, label } = attempt.worker
  return {
    attemptId: attempt.id,
    number: attempt.number,
    state: attempt.state,
    modelId,
    effort: attempt.worker.effort ?? null,
    label,
    fallback: modelId === null && label === ORCHESTRATOR_FALLBACK_LABEL
  }
}

function effortRank(effort: ReasoningEffort): number {
  return REASONING_EFFORTS.indexOf(effort)
}

function higherEffort(later: TierFactAttempt, earlier: TierFactAttempt): boolean {
  return later.effort !== null && earlier.effort !== null && effortRank(later.effort) > effortRank(earlier.effort)
}

function higherTier(later: TierFactAttempt, earlier: TierFactAttempt, models: Models): boolean {
  const a = later.modelId === null ? undefined : models.get(later.modelId)
  const b = earlier.modelId === null ? undefined : models.get(earlier.modelId)
  return a !== undefined && b !== undefined && compareTier(a, b) > 0
}

function isEscalated(attempts: TierFactAttempt[], models: Models): boolean {
  return attempts.some((later, index) =>
    attempts.slice(0, index).some((earlier) => higherTier(later, earlier, models) || higherEffort(later, earlier))
  )
}

function ticketFacts(ticket: TicketContent, all: TierFactsAttempt[], models: Models): TicketTierFacts {
  const attempts = all
    .filter((attempt) => attempt.ticketId === ticket.id && attempt.kind === 'work')
    .sort((a, b) => a.number - b.number)
    .map(attemptFact)
  return {
    ticketId: ticket.id,
    key: ticket.key,
    size: ticket.size ?? null,
    plannedLevel: ticket.capability.reasoning.level,
    plannedEffort: ticket.capability.reasoning.effort ?? null,
    attempts,
    attemptCount: attempts.length,
    rejectionCount: attempts.filter((attempt) => attempt.state === 'rejected').length,
    escalated: isEscalated(attempts, models)
  }
}

/** The facts of every ticket the sprint lists, in sprint order, whether or not it was worked on. Empty for an unknown sprint. */
export function computeTierFacts(input: TierFactsInput): TicketTierFacts[] {
  const sprint = input.bundle.sprints.find((item) => item.id === input.sprintId)
  const tickets = new Map(input.bundle.tickets.map((ticket) => [ticket.id, ticket]))
  const models: Models = new Map((input.catalog?.models ?? []).map((model) => [model.id, model]))
  return (sprint?.ticketIds ?? []).flatMap((id) => {
    const ticket = tickets.get(id)
    return ticket === undefined ? [] : [ticketFacts(ticket, input.attempts, models)]
  })
}
