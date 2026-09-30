import type { SessionRole, SessionView } from '../../shared/domain/views'
import { type Capability, type SessionContext } from '../authz'
import type { Clock } from '../clock'
import type { Db } from '../db/database'
import { parseJson, toJson } from '../db/database'
import type { IdGenerator } from '../ids'

/** A session that has not heartbeated within this window no longer counts as active. */
export const SESSION_ACTIVE_WINDOW_MS = 60_000

export interface SessionRegistration {
  role: SessionRole
  label: string
  transport: 'stdio' | 'desktop' | 'in_process'
  pid: number | null
  capabilities: Capability[]
}

interface SessionRow {
  id: string
  role: SessionRole
  label: string
  capabilities_json: string
  transport: string
  pid: number | null
  started_at: string
  last_seen_at: string
  ended_at: string | null
}

export function registerSession(
  deps: { db: Db; clock: Clock; ids: IdGenerator },
  registration: SessionRegistration
): SessionContext {
  const id = deps.ids.next('session')
  const now = deps.clock.nowIso()
  deps.db.tx(() => {
    deps.db.run(
      `INSERT INTO sessions (id, role, label, capabilities_json, transport, pid, started_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      registration.role,
      registration.label,
      toJson(registration.capabilities),
      registration.transport,
      registration.pid,
      now,
      now
    )
  })
  return {
    id,
    role: registration.role,
    label: registration.label,
    capabilities: new Set(registration.capabilities)
  }
}

export function touchSession(deps: { db: Db; clock: Clock }, sessionId: string): void {
  deps.db.tx(() => {
    deps.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', deps.clock.nowIso(), sessionId)
  })
}

export function endSession(deps: { db: Db; clock: Clock }, sessionId: string): void {
  deps.db.tx(() => {
    deps.db.run('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL', deps.clock.nowIso(), sessionId)
  })
}

function isActive(row: SessionRow, nowMs: number): boolean {
  return row.ended_at === null && nowMs - Date.parse(row.last_seen_at) <= SESSION_ACTIVE_WINDOW_MS
}

function toSessionView(row: SessionRow, nowMs: number): SessionView {
  return {
    id: row.id,
    role: row.role,
    label: row.label,
    transport: row.transport,
    pid: row.pid,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    active: isActive(row, nowMs)
  }
}

export function listSessions(deps: { db: Db; clock: Clock }, limit = 50): SessionView[] {
  const nowMs = deps.clock.nowMs()
  return deps.db
    .all<SessionRow>('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?', limit)
    .map((row) => toSessionView(row, nowMs))
}

export function summarizeActiveSessions(
  deps: { db: Db; clock: Clock }
): { active: number; byRole: Record<string, number> } {
  const byRole: Record<string, number> = {}
  let active = 0
  for (const session of listSessions(deps, 500)) {
    if (session.active) {
      active += 1
      byRole[session.role] = (byRole[session.role] ?? 0) + 1
    }
  }
  return { active, byRole }
}

export function sessionCapabilities(row: { capabilities_json: string }): Capability[] {
  return parseJson<Capability[]>(row.capabilities_json, [])
}
