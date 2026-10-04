import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import {
  captureError,
  createSavedEpic,
  eventKinds,
  insertRun,
  outboxRows,
  saveNow
} from '../../test/authoring'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { canonicalJson } from '../canonical'
import { createInitialBundle } from '../plan/normalize'
import { openDraft, updatePlanDraft } from './drafts'
import { assertEpicOpen, createEpic, getEpic, listEpics, loadEpicRow, setEpicBranch, setEpicStatus } from './epics'
import { requestSave } from './plans'

const T0 = '2026-01-01T00:00:00.000Z'
const BRANCH = { repository: null, name: 'feature/checkout', startCommit: null }

function forceStatus(ctx: TestCtx, epicId: string, status: string): void {
  ctx.db.run('UPDATE epics SET status = ? WHERE id = ?', status, epicId)
}

function epicCount(ctx: TestCtx): number {
  return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM epics')?.n ?? -1
}

describe('createEpic', () => {
  it('creates a backlog epic with an initial one-sprint draft', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: '  Checkout  ', intent: 'Ship it', successCriteria: ['Customers can pay'] })
    expect(epic).toEqual({
      id: epic.id,
      title: 'Checkout',
      status: 'backlog',
      revision: 1,
      currentRevisionId: null,
      currentRevisionNumber: null,
      hasDraft: true,
      draftRevision: 1,
      draftChanged: true,
      ticketCount: 1,
      sprintCount: 1,
      run: null,
      branch: null,
      pendingSave: false,
      conflict: null,
      createdAt: T0,
      updatedAt: T0,
      completedAt: null,
      intent: 'Ship it',
      successCriteria: [{ id: 's1', text: 'Customers can pay' }],
      ownerRole: null,
      provenance: null,
      outcome: null
    })
    expect(eventKinds(ctx)).toEqual(['epic.created'])
    expect(outboxRows(ctx)).toEqual([])
  })
})

describe('createEpic initial draft', () => {
  it('stores the draft with no base revision at draft revision 1', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Checkout', ownerRole: 'planner' })
    const draft = ctx.db.get<{ base_revision_id: string | null; draft_revision: number; bundle_json: string; updated_by: string }>(
      'SELECT base_revision_id, draft_revision, bundle_json, updated_by FROM drafts WHERE epic_id = ?',
      epic.id
    )
    const bundle = JSON.parse(draft?.bundle_json ?? '{}') as PlanBundle
    expect(draft?.base_revision_id).toBeNull()
    expect(draft?.draft_revision).toBe(1)
    expect(draft?.updated_by).toBe(ctx.session.id)
    expect(bundle).toEqual(
      createInitialBundle(
        { title: 'Checkout', intent: '', successCriteria: [], ownerRole: 'planner' },
        { sprintId: bundle.sprints[0].id, ticketId: bundle.tickets[0].id, ticketKey: 'DM-1' }
      )
    )
    expect(bundle.sprints[0].id).toMatch(/^sp_/)
  })

  it('rejects a blank title', () => {
    const ctx = createTestCtx()
    expect(captureError(() => createEpic(ctx, { title: '   ' }))).toEqual({
      code: 'invalid_input',
      message: 'The epic needs a title.',
      details: undefined
    })
    expect(epicCount(ctx)).toBe(0)
  })
})

describe('createEpic acceptance node', () => {
  it('puts the first sprint acceptance node in the draft, ready for its criteria', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Checkout' })
    const draft = ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM drafts WHERE epic_id = ?', epic.id)
    const bundle = JSON.parse(draft?.bundle_json ?? '{}') as PlanBundle
    expect(bundle.tickets).toHaveLength(1)
    expect(bundle.tickets[0]).toMatchObject({
      id: expect.stringMatching(/^tk_/),
      key: 'DM-1',
      title: 'Sprint 1 acceptance',
      kind: 'acceptance',
      acceptanceCriteria: [],
      capability: { workType: 'testing' }
    })
    expect(bundle.sprints[0].ticketIds).toEqual([bundle.tickets[0].id])
    expect(epic.ticketCount).toBe(1)
  })

  it('numbers the node of each new epic after the keys the project already uses', () => {
    const ctx = createTestCtx()
    createEpic(ctx, { title: 'First' })
    const second = createEpic(ctx, { title: 'Second' })
    const draft = ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM drafts WHERE epic_id = ?', second.id)
    expect((JSON.parse(draft?.bundle_json ?? '{}') as PlanBundle).tickets.map((ticket) => ticket.key)).toEqual(['DM-2'])
  })
})

describe('createEpic branch and provenance', () => {
  it('records the branch and a provenance link to a completed epic', () => {
    const ctx = createTestCtx()
    const source = createEpic(ctx, { title: 'Old work' })
    forceStatus(ctx, source.id, 'completed')
    const plain = createEpic(ctx, { title: 'Redo', branch: BRANCH, provenance: { sourceEpicId: source.id } })
    const noted = createEpic(ctx, { title: 'Extend', provenance: { sourceEpicId: source.id, note: 'Follow-up' } })
    expect(plain.branch).toEqual(BRANCH)
    expect(plain.provenance).toEqual({ sourceEpicId: source.id, note: '' })
    expect(noted.provenance).toEqual({ sourceEpicId: source.id, note: 'Follow-up' })
    expect(noted.branch).toBeNull()
  })

  it('rejects an unknown provenance source without creating anything', () => {
    const ctx = createTestCtx()
    const error = captureError(() => createEpic(ctx, { title: 'Orphan', provenance: { sourceEpicId: 'ep_missing' } }))
    expect(error.code).toBe('not_found')
    expect(error.message).toBe('Source epic ep_missing not found.')
    expect(epicCount(ctx)).toBe(0)
  })
})

describe('createEpic idempotency and authorization', () => {
  it('returns the original epic for a repeated idempotency key', () => {
    const ctx = createTestCtx()
    const first = createEpic(ctx, { title: 'Checkout', idempotencyKey: 'k1' })
    ctx.clock.advanceSeconds(5)
    expect(createEpic(ctx, { title: 'Checkout', idempotencyKey: 'k1' })).toEqual(first)
    expect(epicCount(ctx)).toBe(1)
    expect(captureError(() => createEpic(ctx, { title: 'Other', idempotencyKey: 'k1' })).code).toBe('idempotency_mismatch')
  })

  it('requires the epic.create capability', () => {
    const ctx = createTestCtx()
    const error = captureError(() => createEpic(withRole(ctx, 'worker'), { title: 'Nope' }))
    expect(error.code).toBe('unauthorized')
    expect(error.details).toEqual({ role: 'worker', capability: 'epic.create' })
    expect(createEpic(withRole(ctx, 'planner'), { title: 'Planned' }).status).toBe('backlog')
  })
})

describe('listEpics ordering', () => {
  it('orders in progress, backlog, completed, then most recently updated first', () => {
    const ctx = createTestCtx()
    const done = createEpic(ctx, { title: 'Done' })
    forceStatus(ctx, done.id, 'completed')
    ctx.clock.advanceSeconds(10)
    const older = createEpic(ctx, { title: 'Older' })
    ctx.clock.advanceSeconds(10)
    const newer = createEpic(ctx, { title: 'Newer' })
    const tie = createEpic(ctx, { title: 'Tie' })
    ctx.clock.advanceSeconds(10)
    const active = createEpic(ctx, { title: 'Active' })
    ctx.clock.set(T0)
    setEpicStatus(ctx, { epicId: active.id, status: 'in_progress' })
    expect(listEpics(ctx).map((epic) => epic.title)).toEqual(['Active', 'Tie', 'Newer', 'Older', 'Done'])
    expect(listEpics(ctx).map((epic) => epic.id)).toEqual([active.id, tie.id, newer.id, older.id, done.id])
  })

  it('requires the read capability', () => {
    const ctx = createTestCtx()
    const error = captureError(() => listEpics(withRole(ctx, 'worker', { capabilities: [] })))
    expect(error.code).toBe('unauthorized')
    expect(listEpics(withRole(ctx, 'reviewer'))).toEqual([])
  })
})

describe('listEpics summaries of saved and unsaved epics', () => {
  it('counts the saved plan, not the draft, once an epic has been saved', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Gamma' } }] })
    const [summary] = listEpics(ctx)
    expect(summary).toMatchObject({
      id: saved.epicId,
      currentRevisionId: saved.revisionId,
      currentRevisionNumber: 1,
      hasDraft: true,
      draftRevision: 2,
      ticketCount: 2,
      sprintCount: 1,
      pendingSave: false,
      run: null
    })
    expect(summary.revision).toBe(2)
  })

  it('counts the draft of a never-saved epic and flags a pending save', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Draft only' })
    updatePlanDraft(ctx, {
      epicId: epic.id,
      ops: [
        { op: 'add_sprint', sprint: { goal: 'Second' } },
        { op: 'add_ticket', sprint: '2', ticket: { title: 'Solo' } }
      ]
    })
    // Solo plus the acceptance node of each of the two sprints.
    expect(listEpics(ctx)[0]).toMatchObject({ ticketCount: 3, sprintCount: 2, pendingSave: false, hasDraft: true })
    requestSave(ctx, { epicId: epic.id, expectedDraftRevision: 2 })
    expect(listEpics(ctx)[0]).toMatchObject({ pendingSave: true, currentRevisionId: null, currentRevisionNumber: null })
  })

  it('reports no draft once the saved plan has no pending edits and surfaces sync conflicts', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    ctx.db.run(
      "INSERT INTO sync_state (kind, entity_id, conflict, updated_at) VALUES ('epic', ?, 'Tracked state changed', ?)",
      saved.epicId,
      T0
    )
    expect(listEpics(ctx)[0]).toMatchObject({
      hasDraft: false,
      draftRevision: null,
      draftChanged: false,
      conflict: 'Tracked state changed'
    })
  })
})

function draftJson(ctx: TestCtx, epicId: string): string {
  return ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM drafts WHERE epic_id = ?', epicId)?.bundle_json ?? ''
}

describe('listEpics draft changes', () => {
  it('does not count a draft opened from the saved plan as a change until it is edited', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    openDraft(ctx, { epicId: saved.epicId })
    expect(listEpics(ctx)[0]).toMatchObject({ hasDraft: true, draftRevision: 1, draftChanged: false })
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [{ op: 'set_rationale', rationale: 'Smaller steps' }] })
    expect(listEpics(ctx)[0]).toMatchObject({ hasDraft: true, draftRevision: 2, draftChanged: true })
  })

  it('compares plan content, not how the draft happens to be serialized', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    openDraft(ctx, { epicId: saved.epicId })
    const reordered = canonicalJson(JSON.parse(draftJson(ctx, saved.epicId)))
    expect(reordered).not.toBe(draftJson(ctx, saved.epicId))
    ctx.db.run('UPDATE drafts SET bundle_json = ? WHERE epic_id = ?', reordered, saved.epicId)
    expect(getEpic(ctx, { epicId: saved.epicId }).draftChanged).toBe(false)
    const alpha = saved.refMap['a'] ?? ''
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [{ op: 'update_ticket', ticket: alpha, patch: { title: 'Alphb' } }] })
    expect(getEpic(ctx, { epicId: saved.epicId }).draftChanged).toBe(true)
  })

  it('counts the draft of a never-saved epic as a change and reports none for an epic without a draft', () => {
    const ctx = createTestCtx()
    const unsaved = createEpic(ctx, { title: 'Draft only' })
    const clean = createSavedEpic(ctx, { title: 'Clean' })
    expect(getEpic(ctx, { epicId: unsaved.id }).draftChanged).toBe(true)
    expect(getEpic(ctx, { epicId: clean.epicId })).toMatchObject({ hasDraft: false, draftChanged: false })
  })
})

describe('listEpics run summaries', () => {
  it('prefers the active run and describes its pinned revision', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const bundle = JSON.parse(
      ctx.db.get<{ bundle_json: string }>('SELECT bundle_json FROM plan_revisions WHERE id = ?', saved.revisionId)
        ?.bundle_json ?? '{}'
    ) as PlanBundle
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [{ op: 'add_sprint', sprint: { goal: 'More' } }] })
    saveNow(ctx, saved.epicId)
    insertRun(ctx, { epicId: saved.epicId, revisionId: saved.revisionId, state: 'completed', number: 1 })
    const paused = insertRun(ctx, {
      epicId: saved.epicId,
      revisionId: saved.revisionId,
      state: 'paused',
      number: 2,
      activeSprintId: bundle.sprints[0].id,
      pauseReason: 'Branch changed'
    })
    insertRun(ctx, { epicId: saved.epicId, revisionId: saved.revisionId, state: 'failed', number: 3 })
    const [summary] = listEpics(ctx)
    expect(summary.currentRevisionNumber).toBe(2)
    expect(summary.sprintCount).toBe(2)
    expect(summary.run).toEqual({
      id: paused,
      state: 'paused',
      revisionNumber: 1,
      activeSprintOrdinal: 1,
      sprintCount: 1,
      pauseReason: 'Branch changed'
    })
  })

  it('falls back to the latest run when none is active', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    insertRun(ctx, { epicId: saved.epicId, revisionId: saved.revisionId, state: 'completed', number: 1 })
    const latest = insertRun(ctx, { epicId: saved.epicId, revisionId: saved.revisionId, state: 'canceled', number: 2 })
    expect(listEpics(ctx)[0].run).toEqual({
      id: latest,
      state: 'canceled',
      revisionNumber: 1,
      activeSprintOrdinal: null,
      sprintCount: 1,
      pauseReason: null
    })
  })
})

describe('getEpic', () => {
  it('reads content from the saved plan even when the draft differs', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [{ op: 'set_epic', title: 'Renamed', intent: 'Draft intent' }] })
    expect(getEpic(ctx, { epicId: saved.epicId })).toMatchObject({
      title: 'Checkout',
      intent: 'Ship it',
      successCriteria: [{ id: 's1', text: 'Customers can pay' }],
      ownerRole: null
    })
  })

  it('reads content from the draft of a never-saved epic', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Checkout' })
    updatePlanDraft(ctx, {
      epicId: epic.id,
      ops: [{ op: 'set_epic', title: 'Renamed', intent: 'Draft intent', successCriteria: ['Works'], ownerRole: 'qa' }]
    })
    expect(getEpic(ctx, { epicId: epic.id })).toMatchObject({
      title: 'Renamed',
      intent: 'Draft intent',
      successCriteria: [{ id: 's1', text: 'Works' }],
      ownerRole: 'qa'
    })
  })

})

describe('getEpic outcome and fallbacks', () => {
  it('parses the recorded outcome and rejects unknown epics', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Checkout' })
    const outcome = { summary: 'Shipped', successCriteria: [], recordedAt: T0, runId: null }
    ctx.db.run('UPDATE epics SET outcome_json = ? WHERE id = ?', JSON.stringify(outcome), epic.id)
    expect(getEpic(ctx, { epicId: epic.id }).outcome).toEqual(outcome)
    expect(captureError(() => getEpic(ctx, { epicId: 'ep_missing' }))).toEqual({
      code: 'not_found',
      message: 'Epic ep_missing not found.',
      details: { epicId: 'ep_missing' }
    })
  })

  it('falls back to the epic row when no plan content exists', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Bare', intent: 'Lost' })
    ctx.db.run('DELETE FROM drafts WHERE epic_id = ?', epic.id)
    expect(getEpic(ctx, { epicId: epic.id })).toMatchObject({
      title: 'Bare',
      intent: '',
      successCriteria: [],
      ownerRole: null,
      ticketCount: 0,
      sprintCount: 0,
      hasDraft: false
    })
  })
})

describe('setEpicStatus transitions', () => {
  it('moves a saved epic to in progress, bumps its revision, and exports its state', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    ctx.clock.advanceSeconds(60)
    const view = setEpicStatus(ctx, { epicId: saved.epicId, status: 'in_progress', expectedRevision: 2 })
    expect(view).toMatchObject({ status: 'in_progress', revision: 3, updatedAt: '2026-01-01T00:01:00.000Z' })
    expect(eventKinds(ctx).at(-1)).toBe('epic.status_changed')
    expect(outboxRows(ctx).filter((row) => row.kind === 'epic_state')).toEqual([
      { kind: 'epic_state', epicId: saved.epicId, revisionId: null }
    ])
  })

  it('records the transition in the event payload and never exports an unsaved epic', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Unsaved' })
    setEpicStatus(ctx, { epicId: epic.id, status: 'in_progress' })
    const event = ctx.db.get<{ payload_json: string; epic_id: string }>(
      "SELECT payload_json, epic_id FROM events WHERE kind = 'epic.status_changed'"
    )
    expect(JSON.parse(event?.payload_json ?? '{}')).toEqual({ from: 'backlog', to: 'in_progress' })
    expect(event?.epic_id).toBe(epic.id)
    expect(outboxRows(ctx)).toEqual([])
  })

  it('treats the current status as a no-op', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Same' })
    expect(setEpicStatus(ctx, { epicId: epic.id, status: 'backlog', expectedRevision: 99 }).revision).toBe(1)
    expect(eventKinds(ctx)).toEqual(['epic.created'])
  })

  it('rejects a stale expected revision', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Stale' })
    const error = captureError(() => setEpicStatus(ctx, { epicId: epic.id, status: 'in_progress', expectedRevision: 2 }))
    expect(error.code).toBe('conflict')
    expect(error.details).toEqual({ currentRevision: 1 })
    expect(getEpic(ctx, { epicId: epic.id }).status).toBe('backlog')
  })
})

describe('setEpicStatus completion rules', () => {
  it('never completes an epic through the status tool', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Finish' })
    expect(captureError(() => setEpicStatus(ctx, { epicId: epic.id, status: 'completed' }))).toEqual({
      code: 'unauthorized_transition',
      message:
        'Epics complete when the final sprint checkpoint advances (advance_sprint); status tools cannot bypass completion rules.',
      details: undefined
    })
  })

  it('keeps completed epics read-only', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Closed' })
    forceStatus(ctx, epic.id, 'completed')
    expect(captureError(() => setEpicStatus(ctx, { epicId: epic.id, status: 'in_progress' }))).toEqual({
      code: 'completed_epic',
      message: 'Completed epics are read-only. Create a new epic to extend this work.',
      details: undefined
    })
    expect(captureError(() => setEpicStatus(ctx, { epicId: epic.id, status: 'completed' })).code).toBe('completed_epic')
  })

  it('moves back to backlog only without an active run', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    setEpicStatus(ctx, { epicId: saved.epicId, status: 'in_progress' })
    const run = insertRun(ctx, { epicId: saved.epicId, revisionId: saved.revisionId, state: 'running' })
    const error = captureError(() => setEpicStatus(ctx, { epicId: saved.epicId, status: 'backlog' }))
    expect(error.code).toBe('active_run_exists')
    expect(error.details).toEqual({ runId: run })
    ctx.db.run("UPDATE runs SET state = 'canceled' WHERE id = ?", run)
    expect(setEpicStatus(ctx, { epicId: saved.epicId, status: 'backlog' }).status).toBe('backlog')
  })

  it('requires the epic.status capability', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Guarded' })
    expect(captureError(() => setEpicStatus(withRole(ctx, 'planner'), { epicId: epic.id, status: 'in_progress' })).code).toBe(
      'unauthorized'
    )
    expect(setEpicStatus(withRole(ctx, 'desktop'), { epicId: epic.id, status: 'in_progress' }).status).toBe('in_progress')
  })
})

describe('setEpicBranch', () => {
  it('records the branch, bumps the revision, and exports saved epics', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const view = setEpicBranch(ctx, { epicId: saved.epicId, branch: BRANCH, expectedRevision: 2 })
    expect(view).toMatchObject({ branch: BRANCH, revision: 3 })
    expect(getEpic(ctx, { epicId: saved.epicId }).branch).toEqual(BRANCH)
    expect(eventKinds(ctx).at(-1)).toBe('epic.branch_set')
    expect(outboxRows(ctx).filter((row) => row.kind === 'epic_state')).toHaveLength(1)
  })

  it('does not export an unsaved epic', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Unsaved' })
    expect(setEpicBranch(ctx, { epicId: epic.id, branch: BRANCH }).branch).toEqual(BRANCH)
    expect(outboxRows(ctx)).toEqual([])
  })

  it('rejects stale revisions, active runs, completed epics, and missing capability', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const stale = captureError(() => setEpicBranch(ctx, { epicId: saved.epicId, branch: BRANCH, expectedRevision: 1 }))
    expect(stale).toMatchObject({ code: 'conflict', details: { currentRevision: 2 } })
    const run = insertRun(ctx, { epicId: saved.epicId, revisionId: saved.revisionId, state: 'queued' })
    expect(captureError(() => setEpicBranch(ctx, { epicId: saved.epicId, branch: BRANCH }))).toMatchObject({
      code: 'active_run_exists',
      details: { runId: run }
    })
    forceStatus(ctx, saved.epicId, 'completed')
    expect(captureError(() => setEpicBranch(ctx, { epicId: saved.epicId, branch: BRANCH })).code).toBe('completed_epic')
    const planner = withRole(ctx, 'planner')
    expect(captureError(() => setEpicBranch(planner, { epicId: saved.epicId, branch: BRANCH })).code).toBe('unauthorized')
  })
})

describe('loadEpicRow and assertEpicOpen', () => {
  it('loads rows and lets open epics through', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Open' })
    const row = loadEpicRow(ctx, epic.id)
    expect(row).toMatchObject({ id: epic.id, title: 'Open', status: 'backlog', revision: 1, current_revision_id: null })
    expect(() => assertEpicOpen(row)).not.toThrow()
    expect(captureError(() => assertEpicOpen({ ...row, status: 'completed' })).code).toBe('completed_epic')
  })
})
