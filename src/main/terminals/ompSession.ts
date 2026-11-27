/**
 * How the app learns an OMP chat's session (`docs/reports/omp-cli.md`, 4 and 5). OMP mints the session id itself
 * (a UUIDv7) and offers no flag to choose it, and a start with no prompt writes no session file until the first
 * turn. So each OMP chat gets a session folder of its own (`--session-dir`), and the id is read from the name of
 * the one file OMP wrote there, `<timestamp>_<uuid>.jsonl`; a chat whose folder holds none has no session to
 * resume. `--resume <uuid>` with the same `--session-dir` then finds it.
 *
 * The same folder holds a config overlay: `setupVersion: 3`, because OMP's first-run Setup wizard opens
 * instead of the chat until its current setup marker is present, the Skitarii theme (`ompSkitariiTheme.ts`) and the
 * startup and status line settings the Skitarii extension's look needs (`resources/skitarii/extension/`).
 * An overlay given with `--config` applies to one launch without changing the person's own `~/.omp`.
 * OMP 18.17.0 was exercised with this production overlay and a fresh isolated agent folder.
 */
import { mkdir, rename, rm } from 'node:fs/promises'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { chatIdSchema, type ChatRole } from '../../shared/agents/chat'
import { SKITARII_THEME_NAME } from './ompSkitariiTheme'
import { writePrivateFile } from './privateFile'

const SESSION_FILE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

/**
 * OMP's `default` status line (`packages/tui/src/status-line/presets.ts` in OMP 18.16.0) without its `pi` brand
 * segment, which draws `π`. Segment lists are read only under `preset: custom`, so the overlay names the preset too.
 */
const STATUS_LINE = [
  'statusLine:',
  '  preset: custom',
  '  leftSegments: [vim, model, mode, collab, stream, path, git, pr, context_pct, cost]',
  '  rightSegments: [session_name]',
  '  separator: powerline-thin',
  '  segmentOptions:',
  '    model: { showThinkingLevel: true }',
  '    path: { abbreviate: true, maxLength: 40, stripWorkPrefix: true }',
  '    git: { showBranch: true, showStaged: true, showUnstaged: true, showUntracked: true }'
]

/**
 * The overlay text for the launch it is given to: skips the first-run Setup wizard, picks the Skitarii theme (both
 * slots), hides OMP's own logo and welcome (`startup.quiet`; the Skitarii extension draws the mascot banner instead) and
 * drops the `π` brand from the status line.
 */
export const OMP_CONFIG_OVERLAY = [
  'setupVersion: 3',
  'startup:',
  '  quiet: true',
  'theme:',
  `  dark: ${SKITARII_THEME_NAME}`,
  `  light: ${SKITARII_THEME_NAME}`,
  ...STATUS_LINE,
  ''
].join('\n')

/**
 * What the overlay of a chat that orchestrates a run adds: OMP's task tool takes a per-subagent `model`
 * (`provider/id[:level]`) only with `task.perCallModel: on` (default `off`, which refuses the call; project settings
 * cannot turn it on). The Magos starts each worker on the model and effort it claimed (`core/hostCatalogs/omp.ts`).
 * Verified on omp 18.20.2. OMP still accepts only models its configuration already routes to.
 */
export const OMP_MAGOS_OVERLAY = ['task:', '  perCallModel: "on"', ''].join('\n')

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
 * Writes the overlay (with the Magos part for a chat whose recorded role is `orchestrator`, a run's or a folder's
 * Magos) and makes the session folder. A start that forgets the old session (`fresh`) first moves the folder aside,
 * so the old session stays on disk but is not the one resumed.
 */
export async function writeOmpFiles(
  userData: string, chatId: string, start: { fresh: boolean; role: ChatRole }, now: () => number = Date.now
): Promise<OmpFiles> {
  const files = ompFilePaths(userData, chatId)
  if (start.fresh && ompSessionId(files.sessionDir) !== null) {
    await rename(files.sessionDir, `${files.sessionDir}.old-${now()}`)
  }
  await mkdir(files.sessionDir, { recursive: true, mode: 0o700 })
  await writePrivateFile(files.config, start.role === 'orchestrator' ? OMP_CONFIG_OVERLAY + OMP_MAGOS_OVERLAY : OMP_CONFIG_OVERLAY, 0o600)
  return files
}

/**
 * Removes a deleted chat's whole OMP folder (overlay and every session). The id is validated by `ompFilePaths` before
 * anything is touched, so a bad id throws and deletes nothing; a missing folder is not an error.
 */
export async function removeOmpFolder(userData: string, chatId: string): Promise<void> {
  const folder = dirname(ompFilePaths(userData, chatId).config)
  await rm(folder, { recursive: true, force: true })
}
