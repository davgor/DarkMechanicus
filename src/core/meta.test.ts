import { describe, expect, it } from 'vitest'
import { createTestDb } from '../test/testContext'
import { getMeta, META_KEYS, setMeta } from './meta'

describe('meta keys', () => {
  it('pins the storage key of every meta entry', () => {
    expect(META_KEYS).toEqual({
      projectId: 'project_id',
      projectName: 'project_name',
      keyPrefix: 'key_prefix',
      machineId: 'machine_id',
      checkoutBranch: 'checkout_branch',
      lastFlushAt: 'last_flush_at',
      lastReconcileAt: 'last_reconcile_at',
      reconcileProblems: 'reconcile_problems'
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
