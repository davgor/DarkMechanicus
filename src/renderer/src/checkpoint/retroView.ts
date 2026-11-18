/**
 * Pure view model for a sprint report's retro: the sprint demo (what was delivered and where to look), the
 * retro notes, the table that sets each ticket's planned tier against what it took, and the work that goes
 * to the next sprint. Tickets are stable ids in the stored retro; the caller names them from the plan.
 */
import type { ReasoningEffort } from '../../../shared/domain/bundle'
import type {
  ExperimentComparison,
  ExperimentOutcome,
  ExperimentOutcomeClass,
  ExperimentReading,
  ImprovementConcern,
  RetroExperiment
} from '../../../shared/domain/experiments'
import type { RetroTierFit, TicketTierFacts, TierFactAttempt, TierVerdict } from '../../../shared/domain/retro'
import type { GradeSubjectLevel } from '../../../shared/domain/space'
import type { SprintReportView } from '../../../shared/domain/views'
import { EFFORT_LABELS, REASONING_LABELS, SIZE_LABELS } from '../ticket/ticketView'
import { correctionRoute, routeText } from './correctionRoute'

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

/** One piece of an experiment's proposed work; `size` is null when the reporter left it unsized (it cannot be scheduled). */
interface ExperimentWorkRow {
  title: string
  body: string
  size: string | null
}

/** A structured improvement experiment as the approver reads it: every field in words. */
export interface ExperimentRow {
  id: string
  /** The kind of gap it addresses, as the reporter judged it ("Plan or context"); "Concern not stated" on an older one. */
  concern: string
  /** The frozen grade it was drawn from: "Ticket grade · this revision's scorecard" (the ticket is `sourceTicket`). */
  source: string
  sourceTicket: TicketRef | null
  issue: string
  /** Each cited record: "attempt at_… (longest attempt)". */
  evidence: string[]
  hypothesis: string
  destination: string
  work: ExperimentWorkRow[]
  /** "T.actual_ms 4,200,000 milliseconds (observed)". */
  baseline: string
  /** "Decrease by 20 percent". */
  change: string
  /** "A.delivered at least 3 count". */
  guardrails: string[]
  /** "Over the next 1 sprint". */
  window: string
  /** How the corrective work measured up against the experiment; null when the report was read without outcomes. */
  outcome: ExperimentOutcomeRow | null
}

/** A corrective ticket of the experiment and whether it was accepted. */
interface CorrectionRow {
  /** Linked when the report's plan holds it; otherwise named by the key and title it has in the epic holding it. */
  ticket: TicketRef
  /** 'Follow-up epic "Title" (ep_…)' when another epic holds it; null in the experiment's own epic. */
  epic: string | null
  /** "Accepted 2026-11-15T10:00:00.000Z in run rn_…", "Not accepted yet · saved in revision 4" or "Not accepted yet · in the draft, not saved". */
  state: string
}

/** One measured result set against the baseline, with the evidence it stands on. */
export interface ExperimentResultRow {
  /** "Result #3 · Improved". */
  heading: string
  tone: OutcomeTone
  /** "1,400,000 milliseconds per ticket (4,200,000 over 3 tickets) · sprint grade of report rp_… revision 1 · window …". */
  before: string
  after: string
  /** "-280,000 (-20%) against a target of 1,120,000", or "Not compared". */
  change: string
  /** "P.score 80 points, within at least 70 points (held)". */
  guardrails: string[]
  evidence: string[]
  reasons: string[]
  note: string
}

type OutcomeTone = 'accepted' | 'neutral' | 'blocked' | 'attention'

export interface ExperimentOutcomeRow {
  /** "Improved", "Unchanged", "Regressed" or "Insufficient evidence". */
  label: string
  tone: OutcomeTone
  /** "Completed". */
  status: string
  reasons: string[]
  /** "Decrease T.actual_ms by 20 percent from 4,200,000 to 3,360,000 milliseconds". */
  target: string
  corrections: CorrectionRow[]
  /** When the work landed (the after-window starts there), or why it has not. */
  landing: string
  results: ExperimentResultRow[]
  /** The observational label: a difference is not proof of cause. */
  caveat: string
}

export interface RetroSections {
  delivered: DeliveredRow[]
  wentWell: string[]
  wentPoorly: string[]
  actions: string[]
  tierFit: TierFitRow[]
  discoveries: DiscoveryRow[]
  leftovers: LeftoverRow[]
  experiments: ExperimentRow[]
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
    const start = match.index
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

export const CONCERN_LABELS: Record<ImprovementConcern, string> = {
  code_defect: 'Code defect',
  plan_context: 'Plan or context',
  orchestration_tooling: 'Orchestration or tooling',
  unavailable_evidence: 'Unavailable evidence'
}

export const SUBJECT_LABELS: Record<GradeSubjectLevel, string> = { ticket: 'Ticket', sprint: 'Sprint', run: 'Run', epic: 'Epic' }

export const numberText = (value: number): string => value.toLocaleString('en-US')

function sourceText(experiment: RetroExperiment): string {
  const { subject, revision, reportRevision } = experiment.source
  const card = revision === 'own' ? "this revision's scorecard" : `the scorecard of report revision ${reportRevision}`
  return `${SUBJECT_LABELS[subject.level]} grade · ${card}`
}

const OUTCOME_LABELS: Record<ExperimentOutcomeClass, { label: string; tone: OutcomeTone }> = {
  improved: { label: 'Improved', tone: 'accepted' },
  unchanged: { label: 'Unchanged', tone: 'neutral' },
  regressed: { label: 'Regressed', tone: 'blocked' },
  insufficient_evidence: { label: 'Insufficient evidence', tone: 'attention' }
}

/** The planned size of a ticket scope, or the size mix of a run, sprint or epic scope ("sizes 3 Medium"). */
function scopeText(reading: ExperimentReading): string[] {
  if (reading.size !== null) return [`planned ${SIZE_LABELS[reading.size]}`]
  if (reading.sizeMix === null) return []
  const mix = Object.entries(reading.sizeMix).map(([size, count]) => `${count} ${size === 'unsized' ? 'unsized' : SIZE_LABELS[size as keyof typeof SIZE_LABELS]}`)
  return [`sizes ${mix.join(', ') || 'none'}`]
}

/** The grade a side was read from: of this epic, a follow-up epic, or a correction epic of the Dark Mechanicus source. */
function gradedWhere(ref: ExperimentReading['assessment'], homeEpicId: string | null, crossRepo: ExperimentComparison['crossRepo']): string {
  if (ref === null) return 'stated with evidence'
  const other =
    crossRepo === undefined ? ` of epic ${ref.epicId}` : ` of correction epic "${crossRepo.epicTitle}" (${crossRepo.epicId}) in the Dark Mechanicus source, project ${crossRepo.projectId}`
  return `${ref.subject.level} grade of report ${ref.reportId} revision ${ref.reportRevision}${ref.epicId === homeEpicId ? '' : other}`
}

/** A side of a comparison: its figure (per ticket with the total and sample size), the grade it was read from, its scope and window. */
function readingText(reading: ExperimentReading, basis: ExperimentComparison['basis'], homeEpicId: string | null, crossRepo?: ExperimentComparison['crossRepo']): string {
  const value = reading.value === null ? `no value (${reading.state})` : `${numberText(reading.value)} ${reading.unit} (${reading.state})`
  const perTicket = basis === 'per_ticket' ? reading.perTicket : null
  const figure = perTicket === null ? value : `${numberText(perTicket)} ${reading.unit} per ticket (${value} over ${reading.sampleSize} tickets)`
  const window = reading.window === null ? [] : [`window ${reading.window.from ?? 'no dispatch'} to ${reading.window.to}`]
  return [figure, gradedWhere(reading.assessment, homeEpicId, crossRepo), ...scopeText(reading), ...window].join(' · ')
}

function changeText(comparison: ExperimentComparison): string {
  if (comparison.difference === null) return 'Not compared'
  const sign = comparison.difference > 0 ? '+' : ''
  const percent = comparison.percentChange === null ? '' : ` (${sign}${numberText(comparison.percentChange)}%)`
  const target = comparison.target === null ? '' : ` against a target of ${numberText(comparison.target)}`
  return `${sign}${numberText(comparison.difference)}${percent}${target}`
}

function resultRow(comparison: ExperimentComparison, outcome: ExperimentOutcome): ExperimentResultRow {
  const verdict = OUTCOME_LABELS[comparison.classification]
  const home = outcome.baseline.assessment?.epicId ?? null
  return {
    heading: `Result #${comparison.eventNumber} · ${verdict.label}`,
    tone: verdict.tone,
    before: readingText(outcome.baseline, comparison.basis, home),
    after: readingText(comparison.after, comparison.basis, home, comparison.crossRepo),
    change: changeText(comparison),
    guardrails: comparison.guardrails.map((check) => `${check.detail} (${check.verdict})`),
    evidence: comparison.evidence.map((ref) => `${ref.kind} ${ref.id}${ref.detail === null ? '' : ` (${ref.detail})`}`),
    reasons: comparison.reasons,
    note: comparison.note
  }
}

function correctionRow(ticket: ExperimentOutcome['corrections']['tickets'][number], lookup: RetroLookup, homeEpicId: string | null): CorrectionRow {
  const { accepted } = ticket
  const role = ticket.role === 'fireguard' ? ' (Fireguard)' : ''
  const known = lookup.ref(ticket.ticketId)
  return {
    // The report's plan names only its own epic's tickets: a follow-up epic's keeps the key and title it has there.
    ticket: known.ticketId === null ? { ticketId: null, key: ticket.key, title: ticket.title } : known,
    epic:
      ticket.projectId !== undefined
        ? `Correction epic "${ticket.epicTitle}" (${ticket.epicId}) in the Dark Mechanicus source`
        : ticket.epicId === homeEpicId
          ? null
          : `Follow-up epic "${ticket.epicTitle}" (${ticket.epicId})`,
    state:
      accepted === null
        ? `Not accepted yet${role} · ${ticket.revisionNumber === null ? 'in the draft, not saved' : `saved in revision ${ticket.revisionNumber}`}`
        : `Accepted ${accepted.at} in run ${accepted.runId}${role}`
  }
}

function outcomeRow(outcome: ExperimentOutcome, lookup: RetroLookup): ExperimentOutcomeRow {
  const verdict = OUTCOME_LABELS[outcome.classification]
  const { target, baseline } = outcome
  const direction = target.direction === 'increase' ? 'Increase' : 'Decrease'
  return {
    ...verdict,
    status: outcome.status.charAt(0).toUpperCase() + outcome.status.slice(1).replaceAll('_', ' '),
    reasons: outcome.reasons,
    target: `${direction} by ${numberText(target.amount)} ${target.unit} from ${numberText(baseline.value ?? 0)} to ${numberText(target.value)} ${baseline.unit}`,
    corrections: outcome.corrections.tickets.map((ticket) => correctionRow(ticket, lookup, baseline.assessment?.epicId ?? null)),
    landing: outcome.landing.at === null ? `Not landed: ${outcome.landing.detail}` : `Landed ${outcome.landing.at}: ${outcome.landing.detail}`,
    results: outcome.comparisons.map((comparison) => resultRow(comparison, outcome)),
    caveat: outcome.caveat
  }
}

export function experimentRow(experiment: RetroExperiment, outcome: ExperimentOutcome | undefined, lookup: RetroLookup): ExperimentRow {
  const { baseline, expectedChange, window } = experiment
  const { subject } = experiment.source
  return {
    id: experiment.id,
    concern: experiment.concern === undefined ? 'Concern not stated' : CONCERN_LABELS[experiment.concern],
    source: sourceText(experiment),
    sourceTicket: subject.level === 'ticket' ? lookup.ref(subject.id) : null,
    issue: experiment.issue.summary,
    evidence: experiment.issue.evidence.map((ref) => `${ref.kind} ${ref.id}${ref.detail === null ? '' : ` (${ref.detail})`}`),
    hypothesis: experiment.hypothesis,
    destination: routeText(correctionRoute(experiment.destination)),
    work: experiment.proposedWork.map((work) => ({ title: work.title, body: work.body, size: work.size === undefined ? null : SIZE_LABELS[work.size] })),
    baseline: `${baseline.measure} ${numberText(baseline.value)} ${baseline.unit} (${baseline.state})`,
    change: `${expectedChange.direction === 'increase' ? 'Increase' : 'Decrease'} by ${numberText(expectedChange.amount)} ${expectedChange.unit}`,
    guardrails: experiment.guardrails.map(
      (guardrail) => `${guardrail.measure} ${guardrail.comparator === 'at_least' ? 'at least' : 'at most'} ${numberText(guardrail.threshold)} ${guardrail.unit}`
    ),
    window: `Over the next ${window.count} ${window.count === 1 ? window.basis.slice(0, -1) : window.basis}`,
    outcome: outcome === undefined ? null : outcomeRow(outcome, lookup)
  }
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
    })),
    experiments: (retro.experiments ?? []).map((experiment) =>
      experimentRow(
        experiment,
        report.experimentOutcomes?.find((outcome) => outcome.experimentId === experiment.id),
        lookup
      )
    )
  }
}
