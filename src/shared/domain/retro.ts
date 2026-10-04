/**
 * The retro of a sprint report, and the tier facts a report view carries beside it.
 *
 * A retro is what the reporter writes about the sprint: what was delivered and how to see it, what went
 * well and poorly, the process changes for the next sprint, the work discovered, the required work left
 * over, and whether each developer was sized right. It is stored inside the report, so it is part of the
 * report's content hash. Its `ticket` fields are written as a ticket id or display key and stored as the
 * stable id.
 *
 * Tier facts are not written by anyone. The server computes them from the run's attempts whenever a report
 * is read, so they are never stored and never change the content hash.
 */
import type { ReasoningEffort, ReasoningLevel, TicketSize } from './bundle'
import type { AttemptState } from './status'

/** Whether the model and effort a ticket got matched what it needed, as the reporter judges it. */
export const TIER_VERDICTS = ['right_sized', 'oversized', 'undersized'] as const
export type TierVerdict = (typeof TIER_VERDICTS)[number]

/** What to look at for a delivered ticket, and where to find it (an artifact, a screenshot or a commit). */
export interface RetroDelivered {
  ticket: string
  demo: string
  evidence: string
}

/** New work found during the sprint, with the ticket it came up on when there is one. */
export interface RetroDiscovery {
  title: string
  body: string
  ticket: string | null
}

/** Required work that was not accepted this sprint, and why. */
export interface RetroLeftover {
  ticket: string
  reason: string
}

export interface RetroTierFit {
  ticket: string
  verdict: TierVerdict
  note: string
}

/** A retro as stored and read: every list present, every ticket a stable id. */
export interface SprintRetro {
  delivered: RetroDelivered[]
  wentWell: string[]
  wentPoorly: string[]
  /** Process changes for the next sprint. */
  actions: string[]
  discoveries: RetroDiscovery[]
  leftovers: RetroLeftover[]
  tierFit: RetroTierFit[]
}

/** A retro as a reporter writes it: every list optional, tickets by id or display key. */
export interface SprintRetroInput {
  delivered?: { ticket: string; demo: string; evidence: string }[]
  wentWell?: string[]
  wentPoorly?: string[]
  actions?: string[]
  discoveries?: { title: string; body?: string; ticket?: string | null }[]
  leftovers?: { ticket: string; reason: string }[]
  tierFit?: { ticket: string; verdict: TierVerdict; note?: string }[]
}

/** One work attempt on a ticket: the model and effort its worker recorded. */
export interface TierFactAttempt {
  attemptId: string
  number: number
  state: AttemptState
  /** Null when the worker recorded no model, as for an orchestrator fallback. */
  modelId: string | null
  /** Null when the claim named no effort (and for every worker recorded before efforts existed). */
  effort: ReasoningEffort | null
  /** The worker's label, such as "Orchestrator (fallback)". */
  label: string
  /** True when the orchestrator collected the ticket because the model named for it could not take it. Such an attempt has no model or effort to rank. */
  fallback: boolean
}

/**
 * What a sprint ticket was planned at and what it took, for judging whether its developers were sized
 * right. Only work attempts count (a carried-forward attempt ran no worker), including superseded ones,
 * which did run.
 */
export interface TicketTierFacts {
  ticketId: string
  key: string
  size: TicketSize | null
  plannedLevel: ReasoningLevel
  /** The effort the ticket sets for itself, or null when it sets none. */
  plannedEffort: ReasoningEffort | null
  /** In attempt order. */
  attempts: TierFactAttempt[]
  attemptCount: number
  /** Attempts the orchestrator or reviewer rejected; failed and canceled attempts are not rejections. */
  rejectionCount: number
  /**
   * True when some attempt ran on a higher model tier (cost tier, then highest reasoning level) or at a
   * higher effort than some earlier attempt. Two models are compared only when the host catalog lists both,
   * and two efforts only when both were recorded, so an orchestrator fallback attempt (no model, no effort)
   * is never ranked.
   */
  escalated: boolean
}
