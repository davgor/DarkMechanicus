/**
 * What changed one epic's plan since an event sequence number, and through which grant: the Plan Forge council
 * (`src/main/cults/planForgeCouncil.ts`) reads it through the desktop's workspace operation `cultPlanTrace`, never the
 * database directly, to tell its Magos's own draft edits from a change made outside the run.
 */
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { latestSeq } from './events'

/** One recorded change of the plan: its event kind, the grant of the session that made it (null: none), and the draft revision it produced. */
interface PlanChangeTrace {
  kind: string
  grantId: string | null
  draftRevision: number | null
}

export interface PlanTrace {
  savedRevision: number | null
  draftRevision: number | null
  /** The folder's event high-water mark as read. */
  eventSeq: number
  /** Changes after `afterSeq`, oldest first; empty when none was asked for. */
  changes: PlanChangeTrace[]
}

/** The most changes one trace returns; a run that edits more than this between conclusions is read as changed outside. */
const MAX_TRACE_CHANGES = 1000

/** The epic's saved and draft revisions now, and every draft change or save request after `afterSeq` (null: none). */
export function planTrace(ctx: Ctx, epicId: string, afterSeq: number | null): PlanTrace {
  requireCapability(ctx.session, 'read')
  return ctx.db.tx(() => {
    const epic = ctx.db.get<{ saved: number | null; draft: number | null }>(
      `SELECT (SELECT number FROM plan_revisions WHERE id = e.current_revision_id) AS saved,
         (SELECT draft_revision FROM drafts WHERE epic_id = e.id) AS draft
       FROM epics e WHERE e.id = ?`,
      epicId
    )
    if (epic === undefined) fail('not_found', `Epic ${epicId} does not exist.`)
    const eventSeq = latestSeq(ctx, 0)
    const rows = afterSeq === null ? [] : ctx.db.all<{ kind: string; grant_id: string | null; payload_json: string }>(
      `SELECT ev.kind, s.grant_id, ev.payload_json FROM events ev LEFT JOIN sessions s ON s.id = ev.session_id
       WHERE ev.epic_id = ? AND ev.seq > ? AND ev.seq <= ? AND (ev.kind LIKE 'draft.%' OR ev.kind = 'plan.save_requested')
       ORDER BY ev.seq LIMIT ?`,
      epicId,
      afterSeq,
      eventSeq,
      MAX_TRACE_CHANGES + 1
    )
    const changes = rows.map((row) => {
      const payload: unknown = JSON.parse(row.payload_json)
      const revision = payload !== null && typeof payload === 'object' && 'draftRevision' in payload ? payload.draftRevision : null
      return { kind: row.kind, grantId: row.grant_id, draftRevision: typeof revision === 'number' ? revision : null }
    })
    if (changes.length > MAX_TRACE_CHANGES) changes.splice(MAX_TRACE_CHANGES, Infinity, { kind: 'trace.truncated', grantId: null, draftRevision: null })
    return { savedRevision: epic.saved, draftRevision: epic.draft, eventSeq, changes }
  }, 'read')
}
