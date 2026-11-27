/**
 * The `dm-attachment:` protocol: serves stored images to the app window, read-only. The request handler and the
 * lookup are pure (no Electron imports) so they are unit tested with fakes; `registerAttachmentScheme` and
 * `registerAttachmentProtocol` are the only Electron touch points and only pass the scheme and the handler through.
 */
import type { Protocol } from 'electron'
import type { AttachmentMime } from '../../shared/domain/views'
import { ATTACHMENT_SCHEME } from '../../shared/desktop/attachmentUrl'
import { CHAT_IMAGE_SCHEME } from '../../shared/agents/chatImageUrl'
import { isStableId } from '../../core/ids'

/** A folder key is 16 random bytes in lowercase hex (`folderRegistry`). */
const FOLDER_KEY_PATTERN = /^[0-9a-f]{32}$/
const SINGLE_SEGMENT_PATH = /^\/([^/]+)$/

interface StoredImage {
  bytes: Uint8Array
  mime: AttachmentMime
}

/** The stored image for a folder key and an attachment id, or null when there is none to serve. */
export type AttachmentLookup = (folderKey: string, attachmentId: string) => StoredImage | null | Promise<StoredImage | null>

interface AttachmentTarget {
  folderKey: string
  attachmentId: string
}

/** The folder key and attachment id a request URL names, or null when it names neither validly. */
export function parseAttachmentUrl(url: string): AttachmentTarget | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== `${ATTACHMENT_SCHEME}:`) {
    return null
  }
  const folderKey = parsed.hostname
  const path = SINGLE_SEGMENT_PATH.exec(parsed.pathname)
  const attachmentId = path?.[1]
  if (!FOLDER_KEY_PATTERN.test(folderKey) || attachmentId === undefined || !isStableId(attachmentId, 'attachment')) {
    return null
  }
  return { folderKey, attachmentId }
}

const NOSNIFF = 'nosniff'
const IMMUTABLE_FOR_A_YEAR = 'private, max-age=31536000, immutable'

function empty(status: number, headers: Record<string, string> = {}): Response {
  return new Response(null, { status, headers: { 'X-Content-Type-Options': NOSNIFF, ...headers } })
}

/**
 * Answers one `dm-attachment:` request: the stored bytes with their stored type for a known id, 404 for an
 * unknown, missing or malformed address, and 405 for any method but GET.
 */
export async function handleAttachmentRequest(request: Request, lookup: AttachmentLookup): Promise<Response> {
  if (request.method !== 'GET') {
    return empty(405, { Allow: 'GET' })
  }
  const target = parseAttachmentUrl(request.url)
  if (target === null) {
    return empty(404)
  }
  let image: StoredImage | null
  try {
    image = await lookup(target.folderKey, target.attachmentId)
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

interface AttachmentLookupDeps {
  /** The tracked folder a key names, or null. */
  pathForKey(folderKey: string): string | null
  read(path: string, attachmentId: string): Promise<StoredImage | null>
}

/**
 * Looks an image up through the folder's own workspace. A missing folder, an unknown id, and an image flagged
 * missing all read as null; other failures propagate to the handler, which answers 404.
 */
export function createAttachmentLookup(deps: AttachmentLookupDeps): AttachmentLookup {
  return async (folderKey, attachmentId) => {
    const path = deps.pathForKey(folderKey)
    if (path === null) return null
    const image = await deps.read(path, attachmentId)
    return deps.pathForKey(folderKey) === path ? image : null
  }
}

/**
 * Before the app is ready: both image schemes (`dm-attachment:` and the chats' `dm-chat-image:`) must be privileged to
 * load as image sources. Electron honours only one `registerSchemesAsPrivileged` call, so this is the app's only one.
 */
export function registerAttachmentScheme(protocol: Pick<Protocol, 'registerSchemesAsPrivileged'>): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ATTACHMENT_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: CHAT_IMAGE_SCHEME, privileges: { standard: true, secure: true } }
  ])
}

/** After the app is ready: answers `dm-attachment:` requests with `lookup`. */
export function registerAttachmentProtocol(protocol: Pick<Protocol, 'handle'>, lookup: AttachmentLookup): void {
  protocol.handle(ATTACHMENT_SCHEME, (request) => handleAttachmentRequest(request, lookup))
}
