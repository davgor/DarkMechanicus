import type { Ctx } from '../context'

/** Hold extensions do not enlarge the lease length kept by later heartbeats. */
export function toolingLeaseTimeGivenBack(ctx: Ctx, attemptId: string, kind: 'run' | 'card', since: string): number {
  return ctx.db.get<{ ms: number }>('SELECT COALESCE(SUM(ms), 0) AS ms FROM legacy_tooling_lease_credits WHERE attempt_id = ? AND kind = ? AND granted_at = ?', attemptId, kind, since)?.ms ?? 0
}
