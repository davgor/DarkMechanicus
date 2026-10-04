/**
 * Row checks: the orchestrator's record that one dependency row of a sprint (see `planRows`) combined
 * cleanly at a commit. They are recorded in `row_checks`, announced as a run event, and exported with
 * the run history. They only read back through readiness, which holds the dependents of a row whose
 * latest check did not pass.
 */
import type { RecordRowCheckInput } from '../../shared/domain/api'
import type { PlanBundle } from '../../shared/domain/bundle'
import { isActiveRunState } from '../../shared/domain/status'
import type { RowCheckView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { toJson } from '../db/database'
import { fail } from '../errors'
import { planRows } from '../plan/graph'
import { appendEvent } from './events'
import { loadBundle, type RowCheckRow, rowCheckView, type RunRow } from './execution'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { enqueueOutbox } from './outbox'
import { requireOwnedRun } from './runs'

function rowsLabel(count: number): string {
  if (count === 0) {
    return 'no rows'
  }
  return count === 1 ? '1 row' : `${count} rows`
}

/** The sprint and row must exist in the run's pinned plan, so a check can never name a row that is not there. */
function requireRow(bundle: PlanBundle, input: RecordRowCheckInput): void {
  const sprint =
    bundle.sprints.find((item) => item.id === input.sprintId) ??
    fail('not_found', `Sprint ${input.sprintId} is not part of this run's pinned plan.`, { sprintId: input.sprintId })
  const count = planRows(bundle).filter((item) => item.sprintId === sprint.id).length
  if (input.row > count) {
    fail('invalid_input', `Sprint ${sprint.ordinal} has ${rowsLabel(count)}; there is no row ${input.row}.`, {
      sprintId: sprint.id,
      row: input.row,
      rows: count
    })
  }
}

function insertRowCheck(ctx: Ctx, run: RunRow, input: RecordRowCheckInput): RowCheckRow {
  const id = ctx.ids.next('rowCheck')
  const last = ctx.db.get<{ number: number | null }>('SELECT MAX(number) AS number FROM row_checks WHERE run_id = ?', run.id)
  const checks = input.checks.map((check) => ({ name: check.name, status: check.status, detail: check.detail ?? '' }))
  ctx.db.run(
    `INSERT INTO row_checks (id, run_id, number, sprint_id, row_no, commit_ref, checks_json, recorded_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    run.id,
    (last?.number ?? 0) + 1,
    input.sprintId,
    input.row,
    input.commit,
    toJson(checks),
    ctx.session.label,
    ctx.clock.nowIso()
  )
  return ctx.db.get<RowCheckRow>('SELECT * FROM row_checks WHERE id = ?', id) ?? fail('internal', `Row check ${id} was not stored.`)
}

/**
 * Orchestrator: records a check of one row of a sprint at a commit. The check passes only when every
 * entry in `checks` passed; a failed or skipped entry fails it. The newest check of a row decides:
 * while it has not passed, every ticket that requires a ticket of that row is held back (state
 * `waiting`, blocker `row_check_failed`), and a later passing check clears the hold.
 */
export function recordRowCheck(ctx: Ctx, input: RecordRowCheckInput): RowCheckView {
  requireCapability(ctx.session, 'run.row_check')
  return withIdempotency(ctx, { command: 'recordRowCheck', key: input.idempotencyKey, request: requestWithoutKey(input) }, () => {
    const run = requireOwnedRun(ctx, input.runId)
    if (!isActiveRunState(run.state)) {
      fail('run_not_active', `The run is ${run.state}; row checks need an active run.`, { runId: run.id, state: run.state })
    }
    requireRow(loadBundle(ctx, run.revision_id), input)
    const view = rowCheckView(insertRowCheck(ctx, run, input))
    appendEvent(ctx, {
      kind: 'run.row_check_recorded',
      epicId: run.epic_id,
      runId: run.id,
      payload: { rowCheckId: view.id, sprintId: view.sprintId, row: view.row, number: view.number, commit: view.commit, passed: view.passed }
    })
    enqueueOutbox(ctx, { kind: 'run_history', epicId: run.epic_id, runId: run.id })
    return view
  })
}
