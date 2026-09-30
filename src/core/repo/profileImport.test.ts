/** Named capability profiles are reconstructed and refreshed from `.darkmechanicus/profiles/` on reconcile. */
import { describe, expect, it } from 'vitest'
import { defaultCapabilityProfile } from '../../shared/domain/bundle'
import { insertOutbox, insertProfile } from '../../test/repoFixtures'
import { copyTracked, createRepoEnv, createStubGit, flush, importerDeps, initProject, type RepoEnv } from '../../test/repoEnv'
import { reconcileRepository } from './importer'
import { ownedPaths } from './paths'
import { trackedProfileHash } from './portable'

const REVIEW = { ...defaultCapabilityProfile(), workType: 'review', reasoning: { level: 'deep', rationale: 'Careful' } }
const UPDATED = '2026-01-02T00:00:00.000Z'
const CONFLICT = 'Tracked profile ui changed while local profile changes are waiting to be exported. Flush or resolve the local changes before importing.'

/** A repository with two saved profiles, both exported. */
function profileSource(): RepoEnv {
  const source = createRepoEnv({ root: '/source' })
  initProject(source)
  insertProfile(source.db, { name: 'deep-review', description: 'Careful review', capability: REVIEW, revision: 3, updatedAt: UPDATED })
  insertProfile(source.db, { name: 'ui' })
  insertOutbox(source.db, { kind: 'profile', entityId: 'deep-review' })
  insertOutbox(source.db, { kind: 'profile', entityId: 'ui' })
  expect(flush(source).flushed).toBe(2)
  return source
}

function cloneOf(source: RepoEnv): RepoEnv {
  const target = createRepoEnv({ root: '/clone' })
  copyTracked(source, target)
  return target
}

/** The source saves `name` again (as another machine would) and exports it. */
function resave(source: RepoEnv, name: string, description: string): void {
  source.db.run('UPDATE profiles SET description = ?, revision = revision + 1, updated_at = ? WHERE name = ?', description, UPDATED, name)
  insertOutbox(source.db, { kind: 'profile', entityId: name })
  flush(source)
}

function storedProfiles(env: RepoEnv): unknown[] {
  return env.db
    .all<{ name: string; description: string; capability_json: string; revision: number; created_at: string; updated_at: string }>(
      'SELECT * FROM profiles ORDER BY name'
    )
    .map((row) => ({ ...row, capability_json: JSON.parse(row.capability_json) as unknown }))
}

function profileText(env: RepoEnv, name: string): string {
  return env.fs.get(ownedPaths(env.layout).profileFile(name)) ?? ''
}

describe('reconcileRepository profile reconstruction', () => {
  it('imports every tracked profile into a fresh clone at local revision 1', () => {
    const target = cloneOf(profileSource())
    const result = reconcileRepository(importerDeps(target, createStubGit('main')))
    expect(result).toEqual({
      imported: ['profile:deep-review', 'profile:ui'],
      unchanged: [],
      conflicts: [],
      profileConflicts: [],
      rejected: [],
      branchChanged: false,
      pausedRuns: []
    })
    expect(storedProfiles(target)).toEqual([
      { name: 'deep-review', description: 'Careful review', capability_json: REVIEW, revision: 1, created_at: '2026-01-01T00:00:00.000Z', updated_at: UPDATED },
      { name: 'ui', description: '', capability_json: defaultCapabilityProfile(), revision: 1, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' }
    ])
  })

  it('records the tracked hash of each imported profile and reports them in the reconciled event', () => {
    const target = cloneOf(profileSource())
    reconcileRepository(importerDeps(target, createStubGit('main')))
    const hash = trackedProfileHash(profileText(target, 'ui'))
    expect(target.db.get("SELECT exported_hash, imported_hash, generation, conflict FROM sync_state WHERE kind = 'profile' AND entity_id = 'ui'")).toEqual({
      exported_hash: hash,
      imported_hash: hash,
      generation: 0,
      conflict: null
    })
    const event = target.db.get<{ payload_json: string }>("SELECT payload_json FROM events WHERE kind = 'repository.reconciled'")
    expect(JSON.parse(event?.payload_json ?? '{}')).toMatchObject({ imported: ['profile:deep-review', 'profile:ui'], conflicts: 0, rejected: 0 })
  })
})

describe('reconcileRepository profile change detection', () => {
  it('leaves unchanged profiles alone and imports a changed one, bumping its local revision', () => {
    const source = profileSource()
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    expect(reconcileRepository(deps)).toMatchObject({ imported: [], unchanged: ['profile:deep-review', 'profile:ui'] })
    expect(target.db.all("SELECT seq FROM events WHERE kind = 'repository.reconciled'")).toHaveLength(1)
    resave(source, 'ui', 'Screens and flows')
    copyTracked(source, target)
    expect(reconcileRepository(deps)).toMatchObject({ imported: ['profile:ui'], unchanged: ['profile:deep-review'] })
    expect(target.db.get('SELECT description, revision, updated_at FROM profiles WHERE name = ?', 'ui')).toEqual({
      description: 'Screens and flows',
      revision: 2,
      updated_at: UPDATED
    })
  })

  it('sees its own exports as unchanged', () => {
    const source = profileSource()
    const result = reconcileRepository(importerDeps(source, createStubGit('main')))
    expect([result.imported, result.unchanged]).toEqual([[], ['profile:deep-review', 'profile:ui']])
    expect(storedProfiles(source)).toHaveLength(2)
  })
})

describe('reconcileRepository profile conflicts', () => {
  it('keeps a local profile with unexported changes and reports a conflict instead of overwriting it', () => {
    const source = profileSource()
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    target.db.run("UPDATE profiles SET description = 'Local edit', revision = 2 WHERE name = 'ui'")
    insertOutbox(target.db, { kind: 'profile', entityId: 'ui' })
    resave(source, 'ui', 'Remote edit')
    copyTracked(source, target)
    const result = reconcileRepository(deps)
    expect([result.profileConflicts, result.conflicts, result.imported]).toEqual([[{ name: 'ui', message: CONFLICT }], [], []])
    expect(target.db.get('SELECT description, revision FROM profiles WHERE name = ?', 'ui')).toEqual({ description: 'Local edit', revision: 2 })
    expect(target.db.get("SELECT conflict FROM sync_state WHERE kind = 'profile' AND entity_id = 'ui'")).toEqual({ conflict: CONFLICT })
    const events = target.db.all<{ payload_json: string }>("SELECT payload_json FROM events WHERE kind = 'repository.reconciled' ORDER BY seq")
    expect(JSON.parse(events[1]?.payload_json ?? '{}')).toMatchObject({ imported: [], conflicts: 1 })
  })

  it('clears the conflict once the local profile is exported, or imports once nothing is pending', () => {
    const source = profileSource()
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    target.db.run("UPDATE profiles SET description = 'Local edit' WHERE name = 'ui'")
    const pending = insertOutbox(target.db, { kind: 'profile', entityId: 'ui', state: 'failed', attempts: 5 })
    resave(source, 'ui', 'Remote edit')
    copyTracked(source, target)
    expect(reconcileRepository(deps).profileConflicts).toHaveLength(1)
    target.db.run("UPDATE outbox SET state = 'done' WHERE id = ?", pending)
    expect(reconcileRepository(deps)).toMatchObject({ imported: ['profile:ui'], profileConflicts: [] })
    expect(target.db.get("SELECT description FROM profiles WHERE name = 'ui'")).toEqual({ description: 'Remote edit' })
    expect(target.db.get("SELECT conflict FROM sync_state WHERE kind = 'profile' AND entity_id = 'ui'")).toEqual({ conflict: null })
  })

  it('lets the pending local save win on export, which clears the conflict', () => {
    const source = profileSource()
    const target = cloneOf(source)
    const deps = importerDeps(target, createStubGit('main'))
    reconcileRepository(deps)
    target.db.run("UPDATE profiles SET description = 'Local edit' WHERE name = 'ui'")
    insertOutbox(target.db, { kind: 'profile', entityId: 'ui' })
    resave(source, 'ui', 'Remote edit')
    copyTracked(source, target)
    reconcileRepository(deps)
    expect(flush(target).failed).toBe(0)
    expect(JSON.parse(profileText(target, 'ui'))).toMatchObject({ description: 'Local edit' })
    expect(target.db.get("SELECT conflict FROM sync_state WHERE kind = 'profile' AND entity_id = 'ui'")).toEqual({ conflict: null })
    expect(reconcileRepository(deps)).toMatchObject({ imported: [], profileConflicts: [] })
  })
})

describe('reconcileRepository profile application', () => {
  it('reports a profile the database refuses and still imports the others', () => {
    const target = cloneOf(profileSource())
    target.db.exec("CREATE TRIGGER refuse_ui BEFORE INSERT ON profiles WHEN NEW.name = 'ui' BEGIN SELECT RAISE(ABORT, 'refused'); END")
    const result = reconcileRepository(importerDeps(target, createStubGit('main')))
    expect(result.imported).toEqual(['profile:deep-review'])
    expect(result.rejected).toEqual([{ path: '.darkmechanicus/profiles/ui.json', message: 'Could not be applied: refused' }])
    expect(target.db.all('SELECT name FROM profiles')).toEqual([{ name: 'deep-review' }])
    expect(target.db.all("SELECT entity_id FROM sync_state WHERE kind = 'profile'")).toEqual([{ entity_id: 'deep-review' }])
  })

  it('imports nothing when the repository has no profiles directory', () => {
    const source = profileSource()
    const bare = createRepoEnv({ root: '/bare' })
    bare.fs.put(bare.layout.projectFile, source.fs.get(source.layout.projectFile) ?? '')
    expect(bare.fs.exists(bare.layout.profilesDir)).toBe(false)
    const result = reconcileRepository(importerDeps(bare, createStubGit('main')))
    expect(result).toMatchObject({ imported: [], unchanged: [], rejected: [], profileConflicts: [] })
  })
})
