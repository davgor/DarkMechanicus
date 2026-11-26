/**
 * The sprint learning evidence snapshot: every negative fact one sprint of one run left behind, collected from the
 * run's pinned plan revision, its attempts and row checks, and the sprint's latest report revision. Read-only.
 *
 * Each item quotes the stored text it rests on (`statements`, with the field it came from) and adds nothing of its
 * own, so a learning card is generated from facts rather than a reporter's paraphrase. Every source item is kept,
 * including superseded attempts and row checks a later check replaced (`standing: false`); classification happens on
 * the card. Collecting unchanged state twice gives the same bytes: nothing reads the clock, and items are ordered by
 * kind, time and source id.
 */
import type { PlanBundle, SprintDef, TicketContent } from '../../shared/domain/bundle'
import {
  isSafeLearningPath,
  LEARNING_EVIDENCE_KINDS,
  type LearningEvidenceItem,
  type LearningEvidenceSnapshot,
  type LearningSourceKind
} from '../../shared/domain/learnings'
import type { AttemptDecision, AttemptEvidence, AttemptFailure, AttemptOutputs, CheckResult, SprintIncrement } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import { contentHash } from '../canonical'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { fail } from '../errors'
import { isAcceptanceTicket } from '../plan/acceptance'
import { planRows } from '../plan/graph'
import { filledReportContent } from '../repo/portable'
import { type AttemptRow, loadBundle, requireRun, type RowCheckRow, type RunRow, rowCheckView } from './execution'

type Statement = LearningEvidenceItem['statements'][number]
type Provenance = LearningEvidenceItem['provenance']
type ItemDraft = Omit<LearningEvidenceItem, 'contentHash' | 'fingerprint'>

interface ReportRow {
  id: string
  report_revision: number
  content_json: string
  content_hash: string
  created_at: string
}

/** What every collector of one sprint reads. */
interface Scope {
  run: RunRow
  bundle: PlanBundle
  sprint: SprintDef
  /** The sprint's tickets in the pinned revision, by id. */
  tickets: Map<string, TicketContent>
}

/** Stored text as written; an absent or blank text says nothing and yields no statement. */
function said(field: string, text: string | null | undefined): Statement[] {
  return text === null || text === undefined || text.trim() === '' ? [] : [{ field, text }]
}

/** The name, status and detail of every check entry that did not pass. */
function unpassedChecks(field: string, checks: readonly CheckResult[] | undefined): Statement[] {
  return (checks ?? [])
    .filter((check) => check.status !== 'passed')
    .flatMap((check) => [...said(`${field}.name`, check.name), ...said(`${field}.status`, check.status), ...said(`${field}.detail`, check.detail)])
}

/** Case, Unicode form and whitespace differences do not make a different lesson. */
function normalized(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
}

function finished(draft: ItemDraft): LearningEvidenceItem {
  const fingerprint = contentHash({
    kind: draft.kind,
    statements: draft.statements.map((statement) => ({ field: statement.field, text: normalized(statement.text) }))
  })
  return { ...draft, fingerprint, contentHash: contentHash({ ...draft, fingerprint }) }
}

function provenance(scope: Scope, patch: Partial<Provenance>): Provenance {
  return {
    runId: scope.run.id,
    sprintId: scope.sprint.id,
    revisionId: scope.run.revision_id,
    ticketId: null,
    ticketKey: null,
    attemptId: null,
    attemptNumber: null,
    rowCheckId: null,
    row: null,
    checkNumber: null,
    reportId: null,
    reportRevision: null,
    ...patch
  }
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

function ticketRepositories(tickets: readonly (TicketContent | undefined)[]): string[] {
  return sortedUnique(tickets.flatMap((ticket) => (ticket?.repo === undefined ? [] : [ticket.repo])))
}

interface ParsedAttempt {
  row: AttemptRow
  ticket: TicketContent | undefined
  decision: AttemptDecision | null
  evidence: AttemptEvidence | null
  failure: AttemptFailure | null
  outputs: AttemptOutputs | null
}

function parsedAttempt(scope: Scope, row: AttemptRow): ParsedAttempt {
  return {
    row,
    ticket: scope.tickets.get(row.ticket_id),
    decision: parseJson<AttemptDecision | null>(row.decision_json, null),
    evidence: parseJson<AttemptEvidence | null>(row.evidence_json, null),
    failure: parseJson<AttemptFailure | null>(row.failure_json, null),
    outputs: parseJson<AttemptOutputs | null>(row.outputs_json, null)
  }
}

/** What the attempt's worker reported about its own work: its notes, unmet criteria and unpassed checks. */
function workerStatements(attempt: ParsedAttempt): Statement[] {
  const evidence = attempt.evidence
  if (evidence === null) return []
  return [
    ...said('evidence.notes', evidence.notes),
    ...(evidence.criteria ?? []).filter((criterion) => !criterion.met).flatMap((criterion) => said(`evidence.criteria.${criterion.criterionId}`, criterion.note)),
    ...unpassedChecks('evidence.checks', evidence.checks)
  ]
}

function failureStatements(attempt: ParsedAttempt): Statement[] {
  return attempt.failure === null ? [] : [...said('failure.reason', attempt.failure.reason), ...said('failure.details', attempt.failure.details)]
}

/** What one attempt item says beyond the attempt itself: its kind, when it happened and its quoted texts. */
interface AttemptFact {
  kind: LearningSourceKind
  occurredAt: string
  statements: Statement[]
}

function attemptItem(scope: Scope, attempt: ParsedAttempt, fact: AttemptFact): LearningEvidenceItem {
  const { row, ticket } = attempt
  return finished({
    ...fact,
    sourceId: row.id,
    standing: row.superseded_at === null,
    provenance: provenance(scope, { ticketId: row.ticket_id, ticketKey: ticket?.key ?? null, attemptId: row.id, attemptNumber: row.number }),
    repositories: ticketRepositories([ticket]),
    paths: sortedUnique((attempt.outputs?.changedFiles ?? []).filter(isSafeLearningPath)),
  })
}

/** Rejected, failed (or expired and not yet reconciled) and reconciled work attempts of the sprint's tickets. */
function attemptItems(scope: Scope, attempts: readonly ParsedAttempt[]): LearningEvidenceItem[] {
  return attempts.flatMap((attempt) => {
    const { row, decision } = attempt
    const items: LearningEvidenceItem[] = []
    if (row.state === 'rejected') {
      const reasons = (decision?.reasons ?? []).flatMap((reason) => said('decision.reasons', reason))
      const statements = [...reasons, ...said('decision.notes', decision?.notes), ...workerStatements(attempt)]
      items.push(attemptItem(scope, attempt, { kind: 'rejected_attempt', occurredAt: row.decided_at ?? row.updated_at, statements }))
    }
    if (row.state === 'failed' || (row.state === 'lease_expired' && row.reconciled_at === null)) {
      items.push(attemptItem(scope, attempt, { kind: 'failed_attempt', occurredAt: row.updated_at, statements: [...failureStatements(attempt), ...workerStatements(attempt)] }))
    }
    if (row.reconciled_at !== null) {
      items.push(attemptItem(scope, attempt, { kind: 'reconciled_attempt', occurredAt: row.reconciled_at, statements: [...failureStatements(attempt), ...workerStatements(attempt)] }))
    }
    return items
  })
}

/**
 * Every failed row check of the sprint. Only a row's latest check stands; an earlier failure a later check (such as
 * an accepted rerun) replaced stays as history with `standing: false`.
 */
function rowCheckItems(ctx: Ctx, scope: Scope): LearningEvidenceItem[] {
  const checks = ctx.db
    .all<RowCheckRow>('SELECT * FROM row_checks WHERE run_id = ? AND sprint_id = ? ORDER BY number', scope.run.id, scope.sprint.id)
    .map(rowCheckView)
  const latest = new Map(checks.map((check) => [check.row, check.number]))
  const rowTickets = new Map(
    planRows(scope.bundle)
      .filter((row) => row.sprintId === scope.sprint.id)
      .map((row) => [row.row, row.ticketIds.map((id) => scope.tickets.get(id))] as const)
  )
  return checks
    .filter((check) => !check.passed)
    .map((check) =>
      finished({
        kind: 'failed_row_check',
        sourceId: check.id,
        occurredAt: check.createdAt,
        standing: latest.get(check.row) === check.number,
        provenance: provenance(scope, { rowCheckId: check.id, row: check.row, checkNumber: check.number }),
        repositories: ticketRepositories(rowTickets.get(check.row) ?? []),
        paths: [],
        statements: [...said('commit', check.commit), ...unpassedChecks('checks', check.checks)]
      })
    )
}

interface CheckSource {
  sourceId: string
  occurredAt: string
  standing: boolean
  provenance: Provenance
  repositories: string[]
  checks: readonly CheckResult[]
}

function checkItems(source: CheckSource): LearningEvidenceItem[] {
  return source.checks.flatMap((check, index) =>
    check.status === 'passed'
      ? []
      : [
          finished({
            kind: 'failed_acceptance_check',
            sourceId: `${source.sourceId}/${index}`,
            occurredAt: source.occurredAt,
            standing: source.standing,
            provenance: source.provenance,
            repositories: source.repositories,
            paths: [],
            statements: unpassedChecks('check', [check])
          })
        ]
  )
}

/** The increment verdicts an acceptance node's submission stored: one, or one per repository in a folder. */
function incrementsOf(row: AttemptRow): { path: string; increment: SprintIncrement }[] {
  const stored = parseJson<SprintIncrement | SprintIncrement[] | null>(row.increment_json, null)
  if (stored === null) return []
  return Array.isArray(stored) ? stored.map((increment, index) => ({ path: `increments/${index}/checks`, increment })) : [{ path: 'increment.checks', increment: stored }]
}

/**
 * The failed and skipped checks of the sprint acceptance node's submissions: the worker's evidence and the server's
 * increment verdicts. Only the node's latest attempt stands; its earlier attempts stay as history.
 */
function acceptanceAttemptItems(scope: Scope, attempts: readonly ParsedAttempt[]): LearningEvidenceItem[] {
  const nodeAttempts = attempts.filter((attempt) => attempt.ticket !== undefined && isAcceptanceTicket(attempt.ticket) && attempt.row.kind === 'work')
  const latest = new Map<string, string>()
  for (const attempt of nodeAttempts) if (attempt.row.superseded_at === null) latest.set(attempt.row.ticket_id, attempt.row.id)
  return nodeAttempts.flatMap((attempt) => {
    const { row, ticket } = attempt
    const standing = latest.get(row.ticket_id) === row.id
    const origin = provenance(scope, { ticketId: row.ticket_id, ticketKey: ticket?.key ?? null, attemptId: row.id, attemptNumber: row.number })
    const evidence = checkItems({
      sourceId: `${row.id}/evidence.checks`,
      occurredAt: row.submitted_at ?? row.updated_at,
      standing,
      provenance: origin,
      repositories: ticketRepositories([ticket]),
      checks: attempt.evidence?.checks ?? []
    })
    const increments = incrementsOf(row).flatMap(({ path, increment }) =>
      checkItems({
        sourceId: `${row.id}/${path}`,
        occurredAt: increment.verifiedAt,
        standing,
        provenance: origin,
        repositories: increment.repo === undefined ? ticketRepositories([ticket]) : [increment.repo],
        checks: increment.checks
      })
    )
    return [...evidence, ...increments]
  })
}

/** The sprint's latest report revision: its unpassed checks and its retro's `wentPoorly` and `actions` entries. */
function reportItems(scope: Scope, report: ReportRow | undefined): LearningEvidenceItem[] {
  if (report === undefined) return []
  const content = filledReportContent(JSON.parse(report.content_json))
  const origin = provenance(scope, { reportId: report.id, reportRevision: report.report_revision })
  const retroList = (kind: LearningSourceKind, field: 'wentPoorly' | 'actions'): LearningEvidenceItem[] =>
    (content.retro?.[field] ?? []).flatMap((text, index) => {
      const statements = said(`retro.${field}`, text)
      return statements.length === 0
        ? []
        : [
            finished({
              kind,
              sourceId: `${report.id}/retro.${field}/${index}`,
              occurredAt: report.created_at,
              standing: true,
              provenance: origin,
              repositories: [],
              paths: [],
              statements
            })
          ]
    })
  return [
    ...checkItems({ sourceId: `${report.id}/checks`, occurredAt: report.created_at, standing: true, provenance: origin, repositories: [], checks: content.checks }),
    ...retroList('retro_went_poorly', 'wentPoorly'),
    ...retroList('retro_action', 'actions')
  ]
}

const KIND_ORDER = new Map(LEARNING_EVIDENCE_KINDS.map((kind, index) => [kind, index]))

function compareItems(a: LearningEvidenceItem, b: LearningEvidenceItem): number {
  const byKind = (KIND_ORDER.get(a.kind) ?? 0) - (KIND_ORDER.get(b.kind) ?? 0)
  if (byKind !== 0) return byKind
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1
  return a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0
}

/**
 * Collects the immutable learning evidence of one sprint of a run. A sprint without negative evidence (and one
 * without a report yet) gives a valid snapshot with no items, so generation stays one card per sprint.
 */
export function collectLearningEvidence(ctx: Ctx, input: { runId: string; sprintId: string }): LearningEvidenceSnapshot {
  requireCapability(ctx.session, 'read')
  const run = requireRun(ctx, input.runId)
  const bundle = loadBundle(ctx, run.revision_id)
  const sprint =
    bundle.sprints.find((item) => item.id === input.sprintId) ??
    fail('not_found', `Sprint ${input.sprintId} is not part of this run's pinned plan.`, { sprintId: input.sprintId })
  const sprintTicketIds = new Set(sprint.ticketIds)
  const tickets = new Map(bundle.tickets.filter((ticket) => sprintTicketIds.has(ticket.id)).map((ticket) => [ticket.id, ticket]))
  const scope: Scope = { run, bundle, sprint, tickets }
  const attempts = ctx.db
    .all<AttemptRow>('SELECT * FROM attempts WHERE run_id = ? ORDER BY rowid', run.id)
    .filter((row) => tickets.has(row.ticket_id))
    .map((row) => parsedAttempt(scope, row))
  const report = ctx.db.get<ReportRow>(
    `SELECT id, report_revision, content_json, content_hash, created_at FROM sprint_reports
     WHERE run_id = ? AND sprint_id = ? ORDER BY report_revision DESC LIMIT 1`,
    run.id,
    sprint.id
  )
  const items = [
    ...attemptItems(scope, attempts),
    ...rowCheckItems(ctx, scope),
    ...acceptanceAttemptItems(scope, attempts),
    ...reportItems(scope, report)
  ].sort(compareItems)
  const snapshot: Omit<LearningEvidenceSnapshot, 'contentHash'> = {
    formatVersion: 1,
    runId: run.id,
    sprintId: sprint.id,
    sprintOrdinal: sprint.ordinal,
    revisionId: run.revision_id,
    report:
      report === undefined
        ? null
        : { id: report.id, reportRevision: report.report_revision, contentHash: report.content_hash, createdAt: report.created_at },
    items
  }
  return { ...snapshot, contentHash: contentHash(snapshot) }
}
