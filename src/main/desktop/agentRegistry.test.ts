import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createAgentRegistry, type AgentConnection, type RegistryFs } from './agentRegistry'

interface MemoryFs extends RegistryFs {
  files: Map<string, string>
  /** Paths passed to writeFile, in order. */
  writes: string[]
  /** Completed renames as `from -> to`, in order. */
  renames: string[]
  faults: { rename: boolean }
}

function createMemoryFs(): MemoryFs {
  const files = new Map<string, string>()
  const writes: string[] = []
  const renames: string[] = []
  const faults = { rename: false }
  return {
    files,
    writes,
    renames,
    faults,
    readFile(path) {
      const data = files.get(path)
      if (data === undefined) {
        throw new Error(`ENOENT: ${path}`)
      }
      return data
    },
    writeFile(path, data) {
      writes.push(path)
      files.set(path, data)
    },
    rename(from, to) {
      if (faults.rename) {
        throw new Error('EIO: rename failed')
      }
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      renames.push(`${from} -> ${to}`)
    },
    mkdirp() {}
  }
}

const REGISTRY_FILE = join(sep, 'state', 'agents.json')
const TEMP_FILE = `${REGISTRY_FILE}.tmp`

/** Deterministic timestamps: 00:00:01, 00:00:02, … */
function counterNow(): () => string {
  let tick = 0
  return () => {
    tick += 1
    return `2026-01-01T00:00:0${tick}.000Z`
  }
}

function memoryRegistry(fs: MemoryFs) {
  return createAgentRegistry({ file: REGISTRY_FILE, fs, now: counterNow() })
}

function connection(kind: AgentConnection['kind'], overrides: Partial<AgentConnection> = {}): AgentConnection {
  return { kind, executablePath: `/usr/bin/${kind}`, version: '1.0.0', connectedVia: 'found', ...overrides }
}

function storedEntry(kind: string): Record<string, unknown> {
  return {
    kind,
    executablePath: `/usr/bin/${kind}`,
    version: '1.0.0',
    connectedVia: 'found',
    connectedAt: '2026-01-01T00:00:01.000Z',
    lastProbed: '2026-01-01T00:00:01.000Z'
  }
}

describe('createAgentRegistry listing', () => {
  it('returns an empty list when agents.json is missing', () => {
    const registry = memoryRegistry(createMemoryFs())

    expect(registry.list()).toEqual([])
  })

  it('returns an empty list when agents.json is unreadable', () => {
    const fs = createMemoryFs()
    fs.files.set(REGISTRY_FILE, '{not json')

    expect(memoryRegistry(fs).list()).toEqual([])
  })

  it('leaves a corrupt file in place until the next successful write', () => {
    const fs = createMemoryFs()
    fs.files.set(REGISTRY_FILE, '{not json')
    const registry = memoryRegistry(fs)

    expect(registry.list()).toEqual([])
    expect(fs.files.get(REGISTRY_FILE)).toBe('{not json')

    registry.upsert(connection('claude'))

    expect(JSON.parse(fs.files.get(REGISTRY_FILE) ?? 'null').agents).toHaveLength(1)
  })

  it('reads the agents stored in a valid file', () => {
    const fs = createMemoryFs()
    fs.files.set(REGISTRY_FILE, JSON.stringify({ version: 1, agents: [storedEntry('claude')] }))

    expect(memoryRegistry(fs).list()).toEqual([storedEntry('claude')])
  })

  it('skips entries that fail validation and keeps the first entry of a repeated kind', () => {
    const fs = createMemoryFs()
    const repeated = { ...storedEntry('claude'), executablePath: '/elsewhere/claude' }
    fs.files.set(
      REGISTRY_FILE,
      JSON.stringify({
        version: 1,
        agents: [storedEntry('claude'), repeated, storedEntry('gemini'), { kind: 'codex' }, storedEntry('cursor')]
      })
    )

    const list = memoryRegistry(fs).list()

    expect(list.map((agent) => agent.kind)).toEqual(['claude', 'cursor'])
    expect(list[0]?.executablePath).toBe('/usr/bin/claude')
  })
})

describe('createAgentRegistry upsert', () => {
  it('adds an entry for a new kind', () => {
    const registry = memoryRegistry(createMemoryFs())

    const result = registry.upsert(connection('claude'))

    expect(result).toEqual(storedEntry('claude'))
    expect(registry.list()).toEqual([storedEntry('claude')])
  })

  it('replaces the entry for the same kind so there is one per kind', () => {
    const registry = memoryRegistry(createMemoryFs())
    registry.upsert(connection('claude'))

    registry.upsert(connection('claude', { executablePath: '/opt/claude', version: '2.0.0', connectedVia: 'downloaded' }))

    const list = registry.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ executablePath: '/opt/claude', version: '2.0.0', connectedVia: 'downloaded' })
  })

  it('keeps entries of other kinds', () => {
    const registry = memoryRegistry(createMemoryFs())

    registry.upsert(connection('claude'))
    registry.upsert(connection('codex', { connectedVia: 'downloaded' }))

    expect(registry.list().map((agent) => agent.kind)).toEqual(['claude', 'codex'])
  })

  it('stamps both timestamps on insert and keeps connectedAt on replacement', () => {
    const registry = memoryRegistry(createMemoryFs())

    const first = registry.upsert(connection('claude'))
    const second = registry.upsert(connection('claude', { version: '2.0.0' }))

    expect(first.connectedAt).toBe('2026-01-01T00:00:01.000Z')
    expect(first.lastProbed).toBe('2026-01-01T00:00:01.000Z')
    expect(second.connectedAt).toBe(first.connectedAt)
    expect(second.lastProbed).toBe('2026-01-01T00:00:02.000Z')
  })
})

describe('createAgentRegistry writes', () => {
  it('writes every change to a temp file and renames it over agents.json', () => {
    const fs = createMemoryFs()
    const registry = memoryRegistry(fs)

    registry.upsert(connection('claude'))
    registry.upsert(connection('codex'))
    registry.remove('claude')

    expect(fs.writes).toEqual([TEMP_FILE, TEMP_FILE, TEMP_FILE])
    expect(fs.renames).toEqual(Array(3).fill(`${TEMP_FILE} -> ${REGISTRY_FILE}`))
    expect(fs.files.has(TEMP_FILE)).toBe(false)
  })

  it('persists a versioned file', () => {
    const fs = createMemoryFs()

    memoryRegistry(fs).upsert(connection('claude'))

    expect(JSON.parse(fs.files.get(REGISTRY_FILE) ?? 'null')).toEqual({ version: 1, agents: [storedEntry('claude')] })
  })

  it('leaves the registry unchanged when a write fails, and succeeds on retry', () => {
    const fs = createMemoryFs()
    const registry = memoryRegistry(fs)
    fs.faults.rename = true

    expect(() => registry.upsert(connection('claude'))).toThrow('EIO')
    expect(registry.list()).toEqual([])
    expect(fs.files.has(REGISTRY_FILE)).toBe(false)

    fs.faults.rename = false
    registry.upsert(connection('claude'))

    expect(registry.list()).toHaveLength(1)
  })
})

describe('createAgentRegistry remove', () => {
  it('drops only the entry for that kind', () => {
    const registry = memoryRegistry(createMemoryFs())
    registry.upsert(connection('claude'))
    registry.upsert(connection('codex'))

    registry.remove('claude')

    expect(registry.list().map((agent) => agent.kind)).toEqual(['codex'])
  })

  it('never touches the executable', () => {
    const fs = createMemoryFs()
    fs.files.set('/usr/bin/claude', 'binary')
    const registry = memoryRegistry(fs)
    registry.upsert(connection('claude'))

    registry.remove('claude')

    expect(fs.files.get('/usr/bin/claude')).toBe('binary')
    expect(fs.writes.every((path) => path === TEMP_FILE)).toBe(true)
  })

  it('does not write when the kind is not in the registry', () => {
    const fs = createMemoryFs()
    const registry = memoryRegistry(fs)
    registry.upsert(connection('claude'))
    const writesBefore = fs.writes.length

    registry.remove('codex')

    expect(fs.writes).toHaveLength(writesBefore)
    expect(registry.list()).toHaveLength(1)
  })
})

describe('createAgentRegistry files that are not a registry', () => {
  it.each([
    ['a file of another version', { version: 2, agents: [storedEntry('claude')] }],
    ['a file without an agents list', { version: 1 }],
    ['a list instead of an object', [storedEntry('claude')]]
  ])('lists nothing for %s', (_name, content) => {
    const fs = createMemoryFs()
    fs.files.set(REGISTRY_FILE, JSON.stringify(content))

    expect(memoryRegistry(fs).list()).toEqual([])
  })

  it('replaces one kind among several and leaves the others as they were', () => {
    const registry = memoryRegistry(createMemoryFs())
    registry.upsert(connection('claude'))
    const codex = registry.upsert(connection('codex'))

    registry.upsert(connection('claude', { version: '3.0.0' }))

    expect(registry.list()).toMatchObject([{ kind: 'claude', version: '3.0.0' }, codex])
  })
})

describe('createAgentRegistry on the real file system', () => {
  it('creates its folder and file, stamps real times, and reads them back', () => {
    const folder = mkdtempSync(join(tmpdir(), 'dm-registry-'))
    const file = join(folder, 'nested', 'agents.json')
    try {
      const before = Date.now()
      const added = createAgentRegistry({ file }).upsert(connection('claude'))

      const reopened = createAgentRegistry({ file }).list()
      expect(Date.parse(added.connectedAt)).toBeGreaterThanOrEqual(before)
      expect(Date.parse(added.lastProbed)).toBeLessThanOrEqual(Date.now())
      expect(reopened).toEqual([added])
      expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
      expect(readdirSync(join(folder, 'nested'))).toEqual(['agents.json'])
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
