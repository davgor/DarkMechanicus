import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { createFakeGit, TEST_STORAGE } from '../../test/workspaceHarness'
import type { Db, TransactionHold } from '../db/database'
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

interface Barrier {
  deps: ImporterDeps
  /** How many times the reconcile prepared (each prepare asks git for its status once). */
  prepares: () => number
}

/**
 * The workspace's importer, with `between` run once on another connection after prepare and before the reconcile's
 * first write transaction takes the lock, as a sync lane or a command committing meanwhile would.
 */
function withBarrier(workspace: Workspace, root: string, between: (other: DatabaseSync) => void): Barrier {
  const deps = importerOf(workspace, root)
  const db = deps.db
  let pending = true
  let prepares = 0
  const git = { ...deps.git, statusPaths: () => { prepares += 1; return deps.git.statusPaths() } }
  const barrierDb: Db = {
    path: db.path,
    get: (sql, ...params) => db.get(sql, ...params),
    all: (sql, ...params) => db.all(sql, ...params),
    run: (sql, ...params) => db.run(sql, ...params),
    exec: (sql) => db.exec(sql),
    inTransaction: () => db.inTransaction(),
    close: () => db.close(),
    tx: (fn, mode) => {
      if (pending && mode === undefined && !db.inTransaction()) {
        pending = false
        const other = new DatabaseSync(resolveLayout(root).dbFile)
        try {
          between(other)
        } finally {
          other.close()
        }
      }
      return db.tx(fn, mode)
    }
  }
  return { deps: { ...deps, db: barrierDb, git }, prepares: () => prepares }
}

describe('a reconcile whose database moved between prepare and apply', () => {
  async function pulledEpic(): Promise<Observed & { epicId: string }> {
    const observed = observedWorkspace()
    await observed.workspace.initializeRepository({})
    const epicId = await savedEpic(observed.workspace, 'Pulled epic', 2)
    retitleOnDisk(observed.root, epicId, 'Pulled epic, changed on disk')
    return { ...observed, epicId }
  }

  it('applies its plan without preparing again when another connection committed an unrelated row', async () => {
    const { root, workspace, epicId } = await pulledEpic()
    try {
      const barrier = withBarrier(workspace, root, (other) => other.exec("INSERT INTO meta (key, value) VALUES ('unrelated', '1')"))
      const result = reconcileRepository(barrier.deps, undefined, { full: true })
      expect(result.imported).toContain(epicId)
      expect(barrier.prepares()).toBe(1)
      expect(workspace.ctx().db.get('SELECT title FROM epics WHERE id = ?', epicId)).toEqual({ title: 'Pulled epic, changed on disk' })
    } finally {
      workspace.close()
    }
  })

  it("prepares again outside the lock when another connection changed a planned record's sync state, and applies it once", async () => {
    const { root, workspace, holds, epicId } = await pulledEpic()
    try {
      const barrier = withBarrier(workspace, root, (other) => {
        other.prepare("UPDATE sync_state SET exported_hash = 'moved' WHERE kind = 'epic' AND entity_id = ?").run(epicId)
      })
      holds.length = 0
      const result = reconcileRepository(barrier.deps, undefined, { full: true })
      expect(result.imported).toEqual([epicId])
      // The second prepare ran outside the lock: the first lock was released without applying anything.
      expect(barrier.prepares()).toBe(2)
      expect(holds.length).toBe(2)
      const { db } = workspace.ctx()
      expect(db.get('SELECT title FROM epics WHERE id = ?', epicId)).toEqual({ title: 'Pulled epic, changed on disk' })
      expect(db.get("SELECT exported_hash = imported_hash AS synced, conflict FROM sync_state WHERE kind = 'epic' AND entity_id = ?", epicId))
        .toEqual({ synced: 1, conflict: null })
      expect(db.all("SELECT kind FROM events WHERE kind = 'repository.reconciled'").length).toBeGreaterThan(0)
    } finally {
      workspace.close()
    }
  })
})
