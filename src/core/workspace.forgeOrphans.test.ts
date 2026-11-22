import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { pngBytes } from '../test/images'
import { createHarness, type Harness } from '../test/workspaceHarness'
import { withForgeTransfer } from './repo/forgeBinding'
import { dropAcceptanceNodes } from '../test/acceptanceNodes'
import { issued } from '../test/execution'
import { nodeFs } from './repo/nodeFs'
import { resolveLayout } from './repo/layout'
import { exportRecoveredAttachment, importRecoveredAttachments } from './repo/recoveredAttachments'

let h: Harness
beforeEach(() => { h = createHarness() })
afterEach(() => h.cleanup())

async function orphanProject(mode: 'repo' | 'db' = 'repo') {
  const source = h.open('desktop', { transport: 'desktop', mode })
  await source.initializeRepository({ name: 'Historical orphan attachment' })
  const image = await source.uploadAttachment({ data: pngBytes(2, 3).toString('base64'), label: 'Historical evidence', purpose: 'evidence' })
  const ownerId = source.ctx().ids.next('attempt')
  source.ctx().db.run("UPDATE attachments SET owner_kind = 'attempt', owner_id = ? WHERE id = ?", ownerId, image.id)
  const member = join(h.homeDir, 'Forge', 'Project')
  mkdirSync(member, { recursive: true })
  return { source, image, ownerId, member }
}

it.each(['repo', 'db'] as const)('force migrates %s orphan evidence without losing its original metadata or inventing an attempt', async mode => {
  const f = await orphanProject(mode)
  const before = f.source.ctx().db.get('SELECT * FROM attachments WHERE id = ?', f.image.id)
  await withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))
  expect(f.source.ctx().db.get('SELECT * FROM attachments WHERE id = ?', f.image.id)).toEqual(before)
  const destination = h.open('orchestrator', { root: f.member })
  expect(destination.ctx().db.get('SELECT * FROM attachments WHERE id = ?', f.image.id)).toEqual(before)
  const clone = h.open('orchestrator', { root: h.cloneTracked(f.member) })
  expect((await clone.reconcileRepository()).rejected).toEqual([])
  expect(clone.ctx().db.get('SELECT * FROM attachments WHERE id = ?', f.image.id)).toEqual(before)
  expect(clone.ctx().db.get('SELECT 1 FROM attempts WHERE id = ?', f.ownerId)).toBeUndefined()
  expect(await clone.getAttachment({ attachmentId: f.image.id, as: 'metadata' })).toMatchObject({
    owner: { kind: 'attempt', id: f.ownerId }, createdBy: f.image.createdBy, createdAt: f.image.createdAt, missing: false
  })
})

it('refuses corrupt orphan bytes without changing source data or publishing the destination', async () => {
  const f = await orphanProject()
  f.source.ctx().db.run('UPDATE attachments SET data = ? WHERE id = ?', Buffer.from('corrupt'), f.image.id)
  const before = f.source.ctx().db.get('SELECT * FROM attachments WHERE id = ?', f.image.id)
  await expect(withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))).rejects.toThrow('sha256')
  expect(f.source.ctx().db.get('SELECT * FROM attachments WHERE id = ?', f.image.id)).toEqual(before)
  expect(existsSync(join(f.member, '.darkmechanicus'))).toBe(false)
})

it('rejects a recovery archive that conflicts with existing ownership, preserving the existing attachment', async () => {
  const f = await orphanProject()
  await withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))
  const destination = h.open('orchestrator', { root: f.member })
  const before = destination.ctx().db.get('SELECT * FROM attachments WHERE id = ?', f.image.id)
  const archive = join(f.member, '.darkmechanicus', 'recovered-attachments', `${f.image.id}.json`)
  const record = JSON.parse(readFileSync(archive, 'utf8'))
  record.owner.id = destination.ctx().ids.next('attempt')
  writeFileSync(archive, JSON.stringify(record))
  const result = await destination.reconcileRepository()
  expect(result.rejected).toEqual([expect.objectContaining({ message: expect.stringContaining('conflict') })])
  expect(destination.ctx().db.get('SELECT * FROM attachments WHERE id = ?', f.image.id)).toEqual(before)
})

it('migrates evidence left by the real epic-deletion workflow and keeps it readable in a fresh clone', async () => {
  const source = h.open('desktop', { transport: 'desktop' })
  await source.initializeRepository({ name: 'Deleted epic evidence' })
  const epic = await source.createEpic({ title: 'Obsolete epic' })
  await dropAcceptanceNodes(source, epic.id)
  const draft = await source.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', ref: 'one', sprint: '1', ticket: { title: 'Old ticket' } }] })
  await source.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  const image = await source.uploadAttachment({ data: pngBytes(4, 5).toString('base64'), label: 'Deleted epic evidence', purpose: 'evidence' })
  const agent = h.open('orchestrator')
  const run = await agent.startRun({ epicId: epic.id })
  const claim = issued(await agent.claimTicket({ runId: run.id, ticketId: draft.refMap.one!, worker: { label: 'Old worker' } }))
  await agent.submitAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, outputs: { summary: 'Evidence survives' }, evidence: { attachments: [image.id] } })
  await source.cancelRun({ runId: run.id, reason: 'Deleting obsolete epic' })
  await source.deleteEpic({ epicId: epic.id })
  const before = source.ctx().db.get('SELECT * FROM attachments WHERE id = ?', image.id)
  expect(before).toMatchObject({ owner_kind: 'attempt', owner_id: claim.attempt.id })
  expect(source.ctx().db.get('SELECT 1 FROM attempts WHERE id = ?', claim.attempt.id)).toBeUndefined()
  const member = join(h.homeDir, 'Forge', 'DeletedEpic')
  mkdirSync(member, { recursive: true })
  await withForgeTransfer(h.homeDir, h.root, member, async () => source.exportForge!(member, 'repo', { force: true }))
  const clone = h.open('orchestrator', { root: h.cloneTracked(member) })
  expect(clone.ctx().db.get('SELECT * FROM attachments WHERE id = ?', image.id)).toEqual(before)
  expect(source.ctx().db.get('SELECT * FROM attachments WHERE id = ?', image.id)).toEqual(before)
})

it('restores the original creator and upload time when a missing comment owner is recovered from canonical records', async () => {
  const f = await orphanProject()
  const epic = await f.source.createEpic({ title: 'Recover comment owner' })
  const draft = await f.source.getPlan({ epicId: epic.id, view: 'draft' })
  await f.source.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision! })
  f.source.ctx().db.run('UPDATE attachments SET owner_kind = NULL, owner_id = NULL WHERE id = ?', f.image.id)
  h.clock.advanceSeconds(10)
  const comment = await f.source.addComment({ epicId: epic.id, body: 'Canonical owner survives', attachments: [f.image.id] })
  const before = f.source.ctx().db.get('SELECT * FROM attachments WHERE id = ?', f.image.id)
  f.source.ctx().db.run('DELETE FROM comments WHERE id = ?', comment.id)
  await withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))
  const clone = h.open('orchestrator', { root: h.cloneTracked(f.member) })
  expect((await clone.reconcileRepository()).rejected).toEqual([])
  expect((await clone.reconcileRepository()).rejected).toEqual([])
  expect(clone.ctx().db.get('SELECT * FROM attachments WHERE id = ?', f.image.id)).toEqual(before)
  expect(clone.ctx().db.get('SELECT body FROM comments WHERE id = ?', comment.id)).toEqual({ body: 'Canonical owner survives' })
})

it('does not rewrite recovered image blobs on subsequent reconciliation', async () => {
  const f = await orphanProject()
  await withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))
  const destination = h.open('orchestrator', { root: f.member })
  const db = destination.ctx().db
  const before = db.get('SELECT total_changes() AS count')
  expect(importRecoveredAttachments({ db, fs: nodeFs, layout: resolveLayout(f.member) })).toEqual([])
  expect(db.get('SELECT total_changes() AS count')).toEqual(before)
})

it('refuses an archive claiming evidence already assigned by a freshly imported canonical attempt', async () => {
  const source = h.open('desktop', { transport: 'desktop' })
  await source.initializeRepository({ name: 'Canonical evidence wins' })
  const epic = await source.createEpic({ title: 'Original evidence owner' })
  await dropAcceptanceNodes(source, epic.id)
  const draft = await source.updatePlanDraft({ epicId: epic.id, ops: [{ op: 'add_ticket', ref: 'one', sprint: '1', ticket: { title: 'Original ticket' } }] })
  await source.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
  const image = await source.uploadAttachment({ data: pngBytes(4, 5).toString('base64'), label: 'Canonical evidence', purpose: 'evidence' })
  const agent = h.open('orchestrator')
  const run = await agent.startRun({ epicId: epic.id })
  const claim = issued(await agent.claimTicket({ runId: run.id, ticketId: draft.refMap.one!, worker: { label: 'Actual worker' } }))
  await agent.submitAttempt({ attemptId: claim.attempt.id, claimToken: claim.packet.claimToken, outputs: { summary: 'Actual evidence' }, evidence: { attachments: [image.id] } })
  source.ctx().db.run('UPDATE attachments SET owner_id = ? WHERE id = ?', source.ctx().ids.next('attempt'), image.id)
  exportRecoveredAttachment({ db: source.ctx().db, fs: nodeFs, layout: resolveLayout(h.root) }, image.id)
  const clone = h.open('orchestrator', { root: h.cloneTracked(), autoReconcile: false })
  expect((await clone.reconcileRepository()).rejected).toEqual([expect.objectContaining({ message: expect.stringContaining('conflicts') })])
  expect(clone.ctx().db.get('SELECT owner_kind, owner_id FROM attachments WHERE id = ?', image.id)).toEqual({ owner_kind: 'attempt', owner_id: claim.attempt.id })
})

it('rehydrates a missing local blob from a verified recovery archive when migrating again', async () => {
  const f = await orphanProject()
  await withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))
  const source = h.open('desktop', { root: f.member, transport: 'desktop', autoReconcile: false })
  source.ctx().db.run('UPDATE attachments SET data = NULL WHERE id = ?', f.image.id)
  const member = join(h.homeDir, 'Forge', 'Again')
  mkdirSync(member)
  await withForgeTransfer(h.homeDir, f.member, member, async () => source.exportForge!(member, 'repo', { force: true }))
  const clone = h.open('orchestrator', { root: h.cloneTracked(member) })
  expect(clone.ctx().db.get<{ data: Uint8Array }>('SELECT data FROM attachments WHERE id = ?', f.image.id)?.data).toEqual(new Uint8Array(pngBytes(2, 3)))
})

it.each(['missing', 'corrupt', 'metadata', 'filename', 'owner', 'oversize', 'linked'] as const)('rejects %s recovery archive data without importing the attachment', async problem => {
  const f = await orphanProject()
  await withForgeTransfer(h.homeDir, h.root, f.member, async () => f.source.exportForge!(f.member, 'repo', { force: true }))
  const root = h.cloneTracked(f.member)
  const dir = join(root, '.darkmechanicus', 'recovered-attachments')
  const metadata = join(dir, `${f.image.id}.json`)
  const image = join(dir, `${f.image.sha256}.png`)
  if (problem === 'missing') rmSync(image)
  if (problem === 'corrupt') writeFileSync(image, Buffer.alloc(f.image.bytes))
  if (problem === 'oversize') writeFileSync(metadata, ' '.repeat(16 * 1024 + 1))
  if (problem === 'linked') {
    const external = join(h.homeDir, 'archive')
    mkdirSync(external)
    rmSync(dir, { recursive: true })
    symlinkSync(external, dir, 'junction')
  }
  if (['metadata', 'filename', 'owner'].includes(problem)) {
    const record = JSON.parse(readFileSync(metadata, 'utf8'))
    if (problem === 'metadata') record.attachment.width += 1
    if (problem === 'filename') record.attachment.id = f.source.ctx().ids.next('attachment')
    if (problem === 'owner') record.owner.id = '../../outside'
    writeFileSync(metadata, JSON.stringify(record))
  }
  const clone = h.open('orchestrator', { root, autoReconcile: false })
  expect((await clone.reconcileRepository()).rejected.length).toBeGreaterThan(0)
  expect(clone.ctx().db.get('SELECT 1 FROM attachments WHERE id = ?', f.image.id)).toBeUndefined()
})
