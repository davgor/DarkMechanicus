import type { StandardizationItem, StandardsNotice, StandardsNoticeRoute } from '../../shared/domain/standardization'
import { contentHash } from '../canonical'
import type { Ctx } from '../context'
import { DomainError } from '../errors'
import { agentMailboxStatus, boundParticipantMailbox, sendAgentMessage } from './agentMail'
import { AGENT_MAIL_LIMITS } from './agentMailStore'
import type { AppliedStandard } from './workStandards'

interface Participants {
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
  return { worker: attemptParticipants(ctx, attempt?.id).worker, orchestrator: run?.orchestrator_session_id }
}

function noticeBody(row: StandardizationItem, rule: AppliedStandard): string {
  const header = `Delivery standards revision ${rule.revision} applies to ${row.kind} ${row.id}.`
  const command = row.kind === 'kanban' ? `get_kanban_card cardId=${row.id}`
    : row.kind === 'ticket' ? `get_ticket epicId=${row.epicId} ticketId=${row.id}`
    : `get_plan epicId=${row.epicId}`
  const summary = `${header}\nInspect the current requirements with ${command} before continuing or accepting the work.\n${rule.reason}`
  const full = `${summary}\n${JSON.stringify(rule, null, 2)}`
  return Buffer.byteLength(full) <= AGENT_MAIL_LIMITS.bodyBytes ? full : summary.slice(0, 3000)
}

/** An inbox acknowledgement is separate; "inbox" means the message was accepted for that verified endpoint. */
export function notifyStandardsChange(ctx: Ctx, row: StandardizationItem, rule: AppliedStandard, runId: string | null): StandardsNotice {
  const people = participants(ctx, row, runId)
  const sender = agentMailboxStatus(ctx)
  function deliver(sessionId?: string): StandardsNoticeRoute {
    if (!sender.bound) return 'refresh'
    const to = boundParticipantMailbox(ctx, sessionId)
    if (!to) return 'refresh'
    if (sender.endpointId === to) return 'current_chat'
    const clientMessageId = contentHash([row.epicId ?? null, row.kind, row.id, rule.revision, to])
    try {
      sendAgentMessage(ctx, { to, clientMessageId, body: noticeBody(row, rule) })
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
