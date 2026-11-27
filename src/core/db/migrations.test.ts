import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LEARNING_HISTORY_KINDS, LEARNING_INTEGRATION_OPEN_STATES, LEARNING_INTEGRATION_STATES, LEARNING_STATES } from '../../shared/domain/learnings'
import { ATTEMPT_STATES, RUN_STATES, WORK_STATUSES } from '../../shared/domain/status'
import { doneCard, kanbanSessions } from '../../test/kanbanFixtures'
import { createRepoEnv, createStubGit, importerDeps, initProject } from '../../test/repoEnv'
import { thrownBy } from '../../test/thrownBy'
import { contentHash, prettyJson } from '../canonical'
import { DomainError } from '../errors'
import { reconcileRepository } from '../repo/importer'
import { ownedPaths } from '../repo/paths'
import { buildKanbanCardRecord, buildKanbanEventRecord, buildRunHistoryRecord, buildSnapshotRecord } from '../repo/portable'
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
  it('starts at version zero and targets the current migration contract', () => {
    expect(SCHEMA_VERSION).toBe(Math.max(...MIGRATIONS.map(migration => migration.version)))
    expect(readSchemaVersion(freshDb())).toBe(0)
  })

  it('applies every migration and records the latest in user_version', () => {
    const db = freshDb()
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION })
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(SCHEMA_VERSION)
  })
})

it('retires legacy holds, restores the prior run state and credits an open lease once', () => {
  const db = freshDb()
  migrate(db, MIGRATIONS.filter(migration => migration.version < 29))
  const heldAt = '2026-11-23T12:00:00.000Z'
  const heartbeat = '2026-11-23T12:01:00.000Z'
  const expires = '2026-11-23T12:06:00.000Z'
  for (const [id, reason] of [['original', 'tooling_recovery'], ['taken', 'taken_over'], ['orphan', 'tooling_recovery']]) {
    db.run("INSERT INTO epics(id,title,status,created_at,updated_at) VALUES (?,?,'in_progress',?,?)", id, id, heldAt, heldAt)
    db.run("INSERT INTO plan_revisions(id,epic_id,number,content_hash,bundle_json,state,created_at) VALUES (?,?,1,'hash','{}','saved',?)", id, id, heldAt)
    db.run(`INSERT INTO runs(id,epic_id,number,revision_id,state,owner_machine_id,pause_reason,paused_at,created_at,updated_at)
      VALUES (?,?,1,?,'paused','fixture',?,?,?,?)`, id, id, id, reason, heldAt, heldAt, heldAt)
  }
  db.run(`INSERT INTO attempts(id,run_id,ticket_id,number,kind,state,fencing_token,worker_json,revision_id,ticket_content_hash,
    lease_expires_at,heartbeat_at,created_at,updated_at)
    VALUES ('attempt','original','ticket',1,'work','claimed',1,'{}','original','hash',?,?,?,?)`, expires, heartbeat, heldAt, heldAt)
  const migrationTime = '2026-11-23T12:04:00.000Z'
  db.run(`INSERT INTO kanban_cards(id,key,title,acceptance_criteria_json,expected_artifacts_json,references_json,priority,
    lane,created_by_role,created_by_label,created_at,updated_at,revision)
    VALUES ('card','DM-1','Open card','[]','[]','[]','medium','in_progress','desktop','Fixture',?,?,1)`, heldAt, heldAt)
  db.run(`INSERT INTO kanban_attempts(id,card_id,number,state,claim_secret,lease_expires_at,heartbeat_at,created_at)
    VALUES ('renewed','card',1,'running','fixture',?,?,?)`, expires, migrationTime, heldAt)
  for (const [id, run, prior] of [['origin', 'original', 'awaiting_checkpoint'], ['overlap', 'original', null], ['old-owner', 'taken', 'running']]) {
    db.run('INSERT INTO tooling_holds(chat_id,incident_id,run_id,held_at,previous_run_state) VALUES (?,?,?,?,?)', id, id, run, heldAt, prior)
  }
  db.run("INSERT INTO tooling_holds(chat_id,incident_id,card_id,held_at) VALUES ('card-chat','card-incident','card',?)", heldAt)
  db.exec("INSERT INTO tooling_held_attempts VALUES ('origin','attempt','run'), ('overlap','attempt','run'), ('card-incident','renewed','card')")
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(new Date(migrationTime))
    expect(migrate(db, MIGRATIONS.filter(migration => migration.version <= 29))).toEqual({ from: 28, to: 29 })
    expect(db.all('SELECT id,state,pause_reason,paused_at FROM runs ORDER BY id')).toEqual([
      { id: 'original', state: 'awaiting_checkpoint', pause_reason: null, paused_at: null },
      { id: 'orphan', state: 'paused', pause_reason: null, paused_at: heldAt },
      { id: 'taken', state: 'paused', pause_reason: 'taken_over', paused_at: heldAt }
    ])
    expect(db.get('SELECT lease_expires_at FROM attempts WHERE id = ?', 'attempt')).toEqual({ lease_expires_at: '2026-11-23T12:09:00.000Z' })
    expect(db.get('SELECT lease_expires_at FROM kanban_attempts WHERE id = ?', 'renewed')).toEqual({ lease_expires_at: expires })
    expect(migrate(db, MIGRATIONS.filter(migration => migration.version <= 29))).toEqual({ from: 29, to: 29 })
    expect(db.all('SELECT attempt_id,kind,granted_at,ms FROM legacy_tooling_lease_credits')).toEqual([
      { attempt_id: 'attempt', kind: 'run', granted_at: heartbeat, ms: 180_000 }
    ])
    expect(objectNames(db, 'table').filter(name => name.startsWith('tooling_'))).toEqual([])
  } finally { vi.useRealTimers() }
})

it('v30 keeps every pending outbox entry and adds an unset retry time', () => {
  const db = freshDb()
  migrate(db, MIGRATIONS.filter(migration => migration.version < 30))
  db.run(
    `INSERT INTO outbox (kind, epic_id, revision_id, entity_id, state, attempts, last_error, created_at) VALUES
      ('snapshot', 'ep1', 'rv1', NULL, 'pending', 0, NULL, 't'),
      ('epic_state', 'ep1', NULL, NULL, 'pending', 2, 'disk full', 't'),
      ('comment', 'ep1', NULL, 'cm1', 'pending', 1, 'not here', 't')`
  )
  expect(migrate(db, MIGRATIONS.filter(migration => migration.version <= 30))).toEqual({ from: 29, to: 30 })
  expect(db.all('SELECT id, kind, state, attempts, last_error, next_attempt_at FROM outbox ORDER BY id')).toEqual([
    { id: 1, kind: 'snapshot', state: 'pending', attempts: 0, last_error: null, next_attempt_at: null },
    { id: 2, kind: 'epic_state', state: 'pending', attempts: 2, last_error: 'disk full', next_attempt_at: null },
    { id: 3, kind: 'comment', state: 'pending', attempts: 1, last_error: 'not here', next_attempt_at: null }
  ])
  expect(readSchemaVersion(db)).toBe(30)
})

const EXPECTED_TABLES = [
  'agent_mail_bindings',
  'agent_mail_endpoints',
  'agent_mail_messages',
  'agent_mail_poll_sessions',
  'agent_mail_receipts',
  'agent_mail_wakes',
  'approvals',
  'attachments',
  'attempts',
  'checkpoints',
  'comments',
  'correction_links',
  'delivery_checks',
  'delivery_context_notices',
  'drafts',
  'epics',
  'events',
  'experiment_events',
  'grants',
  'host_catalogs',
  'idempotency',
  'kanban_attempts',
  'kanban_cards',
  'kanban_events',
  'learning_events',
  'learning_integrations',
  'learning_publications',
  'learning_records',
  'learning_stagings',
  'legacy_tooling_lease_credits',
  'meta',
  'metric_observations',
  'outbox',
  'plan_revisions',
  'profiles',
  'retry_grants',
  'row_checks',
  'runs',
  'save_permission_requests',
  'search_index',
  'sessions',
  'sprint_learning_cards',
  'sprint_reports',
  'sync_state',
  'ticket_status',
  'transfer_items',
  'transfers',
  'yolo_audit',
  'yolo_chat_bindings',
  'yolo_elevations'
]

it('upgrades v26 standards storage without dropping its project records', () => {
  const db = freshDb()
  migrate(db, MIGRATIONS.filter(migration => migration.version <= 26))
  db.run("INSERT INTO meta (key, value) VALUES ('test.policy', 'revision-6')")
  expect(objectNames(db, 'table')).not.toContain('delivery_context_notices')
  expect(migrate(db)).toEqual({ from: 26, to: SCHEMA_VERSION })
  expect(objectNames(db, 'table')).toContain('delivery_context_notices')
  expect(db.get("SELECT value FROM meta WHERE key='test.policy'")).toMatchObject({ value: 'revision-6' })
})

describe('the schema a fresh database ends up with', () => {
  it('creates every table of the schema', () => {
    expect(objectNames(migratedDb(), 'table')).toEqual(EXPECTED_TABLES)
  })
})

describe('the indexes a fresh database ends up with', () => {
  it('creates every index of the schema', () => {
    expect(objectNames(migratedDb(), 'index')).toEqual([
      'agent_mail_bindings_one_open',
      'agent_mail_messages_expiry',
      'agent_mail_messages_pending',
      'agent_mail_messages_retained',
      'agent_mail_receipts_expiry',
      'agent_mail_receipts_sender_expiry',
      'attachments_owner',
      'attempts_one_open_per_ticket',
      'attempts_run_state',
      'comments_epic_ticket',
      'correction_links_epic',
      'correction_links_experiment',
      'delivery_checks_run',
      'events_epic',
      'events_run',
      'experiment_events_run',
      'grants_active',
      'kanban_attempts_one_open_per_card',
      'kanban_cards_open_lanes',
      'kanban_events_card',
      'learning_events_learning',
      'learning_integrations_one_open_per_card',
      'learning_records_replaced_once',
      'learning_records_source',
      'learning_records_state',
      'metric_observations_attempt',
      'metric_observations_epic',
      'metric_observations_recorded',
      'metric_observations_run',
      'outbox_state',
      'plan_revisions_epic',
      'row_checks_run',
      'runs_one_active_per_epic',
      'save_permission_grant',
      'save_permission_session',
      'ticket_status_epic',
      'yolo_audit_run'
    ])
  })
})

describe('migrate when already current', () => {
  it('is a no-op the second time', () => {
    const db = migratedDb()
    expect(migrate(db)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION })
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)
  })

  it('checks a current database without taking the write lock, which every open and mailbox poll would wait on', () => {
    const db = migratedDb()
    let transactions = 0
    const watched = new Proxy(db, {
      get(target, name, receiver) {
        const member: unknown = Reflect.get(target, name, receiver)
        if (typeof member !== 'function') {
          return member
        }
        return (...args: unknown[]) => {
          transactions += name === 'tx' ? 1 : 0
          return Reflect.apply(member, target, args)
        }
      }
    })
    expect(migrate(watched)).toEqual({ from: SCHEMA_VERSION, to: SCHEMA_VERSION })
    expect(transactions).toBe(0)
    // Positive control: a database behind the target still migrates under the lock.
    watched.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`)
    expect(migrate(watched, MIGRATIONS.filter(migration => migration.version !== SCHEMA_VERSION).concat({ version: SCHEMA_VERSION, sql: '' }))).toEqual({ from: SCHEMA_VERSION - 1, to: SCHEMA_VERSION })
    expect(transactions).toBe(1)
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
      `Database schema v${SCHEMA_VERSION + 1} is newer than this build supports (v${SCHEMA_VERSION}). Update Dark Mechanicus.`
    )
    expect((error as DomainError).details).toEqual({ found: SCHEMA_VERSION + 1, supported: SCHEMA_VERSION })
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION + 1)
    expect(objectNames(db, 'table')).toEqual([])
  })

  it('refuses a migrated database that a newer build has upgraded', () => {
    const db = migratedDb()
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`)
    const error = thrownBy(() => migrate(db))
    expect((error as DomainError).code).toBe('incompatible_schema')
    expect((error as DomainError).details).toEqual({ found: SCHEMA_VERSION + 1, supported: SCHEMA_VERSION })
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
    expect(migrate(db)).toEqual({ from: 1, to: SCHEMA_VERSION })
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
    expect(migrate(db)).toEqual({ from: 2, to: SCHEMA_VERSION })
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
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION })
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
    ['sessions.role', "INSERT INTO sessions (id, role, label, capabilities_json, transport, started_at, last_seen_at) VALUES ('s1', 'admin', 'l', '[]', 'stdio', 't', 't')"],
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

  it.each(['desktop', 'planner', 'orchestrator', 'worker', 'reviewer', 'reader'])(
    'accepts the session role %s',
    (role) => {
      const db = migratedDb()
      expect(() =>
        db.run("INSERT INTO sessions (id, role, label, capabilities_json, transport, started_at, last_seen_at) VALUES (?, ?, 'l', '[]', 'stdio', 't', 't')", `ss_${role}`, role)
      ).not.toThrow()
    }
  )

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
    expect(migrate(db)).toEqual({ from: 4, to: SCHEMA_VERSION })
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

function insertDeliveryCheckRow(db: Db, spec: { id: string; number?: number; runId?: string; kind?: string }): void {
  db.run(
    `INSERT INTO delivery_checks (id, run_id, number, sprint_id, kind, commit_ref, release_tag, verdict_json, recorded_by, created_at)
     VALUES (?, ?, ?, 'sp1', ?, NULL, NULL, '{}', NULL, 't')`,
    spec.id,
    spec.runId ?? 'rn1',
    spec.number ?? 1,
    spec.kind ?? 'check'
  )
}

describe('schema v38 trusted epic and role of mail endpoints', () => {
  it('upgrades a v37 database, adding nullable epic_id and chat_role and keeping every endpoint as it was', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 37))
    insertMailEndpoint(db, 'me1')
    insertMailEndpoint(db, 'me2')
    db.run("UPDATE agent_mail_endpoints SET last_seq = 3, human_seen_seq = 2, state = 'suspended' WHERE id = 'me2'")
    expect(columnsOf(db, 'agent_mail_endpoints')).not.toContain('epic_id')

    // Named columns: a later migration (v39) changes the schema again, and a cached SELECT * may keep the old columns.
    expectAdditiveUpgrade(db, 37, { agent_mail_endpoints: { epic_id: null, chat_role: null } })
  })

  it('stores an epic and a chat role, and refuses a role a chat cannot run as', () => {
    const db = freshDb()
    migrate(db)
    insertMailEndpoint(db, 'me1')
    db.run("UPDATE agent_mail_endpoints SET epic_id = 'ep1', chat_role = 'planner' WHERE id = 'me1'")
    expect(db.get('SELECT epic_id, chat_role FROM agent_mail_endpoints')).toEqual({ epic_id: 'ep1', chat_role: 'planner' })
    expect(() => db.run("UPDATE agent_mail_endpoints SET chat_role = 'desktop' WHERE id = 'me1'")).toThrow(/CHECK constraint failed/)
  })
})

describe('schema v37 delivery checks', () => {
  it('upgrades a v36 database, keeping its runs and adding an empty delivery_checks table and its index', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 36))
    insertEpic(db, 'ep1')
    insertRevision(db, 'rv1', 'ep1')
    insertRun(db, { id: 'rn1', state: 'running' })
    expect(objectNames(db, 'table')).not.toContain('delivery_checks')
    expect(migrate(db)).toEqual({ from: 36, to: SCHEMA_VERSION })
    expect(db.all('SELECT id FROM runs')).toEqual([{ id: 'rn1' }])
    expect(db.all('SELECT * FROM delivery_checks')).toEqual([])
    expect(objectNames(db, 'index')).toContain('delivery_checks_run')
  })

  it('keeps a check and a waiver with their run, sprint, number, commit, release, verdict, author and time', () => {
    const db = attemptsDb()
    db.run(
      `INSERT INTO delivery_checks (id, run_id, number, sprint_id, kind, commit_ref, release_tag, verdict_json, recorded_by, created_at)
       VALUES ('dv1', 'rn1', 1, 'sp1', 'check', 'abcdef1', 'v1.2.0', '{"checks":[]}', 'server', 't')`
    )
    insertDeliveryCheckRow(db, { id: 'dv2', number: 2, kind: 'waiver' })
    const columns = 'id, run_id, number, sprint_id, kind, commit_ref, release_tag, verdict_json, recorded_by, created_at'
    expect(db.all(`SELECT ${columns} FROM delivery_checks ORDER BY number`).map((row) => Object.values(row as object))).toEqual([
      ['dv1', 'rn1', 1, 'sp1', 'check', 'abcdef1', 'v1.2.0', '{"checks":[]}', 'server', 't'],
      ['dv2', 'rn1', 2, 'sp1', 'waiver', null, null, '{}', null, 't']
    ])
  })

  it('refuses a kind other than check or waiver, and numbers below 1', () => {
    const db = attemptsDb()
    expect(() => insertDeliveryCheckRow(db, { id: 'dv1', kind: 'other' })).toThrow(/CHECK constraint failed/)
    expect(() => insertDeliveryCheckRow(db, { id: 'dv2', number: 0 })).toThrow(/CHECK constraint failed/)
    expect(db.all('SELECT id FROM delivery_checks')).toEqual([])
  })

  it('rejects a second record with the same id or the same number in a run, and a missing run', () => {
    const db = attemptsDb()
    insertDeliveryCheckRow(db, { id: 'dv1' })
    expect(() => insertDeliveryCheckRow(db, { id: 'dv1', number: 2 })).toThrow(/UNIQUE constraint failed: delivery_checks.id/)
    expect(() => insertDeliveryCheckRow(db, { id: 'dv2', kind: 'waiver' })).toThrow(
      /UNIQUE constraint failed: delivery_checks.run_id, delivery_checks.number/
    )
    expect(() => insertDeliveryCheckRow(db, { id: 'dv3', runId: 'rn_missing' })).toThrow(/FOREIGN KEY constraint failed/)
    expect(() => insertDeliveryCheckRow(db, { id: 'dv4', runId: 'rn2' })).not.toThrow()
  })

  it("looks up a run's records through the (run, sprint) index", () => {
    const db = attemptsDb()
    const plan = db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT id FROM delivery_checks WHERE run_id = 'rn1' AND sprint_id = 'sp1'")
    expect(plan.map((row) => row.detail).join(' ')).toContain('USING INDEX delivery_checks_run')
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
    expect(migrate(db)).toEqual({ from: 5, to: SCHEMA_VERSION })
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

describe('schema v7 report plan revisions', () => {
  it('upgrades a v6 database, keeping its reports and leaving their plan revision unknown', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 6))
    insertEpic(db, 'ep1')
    insertRevision(db, 'rv1', 'ep1')
    insertRun(db, { id: 'rn1', state: 'awaiting_checkpoint' })
    db.run(
      `INSERT INTO sprint_reports (id, run_id, sprint_id, report_revision, content_json, content_hash, created_at)
       VALUES ('rp1', 'rn1', 'sp1', 1, '{}', 'h', 't')`
    )
    expect(migrate(db)).toEqual({ from: 6, to: SCHEMA_VERSION })
    expect(db.all('SELECT id, revision_id FROM sprint_reports')).toEqual([{ id: 'rp1', revision_id: null }])
  })

  it('keeps the plan revision a report was written for', () => {
    const db = attemptsDb()
    db.run(
      `INSERT INTO sprint_reports (id, run_id, sprint_id, report_revision, content_json, content_hash, created_at, revision_id)
       VALUES ('rp1', 'rn1', 'sp1', 1, '{}', 'h', 't', 'rv1')`
    )
    expect(db.get('SELECT revision_id FROM sprint_reports WHERE id = ?', 'rp1')).toEqual({ revision_id: 'rv1' })
  })
})

describe('schema v8 run pause time', () => {
  it('upgrades a v7 database, keeping its paused runs and leaving their pause time unknown', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 7))
    insertEpic(db, 'ep1')
    insertRevision(db, 'rv1', 'ep1')
    insertRun(db, { id: 'rn1', state: 'paused' })
    expect(migrate(db)).toEqual({ from: 7, to: SCHEMA_VERSION })
    expect(db.all('SELECT id, state, paused_at FROM runs')).toEqual([{ id: 'rn1', state: 'paused', paused_at: null }])
  })

  it('keeps the time a run was paused', () => {
    const db = attemptsDb()
    db.run("UPDATE runs SET paused_at = '2026-01-01T00:00:00.000Z' WHERE id = 'rn1'")
    expect(db.get('SELECT paused_at FROM runs WHERE id = ?', 'rn1')).toEqual({ paused_at: '2026-01-01T00:00:00.000Z' })
  })
})

describe('schema v11 Linear transfers', () => {
  function insertTransfer(db: Db, status = 'queued'): void {
    db.run(
      `INSERT INTO transfers (epic_id, target, status, revision_id, packet_hash, packet_json, queued_by, queued_at, updated_at)
       VALUES ('ep1', 'linear', ?, 'rv1', 'sha256:p', '{}', 'ss1', 't', 't')`,
      status
    )
  }

  it('upgrades a v9 database through the v10 scrub, keeping its epics and adding empty transfer tables', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 9))
    insertEpic(db, 'ep1')
    insertRevision(db, 'rv1', 'ep1')
    db.run("INSERT INTO idempotency (command, key, request_hash, response_json, created_at) VALUES ('claimTicket', 'claim-1', 'h', ?, 't')", '{"packet":{"claimToken":"at_1.secret-1"}}')
    expect(migrate(db)).toEqual({ from: 9, to: SCHEMA_VERSION })
    expect(db.get('SELECT response_json FROM idempotency')).toEqual({ response_json: '{"packet":{"claimToken":null}}' })
    expect(db.all('SELECT id FROM epics')).toEqual([{ id: 'ep1' }])
    expect(db.all('SELECT * FROM transfers')).toEqual([])
    expect(db.all('SELECT * FROM transfer_items')).toEqual([])
    insertTransfer(db)
    expect(db.get('SELECT status, target FROM transfers')).toEqual({ status: 'queued', target: 'linear' })
  })

  it('keeps one transfer per epic and one item per ref, and rejects unknown statuses and kinds', () => {
    const db = migratedDb()
    insertEpic(db, 'ep1')
    insertRevision(db, 'rv1', 'ep1')
    expect(() => insertTransfer(db, 'sent')).toThrow(/CHECK constraint failed/)
    insertTransfer(db)
    expect(() => insertTransfer(db)).toThrow(/UNIQUE constraint failed: transfers.epic_id/)
    const item = "INSERT INTO transfer_items (epic_id, ref, kind, linear_id, recorded_at) VALUES (?, 'project', ?, 'lin1', 't')"
    db.run(item, 'ep1', 'project')
    expect(() => db.run(item, 'ep1', 'project')).toThrow(/UNIQUE constraint failed: transfer_items.epic_id, transfer_items.ref/)
    expect(() => db.run(item.replace("'project'", "'other'"), 'ep1', 'comment')).toThrow(/CHECK constraint failed/)
    expect(() => db.run(item, 'ep_missing', 'project')).toThrow(/FOREIGN KEY constraint failed/)
  })
})

describe('schema v11 on top of the v10 scrub', () => {
  it("upgrades a database main's v10 scrub left, adding the transfer tables and leaving stored responses untouched", () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 10))
    expect(readSchemaVersion(db)).toBe(10)
    expect(objectNames(db, 'table')).not.toContain('transfers')
    const stored = '{ "packet": {"claimToken": "at_1.secret-1"} }'
    db.run("INSERT INTO idempotency (command, key, request_hash, response_json, created_at) VALUES ('claimTicket', 'claim-1', 'h', ?, 't')", stored)
    expect(migrate(db)).toEqual({ from: 10, to: SCHEMA_VERSION })
    expect(objectNames(db, 'table')).toEqual(expect.arrayContaining(['transfers', 'transfer_items']))
    expect(db.get('SELECT response_json FROM idempotency')).toEqual({ response_json: stored })
  })

  it('brings a fresh database straight to the latest version with the transfer tables', () => {
    const db = freshDb()
    expect(migrate(db)).toEqual({ from: 0, to: SCHEMA_VERSION })
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)
    expect(objectNames(db, 'table')).toEqual(expect.arrayContaining(['transfers', 'transfer_items']))
  })
})

describe('schema v10 scrubs secrets from stored responses', () => {
  const token = 'at_01j8z3k5m7n9p2q4r6s8t0v1w2.Zk9_aB3dEf7-Hj2LmN5pQr8TuVw0XyZa'

  function v9Db(rows: [command: string, key: string, response: string][]): Db {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 9))
    for (const [command, key, response] of rows) {
      db.run("INSERT INTO idempotency (command, key, request_hash, response_json, created_at) VALUES (?, ?, 'h', ?, 't')", command, key, response)
    }
    return db
  }

  function storedResponses(db: Db): Record<string, string> {
    const rows = db.all<{ key: string; response_json: string }>('SELECT key, response_json FROM idempotency ORDER BY key')
    return Object.fromEntries(rows.map((row) => [row.key, row.response_json]))
  }

  it('nulls the claim token a stored claim kept in plaintext and masks tokens pasted into other responses', () => {
    const claim = JSON.stringify({ attempt: { id: 'at_1', fencingToken: 1 }, packet: { claimToken: 'at_1.secret-1', fencingToken: 1 } })
    const db = v9Db([
      ['claimTicket', 'claim-1', claim],
      ['submitAttempt', 'submit-1', JSON.stringify({ outputs: { summary: `token ${token}` } })]
    ])
    expect(migrate(db)).toEqual({ from: 9, to: SCHEMA_VERSION })
    expect(storedResponses(db)).toEqual({
      'claim-1': '{"attempt":{"id":"at_1","fencingToken":1},"packet":{"claimToken":null,"fencingToken":1}}',
      'submit-1': '{"outputs":{"summary":"token [claim token masked]"}}'
    })
  })

  it('leaves responses with no secret byte for byte as they were', () => {
    const plain = '{ "epicId": "ep_1",  "list": [1, 2] }'
    const db = v9Db([['createEpic', 'create-1', plain]])
    migrate(db)
    expect(storedResponses(db)).toEqual({ 'create-1': plain })
  })

  it('drops a stored response it cannot read, rather than keep what it cannot check', () => {
    const db = v9Db([
      ['claimTicket', 'broken', '{"packet":{"claimToken":"at_1.secret-1"'],
      ['createEpic', 'create-1', '{"epicId":"ep_1"}']
    ])
    migrate(db)
    expect(storedResponses(db)).toEqual({ 'create-1': '{"epicId":"ep_1"}' })
  })
})

describe('schema v12 epic branches per repository', () => {
  it('adds a nullable repository_branches_json to epics and keeps existing epics with none', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 11))
    insertEpic(db, 'ep1')
    expect(migrate(db, MIGRATIONS.filter((migration) => migration.version <= 12))).toEqual({ from: 11, to: 12 })
    expect(db.all('SELECT id, repository_branches_json FROM epics')).toEqual([{ id: 'ep1', repository_branches_json: null }])
    db.run("UPDATE epics SET repository_branches_json = '[]' WHERE id = 'ep1'")
    expect(db.get('SELECT repository_branches_json FROM epics')).toEqual({ repository_branches_json: '[]' })
  })
})

function v12Db(): Db {
  const db = freshDb()
  migrate(db, MIGRATIONS.filter((migration) => migration.version <= 12))
  return db
}

function insertKanbanCard(db: Db, id: string, key: string, lane = 'backlog'): void {
  db.run(
    `INSERT INTO kanban_cards (id, key, title, body, acceptance_criteria_json, expected_artifacts_json, references_json,
       priority, size, lane, created_by_role, created_by_label, created_at, updated_at, revision)
     VALUES (?, ?, 'Card', '', '[]', '[]', '[]', 'normal', NULL, ?, 'desktop', 'Ada', 't', 't', 1)`,
    id,
    key,
    lane
  )
}

function insertKanbanAttempt(db: Db, spec: { id: string; number: number; state: string; cardId?: string }): void {
  db.run(
    `INSERT INTO kanban_attempts (id, card_id, number, state, claim_secret, machine_id, created_at)
     VALUES (?, ?, ?, ?, 'secret', 'mc1', 't')`,
    spec.id,
    spec.cardId ?? 'kc1',
    spec.number,
    spec.state
  )
}

function kanbanDb(): Db {
  const db = migratedDb()
  insertKanbanCard(db, 'kc1', 'DM-1')
  insertKanbanCard(db, 'kc2', 'DM-2')
  return db
}

describe('schema v13 kanban', () => {
  it('upgrades a v12 database, keeping every outbox and sync state row and the outbox id sequence', () => {
    const db = v12Db()
    db.run(
      `INSERT INTO outbox (kind, epic_id, run_id, revision_id, entity_id, state, attempts, last_error, created_at)
       VALUES ('snapshot', 'ep1', NULL, 'rv1', NULL, 'pending', 0, NULL, 't'),
              ('profile', NULL, NULL, NULL, 'fast', 'failed', 2, 'disk full', 't'),
              ('comment', 'ep1', NULL, NULL, 'cm1', 'done', 1, NULL, 't')`
    )
    db.run('DELETE FROM outbox WHERE id = 3')
    db.run(
      `INSERT INTO sync_state (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
       VALUES ('epic', 'ep1', 'sha256:a', 4, 'sha256:b', 'diverged', 't1'), ('profile', 'fast', NULL, 0, NULL, NULL, 't2')`
    )
    expect(objectNames(db, 'table')).not.toContain('kanban_cards')
    expect(migrate(db)).toEqual({ from: 12, to: SCHEMA_VERSION })
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)
    expect(outboxRows(db)).toEqual([
      { id: 1, kind: 'snapshot', epic_id: 'ep1', run_id: null, revision_id: 'rv1', entity_id: null, state: 'pending', attempts: 0, last_error: null },
      { id: 2, kind: 'profile', epic_id: null, run_id: null, revision_id: null, entity_id: 'fast', state: 'failed', attempts: 2, last_error: 'disk full' }
    ])
    expect(db.all('SELECT * FROM sync_state ORDER BY kind')).toEqual([
      { kind: 'epic', entity_id: 'ep1', exported_hash: 'sha256:a', generation: 4, imported_hash: 'sha256:b', conflict: 'diverged', updated_at: 't1' },
      { kind: 'profile', entity_id: 'fast', exported_hash: null, generation: 0, imported_hash: null, conflict: null, updated_at: 't2' }
    ])
    // The id deleted before the upgrade is never handed out again.
    expect(db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES ('kanban_card', 'kc1', 'pending', 't')").lastInsertRowid).toBe(4)
    expect(objectNames(db, 'index')).toContain('outbox_state')
    expect(objectNames(db, 'table')).toEqual(expect.arrayContaining(['kanban_attempts', 'kanban_cards', 'kanban_events']))
  })

  it.each(['kanban_card', 'kanban_event'])('accepts outbox entries and sync state of kind %s', (kind) => {
    const db = migratedDb()
    db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES (?, 'kc1', 'pending', 't')", kind)
    db.run("INSERT INTO sync_state (kind, entity_id, updated_at) VALUES (?, 'kc1', 't')", kind)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox WHERE kind = ?', kind)?.n).toBe(1)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_state WHERE kind = ?', kind)?.n).toBe(1)
  })

  it('still rejects an unknown outbox or sync state kind', () => {
    const db = migratedDb()
    expect(() => db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES ('kanban_board', 'x', 'pending', 't')")).toThrow(
      /CHECK constraint failed/
    )
    expect(() => db.run("INSERT INTO sync_state (kind, entity_id, updated_at) VALUES ('kanban_board', 'x', 't')")).toThrow(
      /CHECK constraint failed/
    )
  })
})

describe('schema v13 kanban tables', () => {
  it('accepts only the four lanes and refuses a duplicate key', () => {
    const db = kanbanDb()
    for (const lane of ['in_progress', 'ready_for_review', 'done']) {
      insertKanbanCard(db, `kc_${lane}`, `DM-${lane}`, lane)
    }
    expect(() => insertKanbanCard(db, 'kc9', 'DM-9', 'archived')).toThrow(/CHECK constraint failed/)
    expect(() => insertKanbanCard(db, 'kc10', 'DM-1')).toThrow(/UNIQUE constraint failed/)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM kanban_cards')?.n).toBe(5)
  })

  it.each(['claimed', 'running', 'submitted'])('rejects a second open attempt for a card while the first is %s', (state) => {
    const db = kanbanDb()
    insertKanbanAttempt(db, { id: 'ka1', number: 1, state })
    expect(() => insertKanbanAttempt(db, { id: 'ka2', number: 2, state: 'claimed' })).toThrow(/UNIQUE constraint failed/)
  })

  it.each(['accepted', 'rejected', 'failed', 'lease_expired'])('allows a new attempt after the previous one is %s', (state) => {
    const db = kanbanDb()
    insertKanbanAttempt(db, { id: 'ka1', number: 1, state })
    insertKanbanAttempt(db, { id: 'ka2', number: 2, state: 'claimed' })
    insertKanbanAttempt(db, { id: 'ka3', number: 1, state: 'claimed', cardId: 'kc2' })
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM kanban_attempts')?.n).toBe(3)
  })

  it('never reuses an attempt number on a card, and refuses unknown states and cards', () => {
    const db = kanbanDb()
    insertKanbanAttempt(db, { id: 'ka1', number: 1, state: 'failed' })
    expect(() => insertKanbanAttempt(db, { id: 'ka2', number: 1, state: 'claimed' })).toThrow(/UNIQUE constraint failed/)
    expect(() => insertKanbanAttempt(db, { id: 'ka3', number: 2, state: 'canceled' })).toThrow(/CHECK constraint failed/)
    expect(() => insertKanbanAttempt(db, { id: 'ka4', number: 1, state: 'claimed', cardId: 'kc404' })).toThrow(
      /FOREIGN KEY constraint failed/
    )
  })
})

describe('schema v13 kanban events', () => {
  it('ties events to an existing card and lists them through the (card, time, id) index', () => {
    const db = kanbanDb()
    const insertEvent = (id: string, cardId: string, at: string): void => {
      db.run(
        `INSERT INTO kanban_events (id, card_id, kind, attempt_id, actor_role, actor_label, payload_json, created_at)
         VALUES (?, ?, 'kanban.created', NULL, 'desktop', 'Ada', '{}', ?)`,
        id,
        cardId,
        at
      )
    }
    insertEvent('ke2', 'kc1', 't2')
    insertEvent('ke1', 'kc1', 't1')
    insertEvent('ke3', 'kc2', 't0')
    expect(() => insertEvent('ke4', 'kc404', 't3')).toThrow(/FOREIGN KEY constraint failed/)
    const plan = db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT id FROM kanban_events WHERE card_id = 'kc1' ORDER BY created_at, id")
    expect(plan.map((row) => row.detail).join(' ')).toContain('kanban_events_card')
    expect(db.all("SELECT id FROM kanban_events WHERE card_id = 'kc1' ORDER BY created_at, id")).toEqual([{ id: 'ke1' }, { id: 'ke2' }])
  })
})

function v13Db(): Db {
  const db = freshDb()
  migrate(db, MIGRATIONS.filter((migration) => migration.version <= 13))
  return db
}

const ATTACHMENT_COLUMNS = `id, sha256, mime, bytes, width, height, label, purpose, owner_kind, owner_id, missing, data,
  created_by_role, created_by_label, created_at`

function insertAttachment(db: Db, id: string, owner: { kind: string; id: string } | null = null): void {
  db.run(
    `INSERT INTO attachments (${ATTACHMENT_COLUMNS})
     VALUES (?, ?, 'image/png', 4, 1, 1, 'shot', 'evidence', ?, ?, 0, x'89504e47', 'worker', 'test worker', 't')`,
    id,
    'a'.repeat(64),
    owner?.kind ?? null,
    owner?.id ?? null
  )
}

describe('schema v14 attachments', () => {
  it('upgrades a v13 database, keeping every outbox and sync state row and the outbox id sequence', () => {
    const db = v13Db()
    db.run(
      `INSERT INTO outbox (kind, epic_id, run_id, revision_id, entity_id, state, attempts, last_error, created_at)
       VALUES ('snapshot', 'ep1', NULL, 'rv1', NULL, 'pending', 0, NULL, 't'),
              ('kanban_card', NULL, NULL, NULL, 'kc1', 'failed', 3, 'disk full', 't'),
              ('comment', 'ep1', NULL, NULL, 'cm1', 'done', 1, NULL, 't')`
    )
    db.run('DELETE FROM outbox WHERE id = 3')
    db.run(
      `INSERT INTO sync_state (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
       VALUES ('epic', 'ep1', 'sha256:a', 4, 'sha256:b', 'diverged', 't1'), ('kanban_event', 'ke1', NULL, 0, NULL, NULL, 't2')`
    )
    expect(objectNames(db, 'table')).not.toContain('attachments')
    expect(migrate(db)).toEqual({ from: 13, to: SCHEMA_VERSION })
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION)
    expect(outboxRows(db)).toEqual([
      { id: 1, kind: 'snapshot', epic_id: 'ep1', run_id: null, revision_id: 'rv1', entity_id: null, state: 'pending', attempts: 0, last_error: null },
      { id: 2, kind: 'kanban_card', epic_id: null, run_id: null, revision_id: null, entity_id: 'kc1', state: 'failed', attempts: 3, last_error: 'disk full' }
    ])
    expect(db.all('SELECT * FROM sync_state ORDER BY kind')).toEqual([
      { kind: 'epic', entity_id: 'ep1', exported_hash: 'sha256:a', generation: 4, imported_hash: 'sha256:b', conflict: 'diverged', updated_at: 't1' },
      { kind: 'kanban_event', entity_id: 'ke1', exported_hash: null, generation: 0, imported_hash: null, conflict: null, updated_at: 't2' }
    ])
    // The id deleted before the upgrade is never handed out again.
    expect(db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES ('attachment', 'im1', 'pending', 't')").lastInsertRowid).toBe(4)
    expect(objectNames(db, 'index')).toEqual(expect.arrayContaining(['outbox_state', 'attachments_owner']))
  })

})

describe('schema v14 attachment records', () => {
  it('accepts outbox entries and sync state of kind attachment, and still rejects an unknown kind', () => {
    const db = migratedDb()
    db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES ('attachment', 'im1', 'pending', 't')")
    db.run("INSERT INTO sync_state (kind, entity_id, updated_at) VALUES ('attachment', 'im1', 't')")
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'attachment'")?.n).toBe(1)
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM sync_state WHERE kind = 'attachment'")?.n).toBe(1)
    expect(() => db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES ('image', 'x', 'pending', 't')")).toThrow(
      /CHECK constraint failed/
    )
  })

  it('stores a staged attachment with no owner and refuses an owner without an id', () => {
    const db = migratedDb()
    insertAttachment(db, 'im1')
    expect(() => db.run("UPDATE attachments SET owner_kind = 'comment' WHERE id = 'im1'")).toThrow(/CHECK constraint failed/)
    expect(() => insertAttachment(db, 'im2', { kind: 'svg', id: 'x' })).toThrow(/CHECK constraint failed/)
    expect(() => db.run("UPDATE attachments SET mime = 'image/svg+xml' WHERE id = 'im1'")).toThrow(/CHECK constraint failed/)
  })

  it('lists the attachments of one owner through the (owner_kind, owner_id) index', () => {
    const db = migratedDb()
    insertAttachment(db, 'im1', { kind: 'attempt', id: 'at1' })
    const plan = db.all<{ detail: string }>("EXPLAIN QUERY PLAN SELECT id FROM attachments WHERE owner_kind = 'attempt' AND owner_id = 'at1'")
    expect(plan.map((row) => row.detail).join(' ')).toContain('attachments_owner')
  })
})

describe('schema v22 Kanban message attachments', () => {
  it('upgrades the v21 schema without losing existing attachments or the owner index', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 21))
    insertAttachment(db, 'im1', { kind: 'comment', id: 'cm1' })
    insertAttachment(db, 'im2')
    const previous = db.all('SELECT * FROM attachments ORDER BY id')
    expect(() => insertAttachment(db, 'im3', { kind: 'kanban_message', id: 'ke1' })).toThrow(/CHECK constraint failed/)

    expect(migrate(db, MIGRATIONS.filter((migration) => migration.version <= 22))).toEqual({ from: 21, to: 22 })
    expect(db.all('SELECT * FROM attachments ORDER BY id')).toEqual(previous)
    insertAttachment(db, 'im3', { kind: 'kanban_message', id: 'ke1' })
    expect(db.get<{ owner_kind: string; owner_id: string }>('SELECT owner_kind, owner_id FROM attachments WHERE id = ?', 'im3')).toEqual({
      owner_kind: 'kanban_message',
      owner_id: 'ke1'
    })
    expect(objectNames(db, 'index')).toContain('attachments_owner')
  })
})

function v14Db(): Db {
  const db = freshDb()
  migrate(db, MIGRATIONS.filter((migration) => migration.version <= 14))
  return db
}

/** A v14 project with records of several kinds, as a build before agent mail left it. */
function v14Project(): Db {
  const db = v14Db()
  insertEpic(db, 'ep1')
  insertComment(db, { id: 'cm1' })
  insertAttachment(db, 'im1', { kind: 'comment', id: 'cm1' })
  db.run("INSERT INTO meta (key, value) VALUES ('projectId', 'pj1')")
  db.run("INSERT INTO outbox (kind, epic_id, entity_id, state, created_at) VALUES ('comment', 'ep1', 'cm1', 'pending', 't')")
  return db
}

function projectRecords(db: Db): unknown {
  return {
    epics: db.all('SELECT id, title FROM epics'),
    comments: db.all('SELECT id, body FROM comments'),
    attachments: db.all('SELECT id, owner_kind, owner_id, data FROM attachments'),
    meta: db.all("SELECT key, value FROM meta WHERE key = 'projectId'"),
    outbox: outboxRows(db)
  }
}

const ENDPOINT_COLUMNS = 'id, machine_id, chat_id, name, state, created_at, updated_at'

function insertMailEndpoint(db: Db, id: string, chatId = id): void {
  db.run(`INSERT INTO agent_mail_endpoints (${ENDPOINT_COLUMNS}) VALUES (?, 'mc1', ?, 'Chat', 'open', 't', 't')`, id, chatId)
}

function insertMailMessage(db: Db, spec: { id: string; to: string; from: string; seq: number; inReplyTo?: string }): void {
  db.run(
    `INSERT INTO agent_mail_messages (id, recipient_endpoint_id, recipient_seq, sender_endpoint_id, client_message_id, in_reply_to,
       body, body_bytes, accepted_at)
     VALUES (?, ?, ?, ?, ?, ?, 'hi', 2, 't')`,
    spec.id,
    spec.to,
    spec.seq,
    spec.from,
    `client-${spec.id}`,
    spec.inReplyTo ?? null
  )
}

describe('schema v15 agent mail', () => {
  it('upgrades a v14 project, keeping every record and adding empty mail tables', () => {
    const db = v14Project()
    const before = projectRecords(db)
    expect(objectNames(db, 'table')).not.toContain('agent_mail_messages')
    expect(migrate(db)).toEqual({ from: 14, to: SCHEMA_VERSION })
    expect(projectRecords(db)).toEqual(before)
    for (const table of ['agent_mail_endpoints', 'agent_mail_bindings', 'agent_mail_messages', 'agent_mail_receipts']) {
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n).toBe(0)
    }
  })

  it('rolls the whole upgrade back when a later migration of the same run fails, leaving the v14 project as it was', () => {
    const db = v14Project()
    const before = projectRecords(db)
    const broken = { version: SCHEMA_VERSION + 1, sql: 'INSERT INTO missing VALUES (1)' }
    expect(() => migrate(db, [...MIGRATIONS, broken])).toThrow(/no such table/)
    expect(readSchemaVersion(db)).toBe(14)
    expect(objectNames(db, 'table').filter((name) => name.startsWith('agent_mail_'))).toEqual([])
    expect(projectRecords(db)).toEqual(before)
    expect(migrate(db)).toEqual({ from: 14, to: SCHEMA_VERSION })
  })
})

describe('schema v15 agent mail constraints', () => {
  it('gives no outbox or sync state kind to mail, so no row can ever be exported', () => {
    const db = migratedDb()
    for (const kind of ['agent_mail', 'mail_message', 'message']) {
      expect(() => db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES (?, 'x', 'pending', 't')", kind)).toThrow(/CHECK constraint failed/)
      expect(() => db.run("INSERT INTO sync_state (kind, entity_id, updated_at) VALUES (?, 'x', 't')", kind)).toThrow(/CHECK constraint failed/)
    }
  })

  it('keeps endpoint identity, recipient sequence and sender-scoped client ids unique', () => {
    const db = migratedDb()
    insertMailEndpoint(db, 'me1')
    insertMailEndpoint(db, 'me2')
    expect(() => insertMailEndpoint(db, 'me3', 'me1')).toThrow(/UNIQUE constraint failed/)
    insertMailMessage(db, { id: 'mm1', to: 'me2', from: 'me1', seq: 1 })
    expect(() => insertMailMessage(db, { id: 'mm2', to: 'me2', from: 'me1', seq: 1 })).toThrow(/UNIQUE constraint failed/)
    insertMailMessage(db, { id: 'mm3', to: 'me1', from: 'me2', seq: 1 })
    const receipt = `INSERT INTO agent_mail_receipts (sender_endpoint_id, client_message_id, payload_hash, result_json, accepted_at, expires_at)
      VALUES (?, 'same', 'h', '{}', 't', 'u')`
    db.run(receipt, 'me1')
    db.run(receipt, 'me2')
    expect(() => db.run(receipt, 'me1')).toThrow(/UNIQUE constraint failed/)
  })

  it('allows one open binding per endpoint and one binding per grant', () => {
    const db = migratedDb()
    insertMailEndpoint(db, 'me1')
    const bind = `INSERT INTO agent_mail_bindings (grant_id, endpoint_id, machine_id, canonical_folder, bound_at) VALUES (?, 'me1', 'mc1', '/p', 't')`
    db.run(bind, 'gr1')
    expect(() => db.run(bind, 'gr2')).toThrow(/UNIQUE constraint failed/)
    db.run("UPDATE agent_mail_bindings SET closed_at = 't', close_reason = 'replaced' WHERE grant_id = 'gr1'")
    db.run(bind, 'gr2')
    expect(() => db.run(bind, 'gr1')).toThrow(/UNIQUE constraint failed/)
    expect(() => db.run("UPDATE agent_mail_bindings SET closed_at = 't' WHERE grant_id = 'gr2'")).toThrow(/CHECK constraint failed/)
  })

  it('never cascades a purge across mailboxes, and sets an expiry only with an acknowledgement', () => {
    const db = migratedDb()
    insertMailEndpoint(db, 'me1')
    insertMailEndpoint(db, 'me2')
    insertMailMessage(db, { id: 'mm1', to: 'me2', from: 'me1', seq: 1 })
    insertMailMessage(db, { id: 'mm2', to: 'me1', from: 'me2', seq: 1, inReplyTo: 'mm1' })
    db.run("DELETE FROM agent_mail_messages WHERE recipient_endpoint_id = 'me2'")
    expect(db.all('SELECT id, in_reply_to FROM agent_mail_messages')).toEqual([{ id: 'mm2', in_reply_to: 'mm1' }])
    expect(() => db.run("UPDATE agent_mail_messages SET expires_at = 't' WHERE id = 'mm2'")).toThrow(/CHECK constraint failed/)
    expect(() => db.run("DELETE FROM agent_mail_endpoints WHERE id = 'me2'")).toThrow(/FOREIGN KEY constraint failed/)
  })
})

/** The last schema released before the SPACE ledger: a v14 project with agent mail and an armed wake on top. */
function v16MailProject(): Db {
  const db = v14Project()
  migrate(db, MIGRATIONS.filter((migration) => migration.version <= 16))
  insertMailEndpoint(db, 'me1')
  insertMailEndpoint(db, 'me2')
  insertMailMessage(db, { id: 'mm1', to: 'me2', from: 'me1', seq: 1 })
  db.run("UPDATE agent_mail_endpoints SET last_seq = 1 WHERE id = 'me2'")
  db.run("INSERT INTO agent_mail_wakes (endpoint_id, revision, armed, request_nonce, armed_at) VALUES ('me2', 1, 1, 'n1', 't')")
  return db
}

function mailRecords(db: Db): unknown {
  return {
    endpoints: db.all(`SELECT ${ENDPOINT_COLUMNS}, last_seq FROM agent_mail_endpoints ORDER BY id`),
    messages: db.all('SELECT id, recipient_endpoint_id, recipient_seq, sender_endpoint_id, body FROM agent_mail_messages ORDER BY id'),
    wakes: db.all('SELECT endpoint_id, revision, armed, request_nonce FROM agent_mail_wakes')
  }
}

describe('a v16 database (agent mail) upgraded to the SPACE ledger', () => {
  it('keeps every project and mail record and the outbox sequence, and adds the empty SPACE tables', () => {
    const db = v16MailProject()
    const before = { project: projectRecords(db), mail: mailRecords(db) }
    const outboxSeq = db.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'outbox'")?.seq
    expect(migrate(db)).toEqual({ from: 16, to: SCHEMA_VERSION })
    expect({ project: projectRecords(db), mail: mailRecords(db) }).toEqual(before)
    expect(db.get<{ seq: number }>("SELECT seq FROM sqlite_sequence WHERE name = 'outbox'")?.seq).toBe(outboxSeq)
    for (const table of ['metric_observations', 'experiment_events', 'correction_links']) {
      expect(db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n).toBe(0)
    }
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])
  })
})

describe('v23 elevation storage compatibility', () => {
  it('preserves existing grants and attachments while defaulting to no elevation', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 22))
    db.run("INSERT INTO grants (id, role, allow_save, label, token_hash, machine_id, created_at, expires_at) VALUES ('gr1', 'worker', 0, 'Existing worker', 'old-hash', 'mc1', '2026-01-01', '2027-01-01')")
    insertAttachment(db, 'old-image', { kind: 'kanban_message', id: 'ke1' })
    // Named columns: later migrations add grant columns (v39 run_save), which a cached SELECT * may or may not return.
    expectAdditiveUpgrade(db, 22, { grants: { run_save: 1 }, attachments: {} })
    expect(db.all('SELECT * FROM yolo_elevations')).toEqual([])
    expect(db.all('SELECT * FROM yolo_chat_bindings')).toEqual([])
  })

  it('refuses audit edits and deletion without changing the stored command record', () => {
    const db = migratedDb()
    db.run("INSERT INTO yolo_audit (time, grant_id, session_id, folder, capability, command, result, target_id, card_id) VALUES ('2026-01-01', 'gr1', 'ss1', '/folder', 'plan.save', 'savePlan', 'failed', 'ep1', 'kc1')")
    const before = db.all('SELECT * FROM yolo_audit')
    expect(() => db.run("UPDATE yolo_audit SET result = 'succeeded'")).toThrow('YOLO audit is append-only')
    expect(() => db.run('DELETE FROM yolo_audit')).toThrow('YOLO audit is append-only')
    expect(db.all('SELECT * FROM yolo_audit')).toEqual(before)
  })
})

describe('v24 save permission compatibility', () => {
  it('preserves explicit launch authority of existing sessions without granting save to restricted sessions', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 23))
    for (const [id, capabilities] of [['ss_saving', '["read","plan.save"]'], ['ss_restricted', '["read"]']] as const) {
      db.run("INSERT INTO sessions (id, role, label, capabilities_json, transport, started_at, last_seen_at) VALUES (?, 'orchestrator', 'Existing session', ?, 'stdio', 't', 't')", id, capabilities)
    }
    expect(migrate(db)).toEqual({ from: 23, to: SCHEMA_VERSION })
    expect(db.all('SELECT id, launch_capabilities_json FROM sessions ORDER BY id')).toEqual([
      { id: 'ss_restricted', launch_capabilities_json: '["read"]' },
      { id: 'ss_saving', launch_capabilities_json: '["read","plan.save"]' }
    ])
    expect(db.all('SELECT * FROM save_permission_requests')).toEqual([])
  })
})

const LEGACY_DIR = fileURLToPath(new URL('../repo/__mocks__/legacy/', import.meta.url))
const LEGACY_EPIC = 'ep_01m3txy30qavmd5wewct90804g'
const LEGACY_REVISION = 'rv_01m3txzpv9ws6fbj6p211ghkn9'
const LEGACY_RUN = 'rn_01m3txzt9wj79mxsq50f5ktf1q'
const LEGACY_COPIED = ['epics', 'plan_revisions', 'ticket_status', 'runs', 'attempts', 'sprint_reports', 'checkpoints',
  'kanban_cards', 'kanban_attempts', 'kanban_events', 'outbox', 'sync_state']
const LEARNING_HASH = `sha256:${'b'.repeat(64)}`

const legacyText = (...parts: string[]): string => readFileSync(join(LEGACY_DIR, ...parts), 'utf8').replace(/\r\n/g, '\n')

/**
 * A v30 database (the last released schema, whose v30 added `outbox.next_attempt_at`) holding an imported legacy run,
 * an approved Kanban card and an outbox entry waiting out its retry time, as an installed build left it.
 */
function v30WithRecords(): { db: Db; cardId: string; eventIds: string[] } {
  const source = createRepoEnv({ root: '/legacy' })
  initProject(source)
  const paths = ownedPaths(source.layout)
  source.fs.put(join(source.layout.dmDir, 'project.json'), legacyText('project.json'))
  source.fs.put(paths.epicPointerFile(LEGACY_EPIC), legacyText('epics', LEGACY_EPIC, 'current.json'))
  source.fs.put(paths.epicStateFile(LEGACY_EPIC), legacyText('epics', LEGACY_EPIC, 'state.json'))
  source.fs.put(paths.snapshotFile(LEGACY_EPIC, LEGACY_REVISION), legacyText('epics', LEGACY_EPIC, 'snapshots', `${LEGACY_REVISION}.json`))
  source.fs.put(paths.runHistoryFile(LEGACY_RUN), legacyText('history', LEGACY_RUN, 'run.json'))
  reconcileRepository(importerDeps(source, createStubGit()))
  const cardId = doneCard(kanbanSessions(source), 'Keep the upload test stable').cardId
  const db = freshDb()
  migrate(db, MIGRATIONS.filter((migration) => migration.version <= 30))
  for (const table of LEGACY_COPIED) {
    for (const row of source.db.all<Record<string, string | number | null>>(`SELECT * FROM ${table}`)) {
      const columns = Object.keys(row)
      db.run(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...columns.map((column) => row[column]))
    }
  }
  source.db.close()
  db.run(
    `INSERT INTO outbox (kind, epic_id, state, attempts, last_error, created_at, next_attempt_at)
     VALUES ('epic_state', ?, 'pending', 2, 'disk full', 't', '2026-01-01T00:00:15.000Z')`,
    LEGACY_EPIC
  )
  const eventIds = db.all<{ id: string }>('SELECT id FROM kanban_events ORDER BY id').map((row) => row.id)
  return { db, cardId, eventIds }
}

/**
 * The hashes of the plan and Kanban records. The run history is pinned to the released file's bytes after the upgrade
 * instead: building it reads `delivery_checks` (v37), which a v30 database does not have yet.
 */
function recordHashes(db: Db, cardId: string, eventIds: string[]): string[] {
  return [
    contentHash(buildSnapshotRecord(db, LEGACY_REVISION)),
    contentHash(buildKanbanCardRecord(db, cardId, { generation: 1 })),
    ...eventIds.map((eventId) => contentHash(buildKanbanEventRecord(db, eventId)))
  ]
}

function schemaOf(db: Db): unknown[] {
  return db.all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
}

function columnsOf(db: Db, table: string): string[] {
  return db.all<{ name: string }>('SELECT name FROM pragma_table_info(?) ORDER BY cid', table).map((column) => column.name)
}

function rowsOf(db: Db, table: string, columns: string[]): unknown[] {
  return db.all(`SELECT ${columns.join(', ')} FROM ${table} ORDER BY rowid`)
}

/**
 * Upgrades `db` to the current schema and checks that each table in `added` keeps every value of every column it had,
 * and gained exactly the named columns, each at its documented default in every existing row. Columns are always named:
 * a cached `SELECT *` statement returns the pre-upgrade column list on some SQLite builds and the new one on others.
 */
function expectAdditiveUpgrade(db: Db, from: number, added: Record<string, Record<string, string | number | null>>): void {
  const tables = Object.entries(added).map(([name, defaults]) => {
    const columns = columnsOf(db, name)
    return { name, defaults, columns, rows: rowsOf(db, name, columns) }
  })
  expect(migrate(db)).toEqual({ from, to: SCHEMA_VERSION })
  for (const table of tables) {
    expect(rowsOf(db, table.name, table.columns)).toEqual(table.rows)
    const fresh = Object.keys(table.defaults)
    expect(columnsOf(db, table.name).filter((column) => !table.columns.includes(column))).toEqual(fresh)
    if (fresh.length > 0) expect(rowsOf(db, table.name, fresh)).toEqual(table.rows.map(() => table.defaults))
  }
}

/** What v34 (sprint learning card links) and v36 (integration authority) add to rows that existed before them. */
const V34_CARD_DEFAULTS = { checkpoint_id: null, revision_id: null, snapshot_json: null, bases_json: '[]' }
const V36_INTEGRATION_DEFAULTS = { owner_machine_id: null, superseded_by: null }

function insertLearning(db: Db, spec: { id: string; state?: string; replaces?: string | null; replacedBy?: string | null; retiredAt?: string | null }): void {
  db.run(
    `INSERT INTO learning_records (id, run_id, sprint_id, card_id, attempt_id, definition_json, definition_hash, state,
       replaces_id, replaced_by_id, created_at, retired_at)
     VALUES (?, 'rn1', 'sp1', 'kc1', 'ka1', '{}', ?, ?, ?, ?, 't', ?)`,
    spec.id, LEARNING_HASH, spec.state ?? 'active', spec.replaces ?? null, spec.replacedBy ?? null, spec.retiredAt ?? null
  )
}

function insertGeneratedCard(db: Db, cardId: string, runId: string, sprintId: string): void {
  db.run(
    `INSERT INTO sprint_learning_cards (card_id, epic_id, run_id, sprint_id, report_id, evidence_hash, created_at)
     VALUES (?, 'ep1', ?, ?, 'rp1', ?, 't')`,
    cardId, runId, sprintId, LEARNING_HASH
  )
}

describe('v31 learning storage upgrade', () => {
  it('upgrades a released v30 database without changing a row, or the hash of a Kanban, plan or run record', () => {
    const { db, cardId, eventIds } = v30WithRecords()
    const rows = JSON.stringify(LEGACY_COPIED.map((table) => db.all(`SELECT * FROM ${table} ORDER BY 1`)))
    const hashes = recordHashes(db, cardId, eventIds)
    expect(eventIds.length).toBeGreaterThan(0)
    expect(migrate(db)).toEqual({ from: 30, to: SCHEMA_VERSION })
    expect(JSON.stringify(LEGACY_COPIED.map((table) => db.all(`SELECT * FROM ${table} ORDER BY 1`)))).toBe(rows)
    expect(recordHashes(db, cardId, eventIds)).toEqual(hashes)
    expect(prettyJson(buildRunHistoryRecord(db, LEGACY_RUN))).toBe(legacyText('history', LEGACY_RUN, 'run.json'))
    expect(contentHash(buildRunHistoryRecord(db, LEGACY_RUN))).toBe(contentHash(JSON.parse(legacyText('history', LEGACY_RUN, 'run.json'))))
    expect(db.all('PRAGMA foreign_key_check')).toEqual([])
    for (const table of ['learning_records', 'sprint_learning_cards', 'learning_integrations']) {
      expect(db.all(`SELECT * FROM ${table}`)).toEqual([])
    }
  })

  it('leaves an upgraded database with exactly the schema of a clean install', () => {
    const upgraded = freshDb()
    migrate(upgraded, MIGRATIONS.filter((migration) => migration.version <= 30))
    migrate(upgraded)
    expect(schemaOf(upgraded)).toEqual(schemaOf(migratedDb()))
  })

  it('links one generated learning card per run and sprint, and a card to one run and sprint', () => {
    const db = migratedDb()
    insertGeneratedCard(db, 'kc1', 'rn1', 'sp1')
    expect(() => insertGeneratedCard(db, 'kc2', 'rn1', 'sp1')).toThrow(/UNIQUE constraint failed: sprint_learning_cards.run_id, sprint_learning_cards.sprint_id/)
    expect(() => insertGeneratedCard(db, 'kc1', 'rn1', 'sp2')).toThrow(/UNIQUE constraint failed: sprint_learning_cards.card_id/)
    insertGeneratedCard(db, 'kc2', 'rn1', 'sp2')
    insertGeneratedCard(db, 'kc3', 'rn2', 'sp1')
    expect(db.all('SELECT card_id FROM sprint_learning_cards ORDER BY card_id')).toEqual([{ card_id: 'kc1' }, { card_id: 'kc2' }, { card_id: 'kc3' }])
  })
})

describe('v31 learning storage invariants', () => {
  it('keeps a learning record definition and source immutable while its lifecycle changes', () => {
    const db = migratedDb()
    insertLearning(db, { id: 'lr1' })
    for (const column of ['definition_json', 'run_id', 'card_id', 'attempt_id', 'definition_hash']) {
      expect(() => db.run(`UPDATE learning_records SET ${column} = 'changed' WHERE id = 'lr1'`)).toThrow('immutable')
    }
    db.run("UPDATE learning_records SET state = 'retired', retired_at = 't2', retired_reason = 'Stale', revision = 2 WHERE id = 'lr1'")
    expect(db.get('SELECT state, retired_reason, revision FROM learning_records')).toEqual({ state: 'retired', retired_reason: 'Stale', revision: 2 })
  })

  it('refuses lifecycle states and links that break the record invariants', () => {
    const db = migratedDb()
    expect(() => insertLearning(db, { id: 'lr0', state: 'draft' })).toThrow(/CHECK constraint failed/)
    expect(() => insertLearning(db, { id: 'lr0', state: 'retired' })).toThrow(/CHECK constraint failed/)
    expect(() => insertLearning(db, { id: 'lr0', retiredAt: 't' })).toThrow(/CHECK constraint failed/)
    // BEFORE INSERT triggers run ahead of CHECK constraints, so the cycle guard is what refuses a self-replacement.
    expect(() => insertLearning(db, { id: 'lr0', replaces: 'lr0' })).toThrow('A learning replacement chain cannot form a cycle')
    expect(() => insertLearning(db, { id: 'lr0', replaces: 'missing' })).toThrow(/FOREIGN KEY constraint failed/)
    insertLearning(db, { id: 'lr1' })
    insertLearning(db, { id: 'lr2', replaces: 'lr1' })
    expect(() => insertLearning(db, { id: 'lr3', replaces: 'lr1' })).toThrow(/UNIQUE constraint failed: learning_records.replaces_id/)
    expect(() => db.run("UPDATE learning_records SET replaced_by_id = 'lr1' WHERE id = 'lr1'")).toThrow(/CHECK constraint failed/)
    expect(() => db.run("UPDATE learning_records SET replaced_by_id = 'lr2' WHERE id = 'lr1'")).toThrow(/CHECK constraint failed/)
    db.run("UPDATE learning_records SET state = 'retired', retired_at = 't2', replaced_by_id = 'lr2' WHERE id = 'lr1'")
    expect(db.all('SELECT id, state, replaces_id, replaced_by_id FROM learning_records ORDER BY id')).toEqual([
      { id: 'lr1', state: 'retired', replaces_id: null, replaced_by_id: 'lr2' },
      { id: 'lr2', state: 'active', replaces_id: 'lr1', replaced_by_id: null }
    ])
  })

  it('refuses a replacement that would close a cycle, even with foreign keys deferred as an import does', () => {
    const db = migratedDb()
    db.exec('PRAGMA foreign_keys = OFF')
    insertLearning(db, { id: 'a', replaces: 'c' })
    insertLearning(db, { id: 'b', replaces: 'a' })
    expect(() => insertLearning(db, { id: 'c', replaces: 'b' })).toThrow('A learning replacement chain cannot form a cycle')
    db.exec('PRAGMA foreign_keys = ON')
    expect(db.all('SELECT id FROM learning_records ORDER BY id')).toEqual([{ id: 'a' }, { id: 'b' }])
  })
})

describe('v31 learning integration storage', () => {
  it('allows one open integration per card and keeps finished ones as history', () => {
    const db = migratedDb()
    const insert = (id: string, state: string): void => {
      db.run(
        `INSERT INTO learning_integrations (id, card_id, attempt_id, state, manifest_json, manifest_hash, created_at, updated_at)
         VALUES (?, 'kc1', 'ka1', ?, '{}', ?, 't', 't')`,
        id, state, LEARNING_HASH
      )
    }
    insert('li1', 'conflicted')
    insert('li2', 'aborted')
    insert('li3', 'prepared')
    expect(() => insert('li4', 'integrating')).toThrow(/UNIQUE constraint failed: learning_integrations.card_id/)
    expect(() => insert('li5', 'merged')).toThrow(/CHECK constraint failed/)
    db.run("UPDATE learning_integrations SET state = 'published' WHERE id = 'li3'")
    insert('li6', 'prepared')
    expect(db.all("SELECT id FROM learning_integrations WHERE state IN ('prepared','integrating','integrated')")).toEqual([{ id: 'li6' }])
  })

  it('names the same lifecycle and integration states as the shared contract', () => {
    const db = migratedDb()
    const sql = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'learning_integrations'")?.sql ?? ''
    expect(sql).toContain(`state IN (${LEARNING_INTEGRATION_STATES.map((state) => `'${state}'`).join(',')})`)
    const index = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'learning_integrations_one_open_per_card'")?.sql ?? ''
    expect(index).toContain(`state IN (${LEARNING_INTEGRATION_OPEN_STATES.map((state) => `'${state}'`).join(',')})`)
    const records = db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'learning_records'")?.sql ?? ''
    expect(records).toContain(`state IN (${LEARNING_STATES.map((state) => `'${state}'`).join(',')})`)
  })
})

describe('v32 learning history upgrade', () => {
  it('upgrades a v31 database with learnings without changing a row, and matches a clean install', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 31))
    insertLearning(db, { id: 'lr1' })
    insertGeneratedCard(db, 'kc1', 'rn1', 'sp1')
    expectAdditiveUpgrade(db, 31, {
      learning_records: {},
      sprint_learning_cards: V34_CARD_DEFAULTS,
      learning_integrations: V36_INTEGRATION_DEFAULTS
    })
    expect(db.all('SELECT * FROM learning_events')).toEqual([])
    expect(schemaOf(db)).toEqual(schemaOf(migratedDb()))
  })

  it('keeps learning history append-only, linked to stored learnings, with a related learning exactly for replacements', () => {
    const db = migratedDb()
    insertLearning(db, { id: 'lr1' })
    insertLearning(db, { id: 'lr2', replaces: 'lr1' })
    const append = (kind: string, learningId: string, related: string | null): void => {
      db.run(
        `INSERT INTO learning_events (learning_id, kind, related_id, reason, revision, actor_role, actor_label, run_id, sprint_id, card_id, attempt_id, at)
         VALUES (?, ?, ?, 'why', 1, 'desktop', 'person', 'rn1', 'sp1', 'kc1', 'ka1', 't')`,
        learningId, kind, related
      )
    }
    append('published', 'lr1', null)
    append('replaced', 'lr1', 'lr2')
    append('created_by_replacement', 'lr2', 'lr1')
    expect(() => append('edited', 'lr1', null)).toThrow(/CHECK constraint failed/)
    expect(() => append('replaced', 'lr1', null)).toThrow(/CHECK constraint failed/)
    expect(() => append('retired', 'lr1', 'lr2')).toThrow(/CHECK constraint failed/)
    expect(() => append('retired', 'missing', null)).toThrow(/FOREIGN KEY constraint failed/)
    expect(() => db.run("UPDATE learning_events SET reason = 'changed'")).toThrow('Learning history is append-only')
    expect(() => db.run('DELETE FROM learning_events WHERE seq = 1')).toThrow('Learning history is append-only')
    expect(db.all('SELECT learning_id, kind, related_id FROM learning_events ORDER BY seq')).toEqual([
      { learning_id: 'lr1', kind: 'published', related_id: null },
      { learning_id: 'lr1', kind: 'replaced', related_id: 'lr2' },
      { learning_id: 'lr2', kind: 'created_by_replacement', related_id: 'lr1' }
    ])
  })

  it('names the same history kinds as the shared contract', () => {
    const sql = migratedDb().get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'learning_events'")?.sql ?? ''
    expect(sql).toContain(`kind IN (${LEARNING_HISTORY_KINDS.map((kind) => `'${kind}'`).join(',')})`)
  })
})

function stageDrafts(db: Db, attemptId: string, drafts = '[]'): void {
  db.run(
    `INSERT INTO learning_stagings (attempt_id, card_id, run_id, sprint_id, snapshot_hash, drafts_json, drafts_hash, evidence_json,
       staged_by_role, staged_by_label, staged_at)
     VALUES (?, 'kc1', 'rn1', 'sp1', ?, ?, ?, '[]', 'worker', 'agent', 't')
     ON CONFLICT (attempt_id) DO UPDATE SET drafts_json = excluded.drafts_json`,
    attemptId, LEARNING_HASH, drafts, LEARNING_HASH
  )
}

function insertPublication(db: Db, attemptId: string, cardId = 'kc1'): void {
  db.run(
    `INSERT INTO learning_publications (attempt_id, card_id, run_id, sprint_id, drafts_hash, evidence_json, record_ids_json,
       published_by_role, published_by_label, published_at)
     VALUES (?, ?, 'rn1', 'sp1', ?, '[]', '[]', 'desktop', 'person', 't')`,
    attemptId, cardId, LEARNING_HASH
  )
}

describe('v33 learning publication storage', () => {
  const stage = stageDrafts
  const publish = insertPublication

  it('upgrades a v32 database with learnings and history without changing a row, and matches a clean install', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 32))
    insertLearning(db, { id: 'lr1' })
    insertGeneratedCard(db, 'kc1', 'rn1', 'sp1')
    db.run(
      `INSERT INTO learning_events (learning_id, kind, reason, revision, actor_role, actor_label, run_id, sprint_id, card_id, attempt_id, at)
       VALUES ('lr1', 'published', 'why', 1, 'desktop', 'person', 'rn1', 'sp1', 'kc1', 'ka1', 't')`
    )
    expectAdditiveUpgrade(db, 32, {
      learning_records: {},
      learning_events: {},
      sprint_learning_cards: V34_CARD_DEFAULTS,
      learning_integrations: V36_INTEGRATION_DEFAULTS
    })
    expect(db.all('SELECT * FROM learning_stagings')).toEqual([])
    expect(db.all('SELECT * FROM learning_publications')).toEqual([])
    expect(schemaOf(db)).toEqual(schemaOf(migratedDb()))
  })

  it('lets an attempt restage until it is published, then freezes its drafts and the publication', () => {
    const db = migratedDb()
    stage(db, 'ka1')
    stage(db, 'ka1', '[{"title":"restaged"}]')
    expect(db.get('SELECT drafts_json FROM learning_stagings')).toEqual({ drafts_json: '[{"title":"restaged"}]' })
    publish(db, 'ka1')
    expect(() => stage(db, 'ka1', '[]')).toThrow('Published learning drafts are immutable')
    expect(() => db.run("DELETE FROM learning_stagings WHERE attempt_id = 'ka1'")).toThrow('Published learning drafts are immutable')
    expect(() => db.run("UPDATE learning_publications SET record_ids_json = '[\"lr1\"]'")).toThrow('A learning publication is immutable')
    expect(() => db.run('DELETE FROM learning_publications')).toThrow('A learning publication is immutable')
    expect(() => publish(db, 'ka1', 'kc2')).toThrow(/UNIQUE constraint failed: learning_publications.attempt_id/)
    expect(() => publish(db, 'ka2')).toThrow(/UNIQUE constraint failed: learning_publications.card_id/)
    stage(db, 'ka3')
    db.run("DELETE FROM learning_stagings WHERE attempt_id = 'ka3'")
    expect(db.all('SELECT attempt_id FROM learning_stagings')).toEqual([{ attempt_id: 'ka1' }])
  })
})

// ─── DM-935: v35 learning kinds in the outbox and sync state ───
function v33Db(): Db {
  const db = freshDb()
  migrate(db, MIGRATIONS.filter((migration) => migration.version <= 33))
  return db
}

describe('v35 learning record kinds', () => {
  it('upgrades a v33 database keeping every outbox and sync state row, its retry times, the outbox id sequence and its index', () => {
    const db = v33Db()
    db.run(
      `INSERT INTO outbox (kind, epic_id, run_id, revision_id, entity_id, state, attempts, last_error, created_at)
       VALUES ('snapshot', 'ep1', NULL, 'rv1', NULL, 'pending', 0, NULL, 't'),
              ('metric_observation', NULL, NULL, NULL, 'mo1', 'failed', 5, 'disk full', 't'),
              ('kanban_card', NULL, NULL, NULL, 'kc1', 'done', 1, NULL, 't')`
    )
    db.run('DELETE FROM outbox WHERE id = 3')
    db.run("UPDATE outbox SET next_attempt_at = '2026-01-01T00:00:15.000Z' WHERE id = 2")
    db.run(
      `INSERT INTO sync_state (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
       VALUES ('epic', 'ep1', 'sha256:a', 4, 'sha256:b', 'diverged', 't1'), ('metric_observation', 'mo1', NULL, 0, 'sha256:c', NULL, 't2')`
    )
    expect(() => db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES ('learning_record', 'lr1', 'pending', 't')")).toThrow(/CHECK constraint failed/)
    expect(migrate(db)).toEqual({ from: 33, to: SCHEMA_VERSION })
    expect(outboxRows(db)).toEqual([
      { id: 1, kind: 'snapshot', epic_id: 'ep1', run_id: null, revision_id: 'rv1', entity_id: null, state: 'pending', attempts: 0, last_error: null },
      { id: 2, kind: 'metric_observation', epic_id: null, run_id: null, revision_id: null, entity_id: 'mo1', state: 'failed', attempts: 5, last_error: 'disk full' }
    ])
    expect(db.all('SELECT id, next_attempt_at FROM outbox ORDER BY id')).toEqual([
      { id: 1, next_attempt_at: null },
      { id: 2, next_attempt_at: '2026-01-01T00:00:15.000Z' }
    ])
    expect(db.all('SELECT * FROM sync_state ORDER BY kind')).toEqual([
      { kind: 'epic', entity_id: 'ep1', exported_hash: 'sha256:a', generation: 4, imported_hash: 'sha256:b', conflict: 'diverged', updated_at: 't1' },
      { kind: 'metric_observation', entity_id: 'mo1', exported_hash: null, generation: 0, imported_hash: 'sha256:c', conflict: null, updated_at: 't2' }
    ])
    // The id deleted before the upgrade is never handed out again.
    expect(db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES ('learning_record', 'lr1', 'pending', 't')").lastInsertRowid).toBe(4)
    expect(objectNames(db, 'index')).toContain('outbox_state')
  })

  it('builds the same schema on upgrade as on a clean install', () => {
    const upgraded = v33Db()
    migrate(upgraded)
    expect(schemaOf(upgraded)).toEqual(schemaOf(migratedDb()))
  })

  it.each(['learning_record', 'learning_integration'])('accepts outbox entries and sync state of kind %s, and still rejects unknown kinds', (kind) => {
    const db = migratedDb()
    db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES (?, 'x1', 'pending', 't')", kind)
    db.run("INSERT INTO sync_state (kind, entity_id, updated_at) VALUES (?, 'x1', 't')", kind)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM outbox WHERE kind = ?', kind)?.n).toBe(1)
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_state WHERE kind = ?', kind)?.n).toBe(1)
    expect(() => db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES ('learning_event', 'x', 'pending', 't')")).toThrow(/CHECK constraint failed/)
    expect(() => db.run("INSERT INTO sync_state (kind, entity_id, updated_at) VALUES ('learning_event', 'x', 't')")).toThrow(/CHECK constraint failed/)
  })
})
// ─── End DM-935 ───

// ─── DM-950: v36 machine-local integration authority ───
describe('v36 learning integration authority', () => {
  it('upgrades a v35 database keeping every integration, each inert, and builds the clean-install schema', () => {
    const db = freshDb()
    migrate(db, MIGRATIONS.filter((migration) => migration.version <= 35))
    db.run(
      `INSERT INTO learning_integrations (id, card_id, attempt_id, state, manifest_json, manifest_hash, failure_json, revision, created_at, updated_at)
       VALUES ('li1', 'kc1', 'ka1', 'integrating', '{"a":1}', 'sha256:a', NULL, 3, 't1', 't2'),
              ('li2', 'kc2', 'ka2', 'aborted', '{"b":2}', 'sha256:b', '{"code":"x","message":"y"}', 2, 't3', 't4')`
    )
    const before = db.all('SELECT * FROM learning_integrations ORDER BY id')
    expect(migrate(db)).toEqual({ from: 35, to: SCHEMA_VERSION })
    // Named columns: a cached `SELECT *` statement would keep the pre-upgrade column list.
    expect(db.all('SELECT learning_integrations.*, owner_machine_id, superseded_by FROM learning_integrations ORDER BY id')).toEqual(
      before.map((row) => ({ ...(row as Record<string, unknown>), owner_machine_id: null, superseded_by: null }))
    )
    expect(objectNames(db, 'index')).toContain('learning_integrations_one_open_per_card')
    expect(schemaOf(db)).toEqual(schemaOf(migratedDb()))
  })
})
// ─── End DM-950 ───
