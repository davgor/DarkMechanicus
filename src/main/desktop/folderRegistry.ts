/**
 * Machine-local list of tracked repository folders (`userData/folders.json`). Entries are keyed by
 * canonical real path, so a symlink, a trailing separator, or a `..` detour selects the existing
 * entry instead of adding a duplicate. Stopping to track a folder removes only its entry here.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, isAbsolute, sep } from 'node:path'
import { z } from 'zod'
import { DomainError } from '../../core/errors'
import { resolveLayout } from '../../core/repo/layout'
import type { TrackedFolderView } from '../../shared/desktop/api'

/** The filesystem surface the registry uses; tests inject fakes and faults through it. */
export interface RegistryFs {
  readFile(path: string): string
  writeFile(path: string, data: string): void
  rename(from: string, to: string): void
  mkdirp(path: string): void
  /** Canonical real path; throws when the path does not exist. */
  realpath(path: string): string
  exists(path: string): boolean
  isDirectory(path: string): boolean
}

export interface FolderRegistry {
  /** Tracked folders in insertion order, with availability and initialization read fresh. */
  list(): TrackedFolderView[]
  /** Adds a folder, or selects the existing entry for the same canonical path (`added: false`). */
  track(path: string): { folder: TrackedFolderView; added: boolean }
  /** Removes only the registry entry (never repository data) and returns the remaining folders. */
  untrack(path: string): TrackedFolderView[]
  has(path: string): boolean
  /** The canonical tracked path for `path`, or null when that folder is not tracked. */
  resolve(path: string): string | null
}

const FILE_VERSION = 1

const registryFileSchema = z.object({
  version: z.literal(FILE_VERSION),
  folders: z.array(z.unknown())
})

const folderEntrySchema = z.object({ path: z.string().min(1), addedAt: z.string() })

type FolderEntry = z.infer<typeof folderEntrySchema>

const nodeRegistryFs: RegistryFs = {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, data) => {
    writeFileSync(path, data, 'utf8')
  },
  rename: renameSync,
  mkdirp: (path) => {
    mkdirSync(path, { recursive: true })
  },
  realpath: (path) => realpathSync.native(path),
  exists: existsSync,
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory()
    } catch {
      return false
    }
  }
}

interface RegistryContext {
  file: string
  homeDir: string
  fs: RegistryFs
  now: () => string
}

interface RegistryState {
  entries: FolderEntry[]
}

function parseEntries(raw: unknown): FolderEntry[] {
  const file = registryFileSchema.safeParse(raw)
  if (!file.success) {
    return []
  }
  return file.data.folders.flatMap((item) => {
    const entry = folderEntrySchema.safeParse(item)
    return entry.success ? [entry.data] : []
  })
}

/** A missing, unreadable, or corrupt registry file is an empty registry; loading never throws. */
function loadEntries(fs: RegistryFs, file: string): FolderEntry[] {
  try {
    return parseEntries(JSON.parse(fs.readFile(file)))
  } catch {
    return []
  }
}

function saveEntries(context: RegistryContext, entries: readonly FolderEntry[]): void {
  const { fs, file } = context
  const temp = `${file}.tmp`
  const data = `${JSON.stringify({ version: FILE_VERSION, folders: entries }, null, 2)}\n`
  fs.mkdirp(dirname(file))
  fs.writeFile(temp, data)
  fs.rename(temp, file)
}

/** Persists first and only then updates memory, so a failed write leaves both unchanged. */
function commit(context: RegistryContext, state: RegistryState, next: FolderEntry[]): void {
  saveEntries(context, next)
  state.entries = next
}

function abbreviateHome(path: string, homeDir: string): string {
  if (homeDir === '') {
    return path
  }
  const home = homeDir.endsWith(sep) ? homeDir.slice(0, -1) : homeDir
  if (path === home) {
    return '~'
  }
  return path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path
}

function toView(context: RegistryContext, entry: FolderEntry): TrackedFolderView {
  const { fs, homeDir } = context
  return {
    path: entry.path,
    name: basename(entry.path) || entry.path,
    displayPath: abbreviateHome(entry.path, homeDir),
    initialized: fs.exists(resolveLayout(entry.path).projectFile),
    available: fs.isDirectory(entry.path),
    addedAt: entry.addedAt
  }
}

function canonicalPath(fs: RegistryFs, path: string): string | null {
  try {
    return fs.realpath(path)
  } catch {
    return null
  }
}

/**
 * Finds the entry for `path`: an exact match on a stored path first (so a folder that was deleted
 * can still be untracked), then the canonical form of an absolute path.
 */
function findEntry(fs: RegistryFs, entries: readonly FolderEntry[], path: string): FolderEntry | undefined {
  const exact = entries.find((entry) => entry.path === path)
  if (exact !== undefined) {
    return exact
  }
  const canonical = isAbsolute(path) ? canonicalPath(fs, path) : null
  return canonical === null ? undefined : entries.find((entry) => entry.path === canonical)
}

function requireDirectory(fs: RegistryFs, path: string): string {
  if (!isAbsolute(path)) {
    throw new DomainError('invalid_input', `Folder path must be absolute: ${path}`)
  }
  const canonical = canonicalPath(fs, path)
  if (canonical === null) {
    throw new DomainError('not_found', `Folder not found: ${path}`)
  }
  if (!fs.isDirectory(canonical)) {
    throw new DomainError('invalid_input', `Not a folder: ${path}`)
  }
  return canonical
}

function trackFolder(
  context: RegistryContext,
  state: RegistryState,
  path: string
): { folder: TrackedFolderView; added: boolean } {
  const existing = findEntry(context.fs, state.entries, path)
  if (existing !== undefined) {
    return { folder: toView(context, existing), added: false }
  }
  const entry = { path: requireDirectory(context.fs, path), addedAt: context.now() }
  commit(context, state, [...state.entries, entry])
  return { folder: toView(context, entry), added: true }
}

function untrackFolder(context: RegistryContext, state: RegistryState, path: string): TrackedFolderView[] {
  const target = findEntry(context.fs, state.entries, path)
  if (target !== undefined) {
    commit(
      context,
      state,
      state.entries.filter((entry) => entry !== target)
    )
  }
  return state.entries.map((entry) => toView(context, entry))
}

export function createFolderRegistry(options: {
  /** Absolute path of the registry JSON file. */
  file: string
  /** Home directory, abbreviated as `~` in display paths. */
  homeDir: string
  fs?: RegistryFs
  /** ISO timestamp source for `addedAt`. */
  now?: () => string
}): FolderRegistry {
  const context: RegistryContext = {
    file: options.file,
    homeDir: options.homeDir,
    fs: options.fs ?? nodeRegistryFs,
    now: options.now ?? (() => new Date().toISOString())
  }
  const state: RegistryState = { entries: loadEntries(context.fs, context.file) }
  return {
    list: () => state.entries.map((entry) => toView(context, entry)),
    track: (path) => trackFolder(context, state, path),
    untrack: (path) => untrackFolder(context, state, path),
    has: (path) => findEntry(context.fs, state.entries, path) !== undefined,
    resolve: (path) => findEntry(context.fs, state.entries, path)?.path ?? null
  }
}
