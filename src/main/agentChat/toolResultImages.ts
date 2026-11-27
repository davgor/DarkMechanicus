import { inspectToolImageBytes, MAX_IMAGE_BYTES } from '../../core/attachments/intake'

/** An image the person sends with a turn, already through DM intake: PNG or JPEG bytes as plain base64. */
export interface TurnImage { mime: 'image/png' | 'image/jpeg'; base64: string }

/**
 * Image bytes a tool returned for one `tool_call` item. They travel beside a translation's events, never inside an
 * item, event or summary, and are not masked: they are bytes, not text.
 */
export interface ToolResultBlob { itemId: string; mime: 'image/png' | 'image/jpeg' | 'image/webp'; base64: string }

/** A tool result's image block as the CLI sent it, before any check. */
interface ToolImageBlock { mime: unknown; data: unknown }

/** Transcript items hold at most 8 tool images (`chat.ts`). */
const IMAGES_PER_ITEM = 8
const MAX_BASE64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
const MIME = /^[a-z0-9.+-]{1,32}\/[a-z0-9.+-]{1,64}$/i

function liftedMime({ mime, data }: ToolImageBlock): ToolResultBlob['mime'] | null {
  if (typeof data !== 'string' || !data || data.length > MAX_BASE64) return null
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) return null
  try {
    const inspected = inspectToolImageBytes(bytes)
    return inspected.mime === mime ? inspected.mime : null
  } catch { return null }
}

/**
 * The Image contract's blob rule for one tool result: a PNG, JPEG or WebP block whose bytes match its type and pass
 * `inspectToolImageBytes` becomes a blob; any other block becomes the note `1 image (<mime>, not shown)`. Pure, so
 * duplicate copies of one result give the same notes.
 */
export function liftToolImages(itemId: string, blocks: readonly ToolImageBlock[]): { blobs: ToolResultBlob[]; notes: string[] } {
  const blobs: ToolResultBlob[] = [], notes: string[] = []
  for (const block of blocks) {
    const mime = blobs.length < IMAGES_PER_ITEM ? liftedMime(block) : null
    if (mime) blobs.push({ itemId, mime, base64: block.data as string })
    else notes.push(`1 image (${typeof block.mime === 'string' && MIME.test(block.mime) ? block.mime.toLowerCase() : 'unknown type'}, not shown)`)
  }
  return { blobs, notes }
}
