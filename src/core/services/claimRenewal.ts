import type { Ctx } from '../context'
import type { CommandName } from '../../shared/domain/api'
import { renewAttemptLease } from './attempts'
import { renewCardLease } from './kanban/attempts'

/**
 * Commands that set a claim's lease themselves: renewing after them would only repeat their write. The `dm` CLI opens
 * these without reconcile or flush work (`OpenWorkspaceOptions.leaseOnly`).
 */
export const LEASE_COMMANDS: readonly CommandName[] = ['heartbeatAttempt', 'heartbeatKanbanCard']

/**
 * After a command succeeded with a claim token in its input, renews the lease of the live claim the token proves, plan
 * or card, so a holder that keeps calling (comments, attachments, metrics) never expires between heartbeats. Only the
 * token proves the holder: a grant may be shared by several workers, so a call without one renews nothing. The command
 * has already committed, so a renewal that cannot be written leaves its result standing; the next call or heartbeat
 * renews again.
 */
export function renewClaimAfter(ctx: Ctx, name: CommandName, input: unknown): void {
  if (LEASE_COMMANDS.includes(name) || typeof input !== 'object' || input === null || !('claimToken' in input)) return
  const token = input.claimToken
  if (typeof token !== 'string') return
  try {
    if (!renewAttemptLease(ctx, token)) renewCardLease(ctx, token)
  } catch {
    // Renewal is a side effect of a call that already succeeded; it never turns that call into a failure.
  }
}
