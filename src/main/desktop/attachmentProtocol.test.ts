import { describe, expect, it, vi } from 'vitest'
import { pngBytes } from '../../test/images'
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
    const response = await handleAttachmentRequest(request(attachmentUrl(FOLDER_KEY, ATTACHMENT_ID)), knownLookup())
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable')
    expect(response.headers.get('Content-Length')).toBe(String(PNG.length))
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG)
  })

  it('answers 404 for an unknown attachment id, with nosniff', async () => {
    const response = await handleAttachmentRequest(
      request(attachmentUrl(FOLDER_KEY, 'im_00000000000000000000000009')),
      knownLookup()
    )
    expect(response.status).toBe(404)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('answers 404 for an unknown folder key', async () => {
    const response = await handleAttachmentRequest(
      request(attachmentUrl('ffffffffffffffffffffffffffffffff', ATTACHMENT_ID)),
      knownLookup()
    )
    expect(response.status).toBe(404)
  })

  it('answers 404 when the lookup finds nothing to serve (a missing image)', async () => {
    const lookup = vi.fn<AttachmentLookup>(() => null)
    expect((await handleAttachmentRequest(request(attachmentUrl(FOLDER_KEY, ATTACHMENT_ID)), lookup)).status).toBe(404)
    expect(lookup).toHaveBeenCalledWith(FOLDER_KEY, ATTACHMENT_ID)
  })

  it('answers 404 when the lookup throws, and never a 500 with the error', async () => {
    const response = await handleAttachmentRequest(
      request(attachmentUrl(FOLDER_KEY, ATTACHMENT_ID)),
      () => {
        throw new Error('database is closed')
      }
    )
    expect(response.status).toBe(404)
  })

})

describe('handleAttachmentRequest refusals', () => {
  it.each(['POST', 'PUT', 'DELETE', 'HEAD'])('answers 405 for %s and never looks anything up', async (method) => {
    const lookup = vi.fn<AttachmentLookup>(knownLookup())
    const response = await handleAttachmentRequest(request(attachmentUrl(FOLDER_KEY, ATTACHMENT_ID), method), lookup)
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
  ])('answers 404 without a lookup for %s', async (_label, url) => {
    const lookup = vi.fn<AttachmentLookup>(knownLookup())
    expect((await handleAttachmentRequest(request(url), lookup)).status).toBe(404)
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
    const [, handler] = handle.mock.calls[0] as [string, (request: Request) => Promise<Response>]
    const response = await handler(request(attachmentUrl(FOLDER_KEY, ATTACHMENT_ID)))
    expect(response.status).toBe(200)
  })
})

describe('createAttachmentLookup', () => {
  it('reads the stored bytes and mime through the tracked folder key', async () => {
    const read = vi.fn(async () => ({ bytes: PNG, mime: 'image/png' as const }))
    const lookup = createAttachmentLookup({ pathForKey: () => '/repo', read })
    await expect(lookup(FOLDER_KEY, ATTACHMENT_ID)).resolves.toEqual({ bytes: PNG, mime: 'image/png' })
    expect(read).toHaveBeenCalledWith('/repo', ATTACHMENT_ID)
  })

  it('finds nothing for an untracked key without opening a worker', async () => {
    const read = vi.fn()
    const lookup = createAttachmentLookup({ pathForKey: () => null, read })
    await expect(lookup(FOLDER_KEY, ATTACHMENT_ID)).resolves.toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('discards bytes when the folder was untracked during the worker read', async () => {
    let path: string | null = '/repo'
    const lookup = createAttachmentLookup({ pathForKey: () => path, read: async () => {
      path = null
      return { bytes: PNG, mime: 'image/png' }
    } })
    await expect(lookup(FOLDER_KEY, ATTACHMENT_ID)).resolves.toBeNull()
  })

  it('lets an unexpected failure through to the handler', async () => {
    const lookup = createAttachmentLookup({ pathForKey: () => '/repo', read: async () => { throw new Error('database is gone') } })
    await expect(lookup(FOLDER_KEY, ATTACHMENT_ID)).rejects.toThrow('database is gone')
  })
})
