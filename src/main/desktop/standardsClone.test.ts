import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { baselineDeliveryPolicy, defaultPrompts } from '../../shared/domain/standardsPrompts'
import { dbProjectDir, SQLITE_STANDARDS_FILE } from '../../core/repo/storageMode'
import { createFolderRegistry, type FolderRegistry } from './folderRegistry'
import { createWorkspacePool, type WorkspacePool } from './workspacePool'

let h: Harness
let registry: FolderRegistry
let pool: WorkspacePool
beforeEach(() => {
  h = createHarness()
  registry = createFolderRegistry({ file: join(h.homeDir, 'folders.json'), homeDir: h.homeDir, dmHome: h.homeDir })
  pool = createWorkspacePool(root => h.open('desktop', { root, transport: 'desktop' }))
})
afterEach(() => { pool.closeAll(); h.cleanup() })

it('recovers the exact SQLite setup from a clone with a fresh local ticket database', async () => {
  const first = h.open('desktop', { mode: 'db' })
  await first.initializeRepository({})
  await first.createKanbanCard({ title: 'Private machine-local work' })
  const prompts = { ...defaultPrompts, planned: '  Named checks with exact evidence.\n' }
  const saved = await first.setDeliveryStandards({ expectedRevision: 0, policy: {
    ...baselineDeliveryPolicy, prompts, setupDecision: 'agent'
  } })
  const clone = join(h.homeDir, 'new-checkout')
  mkdirSync(clone)
  copyFileSync(join(h.root, SQLITE_STANDARDS_FILE), join(clone, SQLITE_STANDARDS_FILE))
  const entry = registry.track(clone).folder
  expect(entry).toMatchObject({ initialized: true, storageMode: 'db' })
  expect(existsSync(join(dbProjectDir(clone, h.homeDir), 'project.json'))).toBe(false)
  const second = pool.get(entry.path)
  expect(second.isInitialized()).toBe(true)
  expect((await second.getStorageStatus()).storage.mode).toBe('db')
  expect((await second.getProject()).deliveryStandards).toEqual(saved)
  expect(saved.policy.prompts).toEqual(prompts)
  expect(saved.policy.setupDecision).toBe('agent')
  expect(readFileSync(join(clone, SQLITE_STANDARDS_FILE), 'utf8')).not.toContain('Private machine-local work')
  expect((await second.setDeliveryStandards({ expectedRevision: 1, policy: saved.policy })).revision).toBe(1)
})

it('surfaces a damaged SQLite sidecar on a new machine before creating a local project', () => {
  writeFileSync(join(h.root, SQLITE_STANDARDS_FILE), '{truncated')
  const entry = registry.track(h.root).folder
  expect(entry).toMatchObject({ initialized: true, storageMode: 'db' })
  expect(() => pool.get(entry.path)).toThrow(SQLITE_STANDARDS_FILE)
  expect(existsSync(join(dbProjectDir(h.root, h.homeDir), 'project.json'))).toBe(false)
})
