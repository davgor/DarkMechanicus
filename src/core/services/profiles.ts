/**
 * Named capability profiles: reusable, provider-neutral requirement presets (for example
 * "ui-implementation" or "deep-review") that tickets start from. A save replaces the whole profile
 * under optimistic concurrency and queues the `.darkmechanicus/profiles/<name>.json` export.
 */
import { type CapabilityProfile, defaultCapabilityProfile } from '../../shared/domain/bundle'
import type { ProfileView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'
import { fail } from '../errors'
import { normalizeTags } from '../plan/normalize'
import { appendEvent } from './events'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { enqueueOutbox } from './outbox'

interface ProfileRow {
  name: string
  description: string
  capability_json: string
  revision: number
  created_at: string
  updated_at: string
}

interface SaveProfileInput {
  name: string
  description?: string
  capability: CapabilityProfile
  expectedRevision?: number
  idempotencyKey?: string
}

function toProfileView(row: ProfileRow): ProfileView {
  return {
    name: row.name,
    description: row.description,
    capability: parseJson<CapabilityProfile>(row.capability_json, defaultCapabilityProfile()),
    revision: row.revision,
    updatedAt: row.updated_at
  }
}

function conflictMessage(name: string, current: number, expected: number): string {
  if (current === 0) {
    return `Profile ${name} does not exist yet. Omit expectedRevision to create it.`
  }
  return expected === 0
    ? `Profile ${name} already exists (revision ${current}). Pass expectedRevision ${current} to replace it.`
    : `Profile ${name} changed (now revision ${current}). Reload it and try again.`
}

/** A missing profile is revision 0: creating expects 0 (or nothing), replacing expects the current revision. */
function assertExpectedRevision(name: string, current: number, expected: number): void {
  if (expected !== current) {
    fail('conflict', conflictMessage(name, current, expected), { name, currentRevision: current })
  }
}

function writeProfile(ctx: Ctx, input: SaveProfileInput): ProfileView {
  const existing = ctx.db.get<{ revision: number }>('SELECT revision FROM profiles WHERE name = ?', input.name)
  const current = existing?.revision ?? 0
  assertExpectedRevision(input.name, current, input.expectedRevision ?? 0)
  const view: ProfileView = {
    name: input.name,
    description: (input.description ?? '').trim(),
    capability: { ...input.capability, skills: normalizeTags(input.capability.skills) },
    revision: current + 1,
    updatedAt: ctx.clock.nowIso()
  }
  ctx.db.run(
    `INSERT INTO profiles (name, description, capability_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET description = excluded.description, capability_json = excluded.capability_json,
       revision = excluded.revision, updated_at = excluded.updated_at`,
    view.name,
    view.description,
    toJson(view.capability),
    view.revision,
    view.updatedAt,
    view.updatedAt
  )
  appendEvent(ctx, { kind: 'profile.saved', payload: { name: view.name, revision: view.revision } })
  enqueueOutbox(ctx, { kind: 'profile', entityId: view.name })
  return view
}

/** Creates or replaces a whole profile; an omitted description is saved as empty. */
export function saveProfile(ctx: Ctx, input: SaveProfileInput): ProfileView {
  requireCapability(ctx.session, 'profile.write')
  ctx.assertBranch()
  const scope = { command: 'saveProfile', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => writeProfile(ctx, input))
}

export function listProfiles(ctx: Ctx): ProfileView[] {
  requireCapability(ctx.session, 'read')
  return ctx.db.all<ProfileRow>('SELECT * FROM profiles ORDER BY name').map(toProfileView)
}

export function getProfile(ctx: Ctx, input: { name: string }): ProfileView {
  requireCapability(ctx.session, 'read')
  const row = ctx.db.get<ProfileRow>('SELECT * FROM profiles WHERE name = ?', input.name)
  return toProfileView(row ?? fail('not_found', `Profile ${input.name} not found.`, { name: input.name }))
}
