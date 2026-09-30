/** Ticket 013.5: hostile repository records are rejected without outside reads/writes or DB changes. */
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeBundle, makeTicket, tid } from '../../test/bundles'
import { isWithin } from '../../test/memoryFs'
import { domainErrorOf, idOf, insertAttempt, insertOutbox, insertRun } from '../../test/repoFixtures'
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
import { MAX_RECORD_BYTES } from './portable'

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
