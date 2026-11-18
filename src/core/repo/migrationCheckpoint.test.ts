/** The private storage-switch checkpoint rebuilds exactly the rows it holds, and refuses anything it cannot reproduce. */
import { describe, expect, it } from 'vitest'
import { idOf, insertEpic, insertOutbox, insertRevision, T0 } from '../../test/repoFixtures'
import { createTestDb } from '../../test/testContext'
import { makeBundle } from '../../test/bundles'
import { checkpointOf, rebuildCheckpoint } from './migrationCheckpoint'

type Checkpoint = ReturnType<typeof checkpointOf>
type Row = Checkpoint['tables'][number]['rows'][number]

const EPIC = idOf('epic', 1)

/** A migrated database holding one saved epic, its revision and a queued export. */
function sourceCheckpoint(): Checkpoint {
  const db = createTestDb()
  insertEpic(db, { id: EPIC })
  insertRevision(db, { id: idOf('revision', 1), epicId: EPIC, number: 1, bundle: makeBundle([[1, 2]], [[1, 2]]), baseRevisionId: null, createdAt: T0 })
  insertOutbox(db, { kind: 'epic_state', epicId: EPIC })
  const checkpoint = checkpointOf(db)
  db.close()
  return checkpoint
}

/** The checkpoint with the rows of `table` replaced by `edit` of them. */
function editRows(checkpoint: Checkpoint, table: string, edit: (rows: Row[]) => Row[]): string {
  return JSON.stringify({ ...checkpoint, tables: checkpoint.tables.map((item) => (item.name === table ? { ...item, rows: edit(item.rows) } : item)) })
}

describe('rebuildCheckpoint', () => {
  it('rebuilds every row of the source database', () => {
    const checkpoint = sourceCheckpoint()
    const db = rebuildCheckpoint(':memory:', JSON.stringify(checkpoint))
    expect(db.all<{ id: string }>('SELECT id FROM epics')).toEqual([{ id: EPIC }])
    expect(checkpointOf(db)).toEqual(checkpoint)
    db.close()
  })

  it('refuses a checkpoint whose tables are not the current schema', () => {
    const checkpoint = sourceCheckpoint()
    const text = JSON.stringify({ ...checkpoint, tables: checkpoint.tables.filter((table) => table.name !== 'comments') })
    expect(() => rebuildCheckpoint(':memory:', text)).toThrow('Migration checkpoint tables do not match the current database schema.')
  })

  it('refuses a row with a column the table does not have', () => {
    const text = editRows(sourceCheckpoint(), 'epics', (rows) => rows.map((row) => ({ ...row, extra: 'x' })))
    expect(() => rebuildCheckpoint(':memory:', text)).toThrow('Migration checkpoint columns do not match epics.')
  })

  it('refuses rows that break a foreign key', () => {
    const text = editRows(sourceCheckpoint(), 'epics', () => [])
    expect(() => rebuildCheckpoint(':memory:', text)).toThrow('The rebuilt migration database failed integrity verification.')
  })

  it('refuses a value the database stores differently than the checkpoint holds it', () => {
    const text = editRows(sourceCheckpoint(), 'outbox', (rows) => rows.map((row) => ({ ...row, attempts: '0' })))
    expect(() => rebuildCheckpoint(':memory:', text)).toThrow('The rebuilt migration database does not match every source row.')
  })
})
