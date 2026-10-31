/**
 * While the person's transfer of an epic to Linear is open, the plan it sends must stay put: no run may be queued
 * or started and no plan may be saved. Draft edits stay allowed.
 */
import type { TransferStatus } from '../../shared/domain/transfer'
import type { Ctx } from '../context'
import { fail } from '../errors'

const OPEN_TRANSFER_SQL = "SELECT status FROM transfers WHERE epic_id = ? AND status IN ('queued', 'in_progress')"

const OPEN_TRANSFER_MESSAGE = 'Finish or cancel the Linear transfer of this epic first.'

/**
 * Refuses with `conflict` while the epic's transfer is queued or in progress. Call it inside the caller's
 * transaction, before its write, so a transfer queued concurrently cannot slip between the check and the write.
 */
export function assertNoOpenTransfer(ctx: Ctx, epicId: string): void {
  const open = ctx.db.get<{ status: TransferStatus }>(OPEN_TRANSFER_SQL, epicId)
  if (open) {
    fail('conflict', OPEN_TRANSFER_MESSAGE, { epicId, transferStatus: open.status })
  }
}
