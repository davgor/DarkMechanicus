import type { CapabilitiesView } from '../../shared/domain/views'
import type { Capability } from '../authz'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { assertGrantUsable } from './grants'
import { isYoloDesktopLive, proveYoloDesktop } from './yoloFence'

export const YOLO_CAPABILITIES: readonly Capability[] = ['plan.save', 'ticket.retry_grant', 'checkpoint.approve', 'checkpoint.advance']

interface YoloBinding {
  grantId: string
  chatId: string
  generation: string
  desktopId: string
  desktopPid: number
  fencePath: string
  proofEndpoint: string
  proofPublicKey: string
  runId: string | null
  cardId?: string
}

interface BindingRow { chat_id: string; generation: string; desktop_id: string; desktop_pid: number; fence_path: string; proof_endpoint: string; proof_public_key: string; folder: string; card_id: string | null }
interface ElevationRow extends BindingRow { run_id: string | null; expires_at: string; revoked_at: string | null }

interface YoloAuditEntry {
  id: number
  time: string
  grantId: string
  sessionId: string
  folder: string
  runId: string | null
  capability: string
  command: string
  result: string
  targetId: string | null
  boundCardId: string | null
}

function requireDesktop(ctx: Ctx): void {
  if (ctx.session.role !== 'desktop') fail('unauthorized', 'Only a live desktop person can approve YOLO.')
}

/** Payloads, error messages, tokens and labels never enter this ledger. */
export function auditYolo(ctx: Ctx, input: { grantId: string; runId: string | null; capability: string; command: string; targetId?: string | null; result: 'admitted' | 'succeeded' | 'failed' | 'refused' | 'approved' | 'revoked' }): void {
  const scope = ctx.db.get<{ card_id: string | null }>('SELECT card_id FROM yolo_elevations WHERE grant_id = ?', input.grantId)
  ctx.db.run(`INSERT INTO yolo_audit (time, grant_id, session_id, folder, run_id, capability, command, result, target_id, card_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.clock.nowIso(), input.grantId, ctx.session.id, ctx.projectRoot, input.runId, input.capability, input.command, input.result, input.targetId ?? null, scope?.card_id ?? null)
}

/** Main owns this binding; no command or renderer can manufacture it. Rebinding ends former consent. */
export function bindYoloChat(ctx: Ctx, binding: YoloBinding): void {
  requireDesktop(ctx)
  revokeYolo(ctx, binding.grantId)
  ctx.db.run(`INSERT INTO yolo_chat_bindings (grant_id, chat_id, generation, desktop_id, desktop_pid, fence_path, proof_endpoint, proof_public_key, folder, card_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(grant_id) DO UPDATE SET chat_id = excluded.chat_id, generation = excluded.generation, desktop_id = excluded.desktop_id, desktop_pid = excluded.desktop_pid, fence_path = excluded.fence_path, proof_endpoint = excluded.proof_endpoint, proof_public_key = excluded.proof_public_key, folder = excluded.folder, card_id = excluded.card_id`,
    binding.grantId, binding.chatId, binding.generation, binding.desktopId, binding.desktopPid, binding.fencePath, binding.proofEndpoint, binding.proofPublicKey, ctx.projectRoot, binding.cardId ?? null)
}

export function endYoloChat(ctx: Ctx, grantId: string): void {
  requireDesktop(ctx)
  revokeYolo(ctx, grantId)
  ctx.db.run('DELETE FROM yolo_chat_bindings WHERE grant_id = ?', grantId)
}


function bindingMatches(row: BindingRow, binding: YoloBinding, folder: string): boolean {
  const identity = row.chat_id === binding.chatId && row.generation === binding.generation && row.folder === folder && row.card_id === (binding.cardId ?? null)
  return identity && fenceMatches(row, binding)
}

function fenceMatches(row: BindingRow, binding: YoloBinding): boolean {
  return row.desktop_id === binding.desktopId && row.desktop_pid === binding.desktopPid && row.fence_path === binding.fencePath &&
    row.proof_endpoint === binding.proofEndpoint && row.proof_public_key === binding.proofPublicKey
}

function rowFence(row: BindingRow) {
  return { path: row.fence_path, instance: row.desktop_id, pid: row.desktop_pid, proofEndpoint: row.proof_endpoint, proofPublicKey: row.proof_public_key }
}

function requireYoloApproval(ctx: Ctx, binding: YoloBinding): void {
  const live = ctx.db.get<BindingRow>('SELECT * FROM yolo_chat_bindings WHERE grant_id = ?', binding.grantId)
  const matched = live !== undefined && bindingMatches(live, binding, ctx.projectRoot)
  const alive = isYoloDesktopLive({ path: binding.fencePath, instance: binding.desktopId, pid: binding.desktopPid, proofEndpoint: binding.proofEndpoint, proofPublicKey: binding.proofPublicKey })
  if (ctx.session.role !== 'desktop' || !matched || !alive) {
    auditYolo(ctx, { grantId: binding.grantId, runId: null, capability: 'yolo.enable', command: 'yolo.enable', result: 'refused' })
    fail('unauthorized', 'Only a live desktop person can approve an existing active chat start.')
  }
  assertGrantUsable(ctx, binding.grantId)
}

function yoloApprovalExpiry(ctx: Ctx, binding: YoloBinding, confirmedExpiry?: string): string {
  const parent = ctx.db.get<{ expires_at: string }>('SELECT expires_at FROM grants WHERE id = ?', binding.grantId)
  if (!parent) fail('unauthorized', 'That grant is no longer active.')
  const current = ctx.db.get<{ expires_at: string; revoked_at: string | null }>('SELECT expires_at, revoked_at FROM yolo_elevations WHERE grant_id = ?', binding.grantId)
  if (current?.revoked_at === null && current.expires_at > ctx.clock.nowIso()) {
    auditYolo(ctx, { grantId: binding.grantId, runId: binding.runId, capability: 'yolo.enable', command: 'yolo.enable', result: 'refused' })
    fail('conflict', 'YOLO is already active; its fixed lifetime cannot be extended.')
  }
  const maximum = ctx.clock.nowMs() + 24 * 60 * 60_000
  const confirmed = confirmedExpiry === undefined ? maximum : Date.parse(confirmedExpiry)
  return new Date(Math.min(maximum, Date.parse(parent.expires_at), confirmed)).toISOString()
}

/** Called by main only after its own native confirmation, never exposed as an agent command. */
export function approveYolo(ctx: Ctx, binding: YoloBinding, confirmedExpiry?: string): { expiresAt: string } {
  requireYoloApproval(ctx, binding)
  const expiresAt = yoloApprovalExpiry(ctx, binding, confirmedExpiry)
  ctx.db.run(`INSERT INTO yolo_elevations (grant_id, chat_id, generation, desktop_id, folder, run_id, card_id, expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
    ON CONFLICT(grant_id) DO UPDATE SET chat_id = excluded.chat_id, generation = excluded.generation, desktop_id = excluded.desktop_id, folder = excluded.folder, run_id = excluded.run_id, card_id = excluded.card_id, expires_at = excluded.expires_at, revoked_at = NULL`,
    binding.grantId, binding.chatId, binding.generation, binding.desktopId, ctx.projectRoot, binding.runId, binding.cardId ?? null, expiresAt)
  auditYolo(ctx, { grantId: binding.grantId, runId: binding.runId, capability: 'yolo.enable', command: 'yolo.enable', result: 'approved' })
  return { expiresAt }
}

export function revokeYolo(ctx: Ctx, grantId: string): void {
  requireDesktop(ctx)
  const scope = ctx.db.get<{ run_id: string | null }>('SELECT run_id FROM yolo_elevations WHERE grant_id = ?', grantId)
  const result = ctx.db.run('UPDATE yolo_elevations SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL', ctx.clock.nowIso(), grantId)
  if (result.changes > 0) auditYolo(ctx, { grantId, runId: scope?.run_id ?? null, capability: 'yolo.revoke', command: 'yolo.revoke', result: 'revoked' })
}

export function isYoloEligible(ctx: Ctx, grantId: string, capability: Capability, runId: string | null): boolean {
  if (!YOLO_CAPABILITIES.includes(capability)) return false
  const row = ctx.db.get<ElevationRow>(`SELECT e.*, b.desktop_pid, b.fence_path, b.proof_endpoint, b.proof_public_key FROM yolo_elevations e JOIN yolo_chat_bindings b ON b.grant_id = e.grant_id
    AND b.chat_id = e.chat_id AND b.generation = e.generation AND b.desktop_id = e.desktop_id AND b.folder = e.folder AND b.card_id IS e.card_id
    JOIN grants g ON g.id = e.grant_id WHERE e.grant_id = ? AND g.revoked_at IS NULL AND g.expires_at > ? AND g.machine_id = ?`, grantId, ctx.clock.nowIso(), ctx.machineId)
  if (!row || row.revoked_at !== null || row.expires_at <= ctx.clock.nowIso() || row.folder !== ctx.projectRoot || row.run_id !== runId) return false
  return isYoloDesktopLive(rowFence(row))
}

/** Only the recorded main endpoint/key may prove this grant's live desktop instance. */
export async function proveYoloGrant(ctx: Ctx, grantId: string): Promise<boolean> {
  const row = ctx.db.get<BindingRow>('SELECT * FROM yolo_chat_bindings WHERE grant_id = ?', grantId)
  return row !== undefined && await proveYoloDesktop(rowFence(row))
}

export function listYoloAudit(ctx: Ctx, scope: { runId?: string | null; grantId?: string; boundCardId?: string } = {}): YoloAuditEntry[] {
  return ctx.db.all<YoloAuditEntry>(`SELECT id, time, grant_id AS grantId, session_id AS sessionId, folder, run_id AS runId, capability, command, result, target_id AS targetId, card_id AS boundCardId FROM yolo_audit
    WHERE (? = 1 OR run_id IS ?) AND (? IS NULL OR grant_id = ?) AND (? IS NULL OR card_id = ?) ORDER BY id`,
    scope.runId === undefined ? 1 : 0, scope.runId ?? null, scope.grantId ?? null, scope.grantId ?? null, scope.boundCardId ?? null, scope.boundCardId ?? null)
}

/** Recommendations remain agent-authored prose, never a grant or an authorization decision. */
export function yoloEvidence(entries: readonly YoloAuditEntry[], suggestions: readonly string[]): string[] {
  const capabilities = new Set(entries.filter((entry) => entry.result === 'admitted').map((entry) => entry.capability))
  for (const capability of capabilities) {
    const prefix = `[YOLO ${capability}] `
    if (!suggestions.some((suggestion) => suggestion.startsWith(prefix) && /^(planner|orchestrator|worker|reviewer): \S.{15,}$/.test(suggestion.slice(prefix.length)))) {
      fail('invalid_input', `Add an agent-authored permission suggestion for ${capability}: [YOLO ${capability}] role: specific safer scope and reason. Recommendations grant no authority.`)
    }
  }
  return entries.map((entry) => `${entry.id} | ${entry.time} | grant=${entry.grantId} | session=${entry.sessionId} | folder=${entry.folder} | run=${entry.runId ?? 'none'} | card=${entry.boundCardId ?? 'none'} | ${entry.capability} | ${entry.command} | ${entry.result} | target=${entry.targetId ?? 'none'}`)
}

export function yoloSessionScope(ctx: Ctx): CapabilitiesView['yolo'] {
  const row = ctx.db.get<{ grant_id: string; chat_id: string; folder: string; run_id: string | null; expires_at: string }>(
    'SELECT e.grant_id, e.chat_id, e.folder, e.run_id, e.expires_at FROM yolo_elevations e JOIN sessions s ON s.grant_id = e.grant_id WHERE s.id = ?', ctx.session.id)
  if (!row || !isYoloEligible(ctx, row.grant_id, 'plan.save', row.run_id)) return undefined
  return { grantId: row.grant_id, chatId: row.chat_id, folder: row.folder, runId: row.run_id, expiresAt: row.expires_at, capabilities: YOLO_CAPABILITIES, transport: 'cli', admission: 'fresh_desktop_challenge_required' }
}
