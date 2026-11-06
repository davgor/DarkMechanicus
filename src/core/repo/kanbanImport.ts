/**
 * Reconcile for Kanban cards: `.darkmechanicus/kanban/<cardId>/card.json` (the definition) and one immutable
 * `events/<eventId>.json` per transition.
 *
 * Every entry is untrusted, exactly like epic records: only directories named by a card id are read, through contained
 * owned paths (links, junctions and files where a directory belongs are refused), within the record size bound, and
 * every file must hold a strict record that names the card of its folder and the event of its file name. A bad file
 * rejects its whole card (nothing of it is applied, so its event stream never has a gap), and never stops the other
 * cards; a `kanban` that is a link, redirects outside or is not a directory is rejected and read as empty.
 *
 * A card's definition is imported unless a local edit waits to be exported: that is a conflict, and the local card is
 * kept. Events are immutable: one already held here with other content is a conflict, never an overwrite. New events are
 * inserted, and the card's lane, attempts, pending Play and Done summary are rebuilt from its whole event stream. What
 * no event carries stays as this database holds it: an attempt's claim secret and progress note, and the lease and
 * heartbeat this computer extended. An attempt imported from another computer keeps that computer's id and gets a
 * secret no token was ever made for, so this computer refuses to report on it (`card_not_owned`).
 */
import { randomBytes } from 'node:crypto'
import { KANBAN_OPEN_ATTEMPT_STATES, type KanbanAttemptState, type KanbanLane } from '../../shared/domain/kanban'
import { contentHash } from '../canonical'
import { type Db, parseJson, toJson } from '../db/database'
import { fail } from '../errors'
import { insertOwnedRow } from './attachmentImport'
import { type FileHashCache, readUnlessSynced } from './fileHashes'
import { assertContained, displayPath, ownedPaths } from './paths'
import {
  type KanbanCardRecord,
  kanbanCardRecord,
  type KanbanEventRecord,
  kanbanEventRecord,
  parseRecord,
  readKanbanEventRecord,
  readOwnedText,
  trackedKanbanCardHash,
  trackedKanbanEventHash
} from './portable'
import type { FsAdapter, RepoLayout } from './types'

/** Card folders `kanban/` may hold before the whole directory is refused unread. */
const MAX_KANBAN_CARDS = 10_000
/** Event files one card may hold before the card is refused unread. */
const MAX_KANBAN_EVENTS_PER_CARD = 10_000

const JSON_SUFFIX = '.json'

interface KanbanImportDeps {
  db: Db
  layout: RepoLayout
  fs: FsAdapter
  fileHashes: FileHashCache
}

interface Rejection {
  path: string
  message: string
}

interface StagedEvent {
  eventId: string
  record: KanbanEventRecord
  trackedHash: string
}

interface StagedCard {
  cardId: string
  /** The card's folder, as rejections name it. */
  path: string
  /** A changed card record to apply; null when `card.json` matches the last sync or is in conflict. */
  definition: { record: KanbanCardRecord; trackedHash: string } | null
  /** Events this database does not hold yet. */
  events: StagedEvent[]
  /** Event files identical to events held here: only their sync record is written. */
  syncedEvents: StagedEvent[]
}

interface KanbanConflict {
  kind: 'kanban_card' | 'kanban_event'
  entityId: string
  cardId: string
  message: string
  /**
   * A card conflict's tracked record, noted as seen (`imported_hash`, and its generation) so the local edit's next
   * export may write over it once this reconcile has reported the conflict, at a later generation.
   */
  seen?: { hash: string; generation: number }
}

/** What a scan of `kanban/` found; `unchanged` holds `kanban:<cardId>` keys. */
export interface KanbanScan {
  cards: StagedCard[]
  unchanged: string[]
  conflicts: KanbanConflict[]
  rejected: Rejection[]
}

function reject(path: string, reason: string): never {
  return fail('import_rejected', `${path} ${reason}.`, { path })
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Entries of an owned directory, dot entries ignored; throws when it is a link or not a directory, or holds too many. */
function listOwnedDir(deps: KanbanImportDeps, dir: string, limit: { count: number; what: string }): string[] {
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
    .filter((name) => !name.startsWith('.'))
    .sort()
  if (names.length > limit.count) {
    reject(shown, `holds more than ${limit.count} ${limit.what}`)
  }
  return names
}

/** A tracked file this database last exported or imported with exactly this text, and not in conflict. */
function synced(db: Db, kind: KanbanConflict['kind'], entityId: string, hash: string): boolean {
  const row = db.get<{ exported_hash: string | null; imported_hash: string | null; conflict: string | null }>(
    'SELECT exported_hash, imported_hash, conflict FROM sync_state WHERE kind = ? AND entity_id = ?',
    kind,
    entityId
  )
  return row !== undefined && row.conflict === null && (row.exported_hash === hash || row.imported_hash === hash)
}

/** One owned record file's text: contained, a regular file, within the record size limit. */
function readRecordText(deps: KanbanImportDeps, file: string): string {
  const shown = displayPath(deps.layout, file)
  assertContained(deps.layout, deps.fs, file)
  if (deps.fs.isDirectory(file)) {
    reject(shown, 'is not a regular file')
  }
  return readOwnedText(deps, file) ?? reject(shown, 'is missing')
}

/** The card's `card.json` when it changed since the last sync, null when it did not. */
function readDefinition(deps: KanbanImportDeps, cardId: string, shownDir: string): StagedCard['definition'] {
  const file = ownedPaths(deps.layout).kanbanCardFile(cardId)
  assertContained(deps.layout, deps.fs, file)
  if (!deps.fs.exists(file) && !deps.fs.isSymlink(file)) {
    reject(shownDir, 'has no card.json')
  }
  const changed = readUnlessSynced(deps, file, {
    hashOf: trackedKanbanCardHash,
    synced: (hash) => synced(deps.db, 'kanban_card', cardId, hash),
    read: () => readRecordText(deps, file)
  })
  if (changed === null) {
    return null
  }
  const shown = displayPath(deps.layout, file)
  const record = parseRecord(kanbanCardRecord, changed.text, shown)
  if (record.id !== cardId) {
    reject(shown, 'names a different card than its folder')
  }
  return { record, trackedHash: changed.hash }
}

/** One event file named `<eventId>.json`; null when its text matches the last sync. */
function readEvent(deps: KanbanImportDeps, cardId: string, name: string): StagedEvent | null {
  const eventId = name.slice(0, -JSON_SUFFIX.length)
  const file = ownedPaths(deps.layout).kanbanEventFile(cardId, eventId)
  const changed = readUnlessSynced(deps, file, {
    hashOf: trackedKanbanEventHash,
    synced: (hash) => synced(deps.db, 'kanban_event', eventId, hash),
    read: () => readRecordText(deps, file)
  })
  if (changed === null) {
    return null
  }
  const shown = displayPath(deps.layout, file)
  const record = parseRecord(kanbanEventRecord, changed.text, shown)
  if (record.id !== eventId) {
    reject(shown, 'names a different event than its file name')
  }
  if (record.cardId !== cardId) {
    reject(shown, 'belongs to a different card than its folder')
  }
  return { eventId, record, trackedHash: changed.hash }
}

/** Every changed event file of a card; null when any is bad, each bad one reported under its own path. */
function readEvents(deps: KanbanImportDeps, cardId: string, scan: KanbanScan): StagedEvent[] | null {
  const dir = ownedPaths(deps.layout).kanbanEventsDir(cardId)
  const names = listOwnedDir(deps, dir, { count: MAX_KANBAN_EVENTS_PER_CARD, what: 'events' })
  const events: StagedEvent[] = []
  let clean = true
  for (const name of names.filter((entry) => entry.endsWith(JSON_SUFFIX))) {
    try {
      const event = readEvent(deps, cardId, name)
      if (event !== null) {
        events.push(event)
      }
    } catch (error: unknown) {
      clean = false
      scan.rejected.push({ path: `${displayPath(deps.layout, dir)}/${name}`, message: messageOf(error) })
    }
  }
  return clean ? events : null
}

function hasPendingCardExport(db: Db, cardId: string): boolean {
  const row = db.get<{ pending: number }>(
    "SELECT EXISTS (SELECT 1 FROM outbox WHERE kind = 'kanban_card' AND entity_id = ? AND state IN ('pending', 'failed')) AS pending",
    cardId
  )
  return row?.pending === 1
}

/** Sorts what changed into the card's staging: definitions unless a local edit waits, new events, and event conflicts. */
function stageCard(deps: KanbanImportDeps, card: StagedCard, found: { definition: StagedCard['definition']; events: StagedEvent[] }, scan: KanbanScan): void {
  const { cardId } = card
  if (found.definition !== null && hasPendingCardExport(deps.db, cardId)) {
    const message = `Tracked Kanban card ${cardId} changed while local card changes are waiting to be exported. The local card is kept, and its next export writes over the tracked record.`
    const seen = { hash: found.definition.trackedHash, generation: found.definition.record.generation }
    scan.conflicts.push({ kind: 'kanban_card', entityId: cardId, cardId, message, seen })
  } else {
    card.definition = found.definition
  }
  for (const event of found.events) {
    const known = readKanbanEventRecord(deps.db, event.eventId)
    if (known === null) {
      card.events.push(event)
    } else if (contentHash(known) === contentHash(event.record)) {
      card.syncedEvents.push(event)
    } else {
      const message = `Kanban event ${event.eventId} already exists with different content; its tracked file was not imported, as events are never rewritten.`
      scan.conflicts.push({ kind: 'kanban_event', entityId: event.eventId, cardId, message })
    }
  }
}

/** Reads one card folder; its problems are added to `scan`, and the card is staged, unchanged or left out. */
function scanCard(deps: KanbanImportDeps, name: string, scan: KanbanScan): void {
  const dir = ownedPaths(deps.layout).kanbanCardDir(name)
  const path = displayPath(deps.layout, dir)
  assertContained(deps.layout, deps.fs, dir)
  if (!deps.fs.isDirectory(dir)) {
    reject(path, 'is not a directory')
  }
  const definition = readDefinition(deps, name, path)
  const events = readEvents(deps, name, scan)
  if (events === null) {
    return
  }
  if (definition === null && events.length === 0) {
    scan.unchanged.push(`kanban:${name}`)
    return
  }
  const card: StagedCard = { cardId: name, path, definition: null, events: [], syncedEvents: [] }
  stageCard(deps, card, { definition, events }, scan)
  scan.cards.push(card)
}

/** Reads and validates every card of `kanban/`, staging what changed for import. */
export function scanKanban(deps: KanbanImportDeps): KanbanScan {
  const scan: KanbanScan = { cards: [], unchanged: [], conflicts: [], rejected: [] }
  let names: string[]
  try {
    names = listOwnedDir(deps, deps.layout.kanbanDir, { count: MAX_KANBAN_CARDS, what: 'cards' })
  } catch (error: unknown) {
    scan.rejected.push({ path: displayPath(deps.layout, deps.layout.kanbanDir), message: messageOf(error) })
    return scan
  }
  for (const name of names) {
    try {
      scanCard(deps, name, scan)
    } catch (error: unknown) {
      scan.rejected.push({ path: `${displayPath(deps.layout, deps.layout.kanbanDir)}/${name}`, message: messageOf(error) })
    }
  }
  return scan
}

function markSynced(db: Db, entry: { kind: KanbanConflict['kind']; entityId: string; hash: string; generation: number; now: string }): void {
  db.run(
    `INSERT INTO sync_state (kind, entity_id, exported_hash, generation, imported_hash, conflict, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(kind, entity_id) DO UPDATE SET exported_hash = excluded.exported_hash,
       generation = MAX(sync_state.generation, excluded.generation), imported_hash = excluded.imported_hash,
       conflict = NULL, updated_at = excluded.updated_at`,
    entry.kind,
    entry.entityId,
    entry.hash,
    entry.generation,
    entry.hash,
    entry.now
  )
}

/** Inserts a new card, or replaces an existing card's definition (its lane and attempts are rebuilt afterwards). */
function applyDefinition(db: Db, record: KanbanCardRecord): void {
  db.run(
    `INSERT INTO kanban_cards (id, key, title, body, acceptance_criteria_json, expected_artifacts_json, references_json,
       priority, size, lane, created_by_role, created_by_label, created_at, updated_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'backlog', ?, ?, ?, ?, 1)
     ON CONFLICT(id) DO UPDATE SET key = excluded.key, title = excluded.title, body = excluded.body,
       acceptance_criteria_json = excluded.acceptance_criteria_json, expected_artifacts_json = excluded.expected_artifacts_json,
       references_json = excluded.references_json, priority = excluded.priority, size = excluded.size,
       created_by_role = excluded.created_by_role, created_by_label = excluded.created_by_label,
       created_at = excluded.created_at, revision = kanban_cards.revision + 1`,
    record.id,
    record.key,
    record.title,
    record.body,
    toJson(record.acceptanceCriteria),
    toJson(record.expectedArtifacts),
    toJson(record.references),
    record.priority,
    record.size,
    record.createdBy.role,
    record.createdBy.label,
    record.createdAt,
    record.updatedAt
  )
  syncCardAttachments(db, record)
}

/**
 * Makes the card's owned image rows the record's list: a listed image with no row gets one without bytes (the restore
 * that follows an import fills it from the card's folder), and a row of the card the record no longer lists is deleted.
 */
function syncCardAttachments(db: Db, record: KanbanCardRecord): void {
  const listed = record.attachments ?? []
  const listedIds = new Set(listed.map((ref) => ref.id))
  const held = db.all<{ id: string }>("SELECT id FROM attachments WHERE owner_kind = 'kanban_card' AND owner_id = ?", record.id)
  for (const row of held.filter((item) => !listedIds.has(item.id))) {
    db.run('DELETE FROM attachments WHERE id = ?', row.id)
    db.run("DELETE FROM sync_state WHERE kind = 'attachment' AND entity_id = ?", row.id)
  }
  for (const ref of listed) {
    if (db.get('SELECT id FROM attachments WHERE id = ?', ref.id) === undefined) {
      insertOwnedRow(db, ref, { owner: 'kanban_card', ownerId: record.id, createdAt: record.updatedAt })
    }
  }
}

/**
 * Where a transition falls in a card's stream. Transitions made in one step can share a timestamp, so within one
 * millisecond the step orders them: a claim before its heartbeat, a submission before its review.
 */
const STREAM_STEP: Record<KanbanEventRecord['kind'], number> = {
  created: 0,
  updated: 1,
  played: 2,
  claimed: 3,
  running: 4,
  submitted: 5,
  failed: 6,
  lease_expired: 6,
  approved: 7,
  kicked_back: 7
}

function byStreamOrder(a: KanbanEventRecord, b: KanbanEventRecord): number {
  return a.createdAt.localeCompare(b.createdAt) || STREAM_STEP[a.kind] - STREAM_STEP[b.kind] || a.id.localeCompare(b.id)
}

function insertEvent(db: Db, record: KanbanEventRecord): void {
  db.run(
    `INSERT INTO kanban_events (id, card_id, kind, attempt_id, actor_role, actor_label, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    record.id,
    record.cardId,
    record.kind,
    record.attemptId,
    record.actor.role,
    record.actor.label,
    toJson(record.payload),
    record.createdAt
  )
}

interface EventRow {
  id: string
  card_id: string
  kind: string
  attempt_id: string | null
  actor_role: string
  actor_label: string
  payload_json: string
  created_at: string
}

/** The card's whole event stream as held here (local and imported), validated and in stream order. */
function cardEvents(db: Db, cardId: string, path: string): KanbanEventRecord[] {
  const events = db.all<EventRow>('SELECT * FROM kanban_events WHERE card_id = ?', cardId).map((row) => {
    const parsed = kanbanEventRecord.safeParse({
      format: 'darkmechanicus.kanban-event',
      formatVersion: 1,
      id: row.id,
      cardId: row.card_id,
      kind: row.kind,
      attemptId: row.attempt_id,
      actor: { role: row.actor_role, label: row.actor_label },
      payload: parseJson<unknown>(row.payload_json, null),
      createdAt: row.created_at
    })
    return parsed.success ? parsed.data : reject(path, `holds event ${row.id}, which is not a valid Kanban event`)
  })
  return events.sort(byStreamOrder)
}

interface RebuiltAttempt {
  id: string
  number: number
  state: KanbanAttemptState
  machineId: string
  leaseExpiresAt: string | null
  heartbeatAt: string | null
  outputsJson: string | null
  evidenceJson: string | null
  reviewComment: string | null
  createdAt: string
  submittedAt: string | null
  decidedAt: string | null
  /** The transition that closed it (failed, lapsed, approved or kicked back): the Play after it and the Done summary. */
  closedBy: KanbanEventRecord | null
}

type AttemptEvent = Exclude<KanbanEventRecord, { attemptId: null }>

/** Applies one later transition to its attempt. */
function stepAttempt(attempt: RebuiltAttempt, event: AttemptEvent): void {
  switch (event.kind) {
    case 'claimed':
      return
    case 'running':
      attempt.state = 'running'
      attempt.heartbeatAt = event.createdAt
      return
    case 'submitted':
      attempt.state = 'submitted'
      attempt.leaseExpiresAt = null
      attempt.submittedAt = event.createdAt
      attempt.outputsJson = toJson(event.payload.outputs)
      attempt.evidenceJson = toJson(event.payload.evidence)
      return
    case 'failed':
      attempt.state = 'failed'
      attempt.leaseExpiresAt = null
      attempt.closedBy = event
      return
    case 'lease_expired':
      attempt.state = 'lease_expired'
      attempt.leaseExpiresAt = event.payload.leaseExpiresAt
      attempt.closedBy = event
      return
    case 'approved':
      attempt.state = 'accepted'
      attempt.decidedAt = event.createdAt
      attempt.closedBy = event
      return
    case 'kicked_back':
      attempt.state = 'rejected'
      attempt.reviewComment = event.payload.comment
      attempt.decidedAt = event.createdAt
      attempt.closedBy = event
  }
}

/** Every attempt of the card from its events, each started by its `claimed` event and numbered consistently. */
function rebuildAttempts(events: KanbanEventRecord[], path: string): RebuiltAttempt[] {
  const attempts = new Map<string, RebuiltAttempt>()
  for (const event of events) {
    if (event.attemptId === null) {
      continue
    }
    const attempt = attempts.get(event.attemptId)
    if (event.kind === 'claimed') {
      if (attempt !== undefined) {
        reject(path, `claims attempt ${event.attemptId} twice`)
      }
      attempts.set(event.attemptId, {
        id: event.attemptId,
        number: event.payload.number,
        state: 'claimed',
        machineId: event.payload.machineId,
        leaseExpiresAt: event.payload.leaseExpiresAt,
        heartbeatAt: null,
        outputsJson: null,
        evidenceJson: null,
        reviewComment: null,
        createdAt: event.createdAt,
        submittedAt: null,
        decidedAt: null,
        closedBy: null
      })
      continue
    }
    if (attempt === undefined) {
      reject(path, `names attempt ${event.attemptId}, which has no claimed event`)
    }
    if (attempt.number !== event.payload.number) {
      reject(path, `gives attempt ${event.attemptId} two numbers`)
    }
    stepAttempt(attempt, event)
  }
  return [...attempts.values()].sort((a, b) => a.number - b.number)
}

interface LocalAttempt {
  card_id: string
  state: KanbanAttemptState
  lease_expires_at: string | null
  heartbeat_at: string | null
}

const LEASED_STATES: readonly KanbanAttemptState[] = ['claimed', 'running']

/**
 * Writes one rebuilt attempt. An attempt held here keeps its claim secret and progress note, and while it stays leased,
 * the lease and latest heartbeat this computer gave it; a new one gets a secret no token was ever made for.
 */
function writeAttempt(db: Db, cardId: string, attempt: RebuiltAttempt): void {
  const local = db.get<LocalAttempt>('SELECT card_id, state, lease_expires_at, heartbeat_at FROM kanban_attempts WHERE id = ?', attempt.id)
  if (local !== undefined && local.card_id !== cardId) {
    fail('import_rejected', `Kanban attempt ${attempt.id} belongs to another card.`)
  }
  const keepsLease = local !== undefined && LEASED_STATES.includes(local.state) && LEASED_STATES.includes(attempt.state)
  const values = [
    attempt.number,
    attempt.state,
    attempt.machineId,
    local !== undefined && keepsLease ? local.lease_expires_at : attempt.leaseExpiresAt,
    local?.heartbeat_at ?? attempt.heartbeatAt,
    attempt.outputsJson,
    attempt.evidenceJson,
    attempt.reviewComment,
    attempt.createdAt,
    attempt.submittedAt,
    attempt.decidedAt
  ]
  if (local === undefined) {
    db.run(
      `INSERT INTO kanban_attempts (number, state, machine_id, lease_expires_at, heartbeat_at, outputs_json, evidence_json,
         review_comment, created_at, submitted_at, decided_at, id, card_id, claim_secret)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ...values,
      attempt.id,
      cardId,
      randomBytes(24).toString('base64url')
    )
    return
  }
  db.run(
    `UPDATE kanban_attempts SET number = ?, state = ?, machine_id = ?, lease_expires_at = ?, heartbeat_at = ?, outputs_json = ?,
       evidence_json = ?, review_comment = ?, created_at = ?, submitted_at = ?, decided_at = ? WHERE id = ?`,
    ...values,
    attempt.id
  )
}

/** The lane the card's latest attempt puts it in; Backlog before any claim. */
function laneOf(latest: RebuiltAttempt | undefined): KanbanLane {
  if (latest === undefined) {
    return 'backlog'
  }
  if (latest.state === 'accepted') {
    return 'done'
  }
  return latest.state === 'submitted' ? 'ready_for_review' : 'in_progress'
}

/**
 * The Play waiting for a claim, if any: before the first claim, a Play; after a kick-back, the kick-back itself; after a
 * failure or a lapsed lease, a Play pressed once it closed. A claim consumes it, so a Play made before the latest claim
 * never counts again, and Plays pressed on two computers before they synced are one Play, the first.
 */
function pendingPlay(events: KanbanEventRecord[], latest: RebuiltAttempt | undefined): KanbanEventRecord | undefined {
  if (latest === undefined) {
    return events.find((event) => event.kind === 'played')
  }
  const closedBy = latest.closedBy
  if (closedBy === null || closedBy.kind === 'approved') {
    return undefined
  }
  if (closedBy.kind === 'kicked_back') {
    return closedBy
  }
  return events.find((event) => event.kind === 'played' && event.createdAt >= closedBy.createdAt)
}

/** The card's content revision: the highest one its create and edit events name. */
function contentRevision(events: KanbanEventRecord[]): number {
  return events.reduce((revision, event) => (event.kind === 'created' || event.kind === 'updated' ? Math.max(revision, event.payload.revision) : revision), 1)
}

/** When the card reached Done and its compact summary, from the approval that closed its latest attempt. */
function doneOf(latest: RebuiltAttempt | undefined): { at: string | null; summaryJson: string | null } {
  const closedBy = latest?.closedBy
  return closedBy?.kind === 'approved' ? { at: closedBy.createdAt, summaryJson: toJson(closedBy.payload.summary) } : { at: null, summaryJson: null }
}

/** The card's own columns from its stream: lane, pending Play, Done summary, last change and content revision. */
function rebuildCard(db: Db, cardId: string, events: KanbanEventRecord[], attempts: RebuiltAttempt[]): void {
  const latest = attempts[attempts.length - 1]
  const play = pendingPlay(events, latest)
  const done = doneOf(latest)
  const lastAt = events.reduce((at, event) => (event.createdAt > at ? event.createdAt : at), '')
  db.run(
    `UPDATE kanban_cards SET lane = ?, play_requested_at = ?, play_requested_by = ?, completed_at = ?, summary_json = ?,
       compacted_at = ?, updated_at = MAX(updated_at, ?), revision = MAX(revision, ?) WHERE id = ?`,
    laneOf(latest),
    play?.createdAt ?? null,
    play?.actor.label ?? null,
    done.at,
    done.summaryJson,
    done.at,
    lastAt,
    contentRevision(events),
    cardId
  )
}

/** Applies one staged card: its definition, its new events, and everything rebuilt from the whole stream. */
function applyCard(db: Db, card: StagedCard, now: string): void {
  if (card.definition !== null) {
    const { record, trackedHash } = card.definition
    const holder = db.get<{ id: string }>('SELECT id FROM kanban_cards WHERE key = ? AND id <> ?', record.key, record.id)
    if (holder !== undefined) {
      reject(card.path, `has key ${record.key}, which card ${holder.id} already holds here`)
    }
    applyDefinition(db, record)
    markSynced(db, { kind: 'kanban_card', entityId: card.cardId, hash: trackedHash, generation: record.generation, now })
  } else if (db.get('SELECT id FROM kanban_cards WHERE id = ?', card.cardId) === undefined) {
    reject(card.path, 'has no imported card record')
  }
  for (const event of [...card.events].sort((a, b) => byStreamOrder(a.record, b.record))) {
    insertEvent(db, event.record)
  }
  const events = cardEvents(db, card.cardId, card.path)
  const attempts = rebuildAttempts(events, card.path)
  // Closed attempts first, so one that closes never collides with the one-open-attempt index.
  const open = attempts.filter((item) => KANBAN_OPEN_ATTEMPT_STATES.includes(item.state))
  for (const attempt of [...attempts.filter((item) => !open.includes(item)), ...open]) {
    writeAttempt(db, card.cardId, attempt)
  }
  rebuildCard(db, card.cardId, events, attempts)
  for (const event of [...card.events, ...card.syncedEvents]) {
    markSynced(db, { kind: 'kanban_event', entityId: event.eventId, hash: event.trackedHash, generation: 0, now })
  }
}

/**
 * Records each conflict. A card conflict also notes the tracked record as seen, so the finalizer, which writes over no
 * card record this machine has not seen, lets the local edit's next export through, one generation later.
 */
function storeConflicts(db: Db, conflicts: KanbanConflict[], now: string): void {
  for (const conflict of conflicts) {
    db.run(
      `INSERT INTO sync_state (kind, entity_id, generation, imported_hash, conflict, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(kind, entity_id) DO UPDATE SET conflict = excluded.conflict, updated_at = excluded.updated_at,
         imported_hash = COALESCE(excluded.imported_hash, sync_state.imported_hash),
         generation = MAX(sync_state.generation, excluded.generation)`,
      conflict.kind,
      conflict.entityId,
      conflict.seen?.generation ?? 0,
      conflict.seen?.hash ?? null,
      conflict.message,
      now
    )
  }
}

/**
 * Applies staged cards, each under its own savepoint so one the database refuses (a key another card holds, a second
 * open attempt, a stream with a gap) is reported without undoing the others, and records conflicts. Returns the imported
 * `kanban:<cardId>` keys (cards whose definition or events changed) and every rejection, the scan's too.
 */
export function applyKanban(db: Db, scan: KanbanScan, now: string): { imported: string[]; rejected: Rejection[] } {
  const imported: string[] = []
  const rejected = [...scan.rejected]
  for (const card of scan.cards) {
    try {
      db.tx(() => applyCard(db, card, now))
      if (card.definition !== null || card.events.length > 0) {
        imported.push(`kanban:${card.cardId}`)
      }
    } catch (error: unknown) {
      rejected.push({ path: card.path, message: `Could not be applied: ${messageOf(error)}` })
    }
  }
  storeConflicts(db, scan.conflicts, now)
  return { imported, rejected }
}
