/**
 * Writes a file only this user may read (and, for a launcher, run), replacing whatever is at the path. The text
 * goes to a sibling file first and is renamed over the path, so a reader never sees half a file and a symlink
 * left at the path is replaced rather than followed.
 */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export async function writePrivateFile(path: string, text: string, mode: 0o600 | 0o700): Promise<void> {
  const folder = dirname(path)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  await chmod(folder, 0o700)
  // Unique per write, so two starts of one chat writing at once never share (or delete) each other's staged file.
  const staged = `${path}.${randomUUID()}.new`
  try {
    await writeFile(staged, text, { mode, flag: 'wx' })
    await chmod(staged, mode)
    await rename(staged, path)
  } finally {
    await rm(staged, { force: true })
  }
}
