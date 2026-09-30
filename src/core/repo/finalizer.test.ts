import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeBundle, tid } from '../../test/bundles'
import type { FaultSpec } from '../../test/memoryFs'
import { idOf, insertComment, insertEpic, insertOutbox, insertRevision, insertRun, insertTicketStatus, T0 } from '../../test/repoFixtures'
import { createRepoEnv, flush, type RepoEnv, saveRevision, stageRevision } from '../../test/repoEnv'
import { contentHash, prettyJson } from '../canonical'
import { getMeta } from '../meta'
import { flushOutbox, type FlushOutcome, writeFileSafely } from './finalizer'
import { ownedPaths } from './paths'
import {
  buildCommentRecord,
  epicPointerRecord,
  epicStateRecord,
  parseRecord,
  snapshotRecord,
  trackedCommentHash,
  trackedEpicHash,
  trackedRunHash
} from './portable'

const EPIC = idOf('epic', 1)
const OTHER_EPIC = idOf('epic', 2)
const R1 = idOf('revision', 1)
const R2 = idOf('revision', 2)
const RUN = idOf('run', 1)
const BUNDLE_1 = makeBundle([[1, 2]], [[1, 2]])
const BUNDLE_2 = makeBundle([[1, 2, 3]], [[1, 2]])

function files(env: RepoEnv): { pointer: string; state: string; snapshot: (revisionId: string) => string } {
  const paths = ownedPaths(env.layout)
  return {
    pointer: paths.epicPointerFile(EPIC),
    state: paths.epicStateFile(EPIC),
    snapshot: (revisionId) => paths.snapshotFile(EPIC, revisionId)
  }
}

function outboxRow(env: RepoEnv, id: number): { state: string; attempts: number; last_error: string | null } | undefined {
  return env.db.get('SELECT state, attempts, last_error FROM outbox WHERE id = ?', id)
}

function revisionState(env: RepoEnv, revisionId: string): string | undefined {
  return env.db.get<{ state: string }>('SELECT state FROM plan_revisions WHERE id = ?', revisionId)?.state
}

function tempFiles(env: RepoEnv): string[] {
  return [...env.fs.files().keys()].filter((path) => path.includes('.tmp-'))
}

describe('flushOutbox snapshot saves', () => {
  it('writes the snapshot, state, and pointer, then completes the save', () => {
    const env = createRepoEnv()
    const entry = stageRevision(env, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE_1 })
    const outcome = flush(env)
    expect(outcome).toEqual({ flushed: 1, failed: 0, errors: [], savedRevisionIds: [R1], failedRevisionIds: [] })
    const f = files(env)
    const snapshot = parseRecord(snapshotRecord, env.fs.get(f.snapshot(R1)) ?? '', 'snapshot')
    expect(snapshot).toMatchObject({ epicId: EPIC, revisionId: R1, number: 1, contentHash: contentHash(BUNDLE_1), bundle: BUNDLE_1 })
    const pointer = parseRecord(epicPointerRecord, env.fs.get(f.pointer) ?? '', 'pointer')
    expect(pointer).toEqual({
      format: 'darkmechanicus.epic-pointer',
      formatVersion: 1,
      epicId: EPIC,
      revisionId: R1,
      revisionNumber: 1,
      contentHash: contentHash(BUNDLE_1),
      generation: 1,
      updatedAt: T0
    })
    const state = parseRecord(epicStateRecord, env.fs.get(f.state) ?? '', 'state')
    expect(state.ticketStatuses).toEqual({ [tid(1)]: 'backlog', [tid(2)]: 'backlog' })
    expect(state.generation).toBe(1)
    expect(revisionState(env, R1)).toBe('saved')
    expect(outboxRow(env, entry)).toEqual({ state: 'done', attempts: 0, last_error: null })
    expect(getMeta(env.db, 'last_flush_at')).toBe(T0)
  })

})

describe('flushOutbox record format', () => {
  it('writes key-sorted pretty JSON and records the exported hash and generation', () => {
    const env = createRepoEnv()
    saveRevision(env, { epicId: EPIC, revisionId: R1, number: 1 })
    const f = files(env)
    for (const path of [f.pointer, f.state, f.snapshot(R1)]) {
      const text = env.fs.get(path) ?? ''
      expect(text).toBe(prettyJson(JSON.parse(text)))
    }
    const sync = env.db.get('SELECT exported_hash, imported_hash, generation, conflict FROM sync_state WHERE kind = ? AND entity_id = ?', 'epic', EPIC)
    expect(sync).toEqual({
      exported_hash: trackedEpicHash(env.fs.get(f.pointer) ?? '', env.fs.get(f.state) ?? ''),
      imported_hash: null,
      generation: 1,
      conflict: null
    })
  })

  it('keeps every snapshot across sequential saves and advances the pointer generation', () => {
    const env = createRepoEnv()
    saveRevision(env, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE_1 })
    const first = env.fs.get(files(env).snapshot(R1))
    const outcome = saveRevision(env, { epicId: EPIC, revisionId: R2, number: 2, bundle: BUNDLE_2, baseRevisionId: R1 })
    expect(outcome.savedRevisionIds).toEqual([R2])
    expect(env.fs.get(files(env).snapshot(R1))).toBe(first)
    const pointer = JSON.parse(env.fs.get(files(env).pointer) ?? '{}') as { revisionId: string; generation: number; revisionNumber: number }
    expect([pointer.revisionId, pointer.revisionNumber, pointer.generation]).toEqual([R2, 2, 2])
    expect(parseRecord(snapshotRecord, env.fs.get(files(env).snapshot(R2)) ?? '', 's').baseRevisionId).toBe(R1)
  })
})

describe('flushOutbox snapshot idempotency', () => {
  it('reuses an identical snapshot left by an interrupted flush without rewriting it', () => {
    const env = createRepoEnv()
    const reference = createRepoEnv()
    saveRevision(reference, { epicId: EPIC, revisionId: R1, number: 1 })
    const snapshotText = reference.fs.get(files(reference).snapshot(R1)) ?? ''
    env.fs.put(files(env).snapshot(R1), snapshotText)
    const outcome = saveRevision(env, { epicId: EPIC, revisionId: R1, number: 1 })
    expect(outcome.savedRevisionIds).toEqual([R1])
    expect(env.fs.writes).not.toContain(resolve(files(env).snapshot(R1)))
    expect(env.fs.get(files(env).pointer)).toBe(reference.fs.get(files(reference).pointer))
  })

  it('fails closed when a snapshot with different content already exists', () => {
    const env = createRepoEnv()
    const other = createRepoEnv()
    saveRevision(other, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE_2 })
    const foreign = other.fs.get(files(other).snapshot(R1)) ?? ''
    env.fs.put(files(env).snapshot(R1), foreign)
    const entry = stageRevision(env, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE_1 })
    const outcome = flush(env)
    expect(outcome.failed).toBe(1)
    expect(outcome.failedRevisionIds).toEqual([R1])
    expect(outcome.errors[0]).toContain('already exists with different content')
    expect(env.fs.get(files(env).snapshot(R1))).toBe(foreign)
    expect(env.fs.get(files(env).pointer)).toBeUndefined()
    expect(revisionState(env, R1)).toBe('pending')
    expect(outboxRow(env, entry)?.state).toBe('pending')
  })
})

function seedSavedFirstRevision(): RepoEnv {
  const env = createRepoEnv()
  saveRevision(env, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE_1 })
  return env
}

const BOUNDARIES: [string, FaultSpec][] = [
  ['snapshot temp write', { op: 'writeFile', match: (path) => path.includes(`${R2}.json.tmp-`) }],
  ['snapshot fsync', { op: 'fsyncFile', match: (path) => path.includes(`${R2}.json.tmp-`) }],
  ['snapshot rename', { op: 'rename', match: (path) => path.endsWith(`${R2}.json`) }],
  ['snapshot read-back', { op: 'readFile', match: (path) => path.endsWith(`${R2}.json`) }],
  ['state temp write', { op: 'writeFile', match: (path) => path.includes('state.json.tmp-') }],
  ['state rename', { op: 'rename', match: (path) => path.endsWith('state.json') }],
  ['pointer temp write', { op: 'writeFile', match: (path) => path.includes('current.json.tmp-') }],
  ['pointer fsync', { op: 'fsyncFile', match: (path) => path.includes('current.json.tmp-') }],
  ['pointer rename', { op: 'rename', match: (path) => path.endsWith('current.json') }]
]

function expectPendingAfterFault(env: RepoEnv, entry: number, before: { pointer?: string; snapshot?: string }, outcome: FlushOutcome): void {
  expect(outcome).toMatchObject({ flushed: 0, failed: 1, savedRevisionIds: [], failedRevisionIds: [R2] })
  expect(env.fs.get(files(env).pointer)).toBe(before.pointer)
  expect(env.fs.get(files(env).snapshot(R1))).toBe(before.snapshot)
  expect(revisionState(env, R2)).toBe('pending')
  expect(outboxRow(env, entry)).toMatchObject({ state: 'pending', attempts: 1 })
  expect(outboxRow(env, entry)?.last_error).toMatch(/Injected|DB commit/)
  expect(tempFiles(env)).toEqual([])
}

describe('flushOutbox fault injection at every write boundary', () => {
  it.each(BOUNDARIES)('keeps the last good pointer and snapshot after a %s fault, then retries identically', (_label, fault) => {
    const env = seedSavedFirstRevision()
    const reference = seedSavedFirstRevision()
    saveRevision(reference, { epicId: EPIC, revisionId: R2, number: 2, bundle: BUNDLE_2, baseRevisionId: R1 })
    const before = { pointer: env.fs.get(files(env).pointer), snapshot: env.fs.get(files(env).snapshot(R1)) }
    const entry = stageRevision(env, { epicId: EPIC, revisionId: R2, number: 2, bundle: BUNDLE_2, baseRevisionId: R1 })
    env.fs.failOn(fault)
    expectPendingAfterFault(env, entry, before, flush(env))

    const retry = flush(env)
    expect(retry).toEqual({ flushed: 1, failed: 0, errors: [], savedRevisionIds: [R2], failedRevisionIds: [] })
    for (const path of [files(env).pointer, files(env).state, files(env).snapshot(R1), files(env).snapshot(R2)]) {
      expect(env.fs.get(path)).toBe(reference.fs.get(path))
    }
    expect(revisionState(env, R2)).toBe('saved')
  })

  it('keeps the last good pointer when the DB side of the save fails to commit', () => {
    const env = seedSavedFirstRevision()
    const before = { pointer: env.fs.get(files(env).pointer), snapshot: env.fs.get(files(env).snapshot(R1)) }
    const entry = stageRevision(env, { epicId: EPIC, revisionId: R2, number: 2, bundle: BUNDLE_2, baseRevisionId: R1 })
    env.hook.failNext = true
    expectPendingAfterFault(env, entry, before, flush(env))
    expect(flush(env).savedRevisionIds).toEqual([R2])
    expect(JSON.parse(env.fs.get(files(env).pointer) ?? '{}')).toMatchObject({ revisionId: R2, generation: 2 })
  })

  it('drops a new snapshot that could not be verified so the retry writes it again', () => {
    const env = seedSavedFirstRevision()
    stageRevision(env, { epicId: EPIC, revisionId: R2, number: 2, bundle: BUNDLE_2, baseRevisionId: R1 })
    env.fs.failOn({ op: 'readFile', match: (path) => path.endsWith(`${R2}.json`) })
    expect(flush(env).failedRevisionIds).toEqual([R2])
    expect(env.fs.get(files(env).snapshot(R2))).toBeUndefined()
    expect(flush(env).savedRevisionIds).toEqual([R2])
    expect(parseRecord(snapshotRecord, env.fs.get(files(env).snapshot(R2)) ?? '', 's').revisionId).toBe(R2)
  })

  it('recovers when the pointer read-back fails after the pointer was replaced', () => {
    const env = seedSavedFirstRevision()
    const entry = stageRevision(env, { epicId: EPIC, revisionId: R2, number: 2, bundle: BUNDLE_2, baseRevisionId: R1 })
    env.fs.failOn({ op: 'readFile', match: (path) => path.endsWith('current.json') })
    expect(flush(env).failedRevisionIds).toEqual([R2])
    expect(outboxRow(env, entry)?.state).toBe('pending')
    expect(revisionState(env, R2)).toBe('pending')
    expect(flush(env).savedRevisionIds).toEqual([R2])
    expect(JSON.parse(env.fs.get(files(env).pointer) ?? '{}')).toMatchObject({ revisionId: R2, generation: 2 })
  })
})

describe('flushOutbox failure accounting', () => {
  it('counts attempts, keeps entries pending until the fifth failure, and still retries failed entries', () => {
    const env = createRepoEnv()
    const entry = stageRevision(env, { epicId: EPIC, revisionId: R1, number: 1 })
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      env.hook.failNext = true
      flush(env)
      expect(outboxRow(env, entry)).toMatchObject({ state: 'pending', attempts: attempt, last_error: 'Injected DB commit failure' })
    }
    env.hook.failNext = true
    expect(flush(env).errors).toEqual([`snapshot ${R1}: Injected DB commit failure`])
    expect(outboxRow(env, entry)).toMatchObject({ state: 'failed', attempts: 5 })
    expect(flush(env).savedRevisionIds).toEqual([R1])
    expect(outboxRow(env, entry)).toEqual({ state: 'done', attempts: 5, last_error: null })
  })

  it('skips later entries of a failed epic but continues with other epics', () => {
    const env = createRepoEnv()
    stageRevision(env, { epicId: EPIC, revisionId: R1, number: 1 })
    const later = insertOutbox(env.db, { kind: 'epic_state', epicId: EPIC })
    stageRevision(env, { epicId: OTHER_EPIC, revisionId: R2, number: 1 })
    env.fs.failOn({ op: 'writeFile', match: (path) => path.includes(EPIC) })
    const outcome = flush(env)
    expect(outcome).toMatchObject({ flushed: 1, failed: 1, savedRevisionIds: [R2], failedRevisionIds: [R1] })
    expect(outboxRow(env, later)).toMatchObject({ state: 'pending', attempts: 0 })
  })
})

function seedRun(env: RepoEnv): void {
  saveRevision(env, { epicId: EPIC, revisionId: R1, number: 1 })
  insertRun(env.db, { id: RUN, epicId: EPIC, revisionId: R1 })
}

describe('flushOutbox epic state and run history', () => {
  it('marks epic state of an unsaved epic done without writing anything', () => {
    const env = createRepoEnv()
    insertEpic(env.db, { id: EPIC })
    const entry = insertOutbox(env.db, { kind: 'epic_state', epicId: EPIC })
    expect(flush(env)).toEqual({ flushed: 1, failed: 0, errors: [], savedRevisionIds: [], failedRevisionIds: [] })
    expect(outboxRow(env, entry)?.state).toBe('done')
    expect(env.fs.writes.filter((path) => path.endsWith('.json'))).toEqual([])
  })

  it('rewrites state and pointer for a saved epic with the next generation', () => {
    const env = createRepoEnv()
    saveRevision(env, { epicId: EPIC, revisionId: R1, number: 1 })
    env.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(1))
    env.clock.advanceSeconds(60)
    insertOutbox(env.db, { kind: 'epic_state', epicId: EPIC })
    flush(env)
    const state = parseRecord(epicStateRecord, env.fs.get(files(env).state) ?? '', 'state')
    expect(state).toMatchObject({ generation: 2, updatedAt: '2026-01-01T00:01:00.000Z' })
    expect(state.ticketStatuses[tid(1)]).toBe('completed')
    expect(JSON.parse(env.fs.get(files(env).pointer) ?? '{}')).toMatchObject({ revisionId: R1, generation: 2 })
  })

  it('writes run history and tracks its hash and generation', () => {
    const env = createRepoEnv()
    seedRun(env)
    insertOutbox(env.db, { kind: 'run_history', epicId: EPIC, runId: RUN })
    expect(flush(env).flushed).toBe(1)
    const path = ownedPaths(env.layout).runHistoryFile(RUN)
    const text = env.fs.get(path) ?? ''
    expect(JSON.parse(text)).toMatchObject({ runId: RUN, epicId: EPIC, attempts: [] })
    expect(env.db.get('SELECT exported_hash, generation FROM sync_state WHERE kind = ? AND entity_id = ?', 'run', RUN)).toEqual({
      exported_hash: trackedRunHash(text),
      generation: 1
    })
    insertOutbox(env.db, { kind: 'run_history', runId: RUN })
    flush(env)
    expect(env.db.get<{ generation: number }>('SELECT generation FROM sync_state WHERE entity_id = ?', RUN)?.generation).toBe(2)
  })
})

describe('flushOutbox ordering and concurrency', () => {
  it('blocks later entries of a failed run but not other runs', () => {
    const env = createRepoEnv()
    seedRun(env)
    const otherRun = idOf('run', 2)
    insertRun(env.db, { id: otherRun, epicId: EPIC, revisionId: R1, state: 'completed' })
    insertOutbox(env.db, { kind: 'run_history', runId: RUN })
    const later = insertOutbox(env.db, { kind: 'run_history', runId: RUN })
    const other = insertOutbox(env.db, { kind: 'run_history', runId: otherRun })
    env.fs.failOn({ op: 'writeFile', match: (path) => path.includes(RUN) })
    expect(flush(env)).toMatchObject({ flushed: 1, failed: 1 })
    expect(outboxRow(env, later)?.attempts).toBe(0)
    expect(outboxRow(env, other)?.state).toBe('done')
  })

  it('skips an entry another process completed meanwhile and reports its revision as saved', () => {
    const env = createRepoEnv()
    stageRevision(env, { epicId: EPIC, revisionId: R1, number: 1 })
    const second = stageRevision(env, { epicId: OTHER_EPIC, revisionId: R2, number: 1 })
    const hook = {
      onSnapshotSaved(revisionId: string): void {
        env.hook.onSnapshotSaved(revisionId)
        env.db.run("UPDATE outbox SET state = 'done' WHERE id = ?", second)
      }
    }
    const outcome = flushOutbox(env, hook)
    expect(outcome).toMatchObject({ flushed: 1, failed: 0, savedRevisionIds: [R1, R2] })
    expect(env.fs.get(ownedPaths(env.layout).epicPointerFile(OTHER_EPIC))).toBeUndefined()
  })
})

describe('flushOutbox path safety', () => {
  it('refuses to write through a linked epics directory', () => {
    const env = createRepoEnv()
    env.fs.put(resolve('/outside/keep.txt'), 'x')
    env.fs.symlink(env.layout.epicsDir, resolve('/outside'))
    const outcome = saveRevision(env, { epicId: EPIC, revisionId: R1, number: 1 })
    expect(outcome.failed).toBe(1)
    expect(outcome.errors[0]).toContain('symbolic links and junctions are not allowed')
    expect(env.fs.writes.filter((path) => path.startsWith(resolve('/outside')))).toEqual([])
    expect([...env.fs.files().keys()].filter((path) => path.startsWith(resolve('/outside')))).toEqual([resolve('/outside/keep.txt')])
  })

  it('writes a file atomically and verifies it by reading it back', () => {
    const env = createRepoEnv()
    const target = join(env.layout.profilesDir, 'default.json')
    writeFileSafely(env, target, '{"a":1}\n')
    expect(env.fs.get(target)).toBe('{"a":1}\n')
    expect(tempFiles(env)).toEqual([])
    const verify = (): void => {
      throw new Error('mismatch')
    }
    expect(() => writeFileSafely(env, target, '{"a":2}\n', verify)).toThrow('mismatch')
  })

  it('writes ticket statuses recorded before the save into the exported state', () => {
    const env = createRepoEnv()
    insertEpic(env.db, { id: EPIC })
    insertTicketStatus(env.db, { ticketId: tid(1), epicId: EPIC, status: 'in_progress' })
    insertRevision(env.db, { id: R1, epicId: EPIC, number: 1, bundle: BUNDLE_1 })
    insertOutbox(env.db, { kind: 'snapshot', epicId: EPIC, revisionId: R1 })
    flush(env)
    expect(parseRecord(epicStateRecord, env.fs.get(files(env).state) ?? '', 's').ticketStatuses[tid(1)]).toBe('in_progress')
  })
})

const C1 = idOf('comment', 1)
const C2 = idOf('comment', 2)

function commentFile(env: RepoEnv, commentId: string, epicId = EPIC): string {
  return ownedPaths(env.layout).commentFile(epicId, commentId)
}

/** A saved epic with comment C1 on ticket 1 and its queued export. */
function seedComment(): { env: RepoEnv; entry: number } {
  const env = seedSavedFirstRevision()
  insertComment(env.db, { id: C1, epicId: EPIC, ticketId: tid(1), body: 'Blocked on **DM-2**' })
  return { env, entry: insertOutbox(env.db, { kind: 'comment', epicId: EPIC, entityId: C1 }) }
}

function commentSync(env: RepoEnv, commentId: string): unknown {
  return env.db.get('SELECT exported_hash, imported_hash, generation, conflict FROM sync_state WHERE kind = ? AND entity_id = ?', 'comment', commentId)
}

describe('flushOutbox comment exports', () => {
  it('writes each comment of a saved epic to its own file and records the exported hash', () => {
    const { env, entry } = seedComment()
    expect(flush(env)).toEqual({ flushed: 1, failed: 0, errors: [], savedRevisionIds: [], failedRevisionIds: [] })
    const text = env.fs.get(commentFile(env, C1)) ?? ''
    expect(text).toBe(prettyJson(buildCommentRecord(env.db, C1)))
    expect(JSON.parse(text)).toMatchObject({ format: 'darkmechanicus.comment', id: C1, epicId: EPIC, ticketId: tid(1), body: 'Blocked on **DM-2**' })
    expect(commentSync(env, C1)).toEqual({ exported_hash: trackedCommentHash(text), imported_hash: null, generation: 1, conflict: null })
    expect(outboxRow(env, entry)).toEqual({ state: 'done', attempts: 0, last_error: null })
  })

  it('keeps an identical file left by an interrupted flush without rewriting it', () => {
    const { env } = seedComment()
    const existing = prettyJson(buildCommentRecord(env.db, C1)).replace(/\n/g, '\r\n')
    env.fs.put(commentFile(env, C1), existing)
    expect(flush(env).flushed).toBe(1)
    expect(env.fs.writes).not.toContain(resolve(commentFile(env, C1)))
    expect(env.fs.get(commentFile(env, C1))).toBe(existing)
    expect(commentSync(env, C1)).toMatchObject({ exported_hash: trackedCommentHash(existing) })
  })

  it('fails closed when the file already holds a different comment', () => {
    const { env, entry } = seedComment()
    const foreign = prettyJson({ ...buildCommentRecord(env.db, C1), body: 'Someone else wrote this' })
    env.fs.put(commentFile(env, C1), foreign)
    const outcome = flush(env)
    const shown = `.darkmechanicus/epics/${EPIC}/comments/${C1}.json`
    expect(outcome).toEqual({
      flushed: 0,
      failed: 1,
      errors: [`comment ${C1}: ${shown} already exists with different content; comments are never rewritten.`],
      savedRevisionIds: [],
      failedRevisionIds: []
    })
    expect(env.fs.get(commentFile(env, C1))).toBe(foreign)
    expect(outboxRow(env, entry)).toMatchObject({ state: 'pending', attempts: 1 })
    expect(commentSync(env, C1)).toBeUndefined()
  })

})

describe('flushOutbox comment export failures', () => {
  it('refuses to export a comment of an epic that has never been saved', () => {
    const env = createRepoEnv()
    insertEpic(env.db, { id: EPIC })
    insertComment(env.db, { id: C1, epicId: EPIC })
    insertOutbox(env.db, { kind: 'comment', epicId: EPIC, entityId: C1 })
    expect(flush(env).errors).toEqual([`comment ${C1}: Comment ${C1} belongs to epic ${EPIC}, which has no saved plan to export it with yet.`])
    expect(env.fs.writes.filter((path) => path.endsWith('.json'))).toEqual([])
  })

  it('drops a new comment file that could not be verified so the retry writes it again', () => {
    const { env, entry } = seedComment()
    env.fs.failOn({ op: 'readFile', match: (path) => path.endsWith(`${C1}.json`) })
    expect(flush(env).failed).toBe(1)
    expect(env.fs.get(commentFile(env, C1))).toBeUndefined()
    expect(tempFiles(env)).toEqual([])
    expect(flush(env).flushed).toBe(1)
    expect(outboxRow(env, entry)).toMatchObject({ state: 'done', attempts: 1 })
  })
})

describe('flushOutbox comment ordering', () => {
  it('never lets a failing comment hold back its epic or other comments', () => {
    const { env } = seedComment()
    env.fs.put(commentFile(env, C1), prettyJson({ ...buildCommentRecord(env.db, C1), body: 'different' }))
    const retry = insertOutbox(env.db, { kind: 'comment', epicId: EPIC, entityId: C1 })
    const state = insertOutbox(env.db, { kind: 'epic_state', epicId: EPIC })
    insertComment(env.db, { id: C2, epicId: EPIC })
    const other = insertOutbox(env.db, { kind: 'comment', epicId: EPIC, entityId: C2 })
    expect(flush(env)).toMatchObject({ flushed: 2, failed: 1 })
    expect(outboxRow(env, retry)).toEqual({ state: 'pending', attempts: 0, last_error: null })
    expect(outboxRow(env, state)?.state).toBe('done')
    expect(outboxRow(env, other)?.state).toBe('done')
  })

  it('exports comments while an earlier save of their epic keeps failing', () => {
    const { env, entry } = seedComment()
    env.db.run('DELETE FROM outbox WHERE id = ?', entry)
    stageRevision(env, { epicId: EPIC, revisionId: R2, number: 2, bundle: BUNDLE_2, baseRevisionId: R1 })
    const comment = insertOutbox(env.db, { kind: 'comment', epicId: EPIC, entityId: C1 })
    env.fs.failOn({ op: 'writeFile', match: (path) => path.includes(`${R2}.json.tmp-`) })
    expect(flush(env)).toMatchObject({ flushed: 1, failed: 1, failedRevisionIds: [R2] })
    expect(outboxRow(env, comment)?.state).toBe('done')
  })
})

describe('flushOutbox passes', () => {
  it('flushes entries queued while flushing, such as comments released by a first save', () => {
    const env = createRepoEnv()
    stageRevision(env, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE_1 })
    insertComment(env.db, { id: C1, epicId: EPIC })
    const hook = {
      onSnapshotSaved(revisionId: string): void {
        env.hook.onSnapshotSaved(revisionId)
        insertOutbox(env.db, { kind: 'comment', epicId: EPIC, entityId: C1 })
      }
    }
    expect(flushOutbox(env, hook)).toEqual({ flushed: 2, failed: 0, errors: [], savedRevisionIds: [R1], failedRevisionIds: [] })
    expect(parseRecord(snapshotRecord, env.fs.get(files(env).snapshot(R1)) ?? '', 's').revisionId).toBe(R1)
    expect(JSON.parse(env.fs.get(commentFile(env, C1)) ?? '{}')).toMatchObject({ id: C1, epicId: EPIC })
  })

  it('stops after three passes, leaving entries queued by the third for the next flush', () => {
    const env = createRepoEnv()
    const revisions = [1, 2, 3, 4].map((n) => idOf('revision', n))
    const epics = [1, 2, 3, 4].map((n) => idOf('epic', n))
    revisions.forEach((revisionId, index) => {
      insertEpic(env.db, { id: epics[index] ?? '' })
      insertRevision(env.db, { id: revisionId, epicId: epics[index] ?? '', number: 1, bundle: BUNDLE_1 })
    })
    insertOutbox(env.db, { kind: 'snapshot', epicId: epics[0], revisionId: revisions[0] })
    const hook = {
      onSnapshotSaved(revisionId: string): void {
        env.hook.onSnapshotSaved(revisionId)
        const next = revisions.indexOf(revisionId) + 1
        insertOutbox(env.db, { kind: 'snapshot', epicId: epics[next], revisionId: revisions[next] })
      }
    }
    expect(flushOutbox(env, hook).savedRevisionIds).toEqual(revisions.slice(0, 3))
    expect(revisionState(env, revisions[3] ?? '')).toBe('pending')
    expect(env.db.all("SELECT revision_id FROM outbox WHERE state = 'pending'")).toEqual([{ revision_id: revisions[3] }])
  })
})
