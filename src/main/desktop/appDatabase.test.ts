import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Db, openDatabase } from '../../core/db/database'
import { migrate } from '../../core/db/migrations'
import { DomainError } from '../../core/errors'
import { thrownBy } from '../../test/thrownBy'
import { APP_MIGRATIONS, openAppDatabase } from './appDatabase'

const tempDirs: string[] = []
const openDbs: Db[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dm-appdb-test-'))
  tempDirs.push(dir)
  return dir
}

function open(dir: string): Db {
  const db = openAppDatabase(dir)
  openDbs.push(db)
  return db
}

function insertAgent(db: Db, id: string, kind: string): void {
  db.run(
    `INSERT INTO agents (id, kind, display_name, executable_path, connected_via, connected_at, last_probed)
     VALUES (?, ?, 'Agent', '/bin/agent', 'found', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    id,
    kind
  )
}

/** The custom rows of the fixture: one per protocol a custom CLI could speak before chats became terminals. */
const ACP_ROW = { id: 'cu_01m6acp00000000000000000aa', protocol: 'acp', display_name: 'a8s over ACP', executable_path: '/Users/me/.local/bin/a8s', args_json: '["start","{folder}","--mode","acp"]', version: '0.79.0', reported_name: 'omp' }
const CODEX_ROW = { id: 'cu_01m6codex000000000000000bb', protocol: 'codex', display_name: 'My Codex', executable_path: '/opt/tools/codex', args_json: '["app-server"]', version: '0.9.1', reported_name: 'codex_cli_rs' }
const CLAUDE_ROW = { id: 'cu_01m6c1aude00000000000000cc', protocol: 'claude', display_name: 'My Claude', executable_path: '/Users/me/.local/bin/claude', args_json: '["--model","haiku"]', version: null, reported_name: null }

/**
 * Writes `<dir>/app.sqlite` at today's schema (v2, as the build before terminal chats left it): a built-in Codex
 * row, one custom row per protocol, and a folder default on the ACP row.
 */
function writeTodaysAppSqlite(dir: string): void {
  const raw = openDatabase(join(dir, 'app.sqlite'))
  migrate(raw, APP_MIGRATIONS.filter((migration) => migration.version <= 2))
  raw.run(
    `INSERT INTO agents (id, kind, protocol, display_name, executable_path, args_json, version, reported_name, connected_via, connected_at, last_probed)
     VALUES ('codex', 'codex', 'codex', 'Codex', '/usr/local/bin/codex', '[]', '0.9.1', NULL, 'found', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')`
  )
  for (const row of [ACP_ROW, CODEX_ROW, CLAUDE_ROW]) {
    raw.run(
      `INSERT INTO agents (id, kind, protocol, display_name, executable_path, args_json, version, reported_name, connected_via, connected_at, last_probed)
       VALUES (?, 'custom', ?, ?, ?, ?, ?, ?, 'custom', '2026-10-01T00:00:00Z', '2026-10-02T00:00:00Z')`,
      row.id,
      row.protocol,
      row.display_name,
      row.executable_path,
      row.args_json,
      row.version,
      row.reported_name
    )
  }
  raw.run("INSERT INTO folder_agent_defaults (folder, agent_id, updated_at) VALUES ('/repos/a', ?, '2026-10-03T00:00:00Z')", ACP_ROW.id)
  raw.run("INSERT INTO app_meta (key, value) VALUES ('legacy_import', 'done')")
  expect(raw.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(2)
  raw.close()
}

/** The fixture at today's schema, opened (and so upgraded) by this build. */
function upgraded(): Db {
  const dir = tempDir()
  writeTodaysAppSqlite(dir)
  return open(dir)
}

function columnsOf(db: Db, table: string): string[] {
  return db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}') ORDER BY cid`).map((column) => column.name)
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('openAppDatabase', () => {
  it('creates app.sqlite at user_version 4 with the three tables', () => {
    const dir = tempDir()
    const db = open(dir)
    expect(existsSync(join(dir, 'app.sqlite'))).toBe(true)
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(4)
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row.name)
    expect(tables).toEqual(['agents', 'app_meta', 'folder_agent_defaults'])
  })

  it('stores an agent with no protocol and no handshake result, and whether it needs review', () => {
    const db = open(tempDir())
    expect(columnsOf(db, 'agents')).toEqual([
      'id',
      'kind',
      'display_name',
      'executable_path',
      'args_json',
      'version',
      'connected_via',
      'connected_at',
      'last_probed',
      'needs_review'
    ])
  })

})

describe('openAppDatabase on a file already there', () => {
  it('applies nothing when reopened', () => {
    const dir = tempDir()
    open(dir).close()
    openDbs.length = 0
    const db = open(dir)
    expect(migrate(db, APP_MIGRATIONS)).toEqual({ from: 4, to: 4 })
  })

  it('refuses a database at a newer user_version with incompatible_schema', () => {
    const dir = tempDir()
    const raw = openDatabase(join(dir, 'app.sqlite'))
    raw.exec('PRAGMA user_version = 5')
    raw.close()
    const error = thrownBy(() => open(dir))
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('incompatible_schema')
  })

  it('upgrades a v1 file, keeping its agent rows', () => {
    const dir = tempDir()
    const raw = openDatabase(join(dir, 'app.sqlite'))
    migrate(raw, APP_MIGRATIONS.filter((migration) => migration.version === 1))
    raw.run(
      `INSERT INTO agents (id, kind, protocol, display_name, executable_path, args_json, version, connected_via, connected_at, last_probed)
       VALUES ('cu_1', 'custom', 'acp', 'a8s custom', '/bin/a8s', '["{folder}"]', '18.11.2', 'custom', 't', 't')`
    )
    raw.close()
    const db = open(dir)
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(4)
    expect(db.get('SELECT id, args_json, needs_review FROM agents')).toEqual({ id: 'cu_1', args_json: '["{folder}"]', needs_review: 1 })
  })
})

describe('upgrading an app.sqlite at today’s schema (v2): the protocol goes, ACP and Codex custom rows need review', () => {
  it('drops the protocol column, and the agent name the handshake reported', () => {
    const db = upgraded()
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(4)
    expect(columnsOf(db, 'agents')).not.toContain('protocol')
    expect(columnsOf(db, 'agents')).not.toContain('reported_name')
    expect(db.get<{ sql: string }>("SELECT sql FROM sqlite_master WHERE name = 'agents'")?.sql).not.toMatch(/protocol|reported_name/)
  })

  it('marks the ACP and Codex custom rows for review, and leaves the Claude-protocol row and the built-in to start as they are', () => {
    const db = upgraded()
    expect(db.all('SELECT id, needs_review FROM agents ORDER BY rowid')).toEqual([
      { id: 'codex', needs_review: 0 },
      { id: ACP_ROW.id, needs_review: 1 },
      { id: CODEX_ROW.id, needs_review: 1 },
      { id: CLAUDE_ROW.id, needs_review: 0 }
    ])
  })

  it('keeps every row’s program, arguments, name and timestamps, and clears only the custom rows’ handshake version', () => {
    const db = upgraded()
    expect(db.all('SELECT id, kind, display_name, executable_path, args_json, version, connected_via, connected_at, last_probed FROM agents ORDER BY rowid')).toEqual([
      { id: 'codex', kind: 'codex', display_name: 'Codex', executable_path: '/usr/local/bin/codex', args_json: '[]', version: '0.9.1', connected_via: 'found', connected_at: '2026-10-01T00:00:00Z', last_probed: '2026-10-02T00:00:00Z' },
      ...[ACP_ROW, CODEX_ROW, CLAUDE_ROW].map((row) => ({
        id: row.id,
        kind: 'custom',
        display_name: row.display_name,
        executable_path: row.executable_path,
        args_json: row.args_json,
        version: null,
        connected_via: 'custom',
        connected_at: '2026-10-01T00:00:00Z',
        last_probed: '2026-10-02T00:00:00Z'
      }))
    ])
  })

})

describe('upgrading an app.sqlite at today’s schema (v2): what else the upgrade keeps', () => {
  it('keeps the folder defaults and app_meta: rebuilding agents would have cascaded the defaults away', () => {
    const db = upgraded()
    expect(db.all('SELECT folder, agent_id FROM folder_agent_defaults')).toEqual([{ folder: '/repos/a', agent_id: ACP_ROW.id }])
    expect(db.all('SELECT key, value FROM app_meta')).toEqual([{ key: 'legacy_import', value: 'done' }])
    db.run('DELETE FROM agents WHERE id = ?', ACP_ROW.id)
    expect(db.all('SELECT * FROM folder_agent_defaults')).toEqual([])
  })

  it('keeps the row checks after the upgrade', () => {
    const db = upgraded()
    expect(thrownBy(() => insertAgent(db, 'other', 'claude'))).toBeInstanceOf(Error)
    expect(thrownBy(() => db.run("UPDATE agents SET needs_review = 2 WHERE id = 'codex'"))).toBeInstanceOf(Error)
  })
})

describe('upgrading an app.sqlite at v3: omp becomes a kind', () => {
  function writeV3(dir: string): void {
    const raw = openDatabase(join(dir, 'app.sqlite'))
    migrate(raw, APP_MIGRATIONS.filter((migration) => migration.version <= 3))
    const columns = 'id, kind, display_name, executable_path, args_json, version, connected_via, connected_at, last_probed, needs_review'
    raw.run(`INSERT INTO agents (${columns}) VALUES ('autonomous', 'autonomous', 'Autonomous', '/bin/a8s', '[]', '0.79.0', 'found', 't1', 't2', 0)`)
    raw.run(`INSERT INTO agents (${columns}) VALUES ('cu_1', 'custom', 'My CLI', '/opt/my cli', '["--x"]', NULL, 'custom', 't3', 't4', 1)`)
    raw.run("INSERT INTO folder_agent_defaults (folder, agent_id, updated_at) VALUES ('/repos/a', 'autonomous', 't5')")
    raw.run("INSERT INTO app_meta (key, value) VALUES ('k', 'v')")
    expect(raw.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(3)
    raw.close()
  }

  it('keeps every agent row and column, including a custom and an autonomous row, and the folder defaults', () => {
    const dir = tempDir()
    writeV3(dir)
    const db = open(dir)
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(4)
    expect(columnsOf(db, 'agents')).toEqual(['id', 'kind', 'display_name', 'executable_path', 'args_json', 'version', 'connected_via', 'connected_at', 'last_probed', 'needs_review'])
    expect(db.all('SELECT * FROM agents ORDER BY rowid')).toEqual([
      { id: 'autonomous', kind: 'autonomous', display_name: 'Autonomous', executable_path: '/bin/a8s', args_json: '[]', version: '0.79.0', connected_via: 'found', connected_at: 't1', last_probed: 't2', needs_review: 0 },
      { id: 'cu_1', kind: 'custom', display_name: 'My CLI', executable_path: '/opt/my cli', args_json: '["--x"]', version: null, connected_via: 'custom', connected_at: 't3', last_probed: 't4', needs_review: 1 }
    ])
    expect(db.all('SELECT folder, agent_id, updated_at FROM folder_agent_defaults')).toEqual([{ folder: '/repos/a', agent_id: 'autonomous', updated_at: 't5' }])
    expect(db.all('SELECT key, value FROM app_meta')).toEqual([{ key: 'k', value: 'v' }])
  })

  it('accepts an omp row, still cascades deletes to the defaults, and keeps the other checks', () => {
    const dir = tempDir()
    writeV3(dir)
    const db = open(dir)
    insertAgent(db, 'omp', 'omp')
    db.run("INSERT INTO folder_agent_defaults (folder, agent_id, updated_at) VALUES ('/repos/b', 'omp', 't6')")
    expect(db.all('SELECT id, kind FROM agents WHERE kind = ?', 'omp')).toEqual([{ id: 'omp', kind: 'omp' }])
    db.run("DELETE FROM agents WHERE id = 'omp'")
    expect(db.all('SELECT folder FROM folder_agent_defaults')).toEqual([{ folder: '/repos/a' }])
    expect(thrownBy(() => insertAgent(db, 'other', 'omp'))).toBeInstanceOf(Error)
    expect(thrownBy(() => insertAgent(db, 'unknown', 'unknown'))).toBeInstanceOf(Error)
  })

  it('accepts an omp row on a fresh database', () => {
    const db = open(tempDir())
    insertAgent(db, 'omp', 'omp')
    expect(db.all('SELECT id FROM agents')).toEqual([{ id: 'omp' }])
  })
})

describe('app database constraints', () => {
  it('cascades agent deletion to folder_agent_defaults', () => {
    const db = open(tempDir())
    insertAgent(db, 'claude', 'claude')
    db.run("INSERT INTO folder_agent_defaults (folder, agent_id, updated_at) VALUES ('/repo', 'claude', 'now')")
    db.run("DELETE FROM agents WHERE id = 'claude'")
    expect(db.all('SELECT * FROM folder_agent_defaults')).toEqual([])
  })

  it('accepts a built-in row and a cu_ custom row, neither needing review unless told', () => {
    const db = open(tempDir())
    insertAgent(db, 'codex', 'codex')
    insertAgent(db, 'cu_1', 'custom')
    expect(db.all('SELECT id, needs_review FROM agents')).toEqual([
      { id: 'codex', needs_review: 0 },
      { id: 'cu_1', needs_review: 0 }
    ])
  })

  it('refuses a built-in row whose id is not its kind', () => {
    const db = open(tempDir())
    expect(thrownBy(() => insertAgent(db, 'other', 'claude'))).toBeInstanceOf(Error)
  })

  it('refuses a custom row whose id does not start with cu_', () => {
    const db = open(tempDir())
    expect(thrownBy(() => insertAgent(db, 'mine', 'custom'))).toBeInstanceOf(Error)
  })

  it('refuses a needs_review other than 0 or 1', () => {
    const db = open(tempDir())
    insertAgent(db, 'cu_1', 'custom')
    expect(thrownBy(() => db.run("UPDATE agents SET needs_review = 2 WHERE id = 'cu_1'"))).toBeInstanceOf(Error)
  })
})
