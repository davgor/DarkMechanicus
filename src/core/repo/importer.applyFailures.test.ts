/** Records the database refuses, comments whose epic is not imported, and run folders without their history file. */
import { describe, expect, it } from 'vitest'
import { makeBundle, tid } from '../../test/bundles'
import { pngBytes } from '../../test/images'
import { copyTracked, createRepoEnv, createStubGit, flush, importerDeps, initProject, type RepoEnv, saveRevision } from '../../test/repoEnv'
import { idOf, insertAttempt, insertComment, insertEpic, insertOutbox, insertRevision, insertRun } from '../../test/repoFixtures'
import { createTestCtx } from '../../test/testContext'
import { claimAttachments, createStagedAttachment } from '../services/attachments'
import { reconcileRepository } from './importer'
import { ownedPaths } from './paths'

const EPIC = idOf('epic', 1)
const R1 = idOf('revision', 1)
const RUN = idOf('run', 1)
const COMMENT = idOf('comment', 1)
const EPIC_DIR = `.darkmechanicus/epics/${EPIC}`
const COMMENT_FILE = `${EPIC_DIR}/comments/${COMMENT}.json`

/** A source that exported an epic, a completed run with one attempt, and a comment; and a fresh clone of its records. */
function pulled(withImage = false): { source: RepoEnv; target: RepoEnv } {
  const source = createRepoEnv({ root: '/source' })
  initProject(source)
  saveRevision(source, { epicId: EPIC, revisionId: R1, number: 1, bundle: makeBundle([[1, 2]], [[1, 2]]) })
  insertRun(source.db, { id: RUN, epicId: EPIC, revisionId: R1, state: 'completed' })
  insertAttempt(source.db, { id: idOf('attempt', 1), runId: RUN, ticketId: tid(1), revisionId: R1 })
  insertOutbox(source.db, { kind: 'run_history', runId: RUN })
  insertComment(source.db, { id: COMMENT, epicId: EPIC })
  if (withImage) {
    const ctx = createTestCtx({ db: source.db, clock: source.clock })
    const image = createStagedAttachment(ctx, { bytes: pngBytes(40, 30, 3), label: 'shot', purpose: 'evidence' })
    claimAttachments(ctx, [image.id], { kind: 'comment', id: COMMENT })
  }
  insertOutbox(source.db, { kind: 'comment', epicId: EPIC, entityId: COMMENT })
  expect(flush(source).failed).toBe(0)
  const target = createRepoEnv({ root: '/clone' })
  copyTracked(source, target)
  return { source, target }
}

const reconcile = (env: RepoEnv) => reconcileRepository(importerDeps(env, createStubGit('main')))
const count = (env: RepoEnv, table: 'epics' | 'runs' | 'comments'): number => env.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0

describe('reconcileRepository when the database refuses a record', () => {
  it('rejects an epic it cannot apply, and leaves its run and comment for a later reconcile', () => {
    const { target } = pulled()
    target.db.exec("CREATE TRIGGER refuse_epic BEFORE INSERT ON epics BEGIN SELECT RAISE(ABORT, 'refused'); END")
    const result = reconcile(target)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: 'Could not be applied: refused' }])
    expect(result.imported).toEqual([])
    expect([count(target, 'epics'), count(target, 'runs'), count(target, 'comments')]).toEqual([0, 0, 0])
  })

  it('rejects only the comment it cannot apply and imports the epic and run', () => {
    const { target } = pulled()
    target.db.exec("CREATE TRIGGER refuse_comment BEFORE INSERT ON comments BEGIN SELECT RAISE(ABORT, 'refused'); END")
    const result = reconcile(target)
    expect(result.rejected).toEqual([{ path: COMMENT_FILE, message: 'Could not be applied: refused' }])
    expect(result.imported).toEqual([EPIC, RUN])
    expect(count(target, 'comments')).toBe(0)
  })
})

describe('reconcileRepository and a comment whose epic is not imported', () => {
  it('leaves the comment unread-as-imported, explained by its epic\'s own rejection', () => {
    const { target } = pulled()
    const other = idOf('epic', 2)
    insertEpic(target.db, { id: other })
    insertRevision(target.db, { id: R1, epicId: other, number: 1, bundle: makeBundle([[5]]), state: 'saved' })
    const result = reconcile(target)
    expect(result.rejected).toEqual([{ path: EPIC_DIR, message: `Revision ${R1} already exists locally with different content or another epic.` }])
    expect(result.imported).toEqual([])
    expect(count(target, 'comments')).toBe(0)
  })
})

describe('reconcileRepository and a comment image already registered here', () => {
  it('imports the comment and keeps the one registered image row', () => {
    const { source, target } = pulled(true)
    const row = source.db.get<Record<string, string | number>>('SELECT * FROM attachments')
    if (row === undefined) throw new Error('The source holds no comment image.')
    target.db.run(
      `INSERT INTO attachments (id, sha256, mime, bytes, width, height, label, purpose, owner_kind, owner_id, missing, data,
         created_by_role, created_by_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'comment', ?, 0, NULL, ?, ?, ?)`,
      ...(['id', 'sha256', 'mime', 'bytes', 'width', 'height', 'label', 'purpose', 'owner_id', 'created_by_role', 'created_by_label', 'created_at'] as const).map(
        (column) => row[column] ?? ''
      )
    )
    const result = reconcile(target)
    expect(result.imported).toEqual([EPIC, RUN, COMMENT])
    expect(result.rejected).toEqual([])
    expect(target.db.all('SELECT id, owner_kind, owner_id FROM attachments')).toEqual([{ id: row['id'], owner_kind: 'comment', owner_id: COMMENT }])
  })
})

describe('reconcileRepository and a run folder without its history file', () => {
  it('rejects the run folder, naming the missing run.json', () => {
    const { target } = pulled()
    const stray = idOf('run', 2)
    target.fs.mkdirp(ownedPaths(target.layout).runDir(stray))
    const result = reconcile(target)
    const shown = `.darkmechanicus/history/${stray}`
    expect(result.rejected).toEqual([{ path: shown, message: `${shown}/run.json is missing.` }])
    expect(result.imported).toEqual([EPIC, RUN, COMMENT])
  })
})
