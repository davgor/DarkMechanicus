import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type Db, openDatabase } from '../../core/db/database'
import { migrate } from '../../core/db/migrations'
import { createAgentRegistry } from './agentRegistry'
import { importLegacyAgents, type LegacyImportFs } from './agentRegistryImport'
import { APP_MIGRATIONS } from './appDatabase'

const FILE = '/state/agents.json'

function appDb(): Db {
  const db = openDatabase(':memory:')
  migrate(db, APP_MIGRATIONS)
  return db
}

interface MemoryFs extends LegacyImportFs {
  files: Map<string, string>
}

function memoryFs(initial: Record<string, string> = {}): MemoryFs {
  const files = new Map(Object.entries(initial))
  return {
    files,
    readFile(path) {
      const data = files.get(path)
      if (data === undefined) {
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
      }
      return data
    },
    removeFile(path) {
      files.delete(path)
    }
  }
}

const CLAUDE = {
  kind: 'claude',
  executablePath: '/usr/local/bin/claude',
  version: '2.1.0',
  connectedVia: 'found',
  connectedAt: '2025-05-01T10:00:00.000Z',
  lastProbed: '2025-06-01T10:00:00.000Z'
}
const CODEX = {
  kind: 'codex',
  executablePath: '/opt/codex',
  version: null,
  connectedVia: 'downloaded',
  connectedAt: '2025-05-02T10:00:00.000Z',
  lastProbed: '2025-06-02T10:00:00.000Z'
}

/** What the registry lists for an imported entry: its id, protocol, display name, (no) arguments and (no) reported name follow from its kind. */
const CLAUDE_VIEW = { ...CLAUDE, id: 'claude', protocol: 'claude', displayName: 'Claude Code', args: [], reportedName: null }
const CODEX_VIEW = { ...CODEX, id: 'codex', protocol: 'codex', displayName: 'Codex', args: [], reportedName: null }

const legacyFile = (agents: unknown[]): string => JSON.stringify({ version: 1, agents })

function importMarker(db: Db): string | undefined {
  return db.get<{ value: string }>("SELECT value FROM app_meta WHERE key = 'legacyAgentsImported'")?.value
}

function run(db: Db, fs: MemoryFs, log: string[] = []): void {
  importLegacyAgents({ db, file: FILE, fs, log: (line) => log.push(line) })
}

describe('importLegacyAgents', () => {
  it('imports every valid entry with its timestamps, marks the database and deletes the file', () => {
    const db = appDb()
    const fs = memoryFs({ [FILE]: legacyFile([CLAUDE, CODEX]) })

    run(db, fs)

    expect(createAgentRegistry({ db }).list()).toEqual([CLAUDE_VIEW, CODEX_VIEW])
    expect(importMarker(db)).toBe('imported')
    expect(fs.files.has(FILE)).toBe(false)
  })

  it('changes nothing on a second run', () => {
    const db = appDb()
    const fs = memoryFs({ [FILE]: legacyFile([CLAUDE, CODEX]) })
    run(db, fs)
    const before = db.all('SELECT * FROM agents ORDER BY rowid')

    run(db, memoryFs())
    run(db, memoryFs({ [FILE]: legacyFile([{ ...CLAUDE, executablePath: '/elsewhere' }]) }))

    expect(db.all('SELECT * FROM agents ORDER BY rowid')).toEqual(before)
    expect(importMarker(db)).toBe('imported')
  })

  it('skips invalid entries, repeated kinds and kinds already in the table', () => {
    const db = appDb()
    createAgentRegistry({ db, now: () => '2026-01-01T00:00:00.000Z' }).upsert({
      kind: 'codex',
      executablePath: '/current/codex',
      version: '9.0.0',
      connectedVia: 'found'
    })
    const fs = memoryFs({ [FILE]: legacyFile([CLAUDE, { ...CLAUDE, executablePath: '/dup' }, { kind: 'nope' }, CODEX]) })

    run(db, fs)

    const agents = createAgentRegistry({ db }).list()
    expect(agents.map((agent) => [agent.kind, agent.executablePath])).toEqual([
      ['codex', '/current/codex'],
      ['claude', CLAUDE.executablePath]
    ])
  })
})

describe('importLegacyAgents without a valid file', () => {
  it('marks a database with no legacy file as none', () => {
    const db = appDb()

    run(db, memoryFs())

    expect(importMarker(db)).toBe('none')
    expect(db.all('SELECT * FROM agents')).toEqual([])
  })

  it.each([
    ['invalid JSON', '{not json'],
    ['a file of the wrong shape', JSON.stringify({ version: 2, agents: [CLAUDE] })]
  ])('leaves %s in place, imports nothing, logs once and never retries', (_label, contents) => {
    const db = appDb()
    const fs = memoryFs({ [FILE]: contents })
    const log: string[] = []

    run(db, fs, log)
    run(db, fs, log)

    expect(db.all('SELECT * FROM agents')).toEqual([])
    expect(importMarker(db)).toBe('unreadable')
    expect(fs.files.get(FILE)).toBe(contents)
    expect(log).toHaveLength(1)
  })

  it('treats a read error other than a missing file as unreadable', () => {
    const db = appDb()
    const fs: MemoryFs = {
      ...memoryFs(),
      readFile: () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      }
    }

    expect(() => {
      run(db, fs)
    }).not.toThrow()
    expect(importMarker(db)).toBe('unreadable')
  })
})

describe('importLegacyAgents recovery', () => {
  it('deletes a file left behind after the commit without touching the rows', () => {
    const db = appDb()
    run(db, memoryFs({ [FILE]: legacyFile([CLAUDE]) }))
    const before = db.all('SELECT * FROM agents ORDER BY rowid')
    // A crash between the commit and the delete leaves the file next to an imported database.
    const fs = memoryFs({ [FILE]: legacyFile([CLAUDE, CODEX]) })

    run(db, fs)

    expect(fs.files.has(FILE)).toBe(false)
    expect(db.all('SELECT * FROM agents ORDER BY rowid')).toEqual(before)
  })

  it('leaves no rows and no marker when the transaction fails, and keeps the file', () => {
    const db = appDb()
    const failing: Db = {
      path: db.path,
      inTransaction: () => db.inTransaction(),
      get: (sql, ...params) => db.get(sql, ...params),
      all: (sql, ...params) => db.all(sql, ...params),
      exec: (sql) => {
        db.exec(sql)
      },
      tx: (fn) => db.tx(fn),
      close: () => {
        db.close()
      },
      run: (sql, ...params) => {
        if (sql.includes('app_meta')) {
          throw new Error('disk I/O error')
        }
        return db.run(sql, ...params)
      }
    }
    const fs = memoryFs({ [FILE]: legacyFile([CLAUDE, CODEX]) })
    const log: string[] = []

    expect(() => {
      run(failing, fs, log)
    }).not.toThrow()

    expect(db.all('SELECT * FROM agents')).toEqual([])
    expect(importMarker(db)).toBeUndefined()
    expect(fs.files.has(FILE)).toBe(true)
    expect(log).toHaveLength(1)
  })
})

describe('importLegacyAgents on the real file system', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reads and deletes the file with the default file system', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-agents-import-'))
    dirs.push(dir)
    const file = join(dir, 'agents.json')
    writeFileSync(file, legacyFile([CLAUDE]))
    const db = appDb()

    importLegacyAgents({ db, file, log: () => {} })

    expect(existsSync(file)).toBe(false)
    expect(createAgentRegistry({ db }).list()).toEqual([CLAUDE_VIEW])
  })
})
