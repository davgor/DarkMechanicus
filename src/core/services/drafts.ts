import type { DraftOp } from '../../shared/domain/api'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { DraftUpdateResultView, PlanView } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import type { Ctx } from '../context'
import { toJson } from '../db/database'
import { applyDraftOps } from '../plan/draftOps'
import { validatePlan } from '../plan/graph'
import { createInitialBundle } from '../plan/normalize'
import { draftDeps, initialPlanIds } from './draftDeps'
import { assertEpicOpen, type EpicRow, loadEpicRow } from './epics'
import { appendEvent } from './events'
import { requestWithoutKey, withIdempotency } from './idempotency'
import { assertDraftRevision, currentSavedBundle, type DraftRow, getPlan, loadDraftRow } from './plans'

function insertDraft(ctx: Ctx, draft: { epicId: string; baseRevisionId: string | null; bundle: PlanBundle }): DraftRow {
  const now = ctx.clock.nowIso()
  const row: DraftRow = {
    epic_id: draft.epicId,
    base_revision_id: draft.baseRevisionId,
    draft_revision: 1,
    bundle_json: toJson(draft.bundle),
    created_at: now,
    updated_at: now,
    updated_by: ctx.session.id
  }
  ctx.db.run(
    `INSERT INTO drafts (epic_id, base_revision_id, draft_revision, bundle_json, created_at, updated_at, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    row.epic_id,
    row.base_revision_id,
    row.draft_revision,
    row.bundle_json,
    row.created_at,
    row.updated_at,
    row.updated_by
  )
  appendEvent(ctx, { kind: 'draft.opened', epicId: draft.epicId, payload: { baseRevisionId: draft.baseRevisionId } })
  return row
}

/** Returns the epic's draft, creating it from the current saved bundle when there is none. */
function ensureDraft(ctx: Ctx, epic: EpicRow): DraftRow {
  const existing = loadDraftRow(ctx, epic.id)
  if (existing) {
    return existing
  }
  const current = currentSavedBundle(ctx, epic.id)
  const bundle =
    current?.bundle ??
    createInitialBundle({ title: epic.title, intent: '', successCriteria: [], ownerRole: null }, initialPlanIds(ctx))
  return insertDraft(ctx, { epicId: epic.id, baseRevisionId: current?.revisionId ?? null, bundle })
}

export function openDraft(ctx: Ctx, input: { epicId: string }): PlanView {
  requireCapability(ctx.session, 'draft.edit')
  return ctx.db.tx(() => {
    const epic = loadEpicRow(ctx, input.epicId)
    assertEpicOpen(epic)
    ensureDraft(ctx, epic)
    return getPlan(ctx, { epicId: epic.id, view: 'draft' })
  })
}

/**
 * Applies draft ops all-or-nothing (implicitly opening the draft). A stale `expectedDraftRevision`
 * is a `conflict`; a rejected op propagates its reason and op index and nothing is persisted.
 */
export function updatePlanDraft(
  ctx: Ctx,
  input: { epicId: string; ops: DraftOp[]; expectedDraftRevision?: number; idempotencyKey?: string }
): DraftUpdateResultView {
  requireCapability(ctx.session, 'draft.edit')
  const scope = { command: 'updatePlanDraft', key: input.idempotencyKey, request: requestWithoutKey(input) }
  return withIdempotency(ctx, scope, () => {
    const epic = loadEpicRow(ctx, input.epicId)
    assertEpicOpen(epic)
    const draft = ensureDraft(ctx, epic)
    assertDraftRevision(draft, input.expectedDraftRevision)
    const result = applyDraftOps(JSON.parse(draft.bundle_json) as PlanBundle, input.ops, draftDeps(ctx))
    const draftRevision = draft.draft_revision + 1
    ctx.db.run(
      'UPDATE drafts SET bundle_json = ?, draft_revision = ?, updated_at = ?, updated_by = ? WHERE epic_id = ?',
      toJson(result.bundle),
      draftRevision,
      ctx.clock.nowIso(),
      ctx.session.id,
      epic.id
    )
    appendEvent(ctx, { kind: 'draft.updated', epicId: epic.id, payload: { draftRevision, ops: input.ops.length } })
    return { epicId: epic.id, draftRevision, refMap: result.refMap, validation: validatePlan(result.bundle) }
  })
}

/** A never-saved epic keeps its content (title, intent, criteria, owner) on a fresh one-sprint plan. */
function resetDraft(ctx: Ctx, draft: DraftRow): void {
  const epic = (JSON.parse(draft.bundle_json) as PlanBundle).epic
  const bundle = createInitialBundle(epic, initialPlanIds(ctx))
  ctx.db.run(
    `UPDATE drafts SET bundle_json = ?, base_revision_id = NULL, draft_revision = ?, updated_at = ?, updated_by = ?
     WHERE epic_id = ?`,
    toJson(bundle),
    draft.draft_revision + 1,
    ctx.clock.nowIso(),
    ctx.session.id,
    draft.epic_id
  )
}

/** Discard restores the last saved plan (the draft is deleted); a never-saved epic is reset instead. */
export function discardPlanDraft(
  ctx: Ctx,
  input: { epicId: string; expectedDraftRevision?: number }
): { discarded: boolean } {
  requireCapability(ctx.session, 'draft.edit')
  return ctx.db.tx(() => {
    const epic = loadEpicRow(ctx, input.epicId)
    const draft = loadDraftRow(ctx, epic.id)
    if (!draft) {
      return { discarded: false }
    }
    assertDraftRevision(draft, input.expectedDraftRevision)
    const reset = epic.current_revision_id === null
    if (reset) {
      resetDraft(ctx, draft)
    } else {
      ctx.db.run('DELETE FROM drafts WHERE epic_id = ?', epic.id)
    }
    appendEvent(ctx, { kind: 'draft.discarded', epicId: epic.id, payload: { reset } })
    return { discarded: true }
  })
}
