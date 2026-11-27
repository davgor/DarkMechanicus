import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { jpegBytes, webpBytes } from '../../test/images'
import { chatImageRefSchema } from '../../shared/agents/chat'
import { createChatImages, type ChatImagesRef } from './chatImages'
import { folderStoreId } from './folderStoreId'

const SWATCH = readFileSync(join(__dirname, '__fixtures__', 'images', 'swatch.png'))
const JPEG = jpegBytes(40, 30)
const FOLDER = join(tmpdir(), 'dm-chat-images-folder', 'Repo')

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-chat-images-')))
  roots.push(root)
  return root
}

/** Every file under `dir`, relative to it. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
}

async function refusal(action: Promise<unknown>): Promise<string> {
  try {
    await action
  } catch (error) {
    return error instanceof DomainError ? error.code : `unexpected: ${String(error)}`
  }
  return 'no error'
}

const CHAT: ChatImagesRef = { folder: FOLDER, chatId: 'chat_one' }
const OTHER_CHAT: ChatImagesRef = { folder: FOLDER, chatId: 'chat_two' }

describe('chat images: put and read', () => {
  it('round-trips the PNG swatch and a JPEG, measured, under the folder store id and the chat id', async () => {
    const root = tempRoot()
    const images = createChatImages({ root, platform: 'win32' })

    const png = await images.put(CHAT, SWATCH)
    const jpeg = await images.put(CHAT, JPEG)

    expect(chatImageRefSchema.parse(png)).toEqual({ id: png.id, mime: 'image/png', width: 64, height: 64, bytes: SWATCH.length })
    expect(chatImageRefSchema.parse(jpeg)).toEqual({ id: jpeg.id, mime: 'image/jpeg', width: 40, height: 30, bytes: JPEG.length })
    expect(png.id).not.toBe(jpeg.id)
    await expect(images.read(CHAT, png.id)).resolves.toEqual({ bytes: SWATCH, mime: 'image/png' })
    await expect(images.read(CHAT, jpeg.id)).resolves.toEqual({ bytes: JPEG, mime: 'image/jpeg' })
    const dir = join(folderStoreId(FOLDER, 'win32'), 'chat_one')
    expect(filesUnder(root).sort()).toEqual([join(dir, `${jpeg.id}.jpg`), join(dir, `${png.id}.png`)].sort())
  })

  it('keeps project-less chats in the projectless directory', async () => {
    const root = tempRoot()
    const images = createChatImages({ root })

    const png = await images.put({ folder: null, chatId: 'chat_loose' }, SWATCH)

    expect(filesUnder(root)).toEqual([join('projectless', 'chat_loose', `${png.id}.png`)])
    await expect(images.read({ folder: null, chatId: 'chat_loose' }, png.id)).resolves.toEqual({ bytes: SWATCH, mime: 'image/png' })
  })

  it('keeps a WebP a tool returned, but never one the person sent', async () => {
    const root = tempRoot()
    const images = createChatImages({ root })
    const webp = webpBytes(320, 200)

    expect(await refusal(images.put(CHAT, webp))).toBe('invalid_input')
    expect(filesUnder(root)).toEqual([])
    const ref = await images.putToolImage(CHAT, webp)

    expect(ref).toMatchObject({ mime: 'image/webp', width: 320, height: 200, bytes: webp.length })
    await expect(images.read(CHAT, ref.id)).resolves.toEqual({ bytes: webp, mime: 'image/webp' })
  })
})

describe('chat images: refusals', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')
  const truncated = SWATCH.subarray(0, 20)
  const oversized = Buffer.concat([SWATCH, Buffer.alloc(10 * 1024 * 1024)])

  it.each([
    ['an SVG', svg],
    ['a truncated PNG', truncated],
    ['an image over 10 MiB', oversized]
  ])('refuses %s with invalid_input and writes nothing', async (_name, bytes) => {
    const root = tempRoot()
    const images = createChatImages({ root })

    expect(await refusal(images.put(CHAT, bytes))).toBe('invalid_input')
    expect(await refusal(images.putToolImage(CHAT, bytes))).toBe('invalid_input')
    expect(filesUnder(root)).toEqual([])
  })

  it('refuses a WebP over 8000 px and a chat id that is not filesystem-safe, writing nothing', async () => {
    const root = tempRoot()
    const images = createChatImages({ root })

    expect(await refusal(images.putToolImage(CHAT, webpBytes(8001, 10)))).toBe('invalid_input')
    expect(await refusal(images.put({ folder: FOLDER, chatId: '..' }, SWATCH))).toBe('invalid_input')
    expect(await refusal(images.put({ folder: null, chatId: 'a/../b' }, SWATCH))).toBe('invalid_input')
    expect(filesUnder(root)).toEqual([])
  })

  it("never reads another chat's image, a malformed id, or a traversing chat id", async () => {
    const root = tempRoot()
    const images = createChatImages({ root })
    const png = await images.put(CHAT, SWATCH)
    await images.put(OTHER_CHAT, JPEG)

    await expect(images.read(OTHER_CHAT, png.id)).resolves.toBeNull()
    await expect(images.read({ folder: null, chatId: CHAT.chatId }, png.id)).resolves.toBeNull()
    await expect(images.read(CHAT, png.id.toUpperCase())).resolves.toBeNull()
    await expect(images.read(CHAT, `${png.id}.png`)).resolves.toBeNull()
    await expect(images.read(CHAT, `../chat_one/${png.id}`)).resolves.toBeNull()
    await expect(images.read({ folder: FOLDER, chatId: '..' }, png.id)).resolves.toBeNull()
    await expect(images.read(CHAT, 'ci_00000000000000000000000000')).resolves.toBeNull()
  })
})

describe('chat images: deleteChat', () => {
  it("removes the chat's directory and every image in it, and keeps the other chats'", async () => {
    const root = tempRoot()
    const images = createChatImages({ root, platform: 'linux' })
    const doomed = await images.put(CHAT, SWATCH)
    const kept = await images.put(OTHER_CHAT, JPEG)

    images.deleteChat(CHAT)

    expect(existsSync(join(root, folderStoreId(FOLDER, 'linux'), 'chat_one'))).toBe(false)
    await expect(images.read(CHAT, doomed.id)).resolves.toBeNull()
    expect(filesUnder(root)).toEqual([join(folderStoreId(FOLDER, 'linux'), 'chat_two', `${kept.id}.jpg`)])
  })

  it('is a no-op for a chat with no images', () => {
    const images = createChatImages({ root: tempRoot() })
    expect(() => images.deleteChat({ folder: null, chatId: 'chat_none' })).not.toThrow()
  })
})
