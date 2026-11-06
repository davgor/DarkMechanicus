import { describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../../core/context'
import { createStagedAttachment, type StagedAttachmentInput } from '../../core/services/attachments'
import { pngBytes } from '../../test/images'
import { createTestCtx } from '../../test/testContext'
import { attachmentUrl } from '../../shared/desktop/attachmentUrl'
import {
  createAttachmentLookup,
  handleAttachmentRequest,
  parseAttachmentUrl,
  registerAttachmentProtocol,
  registerAttachmentScheme,
  type AttachmentLookup
} from './attachmentProtocol'

const FOLDER_KEY = '0123456789abcdef0123456789abcdef'
const ATTACHMENT_ID = 'im_00000000000000000000000001'

function request(url: string, method = 'GET'): Request {
  return new Request(url, { method })
}

const PNG = pngBytes(10, 10, 1)

/** A lookup that knows one folder key and one attachment id. */
function knownLookup(): AttachmentLookup {
  return (folderKey, attachmentId) =>
    folderKey === FOLDER_KEY && attachmentId === ATTACHMENT_ID ? { bytes: PNG, mime: 'image/png' } : null
}

describe('handleAttachmentRequest', () => {
  it('returns the stored bytes with the stored type, nosniff and an immutable cache for a known id', async () => {
    const response = handleAttachmentRequest(request(attachmentUrl(FOLDER_KEY, ATTACHMENT_ID)), knownLookup())
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable')
    expect(response.headers.get('Content-Length')).toBe(String(PNG.length))
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
  })

  it('answers 404 for an unknown attachment id, with nosniff', () => {
    const response = handleAttachmentRequest(
      request(attachmentUrl(FOLDER_KEY, 'im_00000000000000000000000009')),
      knownLookup()
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('answers 404 for an unknown folder key', () => {
    const response = handleAttachmentRequest(
      request(attachmentUrl('ffffffffffffffffffffffffffffffff', ATTACHMENT_ID)),
      knownLookup()
    )
    expect(response.status).toBe(404)
  })

  it('answers 404 when the lookup finds nothing to serve (a missing image)', () => {
    const lookup = vi.fn<AttachmentLookup>(() => null)
    expect(handleAttachmentRequest(request(attachmentUrl(FOLDER_KEY, ATTACHMENT_ID)), lookup).status).toBe(404)
    expect(lookup).toHaveBeenCalledWith(FOLDER_KEY, ATTACHMENT_ID)
  })

  it('answers 404 when the lookup throws, and never a 500 with the error', () => {
    const response = handleAttachmentRequest(
      request(attachmentUrl(FOLDER_KEY, ATTACHMENT_ID)),
      () => {
        throw new Error('database is closed')
      }
    )
    expect(response.status).toBe(404)
  })

})

describe('handleAttachmentRequest refusals', () => {
  it.each(['POST', 'PUT', 'DELETE', 'HEAD'])('answers 405 for %s and never looks anything up', (method) => {
    const lookup = vi.fn<AttachmentLookup>(knownLookup())
    const response = handleAttachmentRequest(request(attachmentUrl(FOLDER_KEY, ATTACHMENT_ID), method), lookup)
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('GET')
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each([
    ['another scheme', `https://${FOLDER_KEY}/${ATTACHMENT_ID}`],
    ['a path as the folder', `dm-attachment://C%3A%5Cprojects%5Cdm/${ATTACHMENT_ID}`],
    ['a non-attachment id', `dm-attachment://${FOLDER_KEY}/at_00000000000000000000000001`],
    ['an extra path segment', `dm-attachment://${FOLDER_KEY}/${ATTACHMENT_ID}/more`],
    ['no id', `dm-attachment://${FOLDER_KEY}/`]
  ])('answers 404 without a lookup for %s', (_label, url) => {
    const lookup = vi.fn<AttachmentLookup>(knownLookup())
    expect(handleAttachmentRequest(request(url), lookup).status).toBe(404)
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('parseAttachmentUrl', () => {
  it('reads the folder key and the attachment id from the address', () => {
    expect(parseAttachmentUrl(attachmentUrl(FOLDER_KEY, ATTACHMENT_ID))).toEqual({
      folderKey: FOLDER_KEY,
      attachmentId: ATTACHMENT_ID
    })
  })

  it('refuses an address that is not a URL', () => {
    expect(parseAttachmentUrl('not a url')).toBeNull()
  })
})

describe('registerAttachmentScheme and registerAttachmentProtocol', () => {
  it('registers dm-attachment as a standard, secure scheme', () => {
    const registerSchemesAsPrivileged = vi.fn()
    registerAttachmentScheme({ registerSchemesAsPrivileged } as never)
    expect(registerSchemesAsPrivileged).toHaveBeenCalledWith([
      { scheme: 'dm-attachment', privileges: { standard: true, secure: true } }
    ])
  })

  it('answers the scheme with the lookup-backed handler', async () => {
    const handle = vi.fn()
    registerAttachmentProtocol({ handle } as never, knownLookup())
    expect(handle).toHaveBeenCalledWith('dm-attachment', expect.any(Function))
    const [, handler] = handle.mock.calls[0] as [string, (request: Request) => Response]
    const response = handler(request(attachmentUrl(FOLDER_KEY, ATTACHMENT_ID)))
    expect(response.status).toBe(200)
  })
})

describe('createAttachmentLookup', () => {
  const INPUT: StagedAttachmentInput = { bytes: PNG, label: 'shot', purpose: 'evidence' }

  function stored(): { ctx: ReturnType<typeof createTestCtx>; id: string } {
    const ctx = createTestCtx()
    return { ctx, id: createStagedAttachment(ctx, INPUT).id }
  }

  it('reads the stored bytes and mime through the folder that the key names', () => {
    const { ctx, id } = stored()
    const contextFor = vi.fn(() => ctx)
    const lookup = createAttachmentLookup({ pathForKey: (key) => (key === FOLDER_KEY ? '/repo' : null), contextFor })
    expect(lookup(FOLDER_KEY, id)).toEqual({ bytes: PNG, mime: 'image/png' })
    expect(contextFor).toHaveBeenCalledWith('/repo')
  })

  it('finds nothing for an untracked key without opening any workspace', () => {
    const contextFor = vi.fn()
    const lookup = createAttachmentLookup({ pathForKey: () => null, contextFor })
    expect(lookup(FOLDER_KEY, ATTACHMENT_ID)).toBeNull()
    expect(contextFor).not.toHaveBeenCalled()
  })

  it('finds nothing for an unknown id, and for an image flagged missing', () => {
    const { ctx, id } = stored()
    const lookup = createAttachmentLookup({ pathForKey: () => '/repo', contextFor: () => ctx })
    expect(lookup(FOLDER_KEY, 'im_00000000000000000000000009')).toBeNull()
    ctx.db.run('UPDATE attachments SET missing = 1 WHERE id = ?', id)
    expect(lookup(FOLDER_KEY, id)).toBeNull()
  })

  it('lets an unexpected failure through to the handler', () => {
    const lookup = createAttachmentLookup({
      pathForKey: () => '/repo',
      contextFor: () => {
        throw new Error('cannot open workspace')
      }
    })
    expect(() => lookup(FOLDER_KEY, ATTACHMENT_ID)).toThrow('cannot open workspace')
  })
})

describe('createAttachmentLookup failures that are not refusals', () => {
  it('lets an unexpected error through to the handler', () => {
    const broken = { db: { get: () => { throw new TypeError('database is gone') } } } as unknown as Ctx
    const lookup = createAttachmentLookup({ pathForKey: () => '/folder', contextFor: () => broken })
    expect(() => lookup(FOLDER_KEY, ATTACHMENT_ID)).toThrow('database is gone')
  })
})
