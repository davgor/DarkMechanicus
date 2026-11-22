/** Explicit desktop recovery operates on the destination snapshot, never on source execution. */
import type { Ctx } from '../context'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { appendEvent } from '../services/events'
import { recordCardEvent } from '../services/kanban/cards'
import { cancelRun } from '../services/runs'
import type { OutboxKind } from '../services/outbox'

const REASON = 'Force Forge World migration: restart unfinished work from the first ticket.'

/** A pending save has side effects beyond file output and is never completed by migration. */
export function settleForgeExports(db: Db, exported: ReadonlySet<string>): void {
  for (const row of db.all<{ id: number; kind: OutboxKind; epic_id: string | null; run_id: string | null; entity_id: string | null }>("SELECT * FROM outbox WHERE state <> 'done'")) {
    const kind = row.kind === 'epic_state' ? 'epic' : row.kind === 'run_history' ? 'run' : row.kind
    const id = row.kind === 'epic_state' ? row.epic_id : row.kind === 'run_history' ? row.run_id : row.entity_id
    if (row.kind === 'snapshot' || !id || !exported.has(`${kind}:${id}`)) fail('conflict', `The pending ${row.kind} record could not be reconstructed; finish its export before force migration.`)
    db.run("UPDATE outbox SET state = 'done' WHERE id = ?", row.id)
  }
}

export function assertForgeForceSafe(db: Db): void {
  if (db.get('SELECT 1 FROM tooling_holds LIMIT 1')) fail('conflict', 'Resolve every tooling recovery hold before switching storage.')
  if (db.get('SELECT 1 FROM sync_state WHERE conflict IS NOT NULL LIMIT 1')) fail('conflict', 'Resolve storage conflicts before force migration.')
  if (db.get("SELECT 1 FROM outbox WHERE kind = 'snapshot' AND state <> 'done' LIMIT 1")) fail('conflict', 'Finish the pending plan save before force migration; unsaved plans cannot be published.')
  if (db.get("SELECT 1 FROM transfers WHERE status IN ('queued','in_progress') LIMIT 1")) fail('conflict', 'Finish the open plan transfer before force migration.')
}

export function restartForgeExecution(ctx: Ctx): void {
  const { db } = ctx
  const now = ctx.clock.nowIso()
  for (const epic of db.all<{ id: string; status: string }>("SELECT id, status FROM epics WHERE status <> 'completed'")) {
    const runs = db.all<{ id: string }>("SELECT id FROM runs WHERE epic_id = ? AND state IN ('queued','running','paused','awaiting_checkpoint')", epic.id)
    for (const run of runs) cancelRun(ctx, { runId: run.id, reason: REASON })
    db.run(`UPDATE attempts SET reconciled_at = ?, superseded_at = ?, lease_expires_at = NULL, updated_at = ?
      WHERE run_id IN (SELECT id FROM runs WHERE epic_id = ?) AND state = 'lease_expired' AND reconciled_at IS NULL`, now, now, now, epic.id)
    db.run("UPDATE ticket_status SET status = 'backlog', revision = revision + 1, updated_at = ? WHERE epic_id = ?", now, epic.id)
    db.run("UPDATE epics SET status = 'backlog', revision = revision + 1, updated_at = ? WHERE id = ?", now, epic.id)
    appendEvent(ctx, { kind: 'epic.migration_restarted', epicId: epic.id, payload: { reason: REASON, from: epic.status, canceledRuns: runs.map(run => run.id) } })
  }
  for (const card of db.all<{ id: string; key: string }>("SELECT id, key FROM kanban_cards WHERE lane <> 'done'")) {
    const open = db.all<{ id: string; number: number }>("SELECT id, number FROM kanban_attempts WHERE card_id = ? AND state IN ('claimed','running','submitted','lease_expired')", card.id)
    for (const attempt of open) {
      db.run("UPDATE kanban_attempts SET state = 'failed', lease_expires_at = NULL WHERE id = ?", attempt.id)
      recordCardEvent(ctx, card, { kind: 'failed', attemptId: attempt.id, payload: { number: attempt.number, reason: REASON } })
    }
    db.run("UPDATE kanban_cards SET lane = 'backlog', play_requested_at = NULL, play_requested_by = NULL, updated_at = ? WHERE id = ?", now, card.id)
    const last = db.get<{ at: string | null }>('SELECT MAX(created_at) AS at FROM kanban_events WHERE card_id = ?', card.id)?.at
    const at = new Date(Math.max(ctx.clock.nowMs(), last ? Date.parse(last) + 1 : 0)).toISOString()
    recordCardEvent(ctx, card, { kind: 'migration_restarted', payload: { reason: REASON }, at })
  }
  db.run('UPDATE sessions SET ended_at = ? WHERE ended_at IS NULL', now)
}
