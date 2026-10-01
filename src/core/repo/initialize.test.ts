import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMemoryFs, type MemoryFs } from '../../test/memoryFs'
import { domainErrorOf, T0 } from '../../test/repoFixtures'
import { createTempRepo, type TempRepo } from '../../test/tempRepo'
import { createSequentialIds, createTestClock } from '../../test/testContext'
import { prettyJson } from '../canonical'
import { encodeBase32, ID_PREFIXES, type IdKind } from '../ids'
import { resolveLayout } from './layout'
import { deriveKeyPrefix, ensureMachineId, initializeRepository, readProject } from './initialize'
import { nodeFs } from './nodeFs'
import { parseRecord, projectRecord } from './portable'

const ROOT = resolve('/work/new-service')

function seqId(kind: IdKind, n: number): string {
  return `${ID_PREFIXES[kind]}_${encodeBase32(BigInt(n), 26)}`
}
const layout = resolveLayout(ROOT)

function deps(fs: MemoryFs = createMemoryFs()): Parameters<typeof initializeRepository>[0] & { fs: MemoryFs } {
  return { layout, fs, ids: createSequentialIds(), clock: createTestClock() }
}

describe('deriveKeyPrefix', () => {
  it.each([
    ['new-service', 'NS'],
    ['DarkMechanicus', 'DM'],
    ['darkmechanicus', 'DAR'],
    ['my-cool-app', 'MCA'],
    ['a-b-c-d-e', 'ABCD'],
    ['XMLParser', 'XP'],
    ['the_quick brown.fox', 'TQBF'],
    ['go', 'GO'],
    ['api2-service', 'AS'],
    ['2fast', 'DM'],
    ['', 'DM'],
    ['---', 'DM']
  ])('derives %s → %s', (name, prefix) => {
    expect(deriveKeyPrefix(name)).toBe(prefix)
  })
})

describe('initializeRepository on a fresh folder', () => {
  it('creates the layout, gitignore, project, and machine files', () => {
    const d = deps()
    const result = initializeRepository(d, {})
    expect(result).toEqual({
      projectId: seqId('project', 1),
      name: 'new-service',
      keyPrefix: 'NS',
      createdFiles: ['.darkmechanicus/.gitignore', '.darkmechanicus/project.json', '.darkmechanicus/local/machine.json'],
      alreadyInitialized: false,
      machineId: seqId('machine', 2)
    })
    for (const dir of [layout.epicsDir, layout.historyDir, layout.profilesDir, layout.localDir]) {
      expect(d.fs.isDirectory(dir)).toBe(true)
    }
    expect(d.fs.get(layout.gitignoreFile)).toBe('local/\n')
    expect(parseRecord(projectRecord, d.fs.get(layout.projectFile) ?? '', 'p')).toEqual({
      format: 'darkmechanicus.project',
      formatVersion: 1,
      projectId: seqId('project', 1),
      name: 'new-service',
      keyPrefix: 'NS',
      createdAt: T0
    })
    expect(JSON.parse(d.fs.get(layout.machineFile) ?? '{}')).toEqual({ machineId: seqId('machine', 2), createdAt: T0 })
  })

  it('uses an explicit trimmed name and key prefix', () => {
    const result = initializeRepository(deps(), { name: '  Payments Platform ', keyPrefix: 'PAY' })
    expect([result.name, result.keyPrefix]).toEqual(['Payments Platform', 'PAY'])
  })

  it('derives the prefix from an explicit name and falls back to the folder name for a blank one', () => {
    expect(initializeRepository(deps(), { name: 'Billing Engine' }).keyPrefix).toBe('BE')
    expect(initializeRepository(deps(), { name: '   ' }).name).toBe('new-service')
  })

  it('rejects an invalid key prefix or an overlong name before writing anything', () => {
    const d = deps()
    expect(domainErrorOf(() => initializeRepository(d, { keyPrefix: 'bad' })).code).toBe('invalid_input')
    expect(domainErrorOf(() => initializeRepository(d, { name: 'x'.repeat(201) })).code).toBe('invalid_input')
    expect(initializeRepository(deps(), { name: 'x'.repeat(200) }).name).toHaveLength(200)
    expect(d.fs.writes).toEqual([])
  })
})

describe('initializeRepository when repeated', () => {
  it('never changes an existing project and reports it as already initialized', () => {
    const d = deps()
    const first = initializeRepository(d, { name: 'First' })
    const projectText = d.fs.get(layout.projectFile)
    const again = initializeRepository(d, { name: 'Second', keyPrefix: 'SEC' })
    expect(again).toEqual({ ...first, createdFiles: [], alreadyInitialized: true })
    expect(d.fs.get(layout.projectFile)).toBe(projectText)
  })

  it('restores missing pieces without touching existing ones', () => {
    const d = deps()
    initializeRepository(d, {})
    d.fs.put(layout.gitignoreFile, 'local/\n*.bak\n')
    d.fs.remove(layout.machineFile)
    const result = initializeRepository(d, {})
    expect(result.createdFiles).toEqual(['.darkmechanicus/local/machine.json'])
    expect(result.alreadyInitialized).toBe(true)
    expect(d.fs.get(layout.gitignoreFile)).toBe('local/\n*.bak\n')
  })

  it('refuses to overwrite a corrupt project file', () => {
    const d = deps()
    d.fs.put(layout.projectFile, '{"format":"something-else"}')
    expect(domainErrorOf(() => initializeRepository(d, {})).code).toBe('import_rejected')
    expect(d.fs.get(layout.projectFile)).toBe('{"format":"something-else"}')
  })

  it('refuses a linked .darkmechanicus directory', () => {
    const d = deps()
    d.fs.mkdirp(resolve('/elsewhere'))
    d.fs.symlink(layout.dmDir, resolve('/elsewhere'))
    expect(domainErrorOf(() => initializeRepository(d, {})).code).toBe('unsafe_path')
    expect(d.fs.files().size).toBe(0)
  })
})

describe('readProject and ensureMachineId', () => {
  it('reads a valid project, returns null when missing, and rejects invalid files', () => {
    const fs = createMemoryFs()
    expect(readProject(layout, fs)).toBeNull()
    const project = { format: 'darkmechanicus.project', formatVersion: 1, projectId: seqId('project', 9), name: 'X', keyPrefix: 'X', createdAt: T0 }
    fs.put(layout.projectFile, prettyJson(project))
    expect(readProject(layout, fs)).toEqual(project)
    fs.put(layout.projectFile, '<<<<<<< HEAD\n')
    expect(domainErrorOf(() => readProject(layout, fs)).code).toBe('import_rejected')
  })

  it('creates local/ and a machine id in a fresh clone, then keeps it', () => {
    const d = deps()
    d.fs.put(layout.projectFile, '{}')
    const machineId = ensureMachineId(d)
    expect(machineId).toBe(seqId('machine', 1))
    expect(ensureMachineId(d)).toBe(machineId)
    d.fs.put(layout.machineFile, '{"machineId":"not-an-id"}')
    expect(domainErrorOf(() => ensureMachineId(d)).code).toBe('import_rejected')
  })
})

describe('initializeRepository on disk', () => {
  let repo: TempRepo | undefined

  afterEach(() => {
    repo?.cleanup()
    repo = undefined
  })

  it('writes real files that git will ignore under local/', () => {
    repo = createTempRepo()
    const result = initializeRepository({ layout: repo.layout, fs: nodeFs, ids: createSequentialIds(), clock: createTestClock() }, {})
    expect(result.name).toBe('repo')
    expect(readFileSync(join(repo.root, '.darkmechanicus', '.gitignore'), 'utf8')).toBe('local/\n')
    expect(readProject(repo.layout, nodeFs)?.projectId).toBe(result.projectId)
  })
})
