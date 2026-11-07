/** A short-lived, machine-private JSON checkpoint, never a portable record or an import source on open. */
import { z } from 'zod'
import { contentHash } from '../canonical'
import { type Db, type SqlValue, openDatabase } from '../db/database'
import { migrate, SCHEMA_VERSION } from '../db/migrations'
import { fail } from '../errors'

const cell = z.union([z.null(), z.string(), z.number(), z.strictObject({ bytes: z.string() })])
const checkpointSchema = z.strictObject({
  version: z.literal(1),
  schemaVersion: z.literal(SCHEMA_VERSION),
  tables: z.array(z.strictObject({ name: z.string(), rows: z.array(z.record(z.string(), cell)) }))
})
type Checkpoint = z.infer<typeof checkpointSchema>

function tableNames(db: Db): string[] {
  // FTS shadow tables are derived by inserting the virtual table's rows, not copied independently.
  return db.all<{ name: string }>("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'search_index_%' ORDER BY name").map((row) => row.name)
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

export function checkpointOf(db: Db): Checkpoint {
  return {
    version: 1,
    schemaVersion: SCHEMA_VERSION,
    tables: tableNames(db).map((name) => ({
      name,
      rows: db.all<Record<string, SqlValue>>(`SELECT * FROM ${quoted(name)}`).map((row) => Object.fromEntries(
        Object.entries(row).map(([key, value]) => {
          if (typeof value === 'bigint') fail('internal', 'A migration row contains an unsupported bigint.')
          return [key, value instanceof Uint8Array ? { bytes: Buffer.from(value).toString('base64') } : value]
        })
      ))
    }))
  }
}

function digest(checkpoint: Checkpoint): string {
  return contentHash(checkpoint.tables.map((table) => ({ ...table, rows: table.rows.map((row) => contentHash(row)).sort() })))
}

function restoreTable(db: Db, table: Checkpoint['tables'][number]): void {
  const columns = db.all<{ name: string }>(`PRAGMA table_info(${quoted(table.name)})`).map((column) => column.name)
  if (table.name === 'sqlite_sequence') db.run('DELETE FROM sqlite_sequence')
  for (const row of table.rows) {
    const keys = Object.keys(row)
    if (keys.length !== columns.length || keys.some((key) => !columns.includes(key))) {
      fail('internal', `Migration checkpoint columns do not match ${table.name}.`)
    }
    const values = keys.map((key): SqlValue => {
      const value = row[key]
      if (value === undefined) return fail('internal', 'Missing migration checkpoint value.')
      return typeof value === 'object' && value !== null ? Buffer.from(value.bytes, 'base64') : value
    })
    db.run(`INSERT INTO ${quoted(table.name)} (${keys.map(quoted).join(',')}) VALUES (${keys.map(() => '?').join(',')})`, ...values)
  }
}

/** The destination is newly created; SQL identifiers come only from its own migrated schema. */
export function rebuildCheckpoint(path: string, text: string): Db {
  const checkpoint = checkpointSchema.parse(JSON.parse(text))
  const db = openDatabase(path)
  try {
    migrate(db)
    const names = tableNames(db)
    if (JSON.stringify(names) !== JSON.stringify(checkpoint.tables.map((table) => table.name))) {
      fail('internal', 'Migration checkpoint tables do not match the current database schema.')
    }
    db.exec('PRAGMA foreign_keys = OFF')
    db.tx(() => {
      for (const name of names) db.run(`DELETE FROM ${quoted(name)}`)
      // sqlite_sequence is restored last: inserting explicit row ids may advance it first.
      const tables = [...checkpoint.tables.filter((table) => table.name !== 'sqlite_sequence'), ...checkpoint.tables.filter((table) => table.name === 'sqlite_sequence')]
      for (const table of tables) restoreTable(db, table)
    })
    db.exec('PRAGMA foreign_keys = ON')
    if (db.all('PRAGMA foreign_key_check').length !== 0 || db.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check !== 'ok') {
      fail('internal', 'The rebuilt migration database failed integrity verification.')
    }
    if (digest(checkpointOf(db)) !== digest(checkpoint)) {
      fail('internal', 'The rebuilt migration database does not match every source row.')
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
