/**
 * Grants: how a session that is not a person's own desktop comes by a role.
 *
 * Over MCP the role is a launch flag, and that is trustworthy only because the person wrote the
 * configuration the host launches from. A local CLI has no such property — anything that can run
 * `dm` can pass any flag — so the role is not asked for, it is *granted*: a person issues one at
 * the desktop, and a session presents the token it was given.
 *
 * What the database keeps is only a SHA-256 of the token, so nothing stored here can be replayed;
 * the token itself is shown once, at issue, and never again. A grant names the machine it was
 * issued on, expires, and can be revoked. A grant never carries a human-only capability
 * (`HUMAN_ONLY_CAPABILITIES`): approving a checkpoint, deleting an epic and issuing a further
 * grant stay with the person, so no grant can widen itself.
 *
 * This is a boundary of intent, not of force. A process that can run the CLI can also open the
 * SQLite file directly, and nothing here stops it. What it buys is that every delegation is an
 * explicit, expiring, revocable row a person created — so going around it is unambiguous rather
 * than indistinguishable from ordinary use.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { GrantableRole, GrantView } from '../../shared/domain/views'
import { type Capability, capabilitiesForRole, HUMAN_ONLY_CAPABILITIES, requireCapability } from '../authz'
import type { Clock } from '../clock'
import type { Ctx } from '../context'
import type { Db } from '../db/database'
import { bool } from '../db/database'
import { fail } from '../errors'

/** Roles a person may delegate. `desktop` is never one of them: it is the person's own seat. */
export const GRANTABLE_ROLES: readonly GrantableRole[] = ['planner', 'orchestrator', 'worker', 'reviewer', 'reader']

export const MIN_GRANT_MINUTES = 5
export const MAX_GRANT_MINUTES = 7 * 24 * 60
export const DEFAULT_GRANT_MINUTES = 8 * 60

const TOKEN_BYTES = 32
const TOKEN_PREFIX = 'dmg_'

interface GrantRow {
  id: string
  role: GrantableRole
  allow_save: number
  label: string
  machine_id: string
  created_at: string
  expires_at: string
  revoked_at: string | null
  last_used_at: string | null
}

/** A token as the person is shown it, once. */
function formatToken(secret: string): string {
  return `${TOKEN_PREFIX}${secret}`
}

/** The stored form of a token. Only this ever reaches the database. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token.trim()).digest('hex')
}

function viewOf(row: GrantRow, now: string): GrantView {
  return {
    id: row.id,
    role: row.role,
    allowSave: row.allow_save === 1,
    label: row.label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    active: row.revoked_at === null && row.expires_at > now
  }
}

function expiryOf(clock: Clock, minutes: number): string {
  return new Date(clock.nowMs() + minutes * 60_000).toISOString()
}

interface IssueGrantInput {
  role: GrantableRole
  label: string
  /** Minutes the grant stays usable. Outside the allowed range it is refused, not clamped. */
  minutes?: number
  /** Only a planner or orchestrator grant can carry it; ignored for any other role. */
  allowSave?: boolean
}

/**
 * Issues a grant and returns it with the token, which is shown once and never stored. Refused
 * unless the session holds `grant.issue`, which only the desktop does.
 */
export function issueGrant(ctx: Ctx, input: IssueGrantInput): { grant: GrantView; token: string } {
  requireCapability(ctx.session, 'grant.issue')
  if (!GRANTABLE_ROLES.includes(input.role)) {
    fail('invalid_input', `A ${input.role} role cannot be granted.`, { role: input.role })
  }
  const minutes = input.minutes ?? DEFAULT_GRANT_MINUTES
  // The command schema checks this too; a caller that reached the service directly must not be
  // able to produce a grant that never expires, or an unparseable date.
  if (!Number.isInteger(minutes) || minutes < MIN_GRANT_MINUTES || minutes > MAX_GRANT_MINUTES) {
    fail('invalid_input', `A grant lasts between ${MIN_GRANT_MINUTES} and ${MAX_GRANT_MINUTES} minutes.`, { minutes })
  }
  const canSave = input.allowSave === true && (input.role === 'planner' || input.role === 'orchestrator')
  const token = formatToken(randomBytes(TOKEN_BYTES).toString('hex'))
  const id = ctx.ids.next('grant')
  const now = ctx.clock.nowIso()
  const row: GrantRow = {
    id,
    role: input.role,
    allow_save: canSave ? 1 : 0,
    label: input.label,
    machine_id: ctx.machineId,
    created_at: now,
    expires_at: expiryOf(ctx.clock, minutes),
    revoked_at: null,
    last_used_at: null
  }
  ctx.db.run(
    `INSERT INTO grants (id, role, allow_save, label, token_hash, machine_id, issued_by_session, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    row.id,
    row.role,
    bool(canSave),
    row.label,
    hashToken(token),
    row.machine_id,
    ctx.session.id,
    row.created_at,
    row.expires_at
  )
  return { grant: viewOf(row, now), token }
}

export function listGrants(ctx: Ctx): GrantView[] {
  requireCapability(ctx.session, 'read')
  const now = ctx.clock.nowIso()
  return ctx.db
    .all<GrantRow>(
      `SELECT id, role, allow_save, label, machine_id, created_at, expires_at, revoked_at, last_used_at
       FROM grants ORDER BY created_at DESC, id DESC`
    )
    .map((row) => viewOf(row, now))
}

/** Revokes a grant. Already revoked is a no-op, so revoking twice is not an error. */
export function revokeGrant(ctx: Ctx, grantId: string): GrantView {
  requireCapability(ctx.session, 'grant.revoke')
  const now = ctx.clock.nowIso()
  const row = ctx.db.get<GrantRow>(
    `SELECT id, role, allow_save, label, machine_id, created_at, expires_at, revoked_at, last_used_at
     FROM grants WHERE id = ?`,
    grantId
  )
  if (row === undefined) {
    fail('not_found', `Grant ${grantId} does not exist.`, { grantId })
  }
  if (row.revoked_at === null) {
    ctx.db.run('UPDATE grants SET revoked_at = ? WHERE id = ?', now, grantId)
  }
  return viewOf({ ...row, revoked_at: row.revoked_at ?? now }, now)
}

export interface RedeemedGrant {
  grantId: string
  role: GrantableRole
  capabilities: Capability[]
}

interface RedeemDeps {
  db: Db
  clock: Clock
  /** This machine; a grant issued on another one is refused. */
  machineId: string
}

/** The one sentence every unusable grant gets, so probing cannot tell the reasons apart. */
const NOT_USABLE = 'That grant is not usable: it is unknown, expired, revoked, or was issued on another machine.'

/**
 * Still good: not revoked, not past its expiry, and issued on this machine. Checked again before
 * every command of a session that presented one, so revoking a grant stops the session it is
 * running rather than only the next one to start.
 */
export function assertGrantUsable(deps: RedeemDeps, grantId: string): void {
  const row = deps.db.get<Pick<GrantRow, 'expires_at' | 'revoked_at' | 'machine_id'>>(
    'SELECT expires_at, revoked_at, machine_id FROM grants WHERE id = ?',
    grantId
  )
  const now = deps.clock.nowIso()
  if (row === undefined || row.revoked_at !== null || row.expires_at <= now || row.machine_id !== deps.machineId) {
    fail('unauthorized', NOT_USABLE)
  }
}

/**
 * Turns a token into the role and capabilities a session may run with, and records the use.
 * Fails with `unauthorized` for a token that is unknown, expired, revoked, or issued elsewhere —
 * all with the same message, so a caller cannot learn which by probing.
 */
export function redeemGrant(deps: RedeemDeps, token: string): RedeemedGrant {
  const now = deps.clock.nowIso()
  const row = deps.db.get<GrantRow & { token_hash: string }>(
    `SELECT id, role, allow_save, label, machine_id, token_hash, created_at, expires_at, revoked_at, last_used_at
     FROM grants WHERE token_hash = ?`,
    hashToken(token)
  )
  const usable =
    row !== undefined && row.revoked_at === null && row.expires_at > now && row.machine_id === deps.machineId
  if (!usable) {
    fail('unauthorized', NOT_USABLE)
  }
  deps.db.run('UPDATE grants SET last_used_at = ? WHERE id = ?', now, row.id)
  return {
    grantId: row.id,
    role: row.role,
    capabilities: grantedCapabilities(row.role, row.allow_save === 1)
  }
}

/**
 * Strips every capability reserved to a person. Today no grantable role's base set contains one,
 * so this changes nothing — which is exactly why it is separate and tested directly: it is the
 * only thing standing between a future edit to `ROLE_CAPABILITIES` and a grant that confers one,
 * and an identity function that is never exercised is indistinguishable from a deleted one.
 */
export function withoutHumanOnly(capabilities: readonly Capability[]): Capability[] {
  return capabilities.filter((capability) => !HUMAN_ONLY_CAPABILITIES.includes(capability))
}

/** What a grant of `role` confers: its role's capabilities, never anything reserved to a person. */
export function grantedCapabilities(role: GrantableRole, allowSave: boolean): Capability[] {
  return withoutHumanOnly(capabilitiesForRole(role, { allowSave }))
}
