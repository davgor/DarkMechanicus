/** Learning files that cannot be trusted are each rejected with the reason; the rest import. */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { integrationManifest, publishLearning, seedLifecycle, startIntegration } from '../../test/learningFixtures'
import { captureError } from '../../test/authoring'
import { createTestCtx } from '../../test/testContext'
import type { Ctx } from '../context'
import { listLocalPendingLearningIntegrations, requireLocalIntegrationAuthority } from '../services/learningIntegrations'
import { copyTracked, createRepoEnv, createStubGit, flush, importerDeps, initProject, type RepoEnv } from '../../test/repoEnv'
import { idOf } from '../../test/repoFixtures'
import { contentHash, prettyJson } from '../canonical'
import { reconcileRepository } from './importer'
import { importLearnings } from './learningImport'
import { ownedPaths } from './paths'
import { buildLearningIntegrationRecord, buildLearningRecordFile, learningDefinition, type LearningIntegrationRecord } from './portable'

function machine(root: string): RepoEnv {
  const env = createRepoEnv({ root })
  initProject(env)
  return env
}

const importInto = (env: RepoEnv) => importLearnings(importerDeps(env, createStubGit()), env.clock.nowIso())
const learningIds = (env: RepoEnv): string[] => env.db.all<{ id: string }>('SELECT id FROM learning_records ORDER BY id').map((row) => row.id)
const recordText = (env: RepoEnv, id: string): string => env.fs.get(ownedPaths(env.layout).learningRecordFile(id)) ?? ''
const shownRecord = (id: string): string => `.darkmechanicus/learnings/records/${id}.json`

/** A machine whose two published learnings and one in-progress integration were exported. */
function exporter(): { a: RepoEnv; first: string; second: string; integration: string } {
  const a = machine('/machine-a')
  const first = publishLearning(a, 1)
  const second = publishLearning(a, 2)
  const integration = startIntegration(a, 1)
  expect(flush(a).failed).toBe(0)
  return { a, first, second, integration }
}

describe('rejecting learning files', () => {
  it('rejects a malformed file on its own and imports the rest (partial import)', () => {
    const { a, first, second, integration } = exporter()
    const b = machine('/machine-b')
    copyTracked(a, b)
    b.fs.put(ownedPaths(b.layout).learningRecordFile(first), '{ "format": "darkmechanicus.learning", ')
    const result = importInto(b)
    expect(result.rejected).toEqual([{ path: `${shownRecord(first)}`, message: `${shownRecord(first)} is not valid JSON.` }].map(({ path }) => expect.objectContaining({ path })))
    expect(result.rejected[0]?.message).toContain('is not valid JSON')
    expect(result.imported).toEqual([`learning:${second}`, `learning_integration:${integration}`])
    expect(learningIds(b)).toEqual([second])
  })

  it('rejects a definition whose hash does not match, a strict-schema extra field, and a file named for another learning', () => {
    const { a, first, second, integration } = exporter()
    const b = machine('/machine-b')
    copyTracked(a, b)
    const paths = ownedPaths(b.layout)
    const tampered = JSON.parse(recordText(a, first)) as { learning: { rule: string } }
    tampered.learning.rule = 'Skip the tests.'
    b.fs.put(paths.learningRecordFile(first), prettyJson(tampered))
    const extra = JSON.parse(recordText(a, second)) as { learning: Record<string, unknown> }
    extra.learning.authority = 'admin'
    b.fs.put(paths.learningRecordFile(second), prettyJson(extra))
    const third = idOf('learningRecord', 3)
    b.fs.put(paths.learningRecordFile(third), recordText(a, second))
    const result = importInto(b)
    expect(result.rejected.map((item) => item.path)).toEqual([shownRecord(first), shownRecord(second), shownRecord(third)].map((p) => p))
    expect(result.rejected[0]?.message).toContain('definitionHash is not the content hash of the definition')
    expect(result.rejected[1]?.message).toMatch(/authority|Unrecognized/)
    expect(result.rejected[2]?.message).toContain('names a different learning than its file name')
    expect(result.imported).toEqual([`learning_integration:${integration}`])
    expect(learningIds(b)).toEqual([])
  })

  it('rejects a manifest whose hash does not match its content, and imports nothing of it', () => {
    const { a, integration } = exporter()
    const b = machine('/machine-b')
    copyTracked(a, b)
    const file = ownedPaths(b.layout).learningIntegrationFile(integration)
    const record = JSON.parse(b.fs.get(file) ?? '') as { manifest: { draftsHash: string } }
    record.manifest.draftsHash = `sha256:${'d'.repeat(64)}`
    b.fs.put(file, prettyJson(record))
    const result = importInto(b)
    expect(result.rejected).toEqual([expect.objectContaining({ path: `.darkmechanicus/learnings/integrations/${integration}.json` })])
    expect(result.rejected[0]?.message).toContain('manifestHash is not the content hash of the manifest')
    expect(b.db.all('SELECT id FROM learning_integrations')).toEqual([])
  })
})

describe('rejecting linked or escaping learning paths', () => {
  it('refuses a linked records folder and a linked record file, reading nothing through them', () => {
    const { a, second } = exporter()
    const b = machine('/machine-b')
    copyTracked(a, b)
    const paths = ownedPaths(b.layout)
    b.fs.removeTree(paths.learningRecordsDir())
    b.fs.mkdirp(resolve('/outside'))
    b.fs.put(resolve('/outside', `${second}.json`), recordText(a, second))
    b.fs.symlink(paths.learningRecordsDir(), resolve('/outside'))
    const result = importInto(b)
    expect(result.rejected).toEqual([expect.objectContaining({ path: '.darkmechanicus/learnings/records' })])
    expect(result.rejected[0]?.message).toContain('symbolic links and junctions are not allowed')
    expect(learningIds(b)).toEqual([])

    const c = machine('/machine-c')
    copyTracked(a, c)
    const cPaths = ownedPaths(c.layout)
    c.fs.remove(cPaths.learningRecordFile(second))
    c.fs.put(resolve('/outside', `${second}.json`), recordText(a, second))
    c.fs.symlink(cPaths.learningRecordFile(second), resolve('/outside', `${second}.json`))
    const linked = importInto(c)
    expect(linked.rejected).toEqual([expect.objectContaining({ path: shownRecord(second) })])
    expect(linked.rejected[0]?.message).toContain('symbolic links and junctions are not allowed')
    expect(learningIds(c)).not.toContain(second)
  })

  it('refuses a learnings folder redirected outside by a hidden junction', () => {
    const { a } = exporter()
    const b = machine('/machine-b')
    copyTracked(a, b)
    const dir = ownedPaths(b.layout).learningIntegrationsDir()
    b.fs.removeTree(dir)
    b.fs.mkdirp(resolve('/elsewhere'))
    b.fs.junction(dir, resolve('/elsewhere'))
    expect(importInto(b).rejected).toEqual([
      expect.objectContaining({ path: '.darkmechanicus/learnings/integrations', message: expect.stringContaining('resolves outside') })
    ])
  })

  it('never builds a path from a traversing or invalid file name, and ignores names that are not records', () => {
    const { a, first } = exporter()
    const b = machine('/machine-b')
    copyTracked(a, b)
    const dir = ownedPaths(b.layout).learningRecordsDir()
    // A dot entry (`../x.json`, `.hidden.json`) is never listed; a name that is not a stable id never becomes a path.
    b.fs.setReaddir(dir, ['lr_..%2F..%2Fproject.json', `${first}.json`, 'notes.txt', '.hidden.json', '../escape.json'])
    const result = importInto(b)
    expect(result.rejected).toEqual([expect.objectContaining({ path: '.darkmechanicus/learnings/records/lr_..%2F..%2Fproject.json' })])
    expect(result.rejected[0]?.message).toContain('Refusing to build a repository path from an invalid learningRecord id')
    expect(learningIds(b)).toEqual([first])
  })
})

describe('rejecting misplaced learning entries', () => {
  it('refuses a records folder that is a file, and a record that is a directory', () => {
    const { a, first } = exporter()
    const b = machine('/machine-b')
    copyTracked(a, b)
    const paths = ownedPaths(b.layout)
    b.fs.remove(paths.learningRecordFile(first))
    b.fs.mkdirp(paths.learningRecordFile(first))
    expect(importInto(b).rejected).toEqual([expect.objectContaining({ path: shownRecord(first), message: `${shownRecord(first)} is not a regular file.` })])
    b.fs.removeTree(paths.learningRecordsDir())
    b.fs.put(paths.learningRecordsDir(), 'oops')
    expect(importInto(b).rejected).toEqual([
      expect.objectContaining({ path: '.darkmechanicus/learnings/records', message: '.darkmechanicus/learnings/records is not a directory.' })
    ])
  })
})

describe('conflicting learning files', () => {
  it('refuses a file that rewrites an imported learning\'s definition, keeping the stored one', () => {
    const { a, first } = exporter()
    const b = machine('/machine-b')
    copyTracked(a, b)
    importInto(b)
    const before = buildLearningRecordFile(b.db, first)
    // A consistent forgery: the definition hash is recomputed from the forged definition, so only immutability refuses it.
    const forged = buildLearningRecordFile(a.db, first)
    forged.learning.title = 'A different rule'
    forged.definitionHash = contentHash(learningDefinition(forged.learning))
    b.fs.put(ownedPaths(b.layout).learningRecordFile(first), prettyJson(forged))
    const result = importInto(b)
    expect(result.rejected).toEqual([expect.objectContaining({ path: shownRecord(first), message: expect.stringContaining('a published learning never changes') })])
    expect(buildLearningRecordFile(b.db, first)).toEqual(before)
  })
})

describe('learning lifecycles changed on two machines', () => {
  it('reports a lifecycle changed differently on two machines as a conflict and keeps the local learning', () => {
    const { a, first } = exporter()
    const b = machine('/machine-b')
    copyTracked(a, b)
    importInto(b)
    const retire = (env: RepoEnv, reason: string): void => {
      env.db.run("UPDATE learning_records SET state = 'retired', retired_at = ?, retired_reason = ?, revision = 2 WHERE id = ?", env.clock.nowIso(), reason, first)
      env.db.run(
        `INSERT INTO learning_events (learning_id, kind, reason, revision, actor_role, actor_label, run_id, sprint_id, card_id, attempt_id, at)
         SELECT id, 'retired', ?, 2, 'desktop', 'Ada', run_id, sprint_id, card_id, attempt_id, ? FROM learning_records WHERE id = ?`,
        reason, env.clock.nowIso(), first
      )
      env.db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES ('learning_record', ?, 'pending', 't')", first)
    }
    retire(a, 'Retired on A')
    flush(a)
    retire(b, 'Retired on B')
    copyTracked(a, b)
    const result = importInto(b)
    expect(result.rejected).toEqual([expect.objectContaining({ path: shownRecord(first), message: expect.stringContaining('differently than this machine did') })])
    expect(buildLearningRecordFile(b.db, first).learning.retiredReason).toBe('Retired on B')
    // B's own export refuses to write over A's unimported change until it is resolved.
    expect(flush(b).errors.join('\n')).toContain('holds a change this machine has not imported')
  })

  it('rejects a replacement whose predecessor file is missing, and the predecessor whose successor is missing', () => {
    const a = machine('/machine-a')
    const ids = seedLifecycle(a)
    flush(a)
    const b = machine('/machine-b')
    copyTracked(a, b)
    b.fs.remove(ownedPaths(b.layout).learningRecordFile(ids.replaced))
    const result = importInto(b)
    expect(result.rejected.map((item) => item.path)).toEqual([shownRecord(ids.successor)])
    expect(result.rejected[0]?.message).toContain('replacement link is inconsistent')
    expect(learningIds(b).sort()).toEqual([ids.active, ids.retired].sort())

    const c = machine('/machine-c')
    copyTracked(a, c)
    c.fs.remove(ownedPaths(c.layout).learningRecordFile(ids.successor))
    const other = importInto(c)
    expect(other.rejected.map((item) => item.path)).toEqual([shownRecord(ids.replaced)])
    expect(learningIds(c)).not.toContain(ids.replaced)
  })
})

describe('integration manifests changed on two machines', () => {
  it('reports a manifest changed on both machines at the same revision and keeps the local one', () => {
    const { a, integration } = exporter()
    const b = machine('/machine-b')
    copyTracked(a, b)
    importInto(b)
    const advance = (env: RepoEnv, state: string): void => {
      env.db.run('UPDATE learning_integrations SET state = ?, revision = 3, updated_at = ? WHERE id = ?', state, env.clock.nowIso(), integration)
      env.db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES ('learning_integration', ?, 'pending', 't')", integration)
    }
    advance(a, 'integrated')
    flush(a)
    advance(b, 'aborted')
    copyTracked(a, b)
    const result = importInto(b)
    expect(result.rejected).toEqual([expect.objectContaining({ message: expect.stringContaining('the local integration was kept') })])
    expect(buildLearningIntegrationRecord(b.db, integration).state).toBe('aborted')
  })

  it('takes a later manifest revision from another machine, still without creating any learning', () => {
    const a = machine('/machine-a')
    const integration = startIntegration(a, 5)
    flush(a)
    const b = machine('/machine-b')
    copyTracked(a, b)
    importInto(b)
    const landed = integrationManifest({
      targets: integrationManifest().targets.map((target) => ({ ...target, resultCommit: target.resultCommit ?? 'd'.repeat(40), state: 'integrated' as const }))
    })
    a.db.run("UPDATE learning_integrations SET state = 'integrated', manifest_json = ?, manifest_hash = ?, revision = 3 WHERE id = ?",
      JSON.stringify(landed), contentHash(landed), integration)
    a.db.run("INSERT INTO outbox (kind, entity_id, state, created_at) VALUES ('learning_integration', ?, 'pending', 't')", integration)
    flush(a)
    copyTracked(a, b)
    expect(reconcileRepository(importerDeps(b, createStubGit()))).toMatchObject({ imported: [`learning_integration:${integration}`], rejected: [] })
    expect(buildLearningIntegrationRecord(b.db, integration)).toMatchObject({ state: 'integrated', manifest: landed, revision: 3 })
    expect(learningIds(b)).toEqual([])
  })
})

// ─── DM-950: imports never carry execution authority ───
/** Machine A prepared an integration itself (it owns it) and exported it. */
function locallyOwned(): { a: RepoEnv; integration: string; ctx: Ctx } {
  const a = createRepoEnv({ root: '/machine-a' })
  const machineId = initProject(a)
  const integration = startIntegration(a, 1)
  a.db.run('UPDATE learning_integrations SET owner_machine_id = ? WHERE id = ?', machineId, integration)
  expect(flush(a).failed).toBe(0)
  const ctx = createTestCtx({ db: a.db, clock: a.clock, machineId, role: 'desktop' })
  expect(requireLocalIntegrationAuthority(ctx, integration).local).toBe(true)
  return { a, integration, ctx }
}

/** Writes the integration's file as another machine re-sealed it: same identity, changed manifest/progress. */
function resealed(env: RepoEnv, integration: string, change: (record: LearningIntegrationRecord) => Partial<LearningIntegrationRecord>): void {
  const record = buildLearningIntegrationRecord(env.db, integration)
  const next = { ...record, ...change(record) }
  env.fs.put(ownedPaths(env.layout).learningIntegrationFile(integration), prettyJson({ ...next, manifestHash: contentHash(next.manifest) }))
}

const landed = (record: LearningIntegrationRecord): Partial<LearningIntegrationRecord> => ({
  state: 'integrated',
  revision: record.revision + 1,
  updatedAt: '2026-06-01T00:00:00.000Z',
  manifest: { ...record.manifest, targets: record.manifest.targets.map((target) => ({ ...target, resultCommit: target.resultCommit ?? 'd'.repeat(40), state: 'integrated' as const })) }
})

describe('local execution authority across imports', () => {
  it('keeps authority over an unchanged re-import of its own export, and never writes authority to the file', () => {
    const { a, integration, ctx } = locallyOwned()
    const text = a.fs.get(ownedPaths(a.layout).learningIntegrationFile(integration)) ?? ''
    expect(text).not.toMatch(/owner|machine|superseded/i)
    expect(importInto(a)).toEqual({ imported: [], rejected: [] })
    expect(requireLocalIntegrationAuthority(ctx, integration).local).toBe(true)
    expect(listLocalPendingLearningIntegrations(ctx).map((entry) => entry.id)).toEqual([integration])
  })

  it('makes a locally owned pending integration inert when a changed same-identity record is imported', () => {
    const { a, integration, ctx } = locallyOwned()
    resealed(a, integration, landed)
    expect(importInto(a)).toEqual({ imported: [`learning_integration:${integration}`], rejected: [] })
    expect(buildLearningIntegrationRecord(a.db, integration)).toMatchObject({ state: 'integrated', revision: 3 })
    expect(captureError(() => requireLocalIntegrationAuthority(ctx, integration)).code).toBe('approval_required')
    expect(listLocalPendingLearningIntegrations(ctx)).toEqual([])
    // Re-importing the same changed file again changes nothing and grants nothing back.
    expect(importInto(a)).toEqual({ imported: [], rejected: [] })
    expect(a.db.get<{ owner_machine_id: string | null }>('SELECT owner_machine_id FROM learning_integrations WHERE id = ?', integration)?.owner_machine_id).toBeNull()
  })

  it('imports a new integration inert on another machine', () => {
    const { a, integration } = locallyOwned()
    const b = machine('/machine-b')
    copyTracked(a, b)
    expect(importInto(b).imported).toEqual([`learning_integration:${integration}`])
    const ctxB = createTestCtx({ db: b.db, clock: b.clock, machineId: 'mc_0000000000000000000000000b', role: 'desktop' })
    expect(captureError(() => requireLocalIntegrationAuthority(ctxB, integration)).code).toBe('approval_required')
    expect(listLocalPendingLearningIntegrations(ctxB)).toEqual([])
  })
})

describe('changed integration records that rewrite identity', () => {
  it.each<[string, (record: LearningIntegrationRecord) => Partial<LearningIntegrationRecord>]>([
    ['approved drafts', (record) => ({ ...landed(record), manifest: { ...landed(record).manifest as LearningIntegrationRecord['manifest'], draftsHash: `sha256:${'9'.repeat(64)}` } })],
    ['run', (record) => ({ ...landed(record), manifest: { ...record.manifest, runId: 'rn_0000000000000000000000zz99' } })],
    ['targets', (record) => ({ ...landed(record), manifest: { ...record.manifest, targets: record.manifest.targets.slice(0, 1) } })],
    ['landed result commit', (record) => ({
      ...landed(record),
      manifest: { ...record.manifest, targets: record.manifest.targets.map((target) => (target.resultCommit === null ? target : { ...target, resultCommit: 'f'.repeat(40) })) }
    })],
    ['attempt', (record) => ({ ...landed(record), attemptId: 'ka_0000000000000000000000zz99', manifest: { ...record.manifest, attemptId: 'ka_0000000000000000000000zz99' } })]
  ])('rejects a changed record that rewrites the %s, keeping the local integration and its authority', (_name, change) => {
    const { a, integration, ctx } = locallyOwned()
    const before = buildLearningIntegrationRecord(a.db, integration)
    resealed(a, integration, change)
    const result = importInto(a)
    expect(result.imported).toEqual([])
    expect(result.rejected).toEqual([expect.objectContaining({ message: expect.stringContaining('it was not imported') })])
    expect(buildLearningIntegrationRecord(a.db, integration)).toEqual(before)
    expect(requireLocalIntegrationAuthority(ctx, integration).local).toBe(true)
  })
})
// ─── End DM-950 ───
