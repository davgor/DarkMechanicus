import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AttachmentRef } from '../../shared/domain/views'
import { captureError, createSavedEpic, draftRevisionOf, saveNow } from '../../test/authoring'
import { pngBytes } from '../../test/images'
import { createMemoryFs } from '../../test/memoryFs'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { contentHash } from '../canonical'
import { flushOutbox } from '../repo/finalizer'
import { resolveLayout } from '../repo/layout'
import { parseRecord, snapshotRecord } from '../repo/portable'
import { claimAttachments, createStagedAttachment, getAttachment, pruneStagedAttachments } from './attachments'
import { claimTicket } from './attempts'
import { updatePlanDraft } from './drafts'
import { createEpic } from './epics'
import { completeSavedRevision, getPlan, requestSave } from './plans'
import { startRun } from './runs'
import { checkSavedTicketAttachments } from './ticketAttachments'

const REPO_ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')

/** Snapshots committed before the image-attachments epic: their tickets carry no `attachments` key. */
const PRE_EPIC_SNAPSHOTS = [
  '.darkmechanicus/epics/ep_01m3txy30qavmd5wewct90804g/snapshots/rv_01m3txzpv9ws6fbj6p211ghkn9.json',
  '.darkmechanicus/epics/ep_01m418epbg8qkqa2e2krvdkqk5/snapshots/rv_01m464qr300pd5y24xgjt2qy14.json'
]

function stage(ctx: TestCtx, purpose: 'reference' | 'evidence' = 'reference'): string {
  return createStagedAttachment(ctx, { bytes: pngBytes(4, 3), label: 'mockup', purpose }).id
}

function stageMany(ctx: TestCtx, count: number): string[] {
  return Array.from({ length: count }, () => stage(ctx))
}

function setImages(ctx: TestCtx, epicId: string, ticket: string, attachments: string[]): void {
  updatePlanDraft(ctx, { epicId, ops: [{ op: 'update_ticket', ticket, patch: { attachments } }] })
}

function draftImages(ctx: TestCtx, epicId: string, ticketId: string): AttachmentRef[] | undefined {
  return getPlan(ctx, { epicId, view: 'draft' }).bundle.tickets.find((ticket) => ticket.id === ticketId)?.attachments
}

function ownerOf(ctx: TestCtx, id: string): string | null {
  return getAttachment(ctx, id).owner?.id ?? null
}

function editRefusal(ctx: TestCtx, epicId: string, ticket: string, attachments: string[]): string | undefined {
  return captureError(() => setImages(ctx, epicId, ticket, attachments)).code
}

describe('saved plan hashes', () => {
  it('recomputes a pre-epic snapshot to its stored content hash', () => {
    for (const path of PRE_EPIC_SNAPSHOTS) {
      const record = parseRecord(snapshotRecord, readFileSync(resolve(REPO_ROOT, path), 'utf8'), path)
      expect(record.bundle.tickets.length).toBeGreaterThan(0)
      expect(record.bundle.tickets.some((ticket) => Object.hasOwn(ticket, 'attachments'))).toBe(false)
      expect(contentHash(record.bundle)).toBe(record.contentHash)
    }
  })
})

describe('draft ops name reference images on tickets', () => {
  it('turns staged ids into refs on the ticket and leaves the images staged', () => {
    const ctx = createTestCtx()
    const { epicId, refMap } = createSavedEpic(ctx)
    const ids = stageMany(ctx, 2)
    setImages(ctx, epicId, refMap.a, ids)
    expect(draftImages(ctx, epicId, refMap.a)?.map((ref) => ref.id)).toEqual(ids)
    expect(draftImages(ctx, epicId, refMap.a)?.[0]).toMatchObject({ mime: 'image/png', width: 4, height: 3, purpose: 'reference' })
    expect(ids.map((id) => ownerOf(ctx, id))).toEqual([null, null])
    setImages(ctx, epicId, refMap.a, [])
    expect(draftImages(ctx, epicId, refMap.a)).toBeUndefined()
  })

  it('refuses unknown, evidence, repeated and too many ids', () => {
    const ctx = createTestCtx()
    const { epicId, refMap } = createSavedEpic(ctx)
    expect(editRefusal(ctx, epicId, refMap.a, ['im_00000000000000000000000zzz'])).toBe('not_found')
    expect(editRefusal(ctx, epicId, refMap.a, [stage(ctx, 'evidence')])).toBe('invalid_input')
    const id = stage(ctx)
    expect(editRefusal(ctx, epicId, refMap.a, [id, id])).toBe('invalid_input')
    expect(editRefusal(ctx, epicId, refMap.a, stageMany(ctx, 21))).toBe('capacity_exceeded')
    expect(draftRevisionOf(ctx, epicId)).toBeNull()
  })

  it('refuses an image owned by another record, or shown on a ticket of another draft', () => {
    const ctx = createTestCtx()
    const { epicId, refMap } = createSavedEpic(ctx)
    const owned = stage(ctx)
    claimAttachments(ctx, [owned], { kind: 'ticket', id: refMap.b })
    expect(editRefusal(ctx, epicId, refMap.a, [owned])).toBe('conflict')
    setImages(ctx, epicId, refMap.b, [owned])
    expect(draftImages(ctx, epicId, refMap.b)?.map((ref) => ref.id)).toEqual([owned])
    const shared = stage(ctx)
    const other = createEpic(ctx, { title: 'Other' })
    updatePlanDraft(ctx, { epicId: other.id, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Elsewhere', attachments: [shared] } }] })
    expect(editRefusal(ctx, epicId, refMap.a, [shared])).toBe('conflict')
  })
})

describe('the prune keeps planned images', () => {
  it('keeps an old staged image a draft names and deletes an old one nobody names', () => {
    const ctx = createTestCtx()
    const { epicId, refMap } = createSavedEpic(ctx)
    ctx.clock.set('2026-03-01T00:00:00.000Z')
    const planned = stage(ctx)
    const loose = stage(ctx)
    setImages(ctx, epicId, refMap.a, [planned])
    ctx.clock.set('2026-03-20T00:00:00.000Z')
    expect(pruneStagedAttachments(ctx)).toBe(1)
    expect(getAttachment(ctx, planned).owner).toBeNull()
    expect(captureError(() => getAttachment(ctx, loose)).code).toBe('not_found')
  })
})

describe('saving a plan claims its ticket images', () => {
  it('claims the refs for their ticket when the save completes', () => {
    const ctx = createTestCtx()
    const { epicId, refMap } = createSavedEpic(ctx)
    const ids = stageMany(ctx, 2)
    setImages(ctx, epicId, refMap.a, ids)
    saveNow(ctx, epicId)
    expect(ids.map((id) => getAttachment(ctx, id).owner)).toEqual(ids.map(() => ({ kind: 'ticket', id: refMap.a })))
  })

  it('refuses a save naming an image that vanished, before any revision is pending', () => {
    const ctx = createTestCtx()
    const { epicId, refMap } = createSavedEpic(ctx)
    const id = stage(ctx)
    setImages(ctx, epicId, refMap.a, [id])
    ctx.db.run('DELETE FROM attachments WHERE id = ?', id)
    const error = captureError(() => requestSave(ctx, { epicId, expectedDraftRevision: draftRevisionOf(ctx, epicId) ?? 0 }))
    expect(error.code).toBe('not_found')
    expect(ctx.db.get("SELECT id FROM plan_revisions WHERE state = 'pending'")).toBeUndefined()
  })

  it('replaces 15 saved images with 10 new ones and saves', () => {
    const ctx = createTestCtx()
    const { epicId, refMap } = createSavedEpic(ctx)
    const first = stageMany(ctx, 15)
    setImages(ctx, epicId, refMap.a, first)
    saveNow(ctx, epicId)
    const second = stageMany(ctx, 10)
    setImages(ctx, epicId, refMap.a, second)
    saveNow(ctx, epicId)
    expect(second.map((id) => ownerOf(ctx, id))).toEqual(second.map(() => refMap.a))
    expect(getPlan(ctx, { epicId, view: 'saved' }).bundle.tickets.find((ticket) => ticket.id === refMap.a)?.attachments).toHaveLength(10)
  })
})

describe('the snapshot entry claims what it still can', () => {
  it('skips an image claimed elsewhere between the save request and the flush, and still completes', () => {
    const ctx = createTestCtx()
    const { epicId, refMap } = createSavedEpic(ctx)
    const [taken, kept] = stageMany(ctx, 2)
    setImages(ctx, epicId, refMap.a, [taken, kept])
    const save = requestSave(ctx, { epicId, expectedDraftRevision: draftRevisionOf(ctx, epicId) ?? 0 })
    claimAttachments(ctx, [taken], { kind: 'ticket', id: refMap.b })
    const root = resolve('/repo')
    const layout = resolveLayout(root)
    const fs = createMemoryFs()
    fs.mkdirp(layout.dmDir)
    const deps = { db: ctx.db, layout, fs, clock: ctx.clock }
    const outcome = flushOutbox(deps, { onSnapshotSaved: (revisionId) => completeSavedRevision(ctx, revisionId) })
    expect(outcome.failed).toBe(0)
    expect(outcome.savedRevisionIds).toContain(save.revisionId)
    expect(ownerOf(ctx, taken)).toBe(refMap.b)
    expect(ownerOf(ctx, kept)).toBe(refMap.a)
  })
})

describe('execution packets carry ticket images', () => {
  it('lists the ticket refs in the claimed packet', () => {
    const ctx = createTestCtx()
    const { epicId, refMap } = createSavedEpic(ctx)
    const ids = stageMany(ctx, 2)
    setImages(ctx, epicId, refMap.a, ids)
    saveNow(ctx, epicId)
    const run = startRun(withRole(ctx, 'orchestrator'), { epicId })
    const claimed = claimTicket(ctx, { runId: run.id, ticketId: refMap.a, worker: { label: 'worker-1' } })
    expect(claimed.packet.ticket.attachments?.map((ref) => ref.id)).toEqual(ids)
    expect(claimed.packet.ticket.attachments?.[0]).toMatchObject({ purpose: 'reference', mime: 'image/png' })
  })
})

describe('a save refuses ticket images that cannot be theirs', () => {
  function bundleWith(ctx: TestCtx, epicId: string, images: Record<string, string[]>): ReturnType<typeof getPlan>['bundle'] {
    const bundle = getPlan(ctx, { epicId, view: 'saved' }).bundle
    const tickets = bundle.tickets.map((ticket) => {
      const ids = images[ticket.id]
      return ids === undefined ? ticket : { ...ticket, attachments: ids.map((id) => getAttachment(ctx, id)) }
    })
    return { ...bundle, tickets }
  }

  it('refuses one image named on two tickets', () => {
    const ctx = createTestCtx()
    const { epicId, refMap } = createSavedEpic(ctx)
    const id = stage(ctx)
    const error = captureError(() => checkSavedTicketAttachments(ctx.db, bundleWith(ctx, epicId, { [refMap.a]: [id], [refMap.b]: [id] })))
    expect(error.message).toMatch(/is shown on both/)
    expect(error.code).toBe('conflict')
  })

  it('refuses an image another record claimed after the draft named it', () => {
    const ctx = createTestCtx()
    const { epicId, refMap } = createSavedEpic(ctx)
    const id = stage(ctx)
    setImages(ctx, epicId, refMap.a, [id])
    claimAttachments(ctx, [id], { kind: 'ticket', id: refMap.b })
    const error = captureError(() => requestSave(ctx, { epicId, expectedDraftRevision: draftRevisionOf(ctx, epicId) ?? 0 }))
    expect(error.code).toBe('conflict')
    expect(error.message).toMatch(/now belongs to a ticket/)
    expect(ctx.db.get("SELECT id FROM plan_revisions WHERE state = 'pending'")).toBeUndefined()
  })

  it('names the kind of record that holds the image', () => {
    const ctx = createTestCtx()
    const { epicId, refMap } = createSavedEpic(ctx)
    const id = stage(ctx)
    ctx.db.run("UPDATE attachments SET owner_kind = 'comment', owner_id = 'elsewhere' WHERE id = ?", id)
    const held = captureError(() => checkSavedTicketAttachments(ctx.db, bundleWith(ctx, epicId, { [refMap.a]: [id] })))
    expect(held.message).toMatch(/now belongs to a comment/)
    expect(editRefusal(ctx, epicId, refMap.a, [id])).toBe('conflict')
  })
})
