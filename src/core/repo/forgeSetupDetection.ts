import { createHash } from 'node:crypto'
import {
  FORGE_SETUP_FACT_VALUE_MAX, type ForgeSetupDetection, type ForgeSetupDetectionReason, type ForgeSetupFact, type ForgeSourceRevision
} from '../../shared/desktop/forgeSetup'
import { githubRemote } from './forgeManifest'

export interface ForgeSetupTreeEntry {
  path: string
  mode: string
  type: string
  sha: string
  size?: number
}

interface ReadOptions {
  maxBytes: number
  maxEntries?: number
  signal?: AbortSignal
}

/** Implementations enforce the byte/entry bounds before materializing a response. */
export interface ForgeSetupDescriptorReader {
  head(repository: string, options: ReadOptions): Promise<{ commit: string; tree: string } | null>
  tree(repository: string, sha: string, options: ReadOptions): Promise<{ entries: ForgeSetupTreeEntry[]; truncated: boolean }>
  blob(repository: string, sha: string, options: ReadOptions): Promise<Uint8Array>
}

const descriptors = ['package.json', '.nvmrc', '.node-version', '.tool-versions'] as const
const locks = {
  'package-lock.json': 'npm', 'npm-shrinkwrap.json': 'npm', 'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn', 'bun.lock': 'bun', 'bun.lockb': 'bun'
} as const
const approved = new Set<string>([...descriptors, ...Object.keys(locks)])
const gitDigest = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const maxTreeEntries = 2048
const maxBlobBytes = 64 * 1024
const maxDescriptorBytes = 128 * 1024

class DescriptorError extends Error {
  constructor(readonly reason: 'invalid-descriptor' | 'descriptor-limits') { super(reason) }
}

function result(
  status: 'unsupported' | 'unavailable' | 'ambiguous',
  source: ForgeSourceRevision | null,
  reason: ForgeSetupDetectionReason,
  facts: ForgeSetupFact[] = []
): ForgeSetupDetection {
  return { detectorVersion: 1, status, source, facts, reason }
}

function selectedEntries(entries: ForgeSetupTreeEntry[]): Map<string, ForgeSetupTreeEntry> | null {
  const selected = new Map<string, ForgeSetupTreeEntry>()
  for (const entry of entries) {
    if (typeof entry?.path !== 'string') return null
    const path = entry.path.toLowerCase()
    if (!approved.has(path)) continue
    if (path !== entry.path || selected.has(path) || entry.type !== 'blob' ||
      !/^(?:100644|100755)$/.test(entry.mode) || !gitDigest.test(entry.sha)) return null
    selected.set(path, entry)
  }
  return selected
}

function verifiedBlob(bytes: Uint8Array, sha: string, size: number): boolean {
  if (!(bytes instanceof Uint8Array) || bytes.length !== size) return false
  const hash = createHash(sha.length === 40 ? 'sha1' : 'sha256')
  return hash.update('blob ' + size + '\0').update(bytes).digest('hex') === sha
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

const versionRange = /^(?=.{1,100}$)(?=.*\d)[v\d.xX*^~<>=| -]+(?:-(?:alpha|beta|rc|nightly|canary|next)[\d.-]*)?$/i
const nodeVersion = /^(?:v?\d{1,3}(?:\.\d{1,3}){0,2}|(?:lts\/(?:\*|[a-z]{2,20})|node|stable))$/i
const managerVersion = /^(npm|yarn|pnpm|bun)@(\d+\.\d+\.\d+(?:-(?:alpha|beta|rc|next)[\d.-]*)?)(?:\+sha(?:224|256|384|512)\.[a-f0-9]{56,128})?$/i
const scriptName = /^(?:build|test|dev|start|lint|typecheck|verify|check|package|preview)(?::[a-z0-9.-]{1,24})?$/i

type Version = [major: number, minor: number, patch: number]
interface ReleasePrefix {
  start: Version
  end: Version
}

function numericPrefix(value: string): ReleasePrefix | null {
  const match = /^v?(0|[1-9]\d{0,2})(?:\.(0|[1-9]\d{0,2})(?:\.(0|[1-9]\d{0,2}))?)?$/i.exec(value)
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2] ?? '0')
  const patch = Number(match[3] ?? '0')
  const end: Version = match[2] === undefined ? [major + 1, 0, 0] :
    match[3] === undefined ? [major, minor + 1, 0] : [major, minor, patch + 1]
  return { start: [major, minor, patch], end }
}

function compareVersion(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

function disjointFromComparison(pin: ReleasePrefix, bound: ReleasePrefix, operator: string | undefined): boolean {
  switch (operator) {
    case '>=': return compareVersion(pin.end, bound.start) <= 0
    case '>': return compareVersion(pin.end, bound.end) <= 0
    case '<=': return compareVersion(pin.start, bound.end) >= 0
    case '<': return compareVersion(pin.start, bound.start) >= 0
    default: return compareVersion(pin.end, bound.start) <= 0 || compareVersion(pin.start, bound.end) >= 0
  }
}

/** Prove conflicts for single numeric comparators. Keep compound ranges and moving aliases as evidence. */
function nodePinsAgree(facts: ForgeSetupFact[], pins: Set<string>): boolean {
  if (pins.size > 1) return false
  const engine = facts.find((fact) => fact.kind === 'node' && fact.source === 'package.json')
  const comparison = /^(>=|<=|>|<|=)?\s*(v?[\d.]+)$/i.exec(engine?.value ?? '')
  if (!comparison) return true
  const bound = numericPrefix(comparison[2])
  const pin = numericPrefix(pins.values().next().value ?? '')
  return !bound || !pin || !disjointFromComparison(pin, bound, comparison[1])
}

function addPackagePins(pkg: Record<string, unknown>, facts: ForgeSetupFact[]): boolean {
  const node = record(pkg.engines)?.node
  if (node !== undefined) {
    if (typeof node !== 'string' || !versionRange.test(node.trim())) return false
    facts.push({ kind: 'node', value: node.trim(), source: 'package.json' })
  }
  const manager = typeof pkg.packageManager === 'string' ? managerVersion.exec(pkg.packageManager) : null
  if (pkg.packageManager !== undefined) {
    if (!manager) return false
    const value = manager[1].toLowerCase() + '@' + manager[2]
    if (value.length > FORGE_SETUP_FACT_VALUE_MAX) return false
    facts.push({ kind: 'package-manager', value, source: 'package.json' })
  }
  return true
}

function addElectronPin(pkg: Record<string, unknown>, facts: ForgeSetupFact[]): boolean {
  const versions = new Set<string>()
  for (const key of ['devDependencies', 'dependencies', 'optionalDependencies', 'peerDependencies']) {
    const value = record(pkg[key])?.electron
    if (value === undefined) continue
    if (typeof value !== 'string' || !versionRange.test(value.trim())) return false
    versions.add(value.trim())
  }
  if (versions.size > 1) return false
  for (const version of versions) facts.push({ kind: 'electron', value: version, source: 'package.json' })
  return true
}

function addScriptNames(pkg: Record<string, unknown>, facts: ForgeSetupFact[]): void {
  const names = Object.entries(record(pkg.scripts) ?? {})
    .filter(([name, body]) => scriptName.test(name) && typeof body === 'string')
    .map(([name]) => name).sort().slice(0, 32)
  for (const name of names) facts.push({ kind: 'script', value: name, source: 'package.json' })
}

function addNodePins(files: Map<string, string>, facts: ForgeSetupFact[]): boolean {
  const pins = new Set<string>()
  for (const path of ['.nvmrc', '.node-version', '.tool-versions']) {
    const content = files.get(path)
    if (content === undefined) continue
    const lines = content.split(/\r?\n/).map((line) => line.replace(/#.*/, '').trim()).filter(Boolean)
    const matches = path === '.tool-versions'
      ? lines.filter((line) => /^nodejs\s/.test(line)).map((line) => line.slice('nodejs'.length).trim())
      : lines
    if (matches.length === 0 && path === '.tool-versions') continue
    if (matches.length !== 1 || !nodeVersion.test(matches[0])) return false
    facts.push({ kind: 'node', value: matches[0], source: path })
    pins.add(matches[0].toLowerCase().replace(/^v(?=\d)/, ''))
  }
  return nodePinsAgree(facts, pins)
}

function addLockFacts(entries: Map<string, ForgeSetupTreeEntry>, facts: ForgeSetupFact[]): boolean {
  const managers = new Set(facts.filter((fact) => fact.kind === 'package-manager').map((fact) => fact.value.split('@')[0]))
  let lockCount = 0
  for (const [path, manager] of Object.entries(locks)) {
    if (!entries.has(path)) continue
    lockCount++
    managers.add(manager)
    facts.push({ kind: 'lockfile', value: manager, source: path })
  }
  return managers.size <= 1 && lockCount <= 1
}

function normalizedFacts(
  files: Map<string, string>, entries: Map<string, ForgeSetupTreeEntry>, source: ForgeSourceRevision
): ForgeSetupDetection {
  const manifest = files.get('package.json')
  if (manifest === undefined) return result('unsupported', source, 'no-node-manifest')
  let pkg: Record<string, unknown> | undefined
  try { pkg = record(JSON.parse(manifest)) } catch { return result('unavailable', source, 'invalid-descriptor') }
  if (!pkg) return result('unavailable', source, 'invalid-descriptor')
  const facts: ForgeSetupFact[] = []
  const packagePins = addPackagePins(pkg, facts) && addElectronPin(pkg, facts)
  addScriptNames(pkg, facts)
  const runtimePins = addNodePins(files, facts)
  const locksMatch = addLockFacts(entries, facts)
  if (!packagePins || !runtimePins || !locksMatch || facts.length === 0) {
    return result('ambiguous', source, 'conflicting-requirements', facts)
  }
  return { detectorVersion: 1, status: 'detected', source, facts }
}

function descriptorBodies(entries: Map<string, ForgeSetupTreeEntry>): Array<{ path: string; sha: string; size: number }> {
  let total = 0
  const files: Array<{ path: string; sha: string; size: number }> = []
  for (const path of descriptors) {
    const entry = entries.get(path)
    if (!entry) continue
    const { sha, size } = entry
    if (size === undefined || !Number.isSafeInteger(size) || size < 0) throw new DescriptorError('invalid-descriptor')
    total += size
    if (size > maxBlobBytes || total > maxDescriptorBytes) throw new DescriptorError('descriptor-limits')
    files.push({ path, sha, size })
  }
  return files
}

async function readDescriptor(
  reader: ForgeSetupDescriptorReader, source: ForgeSourceRevision,
  entry: { sha: string; size: number }, signal?: AbortSignal
): Promise<string> {
  const { sha, size } = entry
  signal?.throwIfAborted()
  const bytes = await reader.blob(source.repository, sha, { maxBytes: size, signal })
  signal?.throwIfAborted()
  if (!verifiedBlob(bytes, sha, size)) throw new DescriptorError('invalid-descriptor')
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new DescriptorError('invalid-descriptor') }
}

async function inspectTree(
  reader: ForgeSetupDescriptorReader, source: ForgeSourceRevision, tree: string, signal?: AbortSignal
): Promise<ForgeSetupDetection> {
  const snapshot = await reader.tree(source.repository, tree, { maxBytes: 512 * 1024, maxEntries: maxTreeEntries, signal })
  signal?.throwIfAborted()
  if (snapshot.truncated !== false || snapshot.entries.length > maxTreeEntries) throw new DescriptorError('descriptor-limits')
  const entries = selectedEntries(snapshot.entries)
  if (!entries) throw new DescriptorError('invalid-descriptor')
  const files = new Map<string, string>()
  for (const entry of descriptorBodies(entries)) files.set(entry.path, await readDescriptor(reader, source, entry, signal))
  return normalizedFacts(files, entries, source)
}

/** Discover a single commit's ordinary root descriptors without reading code, lockfiles, or repository instructions. */
export async function discoverForgeSetup(
  input: string, reader: ForgeSetupDescriptorReader, signal?: AbortSignal
): Promise<ForgeSetupDetection> {
  let source: ForgeSourceRevision | null = null
  try {
    signal?.throwIfAborted()
    const repository = githubRemote(input)
    const head = await reader.head(repository, { maxBytes: 32 * 1024, signal })
    signal?.throwIfAborted()
    if (!head) return result('unavailable', null, 'source-unavailable')
    if (!gitDigest.test(head.commit) || !gitDigest.test(head.tree)) return result('unavailable', null, 'invalid-descriptor')
    source = { repository, commit: head.commit }
    return await inspectTree(reader, source, head.tree, signal)
  } catch (error) {
    return result('unavailable', source, error instanceof DescriptorError ? error.reason : 'source-unavailable')
  }
}
