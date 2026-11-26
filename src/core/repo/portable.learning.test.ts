/** Learnings and integration recovery manifests survive export, clone/import and restart in both storage modes. */
import { describe, expect, it } from 'vitest'
import { integrationManifest, LEARNING_SOURCE, publishLearning, seedLifecycle, startIntegration } from '../../test/learningFixtures'
import { copyTracked, createRepoEnv, createStubGit, flush, importerDeps, initProject, type RepoEnv } from '../../test/repoEnv'
import { contentHash, prettyJson } from '../canonical'
import { getLearning } from '../services/learnings'
import { createTestCtx } from '../../test/testContext'
import { reconcileRepository } from './importer'
import { exportMigrationRecords } from './migrationExport'
import { ownedPaths } from './paths'
import {
  buildLearningIntegrationRecord,
  buildLearningRecordFile,
  learningDefinition,
  learningIntegrationRecord,
  learningRecordFile,
  parseRecord
} from './portable'

function machine(root: string, mode: 'repo' | 'db' = 'repo'): RepoEnv {
  const env = createRepoEnv({ root, mode })
  initProject(env)
  return env
}

const reconcile = (env: RepoEnv) => reconcileRepository(importerDeps(env, createStubGit()))
const learningIds = (env: RepoEnv): string[] => env.db.all<{ id: string }>('SELECT id FROM learning_records ORDER BY id').map((row) => row.id)
/** Each learning as every reader sees it, with its whole history (sequence numbers are local and left out). */
function learningViews(env: RepoEnv): unknown[] {
  const reader = createTestCtx({ db: env.db, clock: env.clock })
  return learningIds(env).map((learningId) => {
    const { learning, history } = getLearning(reader, { learningId })
    return { learning, history: history.map(({ seq: _seq, ...entry }) => entry) }
  })
}
const learningFiles = (env: RepoEnv): string[] =>
  [...env.fs.files().keys()].filter((path) => path.includes(`${ownedPaths(env.layout).learningRecordsDir()}`) || path.includes(ownedPaths(env.layout).learningIntegrationsDir()))

describe('learning records in repository mode', () => {
  it('round-trips active, retired and replaced learnings with their provenance and unchanged hashes', () => {
    const a = machine('/machine-a')
    const ids = seedLifecycle(a)
    expect(flush(a)).toMatchObject({ failed: 0, errors: [] })
    const exported = new Map(learningIds(a).map((id) => [id, a.fs.get(ownedPaths(a.layout).learningRecordFile(id))]))
    expect([...exported.values()].every((text) => text !== undefined)).toBe(true)

    const b = machine('/machine-b')
    copyTracked(a, b)
    const result = reconcile(b)
    expect(result.rejected).toEqual([])
    expect(result.imported).toEqual(expect.arrayContaining(learningIds(a).map((id) => `learning:${id}`)))
    expect(learningViews(b)).toEqual(learningViews(a))

    const states = Object.fromEntries(learningIds(b).map((id) => [id, buildLearningRecordFile(b.db, id).learning.state]))
    expect(states).toEqual({ [ids.active]: 'active', [ids.retired]: 'retired', [ids.replaced]: 'retired', [ids.successor]: 'active' })
    const successor = buildLearningRecordFile(b.db, ids.successor)
    expect(successor.learning.replaces).toBe(ids.replaced)
    expect(successor.learning.source).toEqual(LEARNING_SOURCE)
    expect(buildLearningRecordFile(b.db, ids.replaced).learning.replacedBy).toBe(ids.successor)

    // Semantic hashes: the definition hash, and the very bytes another export from B would write.
    for (const id of learningIds(a)) {
      const record = buildLearningRecordFile(b.db, id)
      expect(record.definitionHash).toBe(buildLearningRecordFile(a.db, id).definitionHash)
      expect(record.definitionHash).toBe(contentHash(learningDefinition(record.learning)))
      expect(prettyJson(record)).toBe(exported.get(id))
    }
    // Nothing is left to export or import: the second reconcile sees every file as synced.
    expect(reconcile(b).imported).toEqual([])
  })

  it('carries a later retirement to a machine that imported the learning while it was active', () => {
    const a = machine('/machine-a')
    const learningId = publishLearning(a, 7)
    flush(a)
    const b = machine('/machine-b')
    copyTracked(a, b)
    reconcile(b)
    expect(buildLearningRecordFile(b.db, learningId).learning.state).toBe('active')

    a.db.run("UPDATE learning_records SET state = 'retired', retired_at = ?, retired_reason = 'Obsolete', revision = 2 WHERE id = ?", a.clock.nowIso(), learningId)
    a.db.run(
      `INSERT INTO learning_events (learning_id, kind, reason, revision, actor_role, actor_label, run_id, sprint_id, card_id, attempt_id, at)
       VALUES (?, 'retired', 'Obsolete', 2, 'desktop', 'Ada', ?, ?, ?, ?, ?)`,
      learningId, LEARNING_SOURCE.runId, LEARNING_SOURCE.sprintId, LEARNING_SOURCE.cardId, LEARNING_SOURCE.attemptId, a.clock.nowIso()
    )
    a.db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES ('learning_record', ?, 'pending', 't')", learningId)
    expect(flush(a).failed).toBe(0)
    copyTracked(a, b)
    expect(reconcile(b)).toMatchObject({ imported: [`learning:${learningId}`], rejected: [] })
    expect(learningViews(b)).toEqual(learningViews(a))
  })
})

describe('learning integration manifests in repository mode', () => {
  it('exports an in-progress integration manifest that a clone recovers without activating any learning', () => {
    const a = machine('/machine-a')
    const integrationId = startIntegration(a, 1)
    expect(flush(a)).toMatchObject({ failed: 0 })
    const file = a.fs.get(ownedPaths(a.layout).learningIntegrationFile(integrationId)) ?? ''
    const record = parseRecord(learningIntegrationRecord, file, 'manifest')
    expect(record).toMatchObject({ state: 'integrating', manifest: integrationManifest(), manifestHash: contentHash(integrationManifest()) })

    const b = machine('/machine-b')
    copyTracked(a, b)
    expect(reconcile(b)).toMatchObject({ imported: [`learning_integration:${integrationId}`], rejected: [] })
    expect(buildLearningIntegrationRecord(b.db, integrationId)).toEqual(buildLearningIntegrationRecord(a.db, integrationId))
    // Recovery state only: nothing is published, so no learning exists, let alone an active one.
    expect(learningIds(b)).toEqual([])
    expect(b.db.all('SELECT * FROM learning_publications')).toEqual([])
  })

  it('recovers an integration after a restart: a pending export interrupted before it ran is flushed later', () => {
    const a = machine('/machine-a')
    const integrationId = startIntegration(a, 2)
    // "Restart": a new finalizer over the same database and files; the outbox entry is still pending.
    expect(a.db.get<{ state: string }>("SELECT state FROM outbox WHERE kind = 'learning_integration'")?.state).toBe('pending')
    const restarted: RepoEnv = { ...a }
    expect(flush(restarted)).toMatchObject({ flushed: 1, failed: 0 })
    expect(a.fs.get(ownedPaths(a.layout).learningIntegrationFile(integrationId))).toBe(prettyJson(buildLearningIntegrationRecord(a.db, integrationId)))
    expect(learningIds(a)).toEqual([])
  })

  it('exports every learning and manifest when a database moves to repository storage', () => {
    const a = machine('/machine-a', 'db')
    const ids = seedLifecycle(a)
    const integrationId = startIntegration(a, 3)
    const target = createRepoEnv({ root: '/moved' })
    target.fs.mkdirp(target.layout.dmDir)
    const exported = exportMigrationRecords({ db: a.db, fs: target.fs, layout: target.layout, clock: a.clock })
    expect(exported).toEqual(new Set([...learningIds(a).map((id) => `learning_record:${id}`), `learning_integration:${integrationId}`]))
    const paths = ownedPaths(target.layout)
    expect(parseRecord(learningRecordFile, target.fs.get(paths.learningRecordFile(ids.successor)) ?? '', 'x').learning.replaces).toBe(ids.replaced)
    expect(target.fs.get(paths.learningIntegrationFile(integrationId))).toBe(prettyJson(buildLearningIntegrationRecord(a.db, integrationId)))
  })
})

describe('learning records in database mode', () => {
  it('settles the same outbox entries without writing any learning file', () => {
    const a = machine('/machine-a', 'db')
    seedLifecycle(a)
    startIntegration(a, 4)
    const kinds = a.db.all<{ kind: string }>("SELECT kind FROM outbox WHERE kind LIKE 'learning%' AND state = 'pending'").map((row) => row.kind)
    expect(new Set(kinds)).toEqual(new Set(['learning_record', 'learning_integration']))
    expect(flush(a)).toMatchObject({ failed: 0, errors: [] })
    expect(a.db.all("SELECT id FROM outbox WHERE kind LIKE 'learning%' AND state <> 'done'")).toEqual([])
    expect(learningFiles(a)).toEqual([])
    expect(a.fs.exists(ownedPaths(a.layout).learningRecordsDir())).toBe(false)
    // Restart: the learnings and the manifest are still the database's records, and reconcile reads no file.
    expect(reconcile(a)).toMatchObject({ imported: [], rejected: [] })
    expect(learningIds(a)).toHaveLength(4)
    expect(buildLearningIntegrationRecord(a.db, a.db.get<{ id: string }>('SELECT id FROM learning_integrations')?.id ?? '').state).toBe('integrating')
  })
})
