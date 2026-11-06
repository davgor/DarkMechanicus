/** Attachment image files: written beside their owner's records before the record that points at them, and imported back. */
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeBundle, tid } from '../../test/bundles'
import { jpegBytes, pngBytes } from '../../test/images'
import { createStubGit, copyTracked, createRepoEnv, flush, importerDeps, initProject, type RepoEnv, saveRevision, stageRevision } from '../../test/repoEnv'
import { idOf, insertAttempt, insertComment, insertEpic, insertOutbox, insertRun } from '../../test/repoFixtures'
import { claim as claimTicket, startedRun, submitClaim } from '../../test/execution'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { type AttachmentOwner } from '../../shared/domain/views'
import { claimAttachments, createStagedAttachment } from '../services/attachments'
import { resolveAttachmentPlacement } from '../services/attachmentOwners'
import { claimKanbanCard, playKanbanCard, submitKanbanCard } from '../services/kanban/attempts'
import { createKanbanCard } from '../services/kanban/cards'
import { loadStoredAttachment, placementOfAttachment, writeAttachmentFile } from './attachmentFiles'
import { removeEpicFiles } from './epicRemoval'
import { reconcileRepository } from './importer'
import { ownedPaths } from './paths'

const EPIC = idOf('epic', 1)
const R1 = idOf('revision', 1)
const RUN = idOf('run', 1)
const ATTEMPT = idOf('attempt', 1)
const COMMENT = idOf('comment', 1)

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

interface Fixture {
  env: RepoEnv
  ctx: TestCtx
}

function fixture(mode: 'repo' | 'db' = 'repo'): Fixture {
  const env = createRepoEnv({ root: '/source', mode })
  initProject(env)
  return { env, ctx: createTestCtx({ db: env.db, clock: env.clock }) }
}

/** A saved epic with a run and one attempt on its first ticket, and a comment. */
function seedEpic(env: RepoEnv): void {
  saveRevision(env, { epicId: EPIC, revisionId: R1, number: 1, bundle: makeBundle([[1, 2]], [[1, 2]]) })
  insertRun(env.db, { id: RUN, epicId: EPIC, revisionId: R1 })
  insertAttempt(env.db, { id: ATTEMPT, runId: RUN, ticketId: tid(1), revisionId: R1 })
  insertComment(env.db, { id: COMMENT, epicId: EPIC })
}

function stage(ctx: TestCtx, bytes: Buffer): string {
  return createStagedAttachment(ctx, { bytes, label: 'shot', purpose: 'evidence' }).id
}

function claim(ctx: TestCtx, bytes: Buffer, owner: AttachmentOwner): string {
  const id = stage(ctx, bytes)
  claimAttachments(ctx, [id], owner)
  return id
}

function writeIndex(env: RepoEnv, path: string): number {
  return env.fs.writes.lastIndexOf(resolve(path))
}

describe('attachment export (repo mode)', () => {
  it('writes an attempt image into its run folder before the run record, byte for byte', () => {
    const { env, ctx } = fixture()
    seedEpic(env)
    flush(env)
    const bytes = pngBytes(40, 30, 1)
    // The run record is queued first and the claim after it: the file must still come first.
    env.db.run("INSERT INTO outbox (kind, epic_id, run_id, state, created_at) VALUES ('run_history', ?, ?, 'pending', ?)", EPIC, RUN, '2026-01-01T00:00:00.000Z')
    const id = claim(ctx, bytes, { kind: 'attempt', id: ATTEMPT })
    expect(flush(env)).toMatchObject({ failed: 0, errors: [] })
    const paths = ownedPaths(env.layout)
    const file = paths.attachmentFile({ kind: 'run', id: RUN }, sha(bytes), 'image/png')
    expect(file).toContain(RUN)
    expect(Buffer.from(env.fs.getBytes(file) ?? []).equals(bytes)).toBe(true)
    expect(writeIndex(env, file)).toBeGreaterThan(-1)
    expect(writeIndex(env, file)).toBeLessThan(writeIndex(env, paths.runHistoryFile(RUN)))
    expect(env.db.get('SELECT exported_hash FROM sync_state WHERE kind = ? AND entity_id = ?', 'attachment', id)).toEqual({ exported_hash: sha(bytes) })
    expect(env.db.all("SELECT kind FROM outbox WHERE state <> 'done'")).toEqual([])
  })

  it('writes ticket images before the epic state and comment images before the comment', () => {
    const { env, ctx } = fixture()
    seedEpic(env)
    flush(env)
    const ticketBytes = pngBytes(40, 30, 2)
    const commentBytes = jpegBytes(10, 20)
    claim(ctx, ticketBytes, { kind: 'ticket', id: tid(1) })
    claim(ctx, commentBytes, { kind: 'comment', id: COMMENT })
    env.db.run("INSERT INTO outbox (kind, epic_id, state, created_at) VALUES ('epic_state', ?, 'pending', ?)", EPIC, '2026-01-01T00:00:00.000Z')
    env.db.run("INSERT INTO outbox (kind, epic_id, entity_id, state, created_at) VALUES ('comment', ?, ?, 'pending', ?)", EPIC, COMMENT, '2026-01-01T00:00:00.000Z')
    expect(flush(env)).toMatchObject({ failed: 0, errors: [] })
    const paths = ownedPaths(env.layout)
    const ticketFile = paths.attachmentFile({ kind: 'epic', id: EPIC }, sha(ticketBytes), 'image/png')
    const commentFile = paths.attachmentFile({ kind: 'epic', id: EPIC }, sha(commentBytes), 'image/jpeg')
    expect(commentFile.endsWith('.jpg')).toBe(true)
    expect(Buffer.from(env.fs.getBytes(ticketFile) ?? []).equals(ticketBytes)).toBe(true)
    expect(Buffer.from(env.fs.getBytes(commentFile) ?? []).equals(commentBytes)).toBe(true)
    expect(writeIndex(env, ticketFile)).toBeLessThan(writeIndex(env, paths.epicStateFile(EPIC)))
    expect(writeIndex(env, commentFile)).toBeLessThan(writeIndex(env, paths.commentFile(EPIC, COMMENT)))
  })

})

describe('attachment export of cards (repo mode)', () => {
  it('writes card images into the card folder before card.json', () => {
    const { env, ctx } = fixture()
    const card = createKanbanCard(ctx, { title: 'Card with a mockup' })
    const bytes = pngBytes(40, 30, 3)
    claim(ctx, bytes, { kind: 'kanban_card', id: card.id })
    expect(flush(env)).toMatchObject({ failed: 0, errors: [] })
    const paths = ownedPaths(env.layout)
    const file = paths.attachmentFile({ kind: 'kanban_card', id: card.id }, sha(bytes), 'image/png')
    expect(Buffer.from(env.fs.getBytes(file) ?? []).equals(bytes)).toBe(true)
    expect(writeIndex(env, file)).toBeLessThan(writeIndex(env, paths.kanbanCardFile(card.id)))
  })

})

describe('attachment export idempotence (repo mode)', () => {
  it('writes the file once: a second flush leaves it alone', () => {
    const { env, ctx } = fixture()
    seedEpic(env)
    flush(env)
    const bytes = pngBytes(40, 30, 4)
    claim(ctx, bytes, { kind: 'attempt', id: ATTEMPT })
    flush(env)
    const file = ownedPaths(env.layout).attachmentFile({ kind: 'run', id: RUN }, sha(bytes), 'image/png')
    const before = env.fs.writes.filter((path) => path === resolve(file)).length
    env.db.run("INSERT INTO outbox (kind, entity_id, state, created_at) SELECT 'attachment', id, 'pending', created_at FROM attachments")
    flush(env)
    expect(env.fs.writes.filter((path) => path === resolve(file))).toHaveLength(before)
  })

})

describe('attachment export failures (repo mode)', () => {
  it('fails the entry with the reason, and writes nothing, when the owner has no folder', () => {
    const { env, ctx } = fixture()
    seedEpic(env)
    flush(env)
    const before = env.fs.writes.length
    claim(ctx, pngBytes(40, 30, 5), { kind: 'ticket', id: tid(1) })
    env.db.run('DELETE FROM ticket_status WHERE ticket_id = ?', tid(1))
    const outcome = flush(env)
    expect(outcome.failed).toBe(1)
    expect(outcome.errors[0]).toContain('folder cannot be found')
    expect(env.fs.writes).toHaveLength(before)
    expect(env.db.all<{ state: string; last_error: string }>("SELECT state, last_error FROM outbox WHERE kind = 'attachment'")[0]?.last_error).toContain(
      'folder cannot be found'
    )
  })

})

describe('attachment export of unsaved and vanished records (repo mode)', () => {
  it('finishes the first save of a never-saved epic that holds a comment image, then exports the image with the comment', () => {
    const { env, ctx } = fixture()
    insertEpic(env.db, { id: EPIC })
    insertComment(env.db, { id: COMMENT, epicId: EPIC })
    const bytes = pngBytes(40, 30, 11)
    claim(ctx, bytes, { kind: 'comment', id: COMMENT })
    expect(env.db.all("SELECT kind FROM outbox WHERE kind = 'attachment'")).toEqual([])
    stageRevision(env, { epicId: EPIC, revisionId: R1, number: 1, bundle: makeBundle([[1, 2]], [[1, 2]]) })
    expect(flush(env)).toMatchObject({ failed: 0, errors: [], savedRevisionIds: [R1] })
    const paths = ownedPaths(env.layout)
    expect(env.fs.exists(paths.epicPointerFile(EPIC))).toBe(true)
    insertOutbox(env.db, { kind: 'comment', epicId: EPIC, entityId: COMMENT })
    expect(flush(env)).toMatchObject({ failed: 0, errors: [] })
    const file = paths.attachmentFile({ kind: 'epic', id: EPIC }, sha(bytes), 'image/png')
    expect(Buffer.from(env.fs.getBytes(file) ?? []).equals(bytes)).toBe(true)
    expect(writeIndex(env, file)).toBeLessThan(writeIndex(env, paths.commentFile(EPIC, COMMENT)))
  })

  it('flushes a queued attachment whose row was deleted as done, and writes nothing', () => {
    const { env, ctx } = fixture()
    seedEpic(env)
    flush(env)
    const id = claim(ctx, pngBytes(40, 30, 12), { kind: 'attempt', id: ATTEMPT })
    env.db.run('DELETE FROM attachments WHERE id = ?', id)
    const before = env.fs.writes.length
    expect(flush(env)).toMatchObject({ failed: 0, errors: [] })
    expect(env.fs.writes).toHaveLength(before)
    expect(env.db.all("SELECT kind FROM outbox WHERE state <> 'done'")).toEqual([])
  })

  it('fails the entry when the stored bytes do not match their hash, leaving no file', () => {
    const { env, ctx } = fixture()
    seedEpic(env)
    flush(env)
    const bytes = pngBytes(40, 30, 6)
    const id = claim(ctx, bytes, { kind: 'attempt', id: ATTEMPT })
    env.db.run('UPDATE attachments SET data = ? WHERE id = ?', Buffer.from('tampered'), id)
    expect(flush(env).errors.join('\n')).toContain('do not match its sha256')
    const file = ownedPaths(env.layout).attachmentFile({ kind: 'run', id: RUN }, sha(bytes), 'image/png')
    expect(env.fs.exists(file)).toBe(false)
  })

  it('leaves no temp file behind when the write fails', () => {
    const { env, ctx } = fixture()
    seedEpic(env)
    flush(env)
    claim(ctx, pngBytes(40, 30, 7), { kind: 'attempt', id: ATTEMPT })
    env.fs.failOn({ op: 'rename', match: (path) => path.endsWith('.png') })
    expect(flush(env).failed).toBeGreaterThan(0)
    const leftovers = [...env.fs.files().keys()].filter((path) => path.includes('.tmp-') && path.includes('attachments'))
    expect(leftovers).toEqual([])
  })
})

describe('attachment export (db mode)', () => {
  it('completes the entry and writes no file', () => {
    const { env, ctx } = fixture('db')
    seedEpic(env)
    flush(env)
    const before = env.fs.writes.length
    claim(ctx, pngBytes(40, 30, 8), { kind: 'attempt', id: ATTEMPT })
    expect(env.db.all("SELECT kind FROM outbox WHERE state = 'pending'")).toEqual([{ kind: 'attachment' }])
    expect(flush(env)).toMatchObject({ failed: 0, errors: [] })
    expect(env.fs.writes).toHaveLength(before)
    expect(env.db.all("SELECT kind FROM outbox WHERE state <> 'done'")).toEqual([])
  })
})

describe('epic removal', () => {
  it('removes the attachments folders with the epic and its runs', () => {
    const { env, ctx } = fixture()
    seedEpic(env)
    flush(env)
    const runBytes = pngBytes(40, 30, 9)
    const epicBytes = pngBytes(40, 30, 10)
    claim(ctx, runBytes, { kind: 'attempt', id: ATTEMPT })
    claim(ctx, epicBytes, { kind: 'ticket', id: tid(1) })
    flush(env)
    const paths = ownedPaths(env.layout)
    const runFile = paths.attachmentFile({ kind: 'run', id: RUN }, sha(runBytes), 'image/png')
    const epicFile = paths.attachmentFile({ kind: 'epic', id: EPIC }, sha(epicBytes), 'image/png')
    expect(env.fs.exists(runFile) && env.fs.exists(epicFile)).toBe(true)
    removeEpicFiles(env, EPIC, [RUN])
    expect(env.fs.exists(runFile) || env.fs.exists(epicFile)).toBe(false)
    expect(env.fs.exists(paths.attachmentsDir({ kind: 'epic', id: EPIC }))).toBe(false)
  })
})

interface Imported {
  source: RepoEnv
  target: RepoEnv
  ctx: TestCtx
  bytes: { run: Buffer; ticket: Buffer; comment: Buffer; card: Buffer }
  ids: { run: string; ticket: string; comment: string; card: string }
  cardId: string
  reconcile: () => ReturnType<typeof reconcileRepository>
}

/** A source with one image per owner kind exported, a clone of it that has the records, and the image rows without bytes. */
function importedFixture(): Imported {
  const { env: source, ctx } = fixture()
  seedEpic(source)
  const card = createKanbanCard(ctx, { title: 'Card with a mockup' })
  const bytes = { run: pngBytes(40, 30, 11), ticket: pngBytes(40, 30, 12), comment: jpegBytes(10, 20), card: pngBytes(40, 30, 13) }
  const ids = {
    run: claim(ctx, bytes.run, { kind: 'attempt', id: ATTEMPT }),
    ticket: claim(ctx, bytes.ticket, { kind: 'ticket', id: tid(1) }),
    comment: claim(ctx, bytes.comment, { kind: 'comment', id: COMMENT }),
    card: claim(ctx, bytes.card, { kind: 'kanban_card', id: card.id })
  }
  source.db.run("INSERT INTO outbox (kind, epic_id, run_id, state, created_at) VALUES ('run_history', ?, ?, 'pending', ?)", EPIC, RUN, '2026-01-01T00:00:00.000Z')
  source.db.run("INSERT INTO outbox (kind, epic_id, entity_id, state, created_at) VALUES ('comment', ?, ?, 'pending', ?)", EPIC, COMMENT, '2026-01-01T00:00:00.000Z')
  expect(flush(source)).toMatchObject({ failed: 0 })
  const target = createRepoEnv({ root: '/clone' })
  copyTracked(source, target)
  const deps = importerDeps(target, createStubGit('main'))
  reconcileRepository(deps)
  for (const row of source.db.all<Record<string, unknown>>('SELECT * FROM attachments')) {
    target.db.run(
      `INSERT INTO attachments (id, sha256, mime, bytes, width, height, label, purpose, owner_kind, owner_id, missing, data,
         created_by_role, created_by_label, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
      ...(['id', 'sha256', 'mime', 'bytes', 'width', 'height', 'label', 'purpose', 'owner_kind', 'owner_id', 'created_by_role', 'created_by_label', 'created_at'] as const).map(
        (column) => row[column] as string | number
      )
    )
  }
  return { source, target, ctx, bytes, ids, cardId: card.id, reconcile: () => reconcileRepository(deps) }
}

function stored(env: RepoEnv, id: string): { missing: number; data: Uint8Array | null } {
  return env.db.get<{ missing: number; data: Uint8Array | null }>('SELECT missing, data FROM attachments WHERE id = ?', id) ?? { missing: -1, data: null }
}

describe('attachment import', () => {
  it('restores byte-identical attachments for every owner kind after an export and a clone', () => {
    const f = importedFixture()
    expect(f.reconcile().rejected).toEqual([])
    for (const key of ['run', 'ticket', 'comment', 'card'] as const) {
      const row = stored(f.target, f.ids[key])
      expect(row.missing).toBe(0)
      expect(Buffer.from(row.data ?? []).equals(f.bytes[key])).toBe(true)
    }
  })

  it('flags a missing file as missing without failing, and restores it once the file arrives', () => {
    const f = importedFixture()
    const file = ownedPaths(f.target.layout).attachmentFile({ kind: 'epic', id: EPIC }, sha(f.bytes.ticket), 'image/png')
    f.target.fs.remove(file)
    const result = f.reconcile()
    expect(result.rejected).toEqual([])
    expect(stored(f.target, f.ids.ticket)).toEqual({ missing: 1, data: null })
    expect(stored(f.target, f.ids.run).missing).toBe(0)
    f.target.fs.putBytes(file, f.bytes.ticket)
    f.reconcile()
    expect(stored(f.target, f.ids.ticket).missing).toBe(0)
    expect(Buffer.from(stored(f.target, f.ids.ticket).data ?? []).equals(f.bytes.ticket)).toBe(true)
  })

  it('refuses a file whose bytes do not match the hash in its name', () => {
    const f = importedFixture()
    const file = ownedPaths(f.target.layout).attachmentFile({ kind: 'run', id: RUN }, sha(f.bytes.run), 'image/png')
    f.target.fs.putBytes(file, pngBytes(40, 30, 99))
    const result = f.reconcile()
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]?.message).toContain('hash differs')
    expect(stored(f.target, f.ids.run)).toEqual({ missing: 1, data: null })
    expect(stored(f.target, f.ids.card).missing).toBe(0)
  })

  it('refuses a file that is not a PNG or JPEG even when its hash matches its name', () => {
    const f = importedFixture()
    const junk = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
    const paths = ownedPaths(f.target.layout)
    const file = paths.attachmentFile({ kind: 'kanban_card', id: f.cardId }, sha(f.bytes.card), 'image/png')
    f.target.fs.remove(file)
    const named = paths.attachmentFile({ kind: 'kanban_card', id: f.cardId }, sha(junk), 'image/png')
    f.target.fs.putBytes(named, junk)
    f.target.db.run('UPDATE attachments SET sha256 = ?, bytes = ? WHERE id = ?', sha(junk), junk.length, f.ids.card)
    const result = f.reconcile()
    expect(result.rejected[0]?.message).toContain('Unsupported image type')
    expect(stored(f.target, f.ids.card)).toEqual({ missing: 1, data: null })
  })

})

/** A fresh clone that holds only the tracked files of `source`, and its reconcile. */
function cloneOf(source: RepoEnv): { target: RepoEnv; reconcile: () => ReturnType<typeof reconcileRepository> } {
  const target = createRepoEnv({ root: '/clone' })
  copyTracked(source, target)
  const deps = importerDeps(target, createStubGit('main'))
  return { target, reconcile: () => reconcileRepository(deps) }
}

describe('attachments named by a submission (repo mode round trip)', () => {
  it('restores an epic attempt image byte for byte in a fresh clone, from the submission alone', () => {
    const { env, ctx } = fixture()
    const { runId } = startedRun(ctx, { bundle: makeBundle([[1, 2]], [[1, 2]]) })
    flush(env)
    const claimed = claimTicket(ctx, runId, 1)
    const bytes = pngBytes(40, 30, 21)
    const id = stage(ctx, bytes)
    submitClaim(withRole(ctx, 'worker'), claimed, { evidence: { notes: 'Shot', attachments: [id] } })
    expect(flush(env)).toMatchObject({ failed: 0, errors: [] })
    const { target, reconcile } = cloneOf(env)
    expect(reconcile().rejected).toEqual([])
    expect(target.db.get('SELECT owner_kind, owner_id, missing FROM attachments WHERE id = ?', id)).toEqual({
      owner_kind: 'attempt',
      owner_id: claimed.attempt.id,
      missing: 0
    })
    expect(Buffer.from(stored(target, id).data ?? []).equals(bytes)).toBe(true)
  })

  it('restores a Kanban card attempt image byte for byte in a fresh clone, from the submitted event alone', () => {
    const { env } = fixture()
    const desktop = createTestCtx({ db: env.db, clock: env.clock, role: 'desktop', checkout: { branch: 'feature/cards', commit: null } })
    const card = createKanbanCard(desktop, { title: 'Card with a screenshot', acceptanceCriteria: ['It shows'] })
    playKanbanCard(desktop, { cardId: card.id })
    const packet = claimKanbanCard(withRole(desktop, 'orchestrator'), { cardId: card.id })
    const bytes = pngBytes(40, 30, 22)
    const worker = withRole(desktop, 'worker')
    const id = stage(worker, bytes)
    submitKanbanCard(worker, {
      attemptId: packet.attemptId,
      claimToken: packet.claimToken ?? '',
      outputs: { summary: 'Screenshot attached' },
      evidence: { attachments: [id] }
    })
    expect(flush(env)).toMatchObject({ failed: 0, errors: [] })
    const { target, reconcile } = cloneOf(env)
    expect(reconcile().rejected).toEqual([])
    expect(target.db.get('SELECT owner_kind, owner_id, missing FROM attachments WHERE id = ?', id)).toEqual({
      owner_kind: 'kanban_attempt',
      owner_id: packet.attemptId,
      missing: 0
    })
    expect(Buffer.from(stored(target, id).data ?? []).equals(bytes)).toBe(true)
  })
})

describe('attachment import refusals', () => {
  it('refuses a symbolic link in attachments/', () => {
    const f = importedFixture()
    const paths = ownedPaths(f.target.layout)
    const file = paths.attachmentFile({ kind: 'epic', id: EPIC }, sha(f.bytes.ticket), 'image/png')
    const elsewhere = paths.attachmentFile({ kind: 'run', id: RUN }, sha(f.bytes.run), 'image/png')
    f.target.fs.remove(file)
    f.target.fs.symlink(file, elsewhere)
    const result = f.reconcile()
    expect(result.rejected.map((item) => item.message).join('\n')).toContain('symbolic links')
    expect(stored(f.target, f.ids.ticket)).toEqual({ missing: 1, data: null })
    expect(stored(f.target, f.ids.run).missing).toBe(0)
  })

  it('refuses an attachments folder that is a link', () => {
    const f = importedFixture()
    const paths = ownedPaths(f.target.layout)
    const dir = paths.attachmentsDir({ kind: 'kanban_card', id: f.cardId })
    f.target.fs.removeTree(dir)
    f.target.fs.symlink(dir, paths.attachmentsDir({ kind: 'run', id: RUN }))
    const result = f.reconcile()
    expect(result.rejected.map((item) => item.message).join('\n')).toContain('symbolic links')
    expect(stored(f.target, f.ids.card)).toEqual({ missing: 1, data: null })
  })

  it('reads nothing from a folder with more than 2,000 entries', () => {
    const f = importedFixture()
    const dir = ownedPaths(f.target.layout).attachmentsDir({ kind: 'run', id: RUN })
    f.target.fs.setReaddir(
      dir,
      Array.from({ length: 2001 }, (_, index) => `${index.toString(16).padStart(64, '0')}.png`)
    )
    const result = f.reconcile()
    expect(result.rejected[0]?.message).toContain('more than 2000 files')
    expect(stored(f.target, f.ids.run)).toEqual({ missing: 1, data: null })
  })

  it('reads nothing from a folder over 512 MiB', () => {
    const f = importedFixture()
    const paths = ownedPaths(f.target.layout)
    const file = paths.attachmentFile({ kind: 'run', id: RUN }, sha(f.bytes.run), 'image/png')
    f.target.fs.setSize(file, 513 * 1024 * 1024)
    const result = f.reconcile()
    expect(result.rejected[0]?.message).toContain('512 MiB')
    expect(stored(f.target, f.ids.run)).toEqual({ missing: 1, data: null })
  })
})

describe('attachment export helpers', () => {
  it('reads an unowned image back with no owner, and refuses an unknown id', () => {
    const { env, ctx } = fixture()
    const id = stage(ctx, pngBytes(40, 30, 21))
    expect(loadStoredAttachment(env.db, id)).toMatchObject({ id, owner: null })
    expect(() => loadStoredAttachment(env.db, idOf('attachment', 9))).toThrow('does not exist')
  })

  it('has no folder for an image nobody owns', () => {
    const { env, ctx } = fixture()
    const stored = loadStoredAttachment(env.db, stage(ctx, pngBytes(40, 30, 22)))
    expect(() => placementOfAttachment(env.db, stored)).toThrow('has no owner')
  })

  it('refuses to write an image whose bytes are not stored, and one that does not read back as written', () => {
    const { env, ctx } = fixture()
    seedEpic(env)
    const bytes = pngBytes(40, 30, 23)
    const id = claim(ctx, bytes, { kind: 'attempt', id: ATTEMPT })
    const stored = loadStoredAttachment(env.db, id)
    const placement = placementOfAttachment(env.db, stored)
    expect(() => writeAttachmentFile(env, { ...stored, data: null }, placement)).toThrow('are not stored')
    const corrupting = Object.create(env.fs, { readFileBytes: { value: () => Buffer.from('not what was written') } }) as typeof env.fs
    expect(() => writeAttachmentFile({ layout: env.layout, fs: corrupting }, stored, placement)).toThrow('does not match what was written')
  })
})

describe('attachment import of odd folders and files', () => {
  const dirOf = (f: Imported, kind: 'run' | 'epic' | 'kanban_card', id: string): string =>
    ownedPaths(f.target.layout).attachmentsDir({ kind, id })

  it('reads nothing from a missing attachments folder and flags the image missing', () => {
    const f = importedFixture()
    f.target.fs.removeTree(dirOf(f, 'run', RUN))
    expect(f.reconcile().rejected).toEqual([])
    expect(stored(f.target, f.ids.run)).toEqual({ missing: 1, data: null })
  })

  it('refuses an attachments folder that is a regular file', () => {
    const f = importedFixture()
    f.target.fs.removeTree(dirOf(f, 'run', RUN))
    f.target.fs.putBytes(dirOf(f, 'run', RUN), Buffer.from('not a folder'))
    expect(f.reconcile().rejected[0]?.message).toContain('is not a directory')
  })

  it('ignores files whose names are not an image hash, and refuses a folder named like an image', () => {
    const f = importedFixture()
    const dir = dirOf(f, 'run', RUN)
    f.target.fs.putBytes(`${dir}/notes.txt`, Buffer.from('hello'))
    f.target.fs.remove(ownedPaths(f.target.layout).attachmentFile({ kind: 'run', id: RUN }, sha(f.bytes.run), 'image/png'))
    f.target.fs.mkdirp(`${dir}/${sha(f.bytes.run)}.png`)
    const result = f.reconcile()
    expect(result.rejected.map((item) => item.message).join(' ')).toContain('is not a regular file')
    expect(stored(f.target, f.ids.run).missing).toBe(1)
  })

  it('refuses a file over the size limit before reading it', () => {
    const f = importedFixture()
    const big = Buffer.alloc(10 * 1024 * 1024 + 1)
    f.target.fs.putBytes(`${dirOf(f, 'run', RUN)}/${sha(big)}.png`, big)
    expect(f.reconcile().rejected.map((item) => item.message).join(' ')).toContain('is larger than')
  })

  it('refuses a file whose type differs from the type in its name', () => {
    const f = importedFixture()
    const png = pngBytes(40, 30, 31)
    f.target.fs.putBytes(`${dirOf(f, 'run', RUN)}/${sha(png)}.jpg`, png)
    expect(f.reconcile().rejected.map((item) => item.message).join(' ')).toContain('named as image/jpeg')
  })

  it('flags an image whose owner this database does not hold as missing', () => {
    const f = importedFixture()
    f.target.db.run('UPDATE attachments SET owner_id = ? WHERE id = ?', tid(77), f.ids.ticket)
    expect(f.reconcile().rejected).toEqual([])
    expect(stored(f.target, f.ids.ticket)).toEqual({ missing: 1, data: null })
  })
})

describe('attachment placement of owners the database does not hold', () => {
  it('has no folder for an attempt, a card attempt or a card it does not know', () => {
    const { env } = fixture()
    expect(resolveAttachmentPlacement(env.db, { kind: 'attempt', id: idOf('attempt', 8) })).toBeNull()
    expect(resolveAttachmentPlacement(env.db, { kind: 'kanban_attempt', id: 'ka_00000000000000000000000008' })).toBeNull()
    expect(resolveAttachmentPlacement(env.db, { kind: 'kanban_card', id: 'kc_00000000000000000000000008' })).toBeNull()
  })
})
