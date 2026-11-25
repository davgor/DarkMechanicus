/** Learning files whose history or revision differs from the stored learning: forward changes import, the rest wait or are refused. */
import { describe, expect, it } from 'vitest'
import { publishLearning, seedLifecycle, startIntegration } from '../../test/learningFixtures'
import { copyTracked, createRepoEnv, createStubGit, flush, importerDeps, initProject, type RepoEnv } from '../../test/repoEnv'
import { idOf } from '../../test/repoFixtures'
import { createTestCtx, withRole } from '../../test/testContext'
import { prettyJson } from '../canonical'
import { retireLearning } from '../services/learnings'
import { importLearnings } from './learningImport'
import { ownedPaths } from './paths'
import { buildLearningIntegrationRecord, buildLearningRecordFile, MAX_LEARNING_RECORD_BYTES, trackedLearningRecordHash } from './portable'
import type { FsAdapter } from './types'

function machine(root: string): RepoEnv {
  const env = createRepoEnv({ root })
  initProject(env)
  return env
}

const importInto = (env: RepoEnv) => importLearnings(importerDeps(env, createStubGit()), env.clock.nowIso())
const learningIds = (env: RepoEnv): string[] => env.db.all<{ id: string }>('SELECT id FROM learning_records ORDER BY id').map((row) => row.id)
const shownRecord = (id: string): string => `.darkmechanicus/learnings/records/${id}.json`
const shownIntegration = (id: string): string => `.darkmechanicus/learnings/integrations/${id}.json`

/** Rewrites a file with the same content in another layout: its text (and tracked hash) changes, its record does not. */
function reformat(env: RepoEnv, path: string): string {
  const compact = JSON.stringify(JSON.parse(env.fs.get(path) ?? ''))
  env.fs.put(path, compact)
  return compact
}

/** Machine B holding everything machine A exported and imported once. */
function importedPair(seed: (a: RepoEnv) => void): { a: RepoEnv; b: RepoEnv } {
  const a = machine('/machine-a')
  seed(a)
  expect(flush(a).failed).toBe(0)
  const b = machine('/machine-b')
  copyTracked(a, b)
  expect(importInto(b).rejected).toEqual([])
  return { a, b }
}

const retire = (env: RepoEnv, learningId: string, reason: string) =>
  retireLearning(withRole(createTestCtx({ db: env.db, clock: env.clock }), 'desktop'), { learningId, expectedRevision: 1, reason })

describe('learning folders and files refused before they are read', () => {
  it('refuses a records folder holding more files than the limit, and still imports the integrations', () => {
    const a = machine('/machine-a')
    const first = publishLearning(a, 1)
    const integration = startIntegration(a, 1)
    flush(a)
    const b = machine('/machine-b')
    copyTracked(a, b)
    const dir = ownedPaths(b.layout).learningRecordsDir()
    b.fs.setReaddir(dir, [`${first}.json`, ...Array.from({ length: 10_000 }, (_, index) => `lr_${index}.json`)])
    expect(importInto(b)).toEqual({
      imported: [`learning_integration:${integration}`],
      rejected: [{ path: '.darkmechanicus/learnings/records', message: '.darkmechanicus/learnings/records holds more than 10000 files.' }]
    })
    expect(learningIds(b)).toEqual([])
  })

  it('refuses a record larger than the learning limit and a listed record that is gone, importing the rest', () => {
    const a = machine('/machine-a')
    const first = publishLearning(a, 1)
    const second = publishLearning(a, 2)
    flush(a)
    const b = machine('/machine-b')
    copyTracked(a, b)
    const paths = ownedPaths(b.layout)
    const ghost = idOf('learningRecord', 3)
    b.fs.setSize(paths.learningRecordFile(first), MAX_LEARNING_RECORD_BYTES + 1)
    b.fs.setReaddir(paths.learningRecordsDir(), [`${first}.json`, `${second}.json`, `${ghost}.json`])
    expect(importInto(b)).toEqual({
      imported: [`learning:${second}`],
      rejected: [
        { path: shownRecord(first), message: `${shownRecord(first)} is larger than the 1 MiB learning record limit.` },
        { path: `.darkmechanicus/learnings/records/${ghost}.json`, message: `${shownRecord(ghost)} is missing.` }
      ]
    })
    expect(learningIds(b)).toEqual([second])
  })
})

describe('learning folders that cannot be listed', () => {
  it('reports a folder failure that is not an Error by its own text', () => {
    const a = machine('/machine-a')
    publishLearning(a, 1)
    flush(a)
    const b = machine('/machine-b')
    copyTracked(a, b)
    const denied = new Proxy(b.fs, {
      get(target, prop) {
        if (prop === 'readdir') {
          return () => {
            throw 'EACCES: the records folder cannot be listed'
          }
        }
        const value: unknown = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) satisfies FsAdapter
    const result = importLearnings({ ...importerDeps(b, createStubGit()), fs: denied }, b.clock.nowIso())
    // Only the records folder exists, so only it is listed and refused.
    expect(result.rejected).toEqual([{ path: '.darkmechanicus/learnings/records', message: 'EACCES: the records folder cannot be listed' }])
    expect(learningIds(b)).toEqual([])
  })
})

describe('a whole replacement chain imported at once', () => {
  it('inserts each predecessor before its replacement, so every learning and link imports in one step', () => {
    const { a, b } = importedPair((env) => void seedLifecycle(env))
    const ids = learningIds(a)
    expect(ids).toHaveLength(4)
    expect(learningIds(b)).toEqual(ids)
    for (const id of ids) expect(buildLearningRecordFile(b.db, id)).toEqual(buildLearningRecordFile(a.db, id))
  })
})

describe('a learning file whose history matches the stored one', () => {
  it('takes a reformatted but unchanged file as synced, importing and refusing nothing', () => {
    const { b } = importedPair((env) => void publishLearning(env, 1))
    const [first = ''] = learningIds(b)
    const text = reformat(b, ownedPaths(b.layout).learningRecordFile(first))
    expect(importInto(b)).toEqual({ imported: [], rejected: [] })
    expect(b.db.get<{ imported_hash: string }>("SELECT imported_hash FROM sync_state WHERE kind = 'learning_record' AND entity_id = ?", first)?.imported_hash).toBe(
      trackedLearningRecordHash(text)
    )
  })

  it('refuses a file whose lifecycle differs from the stored one under the same history', () => {
    let retired = ''
    const { b } = importedPair((env) => {
      retired = seedLifecycle(env).retired
    })
    const file = ownedPaths(b.layout).learningRecordFile(retired)
    const record = buildLearningRecordFile(b.db, retired)
    b.fs.put(file, prettyJson({ ...record, learning: { ...record.learning, retiredReason: 'Rewritten elsewhere' } }))
    expect(importInto(b).rejected).toEqual([
      { path: shownRecord(retired), message: `${shownRecord(retired)} records a different lifecycle for learning ${retired} than its history.` }
    ])
    expect(buildLearningRecordFile(b.db, retired).learning.retiredReason).toBe('No longer needed')
  })

  it('refuses a file whose revision differs from the stored revision under the same history', () => {
    const { b } = importedPair((env) => void publishLearning(env, 1))
    const [first = ''] = learningIds(b)
    b.db.run('UPDATE learning_records SET revision = 7 WHERE id = ?', first)
    reformat(b, ownedPaths(b.layout).learningRecordFile(first))
    expect(importInto(b).rejected).toEqual([
      { path: shownRecord(first), message: `${shownRecord(first)} records a different lifecycle for learning ${first} than its history.` }
    ])
  })
})

describe('a learning file whose history differs from the stored one', () => {
  it('fast-forwards a lifecycle change made on another machine', () => {
    const { a, b } = importedPair((env) => void publishLearning(env, 1))
    const [first = ''] = learningIds(a)
    retire(a, first, 'Retired on A')
    flush(a)
    copyTracked(a, b)
    expect(importInto(b)).toEqual({ imported: [`learning:${first}`], rejected: [] })
    expect(buildLearningRecordFile(b.db, first)).toEqual(buildLearningRecordFile(a.db, first))
    expect(buildLearningRecordFile(b.db, first).learning).toMatchObject({ state: 'retired', retiredReason: 'Retired on A' })
  })

  it('keeps a later local change over an older file, importing and refusing nothing', () => {
    const { b } = importedPair((env) => void publishLearning(env, 1))
    const [first = ''] = learningIds(b)
    retire(b, first, 'Retired on B')
    reformat(b, ownedPaths(b.layout).learningRecordFile(first))
    expect(importInto(b)).toEqual({ imported: [], rejected: [] })
    expect(buildLearningRecordFile(b.db, first)).toMatchObject({ revision: 2, learning: { state: 'retired', retiredReason: 'Retired on B' } })
  })
})

describe('integration manifests', () => {
  it('refuses a manifest stored under another integration\'s file name, importing the real one', () => {
    const a = machine('/machine-a')
    const integration = startIntegration(a, 1)
    flush(a)
    const b = machine('/machine-b')
    copyTracked(a, b)
    const paths = ownedPaths(b.layout)
    const misnamed = idOf('learningIntegration', 9)
    b.fs.put(paths.learningIntegrationFile(misnamed), b.fs.get(paths.learningIntegrationFile(integration)) ?? '')
    expect(importInto(b)).toEqual({
      imported: [`learning_integration:${integration}`],
      rejected: [{ path: shownIntegration(misnamed), message: `${shownIntegration(misnamed)} names a different learning integration than its file name.` }]
    })
  })

  it('imports an aborted integration with its recorded failure', () => {
    let integration = ''
    const failure = { code: 'merge_conflict', message: 'The web repository conflicted.' }
    const { b } = importedPair((env) => {
      integration = startIntegration(env, 1)
      env.db.run("UPDATE learning_integrations SET state = 'aborted', failure_json = ? WHERE id = ?", JSON.stringify(failure), integration)
    })
    expect(buildLearningIntegrationRecord(b.db, integration)).toMatchObject({ state: 'aborted', failure })
  })
})

describe('integration manifests this machine already holds', () => {
  it('takes a reformatted but unchanged manifest as synced, importing and refusing nothing', () => {
    let integration = ''
    const { b } = importedPair((env) => {
      integration = startIntegration(env, 1)
    })
    reformat(b, ownedPaths(b.layout).learningIntegrationFile(integration))
    expect(importInto(b)).toEqual({ imported: [], rejected: [] })
  })

  it('keeps a later local revision over an older manifest, importing and refusing nothing', () => {
    let integration = ''
    const { b } = importedPair((env) => {
      integration = startIntegration(env, 1)
    })
    b.db.run("UPDATE learning_integrations SET state = 'aborted', revision = 3 WHERE id = ?", integration)
    reformat(b, ownedPaths(b.layout).learningIntegrationFile(integration))
    expect(importInto(b)).toEqual({ imported: [], rejected: [] })
    expect(buildLearningIntegrationRecord(b.db, integration)).toMatchObject({ state: 'aborted', revision: 3 })
  })

  it('reports a manifest the database refuses as not applied, with the database reason', () => {
    const a = machine('/machine-a')
    const integration = startIntegration(a, 1)
    flush(a)
    const b = machine('/machine-b')
    // B already integrates the same card: only one open integration per card is allowed.
    const local = startIntegration(b, 7)
    copyTracked(a, b)
    const result = importInto(b)
    expect(result.imported).toEqual([])
    expect(result.rejected).toEqual([{ path: shownIntegration(integration), message: expect.stringMatching(/^Could not be applied: UNIQUE constraint failed/) }])
    expect(b.db.all<{ id: string }>('SELECT id FROM learning_integrations').map((row) => row.id)).toEqual([local])
  })
})
