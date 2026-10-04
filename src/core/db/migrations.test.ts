import { afterEach, describe, expect, it } from 'vitest'
import { ATTEMPT_STATES, RUN_STATES, WORK_STATUSES } from '../../shared/domain/status'
import { thrownBy } from '../../test/thrownBy'
import { DomainError } from '../errors'
import { type Db, openDatabase } from './database'
import { MIGRATIONS, migrate, readSchemaVersion, SCHEMA_VERSION } from './migrations'

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
  it('starts at schema version 0 and targets SCHEMA_VERSION 6', () => {
    expect(SCHEMA_VERSION).toBe(6)
    expect(readSchemaVersion(freshDb())).toBe(0)
  })

  it('applies every migration and records the latest in user_version', () => {
    const db = freshDb()
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION })
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(6)
  })
})

describe('the schema a fresh database ends up with', () => {
  it('creates every table of the schema', () => {
    expect(objectNames(migratedDb(), 'table')).toEqual([
      'approvals',
      'attempts',
      'checkpoints',
      'comments',
      'drafts',
      'epics',
      'events',
      'host_catalogs',
      'idempotency',
      'meta',
      'outbox',
      'plan_revisions',
      'profiles',
      'retry_grants',
      'row_checks',
      'runs',
      'search_index',
      'sessions',
      'sprint_reports',
      'sync_state',
      'ticket_status'
    ])
  })

  it('creates every index of the schema', () => {
    expect(objectNames(migratedDb(), 'index')).toEqual([
      'attempts_one_open_per_ticket',
      'attempts_run_state',
      'comments_epic_ticket',
      'events_epic',
      'events_run',
      'outbox_state',
      'plan_revisions_epic',
      'row_checks_run',
      'runs_one_active_per_epic',
      'ticket_status_epic'
    ])
  })
})

describe('migrate when already current', () => {
  it('is a no-op the second time', () => {
    const db = migratedDb()
    expect(migrate(db)).toEqual({ from: 6, to: 6 })
    expect(readSchemaVersion(db)).toBe(6)
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
      'Database schema v7 is newer than this build supports (v6). Update Dark Mechanicus.'
    )
    expect((error as DomainError).details).toEqual({ found: 7, supported: 6 })
    expect(readSchemaVersion(db)).toBe(7)
    expect(objectNames(db, 'table')).toEqual([])
  })

  it('refuses a migrated database that a newer build has upgraded', () => {
    const db = migratedDb()
    db.exec('PRAGMA user_version = 7')
    const error = thrownBy(() => migrate(db))
    expect((error as DomainError).code).toBe('incompatible_schema')
    expect((error as DomainError).details).toEqual({ found: 7, supported: 6 })
    expect(objectNames(db, 'table')).toContain('epics')
  })

  it('accepts a database exactly at the supported version', () => {
    const db = migratedDb()
    expect(thrownBy(() => migrate(db))).toBeUndefined()
  })
})

function v1Db(): Db {
  const db = freshDb()
  migrate(db, MIGRATIONS.filter((migration) => migration.version === 1))
  return db
}

function outboxRows(db: Db): unknown[] {
  return db.all('SELECT id, kind, epic_id, run_id, revision_id, entity_id, state, attempts, last_error FROM outbox ORDER BY id')
}

describe('migrate a v1 database to v2', () => {
  it('keeps every outbox row and id, with no entity id yet', () => {
    const db = v1Db()
    db.run(
      `INSERT INTO outbox (kind, epic_id, run_id, revision_id, state, attempts, last_error, created_at)
       VALUES ('snapshot', 'ep1', NULL, 'rv1', 'done', 1, NULL, 't'), ('run_history', 'ep1', 'rn1', NULL, 'failed', 3, 'disk full', 't')`
    )
    expect(migrate(db)).toEqual({ from: 1, to: 6 })
    expect(outboxRows(db)).toEqual([
      { id: 1, kind: 'snapshot', epic_id: 'ep1', run_id: null, revision_id: 'rv1', entity_id: null, state: 'done', attempts: 1, last_error: null },
      { id: 2, kind: 'run_history', epic_id: 'ep1', run_id: 'rn1', revision_id: null, entity_id: null, state: 'failed', attempts: 3, last_error: 'disk full' }
    ])
  })

  it('never reuses an outbox id, even one deleted before the upgrade', () => {
    const db = v1Db()
    db.run("INSERT INTO outbox (kind, state, created_at) VALUES ('snapshot', 'done', 't'), ('snapshot', 'done', 't')")
    db.run('DELETE FROM outbox WHERE id = 2')
    migrate(db)
    expect(db.run("INSERT INTO outbox (kind, state, created_at) VALUES ('comment', 'pending', 't')").lastInsertRowid).toBe(3)
  })

  it('keeps every sync state row', () => {
    const db = v1Db()
    db.run(
      `INSERT INTO sync_state (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
       VALUES ('epic', 'ep1', 'sha256:a', 4, 'sha256:b', 'diverged', 't1'), ('run', 'rn1', NULL, 0, NULL, NULL, 't2')`
    )
    migrate(db)
    expect(db.all('SELECT * FROM sync_state ORDER BY kind')).toEqual([
      { kind: 'epic', entity_id: 'ep1', exported_hash: 'sha256:a', generation: 4, imported_hash: 'sha256:b', conflict: 'diverged', updated_at: 't1' },
      { kind: 'run', entity_id: 'rn1', exported_hash: null, generation: 0, imported_hash: null, conflict: null, updated_at: 't2' }
    ])
  })

  it('keeps the pending-work index on the rebuilt outbox', () => {
    const db = v1Db()
    migrate(db)
    expect(objectNames(db, 'index')).toContain('outbox_state')
  })
})

describe('schema v2 record kinds', () => {
  it.each(['comment', 'profile'])('accepts outbox entries of kind %s keyed by entity id', (kind) => {
    const db = migratedDb()
    db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES (?, 'key-1', 'pending', 't')", kind)
    expect(db.get<{ entity_id: string }>('SELECT entity_id FROM outbox WHERE kind = ?', kind)?.entity_id).toBe('key-1')
  })

  it.each(['comment', 'profile'])('accepts sync state of kind %s', (kind) => {
    const db = migratedDb()
    db.run("INSERT INTO sync_state (kind, entity_id, updated_at) VALUES (?, 'key-1', 't')", kind)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_state WHERE kind = ?', kind)?.n).toBe(1)
  })
})

function insertComment(db: Db, spec: { id: string; epicId?: string; ticketId?: string | null; role?: string }): void {
  db.run(
    `INSERT INTO comments (id, epic_id, ticket_id, body, author_role, author_label, created_at)
     VALUES (?, ?, ?, 'Looks **good**', ?, 'Ada', 't')`,
    spec.id,
    spec.epicId ?? 'ep1',
    spec.ticketId ?? null,
    spec.role ?? 'desktop'
  )
}

function commentsDb(): Db {
  const db = migratedDb()
  insertEpic(db, 'ep1')
  return db
}

describe('schema v3 comments', () => {
  it('migrates a v2 database through v3 and keeps its epics', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 2))
    insertEpic(db, 'ep1')
    expect(migrate(db)).toEqual({ from: 2, to: SCHEMA_VERSION })
    insertComment(db, { id: 'cm1' })
    expect(db.all('SELECT id, epic_id, ticket_id, body, author_role, author_label, created_at FROM comments')).toEqual([
      { id: 'cm1', epic_id: 'ep1', ticket_id: null, body: 'Looks **good**', author_role: 'desktop', author_label: 'Ada', created_at: 't' }
    ])
    expect(db.all('SELECT id FROM epics')).toEqual([{ id: 'ep1' }])
  })

  it.each(['desktop', 'planner', 'orchestrator', 'worker', 'reviewer'])('accepts comments written by the %s role', (role) => {
    const db = commentsDb()
    insertComment(db, { id: `cm_${role}`, ticketId: 'tk1', role })
    expect(db.get<{ author_role: string; ticket_id: string }>('SELECT author_role, ticket_id FROM comments')).toEqual({
      author_role: role,
      ticket_id: 'tk1'
    })
  })

  it('rejects an unknown author role, a missing epic, and a duplicate id', () => {
    const db = commentsDb()
    expect(() => insertComment(db, { id: 'cm1', role: 'admin' })).toThrow(/CHECK constraint failed/)
    expect(() => insertComment(db, { id: 'cm1', epicId: 'nope' })).toThrow(/FOREIGN KEY constraint failed/)
    insertComment(db, { id: 'cm1' })
    expect(() => insertComment(db, { id: 'cm1' })).toThrow(/UNIQUE constraint failed/)
  })

  it.each([
    ['body', "NULL, 'desktop', 'Ada', 't'"],
    ['author_label', "'b', 'desktop', NULL, 't'"],
    ['created_at', "'b', 'desktop', 'Ada', NULL"]
  ])('requires comments.%s', (column, values) => {
    const db = commentsDb()
    const insert = `INSERT INTO comments (id, epic_id, ticket_id, body, author_role, author_label, created_at) VALUES ('cm1', 'ep1', NULL, ${values})`
    expect(() => db.run(insert)).toThrow(`NOT NULL constraint failed: comments.${column}`)
  })

  it('lists an epic’s comments through the (epic, ticket, time) index', () => {
    const db = commentsDb()
    const plan = db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT id FROM comments WHERE epic_id = 'ep1' AND ticket_id = 'tk1' ORDER BY created_at")
    expect(plan.map((row) => row.detail).join(' ')).toContain('USING INDEX comments_epic_ticket (epic_id=? AND ticket_id=?)')
  })
})

function v2Db(): Db {
  const db = freshDb()
  migrate(db, MIGRATIONS.filter((migration) => migration.version <= 2))
  return db
}

function insertProfile(db: Db, name: string): void {
  db.run("INSERT INTO profiles (name, capability_json, revision, created_at, updated_at) VALUES (?, '{}', 1, 't', 't')", name)
}

describe('schema v4 named profiles', () => {
  it('upgrades a v2 database to the latest version, keeping its rows and adding an empty profiles table', () => {
    const db = v2Db()
    db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES ('profile', 'deep-review', 'pending', 't')")
    expect(migrate(db)).toEqual({ from: 2, to: 6 })
    expect(db.all('SELECT kind, entity_id, state FROM outbox')).toEqual([{ kind: 'profile', entity_id: 'deep-review', state: 'pending' }])
    expect(db.all('SELECT * FROM profiles')).toEqual([])
  })

  it('keys profiles by name with a description, capability, revision, and timestamps', () => {
    const columns = migratedDb().all<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>(
      'SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(\'profiles\') ORDER BY cid'
    )
    expect(columns).toEqual([
      { name: 'name', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { name: 'description', type: 'TEXT', notnull: 1, dflt_value: "''", pk: 0 },
      { name: 'capability_json', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'revision', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'updated_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 }
    ])
  })

  it('defaults the description to empty and refuses a second profile of the same name', () => {
    const db = migratedDb()
    insertProfile(db, 'deep-review')
    expect(db.get('SELECT description FROM profiles WHERE name = ?', 'deep-review')).toEqual({ description: '' })
    expect(() => insertProfile(db, 'deep-review')).toThrow(/UNIQUE constraint failed: profiles.name/)
    expect(() => db.run("INSERT INTO profiles (name, revision, created_at, updated_at) VALUES ('x', 1, 't', 't')")).toThrow(
      /NOT NULL constraint failed: profiles.capability_json/
    )
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
    expect(migrate(db)).toEqual({ from: 0, to: 6 })
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

describe('schema constraints match the shared vocabulary', () => {
  it.each(WORK_STATUSES)('accepts the work status %s for epics and tickets', (status) => {
    const db = runsDb()
    expect(() =>
      db.run(
        "INSERT INTO epics (id, title, status, created_at, updated_at) VALUES (?, 'T', ?, 't', 't')",
        `ep_${status}`,
        status
      )
    ).not.toThrow()
    expect(() => db.run("INSERT INTO ticket_status VALUES (?, 'ep1', ?, 1, 't')", `tk_${status}`, status)).not.toThrow()
  })

  it.each(RUN_STATES)('accepts the run state %s', (state) => {
    const db = runsDb()
    insertEpic(db, `ep_${state}`)
    expect(() => insertRun(db, { id: `rn_${state}`, state, epicId: `ep_${state}` })).not.toThrow()
  })

  it.each(ATTEMPT_STATES)('accepts the attempt state %s', (state) => {
    const db = attemptsDb()
    expect(() => insertAttempt(db, { id: `at_${state}`, state, number: 1, ticketId: `tk_${state}` })).not.toThrow()
  })
})

describe('schema constraints on other vocabularies', () => {
  it('rejects run and attempt states outside the vocabulary', () => {
    const db = attemptsDb()
    insertEpic(db, 'ep_other')
    expect(() => insertRun(db, { id: 'rn_bad', state: 'exploded', epicId: 'ep_other' })).toThrow(/CHECK constraint failed/)
    expect(() => insertAttempt(db, { id: 'at_bad', state: 'exploded', number: 1, ticketId: 'tk_bad' })).toThrow(
      /CHECK constraint failed/
    )
  })

  it.each(['work', 'carry_forward'])('accepts the attempt kind %s and rejects others', (kind) => {
    const db = attemptsDb()
    const insert = (value: string): number =>
      db.run(
        `INSERT INTO attempts (id, run_id, ticket_id, number, kind, state, fencing_token, worker_json,
           revision_id, ticket_content_hash, created_at, updated_at)
         VALUES (?, 'rn1', ?, 1, ?, 'accepted', 1, '{}', 'rv1', 'h', 't', 't')`,
        `at_${value}`,
        `tk_${value}`,
        value
      ).changes
    expect(() => insert(kind)).not.toThrow()
    expect(() => insert('mystery')).toThrow(/CHECK constraint failed/)
  })

  it.each(['desktop', 'planner', 'orchestrator', 'worker', 'reviewer'])('accepts the session role %s', (role) => {
    const db = migratedDb()
    expect(() =>
      db.run("INSERT INTO sessions VALUES (?, ?, 'l', '[]', 'stdio', NULL, 't', 't', NULL)", `ss_${role}`, role)
    ).not.toThrow()
  })

  it.each(['pending', 'saved', 'failed'])('accepts the plan revision state %s', (state) => {
    const db = runsDb()
    const insert = (value: string): number =>
      db.run(
        `INSERT INTO plan_revisions (id, epic_id, number, content_hash, bundle_json, state, created_at)
         VALUES (?, 'ep1', 2, 'h', '{}', ?, 't')`,
        `rv_${value}`,
        value
      ).changes
    expect(() => insert(state)).not.toThrow()
    expect(() => insert('draft')).toThrow(/CHECK constraint failed/)
  })
})

function insertRowCheckRow(db: Db, spec: { id: string; number?: number; runId?: string; row?: number }): void {
  db.run(
    `INSERT INTO row_checks (id, run_id, number, sprint_id, row_no, commit_ref, checks_json, recorded_by, created_at)
     VALUES (?, ?, ?, 'sp1', ?, 'abcdef1', '[]', NULL, 't')`,
    spec.id,
    spec.runId ?? 'rn1',
    spec.number ?? 1,
    spec.row ?? 1
  )
}

describe('schema v5 row checks', () => {
  it('upgrades a v4 database, keeping its runs and adding an empty row_checks table', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 4))
    insertEpic(db, 'ep1')
    insertRevision(db, 'rv1', 'ep1')
    insertRun(db, { id: 'rn1', state: 'running' })
    expect(migrate(db)).toEqual({ from: 4, to: 6 })
    expect(db.all('SELECT id FROM runs')).toEqual([{ id: 'rn1' }])
    expect(db.all('SELECT * FROM row_checks')).toEqual([])
  })

  it('keeps a check with its run, sprint, row, number, commit, entries, author and time', () => {
    const db = attemptsDb()
    insertRowCheckRow(db, { id: 'rk1', row: 2 })
    expect(db.get('SELECT id, run_id, sprint_id, row_no, number, commit_ref, checks_json, recorded_by, created_at FROM row_checks')).toEqual({
      id: 'rk1',
      run_id: 'rn1',
      sprint_id: 'sp1',
      row_no: 2,
      number: 1,
      commit_ref: 'abcdef1',
      checks_json: '[]',
      recorded_by: null,
      created_at: 't'
    })
  })

  it('rejects a second check with the same id or the same number in a run, and a missing run', () => {
    const db = attemptsDb()
    insertRowCheckRow(db, { id: 'rk1' })
    expect(() => insertRowCheckRow(db, { id: 'rk1', number: 2 })).toThrow(/UNIQUE constraint failed: row_checks.id/)
    expect(() => insertRowCheckRow(db, { id: 'rk2' })).toThrow(/UNIQUE constraint failed: row_checks.run_id, row_checks.number/)
    expect(() => insertRowCheckRow(db, { id: 'rk3', runId: 'rn_missing' })).toThrow(/FOREIGN KEY constraint failed/)
    expect(() => insertRowCheckRow(db, { id: 'rk4', runId: 'rn2' })).not.toThrow()
  })

  it('rejects rows and numbers below 1', () => {
    const db = attemptsDb()
    expect(() => insertRowCheckRow(db, { id: 'rk1', row: 0 })).toThrow(/CHECK constraint failed/)
    expect(() => insertRowCheckRow(db, { id: 'rk2', number: 0 })).toThrow(/CHECK constraint failed/)
  })

  it('looks up a run\'s checks through the (run, sprint, row) index', () => {
    const db = attemptsDb()
    const plan = db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT id FROM row_checks WHERE run_id = 'rn1' AND sprint_id = 'sp1' AND row_no = 1")
    expect(plan.map((row) => row.detail).join(' ')).toContain('USING INDEX row_checks_run')
  })
})

describe('schema v6 sprint increments', () => {
  it('upgrades a v5 database, keeping its attempts and leaving their increment empty', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 5))
    insertEpic(db, 'ep1')
    insertRevision(db, 'rv1', 'ep1')
    insertRun(db, { id: 'rn1', state: 'running' })
    insertAttempt(db, { id: 'at1', state: 'accepted', number: 1 })
    expect(migrate(db)).toEqual({ from: 5, to: 6 })
    expect(db.all('SELECT id, state, increment_json FROM attempts')).toEqual([{ id: 'at1', state: 'accepted', increment_json: null }])
  })

  it('keeps the verdict of an attempt as the JSON it was stored with', () => {
    const db = attemptsDb()
    insertAttempt(db, { id: 'at1', state: 'submitted', number: 1 })
    db.run("UPDATE attempts SET increment_json = '{\"passed\":true}' WHERE id = 'at1'")
    expect(db.get('SELECT increment_json FROM attempts WHERE id = ?', 'at1')).toEqual({ increment_json: '{"passed":true}' })
  })

  it('adds no table', () => {
    expect(objectNames(migratedDb(), 'table')).not.toContain('sprint_increments')
  })
})
