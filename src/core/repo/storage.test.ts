import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryFs } from '../../test/memoryFs'
import { idOf, insertComment, insertEpic, insertOutbox, insertRevision, insertRun, T0 } from '../../test/repoFixtures'
import { kanbanSessions } from '../../test/kanbanFixtures'
import { createStubGit } from '../../test/repoEnv'
import { makeBundle } from '../../test/bundles'
import { createTestClock, createTestDb } from '../../test/testContext'
import { prettyJson } from '../canonical'
import type { Db } from '../db/database'
import { SCHEMA_VERSION } from '../db/migrations'
import { setMeta } from '../meta'
import { TRANSFER_HOLD_PREFIX } from '../services/transferGuard'
import { createKanbanCard } from '../services/kanban/cards'
import { EPIC_RECORDS_CONFLICT_PREFIX } from './importer'
import { resolveLayout } from './layout'
import { getStorageStatus } from './storage'
import { ownedPaths } from './paths'
import type { GitAdapter } from './types'

const layout = resolveLayout(resolve('/repo'))
const PROJECT = {
  format: 'darkmechanicus.project',
  formatVersion: 1,
  projectId: idOf('project', 1),
  name: 'Demo',
  keyPrefix: 'DM',
  createdAt: T0
}

function gitWith(count: number | null, branch: string | null = 'main'): GitAdapter {
  return { ...createStubGit(branch), countUncommitted: async () => count }
}

function initializedFs(): ReturnType<typeof createMemoryFs> {
  const fs = createMemoryFs()
  fs.put(layout.projectFile, prettyJson(PROJECT))
  return fs
}

describe('getStorageStatus without a database', () => {
  it('reports an uninitialized folder with zero counts', async () => {
    const status = await getStorageStatus({ db: null, layout, fs: createMemoryFs(), git: gitWith(null, null), clock: createTestClock() })
    expect(status).toEqual({
      initialized: false,
      repoRoot: layout.root,
      storage: { mode: 'repo', projectDir: layout.dmDir, databasePath: layout.dbFile },
      projectId: null,
      projectName: null,
      schemaVersion: null,
      outbox: { pending: 0, failed: 0, lastError: null },
      lastFlushAt: null,
      branch: { current: null, recorded: null, changed: false, repository: true },
      uncommittedRecordFiles: null,
      conflicts: [],
      profileConflicts: [],
      kanbanConflicts: [],
      sessions: { active: 0, byRole: {} }
    })
  })

  it('reads the project and uncommitted record count before the database exists', async () => {
    const status = await getStorageStatus({ db: null, layout, fs: initializedFs(), git: gitWith(3), clock: createTestClock() })
    expect(status).toMatchObject({
      initialized: true,
      projectId: PROJECT.projectId,
      projectName: 'Demo',
      uncommittedRecordFiles: 3,
      branch: { current: 'main', recorded: null, changed: false, repository: true }
    })
  })

  it('reports an invalid project file as not initialized instead of failing', async () => {
    const fs = createMemoryFs()
    fs.put(layout.projectFile, '{"format":"nope"}')
    const status = await getStorageStatus({ db: null, layout, fs, git: gitWith(0), clock: createTestClock() })
    expect([status.initialized, status.projectId]).toEqual([false, null])
  })
})

function seededDb(): Db {
  const db = createTestDb()
  const epic = idOf('epic', 1)
  const run = idOf('run', 1)
  insertEpic(db, { id: epic })
  insertRevision(db, { id: idOf('revision', 1), epicId: epic, number: 1, bundle: makeBundle([[1]]) })
  insertRun(db, { id: run, epicId: epic, revisionId: idOf('revision', 1) })
  insertOutbox(db, { kind: 'epic_state', epicId: epic })
  const pendingWithError = insertOutbox(db, { kind: 'epic_state', epicId: epic })
  const failed = insertOutbox(db, { kind: 'run_history', runId: run, state: 'failed' })
  const done = insertOutbox(db, { kind: 'run_history', runId: run, state: 'done' })
  db.run('UPDATE outbox SET last_error = ? WHERE id = ?', 'disk full', pendingWithError)
  db.run('UPDATE outbox SET last_error = ? WHERE id = ?', 'permission denied', failed)
  db.run('UPDATE outbox SET last_error = ? WHERE id = ?', 'old problem', done)
  setMeta(db, 'last_flush_at', '2026-01-01T00:05:00.000Z')
  setMeta(db, 'checkout_branch', 'release')
  db.run("INSERT INTO sync_state (kind, entity_id, conflict, updated_at) VALUES ('epic', ?, 'epic conflict', ?)", epic, T0)
  db.run("INSERT INTO sync_state (kind, entity_id, conflict, updated_at) VALUES ('run', ?, 'run conflict', ?)", run, T0)
  db.run("INSERT INTO sync_state (kind, entity_id, conflict, updated_at) VALUES ('epic', ?, NULL, ?)", idOf('epic', 2), T0)
  db.run("INSERT INTO sync_state (kind, entity_id, conflict, updated_at) VALUES ('profile', 'ui', 'ui conflict', ?)", T0)
  db.run("INSERT INTO sync_state (kind, entity_id, conflict, updated_at) VALUES ('profile', 'deep-review', 'review conflict', ?)", T0)
  db.run("INSERT INTO sync_state (kind, entity_id, conflict, updated_at) VALUES ('profile', 'quiet', NULL, ?)", T0)
  const session = "INSERT INTO sessions (id, role, label, capabilities_json, transport, started_at, last_seen_at) VALUES (?, ?, 'x', '[]', 'stdio', ?, ?)"
  db.run(session, idOf('session', 1), 'orchestrator', T0, T0)
  db.run(session, idOf('session', 2), 'desktop', T0, '2025-12-31T00:00:00.000Z')
  return db
}

describe('getStorageStatus with a database', () => {
  it('summarizes the outbox, flush time, branch, conflicts, and sessions', async () => {
    const status = await getStorageStatus({ db: seededDb(), layout, fs: initializedFs(), git: gitWith(0, 'main'), clock: createTestClock() })
    expect(status).toEqual({
      initialized: true,
      repoRoot: layout.root,
      storage: { mode: 'repo', projectDir: layout.dmDir, databasePath: layout.dbFile },
      projectId: PROJECT.projectId,
      projectName: 'Demo',
      schemaVersion: SCHEMA_VERSION,
      outbox: { pending: 2, failed: 1, lastError: 'permission denied' },
      lastFlushAt: '2026-01-01T00:05:00.000Z',
      branch: { current: 'main', recorded: 'release', changed: true, repository: true },
      uncommittedRecordFiles: 0,
      conflicts: [
        { epicId: idOf('epic', 1), message: 'epic conflict', resolvable: false },
        { epicId: idOf('epic', 1), message: 'run conflict', resolvable: false }
      ],
      profileConflicts: [
        { name: 'deep-review', message: 'review conflict' },
        { name: 'ui', message: 'ui conflict' }
      ],
      kanbanConflicts: [],
      sessions: { active: 1, byRole: { orchestrator: 1 } }
    })
  })

  it('attributes a conflicting comment to its epic', async () => {
    const db = createTestDb()
    insertEpic(db, { id: idOf('epic', 3) })
    insertComment(db, { id: idOf('comment', 1), epicId: idOf('epic', 3) })
    const conflict = 'INSERT INTO sync_state (kind, entity_id, conflict, updated_at) VALUES (?, ?, ?, ?)'
    db.run(conflict, 'epic', idOf('epic', 4), 'epic conflict', T0)
    db.run(conflict, 'comment', idOf('comment', 1), 'comment conflict', T0)
    db.run(conflict, 'comment', idOf('comment', 2), 'unknown comment', T0)
    const status = await getStorageStatus({ db, layout, fs: initializedFs(), git: gitWith(0, 'main'), clock: createTestClock() })
    expect(status.conflicts).toEqual([
      { epicId: idOf('epic', 3), message: 'comment conflict', resolvable: false },
      { epicId: idOf('comment', 2), message: 'unknown comment', resolvable: false },
      { epicId: idOf('epic', 4), message: 'epic conflict', resolvable: false }
    ])
  })

  it('reports a clean database as idle and unchanged', async () => {
    const db = createTestDb()
    setMeta(db, 'checkout_branch', 'main')
    const status = await getStorageStatus({ db, layout, fs: initializedFs(), git: gitWith(0, 'main'), clock: createTestClock() })
    expect(status.outbox).toEqual({ pending: 0, failed: 0, lastError: null })
    expect(status.branch).toEqual({ current: 'main', recorded: 'main', changed: false, repository: true })
    expect([status.conflicts, status.profileConflicts, status.kanbanConflicts]).toEqual([[], [], []])
  })
})

describe('getStorageStatus Kanban conflicts', () => {
  it('lists Kanban card and event conflicts by card, apart from the epic conflicts', async () => {
    const db = createTestDb()
    const { desktop } = kanbanSessions({ db, clock: createTestClock() })
    const card = createKanbanCard(desktop, { title: 'Edited on two machines' })
    const event = db.get<{ id: string }>('SELECT id FROM kanban_events WHERE card_id = ?', card.id)?.id ?? ''
    const conflict = 'INSERT INTO sync_state (kind, entity_id, conflict, updated_at) VALUES (?, ?, ?, ?)'
    db.run(conflict, 'kanban_card', card.id, 'card conflict', T0)
    db.run(conflict, 'kanban_event', event, 'event conflict', T0)
    db.run(conflict, 'kanban_card', idOf('kanbanCard', 99), null, T0)
    const status = await getStorageStatus({ db, layout, fs: initializedFs(), git: gitWith(0, 'main'), clock: createTestClock() })
    expect(status.kanbanConflicts).toEqual([
      { cardId: card.id, message: 'card conflict' },
      { cardId: card.id, message: 'event conflict' }
    ])
    expect(status.conflicts).toEqual([])
  })
})

describe('getStorageStatus conflict choices', () => {
  it("offers the person's choice only while an epic's own tracked-records conflict still holds", async () => {
    const db = createTestDb()
    const fs = initializedFs()
    const conflict = 'INSERT INTO sync_state (kind, entity_id, conflict, updated_at) VALUES (?, ?, ?, ?)'
    const records = (epicId: string): string => `${EPIC_RECORDS_CONFLICT_PREFIX}${epicId} changed while local changes are waiting to be exported.`
    for (const n of [3, 5]) {
      insertEpic(db, { id: idOf('epic', n) })
      db.run(conflict, 'epic', idOf('epic', n), records(idOf('epic', n)), T0)
      fs.put(ownedPaths(layout).epicPointerFile(idOf('epic', n)), '{"pulled":true}')
      fs.put(ownedPaths(layout).epicStateFile(idOf('epic', n)), '{"pulled":true}')
    }
    // Epic 5's local change is no longer waiting: its stored conflict is stale.
    insertOutbox(db, { kind: 'epic_state', epicId: idOf('epic', 3) })
    insertRevision(db, { id: idOf('revision', 1), epicId: idOf('epic', 3), number: 1, bundle: makeBundle([[1]]) })
    insertRun(db, { id: idOf('run', 2), epicId: idOf('epic', 3), revisionId: idOf('revision', 1) })
    db.run(conflict, 'run', idOf('run', 2), `${EPIC_RECORDS_CONFLICT_PREFIX}look-alike`, T0)
    db.run(conflict, 'epic', idOf('epic', 4), `${TRANSFER_HOLD_PREFIX}${idOf('epic', 4)}: held`, T0)
    const status = await getStorageStatus({ db, layout, fs, git: gitWith(0, 'main'), clock: createTestClock() })
    expect(status.conflicts.map((item) => [item.epicId, item.resolvable])).toEqual([
      [idOf('epic', 3), true],
      [idOf('epic', 4), false],
      [idOf('epic', 5), false],
      [idOf('epic', 3), false]
    ])
  })
})

describe('getStorageStatus outside Git', () => {
  it('reports a folder that is not a Git checkout instead of a detached HEAD', async () => {
    const git: GitAdapter = { ...createStubGit('main'), head: () => null, countUncommitted: async () => null }
    const status = await getStorageStatus({ db: null, layout, fs: initializedFs(), git, clock: createTestClock() })
    expect(status.branch).toEqual({ current: null, recorded: null, changed: false, repository: false })
  })
})

describe('getStorageStatus for a database-only project', () => {
  const dbLayout = resolveLayout(resolve('/repo'), { mode: 'db', homeDir: resolve('/home/dev/.darkmechanicus') })

  it('reports the mode, the project directory outside the repository, and no tracked files to commit', async () => {
    const fs = createMemoryFs()
    fs.put(dbLayout.projectFile, prettyJson(PROJECT))
    const status = await getStorageStatus({ db: null, layout: dbLayout, fs, git: gitWith(0), clock: createTestClock() })
    expect(status.storage).toEqual({
      mode: 'db',
      projectDir: dbLayout.dmDir,
      databasePath: dbLayout.dbFile
    })
    expect(status.initialized).toBe(true)
    expect(status.uncommittedRecordFiles).toBeNull()
    expect(status.repoRoot).toBe(dbLayout.root)
  })

  it('never asks Git what is uncommitted, because no record file is in the checkout', async () => {
    const fs = createMemoryFs()
    fs.put(dbLayout.projectFile, prettyJson(PROJECT))
    let asked = 0
    const git: GitAdapter = { ...createStubGit('main'), countUncommitted: async () => {
      asked += 1
      return 3
    } }
    const status = await getStorageStatus({ db: null, layout: dbLayout, fs, git, clock: createTestClock() })
    expect(asked).toBe(0)
    expect(status.uncommittedRecordFiles).toBeNull()
  })
})
