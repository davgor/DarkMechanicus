/** Fixtures for repository-layer tests: ids, error capture, and raw DB rows. Not shipped. */
import { contentHash } from '../core/canonical'
import type { Clock } from '../core/clock'
import type { Db } from '../core/db/database'
import { DomainError } from '../core/errors'
import { encodeBase32, ID_PREFIXES, type IdKind } from '../core/ids'
import type { FinalizerHooks } from '../core/repo/finalizer'
import { defaultCapabilityProfile, type PlanBundle } from '../shared/domain/bundle'
import type { AttemptState, RunState } from '../shared/domain/status'
import type { SessionRole } from '../shared/domain/views'

interface CapturedDomainError {
  code: string
  message: string
  details: Record<string, unknown> | undefined
}

/** Runs `action` and returns the DomainError it throws; other errors and success fail the test. */
export function domainErrorOf(action: () => unknown): CapturedDomainError {
  try {
    action()
  } catch (error: unknown) {
    if (error instanceof DomainError) {
      return { code: error.code, message: error.message, details: error.details }
    }
    throw error
  }
  throw new Error('Expected a DomainError, but the action succeeded.')
}

/** Async variant of `domainErrorOf`. */
export async function domainErrorOfAsync(action: () => Promise<unknown>): Promise<CapturedDomainError> {
  try {
    await action()
  } catch (error: unknown) {
    if (error instanceof DomainError) {
      return { code: error.code, message: error.message, details: error.details }
    }
    throw error
  }
  throw new Error('Expected a DomainError, but the action succeeded.')
}

/** A valid stable id of `kind` with a predictable counter, e.g. `idOf('epic', 1)`. */
export function idOf(kind: IdKind, n: number): string {
  return `${ID_PREFIXES[kind]}_${encodeBase32(BigInt(5000 + n), 26)}`
}

export const T0 = '2026-01-01T00:00:00.000Z'

interface EpicRowInput {
  id: string
  title?: string
  status?: 'backlog' | 'in_progress' | 'completed'
  currentRevisionId?: string | null
  branch?: unknown
  provenance?: unknown
  outcome?: unknown
  createdAt?: string
  completedAt?: string | null
}

function jsonOrNull(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value)
}

export function insertEpic(db: Db, input: EpicRowInput): void {
  db.run(
    `INSERT INTO epics (id, title, status, current_revision_id, branch_json, provenance_json, outcome_json,
       revision, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    input.id,
    input.title ?? 'Test epic',
    input.status ?? 'backlog',
    input.currentRevisionId ?? null,
    jsonOrNull(input.branch),
    jsonOrNull(input.provenance),
    jsonOrNull(input.outcome),
    input.createdAt ?? T0,
    input.createdAt ?? T0,
    input.completedAt ?? null
  )
}

interface RevisionRowInput {
  id: string
  epicId: string
  number: number
  bundle: PlanBundle
  state?: 'pending' | 'saved' | 'failed'
  baseRevisionId?: string | null
  createdAt?: string
  savedAt?: string | null
  contentHash?: string
}

export function insertRevision(db: Db, input: RevisionRowInput): void {
  db.run(
    `INSERT INTO plan_revisions (id, epic_id, number, base_revision_id, content_hash, bundle_json, state,
       created_at, saved_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    input.id,
    input.epicId,
    input.number,
    input.baseRevisionId ?? null,
    input.contentHash ?? contentHash(input.bundle),
    JSON.stringify(input.bundle),
    input.state ?? 'pending',
    input.createdAt ?? T0,
    input.savedAt ?? null
  )
}

interface OutboxRowInput {
  kind: 'snapshot' | 'epic_state' | 'run_history' | 'comment' | 'profile'
  epicId?: string | null
  runId?: string | null
  revisionId?: string | null
  entityId?: string | null
  state?: 'pending' | 'done' | 'failed'
  attempts?: number
}

export function insertOutbox(db: Db, input: OutboxRowInput): number {
  return db.run(
    `INSERT INTO outbox (kind, epic_id, run_id, revision_id, entity_id, state, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    input.kind,
    input.epicId ?? null,
    input.runId ?? null,
    input.revisionId ?? null,
    input.entityId ?? null,
    input.state ?? 'pending',
    input.attempts ?? 0,
    T0
  ).lastInsertRowid
}

interface CommentRowInput {
  id: string
  epicId: string
  ticketId?: string | null
  body?: string
  role?: SessionRole
  label?: string
  createdAt?: string
}

export function insertComment(db: Db, input: CommentRowInput): void {
  db.run(
    `INSERT INTO comments (id, epic_id, ticket_id, body, author_role, author_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    input.id,
    input.epicId,
    input.ticketId ?? null,
    input.body ?? 'A **comment**',
    input.role ?? 'worker',
    input.label ?? 'worker-1',
    input.createdAt ?? T0
  )
}

interface RunRowInput {
  id: string
  epicId: string
  revisionId: string
  number?: number
  state?: RunState
  activeSprintId?: string | null
  host?: unknown
  ownerMachineId?: string
  pauseReason?: string | null
  autoContinue?: boolean
  createdAt?: string
}

export function insertRun(db: Db, input: RunRowInput): void {
  db.run(
    `INSERT INTO runs (id, epic_id, number, revision_id, state, active_sprint_id, orchestrator_session_id, host_json,
       host_catalog_id, skill_version, owner_machine_id, pause_reason, auto_continue, revision, created_at,
       started_at, updated_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, 'ss_00000000000000000000000009', ?, NULL, '1.0.0', ?, ?, ?, 1, ?, ?, ?, NULL)`,
    input.id,
    input.epicId,
    input.number ?? 1,
    input.revisionId,
    input.state ?? 'running',
    input.activeSprintId ?? null,
    jsonOrNull(input.host),
    input.ownerMachineId ?? idOf('machine', 1),
    input.pauseReason ?? null,
    input.autoContinue === true ? 1 : 0,
    input.createdAt ?? T0,
    input.createdAt ?? T0,
    input.createdAt ?? T0
  )
}

interface AttemptRowInput {
  id: string
  runId: string
  ticketId: string
  revisionId: string
  number?: number
  kind?: 'work' | 'carry_forward'
  state?: AttemptState
  worker?: unknown
  outputs?: unknown
  evidence?: unknown
  failure?: unknown
  decision?: unknown
  claimSecret?: string | null
  leaseExpiresAt?: string | null
}

export function insertAttempt(db: Db, input: AttemptRowInput): void {
  db.run(
    `INSERT INTO attempts (id, run_id, ticket_id, number, kind, state, fencing_token, claim_secret, worker_json,
       revision_id, ticket_content_hash, lease_expires_at, heartbeat_at, outputs_json, evidence_json, failure_json,
       decision_json, created_at, updated_at, submitted_at, decided_at, reconciled_at, superseded_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
    input.id,
    input.runId,
    input.ticketId,
    input.number ?? 1,
    input.kind ?? 'work',
    input.state ?? 'accepted',
    input.claimSecret ?? null,
    JSON.stringify(input.worker ?? { sessionId: 'ss_00000000000000000000000009', label: 'worker-1', modelId: null }),
    input.revisionId,
    `sha256:${'0'.repeat(64)}`,
    input.leaseExpiresAt ?? null,
    input.leaseExpiresAt ?? null,
    jsonOrNull(input.outputs),
    jsonOrNull(input.evidence),
    jsonOrNull(input.failure),
    jsonOrNull(input.decision),
    T0,
    T0
  )
}

interface ReportRowInput {
  id: string
  runId: string
  sprintId: string
  reportRevision?: number
  content: unknown
}

export function insertReport(db: Db, input: ReportRowInput): void {
  db.run(
    `INSERT INTO sprint_reports (id, run_id, sprint_id, report_revision, content_json, content_hash, submitted_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'orchestrator', ?)`,
    input.id,
    input.runId,
    input.sprintId,
    input.reportRevision ?? 1,
    JSON.stringify(input.content),
    contentHash(input.content),
    T0
  )
}

export function insertCheckpoint(db: Db, input: { id: string; runId: string; sprintId: string; reportId: string }): void {
  db.run(
    `INSERT INTO checkpoints (id, run_id, sprint_id, report_id, outcome, policy, approval_id, decided_by, decided_at)
     VALUES (?, ?, ?, ?, 'advanced', 'human', 'ap_00000000000000000000000001', 'desktop', ?)`,
    input.id,
    input.runId,
    input.sprintId,
    input.reportId,
    T0
  )
}

export function insertTicketStatus(db: Db, input: { ticketId: string; epicId: string; status?: string }): void {
  db.run(
    'INSERT INTO ticket_status (ticket_id, epic_id, status, revision, updated_at) VALUES (?, ?, ?, 1, ?)',
    input.ticketId,
    input.epicId,
    input.status ?? 'backlog',
    T0
  )
}

interface ProfileRowInput {
  name: string
  description?: string
  capability?: unknown
  revision?: number
  createdAt?: string
  updatedAt?: string
}

/** A named capability profile row, as saveProfile stores it (capability defaults to the ticket default). */
export function insertProfile(db: Db, input: ProfileRowInput): void {
  db.run(
    `INSERT INTO profiles (name, description, capability_json, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.name,
    input.description ?? '',
    JSON.stringify(input.capability ?? defaultCapabilityProfile()),
    input.revision ?? 1,
    input.createdAt ?? T0,
    input.updatedAt ?? input.createdAt ?? T0
  )
}

export interface RecordingSaveHook extends FinalizerHooks {
  /** Revisions whose DB side was applied (including ones later rolled back). */
  calls: string[]
  /** When set, the next call throws (simulates the DB side of a save failing to commit). */
  failNext: boolean
}

/**
 * Minimal stand-in for the real save completion: marks the revision saved, advances the epic's
 * current revision, and creates backlog statuses for new tickets.
 */
export function createSaveHook(db: Db, clock: Clock): RecordingSaveHook {
  const hook: RecordingSaveHook = {
    calls: [],
    failNext: false,
    onSnapshotSaved(revisionId) {
      hook.calls.push(revisionId)
      if (hook.failNext) {
        hook.failNext = false
        throw new Error('Injected DB commit failure')
      }
      const row = db.get<{ epic_id: string; bundle_json: string }>(
        'SELECT epic_id, bundle_json FROM plan_revisions WHERE id = ?',
        revisionId
      )
      const now = clock.nowIso()
      db.run("UPDATE plan_revisions SET state = 'saved', saved_at = ? WHERE id = ?", now, revisionId)
      db.run('UPDATE epics SET current_revision_id = ?, updated_at = ? WHERE id = ?', revisionId, now, row?.epic_id ?? '')
      const bundle = JSON.parse(row?.bundle_json ?? '{"tickets":[]}') as { tickets: { id: string }[] }
      for (const ticket of bundle.tickets) {
        db.run(
          "INSERT OR IGNORE INTO ticket_status (ticket_id, epic_id, status, revision, updated_at) VALUES (?, ?, 'backlog', 1, ?)",
          ticket.id,
          row?.epic_id ?? '',
          now
        )
      }
    }
  }
  return hook
}
