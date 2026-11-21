import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { baselineDeliveryPolicy } from './deliveryPolicySchema'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { effectivePrompts } from '../shared/domain/standardsPrompts'
import { getMeta, META_KEYS, setMeta } from './meta'
import { nodeFs } from './repo/nodeFs'
import { dbProjectDir, SQLITE_STANDARDS_FILE } from './repo/storageMode'

let h: Harness
beforeEach(() => { h = createHarness() })
afterEach(() => h.cleanup())

it('keeps the selected policy and version in exactly the active ticket backend through a round trip', async () => {
  const w = h.open('desktop', { mode: 'db', transport: 'desktop' })
  await w.initializeRepository({ name: 'Scoped policy' })
  expect((await w.getProject()).deliveryStandards).toBeUndefined()
  const input = { expectedRevision: 0, policy: { ...baselineDeliveryPolicy, setupDecision: 'defaults' as const } }
  const accepted = await w.setDeliveryStandards(input)
  const dbMarker = join(dbProjectDir(h.root, h.homeDir), 'project.json')
  expect(readFileSync(dbMarker, 'utf8')).not.toContain('deliveryStandards')
  expect(existsSync(join(h.root, '.darkmechanicus'))).toBe(false)
  expect(JSON.parse(getMeta(w.ctx().db, META_KEYS.deliveryStandards)!)).toEqual(accepted)
  await w.switchStorageMode({ mode: 'repo', confirmed: true })
  expect(getMeta(w.ctx().db, META_KEYS.deliveryStandards)).toBeNull()
  expect(JSON.parse(readFileSync(join(h.root, '.darkmechanicus/project.json'), 'utf8')).deliveryStandards).toEqual(accepted)
  await expect(w.setDeliveryStandards(input)).rejects.toThrow('Reload')
  const policy = { ...baselineDeliveryPolicy, kanbanCloseout: { ...baselineDeliveryPolicy.kanbanCloseout, push: false } }
  const updated = await w.setDeliveryStandards({ expectedRevision: accepted.revision, policy })
  expect(updated.revision).toBe(2)
  expect(updated.policy.epicCloseout.push).toBe(true)
  await w.switchStorageMode({ mode: 'db', confirmed: true })
  w.close()
  expect((await h.open('desktop').getProject()).deliveryStandards).toEqual(updated)
  expect(readFileSync(dbMarker, 'utf8')).not.toContain('deliveryStandards')
})

it('preserves legacy SQLite rules and closeout choices when upgrading to four prompts', async () => {
  const w = h.open('desktop', { mode: 'db' })
  await w.initializeRepository({})
  const { prompts: _, ...policy } = baselineDeliveryPolicy
  policy.epicTicket = { ...policy.epicTicket, verification: 'Test the vehicle renderer' }
  policy.kanbanCloseout = { ...policy.kanbanCloseout, removeWorktree: false }
  const legacy = { revision: 9, policy }
  setMeta(w.ctx().db, META_KEYS.deliveryStandards, JSON.stringify(legacy))
  expect((await w.getProject()).deliveryStandards).toEqual(legacy)
  w.close()
  const migrated = h.open('desktop', { transport: 'desktop' })
  expect(JSON.parse(readFileSync(join(h.root, SQLITE_STANDARDS_FILE), 'utf8')).standards).toEqual(legacy)
  const resolved = effectivePrompts(policy)
  expect(resolved.ticket).toContain('Test the vehicle renderer')
  expect(resolved.ticket).toContain('Remove worktree: no')
  const saved = await migrated.setDeliveryStandards({ expectedRevision: 9, policy: { ...policy, prompts: resolved, setupDecision: 'edited' } })
  expect(saved.revision).toBe(10)
  expect(saved.policy.prompts).toEqual(resolved)
})

it('reports broken portable settings instead of offering new setup or overwriting them', async () => {
  const w = h.open('desktop', { mode: 'db' })
  await w.initializeRepository({})
  const file = join(h.root, SQLITE_STANDARDS_FILE)
  writeFileSync(file, 'broken')
  await expect(w.getProject()).rejects.toThrow()
  await expect(w.setDeliveryStandards({ expectedRevision: 0, policy: baselineDeliveryPolicy })).rejects.toThrow()
  expect(readFileSync(file, 'utf8')).toBe('broken')
})

it('refuses a downlevel save that would erase the approved four prompts', async () => {
  const w = h.open('desktop', { mode: 'repo' })
  await w.initializeRepository({})
  const saved = await w.setDeliveryStandards({ expectedRevision: 0, policy: baselineDeliveryPolicy })
  const { prompts: _, ...oldClient } = saved.policy
  await expect(w.setDeliveryStandards({ expectedRevision: 1, policy: oldClient })).rejects.toMatchObject({ code: 'conflict' })
  expect((await w.getProject()).deliveryStandards).toEqual(saved)
})

it('keeps repo standards authoritative and leaves no SQLite sidecar when migration fails before cutover', async () => {
  const target = dbProjectDir(h.root, h.homeDir)
  const w = h.open('desktop', { transport: 'desktop', fs: {
    ...nodeFs, rename(from, to) {
      if (to === target) throw new Error('Destination unavailable')
      nodeFs.rename(from, to)
    }
  } })
  await w.initializeRepository({})
  const expected = await w.setDeliveryStandards({ expectedRevision: 0, policy: baselineDeliveryPolicy })
  await expect(w.switchStorageMode({ mode: 'db', confirmed: true })).rejects.toThrow('Destination unavailable')
  expect((await w.getProject()).deliveryStandards).toEqual(expected)
  expect(existsSync(join(h.root, SQLITE_STANDARDS_FILE))).toBe(false)
})
