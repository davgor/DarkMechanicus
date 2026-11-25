import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { dropAcceptanceNodes } from '../../test/acceptanceNodes'
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

/**
 * A saved epic with exactly `tickets` work tickets in one sprint (its acceptance node dropped), added in drafts of at
 * most 500 operations (the command's limit).
 */
async function savedEpic(workspace: Workspace, title: string, tickets: number): Promise<string> {
  const epic = await workspace.createEpic({ title })
  let draftRevision = await dropAcceptanceNodes(workspace, epic.id)
  const ops = Array.from({ length: tickets }, (_, index) => ({ op: 'add_ticket' as const, sprint: '1', ticket: { title: `${title} ticket ${index + 1}` } }))
  for (let start = 0; start < ops.length; start += 500) {
    draftRevision = (await workspace.updatePlanDraft({ epicId: epic.id, ops: ops.slice(start, start + 500) })).draftRevision
  }
  await workspace.savePlan({ epicId: epic.id, expectedDraftRevision: draftRevision })
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
  /** How many times the reconcile prepared `epicId` (each prepare reads its changed state file once). */
  prepares: () => number
}

/**
 * The workspace's importer, with `between` run once on another connection after prepare and before the reconcile's
 * first write transaction takes the lock, as a sync lane or a command committing meanwhile would.
 */
function withBarrier(workspace: Workspace, root: string, target: { epicId: string; between: (other: DatabaseSync) => void }): Barrier {
  const deps = importerOf(workspace, root)
  const db = deps.db
  const { epicId, between } = target
  const stateFile = ownedPaths(resolveLayout(root)).epicStateFile(epicId)
  let pending = true
  let prepares = 0
  const fs = { ...deps.fs, readFile: (path: string) => { if (path === stateFile) prepares += 1; return deps.fs.readFile(path) } }
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
  return { deps: { ...deps, db: barrierDb, fs }, prepares: () => prepares }
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
      const barrier = withBarrier(workspace, root, { epicId, between: (other) => other.exec("INSERT INTO meta (key, value) VALUES ('unrelated', '1')") })
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
      const barrier = withBarrier(workspace, root, { epicId, between: (other) => {
        other.prepare("UPDATE sync_state SET exported_hash = 'moved' WHERE kind = 'epic' AND entity_id = ?").run(epicId)
      } })
      holds.length = 0
      const result = reconcileRepository(barrier.deps, undefined, { full: true })
      expect(result.imported).toEqual([epicId])
      // The epic's transaction found it moved and wrote nothing; the epic alone was prepared again, outside the lock.
      expect(barrier.prepares()).toBe(2)
      expect(holds.every(({ outcome }) => outcome === 'commit')).toBe(true)
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

/** The workspace's importer, whose `ticket_status` writes for `epicId` throw: the failure lands mid-way through that epic's apply. */
function failingFor(workspace: Workspace, root: string, epicId: string): ImporterDeps {
  const deps = importerOf(workspace, root)
  const db = deps.db
  const failing: Db = {
    path: db.path,
    get: (sql, ...params) => db.get(sql, ...params),
    all: (sql, ...params) => db.all(sql, ...params),
    run: (sql, ...params) => {
      if (sql.includes('INSERT INTO ticket_status') && params.includes(epicId)) throw new Error('disk I/O error')
      return db.run(sql, ...params)
    },
    exec: (sql) => db.exec(sql),
    inTransaction: () => db.inTransaction(),
    close: () => db.close(),
    tx: (fn, mode) => db.tx(fn, mode)
  }
  return { ...deps, db: failing }
}

function reconciledEvents(workspace: Workspace): { changedEpics: string[]; rejected: number }[] {
  return workspace.ctx().db.all<{ payload_json: string }>("SELECT payload_json FROM events WHERE kind = 'repository.reconciled' ORDER BY seq")
    .map((row) => JSON.parse(row.payload_json) as { changedEpics: string[]; rejected: number })
}

describe('a reconcile that fails mid-way through one epic', () => {
  it('leaves that epic all-old, commits the others, and reports one reconciled event listing them', async () => {
    const { root, workspace } = observedWorkspace()
    try {
      await workspace.initializeRepository({})
      const epics = [await savedEpic(workspace, 'First', 2), await savedEpic(workspace, 'Second', 2), await savedEpic(workspace, 'Third', 2)]
      const [first, second, third] = epics as [string, string, string]
      const { db } = workspace.ctx()
      const before = {
        epic: db.get('SELECT * FROM epics WHERE id = ?', second),
        sync: db.get("SELECT * FROM sync_state WHERE kind = 'epic' AND entity_id = ?", second),
        statuses: db.all('SELECT * FROM ticket_status WHERE epic_id = ? ORDER BY ticket_id', second)
      }
      for (const epicId of epics) retitleOnDisk(root, epicId, `${epicId} pulled`)
      const events = reconciledEvents(workspace).length

      const result = reconcileRepository(failingFor(workspace, root, second), undefined, { full: true })

      expect(result.imported).toEqual(expect.arrayContaining([first, third]))
      expect(result.imported).not.toContain(second)
      expect(result.rejected).toEqual([expect.objectContaining({ path: expect.stringContaining(second), message: expect.stringContaining('disk I/O error') })])
      for (const epicId of [first, third]) {
        expect(db.get('SELECT title FROM epics WHERE id = ?', epicId)).toEqual({ title: `${epicId} pulled` })
      }
      expect({
        epic: db.get('SELECT * FROM epics WHERE id = ?', second),
        sync: db.get("SELECT * FROM sync_state WHERE kind = 'epic' AND entity_id = ?", second),
        statuses: db.all('SELECT * FROM ticket_status WHERE epic_id = ? ORDER BY ticket_id', second)
      }).toEqual(before)
      const added = reconciledEvents(workspace).slice(events)
      expect(added).toHaveLength(1)
      expect([...added[0]!.changedEpics].sort()).toEqual([first, third].sort())
      expect(added[0]!.rejected).toBe(1)

      // The next reconcile, without the failure, brings the epic in.
      expect(reconcileRepository(importerOf(workspace, root), undefined, { full: true }).imported).toEqual([second])
    } finally {
      workspace.close()
    }
  })
})

describe('a reconcile applying one changed 1,000-ticket epic', () => {
  it('holds the writer lock in two short transactions: the epic, then the finish', async () => {
    const { root, workspace, holds } = observedWorkspace()
    try {
      await workspace.initializeRepository({})
      const epicId = await savedEpic(workspace, 'Large', 1_000)
      const target = ownedPaths(resolveLayout(root)).epicStateFile(epicId)
      const state = JSON.parse(readFileSync(target, 'utf8')) as { title: string; generation: number; ticketStatuses: Record<string, string> }
      const ticketStatuses = Object.fromEntries(Object.keys(state.ticketStatuses).map((ticketId) => [ticketId, 'completed']))
      expect(Object.keys(ticketStatuses)).toHaveLength(1_000)
      writeFileSync(target, JSON.stringify({ ...state, title: 'Large, pulled', ticketStatuses, generation: state.generation + 1 }))

      holds.length = 0
      const result = reconcileRepository(importerOf(workspace, root), undefined, { full: true })
      expect(result.imported).toEqual([epicId])
      expect(holds.map(({ outcome }) => outcome)).toEqual(['commit', 'commit'])
      expect(workspace.ctx().db.get("SELECT count(*) AS done FROM ticket_status WHERE epic_id = ? AND status = 'completed'", epicId)).toEqual({ done: 1_000 })
      console.info(`1,000-ticket epic reconcile holds (ms): ${holds.map(({ holdMs }) => holdMs.toFixed(1)).join(', ')}`)
    } finally {
      workspace.close()
    }
  })
})
