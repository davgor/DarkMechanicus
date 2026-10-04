import { describe, expect, it } from 'vitest'
import type { DraftOp } from '../../shared/domain/api'
import {
  captureError,
  createSavedEpic,
  draftRevisionOf,
  eventKinds,
  insertRun,
  outboxRows,
  saveNow,
  TWO_TICKETS
} from '../../test/authoring'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { contentHash } from '../canonical'
import { DomainError } from '../errors'
import { isStableId } from '../ids'
import { computeChanges } from '../plan/diff'
import { addComment } from './comments'
import { discardPlanDraft, openDraft, updatePlanDraft } from './drafts'
import { createEpic, getEpic, listEpics } from './epics'
import {
  completeSavedRevision,
  currentSavedBundle,
  getPlan,
  listRevisions,
  loadRevisionBundle,
  requestSave,
  saveResult,
  validatePlanView
} from './plans'

const T0 = '2026-01-01T00:00:00.000Z'
const SAVED_REASON = 'Saved revisions are immutable. Edit a draft to change the plan.'

function addTicket(title: string): Extract<DraftOp, { op: 'add_ticket' }> {
  return { op: 'add_ticket', sprint: '1', ticket: { title, acceptanceCriteria: [`${title} works`] } }
}

function lastPayload(ctx: TestCtx): Record<string, unknown> {
  const row = ctx.db.get<{ payload_json: string }>('SELECT payload_json FROM events ORDER BY seq DESC LIMIT 1')
  return JSON.parse(row?.payload_json ?? '{}') as Record<string, unknown>
}

function revisionCount(ctx: TestCtx): number {
  return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM plan_revisions')?.n ?? -1
}

/** Simulates a pull that imported a newer saved revision (copy of `fromRevisionId`) as current. */
function simulatePull(ctx: TestCtx, epicId: string, fromRevisionId: string): string {
  const id = ctx.ids.next('revision')
  ctx.db.run(
    `INSERT INTO plan_revisions (id, epic_id, number, base_revision_id, content_hash, bundle_json, state, created_at, saved_at)
     SELECT ?, epic_id, 99, id, content_hash, bundle_json, 'saved', created_at, created_at FROM plan_revisions WHERE id = ?`,
    id,
    fromRevisionId
  )
  ctx.db.run('UPDATE epics SET current_revision_id = ? WHERE id = ?', id, epicId)
  return id
}

function newEpicWithTickets(ctx: TestCtx): string {
  const epic = createEpic(ctx, { title: 'Checkout', successCriteria: ['Customers can pay'] })
  updatePlanDraft(ctx, { epicId: epic.id, ops: TWO_TICKETS })
  return epic.id
}

describe('requestSave records a pending revision', () => {
  it('returns pending with the content hash and queues the snapshot', () => {
    const ctx = createTestCtx()
    const epicId = newEpicWithTickets(ctx)
    const bundle = getPlan(ctx, { epicId, view: 'draft' }).bundle
    const result = requestSave(ctx, { epicId, expectedDraftRevision: 2 })
    expect(result).toEqual({
      status: 'pending',
      revisionId: result.revisionId,
      revisionNumber: 1,
      contentHash: contentHash(bundle)
    })
    expect(isStableId(result.revisionId, 'revision')).toBe(true)
    expect(outboxRows(ctx)).toEqual([{ kind: 'snapshot', epicId, revisionId: result.revisionId }])
    expect(eventKinds(ctx).at(-1)).toBe('plan.save_requested')
    expect(lastPayload(ctx)).toEqual({ revisionId: result.revisionId, number: 1 })
    expect(ctx.db.get('SELECT created_by, base_revision_id FROM plan_revisions')).toEqual({
      created_by: ctx.session.id,
      base_revision_id: null
    })
  })

  it('keeps the draft and never exposes the pending revision as saved', () => {
    const ctx = createTestCtx()
    const epicId = newEpicWithTickets(ctx)
    const result = requestSave(ctx, { epicId, expectedDraftRevision: 2 })
    expect(draftRevisionOf(ctx, epicId)).toBe(2)
    expect(getEpic(ctx, { epicId }).currentRevisionId).toBeNull()
    expect(captureError(() => getPlan(ctx, { epicId, view: 'saved' }))).toEqual({
      code: 'not_found',
      message: 'This epic has no saved plan yet.',
      details: { epicId }
    })
    expect(captureError(() => getPlan(ctx, { epicId, view: 'saved', revisionId: result.revisionId }))).toEqual({
      code: 'not_found',
      message: `Revision ${result.revisionId} is not a saved revision of this epic.`,
      details: { revisionId: result.revisionId }
    })
  })
})

describe('requestSave guards', () => {
  it('checks the branch before anything else', () => {
    const ctx = createTestCtx({
      assertBranch: () => {
        throw new DomainError('branch_changed', 'The checkout moved to another branch.')
      }
    })
    const epicId = newEpicWithTickets(ctx)
    expect(captureError(() => requestSave(ctx, { epicId, expectedDraftRevision: 2 })).code).toBe('branch_changed')
    expect(revisionCount(ctx)).toBe(0)
  })

  it('rejects a missing draft, a stale draft revision, and a completed epic', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    expect(captureError(() => requestSave(ctx, { epicId: saved.epicId, expectedDraftRevision: 1 }))).toEqual({
      code: 'not_found',
      message: 'There is no draft to save.',
      details: { epicId: saved.epicId }
    })
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [addTicket('Gamma')] })
    const stale = captureError(() => requestSave(ctx, { epicId: saved.epicId, expectedDraftRevision: 1 }))
    expect(stale).toMatchObject({ code: 'conflict', details: { currentDraftRevision: 2 } })
    ctx.db.run("UPDATE epics SET status = 'completed' WHERE id = ?", saved.epicId)
    expect(captureError(() => requestSave(ctx, { epicId: saved.epicId, expectedDraftRevision: 2 })).code).toBe(
      'completed_epic'
    )
    expect(revisionCount(ctx)).toBe(1)
  })

})

describe('requestSave plan checks', () => {
  it('rejects a draft whose base is no longer the current saved revision', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [addTicket('Gamma')] })
    const pulled = simulatePull(ctx, saved.epicId, saved.revisionId)
    expect(captureError(() => requestSave(ctx, { epicId: saved.epicId, expectedDraftRevision: 2 }))).toEqual({
      code: 'stale_draft',
      message:
        'The saved plan changed since this draft was opened (e.g. after a pull). Review and rebase before saving.',
      details: { baseRevisionId: saved.revisionId, currentRevisionId: pulled }
    })
    expect(revisionCount(ctx)).toBe(2)
  })

  it('rejects an invalid plan with every blocking error', () => {
    const ctx = createTestCtx()
    const epicId = newEpicWithTickets(ctx)
    ctx.db.run("UPDATE drafts SET bundle_json = json_set(bundle_json, '$.epic.title', '') WHERE epic_id = ?", epicId)
    expect(captureError(() => requestSave(ctx, { epicId, expectedDraftRevision: 2 }))).toEqual({
      code: 'invalid_plan',
      message: 'The plan has 1 error(s) that block saving. The epic needs a title.',
      details: { errors: [{ code: 'empty_title', message: 'The epic needs a title.' }] }
    })
    expect(revisionCount(ctx)).toBe(0)
  })

  it('allows one pending save per epic', () => {
    const ctx = createTestCtx()
    const epicId = newEpicWithTickets(ctx)
    const first = requestSave(ctx, { epicId, expectedDraftRevision: 2 })
    updatePlanDraft(ctx, { epicId, ops: [addTicket('Gamma')] })
    expect(captureError(() => requestSave(ctx, { epicId, expectedDraftRevision: 3 }))).toEqual({
      code: 'save_pending',
      message: 'Revision 1 is still being saved. Flush portable state, then try again.',
      details: { revisionId: first.revisionId }
    })
  })
})

describe('requestSave outcomes', () => {
  it('reports unchanged for a draft identical to the saved plan and drops the draft', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const view = openDraft(ctx, { epicId: saved.epicId })
    const outbox = outboxRows(ctx)
    expect(requestSave(ctx, { epicId: saved.epicId, expectedDraftRevision: 1 })).toEqual({
      status: 'unchanged',
      revisionId: saved.revisionId,
      revisionNumber: 1,
      contentHash: view.contentHash
    })
    expect(draftRevisionOf(ctx, saved.epicId)).toBeNull()
    expect(revisionCount(ctx)).toBe(1)
    expect(outboxRows(ctx)).toEqual(outbox)
  })

  it('returns the original response for a repeated idempotency key', () => {
    const ctx = createTestCtx()
    const epicId = newEpicWithTickets(ctx)
    const first = requestSave(ctx, { epicId, expectedDraftRevision: 2, idempotencyKey: 'save-1' })
    ctx.db.tx(() => completeSavedRevision(ctx, first.revisionId))
    expect(requestSave(ctx, { epicId, expectedDraftRevision: 2, idempotencyKey: 'save-1' })).toEqual(first)
    expect(revisionCount(ctx)).toBe(1)
    const mismatch = captureError(() => requestSave(ctx, { epicId, expectedDraftRevision: 3, idempotencyKey: 'save-1' }))
    expect(mismatch.code).toBe('idempotency_mismatch')
  })

  it('requires plan.save, which planners only get when explicitly allowed', () => {
    const ctx = createTestCtx()
    const epicId = newEpicWithTickets(ctx)
    const planner = withRole(ctx, 'planner', { allowSave: false })
    expect(captureError(() => requestSave(planner, { epicId, expectedDraftRevision: 2 })).code).toBe('unauthorized')
    expect(requestSave(withRole(ctx, 'planner', { allowSave: true }), { epicId, expectedDraftRevision: 2 }).status).toBe(
      'pending'
    )
  })
})

describe('completeSavedRevision', () => {
  it('makes the revision current, creates ticket statuses, and drops the unchanged draft', () => {
    const ctx = createTestCtx()
    const epicId = newEpicWithTickets(ctx)
    updatePlanDraft(ctx, { epicId, ops: [{ op: 'set_epic', title: 'Checkout v2' }] })
    const { revisionId } = requestSave(ctx, { epicId, expectedDraftRevision: 3 })
    ctx.clock.advanceSeconds(30)
    ctx.db.tx(() => completeSavedRevision(ctx, revisionId))
    const saved = '2026-01-01T00:00:30.000Z'
    expect(ctx.db.get('SELECT state, saved_at FROM plan_revisions WHERE id = ?', revisionId)).toEqual({
      state: 'saved',
      saved_at: saved
    })
    expect(getEpic(ctx, { epicId })).toMatchObject({
      title: 'Checkout v2',
      currentRevisionId: revisionId,
      currentRevisionNumber: 1,
      revision: 2,
      updatedAt: saved,
      hasDraft: false
    })
    // Alpha, Beta and the sprint acceptance node.
    expect(ctx.db.all('SELECT status, revision, updated_at FROM ticket_status WHERE epic_id = ?', epicId)).toEqual([
      { status: 'backlog', revision: 1, updated_at: saved },
      { status: 'backlog', revision: 1, updated_at: saved },
      { status: 'backlog', revision: 1, updated_at: saved }
    ])
    expect(eventKinds(ctx).at(-1)).toBe('plan.saved')
    expect(lastPayload(ctx)).toEqual({ revisionId, number: 1 })
  })

})

describe('completeSavedRevision search index', () => {
  it('indexes the saved tickets and the epic for search', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const rows = ctx.db.all<{ doc_type: string; doc_id: string; ticket_id: string | null; title: string; body: string }>(
      'SELECT doc_type, doc_id, ticket_id, title, body FROM search_index ORDER BY doc_type, title'
    )
    expect(rows).toEqual([
      { doc_type: 'epic', doc_id: saved.epicId, ticket_id: null, title: 'Checkout', body: 'Ship it\nCustomers can pay' },
      { doc_type: 'ticket', doc_id: saved.refMap.a, ticket_id: saved.refMap.a, title: 'DM-1 Alpha', body: 'Alpha works' },
      { doc_type: 'ticket', doc_id: saved.refMap.b, ticket_id: saved.refMap.b, title: 'DM-2 Beta', body: 'Beta works' }
    ])
  })

  it('is a no-op for a revision that is already saved and rejects unknown revisions', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const events = eventKinds(ctx)
    ctx.db.tx(() => completeSavedRevision(ctx, saved.revisionId))
    expect(getEpic(ctx, { epicId: saved.epicId }).revision).toBe(2)
    expect(eventKinds(ctx)).toEqual(events)
    expect(captureError(() => completeSavedRevision(ctx, 'rv_missing'))).toEqual({
      code: 'not_found',
      message: 'Revision rv_missing not found.',
      details: { revisionId: 'rv_missing' }
    })
  })
})

describe('completeSavedRevision releases comments', () => {
  it('queues the export of comments written before the first save and while it was pending', () => {
    const ctx = createTestCtx()
    const epicId = newEpicWithTickets(ctx)
    const early = addComment(ctx, { epicId, body: 'before the save' })
    const { revisionId } = requestSave(ctx, { epicId, expectedDraftRevision: 2 })
    const racing = addComment(ctx, { epicId, body: 'while the save is pending' })
    expect(outboxRows(ctx).map((row) => row.kind)).toEqual(['snapshot'])
    ctx.db.tx(() => completeSavedRevision(ctx, revisionId))
    expect(ctx.db.all("SELECT epic_id, entity_id, state FROM outbox WHERE kind = 'comment' ORDER BY id")).toEqual([
      { epic_id: epicId, entity_id: early.id, state: 'pending' },
      { epic_id: epicId, entity_id: racing.id, state: 'pending' }
    ])
  })
})

describe('completeSavedRevision with later edits', () => {
  it('rebases a draft edited after the save request so the edits are kept', () => {
    const ctx = createTestCtx()
    const epicId = newEpicWithTickets(ctx)
    const { revisionId } = requestSave(ctx, { epicId, expectedDraftRevision: 2 })
    updatePlanDraft(ctx, { epicId, ops: [addTicket('Gamma')] })
    ctx.db.tx(() => completeSavedRevision(ctx, revisionId))
    const draft = getPlan(ctx, { epicId, view: 'draft' })
    expect(draft).toMatchObject({ baseRevisionId: revisionId, baseRevisionNumber: 1, draftRevision: 3, stale: false })
    expect(draft.changes.map((change) => change.detail)).toEqual(['DM-4 Gamma added to Sprint 1'])
  })

  it('keeps existing ticket statuses and leaves a draft with an unrelated base untouched', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    ctx.db.run("UPDATE ticket_status SET status = 'in_progress' WHERE ticket_id = ?", saved.refMap.a)
    const gamma = updatePlanDraft(ctx, { epicId: saved.epicId, ops: [{ ...addTicket('Gamma'), ref: 'g' }] }).refMap.g
    const { revisionId } = requestSave(ctx, { epicId: saved.epicId, expectedDraftRevision: 2 })
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [addTicket('Delta')] })
    ctx.db.run('UPDATE drafts SET base_revision_id = NULL WHERE epic_id = ?', saved.epicId)
    ctx.db.tx(() => completeSavedRevision(ctx, revisionId))
    const statuses = ctx.db.all<{ ticket_id: string; status: string }>('SELECT ticket_id, status FROM ticket_status')
    expect(new Map(statuses.map((row) => [row.ticket_id, row.status]))).toEqual(
      new Map([
        [saved.refMap.a, 'in_progress'],
        [saved.refMap.b, 'backlog'],
        [gamma, 'backlog']
      ])
    )
    expect(getPlan(ctx, { epicId: saved.epicId, view: 'draft' })).toMatchObject({ baseRevisionId: null, stale: true })
  })
})

describe('getPlan saved view', () => {
  it('returns the current saved revision as an immutable view', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const view = getPlan(ctx, { epicId: saved.epicId, view: 'saved' })
    expect(view).toEqual({
      epicId: saved.epicId,
      view: 'saved',
      revisionId: saved.revisionId,
      revisionNumber: 1,
      baseRevisionId: null,
      baseRevisionNumber: null,
      draftRevision: null,
      contentHash: contentHash(view.bundle),
      bundle: view.bundle,
      readOnly: true,
      readOnlyReason: SAVED_REASON,
      changes: [],
      stale: false
    })
    expect(view.bundle.tickets.map((ticket) => ticket.id)).toEqual([saved.refMap.a, saved.refMap.b])
  })

  it('never shows draft-only tickets and requires the read capability', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [addTicket('Draft only')] })
    const titles = getPlan(ctx, { epicId: saved.epicId, view: 'saved' }).bundle.tickets.map((ticket) => ticket.title)
    expect(titles).toEqual(['Alpha', 'Beta'])
    const noRead = withRole(ctx, 'worker', { capabilities: [] })
    expect(captureError(() => getPlan(noRead, { epicId: saved.epicId, view: 'saved' })).code).toBe('unauthorized')
  })

  it('explains that completed epics are read-only', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    openDraft(ctx, { epicId: saved.epicId })
    ctx.db.run("UPDATE epics SET status = 'completed' WHERE id = ?", saved.epicId)
    expect(getPlan(ctx, { epicId: saved.epicId, view: 'saved' }).readOnlyReason).toBe('Completed epics are read-only.')
    expect(getPlan(ctx, { epicId: saved.epicId, view: 'draft' })).toMatchObject({
      readOnly: true,
      readOnlyReason: 'Completed epics are read-only.'
    })
  })
})

describe('saved revisions stay immutable and readable', () => {
  it('creates revision 2 on the next save while revision 1 stays readable', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [addTicket('Gamma')] })
    const second = saveNow(ctx, saved.epicId)
    const first = getPlan(ctx, { epicId: saved.epicId, view: 'saved', revisionId: saved.revisionId })
    const current = getPlan(ctx, { epicId: saved.epicId, view: 'saved' })
    expect(first).toMatchObject({ revisionId: saved.revisionId, revisionNumber: 1, baseRevisionId: null })
    expect(first.bundle.tickets.map((ticket) => ticket.title)).toEqual(['Alpha', 'Beta'])
    expect(current).toMatchObject({
      revisionId: second,
      revisionNumber: 2,
      baseRevisionId: saved.revisionId,
      baseRevisionNumber: 1
    })
    expect(current.bundle.tickets.map((ticket) => ticket.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
  })

  it('keeps a run pinned to its revision after a newer save', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const run = insertRun(ctx, { epicId: saved.epicId, revisionId: saved.revisionId, state: 'running' })
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [addTicket('Gamma')] })
    saveNow(ctx, saved.epicId)
    expect(ctx.db.get('SELECT revision_id FROM runs WHERE id = ?', run)).toEqual({ revision_id: saved.revisionId })
    expect(listEpics(ctx)[0].run?.revisionNumber).toBe(1)
    expect(listEpics(ctx)[0].currentRevisionNumber).toBe(2)
  })

  it('rejects revisions of other epics', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const other = createSavedEpic(ctx, { title: 'Other' })
    const error = captureError(() => getPlan(ctx, { epicId: saved.epicId, view: 'saved', revisionId: other.revisionId }))
    expect(error.code).toBe('not_found')
  })
})

describe('getPlan draft view', () => {
  it('lists every part of a never-saved draft as added', () => {
    const ctx = createTestCtx()
    const epicId = newEpicWithTickets(ctx)
    const view = getPlan(ctx, { epicId, view: 'draft' })
    expect(view).toMatchObject({
      view: 'draft',
      revisionId: null,
      revisionNumber: null,
      baseRevisionId: null,
      baseRevisionNumber: null,
      draftRevision: 2,
      readOnly: false,
      readOnlyReason: null,
      stale: false
    })
    expect(view.contentHash).toBe(contentHash(view.bundle))
    expect(view.changes).toEqual(computeChanges(null, view.bundle))
    expect(view.changes[0]).toMatchObject({ kind: 'added', target: 'epic' })
  })

  it('shows changes against the base and flags a stale base', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [addTicket('Gamma')] })
    const fresh = getPlan(ctx, { epicId: saved.epicId, view: 'draft' })
    expect(fresh.changes.map((change) => change.detail)).toEqual(['DM-3 Gamma added to Sprint 1'])
    expect(fresh.stale).toBe(false)
    simulatePull(ctx, saved.epicId, saved.revisionId)
    const stale = getPlan(ctx, { epicId: saved.epicId, view: 'draft' })
    expect(stale).toMatchObject({ stale: true, baseRevisionId: saved.revisionId, baseRevisionNumber: 1 })
    expect(stale.changes).toEqual(fresh.changes)
  })

  it('explains how to open a missing draft', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    expect(captureError(() => getPlan(ctx, { epicId: saved.epicId, view: 'draft' }))).toEqual({
      code: 'not_found',
      message: 'No draft. Open one with openDraft or update_plan_draft.',
      details: { epicId: saved.epicId }
    })
  })
})

describe('validatePlanView', () => {
  it('validates the saved or the draft bundle', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    openDraft(ctx, { epicId: saved.epicId })
    ctx.db.run(
      "UPDATE drafts SET bundle_json = json_set(bundle_json, '$.sprints[0].ticketIds', json('[]')) WHERE epic_id = ?",
      saved.epicId
    )
    // A plan of work tickets alone, like one saved before acceptance nodes, saves with a warning only.
    const savedReport = validatePlanView(ctx, { epicId: saved.epicId, view: 'saved' })
    expect(savedReport.valid).toBe(true)
    expect(savedReport.errors).toEqual([])
    expect(savedReport.warnings.map((issue) => issue.code)).toEqual(['missing_acceptance_node'])
    const draft = validatePlanView(ctx, { epicId: saved.epicId, view: 'draft' })
    expect(draft.valid).toBe(false)
    expect(draft.errors.map((issue) => issue.code)).toEqual(['ticket_not_in_sprint', 'ticket_not_in_sprint'])
    const noRead = withRole(ctx, 'worker', { capabilities: [] })
    expect(captureError(() => validatePlanView(noRead, { epicId: saved.epicId, view: 'saved' })).code).toBe('unauthorized')
  })
})

describe('saveResult', () => {
  it('reports pending with the last snapshot error, then saved', () => {
    const ctx = createTestCtx()
    const epicId = newEpicWithTickets(ctx)
    const { revisionId, contentHash: hash } = requestSave(ctx, { epicId, expectedDraftRevision: 2 })
    expect(saveResult(ctx, revisionId)).toEqual({
      status: 'pending',
      epicId,
      revisionId,
      revisionNumber: 1,
      contentHash: hash,
      error: null
    })
    ctx.db.run("UPDATE outbox SET state = 'failed', last_error = 'disk full' WHERE revision_id = ?", revisionId)
    expect(saveResult(ctx, revisionId).error).toBe('disk full')
    ctx.db.tx(() => completeSavedRevision(ctx, revisionId))
    expect(saveResult(ctx, revisionId)).toMatchObject({ status: 'saved', error: null })
    expect(captureError(() => saveResult(ctx, 'rv_missing')).code).toBe('not_found')
  })
})

describe('listRevisions', () => {
  it('lists revisions newest first and marks the current one', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [addTicket('Gamma')] })
    ctx.clock.advanceSeconds(60)
    const second = saveNow(ctx, saved.epicId)
    const later = '2026-01-01T00:01:00.000Z'
    const [newest, oldest] = listRevisions(ctx, { epicId: saved.epicId })
    expect(newest).toEqual({
      id: second,
      number: 2,
      state: 'saved',
      contentHash: getPlan(ctx, { epicId: saved.epicId, view: 'saved' }).contentHash,
      baseRevisionId: saved.revisionId,
      createdAt: later,
      savedAt: later,
      ticketCount: 3,
      isCurrent: true
    })
    expect(oldest).toMatchObject({ id: saved.revisionId, number: 1, createdAt: T0, ticketCount: 2, isCurrent: false })
    expect(captureError(() => listRevisions(ctx, { epicId: 'ep_missing' })).code).toBe('not_found')
  })
})

describe('discard after a save', () => {
  it('returns to the saved plan exactly', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const before = getPlan(ctx, { epicId: saved.epicId, view: 'saved' })
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [{ op: 'remove_ticket', ticket: 'DM-1' }] })
    discardPlanDraft(ctx, { epicId: saved.epicId })
    expect(getPlan(ctx, { epicId: saved.epicId, view: 'saved' })).toEqual(before)
    expect(openDraft(ctx, { epicId: saved.epicId }).bundle).toEqual(before.bundle)
  })
})

describe('revision helpers for other services', () => {
  it('load a revision bundle and the current saved bundle', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const unsaved = createEpic(ctx, { title: 'Unsaved' })
    const bundle = loadRevisionBundle(ctx, saved.revisionId)
    expect(bundle).toEqual(getPlan(ctx, { epicId: saved.epicId, view: 'saved' }).bundle)
    expect(currentSavedBundle(ctx, saved.epicId)).toEqual({ revisionId: saved.revisionId, number: 1, bundle })
    expect(currentSavedBundle(ctx, unsaved.id)).toBeNull()
    expect(captureError(() => loadRevisionBundle(ctx, 'rv_missing')).code).toBe('not_found')
  })
})
