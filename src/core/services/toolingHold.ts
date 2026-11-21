import type { CommandName } from '../../shared/domain/api'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { fail } from '../errors'

interface HoldTarget { id: string; incidentId: string; runId?: string; cardId?: string }
/** Live terminal identity is trusted main-process data, not an agent argument. */
export function bindToolingGrant(ctx: Ctx, grantId: string, chatId: string): void {
  requireCapability(ctx.session, 'grant.issue')
  ctx.db.run('INSERT OR REPLACE INTO tooling_chat_grants(grant_id, chat_id) VALUES (?, ?)', grantId, chatId)
}
/** Record the exact interruption before any repair launch; do not cancel attempts or discard planning drafts. */
export function holdToolingWorkflow(ctx: Ctx, target: HoldTarget): void {
  requireCapability(ctx.session, 'grant.issue')
  ctx.db.tx(() => {
    const prior = ctx.db.get<{ incident_id: string }>('SELECT incident_id FROM tooling_holds WHERE chat_id = ?', target.id)
    if (prior !== undefined) {
      if (prior.incident_id !== target.incidentId) fail('conflict', 'This chat already has an unresolved tooling hold.')
      return
    }
    const run = target.runId === undefined ? undefined : ctx.db.get<{ state: string; owner_machine_id: string; pause_reason: string | null }>('SELECT state, owner_machine_id, pause_reason FROM runs WHERE id = ?', target.runId)
    if (target.runId !== undefined && (run === undefined || run.owner_machine_id !== ctx.machineId || run.pause_reason === 'taken_over')) fail('unauthorized', 'Tooling recovery cannot pause a missing, foreign or taken-over run.')
    const pausable = run !== undefined && ['queued', 'running', 'awaiting_checkpoint'].includes(run.state)
    const now = ctx.clock.nowIso()
    ctx.db.run('INSERT INTO tooling_holds(chat_id, incident_id, run_id, card_id, held_at, previous_run_state) VALUES (?, ?, ?, ?, ?, ?)',
      target.id, target.incidentId, target.runId ?? null, target.cardId ?? null, now, pausable ? run.state : null)
    if (pausable) ctx.db.run("UPDATE runs SET state = 'paused', pause_reason = 'tooling_recovery', paused_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?", now, now, target.runId!)
    if (target.runId !== undefined) ctx.db.run("INSERT INTO tooling_held_attempts SELECT ?, id, 'run' FROM attempts WHERE run_id = ? AND state IN ('claimed', 'running')", target.incidentId, target.runId)
    if (target.cardId !== undefined) ctx.db.run("INSERT INTO tooling_held_attempts SELECT ?, id, 'card' FROM kanban_attempts WHERE card_id = ? AND state IN ('claimed', 'running') AND machine_id = ?", target.incidentId, target.cardId, ctx.machineId)
  })
}
/** Only the desktop recovery verifier calls this after exact incident/runtime verification. */
export function releaseToolingWorkflow(ctx: Ctx, target: HoldTarget): void {
  requireCapability(ctx.session, 'grant.issue')
  ctx.db.tx(() => {
    const hold = ctx.db.get<{ run_id: string | null; card_id: string | null; held_at: string; previous_run_state: string | null }>('SELECT * FROM tooling_holds WHERE chat_id = ? AND incident_id = ?', target.id, target.incidentId)
    if (hold === undefined) return
    const now = ctx.clock.nowIso()
    if (hold.run_id !== null) {
      const run = ctx.db.get<{ owner_machine_id: string; pause_reason: string | null }>('SELECT owner_machine_id, pause_reason FROM runs WHERE id = ?', hold.run_id)
      if (run?.owner_machine_id !== ctx.machineId || run.pause_reason === 'taken_over') fail('run_not_owned', 'The original run was taken over; its old interruption cannot resume or extend it.')
    }
    for (const kind of ['run', 'card'] as const) {
      const table = kind === 'run' ? 'attempts' : 'kanban_attempts'
      const attempts = ctx.db.all<{ id: string; lease_expires_at: string; heartbeat_at: string | null; created_at: string }>(
        `SELECT a.id, a.lease_expires_at, a.heartbeat_at, a.created_at FROM ${table} a JOIN tooling_held_attempts h ON h.attempt_id = a.id
         WHERE h.incident_id = ? AND h.kind = ? AND a.state IN ('claimed', 'running') AND a.lease_expires_at IS NOT NULL`, target.incidentId, kind)
      for (const attempt of attempts) {
        // Heartbeats during a hold renew from their own timestamp: never give that elapsed time back twice.
        const since = Math.max(Date.parse(hold.held_at), Date.parse(attempt.heartbeat_at ?? hold.held_at))
        const ms = Math.max(0, Date.parse(now) - since)
        ctx.db.run(`UPDATE ${table} SET lease_expires_at = ? WHERE id = ?`, new Date(Date.parse(attempt.lease_expires_at) + ms).toISOString(), attempt.id)
        ctx.db.run('INSERT INTO tooling_lease_returns(attempt_id, kind, at, granted_at, ms) VALUES (?, ?, ?, ?, ?)', attempt.id, kind, now, attempt.heartbeat_at ?? attempt.created_at, ms)
      }
    }
    if (hold.run_id !== null && hold.previous_run_state !== null) ctx.db.run("UPDATE runs SET state = ?, pause_reason = NULL, paused_at = NULL, updated_at = ?, revision = revision + 1 WHERE id = ? AND state = 'paused' AND pause_reason = 'tooling_recovery'", hold.previous_run_state, now, hold.run_id)
    ctx.db.run('DELETE FROM tooling_held_attempts WHERE incident_id = ?', target.incidentId)
    ctx.db.run('DELETE FROM tooling_holds WHERE chat_id = ? AND incident_id = ?', target.id, target.incidentId)
  })
}
/** Reads, mail, renewal and leased-worker heartbeats continue during the hold; unrelated progress cannot. */
export function assertToolingCommand(ctx: Ctx, grantId: string, name: CommandName, mutates: boolean): void {
  if (!mutates || ['heartbeatAttempt', 'heartbeatKanbanCard', 'sendAgentMessage', 'acknowledgeAgentMessages', 'consumeAgentMailWake'].includes(name)) return
  const hold = ctx.db.get<{ incident_id: string }>('SELECT h.incident_id FROM tooling_holds h JOIN tooling_chat_grants g ON g.chat_id = h.chat_id WHERE g.grant_id = ?', grantId)
  if (hold !== undefined) fail('invalid_state', 'This workflow is tooling-blocked. Continue incident communication and lease heartbeats; resume only after verified repair availability.', { incidentId: hold.incident_id })
}

/** Hold extensions do not enlarge the lease length kept by later heartbeats. */
export function toolingLeaseTimeGivenBack(ctx: Ctx, attemptId: string, kind: 'run' | 'card', since: string): number {
  return ctx.db.get<{ ms: number }>('SELECT COALESCE(SUM(ms), 0) AS ms FROM tooling_lease_returns WHERE attempt_id = ? AND kind = ? AND granted_at = ?', attemptId, kind, since)?.ms ?? 0
}

/** Human-authorized deletion retires this chat's hold, never marks its repair successful or completes its work. */
export function retireToolingWorkflow(ctx: Ctx, chatId: string): void {
  requireCapability(ctx.session, 'grant.revoke')
  ctx.db.tx(() => {
    const hold = ctx.db.get<{ incident_id: string }>('SELECT incident_id FROM tooling_holds WHERE chat_id = ?', chatId)
    if (hold === undefined) return
    ctx.db.run('DELETE FROM tooling_held_attempts WHERE incident_id = ?', hold.incident_id)
    ctx.db.run('DELETE FROM tooling_holds WHERE chat_id = ?', chatId)
    // A tooling-paused run stays paused and unfinished. With no orphan hold, ordinary human recovery can resume/cancel it.
  })
}
