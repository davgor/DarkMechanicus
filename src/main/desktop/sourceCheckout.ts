/**
 * The Dark Mechanicus source checkout of this machine (`userData/source-checkout.json`): the Git clone of Dark
 * Mechanicus itself that the person chose as the destination for corrective work aimed at Dark Mechanicus
 * (`src/shared/desktop/sourceCheckout.ts`). The file keeps the portable target (the checkout's project identity) and
 * the machine-local path apart; only the target may ever reach a cross-repository record.
 *
 * The code must be a Git checkout with the Dark Mechanicus package and source files. A standalone checkout has its
 * own tracked project. A Forge-linked checkout uses its verified, tracked member's project record and keeps the code
 * outside the ticket repository. The association is revalidated by every read and before recovery or correction
 * writes. Without an association file, tooling recovery may use a unique tracked Forge project's verified private
 * hint. The chooser and cross-repository corrections still use the explicit association.
 */
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { DomainError } from '../../core/errors'
import { isStableId } from '../../core/ids'
import { resolveLayout } from '../../core/repo/layout'
import { nodeFs } from '../../core/repo/nodeFs'
import { projectRecord } from '../../core/repo/portable'
import type { DomainErrorCode } from '../../shared/domain/errors'
import type {
  SourceCheckoutChoice,
  SourceCheckoutProblem,
  SourceCheckoutTarget,
  SourceCheckoutView
} from '../../shared/desktop/sourceCheckout'
import { abbreviateHome, canonicalPath, nodeRegistryFs, type FolderRegistry, type RegistryFs } from './folderRegistry'
import { forgeSourceMappingSchema, inspectForgeSource, privateForgeSourceHint, type ForgeSourceMapping } from './forgeSourceMapping'

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
    associatedAt: z.iso.datetime({ offset: true }),
    forge: forgeSourceMappingSchema.optional()
  })
})

/** A missing, unreadable or corrupt file is no association, as for the folder registry. */
const fileSchema = z.strictObject({ version: z.literal(FILE_VERSION), checkout: associationSchema.nullable() })

type Association = z.infer<typeof associationSchema>

type Refusal = Extract<SourceCheckoutChoice, { outcome: 'refused' }>

/** What a folder is, read fresh. */
type Inspection = Refusal | { outcome: 'needs_initialization'; message: string; recovery: string } |
  { outcome: 'source'; target: SourceCheckoutTarget; forge?: ForgeSourceMapping }

type SourceLocation = { target: SourceCheckoutTarget; path: string } &
  ({ projectPath?: never; mappingIdentity?: never } | { projectPath: string; mappingIdentity: string })
type Available = { ok: true; location: SourceLocation }

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
  /** One unambiguous, verified machine-local Forge hint, for the native chooser's starting folder. */
  suggestedPath(): string | undefined
  /**
   * Why the folder at `path` (any alias; canonicalized here) cannot be the checkout as it is now: gone, an installed
   * app, not the Dark Mechanicus source, or a `project.json` that is not a project record. Null when it is the source
   * (set up or not). Reads only: a folder dialog choice is screened in full before it is tracked.
   */
  screen(path: string): Refusal | null
  /** Inspect and associate a path explicitly returned by the native chooser. */
  associatePicked(path: string, track: FolderRegistry['track']): SourceCheckoutChoice
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
  requireAvailable(): SourceLocation
  /** Tooling repair may use one already linked and verified Forge checkout when no explicit choice was made. */
  requireRecoveryCheckout(): SourceLocation
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

function inspectProject(env: Env, path: string, forge?: ForgeSourceMapping): Inspection {
  const layout = forge === undefined
    ? resolveLayout(path, { mode: env.registry.storageMode(path), homeDir: env.dmHome })
    : resolveLayout(forge.member)
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
  return { outcome: 'source', target: { kind: 'darkmechanicus_source', projectId: project.data.projectId, projectName: project.data.name },
    ...(forge === undefined ? {} : { forge }) }
}

/** What a folder is, read fresh: its code markers, optional Forge mapping, and the resulting project identity. */
function inspect(env: Env, path: string): Inspection {
  const refusal = screenFolder(env, path)
  if (refusal !== null) return refusal
  let forge: ForgeSourceMapping | undefined
  try {
    forge = inspectForgeSource(path, env.dmHome, env.registry.list)
    if (forge !== undefined && ![['package.json'], ...SOURCE_FILES].every(parts => {
      const file = join(path, ...parts)
      return nodeFs.fileStamp(file) !== null && nodeFs.realpath(file) === file
    })) return refused('not_dm_source', 'The Dark Mechanicus source files must be ordinary files in the code checkout.', CLONE_IT)
  } catch (error) {
    return refused('project_mismatch', error instanceof Error ? error.message : 'Cannot verify the Forge World checkout mapping.', RECHOOSE)
  }
  return inspectProject(env, path, forge)
}

function readAssociation(env: Env): Association | null | undefined {
  try {
    const parsed = fileSchema.safeParse(JSON.parse(env.fs.readFile(env.file)))
    return parsed.success ? parsed.data.checkout : null
  } catch (error: unknown) {
    // Only an absent file permits recovery discovery. Invalid state, a link, and an explicit clear do not.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' && !env.fs.isSymlink(env.file) ? undefined : null
  }
}

function load(env: Env): Association | null {
  return readAssociation(env) ?? null
}

/** Written whole, then renamed into place: a crash never leaves half a file. */
function save(env: Env, checkout: Association | null): void {
  const { fs, file } = env
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
  if (checkout.local.forge === undefined && env.registry.resolve(path) !== path) {
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
  if (JSON.stringify(inspection.forge) !== JSON.stringify(checkout.local.forge)) {
    return refused('project_mismatch', 'The associated Forge World ticket folder or Git origin changed.', RECHOOSE)
  }
  return { ok: true, location: locationFor(path, inspection) }
}

function locationFor(path: string, { target, forge }: Extract<Inspection, { outcome: 'source' }>): SourceLocation {
  return forge === undefined ? { path, target } :
    { path, target, projectPath: forge.member, mappingIdentity: JSON.stringify(forge) }
}

function viewOf(env: Env, checkout: Association | null): SourceCheckoutView {
  if (checkout === null) {
    return { status: 'none', target: null, local: null, problem: null, message: null, recovery: CHOOSE_FIRST }
  }
  const local = { path: checkout.local.path, displayPath: abbreviateHome(checkout.local.path, env.homeDir), associatedAt: checkout.local.associatedAt,
    ...(checkout.local.forge === undefined ? {} : { projectPath: checkout.local.forge.member }) }
  const check = revalidate(env, checkout)
  if ('ok' in check) {
    return { status: 'available', target: check.location.target, local, problem: null, message: null, recovery: null }
  }
  return { status: 'unavailable', target: checkout.target, local, problem: check.problem, message: check.message, recovery: check.recovery }
}

type Selection = { forge?: ForgeSourceMapping; projectId?: string }

function inspectSelection(env: Env, path: string, selected?: Selection): Inspection {
  const inspection = inspect(env, path)
  if (inspection.outcome === 'refused') return inspection
  const current = inspection.outcome === 'source' ? { forge: inspection.forge, projectId: inspection.target.projectId } : {}
  if (selected === undefined && current.forge !== undefined) {
    return refused('untracked', 'Choose the Forge-linked code checkout with the native folder dialog.', RECHOOSE)
  }
  if (selected !== undefined && (JSON.stringify(selected.forge) !== JSON.stringify(current.forge) || current.projectId !== selected.projectId)) {
    return refused('project_mismatch', 'The checkout project or Forge World mapping changed while choosing it.', RECHOOSE)
  }
  return inspection
}

function recordAssociation(env: Env, path: string, { target, forge }: Extract<Inspection, { outcome: 'source' }>): SourceCheckoutView {
  const stored = load(env)
  const same = stored !== null && stored.local.path === path && stored.target.projectId === target.projectId &&
    JSON.stringify(stored.local.forge) === JSON.stringify(forge)
  const checkout: Association = { target, local: { path, associatedAt: same ? stored.local.associatedAt : env.now(),
    ...(forge === undefined ? {} : { forge }) } }
  // Choosing the associated folder again (through any alias) writes nothing unless its project record was renamed.
  if (JSON.stringify(checkout) !== JSON.stringify(stored)) {
    save(env, checkout)
  }
  return viewOf(env, checkout)
}

function associate(env: Env, path: string, added: boolean, selected?: Selection): SourceCheckoutChoice {
  const canonical = canonicalPath(env.fs, path)
  if (canonical === null) return missing(path)
  if (canonical !== path) return moved(path, canonical)
  const inspection = inspectSelection(env, path, selected)
  if (inspection.outcome === 'refused') return inspection
  const forge = inspection.outcome === 'source' ? inspection.forge : undefined
  const folder = env.registry.list().find(entry => entry.path === (forge?.member ?? path))
  if (folder === undefined) return refused('untracked', `${path} is not tracked by Dark Mechanicus.`, RECHOOSE)
  if (inspection.outcome === 'needs_initialization') return { ...inspection, folder, added }
  return { outcome: 'associated', checkout: recordAssociation(env, path, inspection), folder, added: forge === undefined && added }
}

function requireAvailable(env: Env, checkout = load(env)): SourceLocation {
  if (checkout === null) {
    throw new DomainError('not_found', 'No Dark Mechanicus checkout is chosen on this machine.', { recovery: CHOOSE_FIRST })
  }
  const check = revalidate(env, checkout)
  if ('ok' in check) {
    return check.location
  }
  throw new DomainError(PROBLEM_CODES[check.problem], check.message, {
    problem: check.problem,
    path: checkout.local.path,
    recovery: check.recovery
  })
}

function verifiedHint(env: Env, folder: ReturnType<Env['registry']['list']>[number]): SourceLocation | undefined {
  if (!folder.forgeParent || !folder.initialized || !folder.available) return undefined
  try {
    const hint = privateForgeSourceHint(folder.path)
    if (hint === undefined) return undefined
    const checked = inspect(env, hint)
    return checked.outcome === 'source' && checked.forge?.member === folder.path ? locationFor(hint, checked) : undefined
  } catch {
    // Unverified hints cannot choose or suggest a location.
    return undefined
  }
}

function suggestedPath(env: Env): string | undefined {
  const candidates = new Set(env.registry.list().flatMap(folder => verifiedHint(env, folder)?.path ?? []))
  return candidates.size === 1 ? candidates.values().next().value : undefined
}

function requireRecoveryCheckout(env: Env): SourceLocation {
  const explicit = readAssociation(env)
  if (explicit !== undefined) return requireAvailable(env, explicit)
  const candidates = env.registry.list().flatMap(folder => verifiedHint(env, folder) ?? [])
  const current = readAssociation(env)
  if (current !== undefined) return requireAvailable(env, current)
  if (candidates.length === 1) return candidates[0]
  if (candidates.length > 1) {
    throw new DomainError('conflict', 'More than one linked Dark Mechanicus checkout is available for tooling recovery.', { recovery: CHOOSE_FIRST })
  }
  return requireAvailable(env, null)
}

type Screened = Selection & { canonical: string }

function ticketFolderRefusal(env: Env, path: string): Refusal | null {
  const member = env.registry.list().find(folder => folder.path === path && folder.forgeParent !== undefined)
  if (member === undefined) return null
  const hint = verifiedHint(env, member)?.path
  const recovery = hint === undefined
    ? 'Choose your existing Dark Mechanicus code checkout outside the Forge World. Clone the repository only if you do not have it locally.'
    : `Choose the linked Dark Mechanicus code checkout at ${abbreviateHome(hint, env.homeDir)}.`
  return refused('not_dm_source', `${path} is a Forge World ticket folder.`, recovery)
}

function screen(env: Env, path: string): Refusal | Screened {
  const canonical = canonicalPath(env.fs, path)
  if (canonical === null) return missing(path)
  const member = ticketFolderRefusal(env, canonical)
  if (member !== null) return member
  const inspection = inspect(env, canonical)
  if (inspection.outcome === 'refused') return inspection
  if (inspection.outcome !== 'source') return { canonical }
  if (inspection.forge !== undefined && canonical !== resolve(path)) return moved(path, canonical)
  return { canonical, ...(inspection.forge === undefined ? {} : { forge: inspection.forge }), projectId: inspection.target.projectId }
}

function associatePicked(env: Env, path: string, track: FolderRegistry['track']): SourceCheckoutChoice {
  const checked = screen(env, path)
  if ('outcome' in checked) return checked
  if (checked.forge !== undefined) return associate(env, checked.canonical, false, checked)
  const { folder, added } = track(path)
  const choice = folder.path === checked.canonical
    ? associate(env, folder.path, added, checked)
    : moved(checked.canonical, folder.path)
  return choice.outcome === 'refused' && added ? { ...choice, folder, added } : choice
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
    suggestedPath: () => suggestedPath(env),
    screen: (path) => { const result = screen(env, path); return 'outcome' in result ? result : null },
    associatePicked: (path, track) => associatePicked(env, path, track),
    associate: (path, added) => associate(env, path, added),
    clear: () => {
      save(env, null)
      return viewOf(env, null)
    },
    requireAvailable: () => requireAvailable(env),
    requireRecoveryCheckout: () => requireRecoveryCheckout(env)
  }
}
