/** Ticket 013.5: hostile repository records are rejected without outside reads/writes or DB changes. */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeBundle, makeTicket, tid } from '../../test/bundles'
import { isWithin } from '../../test/memoryFs'
import { domainErrorOf, idOf, insertAttempt, insertOutbox, insertProfile, insertRun } from '../../test/repoFixtures'
import {
  copyTracked,
  createRepoEnv,
  createStubGit,
  dumpDomain,
  flush,
  importerDeps,
  initProject,
  type RepoEnv,
  saveRevision
} from '../../test/repoEnv'
import { contentHash, prettyJson } from '../canonical'
import { LIMITS } from '../schemas'
import type { PlanBundle } from '../../shared/domain/bundle'
import { reconcileRepository } from './importer'
import { ownedPaths } from './paths'
import { MAX_RECORD_BYTES, parseRecord, profileRecord } from './portable'
import { MAX_PROFILE_BYTES, MAX_PROFILES } from './profileImport'

const EPIC = idOf('epic', 1)
const R1 = idOf('revision', 1)
const R9 = idOf('revision', 9)
const RUN = idOf('run', 1)
const OUTSIDE = resolve('/outside')

interface Imported {
  target: RepoEnv
  before: Record<string, unknown[]>
  readsBefore: number
}

/** A clone that already imported one epic and one run: the "previously imported state". */
function imported(): Imported {
  const source = createRepoEnv({ root: '/source' })
  initProject(source)
  saveRevision(source, { epicId: EPIC, revisionId: R1, number: 1, bundle: makeBundle([[1, 2]], [[1, 2]]) })
  insertRun(source.db, { id: RUN, epicId: EPIC, revisionId: R1, state: 'completed' })
  insertAttempt(source.db, { id: idOf('attempt', 1), runId: RUN, ticketId: tid(1), revisionId: R1 })
  insertOutbox(source.db, { kind: 'run_history', runId: RUN })
  flush(source)
  const target = createRepoEnv({ root: '/clone' })
  copyTracked(source, target)
  expect(reconcileRepository(importerDeps(target, createStubGit('main'))).imported).toEqual([EPIC, RUN])
  return { target, before: dumpDomain(target.db), readsBefore: target.fs.reads.length }
}

function reconcile(state: Imported): ReturnType<typeof reconcileRepository> {
  return reconcileRepository(importerDeps(state.target, createStubGit('main')))
}

function outsideReads(state: Imported): string[] {
  return state.target.fs.reads.slice(state.readsBefore).filter((path) => !isWithin(state.target.layout.dmDir, path))
}

function paths(state: Imported): ReturnType<typeof ownedPaths> {
  return ownedPaths(state.target.layout)
}

function editJson(state: Imported, path: string, edit: (value: Record<string, unknown>) => unknown): void {
  const value = JSON.parse(state.target.fs.get(path) ?? '{}') as Record<string, unknown>
  state.target.fs.put(path, prettyJson(edit(value)))
}

function writeSnapshot(state: Imported, revisionId: string, bundle: PlanBundle, hash = contentHash(bundle)): void {
  const record = JSON.parse(state.target.fs.get(paths(state).snapshotFile(EPIC, R1)) ?? '{}') as Record<string, unknown>
  state.target.fs.put(paths(state).snapshotFile(EPIC, revisionId), prettyJson({ ...record, revisionId, number: 9, contentHash: hash, bundle }))
}

/** Makes the epic's tracked state differ from the last sync, as a pull that changed the epic would. */
function touchEpic(state: Imported): void {
  editJson(state, paths(state).epicStateFile(EPIC), (value) => ({ ...value, updatedAt: '2026-02-02T00:00:00.000Z' }))
}

function expectUnchanged(state: Imported, result: ReturnType<typeof reconcileRepository>): void {
  expect(result.imported).toEqual([])
  expect(dumpDomain(state.target.db)).toEqual(state.before)
  expect(outsideReads(state)).toEqual([])
}

const EPIC_DIR = `.darkmechanicus/epics/${EPIC}`

describe('hostile directory names', () => {
  it('ignores dot entries and rejects traversal-like or malformed epic directory names', () => {
    const state = imported()
    const names = ['..', '.', '.DS_Store', '../../etc', 'ep_..', 'ep_../x', EPIC.toUpperCase(), 'ep_short', idOf('ticket', 1), EPIC]
    state.target.fs.setReaddir(state.target.layout.epicsDir, names)
    const result = reconcile(state)
    const invalid = 'Refusing to build a repository path from an invalid epic id.'
    expect(result.rejected).toEqual(
      ['ep_..', 'ep_../x', EPIC.toUpperCase(), 'ep_short', idOf('ticket', 1)].sort().map((name) => ({
        path: `.darkmechanicus/epics/${name}`,
        message: invalid
      }))
    )
    expect(result.unchanged).toEqual([EPIC, RUN])
    expectUnchanged(state, result)
  })

  it('rejects malformed snapshot file names and run directory names', () => {
    const state = imported()
    state.target.fs.put(join(paths(state).snapshotsDir(EPIC), 'rv_bad.json'), '{}')
    state.target.fs.put(join(state.target.layout.historyDir, 'rn_bad', 'run.json'), '{}')
    touchEpic(state)
    const result = reconcile(state)
    expect(result.rejected).toEqual([
      { path: EPIC_DIR, message: 'Refusing to build a repository path from an invalid revision id.' },
      { path: '.darkmechanicus/history/rn_bad', message: 'Refusing to build a repository path from an invalid run id.' }
    ])
    expectUnchanged(state, result)
  })
})

describe('hostile links', () => {
  it('fails closed on a linked epics directory without reading outside', () => {
    const state = imported()
    state.target.fs.put(join(OUTSIDE, EPIC, 'current.json'), state.target.fs.get(paths(state).epicPointerFile(EPIC)) ?? '')
    state.target.fs.symlink(state.target.layout.epicsDir, OUTSIDE)
    const error = domainErrorOf(() => reconcile(state))
    expect(error.code).toBe('unsafe_path')
    expect(dumpDomain(state.target.db)).toEqual(state.before)
    expect(outsideReads(state)).toEqual([])
  })

  it('rejects a linked snapshots directory without reading outside', () => {
    const state = imported()
    state.target.fs.put(join(OUTSIDE, 'snaps', `${R1}.json`), state.target.fs.get(paths(state).snapshotFile(EPIC, R1)) ?? '')
    state.target.fs.symlink(paths(state).snapshotsDir(EPIC), join(OUTSIDE, 'snaps'))
    touchEpic(state)
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: expect.stringContaining('symbolic links and junctions are not allowed') }])
    expectUnchanged(state, result)
  })

  it('rejects an unreported redirect whose real path leaves the repository', () => {
    const state = imported()
    state.target.fs.put(join(OUTSIDE, 'snaps', `${R1}.json`), state.target.fs.get(paths(state).snapshotFile(EPIC, R1)) ?? '')
    state.target.fs.junction(paths(state).snapshotsDir(EPIC), join(OUTSIDE, 'snaps'))
    touchEpic(state)
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: expect.stringContaining('resolves outside .darkmechanicus') }])
    expectUnchanged(state, result)
  })

  it('rejects a linked run history directory', () => {
    const state = imported()
    state.target.fs.put(join(OUTSIDE, 'run', 'run.json'), state.target.fs.get(paths(state).runHistoryFile(RUN)) ?? '')
    state.target.fs.symlink(paths(state).runDir(RUN), join(OUTSIDE, 'run'))
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/history/${RUN}`, message: expect.stringContaining('symbolic links') }])
    expectUnchanged(state, result)
  })
})

describe('hostile file contents', () => {
  it('rejects unresolved merge markers', () => {
    const state = imported()
    const pointer = paths(state).epicPointerFile(EPIC)
    state.target.fs.put(pointer, `<<<<<<< HEAD\n${state.target.fs.get(pointer) ?? ''}=======\n{}\n>>>>>>> theirs\n`)
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: `${EPIC_DIR}/current.json contains unresolved merge conflict markers.` }])
    expectUnchanged(state, result)
  })

  it('rejects an oversized record without reading it', () => {
    const state = imported()
    const stateFile = paths(state).epicStateFile(EPIC)
    state.target.fs.put(stateFile, ' '.repeat(MAX_RECORD_BYTES + 1))
    state.target.fs.failOn({ op: 'readFile', match: (path) => path === stateFile })
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: `${EPIC_DIR}/state.json is larger than the 8 MiB record limit.` }])
    expectUnchanged(state, result)
  })
})

describe('hostile sizes', () => {
  it('rejects an epic whose snapshots exceed the byte budget, and too many snapshots, without reading them', () => {
    const state = imported()
    const snapshot = paths(state).snapshotFile(EPIC, R1)
    state.target.fs.setSize(snapshot, 256 * 1024 * 1024 + 1)
    state.target.fs.failOn({ op: 'readFile', match: (path) => path === snapshot })
    touchEpic(state)
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: `${EPIC_DIR}/snapshots holds more than 256 MiB of snapshots.` }])
    expectUnchanged(state, result)

    const crowded = imported()
    const names = Array.from({ length: 1_001 }, (_, index) => `${idOf('revision', index + 100)}.json`)
    crowded.target.fs.setReaddir(paths(crowded).snapshotsDir(EPIC), names)
    touchEpic(crowded)
    const tooMany = reconcile(crowded)
    expect(tooMany.rejected).toEqual([{ path: EPIC_DIR, message: `${EPIC_DIR}/snapshots holds more than 1000 snapshots.` }])
  })

  it('accepts snapshots exactly at the byte budget', () => {
    const state = imported()
    const bundle = makeBundle([[1, 2]], [[1, 2]])
    const revisions = [R1, ...Array.from({ length: 31 }, (_, index) => idOf('revision', index + 100))]
    for (const revisionId of revisions) {
      if (revisionId !== R1) {
        writeSnapshot(state, revisionId, bundle)
      }
      state.target.fs.setSize(paths(state).snapshotFile(EPIC, revisionId), MAX_RECORD_BYTES)
    }
    touchEpic(state)
    const result = reconcile(state)
    expect(result.rejected).toEqual([])
    expect(result.imported).toEqual([EPIC])
    expect(state.target.db.all('SELECT id FROM plan_revisions')).toHaveLength(32)
  })

})

describe('unchanged epics', () => {
  it('does not re-read the snapshots of an epic whose tracked state is unchanged', () => {
    const state = imported()
    const snapshot = paths(state).snapshotFile(EPIC, R1)
    state.target.fs.put(snapshot, '<<<<<<< HEAD\n')
    const result = reconcile(state)
    expect(result).toMatchObject({ imported: [], unchanged: [EPIC, RUN], rejected: [] })
    expect(state.target.fs.reads.slice(state.readsBefore)).not.toContain(snapshot)
    expect(dumpDomain(state.target.db)).toEqual(state.before)
  })

  it('rejects an oversized graph', () => {
    const state = imported()
    const count = LIMITS.tickets + 1
    const bundle = makeBundle([Array.from({ length: count }, (_, index) => index + 1)])
    writeSnapshot(state, R9, bundle)
    touchEpic(state)
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: expect.stringMatching(new RegExp(`^${EPIC_DIR}/snapshots/${R9}\\.json is not a valid record: bundle\\.tickets`)) }])
    expectUnchanged(state, result)
  })
})

describe('hostile plans and hashes', () => {
  it('rejects a cyclic bundle even when its hash is consistent', () => {
    const state = imported()
    writeSnapshot(state, R9, makeBundle([[1, 2]], [[1, 2], [2, 1]]))
    touchEpic(state)
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: expect.stringContaining(`${R9}.json holds an invalid plan: Dependency cycle`) }])
    expectUnchanged(state, result)
  })

  it('rejects a snapshot whose hash does not match its bundle', () => {
    const state = imported()
    writeSnapshot(state, R9, makeBundle([[1, 2, 3]]), contentHash(makeBundle([[1, 2]])))
    touchEpic(state)
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: expect.stringContaining('Snapshot contentHash does not match its bundle') }])
    expectUnchanged(state, result)
  })

  it('rejects a snapshot whose ids differ from its file name', () => {
    const state = imported()
    state.target.fs.put(paths(state).snapshotFile(EPIC, R9), state.target.fs.get(paths(state).snapshotFile(EPIC, R1)) ?? '')
    touchEpic(state)
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: `${EPIC_DIR}/snapshots/${R9}.json names a different epic or revision than its path.` }])
    expectUnchanged(state, result)
  })

  it('rejects a pointer whose hash or number disagrees with its snapshot', () => {
    const state = imported()
    editJson(state, paths(state).epicPointerFile(EPIC), (value) => ({ ...value, revisionNumber: 2 }))
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: `${EPIC_DIR}/current.json does not match the snapshot it points to.` }])
    expectUnchanged(state, result)
  })
})

describe('partial and inconsistent epics', () => {
  it('rejects a pointer to a missing snapshot', () => {
    const state = imported()
    editJson(state, paths(state).epicPointerFile(EPIC), (value) => ({ ...value, revisionId: R9 }))
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: `${EPIC_DIR}/current.json points to missing snapshot ${R9}.` }])
    expectUnchanged(state, result)
  })

  it('rejects an epic without its state file', () => {
    const state = imported()
    state.target.fs.remove(paths(state).epicStateFile(EPIC))
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: `${EPIC_DIR}/state.json is missing.` }])
    expectUnchanged(state, result)
  })

  it('rejects state naming tickets that no snapshot contains', () => {
    const state = imported()
    editJson(state, paths(state).epicStateFile(EPIC), (value) => ({ ...value, ticketStatuses: { [tid(1)]: 'backlog', [tid(77)]: 'completed' } }))
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: `${EPIC_DIR}/state.json names ticket ${tid(77)}, which no snapshot contains.` }])
    expectUnchanged(state, result)
  })

  it('rejects records that belong to another epic', () => {
    const state = imported()
    editJson(state, paths(state).epicStateFile(EPIC), (value) => ({ ...value, epicId: idOf('epic', 2) }))
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: `${EPIC_DIR}/state.json belongs to a different epic.` }])
    expectUnchanged(state, result)
  })
})

describe('hostile run history', () => {
  function editRun(state: Imported, edit: (value: Record<string, unknown>) => unknown): void {
    editJson(state, paths(state).runHistoryFile(RUN), edit)
  }

  it('rejects a run pinned to an unknown revision', () => {
    const state = imported()
    editRun(state, (value) => ({ ...value, revisionId: R9 }))
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/history/${RUN}/run.json`, message: `Run ${RUN} is pinned to unknown revision ${R9}.` }])
    expectUnchanged(state, result)
  })

  it('rejects duplicate attempts and attempts that belong to another run', () => {
    const state = imported()
    const attempts = (JSON.parse(state.target.fs.get(paths(state).runHistoryFile(RUN)) ?? '{}') as { attempts: unknown[] }).attempts
    editRun(state, (value) => ({ ...value, attempts: [...attempts, ...attempts] }))
    expect(reconcile(state).rejected[0]?.message).toContain('Duplicate attempt id')

    const other = imported()
    other.target.db.run('INSERT INTO runs SELECT ?, epic_id, 2, revision_id, ?, NULL, NULL, NULL, NULL, NULL, owner_machine_id, NULL, 0, 1, created_at, NULL, updated_at, NULL FROM runs', idOf('run', 2), 'completed')
    other.target.db.run('UPDATE attempts SET run_id = ?', idOf('run', 2))
    const before = dumpDomain(other.target.db)
    editJson(other, paths(other).runHistoryFile(RUN), (value) => ({ ...value, pauseReason: 'touched' }))
    expect(reconcile(other).rejected).toEqual([{ path: `.darkmechanicus/history/${RUN}/run.json`, message: `Attempt ${idOf('attempt', 1)} already belongs to another run.` }])
    expect(dumpDomain(other.target.db)).toEqual(before)
  })

  it('never imports prototype-polluting keys', () => {
    const state = imported()
    const stateFile = paths(state).epicStateFile(EPIC)
    const text = (state.target.fs.get(stateFile) ?? '').replace('"ticketStatuses": {', '"ticketStatuses": {\n    "__proto__": { "polluted": true },')
    state.target.fs.put(stateFile, text)
    reconcile(state)
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(state.target.db.all('SELECT ticket_id FROM ticket_status ORDER BY ticket_id')).toEqual([{ ticket_id: tid(1) }, { ticket_id: tid(2) }])
  })

  it('stores hostile Markdown and links as inert text', () => {
    const state = imported()
    const hostile = '<script>alert(1)</script> [open](javascript:alert(1)) ![x](file:///etc/passwd)'
    const bundle = makeBundle([[1, 2]], [[1, 2]], { tickets: [makeTicket(1, { body: hostile }), makeTicket(2)] })
    writeSnapshot(state, R9, bundle)
    editJson(state, paths(state).epicPointerFile(EPIC), (value) => ({ ...value, revisionId: R9, revisionNumber: 9, contentHash: contentHash(bundle) }))
    const result = reconcile(state)
    expect(result.imported).toEqual([EPIC])
    const row = state.target.db.get<{ bundle_json: string }>('SELECT bundle_json FROM plan_revisions WHERE id = ?', R9)
    expect((JSON.parse(row?.bundle_json ?? '{}') as PlanBundle).tickets[0]?.body).toBe(hostile)
    expect(outsideReads(state)).toEqual([])
  })
})

const EPIC_2 = idOf('epic', 2)
const R8 = idOf('revision', 8)

/** Writes a second epic (pointer, state, one snapshot of `bundle`) into the clone's files. */
function addSecondEpic(state: Imported, bundle: PlanBundle, ticketStatuses: Record<string, string>): void {
  const hash = contentHash(bundle)
  const snapshot = JSON.parse(state.target.fs.get(paths(state).snapshotFile(EPIC, R1)) ?? '{}') as Record<string, unknown>
  state.target.fs.put(paths(state).snapshotFile(EPIC_2, R8), prettyJson({ ...snapshot, epicId: EPIC_2, revisionId: R8, number: 1, contentHash: hash, bundle }))
  const pointer = JSON.parse(state.target.fs.get(paths(state).epicPointerFile(EPIC)) ?? '{}') as Record<string, unknown>
  state.target.fs.put(paths(state).epicPointerFile(EPIC_2), prettyJson({ ...pointer, epicId: EPIC_2, revisionId: R8, revisionNumber: 1, contentHash: hash }))
  const epicState = JSON.parse(state.target.fs.get(paths(state).epicStateFile(EPIC)) ?? '{}') as Record<string, unknown>
  state.target.fs.put(paths(state).epicStateFile(EPIC_2), prettyJson({ ...epicState, epicId: EPIC_2, ticketStatuses }))
}

describe('hostile identity reuse', () => {
  it('rejects a snapshot that reuses a local revision id with different content', () => {
    const state = imported()
    const bundle = makeBundle([[1, 2, 3]], [[1, 2]])
    writeSnapshot(state, R1, bundle)
    editJson(state, paths(state).snapshotFile(EPIC, R1), (value) => ({ ...value, number: 1 }))
    editJson(state, paths(state).epicPointerFile(EPIC), (value) => ({ ...value, contentHash: contentHash(bundle) }))
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: `Revision ${R1} already exists locally with different content or another epic.` }])
    expectUnchanged(state, result)
    const events = state.target.db.all<{ payload_json: string }>("SELECT payload_json FROM events WHERE kind = 'repository.reconciled' ORDER BY seq")
    expect(JSON.parse(events[1]?.payload_json ?? '{}')).toMatchObject({ imported: [], rejected: 1 })
  })

  it('rejects an epic whose plan claims tickets of another epic', () => {
    const state = imported()
    addSecondEpic(state, makeBundle([[1, 2]], [[1, 2]]), {})
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/epics/${EPIC_2}`, message: `Ticket ${tid(1)} already belongs to another epic.` }])
    expectUnchanged(state, result)
  })

  it('rejects run history stored under another run id', () => {
    const state = imported()
    const otherRun = idOf('run', 2)
    state.target.fs.put(paths(state).runHistoryFile(otherRun), state.target.fs.get(paths(state).runHistoryFile(RUN)) ?? '')
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/history/${otherRun}`, message: `.darkmechanicus/history/${otherRun}/run.json belongs to a different run.` }])
    expectUnchanged(state, result)
  })

  it('rejects a run that moves to another epic', () => {
    const state = imported()
    addSecondEpic(state, makeBundle([[5, 6]], [[5, 6]]), { [tid(5)]: 'backlog' })
    expect(reconcile(state).imported).toEqual([EPIC_2])
    const before = dumpDomain(state.target.db)
    editJson(state, paths(state).runHistoryFile(RUN), (value) => ({ ...value, epicId: EPIC_2, revisionId: R8, attempts: [] }))
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/history/${RUN}/run.json`, message: `Run ${RUN} already exists locally for another epic.` }])
    expect(dumpDomain(state.target.db)).toEqual(before)
  })
})

// Named capability profiles (`.darkmechanicus/profiles/<name>.json`) are just as untrusted.

const PROFILES_DIR = '.darkmechanicus/profiles'
const INVALID_NAME = 'Refusing to build a repository path from an invalid profile name.'

/** A clone that already imported one profile, `ok`, and nothing else. */
function profiled(): Imported {
  const source = createRepoEnv({ root: '/source' })
  initProject(source)
  insertProfile(source.db, { name: 'ok', description: 'Fine' })
  insertOutbox(source.db, { kind: 'profile', entityId: 'ok' })
  flush(source)
  const target = createRepoEnv({ root: '/clone' })
  copyTracked(source, target)
  expect(reconcileRepository(importerDeps(target, createStubGit('main'))).imported).toEqual(['profile:ok'])
  return { target, before: dumpDomain(target.db), readsBefore: target.fs.reads.length }
}

function profilePath(state: Imported, name: string): string {
  return ownedPaths(state.target.layout).profileFile(name)
}

function okRecord(state: Imported): Record<string, unknown> {
  return JSON.parse(state.target.fs.get(profilePath(state, 'ok')) ?? '{}') as Record<string, unknown>
}

/** The text of a valid record for profile `name` (a renamed copy of `ok`), with optional changes. */
function profileText(state: Imported, name: string, patch: Record<string, unknown> = {}): string {
  return prettyJson({ ...okRecord(state), name, ...patch })
}

function storedNames(state: Imported): string[] {
  return state.target.db.all<{ name: string }>('SELECT name FROM profiles ORDER BY name').map((row) => row.name)
}

function notARecord(entry: string): { path: string; message: string } {
  return { path: `${PROFILES_DIR}/${entry}`, message: `${PROFILES_DIR}/${entry} is not a profile record: profiles are stored as <name>.json.` }
}

const HOSTILE_NAMES = ['Bad.json', 'a_b.json', 'con.json', 'lpt1.json', 'nul.json', 'trailing-.json', 'x/../../escape.json']

describe('hostile profile file names', () => {
  it('rejects unsafe or non-record names and still imports valid profiles', () => {
    const state = profiled()
    state.target.fs.put(profilePath(state, 'good'), profileText(state, 'good'))
    const listing = ['..', '.hidden.json', ...HOSTILE_NAMES, 'notes.txt', 'noext', 'good.json', 'ok.json']
    state.target.fs.setReaddir(state.target.layout.profilesDir, listing)
    const result = reconcile(state)
    expect(result.rejected).toEqual([
      ...HOSTILE_NAMES.map((entry) => ({ path: `${PROFILES_DIR}/${entry}`, message: INVALID_NAME })),
      notARecord('noext'),
      notARecord('notes.txt')
    ].sort((a, b) => (a.path < b.path ? -1 : 1)))
    expect([result.imported, result.unchanged]).toEqual([['profile:good'], ['profile:ok']])
    expect(storedNames(state)).toEqual(['good', 'ok'])
    expect(outsideReads(state)).toEqual([])
  })
})

describe('hostile profile links', () => {
  it('rejects a linked or redirected profile file without reading outside', () => {
    const state = profiled()
    state.target.fs.put(join(OUTSIDE, 'linked.json'), profileText(state, 'linked'))
    state.target.fs.put(join(OUTSIDE, 'redirected.json'), profileText(state, 'redirected'))
    state.target.fs.symlink(profilePath(state, 'linked'), join(OUTSIDE, 'linked.json'))
    state.target.fs.junction(profilePath(state, 'redirected'), join(OUTSIDE, 'redirected.json'))
    const result = reconcile(state)
    expect(result.rejected).toEqual([
      { path: `${PROFILES_DIR}/linked.json`, message: expect.stringContaining('symbolic links and junctions are not allowed') },
      { path: `${PROFILES_DIR}/redirected.json`, message: expect.stringContaining('resolves outside .darkmechanicus') }
    ])
    expect(storedNames(state)).toEqual(['ok'])
    expect(outsideReads(state)).toEqual([])
  })

  it('fails closed on a linked profiles directory without reading outside or changing anything', () => {
    const state = profiled()
    state.target.fs.put(join(OUTSIDE, 'evil.json'), profileText(state, 'evil'))
    state.target.fs.symlink(state.target.layout.profilesDir, OUTSIDE)
    expect(domainErrorOf(() => reconcile(state)).code).toBe('unsafe_path')
    expect(storedNames(state)).toEqual(['ok'])
    expect(outsideReads(state)).toEqual([])
  })

  it('rejects a directory named like a profile record', () => {
    const state = profiled()
    state.target.fs.put(join(profilePath(state, 'folder'), 'inner.json'), profileText(state, 'inner'))
    expect(reconcile(state).rejected).toEqual([
      { path: `${PROFILES_DIR}/folder.json`, message: `${PROFILES_DIR}/folder.json is a directory, not a profile record.` }
    ])
    expect(storedNames(state)).toEqual(['ok'])
  })
})

describe('hostile profile sizes', () => {
  it('rejects a profile record over the size limit without reading it, and accepts one at the limit', () => {
    const state = profiled()
    for (const name of ['big', 'edge']) {
      state.target.fs.put(profilePath(state, name), profileText(state, name))
    }
    state.target.fs.setSize(profilePath(state, 'big'), MAX_PROFILE_BYTES + 1)
    state.target.fs.setSize(profilePath(state, 'edge'), MAX_PROFILE_BYTES)
    state.target.fs.failOn({ op: 'readFile', match: (path) => path === profilePath(state, 'big') })
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: `${PROFILES_DIR}/big.json`, message: `${PROFILES_DIR}/big.json is larger than the 256 KiB profile limit.` }])
    expect(result.imported).toEqual(['profile:edge'])
  })

  it('rejects a profiles directory with too many entries without reading any of them', () => {
    const state = profiled()
    const listing = Array.from({ length: MAX_PROFILES + 1 }, (_, index) => `p-${index}.json`)
    state.target.fs.setReaddir(state.target.layout.profilesDir, listing)
    state.target.fs.failOn({ op: 'readFile', match: (path) => isWithin(state.target.layout.profilesDir, path) })
    const result = reconcile(state)
    expect(result.rejected).toEqual([{ path: PROFILES_DIR, message: `${PROFILES_DIR} holds more than 1000 profiles.` }])
    expect([result.imported, result.unchanged, storedNames(state)]).toEqual([[], [], ['ok']])
  })

  it('reads a profiles directory of exactly the entry limit', () => {
    const state = profiled()
    const listing = [...Array.from({ length: MAX_PROFILES - 1 }, (_, index) => `p-${index}.json`), 'ok.json']
    state.target.fs.setReaddir(state.target.layout.profilesDir, listing)
    const result = reconcile(state)
    expect(result.rejected).toHaveLength(MAX_PROFILES - 1)
    expect(result.rejected[0]).toEqual({ path: `${PROFILES_DIR}/p-0.json`, message: `${PROFILES_DIR}/p-0.json is missing.` })
    expect(result.unchanged).toEqual(['profile:ok'])
  })
})

function worstText(length: number): string {
  return '\u0001'.repeat(length)
}

function worstCapability(): Record<string, unknown> {
  return {
    workType: 'implementation',
    reasoning: { level: 'deep', rationale: worstText(LIMITS.shortText) },
    skills: Array.from({ length: LIMITS.tags }, () => worstText(LIMITS.tag)),
    modalities: ['text', 'images'],
    tools: ['repo_read', 'repo_write', 'shell', 'browser', 'test_execution', 'network'],
    context: { estimatedInputTokens: 100_000_000, requiredArtifacts: Array.from({ length: LIMITS.references }, () => worstText(LIMITS.label)) },
    constraints: {
      environments: Array.from({ length: LIMITS.tags }, () => worstText(LIMITS.label)),
      dataLocation: worstText(LIMITS.label),
      maxDurationMinutes: 100_000,
      maxCostUsd: 1_000_000
    },
    preferences: { quality: 'standard', latency: 'normal', cost: 'normal', autonomy: 'supervised', modelOverride: worstText(LIMITS.label) }
  }
}

describe('profile size limit headroom', () => {
  it('never rejects a valid profile for its size: the largest possible record fits the limit', () => {
    const state = profiled()
    const capability = worstCapability()
    const text = profileText(state, `a${'b'.repeat(63)}`, { description: worstText(LIMITS.profileDescription), capability })
    expect(parseRecord(profileRecord, text, 'largest').capability).toEqual(capability)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(MAX_PROFILE_BYTES)
  })
})

function hostileFiles(state: Imported): Record<string, string> {
  const capability = okRecord(state)['capability'] as Record<string, unknown>
  return {
    empty: '',
    marked: `<<<<<<< HEAD\n${profileText(state, 'marked')}=======\n{}\n>>>>>>> theirs\n`,
    broken: '{',
    extra: profileText(state, 'extra', { revision: 3 }),
    renamed: profileText(state, 'ok'),
    vendor: profileText(state, 'vendor', { capability: { ...capability, workType: 'frontier-model' } }),
    polluting: profileText(state, 'polluting').replace('"capability": {', '"capability": {\n    "__proto__": { "polluted": true },')
  }
}

describe('hostile profile contents', () => {
  it('rejects empty, conflicted, malformed, renamed, unknown-key, and polluting records', () => {
    const state = profiled()
    for (const [name, text] of Object.entries(hostileFiles(state))) {
      state.target.fs.put(profilePath(state, name), text)
    }
    const messages = Object.fromEntries(reconcile(state).rejected.map((item) => [item.path.slice(PROFILES_DIR.length + 1), item.message]))
    expect(messages).toEqual({
      'broken.json': `${PROFILES_DIR}/broken.json is not valid JSON.`,
      'empty.json': `${PROFILES_DIR}/empty.json is empty.`,
      'extra.json': `${PROFILES_DIR}/extra.json is not a valid record: (root): Unrecognized key: "revision".`,
      'marked.json': `${PROFILES_DIR}/marked.json contains unresolved merge conflict markers.`,
      'polluting.json': `${PROFILES_DIR}/polluting.json is not a valid record: capability: Unrecognized key: "__proto__".`,
      'renamed.json': `${PROFILES_DIR}/renamed.json names a different profile than its file name.`,
      'vendor.json': expect.stringContaining(`${PROFILES_DIR}/vendor.json is not a valid record: capability.workType: Invalid option`)
    })
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
    expect(storedNames(state)).toEqual(['ok'])
    expect(outsideReads(state)).toEqual([])
  })

  it('stores hostile description text as inert data', () => {
    const state = profiled()
    const hostile = '<script>alert(1)</script> [x](javascript:alert(1))'
    state.target.fs.put(profilePath(state, 'inert'), profileText(state, 'inert', { description: hostile }))
    expect(reconcile(state).imported).toEqual(['profile:inert'])
    expect(state.target.db.get('SELECT description FROM profiles WHERE name = ?', 'inert')).toEqual({ description: hostile })
  })
})
