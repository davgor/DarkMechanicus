/** The project record's optional Definition of Done: how it parses, and how the app writes it back. */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createMemoryFs, type MemoryFs } from '../../test/memoryFs'
import { domainErrorOf } from '../../test/repoFixtures'
import { createSequentialIds, createTestClock } from '../../test/testContext'
import { prettyJson } from '../canonical'
import { initializeRepository, readProject } from './initialize'
import { resolveLayout } from './layout'
import { parseRecord, projectRecord } from './portable'
import { writeDefinitionOfDone } from './projectConfig'

const ROOT = resolve('/work/service')
const layout = resolveLayout(ROOT)
const PATH = '.darkmechanicus/project.json'

const LINT = { name: 'lint', command: 'npm run lint', description: 'oxlint over src and scripts' }
const TEST = { name: 'test', command: 'npm test', description: 'The unit tests' }

const OLD_PROJECT = {
  format: 'darkmechanicus.project',
  formatVersion: 1,
  projectId: 'pj_00000000000000000000000001',
  name: 'Demo',
  keyPrefix: 'DM',
  createdAt: '2026-01-01T00:00:00.000Z'
}

function initialized(): { fs: MemoryFs; deps: { layout: typeof layout; fs: MemoryFs } } {
  const fs = createMemoryFs()
  initializeRepository({ layout, fs, ids: createSequentialIds(), clock: createTestClock() }, { name: 'Demo' })
  return { fs, deps: { layout, fs } }
}

describe('the project record before a Definition of Done existed', () => {
  it('parses unchanged: no definitionOfDone appears and it re-serializes to the same text', () => {
    const text = prettyJson(OLD_PROJECT)
    const record = parseRecord(projectRecord, text, PATH)
    expect(Object.keys(record)).not.toContain('definitionOfDone')
    expect(prettyJson(record)).toBe(text)
  })

  it('reads as a project with no checks', () => {
    const { fs } = initialized()
    expect(readProject(layout, fs)?.definitionOfDone).toBeUndefined()
  })
})

describe('the project record with a Definition of Done', () => {
  it('parses the checks in order, and a missing description reads as empty', () => {
    const text = prettyJson({ ...OLD_PROJECT, definitionOfDone: [LINT, { name: 'build', command: 'npm run build' }] })
    expect(parseRecord(projectRecord, text, PATH).definitionOfDone).toEqual([
      LINT,
      { name: 'build', command: 'npm run build', description: '' }
    ])
  })

  it('accepts an empty list', () => {
    expect(parseRecord(projectRecord, prettyJson({ ...OLD_PROJECT, definitionOfDone: [] }), PATH).definitionOfDone).toEqual([])
  })

  it.each([
    ['a blank name', [{ ...LINT, name: '   ' }]],
    ['a blank command', [{ ...LINT, command: '' }]],
    ['an unknown member', [{ ...LINT, timeout: 5 }]],
    ['a name that matches another one ignoring case and spacing', [LINT, { ...TEST, name: ' LINT ' }]],
    ['more than 50 checks', Array.from({ length: 51 }, (_unused, index) => ({ ...LINT, name: `check ${index}` }))]
  ])('rejects %s', (_label, definitionOfDone) => {
    const text = prettyJson({ ...OLD_PROJECT, definitionOfDone })
    expect(domainErrorOf(() => parseRecord(projectRecord, text, PATH)).code).toBe('import_rejected')
  })

  it('rejects a definition that is not a list', () => {
    const text = prettyJson({ ...OLD_PROJECT, definitionOfDone: LINT })
    expect(domainErrorOf(() => parseRecord(projectRecord, text, PATH)).code).toBe('import_rejected')
  })
})

describe('writeDefinitionOfDone: what is written', () => {
  it('writes the checks into project.json with sorted keys, two-space indent and a trailing newline', () => {
    const { fs, deps } = initialized()
    const before = readProject(layout, fs)
    writeDefinitionOfDone(deps, [LINT, TEST])
    const text = fs.get(layout.projectFile) ?? ''
    expect(text).toBe(prettyJson({ ...before, definitionOfDone: [LINT, TEST] }))
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "definitionOfDone": [\n    {\n      "command": "npm run lint",\n      "description"')
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      'createdAt',
      'definitionOfDone',
      'format',
      'formatVersion',
      'keyPrefix',
      'name',
      'projectId'
    ])
  })

  it('changes nothing else in the record and returns what it wrote', () => {
    const { fs, deps } = initialized()
    const before = readProject(layout, fs)
    const written = writeDefinitionOfDone(deps, [LINT])
    expect(written).toEqual({ ...before, definitionOfDone: [LINT] })
    expect(readProject(layout, fs)).toEqual(written)
  })

})

describe('writeDefinitionOfDone: replacing and clearing', () => {
  it('replaces the whole list, trims names and commands, and fills a missing description', () => {
    const { fs, deps } = initialized()
    writeDefinitionOfDone(deps, [LINT, TEST])
    writeDefinitionOfDone(deps, [{ name: ' build ', command: ' npm run build ', description: undefined }])
    expect(readProject(layout, fs)?.definitionOfDone).toEqual([{ name: 'build', command: 'npm run build', description: '' }])
  })

  it('drops the key when the list is emptied, so the file returns to its earlier shape', () => {
    const { fs, deps } = initialized()
    const original = fs.get(layout.projectFile)
    writeDefinitionOfDone(deps, [LINT])
    expect(writeDefinitionOfDone(deps, []).definitionOfDone).toBeUndefined()
    expect(fs.get(layout.projectFile)).toBe(original)
  })

  it('refuses an invalid list and leaves the file as it was', () => {
    const { fs, deps } = initialized()
    const original = fs.get(layout.projectFile)
    const refused = domainErrorOf(() => writeDefinitionOfDone(deps, [LINT, { ...TEST, name: 'LINT' }]))
    expect(refused.code).toBe('invalid_input')
    expect(refused.message).toMatch(/unique.*"LINT".*"lint"/)
    expect(fs.get(layout.projectFile)).toBe(original)
  })

  it('refuses when the repository has no project record', () => {
    const fs = createMemoryFs()
    fs.mkdirp(layout.dmDir)
    expect(domainErrorOf(() => writeDefinitionOfDone({ layout, fs }, [LINT])).code).toBe('not_initialized')
  })

  it('leaves no temporary file behind', () => {
    const { fs, deps } = initialized()
    writeDefinitionOfDone(deps, [LINT])
    expect([...fs.files().keys()].filter((path) => path.includes('.tmp-'))).toEqual([])
  })
})
