import { closeSync, fsyncSync, linkSync, openSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { prettyJson } from '../canonical'
import type { Clock } from '../clock'
import type { Ctx } from '../context'
import { type Db, openDatabase } from '../db/database'
import { fail } from '../errors'
import { policyForStore, publishSqlitePolicy, retireSqlitePolicy } from './deliveryPolicy'
import { setMeta, META_KEYS } from '../meta'
import { SESSION_ACTIVE_WINDOW_MS } from '../services/sessions'
import { loadStoredAttachment, placementOfAttachment } from './attachmentFiles'
import { resolveAttachmentPlacement } from '../services/attachmentOwners'
import { readRecoveredAttachmentBytes } from './recoveredAttachments'
import { createFileHashCache } from './fileHashes'
import { reconcileRepository } from './importer'
import { writeFileSafely } from './finalizer'
import { readProject } from './initialize'
import { layoutUnder, resolveLayout } from './layout'
import { checkpointOf, rebuildCheckpoint } from './migrationCheckpoint'
import { exportMigrationRecords } from './migrationExport'
import { assertForgeForceSafe, restartForgeExecution, settleForgeExports } from './forgeForce'
import { prepareForgeReconciliation } from './forgeReconciliation'
import { recordForgeExport, recordForgeExportOwner } from './forgeExportReceipt'
import type { ProjectRecord } from './portable'
import { assertContained, isStrictlyInside, ownedPaths } from './paths'
import { projectKey, type StorageMode } from './storageMode'
import type { FsAdapter, GitAdapter, RepoLayout } from './types'

const journalSchema = z.strictObject({ version: z.literal(1), sourceMode: z.enum(['repo', 'db']), pid: z.number().int().positive() })
const active = new Set<string>()

interface MigrationEnv { repoRoot: string; homeDir: string; fs: FsAdapter }
interface MigrationDeps extends MigrationEnv {
  ctx: Ctx
  db: Db
  layout: RepoLayout
  git: GitAdapter
  clock: Clock
  sessionId: string
  /** Closes the source database without ending the session; no connection may survive its directory's removal. */
  detach(): void
  /** Reopens the verified destination (or the untouched source on failure) under the same session. */
  attach(layout: RepoLayout, db: Db): void
}

interface MigrationPaths {
  source: RepoLayout
  target: RepoLayout
  staging: RepoLayout
  retired: string
}

function migrationPaths(env: MigrationEnv, sourceMode: StorageMode): MigrationPaths {
  const targetMode = sourceMode === 'db' ? 'repo' : 'db'
  const source = resolveLayout(env.repoRoot, { mode: sourceMode, homeDir: env.homeDir })
  const target = resolveLayout(env.repoRoot, { mode: targetMode, homeDir: env.homeDir })
  const staging = layoutUnder(env.repoRoot, targetMode, `${target.dmDir}.switch-staging`)
  return { source, target, staging, retired: `${source.dmDir}.switch-retired` }
}

function journalPath(env: MigrationEnv): string {
  return join(env.homeDir, 'projects', `${projectKey(env.repoRoot)}.switch.json`)
}

function canonicalCandidate(fs: FsAdapter, path: string): string {
  const suffix: string[] = []
  let ancestor = resolve(path)
  while (!fs.exists(ancestor)) {
    if (fs.isSymlink(ancestor) || dirname(ancestor) === ancestor) {
      fail('unsafe_path', `Cannot safely resolve storage migration path ${path}.`)
    }
    suffix.unshift(basename(ancestor))
    ancestor = dirname(ancestor)
  }
  return resolve(fs.realpath(ancestor), ...suffix)
}

function assertDisjointPaths(env: MigrationEnv, paths: MigrationPaths): void {
  const candidates = [paths.source.dmDir, paths.target.dmDir, paths.staging.dmDir, paths.retired, journalPath(env)]
    .map((path) => canonicalCandidate(env.fs, path))
  for (const [index, left] of candidates.entries()) {
    for (const right of candidates.slice(index + 1)) {
      if (relative(left, right) === '' || isStrictlyInside(left, right) || isStrictlyInside(right, left)) {
        fail('unsafe_path', 'Storage source, destination, staging and journal paths must not overlap. Choose a Dark Mechanicus home outside those stores.')
      }
    }
  }
}

function discardTemporary(fs: FsAdapter, path: string): void {
  try { fs.remove(path) } catch { /* A unique, unreferenced temporary file is safe to clean up on a later open. */ }
}

/** wx never follows an existing link; all writes and syncing use the exclusively owned descriptor. */
function prepareFile(fs: FsAdapter, target: string, text: string): string {
  const temp = `${target}.prepare-${process.pid}-${randomUUID()}`
  const fd = openSync(temp, 'wx', 0o600)
  try {
    try { writeFileSync(fd, text); fsyncSync(fd) } finally { closeSync(fd) }
  } catch (error) {
    discardTemporary(fs, temp)
    throw error
  }
  return temp
}

/** Never follows a link, including a junction. A linked child is unlinked, not traversed. */
function removeTree(fs: FsAdapter, path: string): void {
  if (fs.isSymlink(path)) { fs.remove(path); return }
  if (!fs.exists(path)) return
  if (!fs.isDirectory(path)) { fs.remove(path); return }
  for (const name of fs.readdir(path)) removeTree(fs, join(path, name))
  fs.removeDir(path)
}

function purgeIgnoreEntry(env: MigrationEnv): void {
  const path = join(env.repoRoot, '.gitignore')
  if (!env.fs.exists(path)) return
  if (env.fs.isSymlink(path)) fail('unsafe_path', 'The repository .gitignore is a link; remove its DM entry by hand before switching.')
  const before = env.fs.readFile(path)
  const after = before.split(/(?<=\n)/).filter((line) => !/^\/?\.darkmechanicus\/local\/?\r?\n?$/.test(line)).join('')
  if (after === before) return
  const temp = prepareFile(env.fs, `${path}.dm-switch`, after)
  try {
    if (env.fs.isSymlink(path) || env.fs.readFile(path) !== before || env.fs.isSymlink(temp) || env.fs.fileStamp(temp) === null) {
      fail('unsafe_path', 'The Git ignore file changed while storage cleanup was preparing its replacement.')
    }
    env.fs.rename(temp, path)
  } finally { discardTemporary(env.fs, temp) }
}

function committed(env: MigrationEnv, sourceMode: StorageMode): boolean {
  const paths = migrationPaths(env, sourceMode)
  return sourceMode === 'repo' ? env.fs.exists(paths.target.projectFile) : !env.fs.exists(paths.source.projectFile) && env.fs.exists(paths.target.projectFile)
}
function purgeRepository(env: MigrationEnv, source: RepoLayout): void {
  // Keep both protecting ignore rules until every private byte has been removed.
  removeTree(env.fs, source.localDir)
  if (env.fs.exists(source.dmDir)) {
    for (const name of env.fs.readdir(source.dmDir).filter((entry) => entry !== '.gitignore')) {
      removeTree(env.fs, join(source.dmDir, name))
    }
    env.fs.remove(source.gitignoreFile)
    env.fs.removeDir(source.dmDir)
  }
  purgeIgnoreEntry(env)
}


function recover(env: MigrationEnv, sourceMode: StorageMode): void {
  const paths = migrationPaths(env, sourceMode)
  assertDisjointPaths(env, paths)
  if (committed(env, sourceMode)) {
    if (sourceMode === 'repo') {
      const policy = readProject(paths.source, env.fs)?.deliveryStandards
      if (policy) publishSqlitePolicy({ layout: paths.target, fs: env.fs }, policy)
      purgeRepository(env, paths.source)
    } else retireSqlitePolicy({ layout: paths.source, fs: env.fs }, readProject(paths.target, env.fs)?.deliveryStandards)
    removeTree(env.fs, paths.retired)
  } else {
    // A db -> repo export may already be published while the db marker still selects the untouched original.
    removeTree(env.fs, paths.target.dmDir)
  }
  removeTree(env.fs, paths.staging.dmDir)
  env.fs.remove(journalPath(env))
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
function cleanupPreparedJournals(env: MigrationEnv): void {
  const file = journalPath(env)
  const directory = dirname(file)
  if (!env.fs.exists(directory)) return
  const prefix = `${basename(file)}.prepare-`
  for (const name of env.fs.readdir(directory).filter((entry) => entry.startsWith(prefix))) {
    const match = /^([0-9]+)-[0-9a-f-]{36}$/.exec(name.slice(prefix.length))
    if (match !== null && !processAlive(Number(match[1]))) discardTemporary(env.fs, join(directory, name))
  }
}


/** Existing connections must not enqueue writes against the original store while it is being copied. */
export function assertStorageMigrationIdle(env: MigrationEnv): void {
  const file = journalPath(env)
  if (!env.fs.exists(file)) return
  const journal = journalSchema.parse(JSON.parse(env.fs.readFile(file)))
  if (active.has(file) || journal.pid !== process.pid) {
    fail('conflict', 'This folder has a storage switch in progress or awaiting recovery. Close and reconnect this session.')
  }
}

/** On open, finish committed cleanup or discard an interrupted staging export. Never imports the JSON checkpoint. */
export function recoverStorageMigration(env: MigrationEnv): void {
  cleanupPreparedJournals(env)
  const file = journalPath(env)
  if (!env.fs.exists(file)) return
  if (active.has(file)) fail('conflict', 'A storage switch is already in progress for this folder.')
  const journal = journalSchema.parse(JSON.parse(env.fs.readFile(file)))
  if (journal.pid !== process.pid && processAlive(journal.pid)) {
    fail('conflict', 'Another process is switching this folder’s storage. Close it or wait for it to finish.')
  }
  recover(env, journal.sourceMode)
}

function assertOtherSessionsClosed(deps: Pick<MigrationDeps, 'db' | 'clock' | 'sessionId'>): void {
  const since = new Date(deps.clock.nowMs() - SESSION_ACTIVE_WINDOW_MS).toISOString()
  const others = deps.db.all<{ pid: number | null; last_seen_at: string }>(
    'SELECT pid, last_seen_at FROM sessions WHERE id <> ? AND ended_at IS NULL', deps.sessionId
  )
  if (others.some((session) => session.last_seen_at >= since || (session.pid !== null && processAlive(session.pid)))) {
    fail('conflict', 'Close the other connected agent or desktop sessions before switching storage.')
  }
}

export function assertStorageIdle(deps: Pick<MigrationDeps, 'db' | 'clock' | 'sessionId'>): void {
  const { db } = deps
  if (db.get('SELECT 1 FROM tooling_holds LIMIT 1')) fail('conflict', 'Resolve every tooling recovery hold before switching storage.')
  // Paused runs move with their execution history; outstanding claims are fenced below.
  if (db.get("SELECT 1 FROM runs WHERE state IN ('queued','running','awaiting_checkpoint') LIMIT 1")) {
    fail('conflict', 'Pause, finish or cancel every active run before switching storage.')
  }
  const uncertain = deps.db.get("SELECT 1 FROM attempts WHERE state = 'lease_expired' AND reconciled_at IS NULL AND superseded_at IS NULL LIMIT 1")
  if (uncertain || db.get("SELECT 1 FROM attempts WHERE state IN ('claimed','running') LIMIT 1") ||
      db.get("SELECT 1 FROM kanban_attempts WHERE state IN ('claimed','running') LIMIT 1")) {
    fail('conflict', 'Resolve every claimed or uncertain attempt before switching storage.')
  }
  if (db.get('SELECT 1 FROM kanban_cards WHERE play_requested_at IS NOT NULL LIMIT 1')) fail('conflict', 'Cancel queued Kanban work before switching storage.')
  if (db.get("SELECT 1 FROM outbox WHERE state <> 'done' LIMIT 1") || db.get('SELECT 1 FROM sync_state WHERE conflict IS NOT NULL LIMIT 1')) {
    fail('conflict', 'Flush pending records and resolve storage conflicts before switching storage.')
  }
  assertOtherSessionsClosed(deps)
}

async function assertCleanRecords(deps: MigrationDeps): Promise<void> {
  if (deps.layout.mode !== 'repo') return
  const dirty = await deps.git.countUncommitted('.darkmechanicus')
  if (dirty === null) fail('conflict', 'Git could not verify that the .darkmechanicus records are committed; switching was refused.')
  if (dirty !== 0) fail('conflict', 'Commit all uncommitted .darkmechanicus records before switching storage.')
}

function assertVacantDestinations(deps: MigrationDeps, paths: MigrationPaths): void {
  for (const path of [paths.target.dmDir, paths.staging.dmDir, paths.retired]) {
    if (deps.fs.exists(path) || deps.fs.isSymlink(path)) fail('conflict', `Storage switch destination already exists: ${path}. Nothing was removed.`)
  }
}

async function preflight(deps: MigrationDeps, mode: StorageMode): Promise<{ paths: MigrationPaths; project: ProjectRecord }> {
  if (deps.layout.mode === mode) fail('invalid_input', `This folder already uses ${mode} storage.`)
  const paths = migrationPaths(deps, deps.layout.mode)
  assertDisjointPaths(deps, paths)
  const project = readProject(paths.source, deps.fs) ?? fail('not_initialized', 'Initialize the folder before switching storage.')
  if (project.repositories !== undefined && mode === 'repo') fail('invalid_input', 'A folder of repositories must remain database only.')
  await assertCleanRecords(deps)
  assertStorageIdle(deps)
  assertVacantDestinations(deps, paths)
  assertContained(paths.source, deps.fs, paths.source.projectFile)
  if (deps.layout.mode === 'repo' && deps.fs.isSymlink(join(deps.repoRoot, '.gitignore'))) fail('unsafe_path', 'The repository .gitignore is a link; switching was refused.')
  return { paths, project }
}

function hydratedCheckpoint(deps: MigrationDeps, source: RepoLayout) {
  const snapshot = checkpointOf(deps.db)
  // Repo imports may keep attachment bytes only on disk. Hydrate before purging their files.
  for (const row of snapshot.tables.filter((table) => table.name === 'attachments').flatMap((table) => table.rows)) {
    if (row.data !== null || typeof row.id !== 'string') continue
    const attachment = loadStoredAttachment(deps.db, row.id)
    if (attachment.owner !== null && resolveAttachmentPlacement(deps.db, attachment.owner) === null) {
      row.data = { bytes: Buffer.from(readRecoveredAttachmentBytes({ ...deps, layout: source }, row.id)).toString('base64') }
      continue
    }
    const placement = placementOfAttachment(deps.db, attachment)
    const image = ownedPaths(source).attachmentFile(placement.folder, attachment.sha256, attachment.mime)
    assertContained(source, deps.fs, image)
    row.data = { bytes: Buffer.from(deps.fs.readFileBytes(image)).toString('base64') }
  }
  return snapshot
}

function importCanonical(deps: MigrationDeps, rebuilt: Db, source: RepoLayout): void {
  const result = reconcileRepository({
    db: rebuilt, fs: deps.fs, layout: source, clock: deps.clock, git: deps.git,
    machineId: rebuilt.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', META_KEYS.machineId)?.value ?? '',
    sessionId: deps.sessionId, fileHashes: createFileHashCache()
  })
  if (result.rejected.length || result.conflicts.length || result.profileConflicts.length || result.kanbanConflicts.length) {
    fail('conflict', 'Repository records could not be imported without conflicts; the original store was kept.', { result })
  }
  rebuilt.run('DELETE FROM meta WHERE key = ?', META_KEYS.checkoutBranch)
}

function restartDestination(deps: MigrationDeps, paths: MigrationPaths, rebuilt: Db): void {
  if (paths.source.mode === 'repo') {
    prepareForgeReconciliation({ db: rebuilt, fs: deps.fs, source: paths.source, staging: paths.staging, clock: deps.clock })
    importCanonical(deps, rebuilt, paths.staging)
  }
  assertForgeForceSafe(rebuilt)
  restartForgeExecution({ ...deps.ctx, db: rebuilt })
}

function prepareDestination(deps: MigrationDeps, paths: MigrationPaths, project: ProjectRecord, options: { retireSession?: boolean; force?: boolean } = {}): void {
  const { retireSession = false, force = false } = options
  deps.db.tx(() => {
    if (force) assertForgeForceSafe(deps.db)
    else assertStorageIdle(deps)
    deps.fs.mkdirp(paths.staging.localDir)
    const snapshot = hydratedCheckpoint(deps, paths.source)
    const env = { fs: deps.fs, layout: paths.staging }
    if (force) recordForgeExportOwner({ ...env, source: deps.repoRoot }, project.projectId)
    const policy = policyForStore(deps.layout, deps.db, project, deps.fs)
    const destinationProject = { ...project, deliveryStandards: paths.target.mode === 'repo' ? policy : undefined }
    writeFileSafely(env, paths.staging.projectFile, prettyJson(destinationProject))
    writeFileSafely(env, paths.staging.machineFile, deps.fs.readFile(paths.source.machineFile))
    // Credentials and unsaved state stay ignored-local; this is not a new canonical portable format.
    writeFileSafely(env, paths.staging.gitignoreFile, 'local/\n')
    const checkpointFile = join(paths.staging.localDir, 'migration-records.json')
    writeFileSafely(env, checkpointFile, prettyJson(snapshot))
    const rebuilt = rebuildCheckpoint(paths.staging.dbFile, deps.fs.readFile(checkpointFile))
    try {
      if (force) restartDestination(deps, paths, rebuilt)
      if (paths.target.mode === 'db' && policy) setMeta(rebuilt, META_KEYS.deliveryStandards, prettyJson(policy))
      else rebuilt.run('DELETE FROM meta WHERE key = ?', META_KEYS.deliveryStandards)
      if (paths.target.mode === 'repo') {
        const exported = exportMigrationRecords({ ...env, db: rebuilt, clock: deps.clock })
        if (force) settleForgeExports(rebuilt, exported)
      }
      else importCanonical(deps, rebuilt, paths.source)
      assertStorageIdle({ ...deps, db: rebuilt })
      if (retireSession) rebuilt.run('UPDATE sessions SET ended_at = ? WHERE id = ?', deps.clock.nowIso(), deps.sessionId)
      rebuilt.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } finally { rebuilt.close() }

  })
}

function copyKnowledge(fs: FsAdapter, source: RepoLayout, staging: RepoLayout): void {
  function copy(path: string, target: string): void {
    assertContained(source, fs, path)
    assertContained(staging, fs, target)
    if (fs.isDirectory(path)) {
      fs.mkdirp(target)
      for (const name of fs.readdir(path)) copy(join(path, name), join(target, name))
    } else {
      fs.writeFileBytes(target, fs.readFileBytes(path))
      fs.fsyncFile(target)
    }
  }
  if (fs.exists(source.knowledgeDir)) copy(source.knowledgeDir, staging.knowledgeDir)
}

export function exportForgeDestination(deps: MigrationDeps, member: string, mode: StorageMode, force = false): void {
  if (force) {
    if (mode !== 'repo') fail('invalid_input', 'Force migration requires a Forge World destination.')
    assertForgeForceSafe(deps.db)
  }
  else assertStorageIdle(deps)
  const source = deps.layout
  const target = resolveLayout(member, { mode, homeDir: deps.homeDir })
  const staging = layoutUnder(member, mode, target.dmDir + '.preparing')
  const paths = { source, target, staging, retired: source.dmDir + '.retired' }
  assertDisjointPaths(deps, paths)
  assertVacantDestinations(deps, paths)
  const project = readProject(source, deps.fs) ?? fail('not_initialized', 'Initialize this project first.')
  try {
    const { repoRoot: _localRoot, ...portable } = project
    prepareDestination(deps, paths, mode === 'db' ? { ...portable, repoRoot: member } : portable, { retireSession: true, force })
    copyKnowledge(deps.fs, source, staging)
    if (force) recordForgeExport({ fs: deps.fs, layout: staging, source: deps.repoRoot })
    deps.fs.rename(staging.dmDir, target.dmDir)
    if (mode === 'db' && project.deliveryStandards) {
      publishSqlitePolicy({ layout: target, fs: deps.fs }, project.deliveryStandards)
    }
  } catch (error) {
    removeTree(deps.fs, staging.dmDir)
    throw error
  }
}

function beginJournal(deps: MigrationDeps): string {
  const file = journalPath(deps)
  deps.fs.mkdirp(dirname(file))
  const temp = prepareFile(deps.fs, file, prettyJson({ version: 1, sourceMode: deps.layout.mode, pid: process.pid }))
  try { linkSync(temp, file) } finally { discardTemporary(deps.fs, temp) }
  active.add(file)
  return file
}

/** All native records and the complete private row checkpoint are verified before the mode's atomic commit point. */
export async function switchStorage(deps: MigrationDeps, mode: StorageMode): Promise<{ mode: StorageMode; projectDir: string; cleanupPending: boolean }> {
  const { paths, project } = await preflight(deps, mode)
  const file = beginJournal(deps)
  let detached = false
  let destination: Db | null = null
  try {
    prepareDestination(deps, paths, project)
    assertDisjointPaths(deps, paths)
    // No source write has happened. Close the sole live handle only after the complete destination passed verification.
    deps.detach()
    detached = true
    deps.fs.rename(paths.staging.dmDir, paths.target.dmDir)
    if (deps.layout.mode === 'db') deps.fs.rename(paths.source.dmDir, paths.retired)
    // Commit point: target db marker appeared, or source db marker disappeared. Cleanup is idempotent recovery work.
    destination = openDatabase(paths.target.dbFile)
    deps.attach(paths.target, destination)
    destination = null
    detached = false
    let cleanupPending = false
    try { recover(deps, paths.source.mode) } catch { cleanupPending = true }
    return { mode, projectDir: paths.target.dmDir, cleanupPending }
  } catch (error) {
    destination?.close()
    if (committed(deps, paths.source.mode)) {
      // A fault just after the atomic rename is a committed switch, not permission to erase the verified destination.
      if (detached) deps.attach(paths.target, openDatabase(paths.target.dbFile))
      return { mode, projectDir: paths.target.dmDir, cleanupPending: true }
    }
    try { recover(deps, paths.source.mode) } finally {
      if (detached) deps.attach(paths.source, openDatabase(paths.source.dbFile))
    }
    throw error
  } finally { active.delete(file) }
}
