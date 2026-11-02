/**
 * Writes a file only this user may read (and, for a launcher, run), replacing whatever is at the path. The text
 * goes to a sibling file first and is renamed over the path, so a reader never sees half a file and a symlink
 * left at the path is replaced rather than followed.
 */
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

type Rename = (from: string, to: string) => Promise<void>

/**
 * What Windows answers a rename onto a path that another rename is replacing at that moment, or that a reader holds
 * open, as two starts of one chat writing at once do. It passes, so the rename is tried again for a short while.
 */
const REFUSED_FOR_NOW: ReadonlySet<unknown> = new Set(['EPERM', 'EACCES', 'EBUSY'])
const RENAME_TRIES = 10
/** The wait between tries: under half a second in all. */
const RENAME_PAUSE_MS = 50

async function renameOver(from: string, to: string, renameFile: Rename): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await renameFile(from, to)
      return
    } catch (error: unknown) {
      if (attempt === RENAME_TRIES || !REFUSED_FOR_NOW.has((error as { code?: unknown }).code)) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, RENAME_PAUSE_MS))
    }
  }
}

export async function writePrivateFile(path: string, text: string, mode: 0o600 | 0o700, renameFile: Rename = rename): Promise<void> {
  const folder = dirname(path)
  await mkdir(folder, { recursive: true, mode: 0o700 })
  await chmod(folder, 0o700)
  // Unique per write, so two starts of one chat writing at once never share (or delete) each other's staged file.
  const staged = `${path}.${randomUUID()}.new`
  try {
    await writeFile(staged, text, { mode, flag: 'wx' })
    await chmod(staged, mode)
    await renameOver(staged, path, renameFile)
  } finally {
    await rm(staged, { force: true })
  }
}
