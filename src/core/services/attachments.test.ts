import { createHash, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { captureError } from '../../test/authoring'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { LIMITS } from '../schemas'
import {
  claimAttachments,
  createStagedAttachment,
  getAttachment,
  pruneStagedAttachments,
  readAttachmentBytes,
  type StagedAttachmentInput,
  stagedAttachmentCutoff
} from './attachments'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
const TICKET = 'tk_00000000000000000000000001'
const OTHER_TICKET = 'tk_00000000000000000000000002'

function pngBytes(size = 512): Buffer {
  return Buffer.concat([PNG_SIGNATURE, randomBytes(size - PNG_SIGNATURE.length)])
}

function input(overrides: Partial<StagedAttachmentInput> = {}): StagedAttachmentInput {
  const bytes = overrides.bytes ?? pngBytes()
  return {
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    mime: 'image/png',
    width: 800,
    height: 600,
    label: 'terminal screenshot',
    purpose: 'evidence',
    ...overrides
  }
}

/** Stages one image at `iso` and returns its id. */
function stageAt(ctx: TestCtx, iso: string, overrides: Partial<StagedAttachmentInput> = {}): string {
  ctx.clock.set(iso)
  return createStagedAttachment(ctx, input(overrides)).id
}

function codeOf(action: () => unknown): string | undefined {
  return captureError(action).code
}

describe('createStagedAttachment', () => {
  it('stores a PNG with no owner and returns its metadata', () => {
    const ctx = createTestCtx()
    ctx.clock.set('2026-06-01T10:00:00.000Z')
    const bytes = pngBytes()
    const view = createStagedAttachment(ctx, input({ bytes }))
    expect(view).toEqual({
      id: view.id,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mime: 'image/png',
      bytes: bytes.length,
      width: 800,
      height: 600,
      label: 'terminal screenshot',
      purpose: 'evidence',
      owner: null,
      missing: false,
      createdBy: { role: 'orchestrator', label: 'test orchestrator' },
      createdAt: '2026-06-01T10:00:00.000Z'
    })
    expect(view.id).toMatch(/^im_[0-9a-hjkmnp-tv-z]{26}$/)
  })

})

describe('createStagedAttachment bytes and refusals', () => {
  it('reads the bytes back byte-identical, for PNG and JPEG alike', () => {
    const ctx = createTestCtx()
    const png = pngBytes(4096)
    const jpeg = Buffer.concat([JPEG_SIGNATURE, randomBytes(4096)])
    const pngId = createStagedAttachment(ctx, input({ bytes: png })).id
    const jpegId = createStagedAttachment(ctx, input({ bytes: jpeg, mime: 'image/jpeg' })).id
    expect(readAttachmentBytes(ctx, pngId).equals(png)).toBe(true)
    expect(readAttachmentBytes(ctx, jpegId).equals(jpeg)).toBe(true)
    expect(getAttachment(ctx, jpegId).mime).toBe('image/jpeg')
  })

  it('refuses SVG and anything else whose first bytes are not PNG or JPEG', () => {
    const ctx = createTestCtx()
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(codeOf(() => createStagedAttachment(ctx, input({ bytes: svg, mime: 'image/png' })))).toBe('invalid_input')
    expect(codeOf(() => createStagedAttachment(ctx, input({ bytes: pngBytes(), mime: 'image/jpeg' })))).toBe('invalid_input')
    expect(codeOf(() => createStagedAttachment(ctx, input({ bytes: pngBytes(), mime: 'image/svg+xml' as 'image/png' })))).toBe(
      'invalid_input'
    )
    expect(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM attachments')?.n).toBe(0)
  })

  it('refuses a sha256 that does not match the bytes, and malformed dimensions, purpose, or size', () => {
    const ctx = createTestCtx()
    expect(codeOf(() => createStagedAttachment(ctx, input({ sha256: 'f'.repeat(64) })))).toBe('invalid_input')
    expect(codeOf(() => createStagedAttachment(ctx, input({ sha256: 'ABC' })))).toBe('invalid_input')
    expect(codeOf(() => createStagedAttachment(ctx, input({ width: LIMITS.attachmentSide + 1 })))).toBe('invalid_input')
    expect(codeOf(() => createStagedAttachment(ctx, input({ height: 0 })))).toBe('invalid_input')
    expect(codeOf(() => createStagedAttachment(ctx, input({ purpose: 'mockup' as 'reference' })))).toBe('invalid_input')
    const tooBig = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(LIMITS.attachmentBytes)])
    expect(codeOf(() => createStagedAttachment(ctx, input({ bytes: tooBig })))).toBe('invalid_input')
  })
})

describe('claimAttachments', () => {
  it('gives staged images to an owner and reports them as owned', () => {
    const ctx = createTestCtx()
    const first = stageAt(ctx, '2026-06-01T10:00:00.000Z')
    const second = stageAt(ctx, '2026-06-01T10:00:01.000Z')
    const claimed = claimAttachments(ctx, [first, second], { kind: 'ticket', id: TICKET })
    expect(claimed.map((view) => view.owner)).toEqual([
      { kind: 'ticket', id: TICKET },
      { kind: 'ticket', id: TICKET }
    ])
    expect(getAttachment(ctx, first).owner).toEqual({ kind: 'ticket', id: TICKET })
  })

  it('refuses a second claim of the same image, by the same owner or another', () => {
    const ctx = createTestCtx()
    const id = stageAt(ctx, '2026-06-01T10:00:00.000Z')
    claimAttachments(ctx, [id], { kind: 'ticket', id: TICKET })
    expect(codeOf(() => claimAttachments(ctx, [id], { kind: 'ticket', id: TICKET }))).toBe('conflict')
    expect(codeOf(() => claimAttachments(ctx, [id], { kind: 'ticket', id: OTHER_TICKET }))).toBe('conflict')
    expect(getAttachment(ctx, id).owner).toEqual({ kind: 'ticket', id: TICKET })
  })

  it('refuses an unknown id, a repeated id, and a malformed owner, and claims nothing when it refuses', () => {
    const ctx = createTestCtx()
    const id = stageAt(ctx, '2026-06-01T10:00:00.000Z')
    expect(codeOf(() => claimAttachments(ctx, [id, 'im_00000000000000000000000099'], { kind: 'ticket', id: TICKET }))).toBe(
      'not_found'
    )
    expect(getAttachment(ctx, id).owner).toBeNull()
    expect(codeOf(() => claimAttachments(ctx, [id, id], { kind: 'ticket', id: TICKET }))).toBe('invalid_input')
    expect(codeOf(() => claimAttachments(ctx, [id], { kind: 'epic' as 'ticket', id: TICKET }))).toBe('invalid_input')
    expect(codeOf(() => claimAttachments(ctx, [id], { kind: 'ticket', id: 'not-an-id' }))).toBe('invalid_input')
    expect(codeOf(() => claimAttachments(ctx, ['tk_00000000000000000000000003'], { kind: 'ticket', id: TICKET }))).toBe(
      'invalid_input'
    )
    expect(getAttachment(ctx, id).owner).toBeNull()
  })

  it('holds at most 20 attachments per record: 21 at once is refused, and so is one more after 20', () => {
    const ctx = createTestCtx()
    const ids = Array.from({ length: LIMITS.attachmentsPerRecord + 1 }, (_, index) =>
      stageAt(ctx, `2026-06-01T10:00:${String(index % 60).padStart(2, '0')}.000Z`)
    )
    expect(codeOf(() => claimAttachments(ctx, ids, { kind: 'ticket', id: TICKET }))).toBe('capacity_exceeded')
    expect(getAttachment(ctx, ids[0] ?? '').owner).toBeNull()

    claimAttachments(ctx, ids.slice(0, LIMITS.attachmentsPerRecord), { kind: 'ticket', id: TICKET })
    expect(codeOf(() => claimAttachments(ctx, ids.slice(LIMITS.attachmentsPerRecord), { kind: 'ticket', id: TICKET }))).toBe(
      'capacity_exceeded'
    )
    // Another record has its own allowance.
    expect(claimAttachments(ctx, [ids[LIMITS.attachmentsPerRecord] ?? ''], { kind: 'ticket', id: OTHER_TICKET })).toHaveLength(1)
  })
})

describe('pruneStagedAttachments', () => {
  it('removes staged images older than seven days and leaves owned and recent ones', () => {
    const ctx = createTestCtx()
    const oldStaged = stageAt(ctx, '2026-06-01T00:00:00.000Z')
    const oldOwned = stageAt(ctx, '2026-06-01T00:00:01.000Z')
    claimAttachments(ctx, [oldOwned], { kind: 'ticket', id: TICKET })
    const recent = stageAt(ctx, '2026-06-07T12:00:00.000Z')

    ctx.clock.set('2026-06-09T00:00:00.000Z')
    expect(pruneStagedAttachments(ctx)).toBe(1)
    expect(codeOf(() => getAttachment(ctx, oldStaged))).toBe('not_found')
    expect(getAttachment(ctx, oldOwned).owner).toEqual({ kind: 'ticket', id: TICKET })
    expect(getAttachment(ctx, recent).owner).toBeNull()
  })

  it('uses the cutoff it is given, and keeps an image exactly seven days old', () => {
    const ctx = createTestCtx()
    const id = stageAt(ctx, '2026-06-01T00:00:00.000Z')
    expect(stagedAttachmentCutoff('2026-06-08T00:00:00.000Z')).toBe('2026-06-01T00:00:00.000Z')
    expect(pruneStagedAttachments(ctx, '2026-06-01T00:00:00.000Z')).toBe(0)
    expect(pruneStagedAttachments(ctx, '2026-06-01T00:00:00.001Z')).toBe(1)
    expect(codeOf(() => getAttachment(ctx, id))).toBe('not_found')
  })
})

describe('attachment reads and claims at their edges', () => {
  it('refuses the bytes of an unknown id and of an image whose bytes are not stored', () => {
    const ctx = createTestCtx()
    expect(codeOf(() => readAttachmentBytes(ctx, 'im_00000000000000000000000099'))).toBe('not_found')
    const id = stageAt(ctx, '2026-01-01T00:00:00.000Z')
    ctx.db.run('UPDATE attachments SET data = NULL WHERE id = ?', id)
    expect(codeOf(() => readAttachmentBytes(ctx, id))).toBe('not_found')
  })

  it('claims nothing for no ids, and refuses a label that is too long', () => {
    const ctx = createTestCtx()
    expect(claimAttachments(ctx, [], { kind: 'ticket', id: TICKET })).toEqual([])
    expect(codeOf(() => createStagedAttachment(ctx, input({ label: 'x'.repeat(LIMITS.label + 1) })))).toBe('invalid_input')
  })
})
