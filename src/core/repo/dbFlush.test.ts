/** Flushing a database-only project: the save completes, and no record file is ever written. */
import { describe, expect, it } from 'vitest'
import { makeBundle } from '../../test/bundles'
import { createRepoEnv, flush, type RepoEnv, stageRevision } from '../../test/repoEnv'
import {
  idOf,
  insertComment,
  insertEpic,
  insertOutbox,
  insertProfile,
  insertRevision,
  insertRun
} from '../../test/repoFixtures'
import { getMeta, META_KEYS } from '../meta'

const EPIC = idOf('epic', 1)
const R1 = idOf('revision', 1)
const RUN = idOf('run', 1)
const COMMENT = idOf('comment', 1)
const BUNDLE = makeBundle([[1, 2]], [[1, 2]])

function dbEnv(): RepoEnv {
  return createRepoEnv({ mode: 'db' })
}

function outboxStates(env: RepoEnv): string[] {
  return env.db.all<{ state: string }>('SELECT state FROM outbox ORDER BY id').map((row) => row.state)
}

function revisionState(env: RepoEnv, revisionId: string): string | undefined {
  return env.db.get<{ state: string }>('SELECT state FROM plan_revisions WHERE id = ?', revisionId)?.state
}

describe('flush in db mode', () => {
  it('completes a staged save without writing a snapshot, state or pointer file', () => {
    const env = dbEnv()
    stageRevision(env, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE })
    const outcome = flush(env)
    expect(outcome).toEqual({ flushed: 1, failed: 0, errors: [], savedRevisionIds: [R1], failedRevisionIds: [] })
    expect(revisionState(env, R1)).toBe('saved')
    expect(env.hook.calls).toEqual([R1])
    expect([...env.fs.files().keys()]).toEqual([])
  })

  it('records the flush time and leaves nothing pending', () => {
    const env = dbEnv()
    stageRevision(env, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE })
    flush(env)
    expect(outboxStates(env)).toEqual(['done'])
    expect(getMeta(env.db, META_KEYS.lastFlushAt)).not.toBeNull()
  })

  it('is idempotent: a second flush has nothing left to do', () => {
    const env = dbEnv()
    stageRevision(env, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE })
    flush(env)
    expect(flush(env)).toEqual({ flushed: 0, failed: 0, errors: [], savedRevisionIds: [], failedRevisionIds: [] })
    expect(revisionState(env, R1)).toBe('saved')
  })
})

describe('flush in db mode for the other kinds of entry', () => {
  it('completes every one without a file, recording only the comment that must not be re-queued', () => {
    const env = dbEnv()
    insertEpic(env.db, { id: EPIC })
    insertRevision(env.db, { id: R1, epicId: EPIC, number: 1, bundle: BUNDLE, state: 'saved' })
    insertRun(env.db, { id: RUN, epicId: EPIC, revisionId: R1 })
    insertComment(env.db, { id: COMMENT, epicId: EPIC })
    insertProfile(env.db, { name: 'fast-lane' })
    insertOutbox(env.db, { kind: 'epic_state', epicId: EPIC })
    insertOutbox(env.db, { kind: 'run_history', runId: RUN })
    insertOutbox(env.db, { kind: 'comment', epicId: EPIC, entityId: COMMENT })
    insertOutbox(env.db, { kind: 'profile', entityId: 'fast-lane' })
    const outcome = flush(env)
    expect(outcome.flushed).toBe(4)
    expect(outcome.failed).toBe(0)
    expect(outboxStates(env)).toEqual(['done', 'done', 'done', 'done'])
    // Only the comment is recorded, and only so a later save does not queue it again.
    expect(env.db.all<{ kind: string; entity_id: string }>('SELECT kind, entity_id FROM sync_state')).toEqual([
      { kind: 'comment', entity_id: COMMENT }
    ])
    expect([...env.fs.files().keys()]).toEqual([])
  })

})

describe('flush in db mode and the repository folder', () => {
  it('writes nothing into it even when the filesystem would allow it', () => {
    const env = dbEnv()
    stageRevision(env, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE })
    insertOutbox(env.db, { kind: 'epic_state', epicId: EPIC })
    flush(env)
    expect(env.fs.writes.filter((path) => path.startsWith(env.root))).toEqual([])
  })

  it('keeps a save whose database side failed pending, and completes it on the retry', () => {
    const env = dbEnv()
    const id = stageRevision(env, { epicId: EPIC, revisionId: R1, number: 1, bundle: BUNDLE })
    env.hook.failNext = true
    const failed = flush(env)
    expect(failed).toMatchObject({ flushed: 0, failed: 1, failedRevisionIds: [R1] })
    expect(failed.errors[0]).toContain('Injected DB commit failure')
    const row = env.db.get<{ state: string; attempts: number }>('SELECT state, attempts FROM outbox WHERE id = ?', id)
    expect(row).toMatchObject({ state: 'pending', attempts: 1 })
    expect(revisionState(env, R1)).toBe('pending')
    expect(flush(env)).toMatchObject({ flushed: 1, failed: 0 })
    expect(revisionState(env, R1)).toBe('saved')
  })
})

describe('flush in db mode and repeated saves', () => {
  /**
   * `completeSavedRevision` re-enqueues every comment of an epic that has no `sync_state` row, so
   * each save of an epic with comments would queue them again forever if db mode never settled
   * them. The entries always complete, but the table would grow with every save.
   */
  it('settles each comment once, so saving the same epic again does not queue it anew', () => {
    const env = dbEnv()
    insertEpic(env.db, { id: EPIC })
    insertComment(env.db, { id: COMMENT, epicId: EPIC })
    insertOutbox(env.db, { kind: 'comment', epicId: EPIC, entityId: COMMENT })
    flush(env)
    expect(env.db.all('SELECT * FROM outbox')).toHaveLength(1)

    // A later save of the same epic looks for comments that are not accounted for.
    insertOutbox(env.db, { kind: 'comment', epicId: EPIC, entityId: COMMENT })
    const unexported = env.db.all<{ id: string }>(
      `SELECT c.id FROM comments c
       WHERE c.epic_id = ?
         AND NOT EXISTS (SELECT 1 FROM sync_state s WHERE s.kind = 'comment' AND s.entity_id = c.id)`,
      EPIC
    )
    expect(unexported).toEqual([])
  })
})
