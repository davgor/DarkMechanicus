import type { SavePermissionRequestView } from '../../shared/domain/savePermissions'
import type { SessionRole } from '../../shared/domain/views'
import { requireCapability, type Capability } from '../authz'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'
import { fail } from '../errors'
import { appendEvent } from './events'
import { assertGrantUsable } from './grants'
import { SESSION_ACTIVE_WINDOW_MS } from './sessions'

interface SessionAuthority {
  id: string
  role: SessionRole
  grant_id: string | null
  launch_capabilities_json: string
  ended_at: string | null
  last_seen_at: string
}
interface RequestRow {
  id: string
  session_id: string
  grant_id: string | null
  machine_id: string
  requester_label: string
  reason: string
  status: SavePermissionRequestView['status']
  requested_at: string
  decided_at: string | null
  decided_by_session_id: string | null
  decision_reason: string | null
}

function sessionAuthority(ctx: Ctx, sessionId: string): SessionAuthority {
  const row = ctx.db.get<SessionAuthority>(
    'SELECT id, role, grant_id, launch_capabilities_json, ended_at, last_seen_at FROM sessions WHERE id = ?', sessionId
  )
  if (row === undefined) fail('unauthorized', 'The permission session is no longer available.')
  return row
}

function sessionIsLive(ctx: Ctx, row: SessionAuthority): boolean {
  return row.ended_at === null && ctx.clock.nowMs() - Date.parse(row.last_seen_at) <= SESSION_ACTIVE_WINDOW_MS
}

function requireLiveSession(ctx: Ctx, row: SessionAuthority): void {
  if (!sessionIsLive(ctx, row)) {
    fail('unauthorized', 'The permission session is no longer active.')
  }
}

function view(row: RequestRow): SavePermissionRequestView {
  return {
    id: row.id, sessionId: row.session_id, grantId: row.grant_id, requesterLabel: row.requester_label,
    reason: row.reason, status: row.status, requestedAt: row.requested_at, decidedAt: row.decided_at,
    decidedBySessionId: row.decided_by_session_id, decisionReason: row.decision_reason
  }
}

/** Original launch authority only: neither an approved request nor a YOLO admission can delegate. */
function requireDecisionAuthority(ctx: Ctx, actor: SessionAuthority): void {
  requireCapability(ctx.session, 'plan.decide_save')
  if (actor.role === 'desktop') return
  if (actor.role !== 'orchestrator') fail('unauthorized', 'Only a person or an explicitly saving orchestrator may decide Allow save requests.')
  requireLiveSession(ctx, actor)
  if (actor.grant_id !== null) {
    assertGrantUsable(ctx, actor.grant_id)
    const grant = ctx.db.get<{ role: string; allow_save: number }>('SELECT role, allow_save FROM grants WHERE id = ?', actor.grant_id)
    if (grant?.role === 'orchestrator' && grant.allow_save === 1) return
  } else if (parseJson<Capability[]>(actor.launch_capabilities_json, []).includes('plan.save')) {
    return
  }
  fail('unauthorized', 'Approval requires original explicit Allow save authority, not permission acquired from a request.')
}

export function requestSavePermission(ctx: Ctx, input: { reason: string }): SavePermissionRequestView {
  requireCapability(ctx.session, 'plan.request_save')
  if (ctx.session.role !== 'orchestrator') fail('unauthorized', 'Only orchestrators may request Allow save.')
  return ctx.db.tx(() => {
    const actor = sessionAuthority(ctx, ctx.session.id)
    if (actor.grant_id !== null) assertGrantUsable(ctx, actor.grant_id)
    else requireLiveSession(ctx, actor)
    if (ctx.session.capabilities.has('plan.save')) fail('invalid_state', 'This session already has Allow save.')
    const pending = ctx.db.get<RequestRow>(
      `SELECT * FROM save_permission_requests WHERE machine_id = ? AND status = 'pending' AND
       ((? IS NOT NULL AND grant_id = ?) OR (? IS NULL AND session_id = ?))`,
      ctx.machineId, actor.grant_id, actor.grant_id, actor.grant_id, actor.id
    )
    if (pending !== undefined) return view(pending)
    const row: RequestRow = {
      id: ctx.ids.next('savePermission'), session_id: actor.id, grant_id: actor.grant_id, machine_id: ctx.machineId,
      requester_label: ctx.session.label, reason: input.reason, status: 'pending', requested_at: ctx.clock.nowIso(),
      decided_at: null, decided_by_session_id: null, decision_reason: null
    }
    ctx.db.run(
      `INSERT INTO save_permission_requests (id, session_id, grant_id, machine_id, requester_label, reason, status, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id, row.session_id, row.grant_id, row.machine_id, row.requester_label, row.reason, row.status, row.requested_at
    )
    appendEvent(ctx, { kind: 'save_permission.requested', payload: { requestId: row.id, sessionId: actor.id, grantId: actor.grant_id, reason: input.reason } })
    return view(row)
  })
}

export function listSavePermissionRequests(ctx: Ctx): SavePermissionRequestView[] {
  requireCapability(ctx.session, 'read')
  // Readers see no other chat's permission reasons. Orchestrators can inspect pending requests to decide them.
  if (ctx.session.role !== 'desktop' && ctx.session.role !== 'orchestrator') return []
  return ctx.db.all<RequestRow>('SELECT * FROM save_permission_requests WHERE machine_id = ? ORDER BY requested_at DESC, id DESC', ctx.machineId).map(view)
}

export function decideSavePermission(ctx: Ctx, input: { requestId: string; decision: 'approved' | 'denied'; reason: string }): SavePermissionRequestView {
  requireCapability(ctx.session, 'plan.decide_save')
  return ctx.db.tx(() => {
    const actor = sessionAuthority(ctx, ctx.session.id)
    requireDecisionAuthority(ctx, actor)
    const request = ctx.db.get<RequestRow>('SELECT * FROM save_permission_requests WHERE id = ? AND machine_id = ?', input.requestId, ctx.machineId)
    if (request === undefined) fail('not_found', 'That Allow save request does not exist in this folder on this machine.')
    if (request.session_id === actor.id || (actor.grant_id !== null && request.grant_id === actor.grant_id)) {
      fail('unauthorized', 'A requester cannot decide its own Allow save request, including from another session on the same grant.')
    }
    if (request.status !== 'pending') fail('invalid_state', 'This Allow save request has already been decided.')
    const target = sessionAuthority(ctx, request.session_id)
    if (target.role !== 'orchestrator' || target.grant_id !== request.grant_id) fail('unauthorized', 'The request no longer names the intended orchestrator.')
    if (request.grant_id !== null) assertGrantUsable(ctx, request.grant_id)
    else requireLiveSession(ctx, target)
    const decidedAt = ctx.clock.nowIso()
    ctx.db.run(
      'UPDATE save_permission_requests SET status = ?, decided_at = ?, decided_by_session_id = ?, decision_reason = ? WHERE id = ?',
      input.decision, decidedAt, actor.id, input.reason, request.id
    )
    appendEvent(ctx, { kind: 'save_permission.decided', payload: {
      requestId: request.id, sessionId: request.session_id, grantId: request.grant_id,
      decision: input.decision, reason: input.reason, decidedBySessionId: actor.id, decidedByRole: actor.role
    } })
    return view({ ...request, status: input.decision, decided_at: decidedAt, decided_by_session_id: actor.id, decision_reason: input.reason })
  })
}

/** Refresh before dispatch, so an already-open MCP/CLI workspace observes approval without reconnecting. */
export function refreshSavePermission(ctx: Ctx): void {
  if (ctx.session.role !== 'orchestrator') return
  const actor = sessionAuthority(ctx, ctx.session.id)
  const base = parseJson<Capability[]>(actor.launch_capabilities_json, [])
  const approved = ctx.db.get<{ id: string }>(
    `SELECT id FROM save_permission_requests WHERE machine_id = ? AND status = 'approved' AND
     ((? IS NOT NULL AND grant_id = ?) OR (? IS NULL AND session_id = ?)) LIMIT 1`,
    ctx.machineId, actor.grant_id, actor.grant_id, actor.grant_id, actor.id
  )
  const liveScope = actor.grant_id === null ? sessionIsLive(ctx, actor) : actor.ended_at === null
  if (approved !== undefined && liveScope && !base.includes('plan.save')) base.push('plan.save')
  const current = ctx.session.capabilities
  if (current.size === base.length && base.every((capability) => current.has(capability))) return
  ctx.session.capabilities = new Set(base)
  ctx.db.run('UPDATE sessions SET capabilities_json = ? WHERE id = ?', toJson(base), actor.id)
}
