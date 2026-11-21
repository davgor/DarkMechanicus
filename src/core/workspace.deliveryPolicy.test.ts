import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { baselineDeliveryPolicy } from './deliveryPolicySchema'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { getMeta, META_KEYS } from './meta'
import { dbProjectDir } from './repo/storageMode'

let h: Harness
beforeEach(() => { h = createHarness() })
afterEach(() => h.cleanup())

it('keeps the selected policy and version in exactly the active ticket backend through a round trip', async () => {
  const w = h.open('desktop', { mode: 'db', transport: 'desktop' })
  await w.initializeRepository({ name: 'Scoped policy' })
  expect((await w.getProject()).deliveryStandards).toBeUndefined()
  const input = { expectedRevision: 0, policy: baselineDeliveryPolicy }
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
