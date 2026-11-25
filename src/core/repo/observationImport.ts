/**
 * Reconcile of metric observation files: `epics/<epicId>/observations/<observationId>.json` for every epic this
 * database holds, and `observations/<observationId>.json` for project-level ones. Each file is untrusted input:
 * containment and link checks, regular files only, at most 256 KiB, a name built from a valid `mo_` id, the strict
 * record schema with the ledger's storage rules (no claim or grant token, credential, machine-local path or chat
 * text), an id and epic matching the path, and every scope id and evidence reference resolving here, exactly as when
 * the observation was first recorded. A newer `formatVersion` is rejected, never guessed at.
 *
 * Observations are immutable: one already here with the same payload is only marked synced (another machine's record
 * of the same delivery differs only in its `recordedAt`, and the local row stays), and one with a different payload,
 * or one id recorded in two folders, is rejected and reported, never overwritten. Evidence resolves only against
 * observations stored here or inserted by this import, so nothing imports citing a record that did not. Each bad file
 * is rejected on its own; the rest import. Runs inside the reconcile transaction, after epics and runs are applied, so
 * an observation of a run imported now resolves.
 */
import type { MetricObservation } from '../../shared/domain/space'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { checkObservationReferences, insertObservationRow, storedObservation } from '../services/observations'
import { LEDGER_LIMITS, observationPayloadHash } from '../space/ledger'
import { type FileHashCache, readUnlessSynced } from './fileHashes'
import { assertContained, displayPath, ownedPaths } from './paths'
import { MAX_OBSERVATION_RECORD_BYTES, metricObservationRecord, parseRecord, readOwnedText, trackedObservationHash } from './portable'
import { matchesSync } from './syncState'
import type { FsAdapter, RepoLayout } from './types'

interface ObservationImportDeps {
  db: Db
  layout: RepoLayout
  fs: FsAdapter
  fileHashes: FileHashCache
}

interface Rejection {
  path: string
  message: string
}

interface ObservationFile {
  path: string
  epicId: string | null
  observation: MetricObservation
  trackedHash: string
}

const JSON_SUFFIX = '.json'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reject(path: string, reason: string): never {
  return fail('import_rejected', `${path} ${reason}.`, { path })
}

/** `.json` names in an observations folder; dot entries and other names (such as temp files) are ignored. */
function listNames(deps: ObservationImportDeps, dir: string): string[] {
  if (!deps.fs.exists(dir) && !deps.fs.isSymlink(dir)) {
    return []
  }
  assertContained(deps.layout, deps.fs, dir)
  if (!deps.fs.isDirectory(dir)) {
    reject(displayPath(deps.layout, dir), 'is not a directory')
  }
  const names = deps.fs
    .readdir(dir)
    .filter((name) => !name.startsWith('.') && name.endsWith(JSON_SUFFIX))
    .sort()
  if (names.length > LEDGER_LIMITS.perFolder) {
    reject(displayPath(deps.layout, dir), `holds more than ${LEDGER_LIMITS.perFolder} metric observations`)
  }
  return names
}

/** One observation file; null when its text matches what this machine last exported or imported. */
function readObservationFile(deps: ObservationImportDeps, epicId: string | null, name: string): ObservationFile | null {
  const observationId = name.slice(0, -JSON_SUFFIX.length)
  const file = ownedPaths(deps.layout).observationFile(epicId, observationId)
  const shown = displayPath(deps.layout, file)
  const changed = readUnlessSynced(deps, file, {
    hashOf: trackedObservationHash,
    synced: (hash) => matchesSync(deps.db, 'metric_observation', observationId, hash),
    read: () => {
      assertContained(deps.layout, deps.fs, file)
      if (deps.fs.isDirectory(file)) {
        reject(shown, 'is not a regular file')
      }
      if (deps.fs.fileSize(file) > MAX_OBSERVATION_RECORD_BYTES) {
        reject(shown, 'is larger than the 256 KiB observation limit')
      }
      return readOwnedText(deps, file) ?? reject(shown, 'is missing')
    }
  })
  if (changed === null) {
    return null
  }
  const { observation } = parseRecord(metricObservationRecord, changed.text, shown)
  if (observation.observationId !== observationId) {
    reject(shown, 'names a different observation than its file name')
  }
  if (observation.scope.epicId !== epicId) {
    reject(shown, epicId === null ? 'names an epic but sits in the project-level folder' : 'belongs to a different epic')
  }
  return { path: shown, epicId, observation, trackedHash: changed.hash }
}

/** Every changed observation file of one folder; a bad folder or file is rejected on its own. */
function scanFolder(deps: ObservationImportDeps, epicId: string | null, found: ObservationFile[], rejected: Rejection[]): void {
  const dir = ownedPaths(deps.layout).observationsDir(epicId)
  let names: string[]
  try {
    names = listNames(deps, dir)
  } catch (error: unknown) {
    rejected.push({ path: displayPath(deps.layout, dir), message: messageOf(error) })
    return
  }
  for (const name of names) {
    try {
      const file = readObservationFile(deps, epicId, name)
      if (file !== null) {
        found.push(file)
      }
    } catch (error: unknown) {
      rejected.push({ path: `${displayPath(deps.layout, dir)}/${name}`, message: messageOf(error) })
    }
  }
}

function markSynced(db: Db, observationId: string, hash: string, now: string): void {
  db.run(
    `INSERT INTO sync_state (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
     VALUES ('metric_observation', ?, ?, 0, ?, NULL, ?)
     ON CONFLICT(kind, entity_id) DO UPDATE SET exported_hash = excluded.exported_hash,
       imported_hash = excluded.imported_hash, conflict = NULL, updated_at = excluded.updated_at`,
    observationId,
    hash,
    hash,
    now
  )
}

/**
 * Sorts the changed files: an id named by files in more than one folder is a conflict (each folder fixes its epic, so
 * they cannot agree) and none of them imports; an id stored here with the same payload is only marked synced (the
 * local row, with its own `recordedAt`, stays); a different payload is rejected. Returns the files to insert.
 */
function planFiles(deps: ObservationImportDeps, found: ObservationFile[], now: string, rejected: Rejection[]): ObservationFile[] {
  const byId = new Map<string, ObservationFile[]>()
  for (const file of found) {
    byId.set(file.observation.observationId, [...(byId.get(file.observation.observationId) ?? []), file])
  }
  const fresh: ObservationFile[] = []
  for (const [observationId, files] of byId) {
    const [file] = files
    if (file === undefined) {
      continue
    }
    if (files.length > 1) {
      const message = `Metric observation ${observationId} is recorded in ${files.map((item) => item.path).join(' and ')}; one observation has one record, so neither was imported.`
      rejected.push(...files.map((item) => ({ path: item.path, message })))
      continue
    }
    const known = storedObservation(deps.db, observationId)
    if (known === undefined) {
      fresh.push(file)
    } else if (observationPayloadHash(known) === observationPayloadHash(file.observation)) {
      markSynced(deps.db, observationId, file.trackedHash, now)
    } else {
      const message = `Metric observation ${observationId} is already recorded here with a different payload; observations are never rewritten, so the file was not imported.`
      rejected.push({ path: file.path, message })
    }
  }
  return fresh
}

/**
 * Inserts the new observations in passes: each is checked against what this database holds, including observations
 * inserted by an earlier pass, so one citing an observation that cannot be imported is never stored with a dangling
 * reference. Passes repeat while any insert succeeds; what is left is rejected with its last reason.
 */
function insertFiles(deps: ObservationImportDeps, fresh: ObservationFile[], now: string, rejected: Rejection[]): string[] {
  const imported: string[] = []
  // Every file still pending after the first pass failed in the pass before, so each carries that pass's reason.
  let pending = fresh.map((file) => ({ file, reason: '' }))
  let inserted = true
  while (pending.length > 0 && inserted) {
    inserted = false
    const left: { file: ObservationFile; reason: string }[] = []
    for (const { file } of pending) {
      try {
        deps.db.tx(() => {
          checkObservationReferences(deps.db, file.observation, new Map())
          insertObservationRow(deps.db, file.observation)
          markSynced(deps.db, file.observation.observationId, file.trackedHash, now)
        })
        imported.push(file.observation.observationId)
        inserted = true
      } catch (error: unknown) {
        left.push({ file, reason: messageOf(error) })
      }
    }
    pending = left
  }
  rejected.push(...pending.map(({ file, reason }) => ({ path: file.path, message: `Could not be applied: ${reason}` })))
  return imported
}

/** The observation folders a targeted reconcile reads: the project level or not, and those of the epics it names. */
export interface ObservationScope {
  projectLevel: boolean
  epics: ReadonlySet<string>
}

/**
 * Imports the observation files of the project level and of every epic this database holds (with `scope`, only the
 * folders it names, of epics held here). Returns the ids imported and the files rejected (bad, conflicting, or naming a
 * record this database does not hold).
 */
export function importObservations(deps: ObservationImportDeps, now: string, scope?: ObservationScope): { imported: string[]; rejected: Rejection[] } {
  const found: ObservationFile[] = []
  const rejected: Rejection[] = []
  const epicIds = deps.db.all<{ id: string }>('SELECT id FROM epics ORDER BY id').map((row) => row.id)
  const folders = scope === undefined ? [null, ...epicIds] : [...(scope.projectLevel ? [null] : []), ...epicIds.filter((id) => scope.epics.has(id))]
  for (const epicId of folders) {
    scanFolder(deps, epicId, found, rejected)
  }
  const imported = insertFiles(deps, planFiles(deps, found, now, rejected), now, rejected)
  return { imported, rejected }
}
