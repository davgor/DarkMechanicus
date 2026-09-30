/**
 * Git-tracked record formats under `.darkmechanicus/`. Every file is parsed as untrusted input
 * (size bound, merge-marker check, JSON, strict schema); builders produce the same validated shapes
 * from local database rows, so the finalizer never writes a record the importer would reject.
 */
import { z } from 'zod'
import { ATTEMPT_STATES, OPEN_ATTEMPT_STATES, RUN_STATES } from '../../shared/domain/status'
import type { SessionRole } from '../../shared/domain/views'
import { contentHash } from '../canonical'
import { type Db, parseJson } from '../db/database'
import { fail } from '../errors'
import { type IdKind, isStableId, STABLE_ID_PATTERN } from '../ids'
import {
  artifactRef,
  capabilityProfile,
  checkResult,
  commentBody,
  criterionResult,
  epicBranch,
  LIMITS,
  planBundle,
  profileName,
  workStatus
} from '../schemas'
import { assertContained, displayPath } from './paths'
import type { FsAdapter, RepoLayout } from './types'

export const MAX_RECORD_BYTES = 8 * 1024 * 1024
/** A comment file holds at most 20,000 characters of Markdown; anything far larger is not a comment. */
export const MAX_COMMENT_RECORD_BYTES = 256 * 1024
export const KEY_PREFIX_PATTERN = /^[A-Z][A-Z0-9]{0,11}$/
const MERGE_MARKER_PATTERN = /^(?:<{7} |>{7} |\|{7} |={7}\r?$)/m
const MAX_ATTEMPTS = 10_000
const MAX_REPORTS = 5_000
const MAX_CHECKPOINTS = 1_000

const idOf = (kind: IdKind) => z.string().refine((value) => isStableId(value, kind), { message: `Expected a ${kind} id` })
const anyStableId = z.string().regex(STABLE_ID_PATTERN)
const isoTime = z.iso.datetime({ offset: true })
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const opaqueHash = z.string().min(1).max(200)
const label = z.string().max(LIMITS.label)
const shortText = z.string().max(LIMITS.shortText)
const markdown = z.string().max(LIMITS.markdown)
const textList = z.array(shortText).max(LIMITS.listItems)
const positiveInt = z.number().int().min(1)
const criterionResults = z.array(criterionResult).max(LIMITS.criteria)

export const projectRecord = z.strictObject({
  format: z.literal('darkmechanicus.project'),
  formatVersion: z.literal(1),
  projectId: idOf('project'),
  name: z.string().min(1).max(200),
  keyPrefix: z.string().regex(KEY_PREFIX_PATTERN),
  createdAt: isoTime
})
export type ProjectRecord = z.infer<typeof projectRecord>

export const epicPointerRecord = z.strictObject({
  format: z.literal('darkmechanicus.epic-pointer'),
  formatVersion: z.literal(1),
  epicId: idOf('epic'),
  revisionId: idOf('revision'),
  revisionNumber: positiveInt,
  contentHash: sha256,
  generation: positiveInt,
  updatedAt: isoTime
})
export type EpicPointerRecord = z.infer<typeof epicPointerRecord>

const epicOutcome = z.strictObject({
  summary: markdown,
  successCriteria: criterionResults,
  recordedAt: isoTime.nullable().default(null),
  runId: idOf('run').nullable().default(null)
})

export const epicStateRecord = z.strictObject({
  format: z.literal('darkmechanicus.epic-state'),
  formatVersion: z.literal(1),
  epicId: idOf('epic'),
  title: z.string().min(1).max(LIMITS.title),
  status: workStatus,
  branch: epicBranch.nullable(),
  provenance: z.strictObject({ sourceEpicId: anyStableId, note: shortText }).nullable(),
  outcome: epicOutcome.nullable(),
  createdAt: isoTime,
  completedAt: isoTime.nullable(),
  ticketStatuses: z
    .record(idOf('ticket'), workStatus)
    .refine((statuses) => Object.keys(statuses).length <= LIMITS.tickets, {
      message: `At most ${LIMITS.tickets} ticket statuses`
    }),
  generation: positiveInt,
  updatedAt: isoTime
})
export type EpicStateRecord = z.infer<typeof epicStateRecord>

export const snapshotRecord = z
  .strictObject({
    format: z.literal('darkmechanicus.plan-snapshot'),
    formatVersion: z.literal(1),
    epicId: idOf('epic'),
    revisionId: idOf('revision'),
    number: positiveInt,
    baseRevisionId: idOf('revision').nullable(),
    contentHash: sha256,
    createdAt: isoTime,
    savedAt: isoTime,
    bundle: planBundle
  })
  .refine((record) => contentHash(record.bundle) === record.contentHash, {
    message: 'Snapshot contentHash does not match its bundle',
    path: ['contentHash']
  })
export type SnapshotRecord = z.infer<typeof snapshotRecord>

const workerInfo = z.strictObject({
  sessionId: z.string().max(64).nullable().default(null),
  label,
  modelId: label.nullable().default(null),
  hostId: label.nullable().default(null),
  catalogRevision: label.nullable().default(null),
  rationale: shortText.nullable().default(null)
})

const attemptOutputs = z.strictObject({
  summary: markdown,
  artifacts: z.array(artifactRef).max(LIMITS.references).default([]),
  commits: z.array(z.string().max(200)).max(LIMITS.listItems).default([]),
  changedFiles: z.array(shortText).max(5_000).default([]),
  branch: z.string().max(255).nullable().default(null)
})

const attemptEvidence = z.strictObject({
  checks: z.array(checkResult).max(LIMITS.listItems).default([]),
  criteria: criterionResults.default([]),
  notes: markdown.default('')
})

const attemptFailure = z.strictObject({
  reason: shortText,
  details: markdown.default(''),
  retryable: z.boolean().default(false)
})

const attemptDecision = z.strictObject({
  outcome: z.enum(['accepted', 'rejected']),
  notes: markdown.default(''),
  reasons: textList.default([]),
  decidedBy: label.nullable().default(null),
  criteria: criterionResults.optional()
})

const attemptRecord = z.strictObject({
  id: idOf('attempt'),
  ticketId: idOf('ticket'),
  number: z.number().int().min(0),
  kind: z.enum(['work', 'carry_forward']),
  state: z.enum(ATTEMPT_STATES),
  fencingToken: z.number().int().min(0),
  worker: workerInfo,
  revisionId: idOf('revision'),
  ticketContentHash: opaqueHash,
  outputs: attemptOutputs.nullable(),
  evidence: attemptEvidence.nullable(),
  failure: attemptFailure.nullable(),
  decision: attemptDecision.nullable(),
  createdAt: isoTime,
  updatedAt: isoTime,
  submittedAt: isoTime.nullable(),
  decidedAt: isoTime.nullable(),
  reconciledAt: isoTime.nullable(),
  supersededAt: isoTime.nullable()
})

const reportContent = z.strictObject({
  summary: markdown,
  accepted: textList.default([]),
  failed: textList.default([]),
  blocked: textList.default([]),
  changes: z
    .strictObject({ files: z.array(shortText).max(5_000), commits: textList })
    .default({ files: [], commits: [] }),
  checks: z.array(checkResult).max(LIMITS.listItems).default([]),
  risks: textList.default([]),
  followUps: z
    .array(z.strictObject({ title: z.string().min(1).max(LIMITS.title), body: markdown.default('') }))
    .max(LIMITS.listItems)
    .default([]),
  exitCriteria: criterionResults.default([]),
  epicOutcome: z.strictObject({ summary: markdown, successCriteria: criterionResults }).nullable().default(null)
})

const reportRecord = z.strictObject({
  id: idOf('report'),
  sprintId: idOf('sprint'),
  reportRevision: positiveInt,
  contentHash: opaqueHash,
  content: reportContent,
  submittedBy: label.nullable(),
  createdAt: isoTime
})

const checkpointRecord = z.strictObject({
  id: idOf('checkpoint'),
  sprintId: idOf('sprint'),
  reportId: idOf('report'),
  outcome: z.enum(['advanced', 'completed']),
  policy: z.enum(['human', 'auto']),
  decidedBy: label.nullable(),
  decidedAt: isoTime
})

const runHistoryShape = z.strictObject({
  format: z.literal('darkmechanicus.run'),
  formatVersion: z.literal(1),
  runId: idOf('run'),
  epicId: idOf('epic'),
  number: positiveInt,
  revisionId: idOf('revision'),
  state: z.enum(RUN_STATES),
  activeSprintId: idOf('sprint').nullable(),
  host: z.strictObject({ label, type: label, catalogId: anyStableId.nullable().optional() }).nullable(),
  hostCatalogId: idOf('hostCatalog').nullable(),
  skillVersion: z.string().max(50).nullable(),
  ownerMachineId: idOf('machine'),
  pauseReason: shortText.nullable(),
  createdAt: isoTime,
  startedAt: isoTime.nullable(),
  updatedAt: isoTime,
  endedAt: isoTime.nullable(),
  attempts: z.array(attemptRecord).max(MAX_ATTEMPTS),
  reports: z.array(reportRecord).max(MAX_REPORTS),
  checkpoints: z.array(checkpointRecord).max(MAX_CHECKPOINTS)
})
type RunHistoryShape = z.infer<typeof runHistoryShape>

function firstDuplicate(values: string[]): string | undefined {
  const seen = new Set<string>()
  return values.find((value) => {
    if (seen.has(value)) {
      return true
    }
    seen.add(value)
    return false
  })
}

/** Row invariants the database enforces with unique indexes, checked before anything is applied. */
const RUN_UNIQUENESS: { what: string; path: string; keys: (record: RunHistoryShape) => string[] }[] = [
  { what: 'attempt id', path: 'attempts', keys: (record) => record.attempts.map((item) => item.id) },
  {
    what: 'attempt number for a ticket',
    path: 'attempts',
    keys: (record) => record.attempts.map((item) => `${item.ticketId}#${item.number}`)
  },
  {
    what: 'open attempt for a ticket',
    path: 'attempts',
    keys: (record) =>
      record.attempts.filter((item) => OPEN_ATTEMPT_STATES.includes(item.state)).map((item) => item.ticketId)
  },
  { what: 'report id', path: 'reports', keys: (record) => record.reports.map((item) => item.id) },
  {
    what: 'report revision for a sprint',
    path: 'reports',
    keys: (record) => record.reports.map((item) => `${item.sprintId}#${item.reportRevision}`)
  },
  { what: 'checkpoint id', path: 'checkpoints', keys: (record) => record.checkpoints.map((item) => item.id) }
]

const SESSION_ROLES = ['desktop', 'planner', 'orchestrator', 'worker', 'reviewer'] as const satisfies readonly SessionRole[]

/**
 * One immutable file per comment (`epics/<epicId>/comments/<commentId>.json`), so concurrent writers
 * on different machines never edit the same file and merges stay trivial.
 */
export const commentRecord = z.strictObject({
  format: z.literal('darkmechanicus.comment'),
  formatVersion: z.literal(1),
  id: idOf('comment'),
  epicId: idOf('epic'),
  // Plan bundles accept any stable id for a ticket, so a comment's ticket reference does too.
  ticketId: anyStableId.nullable(),
  body: commentBody,
  author: z.strictObject({ role: z.enum(SESSION_ROLES), label }),
  createdAt: isoTime
})
export type CommentRecord = z.infer<typeof commentRecord>

/**
 * A named capability profile. The local save revision is not tracked: it is each database's own
 * optimistic-concurrency counter, and imports bump it.
 */
export const profileRecord = z.strictObject({
  format: z.literal('darkmechanicus.profile'),
  formatVersion: z.literal(1),
  name: profileName,
  description: z.string().max(LIMITS.profileDescription),
  capability: capabilityProfile,
  createdAt: isoTime,
  updatedAt: isoTime
})
export type ProfileRecord = z.infer<typeof profileRecord>

export const runHistoryRecord = runHistoryShape.superRefine((record, ctx) => {
  for (const rule of RUN_UNIQUENESS) {
    const duplicate = firstDuplicate(rule.keys(record))
    if (duplicate !== undefined) {
      ctx.addIssue({ code: 'custom', message: `Duplicate ${rule.what}: ${duplicate}`, path: [rule.path] })
    }
  }
})
export type RunHistoryRecord = z.infer<typeof runHistoryRecord>

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0]
  const where = issue !== undefined && issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)'
  return `${where}: ${issue?.message ?? 'invalid'}`
}

function reject(path: string, reason: string): never {
  return fail('import_rejected', `${path} ${reason}.`, { path })
}

/**
 * Parses untrusted record text. Rejects (`import_rejected`, naming `path`) oversized text,
 * unresolved merge markers, invalid JSON, and schema violations (naming the first issue).
 */
export function parseRecord<T>(schema: z.ZodType<T>, text: string, path: string): T {
  if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) {
    reject(path, 'is larger than the 8 MiB record limit')
  }
  if (MERGE_MARKER_PATTERN.test(text)) {
    reject(path, 'contains unresolved merge conflict markers')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    reject(path, 'is not valid JSON')
  }
  const result = schema.safeParse(value)
  if (!result.success) {
    reject(path, `is not a valid record: ${describeIssue(result.error)}`)
  }
  return result.data
}

interface RecordEnv {
  layout: RepoLayout
  fs: FsAdapter
}

/**
 * Reads an owned record file as untrusted text after the containment check. Returns null when the
 * file is missing; rejects empty (including FIFOs and devices) and oversized files unread.
 */
export function readOwnedText(env: RecordEnv, path: string): string | null {
  assertContained(env.layout, env.fs, path)
  const size = env.fs.fileSize(path)
  if (size < 0) {
    return null
  }
  const shown = displayPath(env.layout, path)
  if (size === 0) {
    reject(shown, 'is empty')
  }
  if (size > MAX_RECORD_BYTES) {
    reject(shown, 'is larger than the 8 MiB record limit')
  }
  return env.fs.readFile(path)
}

export function readOwnedRecord<T>(env: RecordEnv, schema: z.ZodType<T>, path: string): T | null {
  const text = readOwnedText(env, path)
  return text === null ? null : parseRecord(schema, text, displayPath(env.layout, path))
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

/** Change-detection hash of an epic's tracked pointer + state texts (CRLF-insensitive for checkouts with autocrlf). */
export function trackedEpicHash(pointerText: string, stateText: string): string {
  return contentHash([normalizeNewlines(pointerText), normalizeNewlines(stateText)])
}

/** Change-detection hash of a run history file's text. */
export function trackedRunHash(text: string): string {
  return contentHash([normalizeNewlines(text)])
}

/** Change-detection hash of one comment file's text. */
export function trackedCommentHash(text: string): string {
  return contentHash(['comment', normalizeNewlines(text)])
}

/** Change-detection hash of a profile record's text (CRLF-insensitive, like the others). */
export function trackedProfileHash(text: string): string {
  return contentHash([normalizeNewlines(text)])
}

function exportable<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    fail('internal', `Cannot export ${what}: ${describeIssue(result.error)}`)
  }
  return result.data
}

interface RevisionRow {
  id: string
  epic_id: string
  number: number
  base_revision_id: string | null
  content_hash: string
  bundle_json: string
  created_at: string
  saved_at: string | null
}

export function buildSnapshotRecord(db: Db, revisionId: string): SnapshotRecord {
  const row = db.get<RevisionRow>('SELECT * FROM plan_revisions WHERE id = ?', revisionId)
  if (row === undefined) {
    fail('not_found', `Revision ${revisionId} does not exist.`)
  }
  const record = {
    format: 'darkmechanicus.plan-snapshot',
    formatVersion: 1,
    epicId: row.epic_id,
    revisionId: row.id,
    number: row.number,
    baseRevisionId: row.base_revision_id,
    contentHash: row.content_hash,
    createdAt: row.created_at,
    // A pending revision is dated by its Save request, so a retried flush writes identical bytes.
    savedAt: row.saved_at ?? row.created_at,
    bundle: parseJson<unknown>(row.bundle_json, null)
  }
  return exportable(snapshotRecord, record, `snapshot ${revisionId}`)
}

interface EpicRow {
  id: string
  title: string
  status: string
  branch_json: string | null
  provenance_json: string | null
  outcome_json: string | null
  created_at: string
  completed_at: string | null
}

export function buildEpicStateRecord(
  db: Db,
  epicId: string,
  meta: { generation: number; updatedAt: string }
): EpicStateRecord {
  const epic = db.get<EpicRow>('SELECT * FROM epics WHERE id = ?', epicId)
  if (epic === undefined) {
    fail('not_found', `Epic ${epicId} does not exist.`)
  }
  const statuses = db.all<{ ticket_id: string; status: string }>(
    'SELECT ticket_id, status FROM ticket_status WHERE epic_id = ? ORDER BY ticket_id',
    epicId
  )
  const record = {
    format: 'darkmechanicus.epic-state',
    formatVersion: 1,
    epicId: epic.id,
    title: epic.title,
    status: epic.status,
    branch: parseJson<unknown>(epic.branch_json, null),
    provenance: parseJson<unknown>(epic.provenance_json, null),
    outcome: parseJson<unknown>(epic.outcome_json, null),
    createdAt: epic.created_at,
    completedAt: epic.completed_at,
    ticketStatuses: Object.fromEntries(statuses.map((row) => [row.ticket_id, row.status])),
    generation: meta.generation,
    updatedAt: meta.updatedAt
  }
  return exportable(epicStateRecord, record, `epic state ${epicId}`)
}

/** The pointer to `snapshot`, written last so it only ever names a complete, verified snapshot. */
export function buildEpicPointerRecord(
  snapshot: SnapshotRecord,
  meta: { generation: number; updatedAt: string }
): EpicPointerRecord {
  const record = {
    format: 'darkmechanicus.epic-pointer',
    formatVersion: 1,
    epicId: snapshot.epicId,
    revisionId: snapshot.revisionId,
    revisionNumber: snapshot.number,
    contentHash: snapshot.contentHash,
    generation: meta.generation,
    updatedAt: meta.updatedAt
  }
  return exportable(epicPointerRecord, record, `pointer for ${snapshot.epicId}`)
}

interface RunRow {
  id: string
  epic_id: string
  number: number
  revision_id: string
  state: string
  active_sprint_id: string | null
  host_json: string | null
  host_catalog_id: string | null
  skill_version: string | null
  owner_machine_id: string
  pause_reason: string | null
  created_at: string
  started_at: string | null
  updated_at: string
  ended_at: string | null
}

interface AttemptRow {
  id: string
  ticket_id: string
  number: number
  kind: string
  state: string
  fencing_token: number
  worker_json: string
  revision_id: string
  ticket_content_hash: string
  outputs_json: string | null
  evidence_json: string | null
  failure_json: string | null
  decision_json: string | null
  created_at: string
  updated_at: string
  submitted_at: string | null
  decided_at: string | null
  reconciled_at: string | null
  superseded_at: string | null
}

interface ReportRow {
  id: string
  sprint_id: string
  report_revision: number
  content_json: string
  content_hash: string
  submitted_by: string | null
  created_at: string
}

interface CheckpointRow {
  id: string
  sprint_id: string
  report_id: string
  outcome: string
  policy: string
  decided_by: string | null
  decided_at: string
}

function runFields(run: RunRow): Record<string, unknown> {
  return {
    format: 'darkmechanicus.run',
    formatVersion: 1,
    runId: run.id,
    epicId: run.epic_id,
    number: run.number,
    revisionId: run.revision_id,
    state: run.state,
    activeSprintId: run.active_sprint_id,
    host: parseJson<unknown>(run.host_json, null),
    hostCatalogId: run.host_catalog_id,
    skillVersion: run.skill_version,
    ownerMachineId: run.owner_machine_id,
    pauseReason: run.pause_reason,
    createdAt: run.created_at,
    startedAt: run.started_at,
    updatedAt: run.updated_at,
    endedAt: run.ended_at
  }
}

/** Claim secrets, leases, and heartbeats are machine-local and never leave the database. */
function attemptEntry(row: AttemptRow): Record<string, unknown> {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    number: row.number,
    kind: row.kind,
    state: row.state,
    fencingToken: row.fencing_token,
    // Session ids are machine-local; the worker's label/model identity is history.
    worker: { ...parseJson<Record<string, unknown>>(row.worker_json, {}), sessionId: null },
    revisionId: row.revision_id,
    ticketContentHash: row.ticket_content_hash,
    outputs: parseJson<unknown>(row.outputs_json, null),
    evidence: parseJson<unknown>(row.evidence_json, null),
    failure: parseJson<unknown>(row.failure_json, null),
    decision: parseJson<unknown>(row.decision_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at,
    decidedAt: row.decided_at,
    reconciledAt: row.reconciled_at,
    supersededAt: row.superseded_at
  }
}

function reportEntry(row: ReportRow): Record<string, unknown> {
  return {
    id: row.id,
    sprintId: row.sprint_id,
    reportRevision: row.report_revision,
    contentHash: row.content_hash,
    content: parseJson<unknown>(row.content_json, null),
    submittedBy: row.submitted_by,
    createdAt: row.created_at
  }
}

/** Approval grants are local authority: the checkpoint record keeps the decision, not the grant. */
function checkpointEntry(row: CheckpointRow): Record<string, unknown> {
  return {
    id: row.id,
    sprintId: row.sprint_id,
    reportId: row.report_id,
    outcome: row.outcome,
    policy: row.policy,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at
  }
}

export function buildRunHistoryRecord(db: Db, runId: string): RunHistoryRecord {
  const run = db.get<RunRow>('SELECT * FROM runs WHERE id = ?', runId)
  if (run === undefined) {
    fail('not_found', `Run ${runId} does not exist.`)
  }
  const record = {
    ...runFields(run),
    attempts: db.all<AttemptRow>('SELECT * FROM attempts WHERE run_id = ? ORDER BY id', runId).map(attemptEntry),
    reports: db.all<ReportRow>('SELECT * FROM sprint_reports WHERE run_id = ? ORDER BY id', runId).map(reportEntry),
    checkpoints: db.all<CheckpointRow>('SELECT * FROM checkpoints WHERE run_id = ? ORDER BY id', runId).map(checkpointEntry)
  }
  return exportable(runHistoryRecord, record, `run history ${runId}`)
}

interface CommentRow {
  id: string
  epic_id: string
  ticket_id: string | null
  body: string
  author_role: string
  author_label: string
  created_at: string
}

/** A comment row in its record shape, not validated (the importer compares tracked files with it); null when absent. */
export function readCommentRecord(db: Db, commentId: string): Record<string, unknown> | null {
  const row = db.get<CommentRow>('SELECT * FROM comments WHERE id = ?', commentId)
  if (row === undefined) {
    return null
  }
  return {
    format: 'darkmechanicus.comment',
    formatVersion: 1,
    id: row.id,
    epicId: row.epic_id,
    ticketId: row.ticket_id,
    body: row.body,
    author: { role: row.author_role, label: row.author_label },
    createdAt: row.created_at
  }
}

export function buildCommentRecord(db: Db, commentId: string): CommentRecord {
  const record = readCommentRecord(db, commentId) ?? fail('not_found', `Comment ${commentId} does not exist.`)
  return exportable(commentRecord, record, `comment ${commentId}`)
}

interface ProfileRow {
  name: string
  description: string
  capability_json: string
  created_at: string
  updated_at: string
}

export function buildProfileRecord(db: Db, name: string): ProfileRecord {
  const row = db.get<ProfileRow>('SELECT * FROM profiles WHERE name = ?', name)
  if (row === undefined) {
    fail('not_found', `Profile ${name} does not exist.`)
  }
  const record = {
    format: 'darkmechanicus.profile',
    formatVersion: 1,
    name: row.name,
    description: row.description,
    capability: parseJson<unknown>(row.capability_json, null),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
  return exportable(profileRecord, record, `profile ${name}`)
}
