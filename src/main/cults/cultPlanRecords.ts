/**
 * Plan Forge records (DM-738): the target a run is bound to when it starts, and the syntheses its Magos records. A
 * binding is written once per run; a synthesis is inert JSON (recommendations with decisions and reasons), never read
 * as an instruction. The council (`planForgeCouncil.ts`) reads both.
 */
import { fail } from '../../core/errors'
import type { CultRecordSynthesisArgs } from '../../shared/cults/cultControl'
import { requireActiveRun, requireMember, requireRun, type StoreContext } from './cultRecords'

/** The target epic and its revisions as read at the run's start, with the folder's event high-water mark then. */
export interface PlanBinding {
  runId: string
  epicId: string
  savedRevision: number | null
  draftRevision: number | null
  eventSeq: number
  boundAt: string
}

export type PlanBindingInput = Omit<PlanBinding, 'runId' | 'boundAt'>

export interface SynthesisView {
  id: number
  runId: string
  memberChatId: string
  draftRevision: number
  recommendations: CultRecordSynthesisArgs['recommendations']
  recordedAt: string
}

interface BindingRow {
  run_id: string
  epic_id: string
  saved_revision: number | null
  draft_revision: number | null
  event_seq: number
  bound_at: string
}

interface SynthesisRow {
  id: number
  run_id: string
  member_chat_id: string
  draft_revision: number
  recommendations: string
  recorded_at: string
}

/** Binds a run to its target once; a second binding is a `conflict`. */
export function bindPlanTarget(ctx: StoreContext, runId: string, input: PlanBindingInput): PlanBinding {
  return ctx.db.tx(() => {
    requireActiveRun(ctx.db, runId)
    if (ctx.db.get('SELECT 1 FROM cult_plan_bindings WHERE run_id = ?', runId)) fail('conflict', `Run ${runId} is already bound to its target.`)
    const at = ctx.now()
    ctx.db.run(
      'INSERT INTO cult_plan_bindings (run_id, epic_id, saved_revision, draft_revision, event_seq, bound_at) VALUES (?, ?, ?, ?, ?, ?)',
      runId,
      input.epicId,
      input.savedRevision,
      input.draftRevision,
      input.eventSeq,
      at
    )
    return { runId, ...input, boundAt: at }
  })
}

export function getPlanBinding(ctx: StoreContext, runId: string): PlanBinding | null {
  const row = ctx.db.get<BindingRow>('SELECT * FROM cult_plan_bindings WHERE run_id = ?', runId)
  if (row === undefined) return null
  return {
    runId: row.run_id,
    epicId: row.epic_id,
    savedRevision: row.saved_revision,
    draftRevision: row.draft_revision,
    eventSeq: row.event_seq,
    boundAt: row.bound_at
  }
}

/** Records a synthesis by a member of an active run. */
export function recordSynthesis(ctx: StoreContext, runId: string, memberChatId: string, input: CultRecordSynthesisArgs): SynthesisView {
  return ctx.db.tx(() => {
    requireActiveRun(ctx.db, runId)
    requireMember(ctx.db, runId, memberChatId)
    const at = ctx.now()
    const inserted = ctx.db.run(
      'INSERT INTO cult_syntheses (run_id, member_chat_id, draft_revision, recommendations, recorded_at) VALUES (?, ?, ?, ?, ?)',
      runId,
      memberChatId,
      input.draftRevision,
      JSON.stringify(input.recommendations),
      at
    )
    return { id: Number(inserted.lastInsertRowid), runId, memberChatId, draftRevision: input.draftRevision, recommendations: input.recommendations, recordedAt: at }
  })
}

/** The run's most recent synthesis, or null. */
export function latestSynthesis(ctx: StoreContext, runId: string): SynthesisView | null {
  requireRun(ctx.db, runId)
  const row = ctx.db.get<SynthesisRow>('SELECT * FROM cult_syntheses WHERE run_id = ? ORDER BY id DESC LIMIT 1', runId)
  if (row === undefined) return null
  return {
    id: row.id,
    runId: row.run_id,
    memberChatId: row.member_chat_id,
    draftRevision: row.draft_revision,
    recommendations: JSON.parse(row.recommendations) as SynthesisView['recommendations'],
    recordedAt: row.recorded_at
  }
}
