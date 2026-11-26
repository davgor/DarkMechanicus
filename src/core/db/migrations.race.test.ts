/** Two clients opening one old database: the one that waited for the write lock finds it migrated and changes nothing. */
import { afterEach, describe, expect, it } from 'vitest'
import { tempDatabasePath } from '../../test/execution'
import { type Db, openDatabase } from './database'
import { MIGRATIONS, migrate, readSchemaVersion, SCHEMA_VERSION } from './migrations'

const cleanups: Array<() => void> = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function open(path: string): Db {
  const db = openDatabase(path)
  cleanups.unshift(() => db.close())
  return db
}

describe('migrate when another client migrated while this one waited for the write lock', () => {
  it('reports the database as already current and runs no migration again', () => {
    const file = tempDatabasePath()
    cleanups.push(file.cleanup)
    const waiting = open(file.path)
    const competing = open(file.path)
    migrate(waiting, MIGRATIONS.filter((migration) => migration.version < 2))
    const raced: Db = {
      ...waiting,
      path: waiting.path,
      get: waiting.get.bind(waiting),
      all: waiting.all.bind(waiting),
      run: waiting.run.bind(waiting),
      exec: (sql) => {
        if (/CREATE TABLE/i.test(sql)) throw new Error('A migration ran twice.')
        waiting.exec(sql)
      },
      inTransaction: waiting.inTransaction.bind(waiting),
      close: waiting.close.bind(waiting),
      tx: (fn, mode) => {
        // The competing client takes the write lock first and migrates the whole way.
        expect(migrate(competing)).toEqual({ from: 1, to: SCHEMA_VERSION })
        return waiting.tx(fn, mode)
      }
    }
    expect(migrate(raced)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION })
    expect(readSchemaVersion(waiting)).toBe(SCHEMA_VERSION)
  })
})
