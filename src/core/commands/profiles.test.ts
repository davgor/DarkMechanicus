import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type CapabilityProfile, defaultCapabilityProfile } from '../../shared/domain/bundle'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import type { Workspace } from '../workspace'

async function failureOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
    return { code: 'ok', message: '' }
  } catch (error: unknown) {
    const { code, message } = error as { code?: string; message: string }
    return { code: code ?? 'thrown', message }
  }
}

function review(): CapabilityProfile {
  return { ...defaultCapabilityProfile(), workType: 'review', reasoning: { level: 'deep', rationale: 'Careful' } }
}

function profilesDir(harness: Harness): string {
  return join(harness.root, '.darkmechanicus', 'profiles')
}

describe('profile commands over the Workspace', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  async function initialized(role: 'desktop' | 'planner' | 'worker' = 'planner'): Promise<Workspace> {
    await harness.open('orchestrator').initializeRepository({ name: 'profile-repo' })
    return harness.open(role)
  }

  it('saves a profile, exports profiles/<name>.json, and reads it back', async () => {
    const planner = await initialized()
    const saved = await planner.saveProfile({ name: 'deep-review', description: 'Careful review', capability: review() })
    expect(saved).toEqual({ name: 'deep-review', description: 'Careful review', capability: review(), revision: 1, updatedAt: '2026-03-01T10:00:00.000Z' })
    const record = JSON.parse(readFileSync(join(profilesDir(harness), 'deep-review.json'), 'utf8')) as Record<string, unknown>
    expect(record).toMatchObject({ format: 'darkmechanicus.profile', formatVersion: 1, name: 'deep-review', capability: review() })
    expect(await planner.listProfiles()).toEqual([saved])
    expect(await planner.getProfile({ name: 'deep-review' })).toEqual(saved)
    expect((await planner.getStorageStatus()).outbox).toEqual({ pending: 0, failed: 0, lastError: null })
  })

  it('replaces a profile at its revision and refuses a stale one', async () => {
    const desktop = await initialized('desktop')
    await desktop.saveProfile({ name: 'ui', capability: review() })
    const replaced = await desktop.saveProfile({ name: 'ui', capability: defaultCapabilityProfile(), expectedRevision: 1 })
    expect(replaced.revision).toBe(2)
    expect(await failureOf(desktop.saveProfile({ name: 'ui', capability: review(), expectedRevision: 1 }))).toEqual({
      code: 'conflict',
      message: 'Profile ui changed (now revision 2). Reload it and try again.'
    })
    expect(JSON.parse(readFileSync(join(profilesDir(harness), 'ui.json'), 'utf8')).capability).toEqual(defaultCapabilityProfile())
  })

  it('refuses workers and reports missing profiles', async () => {
    const worker = await initialized('worker')
    expect((await failureOf(worker.saveProfile({ name: 'ui', capability: review() }))).code).toBe('unauthorized')
    expect(await worker.listProfiles()).toEqual([])
    expect(await failureOf(worker.getProfile({ name: 'ghost' }))).toEqual({ code: 'not_found', message: 'Profile ghost not found.' })
  })
})

describe('profile command input validation', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it.each([
    ['a traversal name', { name: '../escape', capability: review() }, 'Invalid saveProfile input at name: Use 1-64 lowercase letters'],
    ['a device name', { name: 'nul', capability: review() }, 'Invalid saveProfile input at name: Use 1-64'],
    ['an uppercase name', { name: 'Deep', capability: review() }, 'Invalid saveProfile input at name: Use 1-64'],
    ['a 65-character name', { name: 'a'.repeat(65), capability: review() }, 'Invalid saveProfile input at name: Use 1-64'],
    ['a partial capability', { name: 'ui', capability: { workType: 'review' } }, 'Invalid saveProfile input at capability.reasoning'],
    ['a vendor work type', { name: 'ui', capability: { ...review(), workType: 'gpt' } }, 'Invalid saveProfile input at capability.workType'],
    ['an unknown key', { name: 'ui', capability: review(), model: 'x' }, 'Invalid saveProfile input: Unrecognized key: "model"'],
    ['a 501-character description', { name: 'ui', description: 'x'.repeat(501), capability: review() }, 'Invalid saveProfile input at description'],
    ['a negative revision', { name: 'ui', capability: review(), expectedRevision: -1 }, 'Invalid saveProfile input at expectedRevision']
  ])('rejects %s before anything is stored', async (_label, input, message) => {
    const agent = harness.open('orchestrator')
    await agent.initializeRepository({ name: 'validation-repo' })
    const failure = await failureOf(agent.saveProfile(input as never))
    expect(failure.code).toBe('invalid_input')
    expect(failure.message.startsWith(message)).toBe(true)
    expect(await agent.listProfiles()).toEqual([])
    expect(readdirSync(profilesDir(harness))).toEqual([])
  })

  it('validates getProfile names and accepts a 500-character description', async () => {
    const agent = harness.open('orchestrator')
    await agent.initializeRepository({ name: 'validation-repo' })
    expect((await failureOf(agent.getProfile({ name: '../../etc/passwd' }))).code).toBe('invalid_input')
    expect((await agent.saveProfile({ name: 'long', description: 'x'.repeat(500), capability: review() })).description).toHaveLength(500)
  })
})

describe('profile export containment', () => {
  let harness: Harness

  beforeEach(() => {
    harness = createHarness()
  })

  afterEach(() => {
    harness.cleanup()
  })

  it('never writes through a linked profiles directory; the export stays queued', async () => {
    const agent = harness.open('orchestrator')
    await agent.initializeRepository({ name: 'contained-repo' })
    const outside = join(harness.cloneTracked(), 'outside')
    mkdirSync(outside)
    rmSync(profilesDir(harness), { recursive: true })
    symlinkSync(outside, profilesDir(harness), 'junction')
    expect((await agent.saveProfile({ name: 'ui', capability: review() })).revision).toBe(1)
    expect(existsSync(join(outside, 'ui.json'))).toBe(false)
    const status = await agent.getStorageStatus()
    expect([status.outbox.pending, status.outbox.lastError]).toEqual([1, expect.stringContaining('symbolic links and junctions are not allowed')])
  })

  it('refuses to save while the checkout branch has moved', async () => {
    const agent = harness.open('orchestrator')
    await agent.initializeRepository({ name: 'branch-repo' })
    harness.git.setHead({ branch: 'feature', commit: 'c'.repeat(40), detached: false })
    expect((await failureOf(agent.saveProfile({ name: 'ui', capability: review() }))).code).toBe('branch_changed')
    expect(await agent.listProfiles()).toEqual([])
  })
})
