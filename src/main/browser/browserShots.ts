/**
 * The screenshot copies main hands a chat's `dm` CLI over the browser pipe (DM-867 contract): one PNG, mode 0600, in
 * a fresh 0700 `dm-browser-shot-*` directory directly under the system temp folder. The CLI stages the copy as
 * evidence and removes the directory; a copy nobody collected is swept once it is 10 minutes old, and on dispose.
 */
import { chmod, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const PREFIX = 'dm-browser-shot-'
const FILE = 'screenshot.png'
const SHOT_TTL_MS = 10 * 60_000

export interface BrowserShots {
  /** Writes `png` as a new copy (sweeping older ones first) and answers its absolute path. */
  write(png: Uint8Array): Promise<string>
  /** Removes every copy this process wrote that is still there. */
  dispose(): Promise<void>
}

export function createBrowserShots(options: { now?: () => number; root?: string } = {}): BrowserShots {
  const now = options.now ?? Date.now
  // The CLI compares the copy's parent with the real temp folder, so the copy is written there.
  const root = options.root ?? realpathSync.native(tmpdir())
  const written = new Set<string>()

  /** Removes copies older than the TTL: this process's and any a crashed earlier run left behind. */
  const sweep = async (): Promise<void> => {
    const names = await readdir(root).catch(() => [] as string[])
    await Promise.all(names.filter((name) => name.startsWith(PREFIX)).map(async (name) => {
      const directory = join(root, name)
      const info = await stat(directory).catch(() => null)
      if (info === null || now() - info.mtimeMs < SHOT_TTL_MS) return
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
      written.delete(directory)
    }))
  }

  return {
    write: async (png) => {
      await sweep()
      const directory = await mkdtemp(join(root, PREFIX))
      written.add(directory)
      await chmod(directory, 0o700)
      const file = join(directory, FILE)
      await writeFile(file, png, { mode: 0o600, flag: 'wx' })
      await chmod(file, 0o600)
      return file
    },
    dispose: async () => {
      const directories = [...written]
      written.clear()
      await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true }).catch(() => undefined)))
    }
  }
}
