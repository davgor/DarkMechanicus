/**
 * The person's way out of an epic records conflict: the epic's tracked pointer and state hold records this machine
 * has not imported (another machine's save or state change, pulled or checked out) while this machine's own changes
 * to the epic wait to be exported. A reconcile does not import over the local changes (`planEpics`) and a flush does
 * not write over the tracked records (`exportEpic`), so the outbox entry waits until the person keeps one side:
 *
 * - `tracked` first writes the epic's run histories that wait behind its refused state export (this machine's own
 *   records, written as any flush would). Then, in one transaction that writes no file, it drops the epic's waiting
 *   state export and any waiting save (its revision is marked `failed`; the draft it came from stays) and imports the
 *   tracked records. If they do not import, nothing of the choice is kept and the conflict stays.
 * - `local` records, in one transaction, that the tracked records it found (exactly that hash, `imported_hash`) may
 *   be replaced, then flushes the epic's entries as any flush would. The choice stands even if the write fails: every
 *   later flush retries it, still only over that hash, and the result says why it is not written yet.
 *
 * Files are never written inside a transaction that can still roll back, so a refusal cannot leave this machine's
 * records on disk with no `sync_state` row for them. Both are refused during a Linear transfer hold. Desktop only
 * (`repo.resolve_conflict`); no MCP tool offers it.
 */
import type {
  EpicConflictChoice,
  FlushResultView,
  ReconcileResultView,
  ResolveEpicConflictView
} from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { type FlushScope, unimportedEpicRecords } from '../repo/finalizer'
import { hasPendingEpicChanges } from '../repo/syncState'
import type { FsAdapter, RepoLayout } from '../repo/types'
import { loadEpicRow } from './epics'
import { appendEvent } from './events'
import { enqueueOutbox } from './outbox'
import { hasTransferHold } from './transferGuard'

/** The checkout's records and the workspace's own import and export, which apply the chosen side. */
export interface EpicRecordsAccess {
  layout: RepoLayout
  fs: FsAdapter
  /** Imports the tracked records into the database; reads files, writes none. */
  reconcile(): ReconcileResultView
  flush(scope: FlushScope): FlushResultView
}

/** Waiting exports of the epic's own records (state, pointer and snapshot); its run histories and comments are other files. */
const WAITING_EPIC_RECORDS = "kind IN ('snapshot', 'epic_state') AND state IN ('pending', 'failed')"

/** The hash of the tracked records in conflict with the epic's waiting local changes; `conflict` when there are none. */
function requireConflict(ctx: Ctx, epicId: string, records: EpicRecordsAccess): string {
  const epic = loadEpicRow(ctx, epicId)
  if (hasTransferHold(ctx.db, epic.id)) {
    fail('conflict', `Epic ${epic.id}'s tracked records hold changes waiting for its Linear transfer. Cancel the transfer and reconcile first.`)
  }
  const trackedHash =
    records.layout.mode === 'repo' ? unimportedEpicRecords({ db: ctx.db, layout: records.layout, fs: records.fs }, epic.id) : null
  if (trackedHash === null || !hasPendingEpicChanges(ctx.db, epic.id)) {
    fail(
      'conflict',
      `Epic ${epic.id} has no tracked records that changed while its local changes wait to be exported, so there is nothing to choose.`
    )
  }
  return trackedHash
}

function keepTracked(ctx: Ctx, epicId: string, records: EpicRecordsAccess): ResolveEpicConflictView {
  ctx.db.tx(() => requireConflict(ctx, epicId, records))
  const flushed = records.flush({ epicId, kinds: ['run_history'] })
  return ctx.db.tx(() => {
    requireConflict(ctx, epicId, records)
    const abandonedRevisionIds = ctx.db
      .all<{ id: string }>("SELECT id FROM plan_revisions WHERE epic_id = ? AND state = 'pending' ORDER BY number", epicId)
      .map((row) => row.id)
    ctx.db.run("UPDATE plan_revisions SET state = 'failed' WHERE epic_id = ? AND state = 'pending'", epicId)
    ctx.db.run(
      `UPDATE outbox SET state = 'done', done_at = ?, last_error = NULL WHERE epic_id = ? AND ${WAITING_EPIC_RECORDS}`,
      ctx.clock.nowIso(),
      epicId
    )
    if (hasPendingEpicChanges(ctx.db, epicId)) {
      const reason = flushed.errors.length > 0 ? ` ${flushed.errors.join(' ')}` : ''
      fail('conflict', `Epic ${epicId}'s tracked records were not imported: its run history is still waiting to be exported.${reason}`)
    }
    const result = records.reconcile()
    if (!result.imported.includes(epicId)) {
      const reason =
        result.conflicts.find((conflict) => conflict.epicId === epicId)?.message ??
        result.rejected.find((rejection) => rejection.path.includes(epicId))?.message ??
        'the reconcile did not import them.'
      fail('conflict', `Epic ${epicId}'s tracked records were not imported, so its local changes were kept: ${reason}`)
    }
    appendEvent(ctx, { kind: 'repository.epic_conflict_resolved', epicId, payload: { kept: 'tracked', abandonedRevisionIds } })
    return { epicId, kept: 'tracked', abandonedRevisionIds, error: null }
  })
}

function keepLocal(ctx: Ctx, epicId: string, records: EpicRecordsAccess): ResolveEpicConflictView {
  ctx.db.tx(() => {
    const trackedHash = requireConflict(ctx, epicId, records)
    ctx.db.run(
      `INSERT INTO sync_state (kind, entity_id, generation, imported_hash, updated_at) VALUES ('epic', ?, 0, ?, ?)
       ON CONFLICT(kind, entity_id) DO UPDATE SET imported_hash = excluded.imported_hash, updated_at = excluded.updated_at`,
      epicId,
      trackedHash,
      ctx.clock.nowIso()
    )
    if (ctx.db.get(`SELECT id FROM outbox WHERE epic_id = ? AND ${WAITING_EPIC_RECORDS}`, epicId) === undefined) {
      enqueueOutbox(ctx, { kind: 'epic_state', epicId })
    }
    appendEvent(ctx, { kind: 'repository.epic_conflict_resolved', epicId, payload: { kept: 'local', abandonedRevisionIds: [] } })
  })
  const flushed = records.flush({ epicId })
  const waiting = ctx.db.get<{ last_error: string | null }>(
    `SELECT last_error FROM outbox WHERE epic_id = ? AND ${WAITING_EPIC_RECORDS} ORDER BY id LIMIT 1`,
    epicId
  )
  const error = waiting === undefined ? null : flushed.errors.length > 0 ? flushed.errors.join(' ') : (waiting.last_error ?? 'It is still waiting.')
  return { epicId, kept: 'local', abandonedRevisionIds: [], error }
}

/** Keeps one side of an epic records conflict (see the module comment); `conflict` when there is none to settle. */
export function resolveEpicConflict(
  ctx: Ctx,
  input: { epicId: string; keep: EpicConflictChoice },
  records: EpicRecordsAccess
): ResolveEpicConflictView {
  requireCapability(ctx.session, 'repo.resolve_conflict')
  ctx.assertBranch()
  return input.keep === 'tracked' ? keepTracked(ctx, input.epicId, records) : keepLocal(ctx, input.epicId, records)
}
