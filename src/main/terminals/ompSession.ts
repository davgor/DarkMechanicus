/**
 * How the app learns an OMP chat's session (`docs/reports/omp-cli.md`, 4 and 5). OMP mints the session id itself
 * (a UUIDv7) and offers no flag to choose it, and a start with no prompt writes no session file until the first
 * turn. So each OMP chat gets a session folder of its own (`--session-dir`), and the id is read from the name of
 * the one file OMP wrote there, `<timestamp>_<uuid>.jsonl`; a chat whose folder holds none has no session to
 * resume. `--resume <uuid>` with the same `--session-dir` then finds it.
 *
 * The same folder holds a config overlay that only sets `setupVersion: 2`: OMP's first-run Setup wizard opens
 * (instead of the chat) until that is in its `config.yml`, and an overlay given with `--config` clears it for one
 * launch without changing the person's own `~/.omp` (checked with OMP 18.16.0 and a scratch agent folder).
 */
import { mkdir, rename } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { chatIdSchema } from '../../shared/agents/chat'
import { writePrivateFile } from './privateFile'

const SESSION_FILE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/** The overlay text: skips the first-run Setup wizard for the launch it is given to. */
export const OMP_CONFIG_OVERLAY = 'setupVersion: 2\n'

interface OmpFiles {
  /** `--session-dir`: the chat's own session folder. */
  sessionDir: string
  /** `--config`: the overlay file. */
  config: string
}

export function ompFilePaths(userData: string, chatId: string): OmpFiles {
  if (!chatIdSchema.safeParse(chatId).success) {
    throw new Error(`${JSON.stringify(chatId)} is not a chat id.`)
  }
  const root = join(userData, 'agents', 'omp', chatId)
  return { sessionDir: join(root, 'sessions'), config: join(root, 'config.yml') }
}

/** The id of the newest session in the chat's session folder (file names start with a sortable timestamp), or null. */
export function ompSessionId(sessionDir: string): string | null {
  let names: string[]
  try {
    names = readdirSync(sessionDir)
  } catch {
    return null
  }
  const found = names.filter((name) => SESSION_FILE.test(name)).sort()
  const newest = found[found.length - 1]
  return newest === undefined ? null : (SESSION_FILE.exec(newest)?.[1] ?? null)
}

/**
 * Writes the overlay and makes the session folder. A start that forgets the old session (`fresh`) first moves the
 * folder aside, so the old session stays on disk but is not the one resumed.
 */
export async function writeOmpFiles(userData: string, chatId: string, fresh: boolean, now: () => number = Date.now): Promise<OmpFiles> {
  const files = ompFilePaths(userData, chatId)
  if (fresh && ompSessionId(files.sessionDir) !== null) {
    await rename(files.sessionDir, `${files.sessionDir}.old-${now()}`)
  }
  await mkdir(files.sessionDir, { recursive: true, mode: 0o700 })
  await writePrivateFile(files.config, OMP_CONFIG_OVERLAY, 0o600)
  return files
}
