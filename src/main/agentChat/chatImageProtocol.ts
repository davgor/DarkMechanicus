/**
 * The `dm-chat-image:` protocol: serves the images main keeps for each chat (`chatImages.ts`) to the app window,
 * read-only. `dm-chat-image://<attachment key or projectless>/<chat id>/<image id>`: the host is the folder's per-run
 * attachment key, which main maps to the folder's path and from there to its durable store. Parsing, the handler and
 * the lookup are pure (no Electron imports) so they are unit tested with fakes; `registerChatImageProtocol` only passes
 * the handler through. The scheme is made privileged with `dm-attachment:` in one call (`registerAttachmentScheme`).
 */
import type { Protocol } from 'electron'
import { chatIdSchema, chatImageIdSchema } from '../../shared/agents/chat'
import { CHAT_IMAGE_SCHEME } from '../../shared/agents/chatImageUrl'
import type { ChatImagesRef, StoredChatImage } from './chatImages'

/** A folder key is 16 random bytes in lowercase hex (`folderRegistry`); `projectless` names the project-less chats. */
const HOST_PATTERN = /^(?:[0-9a-f]{32}|projectless)$/
const TWO_SEGMENT_PATH = /^\/([^/]+)\/([^/]+)$/

interface ChatImageTarget {
  /** The folder's attachment key; null for a project-less chat. */
  folderKey: string | null
  chatId: string
  imageId: string
}

/** The stored image a request names, or null when there is none to serve. */
export type ChatImageLookup = (target: ChatImageTarget) => StoredChatImage | null | Promise<StoredChatImage | null>

/** The folder key, chat id and image id a request URL names, or null when it names them not validly. */
export function parseChatImageUrl(url: string): ChatImageTarget | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${CHAT_IMAGE_SCHEME}:` || !HOST_PATTERN.test(parsed.hostname)) {
    return null
  }
  const [, chatSegment, imageSegment] = TWO_SEGMENT_PATH.exec(parsed.pathname) ?? []
  const chatId = chatIdSchema.safeParse(chatSegment)
  const imageId = chatImageIdSchema.safeParse(imageSegment)
  if (!chatId.success || !imageId.success) {
    return null
  }
  return { folderKey: parsed.hostname === 'projectless' ? null : parsed.hostname, chatId: chatId.data, imageId: imageId.data }
}

const NOSNIFF = 'nosniff'
const IMMUTABLE_FOR_A_YEAR = 'private, max-age=31536000, immutable'

function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { 'X-Content-Type-Options': NOSNIFF, ...headers } })
}

/**
 * Answers one `dm-chat-image:` request: the stored bytes with their stored type for a known image, 404 for an
 * unknown, malformed or traversing address (a lookup failure too), and 405 for any method but GET.
 */
export async function handleChatImageRequest(request: Request, lookup: ChatImageLookup): Promise<Response> {
  if (request.method !== 'GET') {
    return empty(405, { Allow: 'GET' })
  }
  const target = parseChatImageUrl(request.url)
  if (target === null) {
    return empty(404)
  }
  let image: StoredChatImage | null
  try {
    image = await lookup(target)
  } catch {
    image = null
  }
  if (image === null) {
    return empty(404)
  }
  return new Response(image.bytes as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': image.mime,
      'Content-Length': String(image.bytes.byteLength),
      'X-Content-Type-Options': NOSNIFF,
      'Cache-Control': IMMUTABLE_FOR_A_YEAR
    }
  })
}

interface ChatImageLookupDeps {
  /** The tracked folder a key names (its canonical path), or null. */
  pathForKey(folderKey: string): string | null
  read(ref: ChatImagesRef, imageId: string): Promise<StoredChatImage | null>
}

/**
 * Looks an image up in its chat's own directory, through the folder the per-run key names. An untracked key, and a
 * key that stopped naming that folder while the image was read, find nothing.
 */
export function createChatImageLookup(deps: ChatImageLookupDeps): ChatImageLookup {
  return async ({ folderKey, chatId, imageId }) => {
    if (folderKey === null) return deps.read({ folder: null, chatId }, imageId)
    const folder = deps.pathForKey(folderKey)
    if (folder === null) return null
    const image = await deps.read({ folder, chatId }, imageId)
    return deps.pathForKey(folderKey) === folder ? image : null
  }
}

/** After the app is ready: answers `dm-chat-image:` requests with `lookup`. Main passes the default session's protocol only. */
export function registerChatImageProtocol(protocol: Pick<Protocol, 'handle'>, lookup: ChatImageLookup): void {
  protocol.handle(CHAT_IMAGE_SCHEME, (request) => handleChatImageRequest(request, lookup))
}
