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

function createLayout(deps: InitDeps): void {
  const { layout, fs } = deps
  if (fs.isSymlink(layout.dmDir)) {
    fail('unsafe_path', '.darkmechanicus must be a real directory, not a link.', { path: '.darkmechanicus' })
  }
  fs.mkdirp(layout.dmDir)
  for (const dir of [layout.epicsDir, layout.historyDir, layout.profilesDir, layout.localDir]) {
    assertContained(layout, fs, dir)
    fs.mkdirp(dir)
  }
}

function createProject(deps: InitDeps, input: { name?: string; keyPrefix?: string }): ProjectRecord {
  const name = input.name ?? (basename(deps.layout.root).slice(0, MAX_NAME_LENGTH) || 'Project')
  const record = projectRecord.parse({
    format: 'darkmechanicus.project',
    formatVersion: 1,
    projectId: deps.ids.next('project'),
    name,
    keyPrefix: input.keyPrefix ?? deriveKeyPrefix(name),
    createdAt: deps.clock.nowIso()
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
 * Explicit, repeatable initialization: creates the `.darkmechanicus/` layout, `.gitignore`
 * (`local/`), `project.json`, and `local/machine.json` when missing. An existing project is never
 * changed. Never runs git.
 */
export function initializeRepository(
  deps: InitDeps,
  input: { name?: string; keyPrefix?: string }
): InitializeResultView & { machineId: string } {
  const requested = { name: requestedName(input), keyPrefix: requestedPrefix(input) }
  createLayout(deps)
  const createdFiles: string[] = []
  if (writeIfMissing(deps, deps.layout.gitignoreFile, GITIGNORE)) {
    createdFiles.push(displayPath(deps.layout, deps.layout.gitignoreFile))
  }
  const existing = readProject(deps.layout, deps.fs)
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
