import { describe, expect, it } from 'vitest'
import { createStubGit } from '../../test/repoEnv'
import { idOf, insertEpic, insertOutbox } from '../../test/repoFixtures'
import { createTestDb } from '../../test/testContext'
import type { Db } from '../db/database'
import { getMeta, META_KEYS, RECONCILE_DIRTY_PATHS_LIMIT, readReconcileMarker, setMeta } from '../meta'
import { IMPORTER_VERSION } from './gitChanges'
import { reconcileScope, recheckRecords, unsettledPaths, writeReconcileMarker } from './reconcileScope'

const EPIC = idOf('epic', 1)
const RUN = idOf('run', 1)
const CARD = idOf('kanbanCard', 1)
const HEAD = 'c'.repeat(40)

function conflict(db: Db, kind: string, entityId: string): void {
  db.run("INSERT INTO sync_state (kind, entity_id, generation, conflict, updated_at) VALUES (?, ?, 0, 'held', '2026-01-01T00:00:00.000Z')", kind, entityId)
}

describe('recheckRecords', () => {
  it('names every record with a stored conflict, and every record exported since the last reconcile', () => {
    const db = createTestDb()
    conflict(db, 'epic', EPIC)
    conflict(db, 'run', RUN)
    conflict(db, 'kanban_card', CARD)
    conflict(db, 'profile', 'ui')
    setMeta(db, META_KEYS.lastReconcileAt, '2026-02-01T00:00:00.000Z')
    const before = insertOutbox(db, { kind: 'epic_state', epicId: idOf('epic', 2) })
    const after = insertOutbox(db, { kind: 'run_history', epicId: idOf('epic', 3), runId: idOf('run', 3) })
    const profile = insertOutbox(db, { kind: 'profile', entityId: 'review' })
    db.run("UPDATE outbox SET state = 'done', done_at = '2026-01-31T23:59:59.999Z' WHERE id = ?", before)
    db.run("UPDATE outbox SET state = 'done', done_at = '2026-02-01T00:00:00.000Z' WHERE id IN (?, ?)", after, profile)
    const recheck = recheckRecords(db)
    expect([...(recheck.epics ?? [])]).toEqual([EPIC])
    expect([...(recheck.runs ?? [])].sort()).toEqual([RUN, idOf('run', 3)].sort())
    expect([...(recheck.kanbanCards ?? [])]).toEqual([CARD])
    expect([...(recheck.profiles ?? [])].sort()).toEqual(['review', 'ui'])
  })

  it('names nothing when no conflict is stored and nothing was exported since', () => {
    const db = createTestDb()
    insertEpic(db, { id: EPIC })
    setMeta(db, META_KEYS.lastReconcileAt, '2026-02-01T00:00:00.000Z')
    expect(recheckRecords(db)).toEqual({ epics: new Set(), runs: new Set(), kanbanCards: new Set(), profiles: new Set(), projectObservations: false })
  })

  it('names an exported observation by its epic, or the project observations for one with none, and skips kinds no folder holds', () => {
    const db = createTestDb()
    setMeta(db, META_KEYS.lastReconcileAt, '2026-02-01T00:00:00.000Z')
    const exported = (kind: string, epicId: string | null, entityId: string): void => {
      db.run(
        "INSERT INTO outbox (kind, epic_id, entity_id, state, attempts, created_at, done_at) VALUES (?, ?, ?, 'done', 0, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')",
        kind, epicId, entityId
      )
    }
    exported('metric_observation', EPIC, 'mo_1')
    exported('attachment', null, 'at_1')
    expect(recheckRecords(db)).toEqual({ epics: new Set([EPIC]), runs: new Set(), kanbanCards: new Set(), profiles: new Set(), projectObservations: false })
    exported('metric_observation', null, 'mo_2')
    expect(recheckRecords(db).projectObservations).toBe(true)
  })
})

describe('the marker a reconcile writes', () => {
  it('stores the head, this importer version and the status and unsettled paths, sorted and without duplicates', () => {
    const db = createTestDb()
    writeReconcileMarker(db, { changes: { kind: 'full', reason: 'requested' }, head: HEAD, statusPaths: ['kanban/b/card.json', 'epics/a'] }, ['epics/a', 'profiles/x.json'])
    expect(readReconcileMarker(db)).toEqual({ baseCommit: HEAD, importerVersion: IMPORTER_VERSION, dirtyPaths: ['epics/a', 'kanban/b/card.json', 'profiles/x.json'] })
  })

  it('stores no path list over the limit, and no marker at all without a status', () => {
    const db = createTestDb()
    const many = Array.from({ length: RECONCILE_DIRTY_PATHS_LIMIT + 1 }, (_, index) => `epics/${index}`)
    writeReconcileMarker(db, { changes: { kind: 'full', reason: 'requested' }, head: HEAD, statusPaths: many }, [])
    expect(readReconcileMarker(db)).toEqual({ baseCommit: HEAD, importerVersion: IMPORTER_VERSION, dirtyPaths: null })
    writeReconcileMarker(db, { changes: { kind: 'full', reason: 'git_failed' }, head: null, statusPaths: null }, [])
    expect([getMeta(db, META_KEYS.reconcileBaseCommit), getMeta(db, META_KEYS.reconcileImporterVersion)]).toEqual([null, null])
  })

  it('maps unsettled records to their folders and rejected paths below .darkmechanicus/', () => {
    expect(unsettledPaths({
      epics: [EPIC], runs: [RUN], kanbanCards: [CARD], profiles: ['ui'],
      rejectedPaths: ['.darkmechanicus/observations/x.json', 'elsewhere/file'], shownDmDir: '.darkmechanicus'
    })).toEqual([`epics/${EPIC}`, `history/${RUN}`, `kanban/${CARD}`, 'profiles/ui.json', 'observations/x.json', 'elsewhere/file'])
  })
})

describe('reconcileScope', () => {
  it('reads everything when asked to, when git fails, and after a record was deleted here', () => {
    const db = createTestDb()
    expect(reconcileScope({ db, git: createStubGit() }, true).changes).toEqual({ kind: 'full', reason: 'requested' })
    expect(reconcileScope({ db, git: createStubGit() }, false).changes).toEqual({ kind: 'full', reason: 'git_failed' })
    setMeta(db, META_KEYS.lastReconcileAt, '2026-02-01T00:00:00.000Z')
    db.run("INSERT INTO events (at, kind, payload_json) VALUES ('2026-02-01T00:00:01.000Z', 'epic.deleted', '{}')")
    expect(reconcileScope({ db, git: createStubGit() }, false).changes).toEqual({ kind: 'full', reason: 'record_deleted' })
  })
})
