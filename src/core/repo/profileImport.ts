/**
 * Reconcile for named capability profiles (`.darkmechanicus/profiles/<name>.json`).
 *
 * Every entry is untrusted, exactly like epic and run records: only `<name>.json` files with a
 * portable profile name are read, through the contained owned path (links, junctions, and
 * directories are refused), within a size bound, and must hold a strict profile record naming the
 * profile of its file name. A bad entry is rejected and reported and never stops the others; a
 * linked `profiles/` directory fails the whole reconcile, like a linked `epics/`. A changed profile
 * is imported unless the local profile has unexported changes: that is a conflict, the local
 * profile is kept, and its next export writes it over the tracked file.
 */
import { type Db, toJson } from '../db/database'
import { fail } from '../errors'
import { type FileHashCache, readUnlessSynced } from './fileHashes'
import { assertContained, displayPath, ownedPaths } from './paths'
import { parseRecord, type ProfileRecord, profileRecord, readOwnedText, trackedProfileHash } from './portable'
import type { FsAdapter, RepoLayout } from './types'

/** Entries a `profiles/` directory may hold before the whole directory is refused unread. */
export const MAX_PROFILES = 1_000
/** Per-file bound, above the largest valid profile record (about 215 KiB of escaped maximum-length text). */
export const MAX_PROFILE_BYTES = 256 * 1024

const JSON_SUFFIX = '.json'

interface ProfileImportDeps {
  db: Db
  layout: RepoLayout
  fs: FsAdapter
  fileHashes: FileHashCache
}

interface Rejection {
  path: string
  message: string
}

interface StagedProfile {
  name: string
  path: string
  record: ProfileRecord
  trackedHash: string
}

/** What a scan of `profiles/` found; `unchanged` holds `profile:<name>` keys. */
export interface ProfileScan {
  staged: StagedProfile[]
  unchanged: string[]
  conflicts: { name: string; message: string }[]
  rejected: Rejection[]
}

function reject(path: string, reason: string): never {
  return fail('import_rejected', `${path} ${reason}.`, { path })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function profileKey(name: string): string {
  return `profile:${name}`
}

function conflictMessage(name: string): string {
  return `Tracked profile ${name} changed while local profile changes are waiting to be exported. Flush or resolve the local changes before importing.`
}

/** Entries of `profiles/` (dot entries ignored). A linked directory fails the whole reconcile. */
function listProfileEntries(deps: ProfileImportDeps): string[] {
  const dir = deps.layout.profilesDir
  if (!deps.fs.exists(dir) && !deps.fs.isSymlink(dir)) {
    return []
  }
  assertContained(deps.layout, deps.fs, dir)
  return deps.fs
    .readdir(dir)
    .filter((entry) => !entry.startsWith('.'))
    .sort()
}

function syncedHash(db: Db, name: string, hash: string): boolean {
  const row = db.get<{ exported_hash: string | null; imported_hash: string | null }>(
    "SELECT exported_hash, imported_hash FROM sync_state WHERE kind = 'profile' AND entity_id = ?",
    name
  )
  return row !== undefined && (row.exported_hash === hash || row.imported_hash === hash)
}

function hasPendingProfileChanges(db: Db, name: string): boolean {
  const row = db.get<{ pending: number }>(
    "SELECT EXISTS (SELECT 1 FROM outbox WHERE kind = 'profile' AND entity_id = ? AND state IN ('pending', 'failed')) AS pending",
    name
  )
  return row?.pending === 1
}

/** One profile file's text: contained, a regular file, and within the profile size limit. */
function readProfileText(deps: ProfileImportDeps, file: string, shownEntry: string): string {
  assertContained(deps.layout, deps.fs, file)
  if (deps.fs.isDirectory(file)) {
    reject(shownEntry, 'is a directory, not a profile record')
  }
  if (deps.fs.fileSize(file) > MAX_PROFILE_BYTES) {
    reject(shownEntry, 'is larger than the 256 KiB profile limit')
  }
  return readOwnedText(deps, file) ?? reject(shownEntry, 'is missing')
}

/** Reads one entry; null when it matches the last sync (then it is not even parsed again). */
function readProfileEntry(deps: ProfileImportDeps, entry: string, shownEntry: string): StagedProfile | null {
  if (!entry.endsWith(JSON_SUFFIX)) {
    reject(shownEntry, 'is not a profile record: profiles are stored as <name>.json')
  }
  const name = entry.slice(0, -JSON_SUFFIX.length)
  const file = ownedPaths(deps.layout).profileFile(name)
  const changed = readUnlessSynced(deps, file, {
    hashOf: trackedProfileHash,
    synced: (hash) => syncedHash(deps.db, name, hash),
    read: () => readProfileText(deps, file, shownEntry)
  })
  if (changed === null) {
    return null
  }
  const record = parseRecord(profileRecord, changed.text, shownEntry)
  if (record.name !== name) {
    reject(shownEntry, 'names a different profile than its file name')
  }
  return { name, path: shownEntry, record, trackedHash: changed.hash }
}

function sortEntry(scan: ProfileScan, db: Db, found: StagedProfile): void {
  if (hasPendingProfileChanges(db, found.name)) {
    scan.conflicts.push({ name: found.name, message: conflictMessage(found.name) })
  } else {
    scan.staged.push(found)
  }
}

/** Reads and validates every entry of `profiles/`, staging changed profiles for import. */
export function scanProfiles(deps: ProfileImportDeps): ProfileScan {
  const scan: ProfileScan = { staged: [], unchanged: [], conflicts: [], rejected: [] }
  const entries = listProfileEntries(deps)
  const shownDir = displayPath(deps.layout, deps.layout.profilesDir)
  if (entries.length > MAX_PROFILES) {
    scan.rejected.push({ path: shownDir, message: `${shownDir} holds more than ${MAX_PROFILES} profiles.` })
    return scan
  }
  for (const entry of entries) {
    const shownEntry = `${shownDir}/${entry}`
    try {
      const found = readProfileEntry(deps, entry, shownEntry)
      if (found === null) {
        scan.unchanged.push(profileKey(entry.slice(0, -JSON_SUFFIX.length)))
      } else {
        sortEntry(scan, deps.db, found)
      }
    } catch (error: unknown) {
      scan.rejected.push({ path: shownEntry, message: messageOf(error) })
    }
  }
  return scan
}

/** Imports one profile: the record's content and dates, a local revision bump, and the synced hash. */
function applyProfile(db: Db, profile: StagedProfile, now: string): void {
  const { record } = profile
  db.run(
    `INSERT INTO profiles (name, description, capability_json, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(name) DO UPDATE SET description = excluded.description, capability_json = excluded.capability_json,
       revision = profiles.revision + 1, created_at = excluded.created_at, updated_at = excluded.updated_at`,
    record.name,
    record.description,
    toJson(record.capability),
    record.createdAt,
    record.updatedAt
  )
  db.run(
    `INSERT INTO sync_state (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
     VALUES ('profile', ?, ?, 0, ?, NULL, ?)
     ON CONFLICT(kind, entity_id) DO UPDATE SET exported_hash = excluded.exported_hash,
       imported_hash = excluded.imported_hash, conflict = NULL, updated_at = excluded.updated_at`,
    profile.name,
    profile.trackedHash,
    profile.trackedHash,
    now
  )
}

function storeProfileConflicts(db: Db, scan: ProfileScan, now: string): void {
  for (const conflict of scan.conflicts) {
    db.run(
      `INSERT INTO sync_state (kind, entity_id, generation, conflict, updated_at) VALUES ('profile', ?, 0, ?, ?)
       ON CONFLICT(kind, entity_id) DO UPDATE SET conflict = excluded.conflict, updated_at = excluded.updated_at`,
      conflict.name,
      conflict.message,
      now
    )
  }
}

/**
 * Applies staged profiles, each under its own savepoint so one the database refuses is reported
 * without undoing the others, and records conflicts. Returns imported `profile:<name>` keys and
 * every rejection (from the scan too).
 */
export function applyProfiles(db: Db, scan: ProfileScan, now: string): { imported: string[]; rejected: Rejection[] } {
  const imported: string[] = []
  const rejected = [...scan.rejected]
  for (const profile of scan.staged) {
    try {
      db.tx(() => applyProfile(db, profile, now))
      imported.push(profileKey(profile.name))
    } catch (error: unknown) {
      rejected.push({ path: profile.path, message: `Could not be applied: ${messageOf(error)}` })
    }
  }
  storeProfileConflicts(db, scan, now)
  return { imported, rejected }
}
