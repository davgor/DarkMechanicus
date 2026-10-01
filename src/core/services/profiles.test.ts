import { describe, expect, it } from 'vitest'
import { type CapabilityProfile, defaultCapabilityProfile } from '../../shared/domain/bundle'
import { captureError, eventKinds } from '../../test/authoring'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { DomainError } from '../errors'
import { getProfile, listProfiles, saveProfile } from './profiles'

const T0 = '2026-01-01T00:00:00.000Z'
const T1 = '2026-01-01T00:01:00.000Z'

function review(): CapabilityProfile {
  const base = defaultCapabilityProfile()
  return {
    ...base,
    workType: 'review',
    reasoning: { level: 'deep', rationale: 'Independent verification of risky changes' },
    skills: ['security-review'],
    tools: ['repo_read', 'test_execution'],
    preferences: { ...base.preferences, quality: 'high' }
  }
}

function profileRows(ctx: TestCtx): unknown[] {
  return ctx.db.all('SELECT name, description, capability_json, revision, created_at, updated_at FROM profiles ORDER BY name')
}

function profileOutbox(ctx: TestCtx): unknown[] {
  return ctx.db.all("SELECT kind, entity_id, epic_id, state FROM outbox WHERE kind = 'profile' ORDER BY id")
}

describe('saveProfile creates a profile', () => {
  it('stores revision 1, records a profile.saved event, and queues the export', () => {
    const ctx = createTestCtx()
    const view = saveProfile(ctx, { name: 'deep-review', description: 'Careful review', capability: review() })
    expect(view).toEqual({ name: 'deep-review', description: 'Careful review', capability: review(), revision: 1, updatedAt: T0 })
    expect(profileRows(ctx)).toEqual([
      {
        name: 'deep-review',
        description: 'Careful review',
        capability_json: JSON.stringify(review()),
        revision: 1,
        created_at: T0,
        updated_at: T0
      }
    ])
    expect(eventKinds(ctx)).toEqual(['profile.saved'])
    expect(ctx.db.get('SELECT payload_json, epic_id FROM events')).toEqual({
      payload_json: '{"name":"deep-review","revision":1}',
      epic_id: null
    })
    expect(profileOutbox(ctx)).toEqual([{ kind: 'profile', entity_id: 'deep-review', epic_id: null, state: 'pending' }])
  })

  it('creates with an explicit expectedRevision of 0 and trims the description', () => {
    const ctx = createTestCtx()
    const view = saveProfile(ctx, { name: 'ui', description: '  UI work  ', capability: review(), expectedRevision: 0 })
    expect([view.revision, view.description]).toEqual([1, 'UI work'])
    expect(saveProfile(ctx, { name: 'bare', capability: review() }).description).toBe('')
  })

  it('normalizes skills the way tickets do', () => {
    const ctx = createTestCtx()
    const capability = { ...review(), skills: [' TypeScript ', 'typescript', '', 'UI'] }
    expect(saveProfile(ctx, { name: 'ui', capability }).capability.skills).toEqual(['TypeScript', 'UI'])
  })
})

describe('saveProfile replaces a profile', () => {
  it('replaces the whole profile at the current revision and keeps its creation time', () => {
    const ctx = createTestCtx()
    saveProfile(ctx, { name: 'deep-review', description: 'Careful review', capability: review() })
    ctx.clock.advanceSeconds(60)
    const changed = { ...review(), workType: 'testing' as const }
    const view = saveProfile(ctx, { name: 'deep-review', capability: changed, expectedRevision: 1 })
    expect(view).toEqual({ name: 'deep-review', description: '', capability: changed, revision: 2, updatedAt: T1 })
    expect(ctx.db.get('SELECT revision, created_at, updated_at FROM profiles')).toEqual({ revision: 2, created_at: T0, updated_at: T1 })
    expect(saveProfile(ctx, { name: 'deep-review', capability: review(), expectedRevision: 2 }).revision).toBe(3)
    expect(eventKinds(ctx)).toEqual(['profile.saved', 'profile.saved', 'profile.saved'])
  })

  it('coalesces pending exports per profile name', () => {
    const ctx = createTestCtx()
    saveProfile(ctx, { name: 'b-profile', capability: review() })
    saveProfile(ctx, { name: 'a-profile', capability: review() })
    saveProfile(ctx, { name: 'b-profile', capability: review(), expectedRevision: 1 })
    expect(profileOutbox(ctx)).toEqual([
      { kind: 'profile', entity_id: 'b-profile', epic_id: null, state: 'pending' },
      { kind: 'profile', entity_id: 'a-profile', epic_id: null, state: 'pending' }
    ])
  })
})

describe('saveProfile revision conflicts', () => {
  it.each([
    [undefined, 'Profile deep-review already exists (revision 1). Pass expectedRevision 1 to replace it.'],
    [0, 'Profile deep-review already exists (revision 1). Pass expectedRevision 1 to replace it.'],
    [2, 'Profile deep-review changed (now revision 1). Reload it and try again.']
  ])('refuses expectedRevision %s for an existing profile and changes nothing', (expectedRevision, message) => {
    const ctx = createTestCtx()
    saveProfile(ctx, { name: 'deep-review', description: 'kept', capability: review() })
    const before = profileRows(ctx)
    const error = captureError(() => saveProfile(ctx, { name: 'deep-review', capability: defaultCapabilityProfile(), expectedRevision }))
    expect(error).toEqual({ code: 'conflict', message, details: { name: 'deep-review', currentRevision: 1 } })
    expect(profileRows(ctx)).toEqual(before)
    expect(eventKinds(ctx)).toEqual(['profile.saved'])
  })

  it('refuses to replace a profile that does not exist', () => {
    const ctx = createTestCtx()
    const error = captureError(() => saveProfile(ctx, { name: 'ghost', capability: review(), expectedRevision: 3 }))
    expect(error).toEqual({
      code: 'conflict',
      message: 'Profile ghost does not exist yet. Omit expectedRevision to create it.',
      details: { name: 'ghost', currentRevision: 0 }
    })
    expect([profileRows(ctx), eventKinds(ctx), profileOutbox(ctx)]).toEqual([[], [], []])
  })
})

describe('saveProfile guards', () => {
  it.each(['worker', 'reviewer'] as const)('refuses a %s session', (role) => {
    const ctx = withRole(createTestCtx(), role)
    const error = captureError(() => saveProfile(ctx, { name: 'deep-review', capability: review() }))
    expect([error.code, error.message]).toEqual(['unauthorized', `This ${role} session is not permitted to perform "profile.write".`])
    expect(profileRows(ctx)).toEqual([])
  })

  it.each(['desktop', 'planner', 'orchestrator'] as const)('lets a %s session save', (role) => {
    const ctx = withRole(createTestCtx(), role)
    expect(saveProfile(ctx, { name: 'deep-review', capability: review() }).revision).toBe(1)
  })

  it('stops before writing when the checkout branch moved', () => {
    const ctx = createTestCtx({
      assertBranch: () => {
        throw new DomainError('branch_changed', 'moved')
      }
    })
    expect(captureError(() => saveProfile(ctx, { name: 'deep-review', capability: review() })).code).toBe('branch_changed')
    expect([profileRows(ctx), eventKinds(ctx)]).toEqual([[], []])
  })
})

describe('saveProfile idempotency', () => {
  it('returns the original result for a repeated request and refuses a different one', () => {
    const ctx = createTestCtx()
    const first = saveProfile(ctx, { name: 'deep-review', capability: review(), idempotencyKey: 'k1' })
    ctx.clock.advanceSeconds(60)
    expect(saveProfile(ctx, { name: 'deep-review', capability: review(), idempotencyKey: 'k1' })).toEqual(first)
    expect(ctx.db.get('SELECT revision FROM profiles')).toEqual({ revision: 1 })
    const error = captureError(() => saveProfile(ctx, { name: 'other', capability: review(), idempotencyKey: 'k1' }))
    expect(error.code).toBe('idempotency_mismatch')
    expect(eventKinds(ctx)).toEqual(['profile.saved'])
  })
})

describe('listProfiles and getProfile', () => {
  it('lists profiles sorted by name and reads one by name', () => {
    const ctx = createTestCtx()
    expect(listProfiles(ctx)).toEqual([])
    saveProfile(ctx, { name: 'ui-implementation', capability: defaultCapabilityProfile() })
    saveProfile(ctx, { name: 'deep-review', description: 'Careful review', capability: review() })
    saveProfile(ctx, { name: '2-fast', capability: defaultCapabilityProfile() })
    expect(listProfiles(ctx).map((profile) => profile.name)).toEqual(['2-fast', 'deep-review', 'ui-implementation'])
    expect(getProfile(ctx, { name: 'deep-review' })).toEqual({
      name: 'deep-review',
      description: 'Careful review',
      capability: review(),
      revision: 1,
      updatedAt: T0
    })
  })

  it('reports a missing profile as not_found', () => {
    const error = captureError(() => getProfile(createTestCtx(), { name: 'ghost' }))
    expect(error).toEqual({ code: 'not_found', message: 'Profile ghost not found.', details: { name: 'ghost' } })
  })

  it('requires the read capability', () => {
    const ctx = createTestCtx({ capabilities: [] })
    expect(captureError(() => listProfiles(ctx)).code).toBe('unauthorized')
    expect(captureError(() => getProfile(ctx, { name: 'x' })).message).toBe('This orchestrator session is not permitted to perform "read".')
    expect(listProfiles(withRole(ctx, 'worker'))).toEqual([])
  })
})
