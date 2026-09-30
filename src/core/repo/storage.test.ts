import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryFs } from '../../test/memoryFs'
import { idOf, insertEpic, insertOutbox, insertRevision, insertRun, T0 } from '../../test/repoFixtures'
import { createStubGit } from '../../test/repoEnv'
import { makeBundle } from '../../test/bundles'
import { createTestClock, createTestDb } from '../../test/testContext'
import { prettyJson } from '../canonical'
import type { Db } from '../db/database'
import { SCHEMA_VERSION } from '../db/migrations'
import { setMeta } from '../meta'
import { resolveLayout } from './layout'
import { getStorageStatus } from './storage'
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
      projectId: null,
      projectName: null,
      schemaVersion: null,
      outbox: { pending: 0, failed: 0, lastError: null },
      lastFlushAt: null,
      branch: { current: null, recorded: null, changed: false },
      uncommittedRecordFiles: null,
      conflicts: [],
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
      branch: { current: 'main', recorded: null, changed: false }
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
      projectId: PROJECT.projectId,
      projectName: 'Demo',
      schemaVersion: SCHEMA_VERSION,
      outbox: { pending: 2, failed: 1, lastError: 'permission denied' },
      lastFlushAt: '2026-01-01T00:05:00.000Z',
      branch: { current: 'main', recorded: 'release', changed: true },
      uncommittedRecordFiles: 0,
      conflicts: [
        { epicId: idOf('epic', 1), message: 'epic conflict' },
        { epicId: idOf('epic', 1), message: 'run conflict' }
      ],
      sessions: { active: 1, byRole: { orchestrator: 1 } }
    })
  })

  it('reports a clean database as idle and unchanged', async () => {
    const db = createTestDb()
    setMeta(db, 'checkout_branch', 'main')
    const status = await getStorageStatus({ db, layout, fs: initializedFs(), git: gitWith(0, 'main'), clock: createTestClock() })
    expect(status.outbox).toEqual({ pending: 0, failed: 0, lastError: null })
    expect(status.branch).toEqual({ current: 'main', recorded: 'main', changed: false })
    expect(status.conflicts).toEqual([])
  })
})
