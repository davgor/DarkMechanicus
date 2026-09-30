import type { SprintReportInput } from '../../shared/domain/api'
import type { PlanBundle, SprintDef } from '../../shared/domain/bundle'
import type { RunState } from '../../shared/domain/status'
import type { SprintReportContent, SprintReportView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import { contentHash } from '../canonical'
import type { Ctx } from '../context'
import { toJson } from '../db/database'
import { fail } from '../errors'
import { appendEvent } from './events'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { enqueueOutbox } from './outbox'
import { indexDocument } from './searchIndex'

/** The run columns checkpoint, report, and adoption rules read. */
export interface RunRow {
  id: string
  epic_id: string
  number: number
  revision_id: string
  state: RunState
  active_sprint_id: string | null
  owner_machine_id: string
  auto_continue: number
}

interface ReportRow {
  id: string
  run_id: string
  sprint_id: string
  report_revision: number
  content_json: string
  content_hash: string
  submitted_by: string | null
  created_at: string
}

export function loadRun(ctx: Ctx, runId: string): RunRow {
  const run = ctx.db.get<RunRow>(
    `SELECT id, epic_id, number, revision_id, state, active_sprint_id, owner_machine_id, auto_continue
     FROM runs WHERE id = ?`,
    runId
  )
  if (!run) {
    fail('not_found', `Run ${runId} not found.`, { runId })
  }
  return run
}

/** Execution commands only run on the machine that owns the run (imported runs need a takeover). */
export function requireOwnedRun(ctx: Ctx, run: RunRow): void {
  if (run.owner_machine_id !== ctx.machineId) {
    fail('run_not_owned', 'This run belongs to another machine; take it over first.', { runId: run.id })
  }
}

/** The immutable plan bundle of a saved revision (a run's pinned revision). */
export function loadBundle(ctx: Ctx, revisionId: string): PlanBundle {
  const row = ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM plan_revisions WHERE id = ?', revisionId)
  if (!row) {
    fail('not_found', `Plan revision ${revisionId} not found.`, { revisionId })
  }
  return JSON.parse(row.bundle_json) as PlanBundle
}

export function setRunState(ctx: Ctx, runId: string, state: RunState): void {
  ctx.db.run(
    'UPDATE runs SET state = ?, updated_at = ?, revision = revision + 1 WHERE id = ?',
    state,
    ctx.clock.nowIso(),
    runId
  )
}

function reportView(row: ReportRow): SprintReportView {
  return {
    id: row.id,
    runId: row.run_id,
    sprintId: row.sprint_id,
    reportRevision: row.report_revision,
    contentHash: row.content_hash,
    report: JSON.parse(row.content_json) as SprintReportContent,
    submittedBy: row.submitted_by,
    createdAt: row.created_at
  }
}

/** The newest report revision for one sprint of a run, or null when none was submitted. */
export function latestReport(ctx: Ctx, runId: string, sprintId: string): SprintReportView | null {
  const row = ctx.db.get<ReportRow>(
    `SELECT * FROM sprint_reports WHERE run_id = ? AND sprint_id = ?
     ORDER BY report_revision DESC LIMIT 1`,
    runId,
    sprintId
  )
  return row ? reportView(row) : null
}

function listOr<T>(items: T[] | undefined): T[] {
  return items ?? []
}

function normalizeReport(input: SprintReportInput): SprintReportContent {
  return {
    summary: input.summary,
    accepted: listOr(input.accepted),
    failed: listOr(input.failed),
    blocked: listOr(input.blocked),
    changes: { files: listOr(input.changes?.files), commits: listOr(input.changes?.commits) },
    checks: listOr(input.checks),
    risks: listOr(input.risks),
    followUps: listOr(input.followUps),
    exitCriteria: listOr(input.exitCriteria),
    epicOutcome: input.epicOutcome ?? null
  }
}

function requireReportable(run: RunRow): void {
  if (run.state !== 'running' && run.state !== 'awaiting_checkpoint') {
    fail(
      'run_not_active',
      `Run #${run.number} is ${run.state}; sprint reports are accepted while it runs or awaits a checkpoint.`,
      { runId: run.id, state: run.state }
    )
  }
}

function requireActiveSprint(run: RunRow, bundle: PlanBundle, sprintId: string): SprintDef {
  const active = bundle.sprints.find((sprint) => sprint.id === run.active_sprint_id)
  if (active === undefined) {
    fail('conflict', `Run #${run.number} has no active sprint.`, { runId: run.id })
  }
  if (active.id !== sprintId) {
    fail(
      'conflict',
      `Reports go to the active sprint, Sprint ${active.ordinal} (${active.id}); ${sprintId} is not active.`,
      { sprintId, activeSprintId: active.id }
    )
  }
  return active
}

function insertReport(ctx: Ctx, run: RunRow, sprintId: string, content: SprintReportContent): SprintReportView {
  const previous = ctx.db.get<{ latest: number | null }>(
    'SELECT MAX(report_revision) AS latest FROM sprint_reports WHERE run_id = ? AND sprint_id = ?',
    run.id,
    sprintId
  )
  const row: ReportRow = {
    id: ctx.ids.next('report'),
    run_id: run.id,
    sprint_id: sprintId,
    report_revision: (previous?.latest ?? 0) + 1,
    content_json: toJson(content),
    content_hash: contentHash(content),
    submitted_by: ctx.session.id,
    created_at: ctx.clock.nowIso()
  }
  ctx.db.run(
    `INSERT INTO sprint_reports (id, run_id, sprint_id, report_revision, content_json, content_hash, submitted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.run_id,
    row.sprint_id,
    row.report_revision,
    row.content_json,
    row.content_hash,
    row.submitted_by,
    row.created_at
  )
  return reportView(row)
}

function searchBody(report: SprintReportContent): string {
  return [
    report.summary,
    ...report.risks,
    ...report.followUps.flatMap((followUp) => [followUp.title, followUp.body]),
    ...report.checks.flatMap((check) => [check.name, check.detail]),
    report.epicOutcome?.summary ?? ''
  ]
    .filter((part) => part !== '')
    .join('\n')
}

/** One search document per sprint report: earlier revisions of the same sprint are replaced. */
function indexReport(ctx: Ctx, run: RunRow, sprint: SprintDef, view: SprintReportView): void {
  ctx.db.run(
    `DELETE FROM search_index WHERE doc_type = 'report'
     AND doc_id IN (SELECT id FROM sprint_reports WHERE run_id = ? AND sprint_id = ?)`,
    run.id,
    sprint.id
  )
  indexDocument(ctx.db, {
    docType: 'report',
    docId: view.id,
    epicId: run.epic_id,
    runId: run.id,
    ticketId: null,
    title: `Sprint ${sprint.ordinal} report`,
    body: searchBody(view.report)
  })
}

interface SubmitSprintReportInput {
  runId: string
  sprintId: string
  report: SprintReportInput
  idempotencyKey?: string
}

/**
 * Stores report revision n+1 for the run's active sprint (content hash recorded) and moves a
 * running run to `awaiting_checkpoint`; no new claims are made while a checkpoint is pending.
 */
export function submitSprintReport(ctx: Ctx, input: SubmitSprintReportInput): SprintReportView {
  requireCapability(ctx.session, 'report.submit')
  const scope = { command: 'submitSprintReport', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => {
    const run = loadRun(ctx, input.runId)
    requireOwnedRun(ctx, run)
    requireReportable(run)
    const sprint = requireActiveSprint(run, loadBundle(ctx, run.revision_id), input.sprintId)
    const view = insertReport(ctx, run, sprint.id, normalizeReport(input.report))
    if (run.state === 'running') {
      setRunState(ctx, run.id, 'awaiting_checkpoint')
    }
    appendEvent(ctx, {
      kind: 'report.submitted',
      epicId: run.epic_id,
      runId: run.id,
      payload: { sprintId: sprint.id, reportRevision: view.reportRevision }
    })
    enqueueOutbox(ctx, { kind: 'run_history', epicId: run.epic_id, runId: run.id })
    indexReport(ctx, run, sprint, view)
    return view
  })
}

/** Latest report revision for `sprintId` (default: the run's active sprint), or null. */
export function getSprintReport(ctx: Ctx, input: { runId: string; sprintId?: string }): SprintReportView | null {
  requireCapability(ctx.session, 'read')
  const run = loadRun(ctx, input.runId)
  const sprintId = input.sprintId ?? run.active_sprint_id
  return sprintId === null ? null : latestReport(ctx, run.id, sprintId)
}
