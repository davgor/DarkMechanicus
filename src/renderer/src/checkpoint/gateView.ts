/** Pure view model for the sprint checkpoint: report sections, gate conditions and actions. */
import type { DraftOp } from '../../../shared/domain/api'
import type { Criterion, PlanBundle } from '../../../shared/domain/bundle'
import { isActiveRunState } from '../../../shared/domain/status'
import type {
  AttemptView,
  Blocker,
  CheckpointView,
  CheckStatus,
  CriterionResult,
  FollowUpProposal,
  GateCondition,
  RunView,
  SprintReportView
} from '../../../shared/domain/views'
import { formatAgo } from '../epic/time'

interface GateInput {
  checkpoint: CheckpointView
  run: RunView
  /** The plan the run executes (for keys, goals and optional flags); null when unavailable. */
  bundle: PlanBundle | null
}

interface RetryAction {
  ticketId: string
  label: string
}

export interface GateView {
  title: string
  conditions: GateCondition[]
  approveLabel: string
  approveEnabled: boolean
  blockedNote: string | null
  retries: RetryAction[]
  autoContinue: { checked: boolean; available: boolean; note: string }
}

export interface ReportRow {
  ticketId: string | null
  key: string
  title: string
  detail: string
}

export interface CriterionLine {
  text: string
  met: boolean
  note: string
}

export interface ReportSections {
  header: string
  summary: string
  accepted: ReportRow[]
  failed: ReportRow[]
  checks: { name: string; status: CheckStatus; detail: string; icon: string }[]
  risks: string[]
  exitCriteria: CriterionLine[]
  followUps: FollowUpProposal[]
  outcome: { summary: string; criteria: CriterionLine[] } | null
}

const AUTO_NOTE =
  'Sprints whose checkpoint policy is "auto" advance on their own once every gate is met. Human-gated sprints still wait for you. Applies to this run only; imported runs never carry it.'
const CHECK_ICONS: Record<CheckStatus, string> = { passed: '✓', failed: '✗', skipped: '–' }

function gateTitle(checkpoint: CheckpointView): string {
  const next = checkpoint.sprintOrdinal + 1
  if (checkpoint.isFinalSprint) {
    return checkpoint.gatesMet ? 'Ready to complete the epic' : "The epic can't complete yet"
  }
  return checkpoint.gatesMet ? `Ready to advance to Sprint ${next}` : `Sprint ${next} can't start yet`
}

function retryActions(input: GateInput): RetryAction[] {
  const optional = new Set((input.bundle?.tickets ?? []).filter((item) => item.optional).map((item) => item.id))
  return input.run.tickets
    .filter((item) => item.sprintId === input.checkpoint.sprintId && item.state === 'failed' && !optional.has(item.ticketId))
    .map((item) => ({ ticketId: item.ticketId, label: `Retry ${item.key}` }))
}

function blockedNote(unmet: number, retries: RetryAction[]): string | null {
  if (unmet === 0) {
    return null
  }
  const lead = `Blocked by ${unmet} gate ${unmet === 1 ? 'condition' : 'conditions'}.`
  if (retries.length === 0) {
    return lead
  }
  const keys = retries.map((item) => item.label.replace('Retry ', '')).join(' or ')
  const pronoun = retries.length === 1 ? "it's" : "they're"
  return `${lead} Retry ${keys} or edit the plan so ${pronoun} no longer required.`
}

export function gateView(input: GateInput): GateView {
  const { checkpoint, run } = input
  const conditions = checkpoint.conditions.filter((item) => item.id !== 'approval')
  const retries = retryActions(input)
  const unmet = conditions.filter((item) => !item.met).length
  return {
    title: gateTitle(checkpoint),
    conditions,
    approveLabel: checkpoint.isFinalSprint
      ? 'Approve & complete epic'
      : `Approve & advance to Sprint ${checkpoint.sprintOrdinal + 1}`,
    approveEnabled: checkpoint.gatesMet && checkpoint.report !== null,
    blockedNote: blockedNote(unmet, retries),
    retries,
    autoContinue: {
      checked: run.autoContinue,
      available: run.ownedByThisMachine && isActiveRunState(run.state),
      note: AUTO_NOTE
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Report

interface ReportContext {
  run: RunView
  bundle: PlanBundle | null
  now: number
}

function resolveRow(entry: string, bundle: PlanBundle | null): ReportRow {
  const found = bundle?.tickets.find((item) => item.id === entry || item.key === entry)
  return found
    ? { ticketId: found.id, key: found.key, title: found.title, detail: '' }
    : { ticketId: null, key: entry, title: '', detail: '' }
}

function attemptsOf(run: RunView, ticketId: string | null): AttemptView[] {
  return run.attempts.filter((item) => item.ticketId === ticketId && !item.superseded).sort((a, b) => b.number - a.number)
}

function acceptedCommit(run: RunView, ticketId: string | null): string {
  const accepted = attemptsOf(run, ticketId).find((item) => item.state === 'accepted')
  return (accepted?.outputs?.commits[0] ?? '').slice(0, 7)
}

function lastProblem(run: RunView, ticketId: string | null): string {
  const latest = attemptsOf(run, ticketId).find((item) => item.state === 'failed' || item.state === 'rejected')
  return latest?.failure?.reason ?? latest?.decision?.reasons[0] ?? ''
}

function attemptPart(count: number, limit: number | undefined): string {
  return limit === undefined ? `attempt ${count}` : `attempt ${count} of ${limit}`
}

function failedDetail(context: ReportContext, ticketId: string | null): string {
  const execution = context.run.tickets.find((item) => item.ticketId === ticketId)
  if (!execution) {
    return ''
  }
  const limitBlocker = execution.blockers.find(
    (item): item is Extract<Blocker, { kind: 'retry_limit' }> => item.kind === 'retry_limit'
  )
  const limit = limitBlocker?.limit ?? context.bundle?.policies.retryLimit
  return [
    attemptPart(execution.attemptCount, limit),
    lastProblem(context.run, ticketId),
    limitBlocker ? 'retry limit reached' : ''
  ]
    .filter((part) => part !== '')
    .join(' · ')
}

/** Each reported result beside its criterion text (the id when the plan has no such criterion). */
export function criterionLines(results: CriterionResult[], criteria: Criterion[]): CriterionLine[] {
  const texts = new Map(criteria.map((item) => [item.id, item.text]))
  return results.map((result) => ({ text: texts.get(result.criterionId) ?? result.criterionId, met: result.met, note: result.note }))
}

function reportHeader(report: SprintReportView, context: ReportContext): string {
  const sprintDef = context.bundle?.sprints.find((item) => item.id === report.sprintId)
  const goal = sprintDef === undefined || sprintDef.goal.trim() === '' ? '' : ` · ${sprintDef.goal.toUpperCase()}`
  const author = (report.submittedBy ?? 'an agent').toUpperCase()
  const when = formatAgo(report.createdAt, context.now).toUpperCase()
  return `SPRINT ${sprintDef?.ordinal ?? '?'} REPORT${goal} · WRITTEN BY ${author} ${when}`
}

export function reportView(report: SprintReportView, context: ReportContext): ReportSections {
  const content = report.report
  const bundle = context.bundle
  const exit = bundle?.sprints.find((item) => item.id === report.sprintId)?.exitCriteria ?? []
  const outcome = content.epicOutcome
  return {
    header: reportHeader(report, context),
    summary: content.summary,
    accepted: content.accepted.map((entry) => {
      const row = resolveRow(entry, bundle)
      return { ...row, detail: acceptedCommit(context.run, row.ticketId) }
    }),
    failed: content.failed.map((entry) => {
      const row = resolveRow(entry, bundle)
      return { ...row, detail: failedDetail(context, row.ticketId) }
    }),
    checks: content.checks.map((check) => ({ ...check, icon: CHECK_ICONS[check.status] })),
    risks: content.risks,
    exitCriteria: criterionLines(content.exitCriteria, exit),
    followUps: content.followUps,
    outcome:
      outcome === null
        ? null
        : { summary: outcome.summary, criteria: criterionLines(outcome.successCriteria, bundle?.epic.successCriteria ?? []) }
  }
}

/** "+ Add to draft": a new ticket in the sprint after this checkpoint (or the last sprint). */
export function followUpOp(
  proposal: FollowUpProposal,
  draft: PlanBundle,
  checkpointOrdinal: number
): { op: DraftOp; sprintOrdinal: number } | null {
  const sprints = [...draft.sprints].sort((a, b) => a.ordinal - b.ordinal)
  const target = sprints.find((item) => item.ordinal === checkpointOrdinal + 1) ?? sprints[sprints.length - 1]
  if (!target) {
    return null
  }
  return {
    sprintOrdinal: target.ordinal,
    op: { op: 'add_ticket', sprint: target.id, ticket: { title: proposal.title, body: proposal.body } }
  }
}
