/**
 * Reconcile of learning files: `learnings/records/<learningId>.json` (a published learning with its lifecycle and
 * append-only history) and `learnings/integrations/<integrationId>.json` (an integration's recovery manifest).
 *
 * Each file is untrusted input, read the way `kanbanImport.ts` reads card folders: contained owned paths (links,
 * junctions and files where a directory belongs are refused), regular files within the size bound, a name built from a
 * valid id, the strict record schema (definition and manifest hashes included) and an id matching the file name. A bad
 * file is rejected on its own and reported; the rest import.
 *
 * A learning's definition and source never change: a file whose definition, source or creation differs from the stored
 * learning is rejected, never applied. Its lifecycle only moves forward: a file whose history extends the stored one is
 * applied (the learning retired, the new entries appended), one the stored history extends waits for this machine's
 * export, and one that diverged is a conflict. New learnings and lifecycle changes are checked as a set with the stored
 * learnings (`learningLinkProblems`): one whose replacement link would dangle or be one-sided is rejected, and so is
 * the partner that needed it.
 *
 * An integration manifest is recovery state only. Importing one never creates, activates or publishes a learning; it
 * stores the integration so the approved card's publication can resume. A manifest that changed on both machines at
 * the same revision, or while a local change waits to be exported, is a conflict and the local one is kept.
 *
 * Execution authority is machine-local (`learning_integrations.owner_machine_id`, never in a file): an imported
 * integration is stored inert, and a changed import of one this machine prepared clears its authority, so another
 * machine's file never drives this machine's integration. Only an unchanged file (this machine's own export) keeps it.
 * A changed file must keep the integration's identity: card, attempt, start, the manifest's run, sprint, drafts and
 * targets, and every result commit a target already landed.
 */
import { learningLinkProblems, type LearningRecord } from '../../shared/domain/learnings'
import { canonicalJson } from '../canonical'
import type { Db } from '../db/database'
import { fail } from '../errors'
import { type FileHashCache, readUnlessSynced } from './fileHashes'
import { assertContained, displayPath, ownedPaths } from './paths'
import {
  type LearningIntegrationRecord,
  learningIntegrationRecord,
  type LearningRecordFile,
  learningRecordFile,
  MAX_LEARNING_RECORD_BYTES,
  parseRecord,
  readLearningIntegrationRecord,
  readOwnedText,
  storedLearningHistory,
  trackedLearningIntegrationHash,
  trackedLearningRecordHash
} from './portable'
import { matchesSync } from './syncState'
import type { FsAdapter, RepoLayout } from './types'
import { toLearningView } from '../services/learnings'

interface LearningImportDeps {
  db: Db
  layout: RepoLayout
  fs: FsAdapter
  fileHashes: FileHashCache
}

interface Rejection {
  path: string
  message: string
}

type LearningSyncKind = 'learning_record' | 'learning_integration'

/** Files a learnings folder may hold before it is refused unread. */
const MAX_LEARNING_FILES = 10_000
const JSON_SUFFIX = '.json'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reject(path: string, reason: string): never {
  return fail('import_rejected', `${path} ${reason}.`, { path })
}

/** `.json` names of an owned folder, dot entries ignored; throws when it is a link, not a directory, or too full. */
function listNames(deps: LearningImportDeps, dir: string): string[] {
  if (!deps.fs.exists(dir) && !deps.fs.isSymlink(dir)) {
    return []
  }
  assertContained(deps.layout, deps.fs, dir)
  const shown = displayPath(deps.layout, dir)
  if (!deps.fs.isDirectory(dir)) {
    reject(shown, 'is not a directory')
  }
  const names = deps.fs
    .readdir(dir)
    .filter((name) => !name.startsWith('.') && name.endsWith(JSON_SUFFIX))
    .sort()
  if (names.length > MAX_LEARNING_FILES) {
    reject(shown, `holds more than ${MAX_LEARNING_FILES} files`)
  }
  return names
}

interface ChangedFile<T> {
  path: string
  value: T
  trackedHash: string
}

/** One record file's parsed value; null when its text is what this machine last exported or imported. */
function readFile<T>(
  deps: LearningImportDeps,
  spec: { kind: LearningSyncKind; id: string; file: string; parse: (text: string, shown: string) => T; hashOf: (text: string) => string }
): ChangedFile<T> | null {
  const shown = displayPath(deps.layout, spec.file)
  const changed = readUnlessSynced(deps, spec.file, {
    hashOf: spec.hashOf,
    synced: (hash) => matchesSync(deps.db, spec.kind, spec.id, hash),
    read: () => {
      assertContained(deps.layout, deps.fs, spec.file)
      if (deps.fs.isDirectory(spec.file)) {
        reject(shown, 'is not a regular file')
      }
      if (deps.fs.fileSize(spec.file) > MAX_LEARNING_RECORD_BYTES) {
        reject(shown, 'is larger than the 1 MiB learning record limit')
      }
      return readOwnedText(deps, spec.file) ?? reject(shown, 'is missing')
    }
  })
  return changed === null ? null : { path: shown, value: spec.parse(changed.text, shown), trackedHash: changed.hash }
}

/** Every changed file of one folder; a bad folder or file is rejected on its own. */
function scanFolder<T>(
  deps: LearningImportDeps,
  dir: string,
  readOne: (id: string) => ChangedFile<T> | null,
  rejected: Rejection[]
): ChangedFile<T>[] {
  let names: string[]
  try {
    names = listNames(deps, dir)
  } catch (error: unknown) {
    rejected.push({ path: displayPath(deps.layout, dir), message: messageOf(error) })
    return []
  }
  const found: ChangedFile<T>[] = []
  for (const name of names) {
    try {
      const file = readOne(name.slice(0, -JSON_SUFFIX.length))
      if (file !== null) {
        found.push(file)
      }
    } catch (error: unknown) {
      rejected.push({ path: `${displayPath(deps.layout, dir)}/${name}`, message: messageOf(error) })
    }
  }
  return found
}

function markSynced(db: Db, entry: { kind: LearningSyncKind; entityId: string; hash: string }, now: string): void {
  db.run(
    `INSERT INTO sync_state (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
     VALUES (?, ?, NULL, 0, ?, NULL, ?)
     ON CONFLICT(kind, entity_id) DO UPDATE SET imported_hash = excluded.imported_hash, conflict = NULL,
       updated_at = excluded.updated_at`,
    entry.kind,
    entry.entityId,
    entry.hash,
    now
  )
}

// ─── Learning records ──────────────────────────────────────────────────────────────────────────────────────────────

function readRecordFile(deps: LearningImportDeps, learningId: string): ChangedFile<LearningRecordFile> | null {
  const file = ownedPaths(deps.layout).learningRecordFile(learningId)
  return readFile(deps, {
    kind: 'learning_record',
    id: learningId,
    file,
    hashOf: trackedLearningRecordHash,
    parse: (text, shown) => {
      const record = parseRecord(learningRecordFile, text, shown)
      if (record.learning.id !== learningId) {
        reject(shown, 'names a different learning than its file name')
      }
      return record
    }
  })
}

/** What one changed learning file asks of this database. */
interface RecordChange {
  file: ChangedFile<LearningRecordFile>
  /** History entries this database does not hold yet (all of them for a new learning). */
  newEntries: LearningRecordFile['history']
  isNew: boolean
}

interface StoredLearning {
  learning: LearningRecord
  revision: number
  definitionHash: string
  history: LearningRecordFile['history']
}

function storedLearnings(db: Db): Map<string, StoredLearning> {
  const rows = db.all<Parameters<typeof toLearningView>[0]>('SELECT * FROM learning_records ORDER BY id')
  return new Map(
    rows.map((row) => {
      const { revision, definitionHash, ...learning } = toLearningView(row)
      return [row.id, { learning, revision, definitionHash, history: storedLearningHistory(db, row.id) }]
    })
  )
}

const sameJson = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)

function isPrefix<T>(shorter: readonly T[], longer: readonly T[]): boolean {
  return shorter.length <= longer.length && shorter.every((entry, index) => sameJson(entry, longer[index]))
}

/** Sorts one changed file against the stored learning: new, a forward lifecycle change, synced, waiting, or rejected. */
function classifyRecord(
  deps: LearningImportDeps,
  file: ChangedFile<LearningRecordFile>,
  stored: StoredLearning | undefined,
  now: string
): RecordChange | null {
  const incoming = file.value
  if (stored === undefined) {
    return { file, newEntries: incoming.history, isNew: true }
  }
  const { learning } = incoming
  const immutable = [
    incoming.definitionHash === stored.definitionHash,
    sameJson(learning.source, stored.learning.source),
    learning.createdAt === stored.learning.createdAt,
    learning.replaces === stored.learning.replaces
  ]
  if (immutable.includes(false)) {
    reject(file.path, `holds a different definition or source for learning ${learning.id}; a published learning never changes, so it was not imported`)
  }
  if (sameJson(incoming.history, stored.history)) {
    if (!sameJson(learning, stored.learning) || incoming.revision !== stored.revision) {
      reject(file.path, `records a different lifecycle for learning ${learning.id} than its history`)
    }
    markSynced(deps.db, { kind: 'learning_record', entityId: learning.id, hash: file.trackedHash }, now)
    return null
  }
  if (isPrefix(stored.history, incoming.history)) {
    return { file, newEntries: incoming.history.slice(stored.history.length), isNew: false }
  }
  if (isPrefix(incoming.history, stored.history)) {
    // This machine's later change is exported over it; nothing to import.
    return null
  }
  return reject(file.path, `changed learning ${learning.id} differently than this machine did; the local learning was kept`)
}

/** Ids whose history names a learning neither stored here nor among the candidates. */
function danglingHistory(candidates: ReadonlyMap<string, RecordChange>, known: ReadonlySet<string>): Set<string> {
  const dangling = new Set<string>()
  for (const [id, change] of candidates) {
    if (change.file.value.history.some((entry) => entry.relatedId !== null && !known.has(entry.relatedId))) {
      dangling.add(id)
    }
  }
  return dangling
}

/**
 * Drops candidates until the stored learnings, overlaid with the remaining candidates, have consistent replacement
 * links: a candidate with a link problem goes (with the reason), which may in turn expose its partner.
 */
function consistentCandidates(stored: ReadonlyMap<string, StoredLearning>, changes: RecordChange[], rejected: Rejection[]): RecordChange[] {
  const candidates = new Map(changes.map((change) => [change.file.value.learning.id, change]))
  for (;;) {
    const view = new Map<string, LearningRecord>([...stored].map(([id, entry]) => [id, entry.learning]))
    for (const [id, change] of candidates) view.set(id, change.file.value.learning)
    const problems = learningLinkProblems([...view.values()]).filter((problem) => candidates.has(problem.id))
    const dangling = danglingHistory(candidates, new Set(view.keys()))
    const dropped = new Map<string, string>(problems.map((problem) => [problem.id, `its replacement link is inconsistent (${problem.problem.replace('_', ' ')})`]))
    for (const id of dangling) if (!dropped.has(id)) dropped.set(id, 'its history names a learning this database does not hold')
    if (dropped.size === 0) {
      return [...candidates.values()]
    }
    for (const [id, reason] of dropped) {
      const change = candidates.get(id)
      if (change !== undefined) {
        rejected.push({ path: change.file.path, message: `${change.file.path} was not imported: ${reason}.` })
        candidates.delete(id)
      }
    }
  }
}

/** New learnings before the ones that replace them, so every `replaces_id` exists when its row is inserted. */
function insertionOrder(changes: RecordChange[]): RecordChange[] {
  const byId = new Map(changes.map((change) => [change.file.value.learning.id, change]))
  const ordered: RecordChange[] = []
  const placed = new Set<string>()
  const place = (change: RecordChange): void => {
    const { id, replaces } = change.file.value.learning
    if (placed.has(id)) return
    placed.add(id)
    const predecessor = replaces === null ? undefined : byId.get(replaces)
    if (predecessor !== undefined) place(predecessor)
    ordered.push(change)
  }
  changes.forEach(place)
  return ordered
}

function insertLearningRow(db: Db, record: LearningRecordFile): void {
  const { learning } = record
  const { title, rule, check, applicability, evidence, replaces } = learning
  db.run(
    `INSERT INTO learning_records (id, run_id, sprint_id, card_id, attempt_id, definition_json, definition_hash, state,
       replaces_id, replaced_by_id, created_at, retired_at, retired_reason, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    learning.id,
    learning.source.runId,
    learning.source.sprintId,
    learning.source.cardId,
    learning.source.attemptId,
    JSON.stringify({ title, rule, check, applicability, evidence, replaces }),
    record.definitionHash,
    learning.state,
    replaces,
    learning.createdAt,
    learning.retiredAt,
    learning.retiredReason,
    record.revision
  )
}

function appendEntries(db: Db, learning: LearningRecord, entries: LearningRecordFile['history']): void {
  for (const entry of entries) {
    db.run(
      `INSERT INTO learning_events (learning_id, kind, related_id, reason, revision, actor_role, actor_label,
         run_id, sprint_id, card_id, attempt_id, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      learning.id,
      entry.kind,
      entry.relatedId,
      entry.reason,
      entry.revision,
      entry.actor.role,
      entry.actor.label,
      learning.source.runId,
      learning.source.sprintId,
      learning.source.cardId,
      learning.source.attemptId,
      entry.at
    )
  }
}

/** Applies a consistent set of changes: rows first (predecessors first), then replacement links, then history. */
function applyRecordChanges(db: Db, changes: RecordChange[], now: string): void {
  const ordered = insertionOrder(changes)
  for (const { file, isNew } of ordered) {
    const { learning } = file.value
    if (isNew) {
      insertLearningRow(db, file.value)
    } else {
      db.run(
        'UPDATE learning_records SET state = ?, retired_at = ?, retired_reason = ?, revision = ? WHERE id = ?',
        learning.state,
        learning.retiredAt,
        learning.retiredReason,
        file.value.revision,
        learning.id
      )
    }
  }
  for (const { file } of ordered) {
    const { learning } = file.value
    db.run('UPDATE learning_records SET replaced_by_id = ? WHERE id = ?', learning.replacedBy, learning.id)
  }
  for (const { file, newEntries } of ordered) {
    appendEntries(db, file.value.learning, newEntries)
    markSynced(db, { kind: 'learning_record', entityId: file.value.learning.id, hash: file.trackedHash }, now)
  }
}

/**
 * Applies the set in one step; if the database refuses it, each change is tried alone so an unrelated learning still
 * imports, and what fails is rejected with the database's reason.
 */
function applyRecords(db: Db, changes: RecordChange[], now: string, rejected: Rejection[]): string[] {
  if (changes.length === 0) return []
  try {
    db.tx(() => applyRecordChanges(db, changes, now))
    return changes.map((change) => change.file.value.learning.id)
  } catch {
    const imported: string[] = []
    for (const change of changes) {
      try {
        db.tx(() => applyRecordChanges(db, [change], now))
        imported.push(change.file.value.learning.id)
      } catch (error: unknown) {
        rejected.push({ path: change.file.path, message: `Could not be applied: ${messageOf(error)}` })
      }
    }
    return imported
  }
}

function importRecords(deps: LearningImportDeps, now: string, rejected: Rejection[]): string[] {
  const dir = ownedPaths(deps.layout).learningRecordsDir()
  const files = scanFolder(deps, dir, (id) => readRecordFile(deps, id), rejected)
  const stored = storedLearnings(deps.db)
  const changes: RecordChange[] = []
  for (const file of files) {
    try {
      const change = classifyRecord(deps, file, stored.get(file.value.learning.id), now)
      if (change !== null) changes.push(change)
    } catch (error: unknown) {
      rejected.push({ path: file.path, message: messageOf(error) })
    }
  }
  return applyRecords(deps.db, consistentCandidates(stored, changes, rejected), now, rejected)
}

// ─── Learning integration recovery manifests ───────────────────────────────────────────────────────────────────────

function readIntegrationFile(deps: LearningImportDeps, integrationId: string): ChangedFile<LearningIntegrationRecord> | null {
  const file = ownedPaths(deps.layout).learningIntegrationFile(integrationId)
  return readFile(deps, {
    kind: 'learning_integration',
    id: integrationId,
    file,
    hashOf: trackedLearningIntegrationHash,
    parse: (text, shown) => {
      const record = parseRecord(learningIntegrationRecord, text, shown)
      if (record.id !== integrationId) {
        reject(shown, 'names a different learning integration than its file name')
      }
      return record
    }
  })
}

function hasPendingExport(db: Db, integrationId: string): boolean {
  return (
    db.get(
      "SELECT 1 FROM outbox WHERE kind = 'learning_integration' AND entity_id = ? AND state IN ('pending', 'failed')",
      integrationId
    ) !== undefined
  )
}

/** Stores an imported manifest. Either way the row ends inert: an imported state never carries execution authority. */
function writeIntegration(db: Db, record: LearningIntegrationRecord, isNew: boolean): void {
  const failure = record.failure === null ? null : JSON.stringify(record.failure)
  if (isNew) {
    db.run(
      `INSERT INTO learning_integrations (id, card_id, attempt_id, state, manifest_json, manifest_hash, failure_json, revision,
         created_at, updated_at, owner_machine_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      record.id,
      record.cardId,
      record.attemptId,
      record.state,
      JSON.stringify(record.manifest),
      record.manifestHash,
      failure,
      record.revision,
      record.createdAt,
      record.updatedAt
    )
    return
  }
  db.run(
    `UPDATE learning_integrations SET state = ?, manifest_json = ?, manifest_hash = ?, failure_json = ?, revision = ?, updated_at = ?,
       owner_machine_id = NULL
     WHERE id = ?`,
    record.state,
    JSON.stringify(record.manifest),
    record.manifestHash,
    failure,
    record.revision,
    record.updatedAt,
    record.id
  )
}

type StoredManifest = LearningIntegrationRecord['manifest']

/** What a changed manifest may not change: its run, sprint, approved drafts and targets, and any landed result commit. */
function manifestIdentityChanged(stored: StoredManifest, incoming: StoredManifest): boolean {
  const identity = (manifest: StoredManifest) => ({
    runId: manifest.runId,
    sprintId: manifest.sprintId,
    draftsHash: manifest.draftsHash,
    targets: manifest.targets.map((target) => [target.repository, target.branch, target.baseCommit])
  })
  if (!sameJson(identity(stored), identity(incoming))) return true
  return stored.targets.some((target, index) => target.resultCommit !== null && incoming.targets[index]?.resultCommit !== target.resultCommit)
}

/** Imports one manifest, or explains why not; returns whether this database changed. */
function importIntegration(deps: LearningImportDeps, file: ChangedFile<LearningIntegrationRecord>, now: string): boolean {
  const incoming = file.value
  const stored = readLearningIntegrationRecord(deps.db, incoming.id)
  if (stored === null) {
    deps.db.tx(() => {
      writeIntegration(deps.db, incoming, true)
      markSynced(deps.db, { kind: 'learning_integration', entityId: incoming.id, hash: file.trackedHash }, now)
    })
    return true
  }
  if (sameJson(stored, incoming)) {
    markSynced(deps.db, { kind: 'learning_integration', entityId: incoming.id, hash: file.trackedHash }, now)
    return false
  }
  if (stored.cardId !== incoming.cardId || stored.attemptId !== incoming.attemptId || stored.createdAt !== incoming.createdAt) {
    reject(file.path, `names another card, attempt or start for learning integration ${incoming.id}; it was not imported`)
  }
  if (manifestIdentityChanged(stored.manifest as StoredManifest, incoming.manifest)) {
    reject(file.path, `changes the run, sprint, approved drafts, targets or a landed result of learning integration ${incoming.id}; it was not imported`)
  }
  const localRevision = Number(stored.revision)
  if (incoming.revision < localRevision) {
    // This machine's later state is exported over it.
    return false
  }
  if (incoming.revision === localRevision || hasPendingExport(deps.db, incoming.id)) {
    reject(file.path, `changed learning integration ${incoming.id} while this machine changed it too; the local integration was kept`)
  }
  deps.db.tx(() => {
    writeIntegration(deps.db, incoming, false)
    markSynced(deps.db, { kind: 'learning_integration', entityId: incoming.id, hash: file.trackedHash }, now)
  })
  return true
}

function importIntegrations(deps: LearningImportDeps, now: string, rejected: Rejection[]): string[] {
  const dir = ownedPaths(deps.layout).learningIntegrationsDir()
  const imported: string[] = []
  for (const file of scanFolder(deps, dir, (id) => readIntegrationFile(deps, id), rejected)) {
    try {
      if (importIntegration(deps, file, now)) imported.push(file.value.id)
    } catch (error: unknown) {
      const message = messageOf(error)
      rejected.push({ path: file.path, message: message.includes(file.path) ? message : `Could not be applied: ${message}` })
    }
  }
  return imported
}

/**
 * Imports the learning record files and integration recovery manifests. Returns what was imported (`learning:<id>`,
 * `learning_integration:<id>`) and every file rejected, each on its own.
 */
export function importLearnings(deps: LearningImportDeps, now: string): { imported: string[]; rejected: Rejection[] } {
  const rejected: Rejection[] = []
  const records = importRecords(deps, now, rejected).map((id) => `learning:${id}`)
  const integrations = importIntegrations(deps, now, rejected).map((id) => `learning_integration:${id}`)
  return { imported: [...records, ...integrations], rejected }
}
