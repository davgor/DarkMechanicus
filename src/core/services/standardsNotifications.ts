import type { StandardizationItem, StandardsNotice, StandardsNoticeRoute } from '../../shared/domain/standardization'
import { contentHash } from '../canonical'
import type { Ctx } from '../context'
import { DomainError } from '../errors'
import { agentMailboxStatus, boundParticipantMailbox, sendAgentMessage } from './agentMail'
import { AGENT_MAIL_LIMITS } from './agentMailStore'
import type { AppliedStandard } from './workStandards'

interface Participants {
  attemptId?: string
  worker?: string
  orchestrator?: string
}

/** Only local authenticated events for the current attempt identify participants. Portable worker labels,
 * actor names and imported chat identifiers cannot establish a recipient. */
function attemptParticipants(ctx: Ctx, attemptId: string | undefined): Participants {
  if (!attemptId) return {}
  const actors = ctx.db.all<{ role: 'worker' | 'orchestrator'; session_id: string }>(
    `SELECT s.role, e.session_id FROM events e JOIN sessions s ON s.id = e.session_id
     WHERE json_extract(e.payload_json,'$.attemptId') = ? AND s.role IN ('worker','orchestrator')
     AND e.kind IN ('attempt.claimed','attempt.running','attempt.progress','attempt.submitted',
                    'kanban.claimed','kanban.running','kanban.submitted')
     ORDER BY e.seq DESC`, attemptId)
  return {
    attemptId,
    worker: actors.find(actor => actor.role === 'worker')?.session_id,
    orchestrator: actors.find(actor => actor.role === 'orchestrator')?.session_id
  }
}

function participants(ctx: Ctx, row: StandardizationItem, runId: string | null): Participants {
  if (row.kind === 'kanban') {
    const attempt = ctx.db.get<{id:string}>(
      "SELECT id FROM kanban_attempts WHERE card_id = ? AND state IN ('claimed','running','submitted') AND machine_id = ?",
      row.id, ctx.machineId)
    return attemptParticipants(ctx, attempt?.id)
  }
  const run = ctx.db.get<{orchestrator_session_id:string}>(
    'SELECT orchestrator_session_id FROM runs WHERE id = ? AND owner_machine_id = ?', runId, ctx.machineId)
  const attempt = ctx.db.get<{id:string}>(`SELECT id FROM attempts WHERE run_id = ? AND ticket_id = ?
    AND superseded_at IS NULL AND state IN ('claimed','running','submitted')`, runId, row.id)
  return { attemptId: attempt?.id, worker: attemptParticipants(ctx, attempt?.id).worker, orchestrator: run?.orchestrator_session_id }
}

function noticeBody(row: StandardizationItem, rule: AppliedStandard): string {
  const header = `Delivery standards revision ${rule.revision} applies to ${row.kind} ${row.id}.`
  const command = row.kind === 'kanban' ? `get_kanban_card cardId=${row.id}`
    : row.kind === 'ticket' ? `get_ticket epicId=${row.epicId} ticketId=${row.id}`
    : `get_plan epicId=${row.epicId}`
  const summary = `${header}\nInspect the current requirements with ${command} before continuing or accepting the work.\n${rule.reason}`
  const {prompt: _prompt, ...changed} = rule
  const full = `${summary}\n${JSON.stringify(changed, null, 2)}`
  return Buffer.byteLength(full) <= AGENT_MAIL_LIMITS.bodyBytes ? full : summary.slice(0, 3000)
}

/** An inbox acknowledgement is separate; "inbox" means the message was accepted for that verified endpoint. */
export function notifyStandardsChange(ctx: Ctx, row: StandardizationItem, rule: AppliedStandard, runId: string | null): StandardsNotice {
  const people = participants(ctx, row, runId)
  const sender = agentMailboxStatus(ctx)
  function deliver(sessionId?: string): StandardsNoticeRoute {
    const to = boundParticipantMailbox(ctx, sessionId)
    if (!to) return 'refresh'
    const body = noticeBody(row, rule)
    ctx.db.run(`INSERT INTO delivery_context_notices(endpoint_id,assignment_id,item_kind,item_id,run_id,attempt_id,revision,body)
      VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(endpoint_id,assignment_id,item_kind,item_id) DO UPDATE SET
      revision=excluded.revision, body=excluded.body`,
      to, people.attemptId ?? runId, row.kind, row.id, runId, people.attemptId ?? null, rule.revision, body)
    if (!sender.bound) return 'refresh'
    if (sender.endpointId === to) return 'current_chat'
    const clientMessageId = contentHash([runId, people.attemptId, row.kind, row.id, rule.revision, to])
    try {
      sendAgentMessage(ctx, { to, clientMessageId, body })
      return 'inbox'
    } catch (error) {
      if (error instanceof DomainError && ['mailbox_full','receipt_quota_full'].includes(error.code)) return 'refresh'
      throw error
    }
  }
  const notice: StandardsNotice = { orchestrator: deliver(people.orchestrator) }
  if (row.kind === 'ticket' || row.kind === 'kanban') notice.worker = deliver(people.worker)
  return notice
}

/** Only requirements for this grant's authenticated endpoint and live assignment enter a model request.
 * A new attempt has a different id, so reassignment or closure retires the previous recipient's notice. */
export function activeContextNotices(ctx: Ctx): string[] {
  const mailbox = agentMailboxStatus(ctx)
  if (!mailbox.bound) return []
  // Each body is bounded by the inbox limit. Keep the project read bounded even for large parallel runs.
  const notices = ctx.db.all<{body:string; total:number}>(`SELECT n.body, COUNT(*) OVER() AS total FROM delivery_context_notices n
    LEFT JOIN runs r ON r.id=n.run_id
    LEFT JOIN attempts a ON a.id=n.attempt_id AND a.run_id=n.run_id AND n.item_kind='ticket'
    LEFT JOIN kanban_attempts k ON k.id=n.attempt_id AND n.item_kind='kanban'
    WHERE n.endpoint_id=? AND (
      (k.state IN ('claimed','running','submitted') AND k.machine_id=?) OR
      (r.state IN ('queued','running','awaiting_checkpoint','paused') AND r.owner_machine_id=? AND (
        (n.item_kind='ticket' AND a.state IN ('claimed','running','submitted') AND a.superseded_at IS NULL) OR
        (n.item_kind='sprint' AND r.active_sprint_id=n.item_id) OR n.item_kind='epic')))
    ORDER BY n.revision DESC,n.item_kind,n.item_id,n.assignment_id LIMIT 4`, mailbox.endpointId, ctx.machineId, ctx.machineId)
  const messages = notices.map(notice => notice.body)
  const remaining = (notices[0]?.total ?? 0) - messages.length
  if (remaining > 0) messages.push(`${remaining} additional active work items have revised requirements. Read get_plan or get_kanban_card for the active item before proceeding.`)
  return messages
}
