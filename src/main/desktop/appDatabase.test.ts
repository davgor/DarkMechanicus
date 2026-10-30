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

function insertAgent(db: Db, id: string, kind: string, protocol = 'claude'): void {
  db.run(
    `INSERT INTO agents (id, kind, protocol, display_name, executable_path, connected_via, connected_at, last_probed)
     VALUES (?, ?, ?, 'Agent', '/bin/agent', 'found', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
    id,
    kind,
    protocol
  )
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('openAppDatabase', () => {
  it('creates app.sqlite at user_version 1 with the three tables', () => {
    const dir = tempDir()
    const db = open(dir)
    expect(existsSync(join(dir, 'app.sqlite'))).toBe(true)
    expect(db.get<{ user_version: number }>('PRAGMA user_version')?.user_version).toBe(1)
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .map((row) => row.name)
    expect(tables).toEqual(['agents', 'app_meta', 'folder_agent_defaults'])
  })

  it('applies nothing when reopened', () => {
    const dir = tempDir()
    open(dir).close()
    openDbs.length = 0
    const db = open(dir)
    expect(migrate(db, APP_MIGRATIONS)).toEqual({ from: 1, to: 1 })
  })

  it('refuses a database at a newer user_version with incompatible_schema', () => {
    const dir = tempDir()
    const raw = openDatabase(join(dir, 'app.sqlite'))
    raw.exec('PRAGMA user_version = 2')
    raw.close()
    const error = thrownBy(() => open(dir))
    expect(error).toBeInstanceOf(DomainError)
    expect((error as DomainError).code).toBe('incompatible_schema')
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

  it('accepts a built-in row and a cu_ custom row', () => {
    const db = open(tempDir())
    insertAgent(db, 'codex', 'codex', 'codex')
    insertAgent(db, 'cu_1', 'custom', 'acp')
    expect(db.all('SELECT id FROM agents')).toHaveLength(2)
  })

  it('refuses a built-in row whose id is not its kind', () => {
    const db = open(tempDir())
    expect(thrownBy(() => insertAgent(db, 'other', 'claude'))).toBeInstanceOf(Error)
  })

  it('refuses a custom row whose id does not start with cu_', () => {
    const db = open(tempDir())
    expect(thrownBy(() => insertAgent(db, 'mine', 'custom', 'acp'))).toBeInstanceOf(Error)
  })

  it('refuses an unknown protocol', () => {
    const db = open(tempDir())
    expect(thrownBy(() => insertAgent(db, 'claude', 'claude', 'telnet'))).toBeInstanceOf(Error)
  })
})
