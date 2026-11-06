import { describe, expect, it } from 'vitest'
import type { AttachmentRef } from '../../shared/domain/views'
import { createSavedEpic } from '../../test/authoring'
import { pngBytes } from '../../test/images'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { createStagedAttachment, getAttachment } from '../services/attachments'
import { claimTicket } from '../services/attempts'
import { startRun } from '../services/runs'
import { registerEvidenceAttachments, registerTicketAttachments } from './attachmentImport'

const NOW = '2026-11-06T00:00:00.000Z'

/** A valid ref whose row is gone, so registering it would insert a row. */
function unregisteredRef(ctx: TestCtx): AttachmentRef {
  const view = getAttachment(ctx, createStagedAttachment(ctx, { bytes: pngBytes(5, 4), label: 'mockup', purpose: 'reference' }).id)
  ctx.db.run('DELETE FROM attachments WHERE id = ?', view.id)
  const { id, sha256, mime, bytes, width, height, label, purpose } = view
  return { id, sha256, mime, bytes, width, height, label, purpose }
}

function setSavedBundle(ctx: TestCtx, revisionId: string, bundle: unknown, savedAt: string | null = NOW): void {
  ctx.db.run('UPDATE plan_revisions SET bundle_json = ?, saved_at = ? WHERE id = ?', JSON.stringify(bundle), savedAt, revisionId)
}

function rows(ctx: TestCtx): { id: string; owner_id: string; created_at: string }[] {
  return ctx.db.all('SELECT id, owner_id, created_at FROM attachments ORDER BY id')
}

describe('registering ticket images from saved revisions', () => {
  it('skips a bundle without a ticket list and tickets that are malformed or name no valid image', () => {
    const ctx = createTestCtx()
    const { revisionId, refMap } = createSavedEpic(ctx)
    const ref = unregisteredRef(ctx)
    setSavedBundle(ctx, revisionId, { tickets: 'none', attachments: [ref] })
    registerTicketAttachments(ctx.db, NOW)
    expect(rows(ctx)).toEqual([])
    setSavedBundle(ctx, revisionId, {
      tickets: [null, { id: 7, attachments: [ref] }, { id: refMap.a, attachments: 'none' }, { id: refMap.b, attachments: [{ id: 'bad' }] }]
    })
    registerTicketAttachments(ctx.db, NOW)
    expect(rows(ctx)).toEqual([])
  })

  it('skips a ticket the database does not track', () => {
    const ctx = createTestCtx()
    const { revisionId } = createSavedEpic(ctx)
    setSavedBundle(ctx, revisionId, { tickets: [{ id: 'tk_untracked', attachments: [unregisteredRef(ctx)] }] })
    registerTicketAttachments(ctx.db, NOW)
    expect(rows(ctx)).toEqual([])
  })

  it('registers a valid image once, dated by the import when the revision has no save time', () => {
    const ctx = createTestCtx()
    const { revisionId, refMap } = createSavedEpic(ctx)
    const ref = unregisteredRef(ctx)
    setSavedBundle(ctx, revisionId, { tickets: [{ id: refMap.a, attachments: [{ id: 'bad' }, ref] }] }, null)
    registerTicketAttachments(ctx.db, NOW)
    registerTicketAttachments(ctx.db, '2027-01-01T00:00:00.000Z')
    expect(rows(ctx)).toEqual([{ id: ref.id, owner_id: refMap.a, created_at: NOW }])
  })
})

describe('registering evidence images from submissions', () => {
  function attemptWithEvidence(ctx: TestCtx, evidence: unknown): string {
    const { epicId, refMap } = createSavedEpic(ctx)
    const run = startRun(withRole(ctx, 'orchestrator'), { epicId })
    const attemptId = claimTicket(ctx, { runId: run.id, ticketId: refMap.a, worker: { label: 'worker-1' } }).attempt.id
    ctx.db.run('UPDATE attempts SET evidence_json = ?, submitted_at = NULL WHERE id = ?', JSON.stringify(evidence), attemptId)
    return attemptId
  }

  it('skips an evidence record whose attachments are not a list', () => {
    const ctx = createTestCtx()
    attemptWithEvidence(ctx, { attachments: 'none' })
    registerEvidenceAttachments(ctx.db, NOW)
    expect(rows(ctx)).toEqual([])
  })

  it('registers the valid images only, dated by the import when the attempt has no submit time', () => {
    const ctx = createTestCtx()
    const ref = unregisteredRef(ctx)
    const attemptId = attemptWithEvidence(ctx, { attachments: [{ id: 'bad' }, ref] })
    registerEvidenceAttachments(ctx.db, NOW)
    expect(rows(ctx)).toEqual([{ id: ref.id, owner_id: attemptId, created_at: NOW }])
  })
})
