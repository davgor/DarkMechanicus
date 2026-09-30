import type { Ctx } from '../context'

export type OutboxKind = 'snapshot' | 'epic_state' | 'run_history'

export interface OutboxEntry {
  kind: OutboxKind
  epicId?: string | null
  runId?: string | null
  revisionId?: string | null
}

/**
 * Records that portable repository files must be (re)written. Call inside the mutation's
 * transaction; the finalizer flushes entries after commit. Pending state/history entries for the
 * same entity are coalesced because each flush rewrites the whole file.
 */
export function enqueueOutbox(ctx: Ctx, entry: OutboxEntry): void {
  if (entry.kind !== 'snapshot') {
    const pending = ctx.db.get<{ id: number }>(
      `SELECT id FROM outbox WHERE state = 'pending' AND kind = ?
       AND IFNULL(epic_id, '') = IFNULL(?, '') AND IFNULL(run_id, '') = IFNULL(?, '')`,
      entry.kind,
      entry.epicId ?? null,
      entry.runId ?? null
    )
    if (pending) {
      return
    }
  }
  ctx.db.run(
    `INSERT INTO outbox (kind, epic_id, run_id, revision_id, state, created_at)
     VALUES (?, ?, ?, ?, 'pending', ?)`,
    entry.kind,
    entry.epicId ?? null,
    entry.runId ?? null,
    entry.revisionId ?? null,
    ctx.clock.nowIso()
  )
}
