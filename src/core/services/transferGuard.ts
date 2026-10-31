/**
 * While the person's transfer of an epic to Linear is open, the plan it sends must stay put: no run may be queued
 * or started and no plan may be saved. Draft edits stay allowed. Tracked records another machine wrote meanwhile
 * are held back by the importer as a conflict (a "transfer hold"), which the epic state export and the transfer's
 * completion both respect, until the person cancels the transfer and reconciles.
 */
import type { TransferStatus } from '../../shared/domain/transfer'
import type { Ctx } from '../context'
import type { Db } from '../db/database'
import { fail } from '../errors'

const OPEN_TRANSFER_SQL =
  "SELECT status, revision_id AS revisionId FROM transfers WHERE epic_id = ? AND status IN ('queued', 'in_progress')"

const OPEN_TRANSFER_MESSAGE = 'Finish or cancel the Linear transfer of this epic first.'

export interface OpenTransfer {
  status: Extract<TransferStatus, 'queued' | 'in_progress'>
  revisionId: string
}

/** The epic's transfer while it is queued or in progress; null when there is none or it is verified or canceled. */
export function findOpenTransfer(db: Db, epicId: string): OpenTransfer | null {
  return db.get<OpenTransfer>(OPEN_TRANSFER_SQL, epicId) ?? null
}

/** Every transfer-hold conflict the importer stores starts with this; a later reconcile drops one whose hold ended. */
export const TRANSFER_HOLD_PREFIX = 'Linear transfer open for epic '

/** Whether the last reconcile held back incoming tracked records of the epic for its open transfer. */
export function hasTransferHold(db: Db, epicId: string): boolean {
  const row = db.get(
    "SELECT 1 AS held FROM sync_state WHERE kind = 'epic' AND entity_id = ? AND substr(conflict, 1, ?) = ?",
    epicId,
    TRANSFER_HOLD_PREFIX.length,
    TRANSFER_HOLD_PREFIX
  )
  return row !== undefined
}

/**
 * Refuses with `conflict` while the epic's transfer is queued or in progress. Call it inside the caller's
 * transaction, before its write, so a transfer queued concurrently cannot slip between the check and the write.
 */
export function assertNoOpenTransfer(ctx: Ctx, epicId: string): void {
  const open = findOpenTransfer(ctx.db, epicId)
  if (open) {
    fail('conflict', OPEN_TRANSFER_MESSAGE, { epicId, transferStatus: open.status })
  }
}
