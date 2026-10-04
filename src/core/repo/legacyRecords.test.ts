/**
 * Compatibility guard: records written before tickets carried a size, a reasoning effort, a kind and
 * covered tickets must keep importing, parsing, hashing and validating exactly as they did. The fixtures
 * under `__mocks__/legacy/` are real records copied verbatim from this repository's `.darkmechanicus/` folder.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createRepoEnv, createStubGit, importerDeps, initProject, type RepoEnv } from '../../test/repoEnv'
import { createTestCtx } from '../../test/testContext'
import { contentHash, prettyJson } from '../canonical'
import { validatePlan } from '../plan/graph'
import { reconcileRepository } from './importer'
import { readProject } from './initialize'
import { attemptView, type AttemptRow } from '../services/execution'
import { getSprintReport } from '../services/reports'
import { ownedPaths } from './paths'
import {
  buildRunHistoryRecord,
  buildSnapshotRecord,
  epicPointerRecord,
  parseRecord,
  projectRecord,
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

  it('gains no kind or covers on parsing, so it is made of work tickets only', () => {
    const { bundle } = parseRecord(snapshotRecord, SNAPSHOT_TEXT, 'legacy snapshot')
    for (const ticket of bundle.tickets) {
      expect(Object.keys(ticket)).not.toContain('kind')
      for (const item of ticket.acceptanceCriteria) {
        expect(Object.keys(item)).not.toContain('covers')
      }
    }
  })

  it('validates with warnings only: each sprint lacks an acceptance node, and nothing is an error', () => {
    const { bundle } = parseRecord(snapshotRecord, SNAPSHOT_TEXT, 'legacy snapshot')
    const report = validatePlan(bundle)
    expect(report.errors).toEqual([])
    expect(report.valid).toBe(true)
    const missing = report.warnings.filter((issue) => issue.code === 'missing_acceptance_node')
    expect(missing.map((issue) => issue.sprintIds)).toEqual(bundle.sprints.map((sprint) => [sprint.id]))
    expect(report.warnings.filter((issue) => issue.code === 'ticket_not_covered')).toEqual([])
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

describe('a run history saved before row checks', () => {
  it('parses without a rowChecks key and re-serializes to the same bytes', () => {
    const record = parseRecord(runHistoryRecord, RUN_TEXT, 'legacy run')
    expect(Object.keys(record)).not.toContain('rowChecks')
    expect(RUN_TEXT).not.toContain('rowChecks')
    expect(prettyJson(record)).toBe(RUN_TEXT)
  })

  it('imports with no row checks and exports back without the key', () => {
    const env = legacyClone()
    reconcileRepository(importerDeps(env, createStubGit('main')))
    expect(env.db.all('SELECT id FROM row_checks')).toEqual([])
    const exported = prettyJson(buildRunHistoryRecord(env.db, RUN))
    expect(exported).not.toContain('rowChecks')
    expect(trackedRunHash(exported)).toBe(trackedRunHash(RUN_TEXT))
  })
})

describe('a project record saved before the Definition of Done', () => {
  const PROJECT_TEXT = fixture('project.json')

  it('parses without a definitionOfDone key and re-serializes to the same bytes', () => {
    const record = parseRecord(projectRecord, PROJECT_TEXT, 'legacy project')
    expect(Object.keys(record)).not.toContain('definitionOfDone')
    expect(PROJECT_TEXT).not.toContain('definitionOfDone')
    expect(prettyJson(record)).toBe(PROJECT_TEXT)
  })

  it('imports with the rest of the repository and reads as a project with no checks', () => {
    const env = legacyClone()
    expect(reconcileRepository(importerDeps(env, createStubGit('main'))).rejected).toEqual([])
    expect(readProject(env.layout, env.fs)?.definitionOfDone).toBeUndefined()
  })
})

describe('a run history saved before sprint increments', () => {
  it('parses without an increment on any attempt and re-serializes to the same bytes', () => {
    const record = parseRecord(runHistoryRecord, RUN_TEXT, 'legacy run')
    expect(record.attempts.length).toBeGreaterThan(0)
    for (const attempt of record.attempts) {
      expect(Object.keys(attempt)).not.toContain('increment')
    }
    expect(RUN_TEXT).not.toContain('increment')
    expect(prettyJson(record)).toBe(RUN_TEXT)
  })

  it('imports with no verdict on any attempt and exports back without the key', () => {
    const env = legacyClone()
    reconcileRepository(importerDeps(env, createStubGit('main')))
    expect(env.db.all('SELECT id FROM attempts WHERE increment_json IS NOT NULL')).toEqual([])
    const exported = prettyJson(buildRunHistoryRecord(env.db, RUN))
    expect(exported).not.toContain('increment')
    expect(trackedRunHash(exported)).toBe(trackedRunHash(RUN_TEXT))
  })

  it('has no increment on its attempt views, and no sprint with an increment', () => {
    const env = legacyClone()
    reconcileRepository(importerDeps(env, createStubGit('main')))
    const rows = env.db.all<AttemptRow>('SELECT * FROM attempts')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(Object.keys(attemptView(row))).not.toContain('increment')
    }
  })
})

describe('a run history saved before sprint retros', () => {
  it('parses a report without a retro key and re-serializes it to the same bytes', () => {
    const record = parseRecord(runHistoryRecord, RUN_TEXT, 'legacy run')
    expect(record.reports.length).toBeGreaterThan(0)
    for (const report of record.reports) {
      expect(Object.keys(report.content)).not.toContain('retro')
    }
    expect(RUN_TEXT).not.toContain('retro')
    expect(prettyJson(record)).toBe(RUN_TEXT)
    expect(trackedRunHash(prettyJson(record))).toBe(trackedRunHash(RUN_TEXT))
  })

  it('imports its report and exports it back without the key, byte for byte', () => {
    const env = legacyClone()
    reconcileRepository(importerDeps(env, createStubGit('main')))
    const exported = prettyJson(buildRunHistoryRecord(env.db, RUN))
    expect(exported).not.toContain('retro')
    expect(exported).toBe(RUN_TEXT)
    expect(trackedRunHash(exported)).toBe(trackedRunHash(RUN_TEXT))
  })

  it('reads the imported report with retro: null and the content hash it was saved with', () => {
    const env = legacyClone()
    reconcileRepository(importerDeps(env, createStubGit('main')))
    const saved = parseRecord(runHistoryRecord, RUN_TEXT, 'legacy run').reports[0]
    const view = getSprintReport(createTestCtx({ db: env.db }), { runId: RUN, sprintId: saved?.sprintId ?? '' })
    expect(view?.report.retro).toBeNull()
    expect(view?.report.summary).toBe(saved?.content.summary)
    expect(view?.contentHash).toBe(saved?.contentHash)
  })

  it('shows its sprint tickets with the attempts that were recorded, none escalated and no efforts', () => {
    const env = legacyClone()
    reconcileRepository(importerDeps(env, createStubGit('main')))
    const saved = parseRecord(runHistoryRecord, RUN_TEXT, 'legacy run').reports[0]
    const facts = getSprintReport(createTestCtx({ db: env.db }), { runId: RUN, sprintId: saved?.sprintId ?? '' })?.tierFacts ?? []
    expect(facts.length).toBeGreaterThan(0)
    expect(facts.flatMap((item) => item.attempts).length).toBeGreaterThan(0)
    for (const item of facts) {
      expect(item.escalated).toBe(false)
      for (const entry of item.attempts) {
        expect(entry.effort).toBeNull()
      }
    }
  })

  it('still finds the imported report in search by its text', () => {
    const env = legacyClone()
    reconcileRepository(importerDeps(env, createStubGit('main')))
    const found = env.db.all<{ doc_id: string }>(`SELECT doc_id FROM search_index WHERE doc_type = 'report' AND search_index MATCH ?`, 'connectivity')
    expect(found.map((row) => row.doc_id)).toEqual([parseRecord(runHistoryRecord, RUN_TEXT, 'legacy run').reports[0]?.id])
  })
})
