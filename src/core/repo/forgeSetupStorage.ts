import { createHash, randomUUID } from 'node:crypto'
import {
  type BigIntStats, closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync,
  renameSync, unlinkSync, writeFileSync
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  FORGE_RECIPEBOOK_FILE, FORGE_SETUP_DIRECTORY, FORGE_SETUP_GUIDE_FILE, FORGE_SETUP_WORKFLOW_FILE,
  type ForgeRecipebook, type ForgeSetupDetection, type ForgeSetupFile, type ForgeSetupProjectView,
  type ForgeSetupStep, type ForgeSetupWorkflow, type ForgeSetupWorkflowEdit
} from '../../shared/desktop/forgeSetup'
import { fail } from '../errors'
import { githubRemote } from './forgeManifest'
import {
  encodeForgeRecipebook, encodeForgeSetupWorkflow, FORGE_RECIPEBOOK_BYTES, FORGE_WORKFLOW_BYTES,
  parseForgeRecipebook, parseForgeSetupWorkflow, updateForgeSetupEvidence
} from './forgeSetupFormat'
import { layoutUnder, resolveLayout } from './layout'
import { nodeFs } from './nodeFs'
import { assertContained } from './paths'
import type { RepoLayout } from './types'

const guideText = [
  '---',
  'id: forge.setup.workflow',
  'type: procedure',
  'title: Prepare this repository',
  'scope.roles: [planner, worker, orchestrator, reviewer]',
  'scope.topics: [setup]',
  '---',
  '',
  'The portable setup requirements and ordered workflow live beside this guide in ' + FORGE_SETUP_WORKFLOW_FILE + '.',
  'Use that workflow when preparing a checkout. A configured workflow records agreed steps.',
  'Confirm the steps and their results on each machine before reporting that its environment is ready.',
  ''
].join('\n')

type Target = string | RepoLayout

interface FilePath {
  layout: RepoLayout
  path: string
  limit: number
  pendingDirectory: string
}

interface TextFile {
  text: string
  sha256: string
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code
}

function fingerprint(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function protectedPath(file: FilePath, path = file.path): void {
  if (nodeFs.realpath(file.layout.root) !== resolve(file.layout.root)) fail('unsafe_path', 'Unsafe Forge setup checkout.')
  assertContained(file.layout, nodeFs, path)
  // A hardlink is also an alias to a file the caller might not own.
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (info && (!info.isFile() || info.nlink !== 1)) fail('unsafe_path', 'Unsafe Forge setup file.')
}

function readBytes(fd: number, size: number): Buffer {
  const bytes = Buffer.alloc(size)
  let received = 0
  while (received < bytes.length) {
    const count = readSync(fd, bytes, received, bytes.length - received, null)
    if (!count) fail('conflict', 'Forge setup file changed while reading.')
    received += count
  }
  return bytes
}

function verifyRead(file: FilePath, before: BigIntStats): void {
  protectedPath(file)
  const after = lstatSync(file.path, { bigint: true, throwIfNoEntry: false })
  if (!after || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) fail('conflict', 'Forge setup file changed while reading.')
}

function boundedRead(file: FilePath): TextFile | null {
  protectedPath(file)
  let fd: number
  try {
    fd = openSync(file.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
  try {
    const before = fstatSync(fd, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n) fail('unsafe_path', 'Unsafe Forge setup file.')
    if (before.size > file.limit) fail('response_too_large', 'Forge setup file exceeds the size limit.')
    const bytes = readBytes(fd, Number(before.size))
    verifyRead(file, before)
    let text: string
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch {
      fail('invalid_input', 'Forge setup files must contain UTF-8 text.')
    }
    return { text, sha256: fingerprint(bytes) }
  } finally { closeSync(fd) }
}

function assertRevision(current: { sha256: string } | null, expected: string | null): void {
  if ((current?.sha256 ?? null) !== expected) fail('conflict', 'Forge setup file changed. Reload it before saving.')
}

function isOwnedTemporary(path: string, own: BigIntStats): boolean {
  const actual = lstatSync(path, { bigint: true, throwIfNoEntry: false })
  return actual?.isFile() === true && actual.ino === own.ino && actual.dev === own.dev
}

function discardTemporary(file: FilePath, path: string, own: BigIntStats): void {
  try {
    protectedPath(file, path)
    if (isOwnedTemporary(path, own)) unlinkSync(path)
  } catch {
    // Preserve the write error. A leftover private temporary file cannot block a future write.
  }
}

/** The desktop serializes writes. Check the prior bytes again immediately before atomic replacement. */
function replaceText(file: FilePath, expected: string | null, text: string): TextFile {
  const sha256 = fingerprint(text)
  if (sha256 === expected) return { text, sha256 }
  protectedPath(file)
  mkdirSync(dirname(file.path), { recursive: true })
  const pending = join(file.pendingDirectory, 'forge-setup-' + basename(file.path) + '.' + randomUUID() + '.tmp')
  protectedPath(file, pending)
  mkdirSync(file.pendingDirectory, { recursive: true })
  protectedPath(file, pending)
  const fd = openSync(pending, 'wx', 0o600)
  let own: BigIntStats | undefined
  try {
    try {
      own = fstatSync(fd, { bigint: true })
      writeFileSync(fd, text, 'utf8')
      fsyncSync(fd)
    } finally { closeSync(fd) }
    assertRevision(boundedRead(file), expected)
    protectedPath(file, pending)
    if (!isOwnedTemporary(pending, own)) fail('conflict', 'Forge setup temporary file changed while saving.')
    renameSync(pending, file.path)
    own = undefined
    const result = boundedRead(file)
    if (result?.sha256 !== sha256) fail('conflict', 'Forge setup file changed while saving.')
    return result
  } finally {
    if (own) discardTemporary(file, pending, own)
  }
}

function workflowPath(target: Target): FilePath {
  const layout = typeof target === 'string' ? resolveLayout(resolve(target)) : target
  return {
    layout, path: join(layout.knowledgeDir, FORGE_SETUP_DIRECTORY, FORGE_SETUP_WORKFLOW_FILE),
    limit: FORGE_WORKFLOW_BYTES, pendingDirectory: layout.localDir
  }
}

function recipebookPath(root: string): FilePath {
  root = resolve(root)
  return {
    layout: layoutUnder(root, 'repo', root), path: join(root, FORGE_RECIPEBOOK_FILE),
    limit: FORGE_RECIPEBOOK_BYTES, pendingDirectory: resolveLayout(root).localDir
  }
}

function ensureGuide(file: FilePath): void {
  const guide = { ...file, path: join(dirname(file.path), FORGE_SETUP_GUIDE_FILE) }
  if (!boundedRead(guide)) replaceText(guide, null, guideText)
}

function workflowValue(current: TextFile | null): ForgeSetupFile<ForgeSetupWorkflow> | null {
  return current && { value: parseForgeSetupWorkflow(current.text), sha256: current.sha256 }
}

export function readForgeSetupWorkflow(target: Target): ForgeSetupFile<ForgeSetupWorkflow> | null {
  const file = workflowPath(target)
  if (!nodeFs.exists(file.layout.dmDir) && !nodeFs.isSymlink(file.layout.dmDir)) return null
  return workflowValue(boundedRead(file))
}

function writeForgeSetupWorkflow(
  target: Target, expectedSha256: string | null, value: ForgeSetupWorkflow
): ForgeSetupFile<ForgeSetupWorkflow> {
  const file = workflowPath(target)
  const current = workflowValue(boundedRead(file))
  assertRevision(current, expectedSha256)
  const text = encodeForgeSetupWorkflow(value)
  if (current && encodeForgeSetupWorkflow(current.value) === text) return current
  if (current && (current.value.repository.toLowerCase() !== value.repository.toLowerCase() ||
    value.revision !== current.value.revision + 1)) fail('conflict', 'Forge setup workflow revision or repository changed.')
  ensureGuide(file)
  return { value, sha256: replaceText(file, expectedSha256, text).sha256 }
}

/** Stable across commits with the same requirements, and suitable for an agent-authored workflow's basedOn field. */
export function forgeSetupEvidenceHash(repository: string, detection: ForgeSetupDetection): string {
  const facts = detection.facts.map((fact) => JSON.stringify([fact.kind, fact.source, fact.value])).sort()
  return fingerprint(JSON.stringify([
    repository.toLowerCase(), detection.detectorVersion, detection.status,
    detection.status === 'detected' ? null : detection.reason, facts
  ]))
}

export function forgeSetupWorkflowState(
  file: ForgeSetupFile<ForgeSetupWorkflow> | null
): ForgeSetupProjectView['state'] {
  if (!file) return 'missing'
  const { repository, detection, workflow } = file.value
  if (workflow.state === 'needs-discovery') return 'needs-discovery'
  return workflow.basedOn === forgeSetupEvidenceHash(repository, detection) ? 'configured' : 'stale'
}

export function saveForgeSetupWorkflow(target: Target, edit: ForgeSetupWorkflowEdit): ForgeSetupFile<ForgeSetupWorkflow> {
  const current = readForgeSetupWorkflow(target)
  if (!current || current.sha256 !== edit.expectedSha256) fail('conflict', 'Forge setup file changed. Reload it before saving.')
  const { value } = current
  const notes = edit.notes ?? value.notes
  const workflow = {
    ...edit.workflow,
    basedOn: edit.workflow.state === 'configured' ? forgeSetupEvidenceHash(value.repository, value.detection) : null
  }
  const next = { ...value, workflow, notes }
  if (encodeForgeSetupWorkflow(next) === encodeForgeSetupWorkflow(value)) return current
  return writeForgeSetupWorkflow(target, current.sha256, { ...next, revision: value.revision + 1 })
}

export function refreshForgeSetupWorkflow(
  target: Target, input: string, detection: ForgeSetupDetection,
  options: { recipeId?: string; steps?: ForgeSetupStep[] } = {}
): ForgeSetupFile<ForgeSetupWorkflow> {
  const repository = githubRemote(input)
  if (detection.source && detection.source.repository.toLowerCase() !== repository.toLowerCase()) {
    fail('project_mismatch', 'Forge setup evidence belongs to a different code repository.')
  }
  const file = workflowPath(target)
  const previous = boundedRead(file)
  if (!previous) {
    return writeForgeSetupWorkflow(target, null, {
      version: 1, repository, revision: 1, recipeId: options.recipeId, detection,
      workflow: { state: 'needs-discovery', basedOn: null, steps: options.steps ?? [] }
    })
  }
  const current = parseForgeSetupWorkflow(previous.text)
  if (current.repository.toLowerCase() !== repository.toLowerCase()) {
    fail('project_mismatch', 'Forge setup workflow belongs to a different code repository.')
  }
  // A failed refresh leaves earlier facts attributed to the commit that actually proved them.
  if (detection.status === 'unavailable' && current.detection.facts.length) {
    detection = { ...detection, facts: current.detection.facts, source: current.detection.source }
  }
  const next = { ...current, detection }
  if (encodeForgeSetupWorkflow(next) === encodeForgeSetupWorkflow(current)) return { value: current, sha256: previous.sha256 }
  next.revision++
  const text = updateForgeSetupEvidence(previous.text, next)
  return { value: next, sha256: replaceText(file, previous.sha256, text).sha256 }
}

export function readForgeRecipebook(root: string): ForgeSetupFile<ForgeRecipebook> | null {
  const current = boundedRead(recipebookPath(root))
  return current && { value: parseForgeRecipebook(current.text), sha256: current.sha256 }
}

export function writeForgeRecipebook(
  root: string, expectedSha256: string | null, value: ForgeRecipebook
): ForgeSetupFile<ForgeRecipebook> {
  const file = recipebookPath(root)
  const current = boundedRead(file)
  assertRevision(current, expectedSha256)
  const text = encodeForgeRecipebook(value)
  if (current && encodeForgeRecipebook(parseForgeRecipebook(current.text)) === text) return { value, sha256: current.sha256 }
  return { value, sha256: replaceText(file, expectedSha256, text).sha256 }
}
