import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeGit, TEST_STORAGE } from '../../test/workspaceHarness'
import type { TransactionHold } from '../db/database'
import { createSystemClock } from '../clock'
import { openWorkspace, type Workspace } from '../workspace'
import { createFileHashCache } from './fileHashes'
import { type ImporterDeps, reconcileRepository } from './importer'
import { resolveLayout } from './layout'
import { nodeFs } from './nodeFs'
import { ownedPaths } from './paths'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(prefix: string): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)))
  tempDirs.push(dir)
  return dir
}

interface Observed {
  root: string
  workspace: Workspace
  holds: TransactionHold[]
}

function observedWorkspace(): Observed {
  const root = tempDir('dm-import-tx-')
  const holds: TransactionHold[] = []
  const workspace = openWorkspace({
    repoRoot: root, homeDir: tempDir('dm-import-tx-home-'), role: 'desktop', label: 'Transactions', transport: 'in_process', ...TEST_STORAGE,
    git: createFakeGit({ branch: 'main', commit: 'a'.repeat(40), detached: false }), onTransaction: (hold) => holds.push(hold)
  })
  return { root, workspace, holds }
}

/** The importer the workspace's own reconcile runs, on its connection (whose observer sees each hold). */
function importerOf(workspace: Workspace, root: string): ImporterDeps {
  const ctx = workspace.ctx()
  return {
    db: ctx.db, layout: resolveLayout(root), fs: nodeFs, clock: createSystemClock(), machineId: ctx.machineId,
    git: createFakeGit({ branch: 'main', commit: 'a'.repeat(40), detached: false }), fileHashes: createFileHashCache()
  }
}

async function savedEpic(workspace: Workspace, title: string, tickets: number): Promise<string> {
  const epic = await workspace.createEpic({ title })
  const ops = Array.from({ length: tickets }, (_, index) => ({ op: 'add_ticket' as const, sprint: '1', ticket: { title: `${title} ticket ${index + 1}` } }))
  const draft = await workspace.updatePlanDraft({ epicId: epic.id, ops })
  await workspace.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  return epic.id
}

/** Changes the tracked state of `epicId` as a pull would. */
function retitleOnDisk(root: string, epicId: string, title: string): void {
  const target = ownedPaths(resolveLayout(root)).epicStateFile(epicId)
  const state = JSON.parse(readFileSync(target, 'utf8')) as { title: string; generation: number }
  writeFileSync(target, JSON.stringify({ ...state, title, generation: state.generation + 1 }))
}

describe('a reconcile that changes nothing', () => {
  it('takes no write transaction and leaves data_version unchanged for another connection', async () => {
    const { root, workspace, holds } = observedWorkspace()
    try {
      await workspace.initializeRepository({})
      const epicId = await savedEpic(workspace, 'Settled epic', 2)
      retitleOnDisk(root, epicId, 'Settled epic, pulled')
      expect((await workspace.reconcileRepository()).imported).toContain(epicId)

      const reader = new DatabaseSync(resolveLayout(root).dbFile, { readOnly: true })
      holds.length = 0
      try {
        const version = (): unknown => reader.prepare('PRAGMA data_version').get()
        const before = version()
        // Explicit (full: the fingerprint never skips it) and automatic (git-targeted) reconciles of the unchanged tree.
        const explicit = reconcileRepository(importerOf(workspace, root), undefined, { full: true })
        const automatic = reconcileRepository(importerOf(workspace, root))
        expect(explicit.imported).toEqual([])
        expect(explicit.unchanged).toContain(epicId)
        expect(automatic.imported).toEqual([])
        expect(holds).toEqual([])
        expect(version()).toEqual(before)
      } finally {
        reader.close()
      }
    } finally {
      workspace.close()
    }
  })
})
