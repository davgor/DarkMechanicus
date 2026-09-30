import { afterEach, describe, expect, it } from 'vitest'
import { DomainError } from '../errors'
import { type Db, openDatabase } from './database'
import { migrate, readSchemaVersion, SCHEMA_VERSION } from './migrations'

const openDbs: Db[] = []

function freshDb(): Db {
  const db = openDatabase(':memory:')
  openDbs.push(db)
  return db
}

function migratedDb(): Db {
  const db = freshDb()
  migrate(db)
  return db
}

function thrownBy(action: () => unknown): unknown {
  try {
    action()
  } catch (error: unknown) {
    return error
  }
  return undefined
}

function objectNames(db: Db, type: 'table' | 'index'): string[] {
  return db
    .all<{ name: string }>(
      `SELECT name FROM sqlite_master
       WHERE type = ? AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_index_%'
       ORDER BY name`,
      type
    )
    .map((row) => row.name)
}

afterEach(() => {
  for (const db of openDbs.splice(0)) {
    db.close()
  }
})

describe('migrate on a fresh database', () => {
  it('starts at schema version 0 and targets SCHEMA_VERSION 1', () => {
    expect(SCHEMA_VERSION).toBe(1)
    expect(readSchemaVersion(freshDb())).toBe(0)
  })

  it('applies schema v1 and records it in user_version', () => {
    const db = freshDb()
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION })
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(1)
  })

  it('creates every table of schema v1', () => {
    expect(objectNames(migratedDb(), 'table')).toEqual([
      'approvals',
      'attempts',
      'checkpoints',
      'drafts',
      'epics',
      'events',
      'host_catalogs',
      'idempotency',
      'meta',
      'outbox',
      'plan_revisions',
      'retry_grants',
      'runs',
      'search_index',
      'sessions',
      'sprint_reports',
      'sync_state',
      'ticket_status'
    ])
  })

  it('creates every index of schema v1', () => {
    expect(objectNames(migratedDb(), 'index')).toEqual([
      'attempts_one_open_per_ticket',
      'attempts_run_state',
      'events_epic',
      'events_run',
      'outbox_state',
      'plan_revisions_epic',
      'runs_one_active_per_epic',
      'ticket_status_epic'
    ])
  })
})

describe('migrate when already current', () => {
  it('is a no-op the second time', () => {
    const db = migratedDb()
    expect(migrate(db)).toEqual({ from: 1, to: 1 })
    expect(readSchemaVersion(db)).toBe(1)
  })

  it('keeps existing data', () => {
    const db = migratedDb()
    db.run("INSERT INTO meta (key, value) VALUES ('k', 'v')")
    migrate(db)
    expect(db.get<{ value: string }>("SELECT value FROM meta WHERE key = 'k'")?.value).toBe('v')
  })
})

describe('migrate refuses newer databases', () => {
  it('throws incompatible_schema naming both versions and leaves the database alone', () => {
    const db = freshDb()
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    const error = thrownBy(() => migrate(db))
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('incompatible_schema')
    expect((error as DomainError).message).toBe(
      'Database schema v2 is newer than this build supports (v1). Update Dark Mechanicus.'
    )
    expect((error as DomainError).details).toEqual({ found: 2, supported: 1 })
    expect(readSchemaVersion(db)).toBe(2)
    expect(objectNames(db, 'table')).toEqual([])
  })

  it('refuses a migrated database that a newer build has upgraded', () => {
    const db = migratedDb()
    db.exec('PRAGMA user_version = 7')
    const error = thrownBy(() => migrate(db))
    expect((error as DomainError).code).toBe('incompatible_schema')
    expect((error as DomainError).details).toEqual({ found: 7, supported: 1 })
    expect(objectNames(db, 'table')).toContain('epics')
  })

  it('accepts a database exactly at the supported version', () => {
    const db = migratedDb()
    expect(thrownBy(() => migrate(db))).toBeUndefined()
  })
})

describe('migrate with custom migration lists', () => {
  const first = { version: 1, sql: 'CREATE TABLE alpha (x)' }
  const second = { version: 2, sql: 'CREATE TABLE beta (y)' }
  const third = { version: 3, sql: 'CREATE TABLE gamma (z)' }

  it('applies migrations in list order up to the highest version', () => {
    const db = freshDb()
    expect(migrate(db, [first, second])).toEqual({ from: 0, to: 2 })
    expect(objectNames(db, 'table')).toEqual(['alpha', 'beta'])
    expect(readSchemaVersion(db)).toBe(2)
  })

  it('applies only migrations newer than the current version', () => {
    const db = freshDb()
    migrate(db, [first, second])
    expect(migrate(db, [first, second, third])).toEqual({ from: 2, to: 3 })
    expect(objectNames(db, 'table')).toEqual(['alpha', 'beta', 'gamma'])
    expect(readSchemaVersion(db)).toBe(3)
  })

  it('lets later migrations build on earlier ones', () => {
    const db = freshDb()
    const alter = { version: 2, sql: 'ALTER TABLE alpha ADD COLUMN extra TEXT' }
    migrate(db, [first, alter])
    db.run("INSERT INTO alpha (x, extra) VALUES ('a', 'b')")
    expect(db.get<{ extra: string }>('SELECT extra FROM alpha')?.extra).toBe('b')
  })

  it('does nothing for an empty list on a fresh database', () => {
    const db = freshDb()
    expect(migrate(db, [])).toEqual({ from: 0, to: 0 })
    expect(readSchemaVersion(db)).toBe(0)
  })

  it('refuses a database newer than the highest listed version', () => {
    const db = freshDb()
    migrate(db, [first, second])
    const error = thrownBy(() => migrate(db, [first]))
    expect((error as DomainError).code).toBe('incompatible_schema')
    expect((error as DomainError).details).toEqual({ found: 2, supported: 1 })
  })
})

describe('migrate failure handling', () => {
  it('rolls a failing migration back completely', () => {
    const db = freshDb()
    const broken = { version: 1, sql: 'CREATE TABLE ok (x); CREATE TABLE ok (x)' }
    expect(() => migrate(db, [broken])).toThrow(/already exists/)
    expect(objectNames(db, 'table')).toEqual([])
    expect(readSchemaVersion(db)).toBe(0)
  })

  it('rolls earlier migrations of the same run back when a later one fails', () => {
    const db = freshDb()
    const good = { version: 1, sql: 'CREATE TABLE good (x)' }
    const bad = { version: 2, sql: 'INSERT INTO missing VALUES (1)' }
    expect(() => migrate(db, [good, bad])).toThrow(/no such table/)
    expect(objectNames(db, 'table')).toEqual([])
    expect(readSchemaVersion(db)).toBe(0)
  })

  it('leaves the connection outside a transaction after a failure', () => {
    const db = freshDb()
    thrownBy(() => migrate(db, [{ version: 1, sql: 'NOT SQL' }]))
    expect(db.inTransaction()).toBe(false)
    expect(migrate(db)).toEqual({ from: 0, to: 1 })
  })
})

function insertEpic(db: Db, id: string): void {
  db.run(
    "INSERT INTO epics (id, title, status, created_at, updated_at) VALUES (?, 'Epic', 'backlog', 't', 't')",
    id
  )
}

function insertRevision(db: Db, id: string, epicId: string): void {
  db.run(
    `INSERT INTO plan_revisions (id, epic_id, number, content_hash, bundle_json, state, created_at)
     VALUES (?, ?, 1, 'sha256:x', '{}', 'saved', 't')`,
    id,
    epicId
  )
}

function insertRun(db: Db, spec: { id: string; state: string; epicId?: string }): void {
  db.run(
    `INSERT INTO runs (id, epic_id, number, revision_id, state, owner_machine_id, created_at, updated_at)
     VALUES (?, ?, 1, 'rv1', ?, 'mc1', 't', 't')`,
    spec.id,
    spec.epicId ?? 'ep1',
    spec.state
  )
}

function insertAttempt(
  db: Db,
  spec: { id: string; state: string; number: number; runId?: string; ticketId?: string }
): void {
  db.run(
    `INSERT INTO attempts (id, run_id, ticket_id, number, kind, state, fencing_token, worker_json,
       revision_id, ticket_content_hash, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'work', ?, 1, '{}', 'rv1', 'sha256:x', 't', 't')`,
    spec.id,
    spec.runId ?? 'rn1',
    spec.ticketId ?? 'tk1',
    spec.number,
    spec.state
  )
}

function runsDb(): Db {
  const db = migratedDb()
  insertEpic(db, 'ep1')
  insertEpic(db, 'ep2')
  insertRevision(db, 'rv1', 'ep1')
  return db
}

function attemptsDb(): Db {
  const db = runsDb()
  insertRun(db, { id: 'rn1', state: 'running' })
  insertRun(db, { id: 'rn2', state: 'completed' })
  return db
}

const ACTIVE_RUN_STATES = ['queued', 'running', 'awaiting_checkpoint', 'paused']
const ENDED_RUN_STATES = ['failed', 'canceled', 'completed']
const OPEN_ATTEMPT_STATES = ['claimed', 'running', 'submitted']
const CLOSED_ATTEMPT_STATES = ['accepted', 'rejected', 'failed', 'canceled', 'lease_expired']

describe('one active run per epic', () => {
  it.each(ACTIVE_RUN_STATES)('rejects a second run while the first is %s', (state) => {
    const db = runsDb()
    insertRun(db, { id: 'r1', state })
    expect(() => insertRun(db, { id: 'r2', state: 'running' })).toThrow(/UNIQUE constraint failed/)
  })

  it.each(ACTIVE_RUN_STATES)('rejects a new %s run while another run is active', (state) => {
    const db = runsDb()
    insertRun(db, { id: 'r1', state: 'paused' })
    expect(() => insertRun(db, { id: 'r2', state })).toThrow(/UNIQUE constraint failed/)
  })

  it.each(ENDED_RUN_STATES)('allows any number of %s runs beside the active one', (state) => {
    const db = runsDb()
    insertRun(db, { id: 'r1', state })
    insertRun(db, { id: 'r2', state })
    insertRun(db, { id: 'r3', state: 'running' })
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs')?.n).toBe(3)
  })

  it('allows one active run per epic', () => {
    const db = runsDb()
    insertRun(db, { id: 'r1', state: 'running', epicId: 'ep1' })
    insertRun(db, { id: 'r2', state: 'running', epicId: 'ep2' })
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM runs')?.n).toBe(2)
  })

  it('frees the slot when the active run ends', () => {
    const db = runsDb()
    insertRun(db, { id: 'r1', state: 'running' })
    db.run("UPDATE runs SET state = 'completed' WHERE id = 'r1'")
    insertRun(db, { id: 'r2', state: 'queued' })
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE state = 'queued'")?.n).toBe(1)
  })

  it('also guards updates that would reactivate an ended run', () => {
    const db = runsDb()
    insertRun(db, { id: 'r1', state: 'completed' })
    insertRun(db, { id: 'r2', state: 'running' })
    expect(() => db.run("UPDATE runs SET state = 'paused' WHERE id = 'r1'")).toThrow(/UNIQUE constraint failed/)
  })
})

describe('one open attempt per ticket', () => {
  it.each(OPEN_ATTEMPT_STATES)('rejects a second attempt while the first is %s', (state) => {
    const db = attemptsDb()
    insertAttempt(db, { id: 'a1', state, number: 1 })
    expect(() => insertAttempt(db, { id: 'a2', state: 'claimed', number: 2 })).toThrow(/UNIQUE constraint failed/)
  })

  it.each(OPEN_ATTEMPT_STATES)('rejects a new %s attempt beside an open one', (state) => {
    const db = attemptsDb()
    insertAttempt(db, { id: 'a1', state: 'submitted', number: 1 })
    expect(() => insertAttempt(db, { id: 'a2', state, number: 2 })).toThrow(/UNIQUE constraint failed/)
  })

  it.each(CLOSED_ATTEMPT_STATES)('allows a new attempt after the previous one is %s', (state) => {
    const db = attemptsDb()
    insertAttempt(db, { id: 'a1', state, number: 1 })
    insertAttempt(db, { id: 'a2', state: 'claimed', number: 2 })
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM attempts')?.n).toBe(2)
  })

  it('allows open attempts for different tickets and different runs', () => {
    const db = attemptsDb()
    insertAttempt(db, { id: 'a1', state: 'claimed', number: 1 })
    insertAttempt(db, { id: 'a2', state: 'claimed', number: 1, ticketId: 'tk2' })
    insertAttempt(db, { id: 'a3', state: 'claimed', number: 1, runId: 'rn2' })
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM attempts')?.n).toBe(3)
  })

  it('never reuses an attempt number within a run and ticket', () => {
    const db = attemptsDb()
    insertAttempt(db, { id: 'a1', state: 'failed', number: 1 })
    expect(() => insertAttempt(db, { id: 'a2', state: 'claimed', number: 1 })).toThrow(/UNIQUE constraint failed/)
  })
})

describe('schema constraints', () => {
  it.each([
    ['sessions.role', "INSERT INTO sessions VALUES ('s1', 'admin', 'l', '[]', 'stdio', NULL, 't', 't', NULL)"],
    ['epics.status', "INSERT INTO epics (id, title, status, created_at, updated_at) VALUES ('e', 'T', 'done', 't', 't')"],
    ['outbox.kind', "INSERT INTO outbox (kind, state, created_at) VALUES ('other', 'pending', 't')"],
    ['outbox.state', "INSERT INTO outbox (kind, state, created_at) VALUES ('snapshot', 'weird', 't')"],
    ['sync_state.kind', "INSERT INTO sync_state (kind, entity_id, updated_at) VALUES ('other', 'x', 't')"],
    ['ticket_status.status', "INSERT INTO ticket_status VALUES ('t', 'e', 'started', 1, 't')"]
  ])('rejects invalid values for %s', (_column, sql) => {
    expect(() => migratedDb().exec(sql)).toThrow(/CHECK constraint failed/)
  })

  it('enforces foreign keys from runs to epics and revisions', () => {
    const db = runsDb()
    expect(() => insertRun(db, { id: 'r1', state: 'running', epicId: 'nope' })).toThrow(
      /FOREIGN KEY constraint failed/
    )
  })

  it('never reuses event sequence numbers, even after the newest event is deleted', () => {
    const db = migratedDb()
    const insert = (): number =>
      db.run("INSERT INTO events (at, kind, payload_json) VALUES ('t', 'k', '{}')").lastInsertRowid
    expect([insert(), insert()]).toEqual([1, 2])
    db.run('DELETE FROM events WHERE seq = 2')
    expect(insert()).toBe(3)
  })

  it('keys idempotency records by command and key', () => {
    const db = migratedDb()
    const insert = (command: string, key: string): void => {
      db.run("INSERT INTO idempotency VALUES (?, ?, 'h', '{}', 't')", command, key)
    }
    insert('save', 'k1')
    insert('advance', 'k1')
    expect(() => insert('save', 'k1')).toThrow(/UNIQUE constraint failed/)
  })
})
