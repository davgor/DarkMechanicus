import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase } from '../db/database'
import { pngBytes, jpegBytes } from '../../test/images'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { createFileHashCache } from './fileHashes'
import { nodeFs } from './nodeFs'
import { resolveLayout } from './layout'
import { assertRecoveredArchiveBounds, exportRecoveredAttachment, importRecoveredAttachments, readRecoveredAttachmentBytes } from './recoveredAttachments'

let h: Harness
beforeEach(() => { h = createHarness() })
afterEach(() => h.cleanup())

async function fixture(bytes = pngBytes(2, 3)) {
  const source = h.open('desktop', { transport: 'desktop' })
  await source.initializeRepository({ name: 'Recovery archive' })
  const image = await source.uploadAttachment({ data: bytes.toString('base64'), label: 'Recovery evidence', purpose: 'evidence' })
  const db = source.ctx().db
  db.run("UPDATE attachments SET owner_kind = 'attempt', owner_id = ? WHERE id = ?", source.ctx().ids.next('attempt'), image.id)
  const env = { db, fs: nodeFs, layout: resolveLayout(h.root) }
  const dir = join(h.root, '.darkmechanicus/recovered-attachments')
  const path = join(dir, `${image.id}.json`)
  const binary = join(dir, `${image.sha256}.${image.mime === 'image/png' ? 'png' : 'jpg'}`)
  return { source, image, env, dir, path, binary }
}

it.each([
  ['attempt', 'attempt'], ['kanban_attempt', 'kanbanAttempt'], ['kanban_message', 'kanbanEvent'],
  ['kanban_card', 'kanbanCard'], ['comment', 'comment'], ['ticket', 'ticket']
] as const)('preserves the original %s owner and metadata through portable recovery', async (kind, idKind) => {
  const f = await fixture()
  f.env.db.run('UPDATE attachments SET owner_kind = ?, owner_id = ? WHERE id = ?', kind, f.source.ctx().ids.next(idKind), f.image.id)
  const before = f.env.db.get('SELECT * FROM attachments WHERE id = ?', f.image.id)
  exportRecoveredAttachment(f.env, f.image.id)
  f.env.db.run('DELETE FROM attachments WHERE id = ?', f.image.id)
  expect(importRecoveredAttachments(f.env)).toEqual([])
  expect(f.env.db.get('SELECT * FROM attachments WHERE id = ?', f.image.id)).toEqual(before)
})

it('preserves JPEG bytes and clears a stale missing flag without changing the original owner', async () => {
  const f = await fixture(jpegBytes(3, 4))
  exportRecoveredAttachment(f.env, f.image.id)
  f.env.db.run('UPDATE attachments SET missing = 1 WHERE id = ?', f.image.id)
  expect(importRecoveredAttachments(f.env)).toEqual([])
  expect(readRecoveredAttachmentBytes(f.env, f.image.id)).toEqual(new Uint8Array(jpegBytes(3, 4)))
  expect(f.env.db.get('SELECT missing FROM attachments WHERE id = ?', f.image.id)).toEqual({ missing: 0 })
})

it('does not reload a verified archive until its input or its stored row changes', async () => {
  const original = pngBytes(2, 3, 11)
  const f = await fixture(original)
  exportRecoveredAttachment(f.env, f.image.id)
  const reads: string[] = []
  const env = {
    ...f.env,
    fileHashes: createFileHashCache(),
    fs: { ...nodeFs, readFileBytes: (path: string) => { reads.push(path); return nodeFs.readFileBytes(path) } }
  }
  expect(importRecoveredAttachments(env)).toEqual([])
  expect(importRecoveredAttachments(env)).toEqual([])
  expect(reads).toEqual([f.binary])

  writeFileSync(f.binary, pngBytes(2, 3, 12))
  expect(importRecoveredAttachments(env)).toEqual([expect.objectContaining({ message: expect.stringContaining('sha256') })])
  writeFileSync(f.binary, original)
  expect(importRecoveredAttachments(env)).toEqual([])
  expect(importRecoveredAttachments(env)).toEqual([])
  expect(reads).toHaveLength(3)

  // Another connection's commit alone no longer invalidates the verification (DM-962): the row it is remembered
  // against does. A row emptied elsewhere is read and restored again, once.
  const external = openDatabase(f.env.db.path)
  try {
    external.run('UPDATE attachments SET data = NULL, missing = 1 WHERE id = ?', f.image.id)
    expect(importRecoveredAttachments(env)).toEqual([])
    expect(reads).toHaveLength(4)
    expect(Buffer.from(f.env.db.get<{ data: Uint8Array }>('SELECT data FROM attachments WHERE id = ?', f.image.id)!.data)).toEqual(Buffer.from(original))
    external.run("INSERT INTO meta (key, value) VALUES ('unrelated', '1')")
    expect(importRecoveredAttachments(env)).toEqual([])
    expect(reads).toHaveLength(4)
  } finally {
    external.close()
  }
})

it('refreshes retained views when a recovery archive alone repairs an image', async () => {
  const f = await fixture()
  exportRecoveredAttachment(f.env, f.image.id)
  f.env.db.run('UPDATE attachments SET data = NULL, missing = 1 WHERE id = ?', f.image.id)
  const events = () => f.env.db.all<{ payload_json: string }>("SELECT payload_json FROM events WHERE kind = 'repository.reconciled' ORDER BY seq")
  const before = events().length
  expect(await f.source.reconcileRepository()).toMatchObject({ imported: [], rejected: [] })
  expect(await f.source.reconcileRepository()).toMatchObject({ imported: [], rejected: [] })
  const published = events().slice(before).map((row) => JSON.parse(row.payload_json))
  expect(published).toEqual([expect.objectContaining({ imported: [], changedEpics: [], refreshAll: true })])
})

it('refuses exporting a recovery record with missing bytes', async () => {
  const f = await fixture()
  f.env.db.run('UPDATE attachments SET data = NULL WHERE id = ?', f.image.id)
  expect(() => exportRecoveredAttachment(f.env, f.image.id)).toThrow('bytes of recovered attachment')
})

it('does not repair a corrupt existing local blob by silently replacing it from the archive', async () => {
  const f = await fixture()
  exportRecoveredAttachment(f.env, f.image.id)
  const bad = Buffer.from('broken local data')
  f.env.db.run('UPDATE attachments SET data = ? WHERE id = ?', bad, f.image.id)
  expect(importRecoveredAttachments(f.env)).toEqual([expect.objectContaining({ message: expect.stringContaining('sha256') })])
  expect(f.env.db.get<{ data: Uint8Array }>('SELECT data FROM attachments WHERE id = ?', f.image.id)?.data).toEqual(new Uint8Array(bad))
})

it.each(['ownership', 'creator', 'time', 'label'] as const)('refuses hydration when archive %s conflicts with the authoritative local metadata', async change => {
  const f = await fixture()
  exportRecoveredAttachment(f.env, f.image.id)
  const record = JSON.parse(readFileSync(f.path, 'utf8'))
  if (change === 'ownership') record.owner.id = f.source.ctx().ids.next('attempt')
  if (change === 'creator') record.createdBy.label = 'Another worker'
  if (change === 'time') record.createdAt = '2025-01-01T00:00:00.000Z'
  if (change === 'label') record.attachment.label = 'Other evidence'
  writeFileSync(f.path, JSON.stringify(record))
  expect(() => readRecoveredAttachmentBytes(f.env, f.image.id)).toThrow('conflicts')
})

it.each(['unknown format', 'invalid json', 'missing record', 'oversized image', 'directory'] as const)('refuses %s before recovering an orphan', async problem => {
  const f = await fixture()
  exportRecoveredAttachment(f.env, f.image.id)
  if (problem === 'unknown format') writeFileSync(f.path, JSON.stringify({ ...JSON.parse(readFileSync(f.path, 'utf8')), formatVersion: 2 }))
  if (problem === 'invalid json') writeFileSync(f.path, '{broken')
  if (problem === 'missing record') rmSync(f.path)
  if (problem === 'directory') { rmSync(f.dir, { recursive: true }); writeFileSync(f.dir, 'not a directory') }
  const fs = problem === 'oversized image' ? { ...nodeFs, fileSize: (path: string) => path === f.binary ? 10 * 1024 * 1024 + 1 : nodeFs.fileSize(path) } : nodeFs
  expect(() => readRecoveredAttachmentBytes({ ...f.env, fs }, f.image.id)).toThrow()
  if (problem !== 'missing record') expect(importRecoveredAttachments({ ...f.env, fs }).length).toBeGreaterThan(0)
})

it.each(['file count', 'total bytes'] as const)('enforces the same %s bound for publication and import without allocating large payloads', async bound => {
  const f = await fixture()
  exportRecoveredAttachment(f.env, f.image.id)
  const fs = {
    ...nodeFs,
    readdir: (path: string) => path === f.dir && bound === 'file count' ? Array<string>(20_001).fill('image.png') : nodeFs.readdir(path),
    fileSize: (path: string) => path === f.binary && bound === 'total bytes' ? 512 * 1024 * 1024 + 1 : nodeFs.fileSize(path)
  }
  expect(() => assertRecoveredArchiveBounds({ ...f.env, fs })).toThrow(bound === 'file count' ? 'too many files' : '512 MiB')
  expect(importRecoveredAttachments({ ...f.env, fs })).toEqual([expect.objectContaining({ message: expect.stringContaining(bound === 'file count' ? 'too many files' : '512 MiB') })])
})

it('leaves an absent archive absent and ignores unrelated files without importing invented metadata', async () => {
  const f = await fixture()
  expect(importRecoveredAttachments(f.env)).toEqual([])
  mkdirSync(f.dir)
  writeFileSync(join(f.dir, 'README.txt'), 'An unrelated note')
  const before = f.env.db.get('SELECT total_changes() AS count')
  expect(importRecoveredAttachments(f.env)).toEqual([])
  expect(f.env.db.get('SELECT total_changes() AS count')).toEqual(before)
})
