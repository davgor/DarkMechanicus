/**
 * The images of each agent chat, kept by main beside the chats (`userData/agents/chat-images`) and never in a folder's
 * portable records: images the person sent, images agents returned, and browser captures. One directory per chat:
 *
 *   <root>/<folderStoreId or projectless>/<chat id>/<image id>.<png|jpg|webp>
 *
 * The folder directory is the folder's durable `folderStoreId` (never its per-run attachment key), so the images
 * survive a restart. Only validated values are joined into a path: the hex store id, a `chatIdSchema` chat id and a
 * `ci_` image id main made itself. Every write lands whole: the bytes go to a sibling file renamed over the target.
 */
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { DomainError } from '../../core/errors'
import { encodeBase32 } from '../../core/ids'
import { inspectImageBytes, inspectToolImageBytes } from '../../core/attachments/intake'
import { chatIdSchema, chatImageIdSchema, type ChatImageRef } from '../../shared/agents/chat'
import { writePrivateFile } from '../terminals/privateFile'
import { folderStoreId } from './folderStoreId'

/** Which chat an image belongs to: the chat's canonical folder path (null for a project-less chat) and its id. */
export interface ChatImagesRef {
  folder: string | null
  chatId: string
}

/** The types main keeps, in the order `read` looks for them. */
const MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const

type ChatImageMime = (typeof MIMES)[number]

/** An image a tool returned, as main measured it: PNG, JPEG or WebP. */
type ToolImageRef = Omit<ChatImageRef, 'mime'> & { mime: ChatImageMime }

export interface StoredChatImage {
  bytes: Uint8Array
  mime: ChatImageMime
}

export interface ChatImages {
  /** Keeps an image the person sent (PNG or JPEG only); refused bytes throw `invalid_input` and write nothing. */
  put(ref: ChatImagesRef, bytes: Uint8Array): Promise<ChatImageRef>
  /** Keeps an image a tool returned: PNG, JPEG or WebP, under the same limits; refused bytes write nothing. */
  putToolImage(ref: ChatImagesRef, bytes: Uint8Array): Promise<ToolImageRef>
  /** The image with that id in that chat's own directory; null for any other id or chat. */
  read(ref: ChatImagesRef, imageId: string): Promise<StoredChatImage | null>
  /** Removes every image of the chat. */
  deleteChat(ref: ChatImagesRef): void
}

/** The directory of the project-less chats' images: not a hex digest, so no folder's store id can be it. */
const PROJECTLESS_DIR = 'projectless'

const EXTENSION: Record<ChatImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }

function invalid(message: string): never {
  throw new DomainError('invalid_input', message)
}

/** The chat's image directory; throws `invalid_input` for a chat id that is not filesystem-safe. */
function chatDir(root: string, ref: ChatImagesRef, platform: NodeJS.Platform): string {
  if (!chatIdSchema.safeParse(ref.chatId).success) invalid('Invalid chat id.')
  return join(root, ref.folder === null ? PROJECTLESS_DIR : folderStoreId(ref.folder, platform), ref.chatId)
}

/** `ci_` and 26 random Crockford base32 characters (130 random bits). */
function newImageId(): string {
  return `ci_${encodeBase32(BigInt(`0x${randomBytes(17).toString('hex')}`), 26)}`
}

function asBuffer(bytes: Uint8Array): Buffer {
  return Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

async function readIfPresent(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path)
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
}

export function createChatImages(options: {
  /** Absolute path of the chat images directory (`userData/agents/chat-images`). */
  root: string
  platform?: NodeJS.Platform
}): ChatImages {
  const platform = options.platform ?? process.platform
  const store = async <T extends ChatImageMime>(ref: ChatImagesRef, buffer: Buffer, measured: { mime: T; width: number; height: number }) => {
    const id = newImageId()
    await writePrivateFile(join(chatDir(options.root, ref, platform), `${id}.${EXTENSION[measured.mime]}`), buffer, 0o600)
    return { id, mime: measured.mime, width: measured.width, height: measured.height, bytes: buffer.byteLength }
  }
  return {
    put: async (ref, bytes) => store(ref, asBuffer(bytes), inspectImageBytes(bytes)),
    putToolImage: async (ref, bytes) => store(ref, asBuffer(bytes), inspectToolImageBytes(bytes)),
    read: async (ref, imageId) => {
      if (!chatImageIdSchema.safeParse(imageId).success || !chatIdSchema.safeParse(ref.chatId).success) return null
      const dir = chatDir(options.root, ref, platform)
      for (const mime of MIMES) {
        const bytes = await readIfPresent(join(dir, `${imageId}.${EXTENSION[mime]}`))
        if (bytes !== null) return { bytes, mime }
      }
      return null
    },
    deleteChat: (ref) => {
      rmSync(chatDir(options.root, ref, platform), { recursive: true, force: true })
    }
  }
}
