/**
 * Row shapes, row-to-view mapping and the shared lookups of the cult store (`cultStore.ts`, `cultRoster.ts`).
 * Every function here runs inside the caller's transaction; none opens one.
 */
import type { z } from 'zod'
import type { Db } from '../../core/db/database'
import { fail } from '../../core/errors'
import { newUlid } from '../../core/ids'
import type { CultArchetype, RosterSlot, RunWorkerType, WorkerType } from '../../shared/cults/archetypes'
import type {
  CultEventKind,
  CultEventView,
  CultOrderData,
  CultMemberView,
  CultPetitionView,
  CultRunView,
  CultScope,
  CultView,
  MemberRole,
  MemberState,
  PetitionKind
} from '../../shared/cults/cult'
import { type EndReason, type PetitionState, type RunClock, type RunState } from '../../shared/cults/runState'

/** What every store operation needs: the app database and an ISO clock. */
export interface StoreContext {
  db: Db
  now: () => string
}

export const newCultId = (prefix: 'ct' | 'cr' | 'cp' | 'co'): string => `${prefix}_${newUlid()}`

/** Validates input at the store boundary; a refusal is `invalid_input` carrying zod's issues. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    const message = result.error.issues.map((issue) => `${issue.path.join('.') || 'input'}: ${issue.message}`)
    fail('invalid_input', message.join('; '), { issues: result.error.issues })
  }
  return result.data
}

interface CultRow {
  id: string
  name: string
  charter: string
  scope: CultScope
  folder_path: string | null
  archetype: CultArchetype
  target_epic_id: string | null
  magos_name: string
  magos_model_id: string | null
  default_time_limit_ms: number | null
  default_cap: number
  acolyte_grace_ms: number
  magos_window_ms: number
  created_at: string
  updated_at: string
}

interface SlotRow {
  slot_id: string
  worker_type: WorkerType
  label: string
  mission: string
  required: number
}

export function cultSlots(db: Db, cultId: string): RosterSlot[] {
  return db
    .all<SlotRow>(
      'SELECT slot_id, worker_type, label, mission, required FROM cult_role_slots WHERE cult_id = ? ORDER BY ordinal',
      cultId
    )
    .map((row) => ({
      id: row.slot_id,
      workerType: row.worker_type,
      label: row.label,
      mission: row.mission,
      required: row.required === 1
    }))
}

export function findCult(db: Db, cultId: string): CultView | null {
  const row = db.get<CultRow>('SELECT * FROM cults WHERE id = ?', cultId)
  if (row === undefined) return null
  return {
    id: row.id,
    name: row.name,
    charter: row.charter,
    scope: row.scope,
    folderPath: row.folder_path,
    archetype: row.archetype,
    targetEpicId: row.target_epic_id,
    magosName: row.magos_name,
    magosModelId: row.magos_model_id,
    defaultTimeLimitMs: row.default_time_limit_ms,
    defaultCap: row.default_cap,
    acolyteGraceMs: row.acolyte_grace_ms,
    magosWindowMs: row.magos_window_ms,
    slots: cultSlots(db, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function requireCult(db: Db, cultId: string): CultView {
  return findCult(db, cultId) ?? fail('not_found', `No cult ${cultId}.`)
}

export interface RunRow {
  id: string
  cult_id: string
  state: RunState
  end_reason: EndReason | null
  time_limit_ms: number | null
  grace_ms: number
  magos_window_ms: number
  accumulated_running_ms: number
  running_since: string | null
  cap: number
  work_dir: string
  chronicle: string | null
  shrine_path: string | null
  shrine_revision: string | null
  started_at: string
  ended_at: string | null
}

export function toRunView(row: RunRow): CultRunView {
  return {
    id: row.id,
    cultId: row.cult_id,
    state: row.state,
    endReason: row.end_reason,
    timeLimitMs: row.time_limit_ms,
    acolyteGraceMs: row.grace_ms,
    magosWindowMs: row.magos_window_ms,
    accumulatedRunningMs: row.accumulated_running_ms,
    runningSince: row.running_since,
    cap: row.cap,
    workDir: row.work_dir,
    chronicle: row.chronicle,
    shrinePath: row.shrine_path,
    shrineRevision: row.shrine_revision,
    startedAt: row.started_at,
    endedAt: row.ended_at
  }
}

export function toClock(row: RunRow): RunClock {
  return {
    state: row.state,
    endReason: row.end_reason,
    timeLimitMs: row.time_limit_ms,
    accumulatedRunningMs: row.accumulated_running_ms,
    runningSince: row.running_since,
    endedAt: row.ended_at
  }
}

export function requireRun(db: Db, runId: string): RunRow {
  return db.get<RunRow>('SELECT * FROM cult_runs WHERE id = ?', runId) ?? fail('not_found', `No cult run ${runId}.`)
}

/** The run, refused with `run_not_active` once it has ended. */
export function requireActiveRun(db: Db, runId: string): RunRow {
  const run = requireRun(db, runId)
  if (run.state === 'ended') fail('run_not_active', `Cult run ${runId} has ended.`)
  return run
}

export interface MemberRow {
  run_id: string
  chat_id: string
  role: MemberRole
  display_name: string
  mission: string
  model: string | null
  tier: string | null
  tier_reason: string | null
  slot_id: string | null
  worker_type: WorkerType | null
  run_worker_type_id: string | null
  state: MemberState
  joined_at: string
  left_at: string | null
}

export function toMemberView(row: MemberRow): CultMemberView {
  return {
    runId: row.run_id,
    chatId: row.chat_id,
    role: row.role,
    displayName: row.display_name,
    mission: row.mission,
    model: row.model,
    tier: row.tier,
    tierReason: row.tier_reason,
    slotId: row.slot_id,
    workerType: row.worker_type,
    runWorkerTypeId: row.run_worker_type_id,
    state: row.state,
    joinedAt: row.joined_at,
    leftAt: row.left_at
  }
}

export function requireMember(db: Db, runId: string, chatId: string): MemberRow {
  return (
    db.get<MemberRow>('SELECT * FROM cult_members WHERE run_id = ? AND chat_id = ?', runId, chatId) ??
    fail('not_found', `No member ${chatId} in cult run ${runId}.`)
  )
}

export interface PetitionRow {
  id: string
  run_id: string
  kind: PetitionKind
  payload: string | null
  reason: string
  state: PetitionState
  granted: number | null
  created_at: string
  decided_at: string | null
}

export function toPetitionView(row: PetitionRow): CultPetitionView {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    additional: row.kind === 'acolytes' ? Number(row.payload) : null,
    folderPath: row.kind === 'folder_access' ? row.payload : null,
    reason: row.reason,
    state: row.state,
    granted: row.granted,
    createdAt: row.created_at,
    decidedAt: row.decided_at
  }
}

interface WorkerTypeRow {
  type_id: string
  display_name: string
  description: string
  mission: string
  rationale: string
  required: number
  creator_chat_id: string
  created_at: string
  updated_at: string
  retired_at: string | null
}

function toWorkerType(row: WorkerTypeRow): RunWorkerType {
  return {
    id: row.type_id,
    displayName: row.display_name,
    description: row.description,
    mission: row.mission,
    rationale: row.rationale,
    requiredForConclusion: row.required === 1,
    creatorMemberId: row.creator_chat_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    retiredAt: row.retired_at
  }
}

/** Every run worker type, retired ones included, in creation order: what `createRunWorkerType` must see. */
export function runWorkerTypes(db: Db, runId: string): RunWorkerType[] {
  return db
    .all<WorkerTypeRow>('SELECT * FROM cult_run_worker_types WHERE run_id = ? ORDER BY rowid', runId)
    .map((row) => toWorkerType(row))
}

interface NewEvent {
  runId: string
  kind: CultEventKind
  memberName: string | null
  summary: string
  at: string
  data?: CultOrderData | null
}

export interface EventRow {
  run_id: string
  seq: number
  at: string
  member_name: string | null
  kind: CultEventKind
  summary: string
  data: string | null
}

export function toEventView(row: EventRow): CultEventView {
  const data = row.data === null ? null : (JSON.parse(row.data) as CultOrderData)
  return { runId: row.run_id, seq: row.seq, at: row.at, memberName: row.member_name, kind: row.kind, summary: row.summary, data }
}

/** Appends one pipeline event at the run's next sequence number. */
export function insertEvent(db: Db, event: NewEvent): CultEventView {
  const next = db.get<{ seq: number }>(
    'SELECT COALESCE(MAX(seq), 0) + 1 AS seq FROM cult_events WHERE run_id = ?',
    event.runId
  )
  const seq = next?.seq ?? 1
  const data = event.data == null ? null : JSON.stringify(event.data)
  db.run(
    'INSERT INTO cult_events (run_id, seq, at, member_name, kind, summary, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
    event.runId,
    seq,
    event.at,
    event.memberName,
    event.kind,
    event.summary,
    data
  )
  return toEventView({ run_id: event.runId, seq, at: event.at, member_name: event.memberName, kind: event.kind, summary: event.summary, data })
}
