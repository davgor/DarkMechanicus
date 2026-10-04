/**
 * Pure view model for a sprint report's retro: the sprint demo (what was delivered and where to look), the
 * retro notes, the table that sets each ticket's planned tier against what it took, and the work that goes
 * to the next sprint. Tickets are stable ids in the stored retro; the caller names them from the plan.
 */
import type { ReasoningEffort } from '../../../shared/domain/bundle'
import type { RetroTierFit, TicketTierFacts, TierFactAttempt, TierVerdict } from '../../../shared/domain/retro'
import type { SprintReportView } from '../../../shared/domain/views'
import { EFFORT_LABELS, REASONING_LABELS, SIZE_LABELS } from '../ticket/ticketView'

/** A ticket as the report names it: linked when the plan has it, otherwise the id as written. */
export interface TicketRef {
  ticketId: string | null
  key: string
  title: string
}

/** What the retro needs from the caller: how to name a ticket, and whether the run has since accepted it. */
export interface RetroLookup {
  ref(ticketId: string): TicketRef
  accepted(ticketId: string): boolean
}

/** A stretch of an evidence line: plain text, or a web address that opens in the browser. */
export interface EvidencePart {
  text: string
  href: string | null
}

export interface DeliveredRow {
  ticket: TicketRef
  demo: string
  evidence: EvidencePart[]
}

export interface TierFitRow {
  ticket: TicketRef
  /** "Medium · Multi-step · Medium effort". */
  planned: string
  /** One line per work attempt: the model (or worker), the effort and how it ended. */
  used: string[]
  attempts: string
  /** The reporter's verdict; null for a ticket the reporter did not judge. */
  verdict: { label: string; tone: 'accepted' | 'attention' | 'blocked' } | null
  note: string
}

export interface DiscoveryRow {
  title: string
  body: string
  /** The ticket it came up on. */
  source: TicketRef | null
}

export interface LeftoverRow {
  ticket: TicketRef
  reason: string
  /** The run has accepted the ticket since the retro was written, so it is no longer left over. */
  accepted: boolean
}

export interface RetroSections {
  delivered: DeliveredRow[]
  wentWell: string[]
  wentPoorly: string[]
  actions: string[]
  tierFit: TierFitRow[]
  discoveries: DiscoveryRow[]
  leftovers: LeftoverRow[]
}

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/g
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

/** The evidence line cut into text and web addresses; only http and https addresses are links. */
export function evidenceParts(evidence: string): EvidencePart[] {
  if (evidence.trim() === '') {
    return []
  }
  const parts: EvidencePart[] = []
  let from = 0
  for (const match of evidence.matchAll(URL_PATTERN)) {
    const address = match[0].replace(TRAILING_PUNCTUATION, '')
    const start = match.index ?? 0
    if (start > from) {
      parts.push({ text: evidence.slice(from, start), href: null })
    }
    parts.push({ text: address, href: address })
    from = start + address.length
  }
  return from < evidence.length ? [...parts, { text: evidence.slice(from), href: null }] : parts
}

const VERDICTS: Record<TierVerdict, { label: string; tone: 'accepted' | 'attention' | 'blocked' }> = {
  right_sized: { label: 'Right-sized', tone: 'accepted' },
  oversized: { label: 'Oversized', tone: 'attention' },
  undersized: { label: 'Undersized', tone: 'blocked' }
}

function effortText(effort: ReasoningEffort | null, none: string): string {
  return effort === null ? none : `${EFFORT_LABELS[effort]} effort`
}

function plannedText(facts: TicketTierFacts | undefined): string {
  if (facts === undefined) {
    return 'unknown plan'
  }
  const size = facts.size === null ? 'No size' : SIZE_LABELS[facts.size]
  return [size, REASONING_LABELS[facts.plannedLevel], effortText(facts.plannedEffort, 'no effort set')].join(' · ')
}

/** "#2 model-large · high effort · failed": the model, or the worker when none was recorded. */
function attemptLine(attempt: TierFactAttempt): string {
  const who = attempt.fallback || attempt.modelId === null ? attempt.label : attempt.modelId
  const effort = attempt.effort === null ? [] : [`${attempt.effort} effort`]
  return [`#${attempt.number} ${who}`, ...effort, attempt.state.replaceAll('_', ' ')].join(' · ')
}

function attemptsText(facts: TicketTierFacts | undefined): string {
  if (facts === undefined || facts.attemptCount === 0) {
    return 'not worked'
  }
  const count = `${facts.attemptCount} ${facts.attemptCount === 1 ? 'attempt' : 'attempts'}`
  return [count, ...(facts.rejectionCount > 0 ? [`${facts.rejectionCount} rejected`] : []), ...(facts.escalated ? ['escalated'] : [])].join(' · ')
}

function tierRow(lookup: RetroLookup, ticketId: string, facts: TicketTierFacts | undefined, judged: RetroTierFit | undefined): TierFitRow {
  return {
    ticket: lookup.ref(ticketId),
    planned: plannedText(facts),
    used: facts?.attempts.map(attemptLine) ?? [],
    attempts: attemptsText(facts),
    verdict: judged === undefined ? null : VERDICTS[judged.verdict],
    note: judged?.note ?? ''
  }
}

/** A row for each ticket that was worked or judged: those the facts list in sprint order, then verdicts on tickets with no facts. */
function tierFitRows(report: SprintReportView, lookup: RetroLookup): TierFitRow[] {
  const verdicts = new Map((report.report.retro?.tierFit ?? []).map((item) => [item.ticket, item]))
  const known = new Set(report.tierFacts.map((facts) => facts.ticketId))
  const worked = report.tierFacts.filter((facts) => facts.attemptCount > 0 || verdicts.has(facts.ticketId))
  const orphans = [...verdicts.keys()].filter((id) => !known.has(id))
  return [
    ...worked.map((facts) => tierRow(lookup, facts.ticketId, facts, verdicts.get(facts.ticketId))),
    ...orphans.map((id) => tierRow(lookup, id, undefined, verdicts.get(id)))
  ]
}

/** The report's retro ready to show; null for a report written without one. */
export function retroSections(report: SprintReportView, lookup: RetroLookup): RetroSections | null {
  const retro = report.report.retro
  if (retro === null) {
    return null
  }
  return {
    delivered: retro.delivered.map((item) => ({
      ticket: lookup.ref(item.ticket),
      demo: item.demo,
      evidence: evidenceParts(item.evidence)
    })),
    wentWell: retro.wentWell,
    wentPoorly: retro.wentPoorly,
    actions: retro.actions,
    tierFit: tierFitRows(report, lookup),
    discoveries: retro.discoveries.map((item) => ({
      title: item.title,
      body: item.body,
      source: item.ticket === null ? null : lookup.ref(item.ticket)
    })),
    leftovers: retro.leftovers.map((item) => ({
      ticket: lookup.ref(item.ticket),
      reason: item.reason,
      accepted: lookup.accepted(item.ticket)
    }))
  }
}
