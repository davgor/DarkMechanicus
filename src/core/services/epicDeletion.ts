import type { DeleteEpicResultView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { activeRun, loadEpicRow } from './epics'
import { appendEvent } from './events'

/**
 * Deletes the epic's tracked files and returns the folders it removed. It runs inside the deletion
 * transaction: a failure leaves every row in place, and the write lock keeps a concurrent reconcile
 * from importing files that are about to go.
 */
type EpicFilesRemover = (epicId: string, runIds: string[]) => string[]

const RUNS = 'SELECT id FROM runs WHERE epic_id = ?'
const COMMENTS = 'SELECT id FROM comments WHERE epic_id = ?'

/** Children before parents, since foreign keys are enforced. Every `?` binds the epic id. */
const DELETE_STATEMENTS = [
  `DELETE FROM attempts WHERE run_id IN (${RUNS})`,
  `DELETE FROM retry_grants WHERE run_id IN (${RUNS})`,
  `DELETE FROM checkpoints WHERE run_id IN (${RUNS})`,
  `DELETE FROM sprint_reports WHERE run_id IN (${RUNS})`,
  'DELETE FROM approvals WHERE epic_id = ?',
  `DELETE FROM sync_state WHERE (kind = 'epic' AND entity_id = ?) OR (kind = 'run' AND entity_id IN (${RUNS}))
     OR (kind = 'comment' AND entity_id IN (${COMMENTS}))`,
  'DELETE FROM outbox WHERE epic_id = ?',
  `DELETE FROM search_index WHERE epic_id = ? OR run_id IN (${RUNS})`,
  `DELETE FROM events WHERE epic_id = ? OR run_id IN (${RUNS})`,
  // Cached replies that name the epic (createEpic, startRun, ...) would otherwise replay a deleted epic.
  'DELETE FROM idempotency WHERE instr(response_json, ?) > 0',
  'DELETE FROM runs WHERE epic_id = ?',
  'DELETE FROM comments WHERE epic_id = ?',
  'DELETE FROM ticket_status WHERE epic_id = ?',
  'DELETE FROM drafts WHERE epic_id = ?',
  'DELETE FROM plan_revisions WHERE epic_id = ?',
  'DELETE FROM epics WHERE id = ?'
]

/**
 * Hard-deletes an epic: every row that belongs to it and, through `removeFiles`, its tracked folders.
 * Refused while a run is active. The event that records it names no deleted id.
 */
export function deleteEpic(ctx: Ctx, input: { epicId: string }, removeFiles: EpicFilesRemover): DeleteEpicResultView {
  requireCapability(ctx.session, 'epic.delete')
  ctx.assertBranch()
  return ctx.db.tx(() => {
    const epic = loadEpicRow(ctx, input.epicId)
    const run = activeRun(ctx, epic.id)
    if (run) {
      fail('active_run_exists', `Run #${run.number} is active. Cancel it before deleting the epic.`, { runId: run.id })
    }
    const runIds = ctx.db.all<{ id: string }>(`${RUNS} ORDER BY number`, epic.id).map((row) => row.id)
    for (const sql of DELETE_STATEMENTS) {
      ctx.db.run(sql, ...Array.from({ length: sql.split('?').length - 1 }, () => epic.id))
    }
    const removedPaths = removeFiles(epic.id, runIds)
    appendEvent(ctx, { kind: 'epic.deleted', payload: { title: epic.title, runs: runIds.length } })
    return { epicId: epic.id, title: epic.title, removedRuns: runIds.length, removedPaths }
  })
}
