/**
 * How one repository folder stores its plans, tickets and history.
 *
 * `repo` is the original mode: the portable records live in the repository itself
 * (`.darkmechanicus/epics/`, `history/`, `profiles/`, tracked by Git) with a Git-ignored working
 * database beside them, so the plan travels with the code.
 *
 * `db` keeps everything in one machine-local SQLite database **outside** the repository, under the
 * Dark Mechanicus home directory. The repository gains no files at all: no `.darkmechanicus/`, no
 * `.gitignore` entry, and no record file is ever written. It suits a checkout whose history should
 * not carry planning data, such as work for someone else.
 *
 * The mode of a folder is not configuration anyone has to keep in sync: a database-only project
 * announces itself by existing, so the desktop app and the headless MCP server resolve the same
 * mode from the repository path alone (`resolveStorageMode`).
 */
import { createHash } from 'node:crypto'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { StorageMode } from '../../shared/domain/views'
import type { FsAdapter } from './types'

export type { StorageMode }

/** Every mode, for input validation and the setup screen. */
export const STORAGE_MODES = ['repo', 'db'] as const satisfies readonly StorageMode[]

/** A folder with no Dark Mechanicus data either way is set up the original way. */
export const DEFAULT_STORAGE_MODE: StorageMode = 'repo'

/** Moves the Dark Mechanicus home directory (read by the desktop app and the MCP server alike). */
export const HOME_ENV = 'DARKMECHANICUS_HOME'

/** Name of the home directory inside the user's home, and of the file that marks a project. */
const HOME_DIR_NAME = '.darkmechanicus'
const PROJECTS_DIR = 'projects'
const PROJECT_FILE = 'project.json'

const KEY_DIGEST_LENGTH = 16
const MAX_SLUG_LENGTH = 24
const FALLBACK_SLUG = 'repo'

/**
 * The Dark Mechanicus home directory: `$DARKMECHANICUS_HOME` when set (a relative value resolves
 * against the user's home directory), otherwise `~/.darkmechanicus`.
 */
export function resolveHomeDir(env: Record<string, string | undefined>, home: string): string {
  const override = env[HOME_ENV]?.trim()
  if (override === undefined || override === '') {
    return join(home, HOME_DIR_NAME)
  }
  return isAbsolute(override) ? resolve(override) : resolve(home, override)
}

/** Lowercase alphanumeric words of a folder name, joined with dashes and capped. */
function slugOf(repoRoot: string): string {
  const slug = basename(resolve(repoRoot))
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== '')
    .join('-')
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, '')
  return slug === '' ? FALLBACK_SLUG : slug
}

/**
 * Directory name for a repository's database-only project: the folder name for a person reading
 * the directory listing, plus a digest of the whole path so two folders of the same name never
 * share a project. Pass a canonical (realpath) root, so a link or a `..` detour selects the same
 * project; every segment is alphanumeric or a dash, so the name can never escape its parent.
 */
export function projectKey(repoRoot: string): string {
  // Both halves read the same normalized path, so one folder never yields two directory names.
  const path = resolve(repoRoot)
  const digest = createHash('sha256').update(path).digest('hex').slice(0, KEY_DIGEST_LENGTH)
  return `${slugOf(path)}-${digest}`
}

/** Where a repository's database-only project lives inside the home directory. */
export function dbProjectDir(repoRoot: string, homeDir: string): string {
  return join(homeDir, PROJECTS_DIR, projectKey(repoRoot))
}

/** The file whose presence marks `repoRoot` as a database-only project. */
function dbProjectFile(repoRoot: string, homeDir: string): string {
  return join(dbProjectDir(repoRoot, homeDir), PROJECT_FILE)
}

interface StorageModeQuery {
  /** Canonical repository root. */
  repoRoot: string
  homeDir: string
  /** Only existence is asked, so the desktop's smaller registry filesystem fits too. */
  fs: Pick<FsAdapter, 'exists'>
}

/**
 * The mode `repoRoot` is set up in: `db` once it has a project in the home directory, otherwise
 * `repo`. Only the home directory decides, so a `.darkmechanicus/` that arrives later in the
 * checkout (a clone, a colleague's commit) never silently takes over a database-only project;
 * `initializeRepository` is what refuses to set a folder up both ways.
 */
export function resolveStorageMode(query: StorageModeQuery): StorageMode {
  return query.fs.exists(dbProjectFile(query.repoRoot, query.homeDir)) ? 'db' : 'repo'
}
