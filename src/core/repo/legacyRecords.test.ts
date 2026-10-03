/**
 * Compatibility guard: records written before tickets carried a size and a reasoning effort must keep
 * importing, parsing, and hashing exactly as they did. The fixtures under `__mocks__/legacy/` are
 * real records copied verbatim from this repository's `.darkmechanicus/` folder.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createRepoEnv, createStubGit, importerDeps, initProject, type RepoEnv } from '../../test/repoEnv'
import { contentHash, prettyJson } from '../canonical'
import { reconcileRepository } from './importer'
import { ownedPaths } from './paths'
import {
  buildRunHistoryRecord,
  buildSnapshotRecord,
  epicPointerRecord,
  parseRecord,
  runHistoryRecord,
  snapshotRecord,
  trackedRunHash
} from './portable'

const FIXTURES = fileURLToPath(new URL('./__mocks__/legacy/', import.meta.url))
const EPIC = 'ep_01m3txy30qavmd5wewct90804g'
const REVISION = 'rv_01m3txzpv9ws6fbj6p211ghkn9'
const RUN = 'rn_01m3txzt9wj79mxsq50f5ktf1q'

/** A fixture's text with line endings normalized, as the importer's change detection reads it. */
function fixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES, ...parts), 'utf8').replace(/\r\n/g, '\n')
}

const SNAPSHOT_TEXT = fixture('epics', EPIC, 'snapshots', `${REVISION}.json`)
const RUN_TEXT = fixture('history', RUN, 'run.json')
const POINTER_TEXT = fixture('epics', EPIC, 'current.json')

/** An empty repository whose tracked records are the legacy fixtures, as after a clone. */
function legacyClone(): RepoEnv {
  const env = createRepoEnv({ root: '/legacy' })
  initProject(env)
  const paths = ownedPaths(env.layout)
  env.fs.put(join(env.layout.dmDir, 'project.json'), fixture('project.json'))
  env.fs.put(paths.epicPointerFile(EPIC), POINTER_TEXT)
  env.fs.put(paths.epicStateFile(EPIC), fixture('epics', EPIC, 'state.json'))
  env.fs.put(paths.snapshotFile(EPIC, REVISION), SNAPSHOT_TEXT)
  env.fs.put(paths.runHistoryFile(RUN), RUN_TEXT)
  return env
}

describe('a plan snapshot saved before ticket sizes and efforts', () => {
  it('parses and still matches its content hash and its pointer', () => {
    const record = parseRecord(snapshotRecord, SNAPSHOT_TEXT, 'legacy snapshot')
    const pointer = parseRecord(epicPointerRecord, POINTER_TEXT, 'legacy pointer')
    expect(contentHash(record.bundle)).toBe(record.contentHash)
    expect(record.contentHash).toBe(pointer.contentHash)
  })

  it('gains no size or effort on parsing, so it re-serializes to the same bytes', () => {
    const { bundle } = parseRecord(snapshotRecord, SNAPSHOT_TEXT, 'legacy snapshot')
    expect(bundle.tickets.length).toBeGreaterThan(0)
    for (const ticket of bundle.tickets) {
      expect(Object.keys(ticket)).not.toContain('size')
      expect(Object.keys(ticket.capability.reasoning).sort()).toEqual(['level', 'rationale'])
    }
    expect(prettyJson(parseRecord(snapshotRecord, SNAPSHOT_TEXT, 'legacy snapshot'))).toBe(SNAPSHOT_TEXT)
  })
})

describe('a run history saved before worker efforts', () => {
  it('parses without adding an effort to any worker and re-serializes to the same bytes', () => {
    const record = parseRecord(runHistoryRecord, RUN_TEXT, 'legacy run')
    expect(record.attempts.length).toBeGreaterThan(0)
    for (const attempt of record.attempts) {
      expect(Object.keys(attempt.worker)).not.toContain('effort')
    }
    expect(prettyJson(record)).toBe(RUN_TEXT)
    expect(trackedRunHash(prettyJson(record))).toBe(trackedRunHash(RUN_TEXT))
  })
})

describe('importing legacy records', () => {
  it('imports the epic and the run, and exports them back byte for byte', () => {
    const env = legacyClone()
    const result = reconcileRepository(importerDeps(env, createStubGit('main')))
    expect(result.rejected).toEqual([])
    expect(result.conflicts).toEqual([])
    expect(result.imported).toEqual([EPIC, RUN])
    const pointer = parseRecord(epicPointerRecord, POINTER_TEXT, 'legacy pointer')
    expect(env.db.get('SELECT content_hash FROM plan_revisions WHERE id = ?', REVISION)).toEqual({
      content_hash: pointer.contentHash
    })
    expect(prettyJson(buildSnapshotRecord(env.db, REVISION))).toBe(SNAPSHOT_TEXT)
    expect(trackedRunHash(prettyJson(buildRunHistoryRecord(env.db, RUN)))).toBe(trackedRunHash(RUN_TEXT))
  })
})
