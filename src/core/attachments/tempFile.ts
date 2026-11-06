import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AttachmentMime } from '../../shared/domain/views'

/** The folder under the system temp folder that holds copies of attachment bytes handed to a caller. */
const ATTACHMENT_TEMP_DIR = join(tmpdir(), 'darkmechanicus-attachments')

const EXTENSIONS: Record<AttachmentMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg' }

/**
 * Writes `bytes` (which must hash to `sha256`) to `<dir>/<sha256>.<ext>` and returns that absolute path. A copy that
 * already holds exactly these bytes is reused; one that does not is replaced.
 */
export function writeAttachmentTempFile(
  sha256: string,
  mime: AttachmentMime,
  bytes: Uint8Array,
  dir: string = ATTACHMENT_TEMP_DIR
): string {
  const path = join(dir, `${sha256}.${EXTENSIONS[mime]}`)
  if (existsSync(path) && createHash('sha256').update(readFileSync(path)).digest('hex') === sha256) {
    return path
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(path, bytes)
  return path
}
