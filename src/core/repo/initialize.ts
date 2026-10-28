import { basename } from 'node:path'
import { z } from 'zod'
import type { InitializeResultView } from '../../shared/domain/views'
import { prettyJson } from '../canonical'
import type { Clock } from '../clock'
import { fail } from '../errors'
import { type IdGenerator, isStableId } from '../ids'
import { writeFileSafely } from './finalizer'
import { assertContained, displayPath } from './paths'
import { KEY_PREFIX_PATTERN, type ProjectRecord, projectRecord, readOwnedRecord } from './portable'
import type { FsAdapter, RepoLayout } from './types'

interface InitDeps {
  layout: RepoLayout
  fs: FsAdapter
  ids: IdGenerator
  clock: Clock
  /**
   * The project file this folder would have in the *other* storage mode. When it exists, the
   * folder is already set up that way and initializing is refused rather than leaving one folder
   * with two projects. Omitted when the caller has not resolved the other mode.
   */
  otherProjectFile?: string
}

const GITIGNORE = 'local/\n'
const MAX_NAME_LENGTH = 200
const FALLBACK_PREFIX = 'DM'

const machineRecord = z.strictObject({
  machineId: z.string().refine((value) => isStableId(value, 'machine'), { message: 'Expected a machine id' }),
  createdAt: z.iso.datetime({ offset: true })
})

/** Words split on non-alphanumerics and camelCase / acronym boundaries (`XMLParser` → XML, Parser). */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== '')
}

/**
 * Ticket key prefix from a project name: initials of up to four words, or the first three letters
 * of a single word; `DM` when that is not a valid prefix (e.g. it starts with a digit).
 */
export function deriveKeyPrefix(name: string): string {
  const words = wordsOf(name)
  const candidate =
    words.length >= 2
      ? words
          .slice(0, 4)
          .map((word) => word.charAt(0))
          .join('')
      : (words[0] ?? '').slice(0, 3)
  const prefix = candidate.toUpperCase()
  return KEY_PREFIX_PATTERN.test(prefix) ? prefix : FALLBACK_PREFIX
}

/** The validated `project.json`, or null when the repository is not initialized. */
export function readProject(layout: RepoLayout, fs: FsAdapter): ProjectRecord | null {
  if (!fs.exists(layout.projectFile)) {
    return null
  }
  return readOwnedRecord({ layout, fs }, projectRecord, layout.projectFile)
}

function requestedName(input: { name?: string }): string | undefined {
  const name = input.name?.trim()
  if (name !== undefined && name.length > MAX_NAME_LENGTH) {
    fail('invalid_input', `Project name must be at most ${MAX_NAME_LENGTH} characters.`)
  }
  return name === '' ? undefined : name
}

function requestedPrefix(input: { keyPrefix?: string }): string | undefined {
  if (input.keyPrefix !== undefined && !KEY_PREFIX_PATTERN.test(input.keyPrefix)) {
    fail('invalid_input', 'Key prefix must be 1-12 uppercase letters or digits, starting with a letter.')
  }
  return input.keyPrefix
}

function writeIfMissing(deps: InitDeps, path: string, text: string): boolean {
  assertContained(deps.layout, deps.fs, path)
  if (deps.fs.exists(path)) {
    return false
  }
  writeFileSafely(deps, path, text)
  return true
}

/** The directories a mode actually writes: `db` mode never writes a record file, so it makes none. */
function ownedDirs(layout: RepoLayout): string[] {
  if (layout.mode === 'db') {
    return [layout.localDir]
  }
  return [layout.epicsDir, layout.historyDir, layout.profilesDir, layout.localDir]
}

function createLayout(deps: InitDeps): void {
  const { layout, fs } = deps
  if (fs.isSymlink(layout.dmDir)) {
    const shown = layout.mode === 'repo' ? '.darkmechanicus' : layout.dmDir
    fail('unsafe_path', `${shown} must be a real directory, not a link.`, { path: shown })
  }
  fs.mkdirp(layout.dmDir)
  for (const dir of ownedDirs(layout)) {
    assertContained(layout, fs, dir)
    fs.mkdirp(dir)
  }
}

/** The modes, as a person reads them in a refusal. */
const MODE_LABELS: Record<RepoLayout['mode'], string> = {
  repo: 'with its records in the repository',
  db: 'as a database-only project in the Dark Mechanicus home directory'
}

/**
 * Refuses a second project for a folder that is already set up the other way. One folder has one
 * project: the modes differ in where every record lives, so two would be two separate histories.
 */
function assertSingleProject(deps: InitDeps): void {
  const other = deps.otherProjectFile
  if (other === undefined || !deps.fs.exists(other)) {
    return
  }
  const otherMode = deps.layout.mode === 'repo' ? 'db' : 'repo'
  fail(
    'conflict',
    `${deps.layout.root} is already set up ${MODE_LABELS[otherMode]} (${other}). A folder has one project: use that one, or remove it before setting the folder up ${MODE_LABELS[deps.layout.mode]}.`,
    { path: other, mode: deps.layout.mode, existingMode: otherMode }
  )
}

function createProject(deps: InitDeps, input: { name?: string; keyPrefix?: string }): ProjectRecord {
  // The name always comes from the repository folder, never from the project directory in db mode.
  const name = input.name ?? (basename(deps.layout.root).slice(0, MAX_NAME_LENGTH) || 'Project')
  const record = projectRecord.parse({
    format: 'darkmechanicus.project',
    formatVersion: 1,
    projectId: deps.ids.next('project'),
    name,
    keyPrefix: input.keyPrefix ?? deriveKeyPrefix(name),
    createdAt: deps.clock.nowIso(),
    // A repo project sits inside its folder and needs no note of where that is.
    ...(deps.layout.mode === 'db' ? { repoRoot: deps.layout.root } : {})
  })
  writeFileSafely(deps, deps.layout.projectFile, prettyJson(record))
  return record
}

function readOrCreateMachine(deps: InitDeps): { machineId: string; created: boolean } {
  const { layout, fs } = deps
  assertContained(layout, fs, layout.localDir)
  fs.mkdirp(layout.localDir)
  const existing = readOwnedRecord({ layout, fs }, machineRecord, layout.machineFile)
  if (existing !== null) {
    return { machineId: existing.machineId, created: false }
  }
  const record = { machineId: deps.ids.next('machine'), createdAt: deps.clock.nowIso() }
  writeFileSafely(deps, layout.machineFile, prettyJson(record))
  return { machineId: record.machineId, created: true }
}

/** This machine's stable id from `local/machine.json`, created on first use (e.g. in a fresh clone). */
export function ensureMachineId(deps: InitDeps): string {
  return readOrCreateMachine(deps).machineId
}

/**
 * Explicit, repeatable initialization: creates the owned layout, `project.json` and
 * `local/machine.json` when missing, plus `.gitignore` (`local/`) in `repo` mode, where the layout
 * sits in the repository. In `db` mode everything is created in the project's directory inside the
 * Dark Mechanicus home directory and the repository folder is left untouched. An existing project
 * is never changed. Never runs git.
 */
export function initializeRepository(
  deps: InitDeps,
  input: { name?: string; keyPrefix?: string }
): Omit<InitializeResultView, 'storage'> & { machineId: string } {
  const requested = { name: requestedName(input), keyPrefix: requestedPrefix(input) }
  // Checked before anything is created, so a refusal leaves no trace...
  assertSingleProject(deps)
  createLayout(deps)
  const createdFiles: string[] = []
  // `db` mode writes nothing into the repository, so it has nothing for Git to ignore.
  if (deps.layout.mode === 'repo' && writeIfMissing(deps, deps.layout.gitignoreFile, GITIGNORE)) {
    createdFiles.push(displayPath(deps.layout, deps.layout.gitignoreFile))
  }
  const existing = readProject(deps.layout, deps.fs)
  // ...and again right before the record is written. The two modes write into different
  // directories, so there is no atomic way to claim both at once; re-checking here narrows the
  // window in which two processes could each create one to almost nothing.
  if (existing === null) {
    assertSingleProject(deps)
  }
  const project = existing ?? createProject(deps, requested)
  if (existing === null) {
    createdFiles.push(displayPath(deps.layout, deps.layout.projectFile))
  }
  const machine = readOrCreateMachine(deps)
  if (machine.created) {
    createdFiles.push(displayPath(deps.layout, deps.layout.machineFile))
  }
  return {
    projectId: project.projectId,
    name: project.name,
    keyPrefix: project.keyPrefix,
    createdFiles,
    alreadyInitialized: existing !== null,
    machineId: machine.machineId
  }
}
