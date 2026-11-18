/**
 * The Dark Mechanicus source checkout of this machine (`userData/source-checkout.json`): the Git clone of Dark
 * Mechanicus itself that the person chose as the destination for corrective work aimed at Dark Mechanicus
 * (`src/shared/desktop/sourceCheckout.ts`). The file keeps the portable target (the checkout's project identity) and
 * the machine-local path apart; only the target may ever reach a cross-repository record.
 *
 * A folder qualifies only when it is a tracked folder (folder registry canonicalization: a link, a trailing separator
 * or a `..` detour selects the same canonical path, so every alias gives one target), a Git checkout whose
 * `package.json` names the `dark-mechanicus` package and which holds its actual source files, and a set-up project
 * with a valid `project.json`. A matching folder name, an installed or built copy of the app, or an unrelated
 * repository never does. The association is revalidated on every read and by `requireAvailable` right before anything
 * writes there: a path that is gone, now leads elsewhere (a link or junction changed), is no longer tracked, or holds
 * another project is unavailable, with a recovery step. Nothing here clones, searches or redirects.
 */
import { dirname, isAbsolute, join, sep } from 'node:path'
import { z } from 'zod'
import { DomainError } from '../../core/errors'
import { isStableId } from '../../core/ids'
import { resolveLayout } from '../../core/repo/layout'
import { projectRecord } from '../../core/repo/portable'
import type { DomainErrorCode } from '../../shared/domain/errors'
import type {
  SourceCheckoutChoice,
  SourceCheckoutProblem,
  SourceCheckoutTarget,
  SourceCheckoutView
} from '../../shared/desktop/sourceCheckout'
import { abbreviateHome, canonicalPath, nodeRegistryFs, type FolderRegistry, type RegistryFs } from './folderRegistry'

const FILE_VERSION = 1
/** Windows long-path maximum, as for every folder path. */
const MAX_PATH_LENGTH = 32_767

/** The npm package name of the Dark Mechanicus source (`package.json` `name`). */
const SOURCE_PACKAGE_NAME = 'dark-mechanicus'
/** Source files every Dark Mechanicus checkout has; an installed or built copy has none of them. */
const SOURCE_FILES: readonly (readonly string[])[] = [
  ['src', 'core', 'workspace.ts'],
  ['src', 'main', 'index.ts'],
  ['src', 'preload', 'index.ts'],
  ['src', 'mcp', 'server.ts'],
  ['electron.vite.config.ts']
]
/** What an installed app folder holds: the packed app on Windows/Linux (`resources/`) and inside a macOS bundle. */
const INSTALLED_APP_FILES: readonly (readonly string[])[] = [
  ['resources', 'app.asar'],
  ['Contents', 'Resources', 'app.asar'],
  ['app.asar']
]

const RECHOOSE = 'Choose the Dark Mechanicus checkout again; nothing is written to it until it checks out.'
const CHOOSE_FIRST = 'Choose your Dark Mechanicus checkout (a Git clone of Dark Mechanicus on this machine).'
const CLONE_IT = 'Clone the Dark Mechanicus repository with Git yourself, then choose that clone.'

const targetSchema = z.strictObject({
  kind: z.literal('darkmechanicus_source'),
  projectId: z.string().refine((value) => isStableId(value, 'project')),
  projectName: z.string().min(1).max(200)
})

const associationSchema = z.strictObject({
  target: targetSchema,
  local: z.strictObject({
    path: z.string().min(1).max(MAX_PATH_LENGTH).refine((value) => isAbsolute(value)),
    associatedAt: z.iso.datetime({ offset: true })
  })
})

/** A missing, unreadable or corrupt file is no association, as for the folder registry. */
const fileSchema = z.strictObject({ version: z.literal(FILE_VERSION), checkout: associationSchema.nullable() })

type Association = z.infer<typeof associationSchema>

type Refusal = Extract<SourceCheckoutChoice, { outcome: 'refused' }>

/** What a folder is, read fresh. */
type Inspection = Refusal | { outcome: 'needs_initialization'; message: string; recovery: string } | { outcome: 'source'; target: SourceCheckoutTarget }

type Available = { ok: true; target: SourceCheckoutTarget; path: string }

/** The domain error code `requireAvailable` fails with, per problem. */
const PROBLEM_CODES: Record<SourceCheckoutProblem, DomainErrorCode> = {
  missing: 'not_found',
  renamed: 'invalid_state',
  relocated: 'project_mismatch',
  untracked: 'unauthorized',
  installed_app: 'invalid_state',
  not_dm_source: 'invalid_state',
  not_initialized: 'not_initialized',
  unreadable_project: 'invalid_state',
  project_mismatch: 'project_mismatch'
}

export interface SourceCheckouts {
  /** The association, revalidated now. */
  view(): SourceCheckoutView
  /**
   * Why the folder at `path` (any alias; canonicalized here) cannot be the checkout as it is now: gone, an installed
   * app, not the Dark Mechanicus source, or a `project.json` that is not a project record. Null when it is the source
   * (set up or not). Reads only: a folder dialog choice is screened in full before it is tracked.
   */
  screen(path: string): Refusal | null
  /**
   * Associates the tracked folder `path` (canonical) after revalidating it; `added` says whether choosing it also
   * tracked it. A folder that is the source but not set up is reported, not associated.
   */
  associate(path: string, added: boolean): SourceCheckoutChoice
  /** Forgets the association (never the folder or its data). */
  clear(): SourceCheckoutView
  /**
   * The gate before anything is written to the checkout: revalidates the association and returns its canonical
   * path and portable target, or throws a DomainError naming the problem and its recovery.
   */
  requireAvailable(): { path: string; target: SourceCheckoutTarget }
}

interface Env {
  file: string
  homeDir: string
  dmHome: string
  fs: RegistryFs
  registry: Pick<FolderRegistry, 'resolve' | 'storageMode' | 'list'>
  installedAppDirs: () => readonly string[]
  now: () => string
}

function refused(problem: SourceCheckoutProblem, message: string, recovery: string): Refusal {
  return { outcome: 'refused', problem, message, recovery }
}

function missing(path: string): Refusal {
  return refused(
    'missing',
    `No folder exists at ${path}. Dark Mechanicus never looks for a moved checkout or clones one.`,
    `If you moved or renamed the checkout, choose it at its new place. Otherwise: ${CLONE_IT}`
  )
}

/** The running app's own folders (or a folder inside them), or a folder laid out like an installed app. */
function isInstalledApp(env: Env, path: string): boolean {
  const own = env.installedAppDirs().flatMap((dir) => canonicalPath(env.fs, dir) ?? [])
  const inside = own.some((dir) => path === dir || path.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`))
  return inside || INSTALLED_APP_FILES.some((parts) => env.fs.exists(join(path, ...parts)))
}

const packageSchema = z.object({ name: z.string() })

function packageName(fs: RegistryFs, path: string): string | null {
  try {
    const parsed = packageSchema.safeParse(JSON.parse(fs.readFile(join(path, 'package.json'))))
    return parsed.success ? parsed.data.name : null
  } catch {
    return null
  }
}

function screenFolder(env: Env, path: string): Refusal | null {
  const { fs } = env
  if (!fs.isDirectory(path)) {
    return missing(path)
  }
  const installed = refused('installed_app', `${path} is an installed or built copy of Dark Mechanicus, not its source.`, CLONE_IT)
  if (isInstalledApp(env, path)) {
    return installed
  }
  const named = packageName(fs, path) === SOURCE_PACKAGE_NAME
  const sources = SOURCE_FILES.every((parts) => fs.exists(join(path, ...parts)))
  const checkout = fs.exists(join(path, '.git'))
  if (named && !sources && !checkout) {
    // The package without its source and outside Git: an unpacked app folder or a build output.
    return installed
  }
  const lacking = !named
    ? `it has no package.json naming the ${SOURCE_PACKAGE_NAME} package`
    : !sources
      ? 'the Dark Mechanicus source files are missing'
      : !checkout
        ? 'it is not a Git checkout'
        : null
  return lacking === null ? null : refused('not_dm_source', `${path} is not a checkout of the Dark Mechanicus source: ${lacking}.`, CLONE_IT)
}

function invalidProject(projectFile: string): Refusal {
  return refused(
    'unreadable_project',
    `${projectFile} is not a valid Dark Mechanicus project record.`,
    'Restore the file from Git (or repair it), then choose the checkout again.'
  )
}

/** What a folder is, read fresh: `screenFolder`, then the project identity of a folder that passed it. */
function inspect(env: Env, path: string): Inspection {
  const refusal = screenFolder(env, path)
  if (refusal !== null) {
    return refusal
  }
  const layout = resolveLayout(path, { mode: env.registry.storageMode(path), homeDir: env.dmHome })
  if (!env.fs.exists(layout.projectFile)) {
    return {
      outcome: 'needs_initialization',
      message: `${path} is the Dark Mechanicus source but has no Dark Mechanicus project record.`,
      recovery: 'Set the folder up in Dark Mechanicus (it is in your folder list), then choose it again.'
    }
  }
  let raw: unknown
  try {
    raw = JSON.parse(env.fs.readFile(layout.projectFile))
  } catch {
    return invalidProject(layout.projectFile)
  }
  const project = projectRecord.safeParse(raw)
  if (!project.success) {
    return invalidProject(layout.projectFile)
  }
  return { outcome: 'source', target: { kind: 'darkmechanicus_source', projectId: project.data.projectId, projectName: project.data.name } }
}

function load(env: Env): Association | null {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(env.fs.readFile(env.file)))
    return parsed.success ? parsed.data.checkout : null
  } catch {
    return null
  }
}

/** Written whole, then renamed into place: a crash never leaves half a file. */
function save(env: Env, checkout: Association | null): void {
  const { fs, file } = env
  if (checkout === null && !fs.exists(file)) {
    return
  }
  const temp = `${file}.tmp`
  fs.mkdirp(dirname(file))
  fs.writeFile(temp, `${JSON.stringify({ version: FILE_VERSION, checkout }, null, 2)}\n`)
  fs.rename(temp, file)
}

/**
 * The stored path now resolves to `canonical`: the same folder renamed by letter case only (a case-insensitive file
 * system), or another folder (a link or junction on the way changed).
 */
function moved(path: string, canonical: string): Refusal {
  if (canonical.toLowerCase() === path.toLowerCase()) {
    return refused('renamed', `${path} is now named ${canonical}: only the letter case changed.`, `Choose the checkout again at ${canonical}; nothing is written to it until it checks out.`)
  }
  return refused('relocated', `${path} now leads to ${canonical}: a link or junction on the way changed.`, RECHOOSE)
}

/** Everything about a stored association that can have changed since it was made, checked in that order. */
function revalidate(env: Env, checkout: Association): Available | Refusal {
  const { path } = checkout.local
  const canonical = canonicalPath(env.fs, path)
  if (canonical === null) {
    return missing(path)
  }
  if (canonical !== path) {
    return moved(path, canonical)
  }
  if (env.registry.resolve(path) !== path) {
    return refused('untracked', `${path} is no longer tracked by Dark Mechanicus.`, RECHOOSE)
  }
  const inspection = inspect(env, path)
  if (inspection.outcome === 'needs_initialization') {
    return refused('not_initialized', inspection.message, inspection.recovery)
  }
  if (inspection.outcome === 'refused') {
    return inspection
  }
  const expected = checkout.target.projectId
  if (inspection.target.projectId !== expected) {
    return refused('project_mismatch', `${path} now holds project ${inspection.target.projectId}, not the associated ${expected}.`, RECHOOSE)
  }
  return { ok: true, target: inspection.target, path }
}

function viewOf(env: Env, checkout: Association | null): SourceCheckoutView {
  if (checkout === null) {
    return { status: 'none', target: null, local: null, problem: null, message: null, recovery: CHOOSE_FIRST }
  }
  const local = { path: checkout.local.path, displayPath: abbreviateHome(checkout.local.path, env.homeDir), associatedAt: checkout.local.associatedAt }
  const check = revalidate(env, checkout)
  if ('ok' in check) {
    return { status: 'available', target: check.target, local, problem: null, message: null, recovery: null }
  }
  return { status: 'unavailable', target: checkout.target, local, problem: check.problem, message: check.message, recovery: check.recovery }
}

function associate(env: Env, path: string, added: boolean): SourceCheckoutChoice {
  const canonical = canonicalPath(env.fs, path)
  if (canonical === null) {
    return missing(path)
  }
  if (canonical !== path) {
    return moved(path, canonical)
  }
  const folder = env.registry.list().find((entry) => entry.path === path)
  if (folder === undefined) {
    return refused('untracked', `${path} is not tracked by Dark Mechanicus.`, RECHOOSE)
  }
  const inspection = inspect(env, path)
  if (inspection.outcome === 'refused') {
    return inspection
  }
  if (inspection.outcome === 'needs_initialization') {
    return { ...inspection, folder, added }
  }
  const stored = load(env)
  const same = stored !== null && stored.local.path === path && stored.target.projectId === inspection.target.projectId
  const checkout: Association = { target: inspection.target, local: { path, associatedAt: same ? stored.local.associatedAt : env.now() } }
  // Choosing the associated folder again (through any alias) writes nothing unless its project record was renamed.
  if (JSON.stringify(checkout) !== JSON.stringify(stored)) {
    save(env, checkout)
  }
  return { outcome: 'associated', checkout: viewOf(env, checkout), folder, added }
}

function requireAvailable(env: Env): { path: string; target: SourceCheckoutTarget } {
  const checkout = load(env)
  if (checkout === null) {
    throw new DomainError('not_found', 'No Dark Mechanicus checkout is chosen on this machine.', { recovery: CHOOSE_FIRST })
  }
  const check = revalidate(env, checkout)
  if ('ok' in check) {
    return { path: check.path, target: check.target }
  }
  throw new DomainError(PROBLEM_CODES[check.problem], check.message, {
    problem: check.problem,
    path: checkout.local.path,
    recovery: check.recovery
  })
}

export function createSourceCheckouts(options: {
  /** Absolute path of the association file. */
  file: string
  /** Home directory, abbreviated as `~` in display paths. */
  homeDir: string
  /** Dark Mechanicus home directory holding database-only projects (`resolveHomeDir`). */
  dmHome: string
  registry: Pick<FolderRegistry, 'resolve' | 'storageMode' | 'list'>
  /** The installed app's own folders (empty in development, where the app runs from a checkout). */
  installedAppDirs: () => readonly string[]
  fs?: RegistryFs
  now?: () => string
}): SourceCheckouts {
  const env: Env = {
    file: options.file,
    homeDir: options.homeDir,
    dmHome: options.dmHome,
    fs: options.fs ?? nodeRegistryFs,
    registry: options.registry,
    installedAppDirs: options.installedAppDirs,
    now: options.now ?? (() => new Date().toISOString())
  }
  return {
    view: () => viewOf(env, load(env)),
    screen: (path) => {
      const canonical = canonicalPath(env.fs, path)
      if (canonical === null) return missing(path)
      const inspection = inspect(env, canonical)
      return inspection.outcome === 'refused' ? inspection : null
    },
    associate: (path, added) => associate(env, path, added),
    clear: () => {
      save(env, null)
      return viewOf(env, null)
    },
    requireAvailable: () => requireAvailable(env)
  }
}
