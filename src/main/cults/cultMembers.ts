/**
 * Named members of a cult run, the run-scoped worker types they may hold, and the specialist reports of roster
 * slots. Each change is one transaction with its pipeline event. Display names are unique per run regardless of
 * case; a member holds a roster slot or a run worker type, never both; a required slot has at most one live member.
 * Retired worker types stay stored, so `createRunWorkerType` never hands out a `dyn_<n>` id twice in a run.
 */
import { fail } from '../../core/errors'
import { createRunWorkerType, type RunWorkerType, retireRunWorkerType } from '../../shared/cults/archetypes'
import {
  type CultMemberView,
  LIVE_MEMBER_STATES,
  type MemberDefinition,
  type MemberInput,
  memberInputSchema,
  type MemberState,
  type MemberChange,
  type MemberUpdate,
  memberUpdateSchema,
  reportInputSchema,
  type SlotCoverage,
  type SpecialistReportInput,
  type SpecialistReportView
} from '../../shared/cults/cult'
import type { DynamicWorkerTypeInput } from '../../shared/cults/archetypes'
import { cultistName } from '../../shared/cults/names'
import {
  cultSlots,
  insertEvent,
  type MemberRow,
  parseInput,
  requireActiveRun,
  requireMember,
  requireRun,
  runWorkerTypes,
  type StoreContext,
  toMemberView
} from './cultRecords'

const LIVE = `state IN (${LIVE_MEMBER_STATES.map((state) => `'${state}'`).join(',')})`
const isLive = (state: MemberState): boolean => LIVE_MEMBER_STATES.includes(state)

function takenNames(ctx: StoreContext, runId: string): string[] {
  return ctx.db.all<{ name: string }>('SELECT display_name AS name FROM cult_members WHERE run_id = ?', runId).map((r) => r.name)
}

/** The slot's worker type, refusing an unknown slot and a second live member on a required slot. */
function slotWorkerType(ctx: StoreContext, cultId: string, member: MemberDefinition, runId: string): string | null {
  if (member.slotId === null) return null
  const slot = cultSlots(ctx.db, cultId).find((candidate) => candidate.id === member.slotId)
  if (slot === undefined) fail('invalid_input', `The cult has no roster slot ${member.slotId}.`)
  const holder = ctx.db.get<{ name: string }>(
    `SELECT display_name AS name FROM cult_members WHERE run_id = ? AND slot_id = ? AND ${LIVE}`,
    runId,
    slot.id
  )
  if (slot.required && holder) fail('conflict', `Slot ${slot.label} is already held by ${holder.name}.`)
  return slot.workerType
}

function requireActiveWorkerType(ctx: StoreContext, runId: string, typeId: string | null): RunWorkerType | null {
  if (typeId === null) return null
  const type = runWorkerTypes(ctx.db, runId).find((candidate) => candidate.id === typeId)
  if (type === undefined) fail('invalid_input', `The run has no worker type ${typeId}.`)
  if (type.retiredAt !== null) fail('invalid_state', `Worker type ${type.displayName} is retired.`)
  return type
}

type NamedMember = MemberDefinition & { displayName: string; workerType: string | null }

function insertMember(ctx: StoreContext, runId: string, member: NamedMember, at: string): void {
  ctx.db.run(
    `INSERT INTO cult_members (run_id, chat_id, role, display_name, mission, model, tier, tier_reason, slot_id, worker_type,
       run_worker_type_id, state, joined_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'joining', ?)`,
    runId,
    member.chatId,
    member.role,
    member.displayName,
    member.mission,
    member.model,
    member.tier,
    member.tierReason,
    member.slotId,
    member.workerType,
    member.runWorkerTypeId,
    at
  )
}

/** Adds a member in `joining` with a `summoned` event (and `worker_type_assigned` when it holds a run type). */
export function addMember(ctx: StoreContext, runId: string, input: MemberInput): CultMemberView {
  const member = parseInput(memberInputSchema, input)
  return ctx.db.tx(() => {
    const run = requireActiveRun(ctx.db, runId)
    const taken = takenNames(ctx, runId)
    const displayName = member.displayName ?? cultistName(taken, member.role, `${runId}:${member.chatId}`)
    if (taken.some((name) => name.toLowerCase() === displayName.toLowerCase()))
      fail('conflict', `A member of this run is already named ${displayName}.`)
    if (ctx.db.get('SELECT 1 FROM cult_members WHERE run_id = ? AND chat_id = ?', runId, member.chatId))
      fail('conflict', `Chat ${member.chatId} is already a member of this run.`)
    const workerType = slotWorkerType(ctx, run.cult_id, member, runId)
    const runType = requireActiveWorkerType(ctx, runId, member.runWorkerTypeId)
    const at = ctx.now()
    insertMember(ctx, runId, { ...member, displayName, workerType }, at)
    insertEvent(ctx.db, { runId, kind: 'summoned', memberName: displayName, summary: `${displayName} was summoned.`, at })
    if (runType)
      insertEvent(ctx.db, { runId, kind: 'worker_type_assigned', memberName: displayName, summary: `${displayName} holds ${runType.displayName}.`, at })
    return toMemberView(requireMember(ctx.db, runId, member.chatId))
  })
}

const LEAVE_EVENT = { concluded: 'concluded', dismissed: 'dismissed', left: 'left' } as const

/** The member's fields after the change: an omitted field keeps its value, an explicit null clears it. */
function changedFields(before: MemberRow, change: MemberChange) {
  const pick = <T>(next: T | undefined, current: T): T => (next === undefined ? current : next)
  return [
    pick(change.mission, before.mission),
    pick(change.model, before.model),
    pick(change.tier, before.tier),
    pick(change.tierReason, before.tier_reason)
  ] as const
}

/** Changes a member; moving from live to a leaving state stamps `leftAt` and appends its event. */
export function updateMember(ctx: StoreContext, runId: string, chatId: string, input: MemberUpdate): CultMemberView {
  const change = parseInput(memberUpdateSchema, input)
  return ctx.db.tx(() => {
    const before = requireMember(ctx.db, runId, chatId)
    const state = change.state ?? before.state
    if (!isLive(before.state) && state !== before.state) fail('invalid_state', `${before.display_name} has already left the run.`)
    const at = ctx.now()
    ctx.db.run(
      `UPDATE cult_members SET state = ?, mission = ?, model = ?, tier = ?, tier_reason = ?, left_at = ?
       WHERE run_id = ? AND chat_id = ?`,
      state,
      ...changedFields(before, change),
      isLive(state) ? null : (before.left_at ?? at),
      runId,
      chatId
    )
    if (isLive(before.state) && !isLive(state)) {
      const kind = LEAVE_EVENT[state as keyof typeof LEAVE_EVENT]
      insertEvent(ctx.db, { runId, kind, memberName: before.display_name, summary: `${before.display_name} ${kind}.`, at })
    }
    return toMemberView(requireMember(ctx.db, runId, chatId))
  })
}

/** A run's members in the order they joined. */
export function listMembers(ctx: StoreContext, runId: string): CultMemberView[] {
  return ctx.db
    .all<MemberRow>('SELECT * FROM cult_members WHERE run_id = ? ORDER BY joined_at, rowid', runId)
    .map((row) => toMemberView(row))
}

// ---- Run-scoped worker types ----

/** Creates a run worker type proposed by a live member, with its `worker_type_created` event. */
export function createWorkerType(ctx: StoreContext, runId: string, creatorChatId: string, input: DynamicWorkerTypeInput): RunWorkerType {
  return ctx.db.tx(() => {
    requireActiveRun(ctx.db, runId)
    const creator = requireMember(ctx.db, runId, creatorChatId)
    if (!isLive(creator.state)) fail('invalid_state', `${creator.display_name} has left the run.`)
    const at = ctx.now()
    const result = createRunWorkerType(input, { existing: runWorkerTypes(ctx.db, runId), creatorMemberId: creatorChatId, now: at })
    if (!result.ok) fail('invalid_input', result.error)
    const type = result.type
    ctx.db.run(
      `INSERT INTO cult_run_worker_types (run_id, type_id, display_name, normalized_name, description, mission, rationale,
         required, creator_chat_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      runId,
      type.id,
      type.displayName,
      type.displayName.toLowerCase(),
      type.description,
      type.mission,
      type.rationale,
      type.requiredForConclusion ? 1 : 0,
      type.creatorMemberId,
      at,
      at
    )
    const summary = `${creator.display_name} created worker type ${type.displayName}.`
    insertEvent(ctx.db, { runId, kind: 'worker_type_created', memberName: creator.display_name, summary, at })
    return type
  })
}

/** Retires an optional run worker type no member has ever held, with its `worker_type_retired` event. */
export function retireWorkerType(ctx: StoreContext, runId: string, typeId: string): RunWorkerType {
  return ctx.db.tx(() => {
    requireActiveRun(ctx.db, runId)
    const type = runWorkerTypes(ctx.db, runId).find((candidate) => candidate.id === typeId)
    if (type === undefined) fail('not_found', `The run has no worker type ${typeId}.`)
    const assigned = ctx.db.get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM cult_members WHERE run_id = ? AND run_worker_type_id = ?',
      runId,
      typeId
    )
    const at = ctx.now()
    const result = retireRunWorkerType(type, assigned?.n ?? 0, at)
    if (!result.ok) fail('invalid_state', result.error)
    ctx.db.run(
      "UPDATE cult_run_worker_types SET state = 'retired', retired_at = ?, updated_at = ? WHERE run_id = ? AND type_id = ?",
      at,
      at,
      runId,
      typeId
    )
    insertEvent(ctx.db, { runId, kind: 'worker_type_retired', memberName: null, summary: `Worker type ${type.displayName} retired.`, at })
    return result.type
  })
}

/** Every worker type the run created, retired ones included, in creation order; kept in completed-run history. */
export function listWorkerTypes(ctx: StoreContext, runId: string): RunWorkerType[] {
  requireRun(ctx.db, runId)
  return runWorkerTypes(ctx.db, runId)
}

// ---- Specialist reports and slot coverage ----

interface ReportRow {
  id: number
  run_id: string
  member_chat_id: string
  slot_id: string | null
  run_worker_type_id: string | null
  text: string
  target_revision: string | null
  submitted_at: string
}

const toReportView = (row: ReportRow): SpecialistReportView => ({
  id: row.id,
  runId: row.run_id,
  memberChatId: row.member_chat_id,
  slotId: row.slot_id,
  runWorkerTypeId: row.run_worker_type_id,
  text: row.text,
  targetRevision: row.target_revision,
  submittedAt: row.submitted_at
})

/** Stores a specialist report; only the live acolyte holding that slot or run worker type may submit it. */
export function submitReport(ctx: StoreContext, runId: string, input: SpecialistReportInput): SpecialistReportView {
  const report = parseInput(reportInputSchema, input)
  return ctx.db.tx(() => {
    requireActiveRun(ctx.db, runId)
    const member = requireMember(ctx.db, runId, report.memberChatId)
    const held = report.slotId === null ? member.run_worker_type_id === report.runWorkerTypeId : member.slot_id === report.slotId
    if (!held || !isLive(member.state))
      fail('unauthorized', `${member.display_name} does not hold ${report.slotId ?? report.runWorkerTypeId}.`)
    const inserted = ctx.db.run(
      `INSERT INTO cult_specialist_reports (run_id, member_chat_id, slot_id, run_worker_type_id, text, target_revision, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      runId,
      report.memberChatId,
      report.slotId,
      report.runWorkerTypeId,
      report.text,
      report.targetRevision,
      ctx.now()
    )
    const row = ctx.db.get<ReportRow>('SELECT * FROM cult_specialist_reports WHERE id = ?', inserted.lastInsertRowid)
    return toReportView(row ?? fail('internal', 'The report vanished after insert.'))
  })
}

export function listReports(ctx: StoreContext, runId: string): SpecialistReportView[] {
  return ctx.db
    .all<ReportRow>('SELECT * FROM cult_specialist_reports WHERE run_id = ? ORDER BY id', runId)
    .map((row) => toReportView(row))
}

/** Each roster slot of the run's cult with who holds it now and how many reports it has. */
export function slotCoverage(ctx: StoreContext, runId: string): SlotCoverage[] {
  return ctx.db.tx(() => {
    const run = requireRun(ctx.db, runId)
    return cultSlots(ctx.db, run.cult_id).map((slot) => {
      const holders = ctx.db.all<{ chat_id: string }>(
        `SELECT chat_id FROM cult_members WHERE run_id = ? AND slot_id = ? AND ${LIVE} ORDER BY joined_at, rowid`,
        runId,
        slot.id
      )
      const reports = ctx.db.get<{ n: number; last: string | null }>(
        'SELECT COUNT(*) AS n, MAX(submitted_at) AS last FROM cult_specialist_reports WHERE run_id = ? AND slot_id = ?',
        runId,
        slot.id
      )
      return {
        slotId: slot.id,
        workerType: slot.workerType,
        label: slot.label,
        required: slot.required,
        liveMemberChatIds: holders.map((holder) => holder.chat_id),
        reportCount: reports?.n ?? 0,
        lastReportAt: reports?.last ?? null
      }
    })
  }, 'read')
}
