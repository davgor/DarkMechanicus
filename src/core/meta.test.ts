import { describe, expect, it } from 'vitest'
import { createTestDb } from '../test/testContext'
import { getMeta, META_KEYS, RECONCILE_DIRTY_PATHS_LIMIT, readReconcileMarker, setMeta } from './meta'

describe('meta keys', () => {
  it('pins the storage key of every meta entry', () => {
    expect(META_KEYS).toEqual({
      projectId: 'project_id',
      deliveryStandards: 'delivery_standards',
      projectName: 'project_name',
      keyPrefix: 'key_prefix',
      machineId: 'machine_id',
      checkoutBranch: 'checkout_branch',
      lastFlushAt: 'last_flush_at',
      lastReconcileAt: 'last_reconcile_at',
      attachmentRegistration: 'attachment_registration',
      reconcileProblems: 'reconcile_problems',
      validatedRepositoryCache: 'validated_repository_cache',
      reconcileFingerprint: 'reconcile_fingerprint',
      reconcileBaseCommit: 'reconcile_base_commit',
      reconcileImporterVersion: 'reconcile_importer_version',
      reconcileDirtyPaths: 'reconcile_dirty_paths'
    })
  })
})

describe('getMeta and setMeta', () => {
  it('returns null for a key that was never set', () => {
    const db = createTestDb()
    expect(getMeta(db, META_KEYS.projectId)).toBeNull()
  })

  it('stores and reads a value', () => {
    const db = createTestDb()
    setMeta(db, META_KEYS.projectName, 'Dark Mechanicus')
    expect(getMeta(db, META_KEYS.projectName)).toBe('Dark Mechanicus')
  })

  it('overwrites an existing value without adding a row', () => {
    const db = createTestDb()
    setMeta(db, META_KEYS.checkoutBranch, 'main')
    setMeta(db, META_KEYS.checkoutBranch, 'feature/x')
    expect(getMeta(db, META_KEYS.checkoutBranch)).toBe('feature/x')
    expect(db.get<{ count: number }>('SELECT COUNT(*) AS count FROM meta')?.count).toBe(1)
  })

  it('keeps keys independent', () => {
    const db = createTestDb()
    setMeta(db, META_KEYS.machineId, 'mc_1')
    setMeta(db, META_KEYS.keyPrefix, 'DM')
    expect(getMeta(db, META_KEYS.machineId)).toBe('mc_1')
    expect(getMeta(db, META_KEYS.keyPrefix)).toBe('DM')
    expect(getMeta(db, META_KEYS.lastFlushAt)).toBeNull()
  })

  it('distinguishes an empty string from a missing key', () => {
    const db = createTestDb()
    setMeta(db, META_KEYS.lastReconcileAt, '')
    expect(getMeta(db, META_KEYS.lastReconcileAt)).toBe('')
  })

  it('is written through the same transaction as the surrounding mutation', () => {
    const db = createTestDb()
    const attempt = (): void =>
      db.tx(() => {
        setMeta(db, META_KEYS.projectId, 'pj_1')
        throw new Error('abort')
      })
    expect(attempt).toThrow('abort')
    expect(getMeta(db, META_KEYS.projectId)).toBeNull()
  })
})

describe('readReconcileMarker', () => {
  const COMMIT = 'c'.repeat(40)

  it('reads nothing as null when no marker was stored', () => {
    expect(readReconcileMarker(createTestDb())).toEqual({ baseCommit: null, importerVersion: null, dirtyPaths: null })
  })

  it('reads a stored commit, importer version and dirty-path list', () => {
    const db = createTestDb()
    setMeta(db, META_KEYS.reconcileBaseCommit, COMMIT)
    setMeta(db, META_KEYS.reconcileImporterVersion, '3')
    setMeta(db, META_KEYS.reconcileDirtyPaths, JSON.stringify(['epics/x/state.json']))
    expect(readReconcileMarker(db)).toEqual({ baseCommit: COMMIT, importerVersion: 3, dirtyPaths: ['epics/x/state.json'] })
    setMeta(db, META_KEYS.reconcileBaseCommit, 'd'.repeat(64))
    setMeta(db, META_KEYS.reconcileDirtyPaths, '[]')
    expect(readReconcileMarker(db)).toMatchObject({ baseCommit: 'd'.repeat(64), dirtyPaths: [] })
  })

  it('reads each malformed part as null', () => {
    const db = createTestDb()
    for (const [commit, version, paths] of [
      ['HEAD', '0', '{"a":1}'],
      [COMMIT.toUpperCase(), '1.5', '[1]'],
      [`${COMMIT}\n`, '-1', 'not json'],
      ['', '01', 'null']
    ] as const) {
      setMeta(db, META_KEYS.reconcileBaseCommit, commit)
      setMeta(db, META_KEYS.reconcileImporterVersion, version)
      setMeta(db, META_KEYS.reconcileDirtyPaths, paths)
      expect(readReconcileMarker(db)).toEqual({ baseCommit: null, importerVersion: null, dirtyPaths: null })
    }
  })

  it('reads a dirty-path list over the limit as missing, and one at the limit as stored', () => {
    const db = createTestDb()
    const atLimit = Array.from({ length: RECONCILE_DIRTY_PATHS_LIMIT }, (_, index) => `epics/e/${index}.json`)
    setMeta(db, META_KEYS.reconcileDirtyPaths, JSON.stringify(atLimit))
    expect(readReconcileMarker(db).dirtyPaths).toHaveLength(RECONCILE_DIRTY_PATHS_LIMIT)
    setMeta(db, META_KEYS.reconcileDirtyPaths, JSON.stringify([...atLimit, 'one/more.json']))
    expect(readReconcileMarker(db).dirtyPaths).toBeNull()
  })
})
