/** Export edges: unverifiable read-backs, records that are not here, half-present tracked files and hand-edited histories. */
import { describe, expect, it } from 'vitest'
import { makeBundle, tid } from '../../test/bundles'
import { pngBytes } from '../../test/images'
import { publishLearning } from '../../test/learningFixtures'
import type { MemoryFs } from '../../test/memoryFs'
import { createRepoEnv, flush, initProject, type RepoEnv, saveRevision, stageRevision } from '../../test/repoEnv'
import { idOf, insertAttempt, insertOutbox, insertRun } from '../../test/repoFixtures'
import { deliver, portable, report, spaceWorld } from '../../test/spaceWorld'
import { createTestCtx } from '../../test/testContext'
import { prettyJson } from '../canonical'
import { claimAttachments, createStagedAttachment } from '../services/attachments'
import { enqueueOutbox } from '../services/outbox'
import { META_KEYS, setMeta } from '../meta'
import { flushOutbox, type FlushOutcome } from './finalizer'
import { ownedPaths } from './paths'
import { MAX_RECORD_BYTES } from './portable'

const EPIC = idOf('epic', 1)
const R1 = idOf('revision', 1)
const R2 = idOf('revision', 2)
const RUN = idOf('run', 1)

/** The memory filesystem, except that the `nth` read of a path matching `match` returns `change` of its text. */
function tamperedRead(fs: MemoryFs, match: (path: string) => boolean, nth: number, change: (text: string) => string): MemoryFs {
  let seen = 0
  const tampered: MemoryFs = Object.create(fs) as MemoryFs
  tampered.readFile = (path) => {
    const text = fs.readFile(path)
    if (!match(path)) return text
    seen += 1
    return seen === nth ? change(text) : text
  }
  return tampered
}

const flushThrough = (env: RepoEnv, fs: MemoryFs): FlushOutcome => flushOutbox({ ...env, fs }, env.hook)

function savedFirst(): RepoEnv {
  const env = createRepoEnv()
  saveRevision(env, { epicId: EPIC, revisionId: R1, number: 1 })
  return env
}

describe('flushOutbox read-back verification', () => {
  it('fails a save whose pointer reads back other than written, then saves on the retry', () => {
    const env = savedFirst()
    stageRevision(env, { epicId: EPIC, revisionId: R2, number: 2, bundle: makeBundle([[1, 2, 3]], [[1, 2]]), baseRevisionId: R1 })
    // The read-back is of the staged copy, before anything is replaced.
    const fs = tamperedRead(env.fs, (path) => path.includes('current.json.tmp-'), 1, (text) => `${text} `)
    const shown = `.darkmechanicus/epics/${EPIC}/current.json`
    expect(flushThrough(env, fs)).toMatchObject({ failed: 1, failedRevisionIds: [R2], errors: [expect.stringContaining(`Read-back of ${shown} does not match what was written.`)] })
    expect(flush(env).savedRevisionIds).toEqual([R2])
  })

  it('drops a snapshot whose read-back holds another revision, so the retry writes it again', () => {
    const env = savedFirst()
    stageRevision(env, { epicId: EPIC, revisionId: R2, number: 2, bundle: makeBundle([[1, 2, 3]], [[1, 2]]), baseRevisionId: R1 })
    const paths = ownedPaths(env.layout)
    const first = env.fs.get(paths.snapshotFile(EPIC, R1)) ?? ''
    const fs = tamperedRead(env.fs, (path) => path.includes(`${R2}.json.tmp-`), 1, () => first)
    const shown = `.darkmechanicus/epics/${EPIC}/snapshots/${R2}.json`
    expect(flushThrough(env, fs)).toMatchObject({ failed: 1, errors: [expect.stringContaining(`Read-back of ${shown} does not match the revision's content hash.`)] })
    expect(env.fs.get(paths.snapshotFile(EPIC, R2))).toBeUndefined()
    expect(flush(env).savedRevisionIds).toEqual([R2])
    expect(env.fs.get(paths.snapshotFile(EPIC, R2))).toContain(R2)
  })
})

describe('flushOutbox and a bare thrown value', () => {
  it('records the value a failed write threw as the entry error, and saves on the retry', () => {
    const env = savedFirst()
    const entry = stageRevision(env, { epicId: EPIC, revisionId: R2, number: 2, bundle: makeBundle([[1, 2, 3]], [[1, 2]]), baseRevisionId: R1 })
    const failing: MemoryFs = Object.create(env.fs) as MemoryFs
    failing.writeFile = (path, text) => {
      // Native bindings may reject with a bare value; the finalizer must keep it as the entry's error.
      if (path.includes(`${R2}.json.tmp-`)) throw 'ENOSPC'
      env.fs.writeFile(path, text)
    }
    expect(flushThrough(env, failing)).toMatchObject({ failed: 1, failedRevisionIds: [R2], errors: [expect.stringMatching(/: ENOSPC$/)] })
    expect(env.db.get('SELECT state, last_error FROM outbox WHERE id = ?', entry)).toEqual({ state: 'pending', last_error: 'ENOSPC' })
    expect(flush(env).savedRevisionIds).toEqual([R2])
  })
})

describe('flushOutbox records that are not here', () => {
  it('fails the state export of an epic this database does not hold', () => {
    const env = createRepoEnv()
    const missing = idOf('epic', 9)
    insertOutbox(env.db, { kind: 'epic_state', epicId: missing })
    expect(flush(env)).toMatchObject({ flushed: 0, failed: 1, errors: [expect.stringContaining(`Epic ${missing} does not exist.`)] })
  })

  it('holds an epic image while the epic records are not in this checkout, and exports it once they are', () => {
    const env = createRepoEnv({ root: '/source' })
    initProject(env)
    saveRevision(env, { epicId: EPIC, revisionId: R1, number: 1, bundle: makeBundle([[1, 2]], [[1, 2]]) })
    const paths = ownedPaths(env.layout)
    const pointer = env.fs.get(paths.epicPointerFile(EPIC)) ?? ''
    env.fs.remove(paths.epicPointerFile(EPIC))
    const ctx = createTestCtx({ db: env.db, clock: env.clock })
    const image = createStagedAttachment(ctx, { bytes: pngBytes(40, 30, 3), label: 'shot', purpose: 'evidence' })
    claimAttachments(ctx, [image.id], { kind: 'ticket', id: tid(1) })
    expect(flush(env).errors).toEqual([expect.stringContaining(`Attachment ${image.id} is not exported: the records of epic ${EPIC} are not in this checkout.`)])
    env.fs.put(paths.epicPointerFile(EPIC), pointer)
    expect(flush(env)).toMatchObject({ failed: 0, errors: [] })
  })
})

describe('flushOutbox entries that name no record', () => {
  it.each(['comment', 'attachment'])('fails a %s entry with no id on its own, holding back nothing of its epic', (kind) => {
    const env = savedFirst()
    env.db.run("INSERT INTO outbox (kind, epic_id, state, created_at) VALUES (?, ?, 'pending', ?)", kind, EPIC, env.clock.nowIso())
    const state = insertOutbox(env.db, { kind: 'epic_state', epicId: EPIC })
    expect(flush(env)).toMatchObject({ flushed: 1, failed: 1, errors: [expect.stringContaining(`Outbox entry has no ${kind} id.`)] })
    expect(env.db.get('SELECT state FROM outbox WHERE id = ?', state)).toEqual({ state: 'done' })
  })
})

describe('flushOutbox over half-present tracked epic records', () => {
  it.each([
    ['only the state', 'pointer'],
    ['only the pointer', 'state']
  ] as const)('refuses to write over a checkout holding %s from elsewhere', (_label, gone) => {
    const env = savedFirst()
    const paths = ownedPaths(env.layout)
    const file = gone === 'pointer' ? paths.epicStateFile(EPIC) : paths.epicPointerFile(EPIC)
    env.fs.remove(gone === 'pointer' ? paths.epicPointerFile(EPIC) : paths.epicStateFile(EPIC))
    env.fs.put(file, `${env.fs.get(file) ?? ''}\n`)
    const kept = env.fs.get(file)
    insertOutbox(env.db, { kind: 'epic_state', epicId: EPIC })
    expect(flush(env)).toMatchObject({ failed: 1, errors: [expect.stringContaining('hold records this machine has not imported')] })
    expect(env.fs.get(file)).toBe(kept)
  })

  it('ignores an export intent file that is not JSON and refuses as without one', () => {
    const env = savedFirst()
    const paths = ownedPaths(env.layout)
    env.db.run("DELETE FROM sync_state WHERE kind = 'epic'")
    env.fs.put(paths.exportIntentFile(EPIC), '{ torn')
    const before = [env.fs.get(paths.epicPointerFile(EPIC)), env.fs.get(paths.epicStateFile(EPIC))]
    insertOutbox(env.db, { kind: 'epic_state', epicId: EPIC })
    expect(flush(env)).toMatchObject({ failed: 1, errors: [expect.stringContaining('hold records this machine has not imported')] })
    expect([env.fs.get(paths.epicPointerFile(EPIC)), env.fs.get(paths.epicStateFile(EPIC))]).toEqual(before)
  })
})

describe('flushOutbox over a hand-edited run history', () => {
  it.each([
    ['events that are not a list', prettyJson({ runId: RUN, experimentEvents: 'none' })],
    ['events without ids', prettyJson({ runId: RUN, experimentEvents: [null, { id: 5 }] })],
    ['text that is not JSON', '{ not json']
  ])('writes over %s, which hold no events to lose', (_label, text) => {
    const env = savedFirst()
    insertRun(env.db, { id: RUN, epicId: EPIC, revisionId: R1 })
    insertAttempt(env.db, { id: idOf('attempt', 1), runId: RUN, ticketId: tid(1), revisionId: R1 })
    const file = ownedPaths(env.layout).runHistoryFile(RUN)
    env.fs.put(file, text)
    insertOutbox(env.db, { kind: 'run_history', epicId: EPIC, runId: RUN })
    expect(flush(env)).toMatchObject({ failed: 0, errors: [] })
    expect(JSON.parse(env.fs.get(file) ?? '{}')).toMatchObject({ runId: RUN, epicId: EPIC })
  })

  it('never writes over the tracked history of a run this database does not hold', () => {
    const env = savedFirst()
    setMeta(env.db, META_KEYS.machineId, 'mc_00000000000000000000000077')
    const file = ownedPaths(env.layout).runHistoryFile(RUN)
    env.fs.put(file, prettyJson({ runId: RUN, epicId: EPIC }))
    insertOutbox(env.db, { kind: 'run_history', epicId: EPIC, runId: RUN })
    expect(flush(env).errors).toEqual([expect.stringContaining(`holds records of run ${RUN} this machine has not imported, and machine unknown owns the run`)])
    expect(env.fs.get(file)).toBe(prettyJson({ runId: RUN, epicId: EPIC }))
  })
})

describe('flushOutbox scorecard writes that cannot complete', () => {
  it('drops a scorecard file that could not be put in place, and writes it on the retry', () => {
    const w = spaceWorld({ overhead: false })
    portable(w)
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 18, corrective: 2 })
    const reportId = report(w).id
    const card = ownedPaths(w.env.layout).scorecardFile(w.runId, reportId)
    w.env.fs.failOn({ op: 'readFile', match: (path) => path.includes(`${reportId}.json.tmp-`) })
    expect(flush(w.env).failed).toBeGreaterThan(0)
    expect(w.env.fs.get(card)).toBeUndefined()
    expect(flush(w.env)).toMatchObject({ failed: 0, errors: [] })
    expect(JSON.parse(w.env.fs.get(card) ?? '{}')).toMatchObject({ runId: w.runId })
  })

  it('refuses to write a scorecard larger than the record limit, and writes no run history naming it', () => {
    const w = spaceWorld({ overhead: false })
    portable(w)
    deliver(w, 1, { minutes: 20, tokens: 30_000, productive: 18, corrective: 2 })
    const reportId = report(w).id
    w.env.db.run("UPDATE sprint_reports SET scorecard_json = json_set(scorecard_json, '$.padding', ?) WHERE id = ?", 'x'.repeat(MAX_RECORD_BYTES), reportId)
    const paths = ownedPaths(w.env.layout)
    const shown = `.darkmechanicus/history/${w.runId}/scorecards/${reportId}.json`
    expect(flush(w.env).errors).toContainEqual(expect.stringContaining(`${shown} would be larger than the 8 MiB record limit, so it is not written.`))
    expect(w.env.fs.get(paths.scorecardFile(w.runId, reportId))).toBeUndefined()
    expect(w.env.fs.get(paths.runHistoryFile(w.runId))).toBeUndefined()
  })
})

describe('flushOutbox and a learning record already exported as it stands', () => {
  it('settles the entry without writing the identical file again', () => {
    const env = createRepoEnv()
    initProject(env)
    const learningId = publishLearning(env, 1)
    expect(flush(env)).toMatchObject({ failed: 0, errors: [] })
    const file = ownedPaths(env.layout).learningRecordFile(learningId)
    const text = env.fs.get(file)
    const writesBefore = env.fs.writes.length
    enqueueOutbox({ db: env.db, clock: env.clock }, { kind: 'learning_record', entityId: learningId })
    expect(flush(env)).toMatchObject({ failed: 0, errors: [] })
    expect(env.fs.writes.slice(writesBefore).filter((path) => path.includes(learningId))).toEqual([])
    expect(env.fs.get(file)).toBe(text)
    expect(env.db.all("SELECT state FROM outbox WHERE kind = 'learning_record'")).toEqual([{ state: 'done' }, { state: 'done' }])
  })
})
