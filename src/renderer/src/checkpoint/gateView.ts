/** Pure view model for the sprint checkpoint: report sections, gate conditions and actions. */
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
  SprintIncrement,
  SprintReportView
} from '../../../shared/domain/views'
import { formatAgo } from '../epic/time'
import { nextSprintPlan, type DiscoveryItem, type LeftoverItem, type NextSprintPlan } from './nextSprint'
import type { RedraftPanel } from './redraftView'
import { retroSections, type RetroLookup, type RetroSections, type TicketRef } from './retroView'

interface GateInput {
  checkpoint: CheckpointView
  run: RunView
  /** The plan the run executes (for keys, goals and optional flags); null when unavailable. */
  bundle: PlanBundle | null
  /** The draft's redraft, when it holds changes: approving then saves and adopts it first. */
  redraft?: RedraftPanel | null
}

interface RetryAction {
  ticketId: string
  label: string
}

/** A gate condition, flagged when the approval itself is what meets it (the plan gate while a redraft waits). */
export type GateRow = GateCondition & { resolvedByApproval?: true }

export interface GateView {
  title: string
  conditions: GateRow[]
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

/** One check made on a report (a sprint check or an increment check), with the glyph that goes beside its words. */
export interface ReportCheck {
  name: string
  status: CheckStatus
  detail: string
  icon: string
}

/** The commit that landed a sprint on the epic branch, as the server verified it when the acceptance node was submitted. */
export interface IncrementSection {
  heading: string
  /** The acceptance node that named it. */
  key: string
  /** The commit as 7 characters of its hash (exactly as named when git did not resolve it). */
  commit: string
  fullCommit: string
  branch: string
  passed: boolean
  verdict: string
  /** What the commit had to follow, as text for the "after" row. */
  base: string
  /** Why it did not pass; empty when it did. */
  reasons: string[]
  checks: ReportCheck[]
}

export interface ReportSections {
  header: string
  summary: string
  accepted: ReportRow[]
  failed: ReportRow[]
  blocked: ReportRow[]
  changes: { files: string[]; commits: string[] }
  /** The sprint's increment; null when its acceptance node named none. */
  increment: IncrementSection | null
  checks: ReportCheck[]
  risks: string[]
  exitCriteria: CriterionLine[]
  followUps: FollowUpProposal[]
  outcome: { summary: string; criteria: CriterionLine[] } | null
  /** The sprint demo and retro; null for a report written without one. */
  retro: RetroSections | null
}

const AUTO_NOTE =
  'Sprints whose checkpoint policy is "auto" advance on their own once every gate is met. Human-gated sprints still wait for you. Applies to this run only; imported runs never carry it.'
const CHECK_ICONS: Record<CheckStatus, string> = { passed: '✓', failed: '✗', skipped: '–' }

function gateTitle(checkpoint: CheckpointView, ready: boolean, redraft: RedraftPanel | null): string {
  const next = checkpoint.sprintOrdinal + 1
  if (redraft !== null && ready) {
    return 'Ready to approve the retro and the redraft'
  }
  if (checkpoint.isFinalSprint) {
    return ready ? 'Ready to complete the epic' : "The epic can't complete yet"
  }
  return ready ? `Ready to advance to Sprint ${next}` : `Sprint ${next} can't start yet`
}

function approveLabel(checkpoint: CheckpointView, redraft: RedraftPanel | null): string {
  if (redraft !== null) {
    return 'Approve retro & redraft'
  }
  return checkpoint.isFinalSprint ? 'Approve & complete epic' : `Approve & advance to Sprint ${checkpoint.sprintOrdinal + 1}`
}

/** What a waiting redraft does about an unmet gate: it meets the plan gate and, by moving the leftovers on, the required-tickets gate. */
function resolution(item: GateCondition, redraft: RedraftPanel): string | null {
  if (item.met) {
    return null
  }
  if (item.id === 'plan_current') {
    return redraft.gateDetail
  }
  return item.id === 'required_accepted' && redraft.clearsRequired ? `Moved to the next sprint by the redraft: ${item.detail}` : null
}

/** While a redraft waits, the approval itself meets those gates: it saves the draft, adopts it into the run and checks again. */
function gateRows(conditions: GateCondition[], redraft: RedraftPanel | null): GateRow[] {
  if (redraft === null) {
    return conditions
  }
  return conditions.map((item) => {
    const detail = resolution(item, redraft)
    return detail === null ? item : { ...item, detail, resolvedByApproval: true as const }
  })
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
  const redraft = input.redraft ?? null
  const conditions = gateRows(checkpoint.conditions.filter((item) => item.id !== 'approval'), redraft)
  const retries = retryActions(input)
  const unmet = conditions.filter((item) => !item.met && item.resolvedByApproval !== true).length
  const ready = redraft === null ? checkpoint.gatesMet : unmet === 0 && redraft.blocked === null
  return {
    title: gateTitle(checkpoint, ready, redraft),
    conditions,
    approveLabel: approveLabel(checkpoint, redraft),
    approveEnabled: ready && checkpoint.report !== null,
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

/** A ticket key such as `DM-12` at the start of an entry, then the separator before the rest of the sentence. */
const LEADING_KEY = /^([A-Z][A-Z0-9]{0,11}-\d+)(?![\w-])[\s:–—-]*/

/**
 * An entry is a bare ticket id or key, or a sentence the agent wrote. A sentence that starts with a
 * ticket key keeps the key in the key column (linked when the plan has it) and the rest as text;
 * any other sentence has no key, so it never lands in the narrow key column.
 */
function resolveRow(entry: string, bundle: PlanBundle | null): ReportRow {
  const tickets = bundle?.tickets ?? []
  const found = tickets.find((item) => item.id === entry || item.key === entry)
  if (found) {
    return { ticketId: found.id, key: found.key, title: found.title, detail: '' }
  }
  const text = entry.trim()
  if (!/\s/.test(text)) {
    return { ticketId: null, key: text, title: '', detail: '' }
  }
  const lead = LEADING_KEY.exec(text)
  if (lead === null) {
    return { ticketId: null, key: '', title: text, detail: '' }
  }
  const key = lead[1] ?? ''
  const named = tickets.find((item) => item.key === key)
  return { ticketId: named?.id ?? null, key, title: text.slice(lead[0].length), detail: '' }
}

function attemptsOf(run: RunView, ticketId: string | null): AttemptView[] {
  return run.attempts.filter((item) => item.ticketId === ticketId && !item.superseded).sort((a, b) => b.number - a.number)
}

/** A leading 7 to 40 character commit hash, only when it ends the entry or is followed by whitespace. */
const LEADING_HASH = /^([0-9a-f]{7})[0-9a-f]{0,33}(?=\s|$)/

/** The commit as 7 characters of its hash, keeping any text after it, e.g. "abc1234 (squash of 3)". */
function shortHash(commit: string): string {
  return commit.replace(LEADING_HASH, '$1')
}

function baseText(base: SprintIncrement['base']): string {
  const commit = base.commit === null ? '' : shortHash(base.commit)
  switch (base.kind) {
    case 'previous_increment':
      return commit === '' ? "the previous sprint's increment" : `${commit} · previous sprint's increment`
    case 'epic_start':
      return commit === '' ? 'the epic start commit' : `${commit} · epic start commit`
    case 'none':
      return 'no earlier increment or epic start commit to follow'
  }
}

function incrementSection(report: SprintReportView): IncrementSection | null {
  const view = report.increment
  if (view === undefined) {
    return null
  }
  const { increment } = view
  return {
    heading: `INCREMENT · SPRINT ${view.sprintOrdinal}`,
    key: view.key,
    commit: shortHash(increment.commit),
    fullCommit: increment.commit,
    branch: increment.branch,
    passed: increment.passed,
    verdict: increment.passed ? 'VERIFIED' : 'NOT VERIFIED',
    base: baseText(increment.base),
    reasons: increment.reasons,
    checks: increment.checks.map((check) => ({ ...check, icon: CHECK_ICONS[check.status] }))
  }
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

/** How the retro names a ticket (as a report entry does, linked when the plan has it) and which leftovers the run has since accepted. */
function retroLookup(context: ReportContext): RetroLookup {
  return {
    ref: (ticketId): TicketRef => {
      const { ticketId: id, key, title } = resolveRow(ticketId, context.bundle)
      return { ticketId: id, key, title }
    },
    accepted: (ticketId) => attemptsOf(context.run, ticketId).some((item) => item.state === 'accepted')
  }
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
    blocked: content.blocked.map((entry) => resolveRow(entry, bundle)),
    changes: {
      files: content.changes.files,
      commits: content.changes.commits.map(shortHash)
    },
    increment: incrementSection(report),
    checks: content.checks.map((check) => ({ ...check, icon: CHECK_ICONS[check.status] })),
    risks: content.risks,
    exitCriteria: criterionLines(content.exitCriteria, exit),
    followUps: content.followUps,
    outcome:
      outcome === null
        ? null
        : { summary: outcome.summary, criteria: criterionLines(outcome.successCriteria, bundle?.epic.successCriteria ?? []) },
    retro: retroSections(report, retroLookup(context))
  }
}

/** What a checkpoint item does to the draft: a report follow-up, a retro discovery or a retro leftover. */
export type NextSprintItem = (FollowUpProposal & { kind?: 'follow_up' }) | DiscoveryItem | LeftoverItem

/**
 * The draft ops behind "+ Add to draft" (a new ticket in the sprint after this checkpoint, or the last
 * sprint), "+ Add to next sprint" (a discovery) and "Move to next sprint" (a leftover). The last two go to a
 * sprint added for them when the checkpoint's is the last.
 */
export function followUpOp(item: NextSprintItem, draft: PlanBundle, checkpointOrdinal: number): NextSprintPlan | null {
  if (item.kind === 'discovery' || item.kind === 'leftover') {
    return nextSprintPlan(item, draft, checkpointOrdinal)
  }
  const sprints = [...draft.sprints].sort((a, b) => a.ordinal - b.ordinal)
  const target = sprints.find((entry) => entry.ordinal === checkpointOrdinal + 1) ?? sprints[sprints.length - 1]
  if (!target) {
    return null
  }
  return {
    sprintOrdinal: target.ordinal,
    moved: [],
    ops: [{ op: 'add_ticket', sprint: target.id, ticket: { title: item.title, body: item.body } }]
  }
}
