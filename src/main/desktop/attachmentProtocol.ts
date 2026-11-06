/**
 * The `dm-attachment:` protocol: serves stored images to the app window, read-only. The request handler and the
 * lookup are pure (no Electron imports) so they are unit tested with fakes; `registerAttachmentScheme` and
 * `registerAttachmentProtocol` are the only Electron touch points and only pass the scheme and the handler through.
 */
import type { Protocol } from 'electron'
import type { AttachmentMime } from '../../shared/domain/views'
import { ATTACHMENT_SCHEME } from '../../shared/desktop/attachmentUrl'
import type { Ctx } from '../../core/context'
import { DomainError } from '../../core/errors'
import { isStableId } from '../../core/ids'
import { getAttachment, readAttachmentBytes } from '../../core/services/attachments'

/** A folder key is 16 random bytes in lowercase hex (`folderRegistry`). */
const FOLDER_KEY_PATTERN = /^[0-9a-f]{32}$/
const SINGLE_SEGMENT_PATH = /^\/([^/]+)$/

interface StoredImage {
  bytes: Uint8Array
  mime: AttachmentMime
}

/** The stored image for a folder key and an attachment id, or null when there is none to serve. */
export type AttachmentLookup = (folderKey: string, attachmentId: string) => StoredImage | null

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
export function handleAttachmentRequest(request: Request, lookup: AttachmentLookup): Response {
  if (request.method !== 'GET') {
    return empty(405, { Allow: 'GET' })
  }
  const target = parseAttachmentUrl(request.url)
  if (target === null) {
    return empty(404)
  }
  let image: StoredImage | null
  try {
    image = lookup(target.folderKey, target.attachmentId)
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
  /** The core context of an open folder; throws when the folder cannot be opened. */
  contextFor(path: string): Ctx
}

/**
 * Looks an image up through the folder's own workspace. A missing folder, an unknown id, and an image flagged
 * missing all read as null; other failures propagate to the handler, which answers 404.
 */
export function createAttachmentLookup(deps: AttachmentLookupDeps): AttachmentLookup {
  return (folderKey, attachmentId) => {
    const path = deps.pathForKey(folderKey)
    if (path === null) {
      return null
    }
    const ctx = deps.contextFor(path)
    try {
      const view = getAttachment(ctx, attachmentId)
      if (view.missing) {
        return null
      }
      return { bytes: readAttachmentBytes(ctx, attachmentId), mime: view.mime }
    } catch (error) {
      if (error instanceof DomainError) {
        return null
      }
      throw error
    }
  }
}

/** Before the app is ready: the scheme must be privileged to load as an image source. */
export function registerAttachmentScheme(protocol: Pick<Protocol, 'registerSchemesAsPrivileged'>): void {
  protocol.registerSchemesAsPrivileged([{ scheme: ATTACHMENT_SCHEME, privileges: { standard: true, secure: true } }])
}

/** After the app is ready: answers `dm-attachment:` requests with `lookup`. */
export function registerAttachmentProtocol(protocol: Pick<Protocol, 'handle'>, lookup: AttachmentLookup): void {
  protocol.handle(ATTACHMENT_SCHEME, (request) => handleAttachmentRequest(request, lookup))
}
