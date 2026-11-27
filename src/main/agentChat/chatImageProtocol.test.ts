import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { jpegBytes } from '../../test/images'
import { chatImageUrl } from '../../shared/agents/chatImageUrl'
import { createFolderRegistry } from '../desktop/folderRegistry'
import { createChatImages } from './chatImages'
import {
  createChatImageLookup,
  handleChatImageRequest,
  parseChatImageUrl,
  registerChatImageProtocol,
  type ChatImageLookup
} from './chatImageProtocol'

const SWATCH = readFileSync(join(__dirname, '__fixtures__', 'images', 'swatch.png'))
const FOLDER_KEY = '0123456789abcdef0123456789abcdef'
const CHAT_ID = 'chat_one'
const IMAGE_ID = 'ci_0123456789abcdefghjkmnpqrs'
const JPEG_ID = 'ci_zzzzzzzzzzzzzzzzzzzzzzzzzz'
const JPEG = jpegBytes(8, 8)

function request(url: string, method = 'GET'): Request {
  return new Request(url, { method })
}

/** A lookup that knows a PNG and a JPEG of one chat in one folder. */
function knownLookup(): ChatImageLookup {
  return ({ folderKey, chatId, imageId }) => {
    if (folderKey !== FOLDER_KEY || chatId !== CHAT_ID) return null
    if (imageId === IMAGE_ID) return { bytes: SWATCH, mime: 'image/png' }
    return imageId === JPEG_ID ? { bytes: JPEG, mime: 'image/jpeg' } : null
  }
}

describe('handleChatImageRequest', () => {
  it('answers 200 with the stored bytes and type, nosniff and an immutable cache', async () => {
    const response = await handleChatImageRequest(request(chatImageUrl(FOLDER_KEY, CHAT_ID, IMAGE_ID)), knownLookup())
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/png')
    expect(response.headers.get('Content-Length')).toBe(String(SWATCH.length))
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(response.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(SWATCH)

    const jpeg = await handleChatImageRequest(request(chatImageUrl(FOLDER_KEY, CHAT_ID, JPEG_ID)), knownLookup())
    expect(jpeg.status).toBe(200)
    expect(jpeg.headers.get('Content-Type')).toBe('image/jpeg')
  })

  it.each([
    ['an unknown image id', chatImageUrl(FOLDER_KEY, CHAT_ID, 'ci_00000000000000000000000000')],
    ['another chat', chatImageUrl(FOLDER_KEY, 'chat_two', IMAGE_ID)],
    ['an unknown folder key', chatImageUrl('ffffffffffffffffffffffffffffffff', CHAT_ID, IMAGE_ID)]
  ])('answers 404 with nosniff for %s', async (_name, url) => {
    const response = await handleChatImageRequest(request(url), knownLookup())
    expect(response.status).toBe(404)
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
  })
})

describe('handleChatImageRequest refusals', () => {
  it.each([
    `dm-chat-image://${FOLDER_KEY}/${CHAT_ID}/not-an-id`,
    `dm-chat-image://${FOLDER_KEY}/${IMAGE_ID}`,
    `dm-chat-image://${FOLDER_KEY}/${CHAT_ID}/${IMAGE_ID}/extra`,
    `dm-chat-image://not-a-key/${CHAT_ID}/${IMAGE_ID}`,
    `dm-chat-image://${FOLDER_KEY}/${CHAT_ID}/../${IMAGE_ID}`,
    `dm-chat-image://${FOLDER_KEY}/other/../${CHAT_ID}/../${IMAGE_ID}`,
    `dm-chat-image://${FOLDER_KEY}/${CHAT_ID}/%2e%2e/${IMAGE_ID}`,
    `dm-chat-image://${FOLDER_KEY}/%2e%2e/%2E%2e/${IMAGE_ID}`,
    `dm-chat-image://${FOLDER_KEY}/${CHAT_ID}%2f..%2f${CHAT_ID}/${IMAGE_ID}`,
    `dm-chat-image://${FOLDER_KEY}/..%5c${CHAT_ID}/${IMAGE_ID}`,
    `dm-attachment://${FOLDER_KEY}/${CHAT_ID}/${IMAGE_ID}`
  ])('answers 404 for the malformed or traversing address %s, without a lookup', async (url) => {
    const lookup = vi.fn<ChatImageLookup>(knownLookup())
    const response = await handleChatImageRequest(request(url), lookup)
    expect(response.status).toBe(404)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('answers 404 when the lookup throws, never a 500', async () => {
    const response = await handleChatImageRequest(request(chatImageUrl(FOLDER_KEY, CHAT_ID, IMAGE_ID)), () => {
      throw new Error('disk gone')
    })
    expect(response.status).toBe(404)
  })

  it.each(['POST', 'PUT', 'DELETE', 'HEAD'])('answers 405 for %s and never looks anything up', async (method) => {
    const lookup = vi.fn<ChatImageLookup>(knownLookup())
    const response = await handleChatImageRequest(request(chatImageUrl(FOLDER_KEY, CHAT_ID, IMAGE_ID), method), lookup)
    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('GET')
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('parseChatImageUrl', () => {
  it('reads the folder key, chat id and image id, and null for a project-less chat', () => {
    expect(parseChatImageUrl(chatImageUrl(FOLDER_KEY, CHAT_ID, IMAGE_ID))).toEqual({ folderKey: FOLDER_KEY, chatId: CHAT_ID, imageId: IMAGE_ID })
    expect(parseChatImageUrl(chatImageUrl(null, CHAT_ID, IMAGE_ID))).toEqual({ folderKey: null, chatId: CHAT_ID, imageId: IMAGE_ID })
  })

  it('refuses an address that is not a URL', () => {
    expect(parseChatImageUrl('not a url')).toBeNull()
  })
})

describe('registerChatImageProtocol', () => {
  it('answers dm-chat-image with the lookup-backed handler', async () => {
    const handle = vi.fn()
    registerChatImageProtocol({ handle } as never, knownLookup())
    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle).toHaveBeenCalledWith('dm-chat-image', expect.any(Function))
    const [, handler] = handle.mock.calls[0] as [string, (request: Request) => Promise<Response>]
    expect((await handler(request(chatImageUrl(FOLDER_KEY, CHAT_ID, IMAGE_ID)))).status).toBe(200)
  })
})

describe('createChatImageLookup', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  it('reads through the folder the key names, project-less chats directly, and nothing for an untracked key', async () => {
    const read = vi.fn(async () => ({ bytes: SWATCH, mime: 'image/png' as const }))
    const lookup = createChatImageLookup({ pathForKey: (key) => (key === FOLDER_KEY ? '/repo' : null), read })

    await expect(lookup({ folderKey: FOLDER_KEY, chatId: CHAT_ID, imageId: IMAGE_ID })).resolves.toEqual({ bytes: SWATCH, mime: 'image/png' })
    expect(read).toHaveBeenLastCalledWith({ folder: '/repo', chatId: CHAT_ID }, IMAGE_ID)
    await lookup({ folderKey: null, chatId: CHAT_ID, imageId: IMAGE_ID })
    expect(read).toHaveBeenLastCalledWith({ folder: null, chatId: CHAT_ID }, IMAGE_ID)
    read.mockClear()
    await expect(lookup({ folderKey: 'ffffffffffffffffffffffffffffffff', chatId: CHAT_ID, imageId: IMAGE_ID })).resolves.toBeNull()
    expect(read).not.toHaveBeenCalled()
  })

  it('finds nothing when the key stopped naming that folder during the read', async () => {
    const paths = ['/repo', '/elsewhere']
    const lookup = createChatImageLookup({
      pathForKey: () => paths.shift() ?? null,
      read: async () => ({ bytes: SWATCH, mime: 'image/png' })
    })
    await expect(lookup({ folderKey: FOLDER_KEY, chatId: CHAT_ID, imageId: IMAGE_ID })).resolves.toBeNull()
  })

  it('still serves an image after a restart: a new registry (new attachment key) and a new store find it', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-chat-image-restart-')))
    roots.push(root)
    const folder = join(root, 'Repo')
    mkdirSync(folder)
    const options = { file: join(root, 'state', 'folders.json'), homeDir: join(root, 'home'), dmHome: join(root, 'home', '.darkmechanicus') }
    const imagesRoot = join(root, 'chat-images')

    const before = createFolderRegistry(options)
    const tracked = before.track(folder).folder
    const ref = await createChatImages({ root: imagesRoot }).put({ folder: tracked.path, chatId: CHAT_ID }, SWATCH)

    const after = createFolderRegistry(options)
    const key = after.list().find((entry) => entry.path === tracked.path)?.attachmentKey ?? ''
    expect(key).not.toBe(tracked.attachmentKey)
    const images = createChatImages({ root: imagesRoot })
    const lookup = createChatImageLookup({ pathForKey: (k) => after.pathForKey(k), read: (r, id) => images.read(r, id) })

    const response = await handleChatImageRequest(request(chatImageUrl(key, CHAT_ID, ref.id)), lookup)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(SWATCH)
    expect((await handleChatImageRequest(request(chatImageUrl(tracked.attachmentKey, CHAT_ID, ref.id)), lookup)).status).toBe(404)
  })
})
