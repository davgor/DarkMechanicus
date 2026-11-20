/**
 * DM-900: an orchestrator without `allowSave` saves the plan of an epic whose active run this machine owns, so it can
 * fix the sprint it runs and adopt the revision; every other session without `plan.save` is refused as before.
 */
import { describe, expect, it } from 'vitest'
import type { DraftOp } from '../../shared/domain/api'
import type { RunState } from '../../shared/domain/status'
import { captureError, createSavedEpic, draftRevisionOf, insertAttempt, insertRun, TWO_TICKETS } from '../../test/authoring'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { DomainError } from '../errors'
import { updatePlanDraft } from './drafts'
import { getPlan, requestSave } from './plans'

const OTHER_MACHINE = 'mc_0000000000000000000000other'

interface World {
  ctx: TestCtx
  epicId: string
  revisionId: string
  /** The orchestrator session without `allowSave`. */
  orchestrator: TestCtx
}

/** A saved epic whose draft holds one more ticket, and an orchestrator session launched without `allowSave`. */
function editedEpic(): World {
  const ctx = createTestCtx()
  const { epicId, revisionId } = createSavedEpic(ctx)
  updatePlanDraft(ctx, {
    epicId,
    ops: [{ op: 'add_ticket', sprint: '1', ticket: { title: 'Gamma', acceptanceCriteria: ['Gamma works'] } }]
  })
  return { ctx, epicId, revisionId, orchestrator: withRole(ctx, 'orchestrator', { allowSave: false }) }
}

function save(ctx: TestCtx, epicId: string): ReturnType<typeof requestSave> {
  return requestSave(ctx, { epicId, expectedDraftRevision: draftRevisionOf(ctx, epicId) ?? 0 })
}

function pendingRevisions(ctx: TestCtx, epicId: string): number {
  return ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM plan_revisions WHERE epic_id = ? AND state = 'pending'", epicId)?.n ?? -1
}

describe('save_plan by an orchestrator without allowSave', () => {
  it('does not hold plan.save itself: the right comes from the run, not the role table', () => {
    const { orchestrator } = editedEpic()
    expect(orchestrator.session.capabilities.has('plan.save')).toBe(false)
  })

  it.each<RunState>(['queued', 'running', 'awaiting_checkpoint', 'paused'])(
    'saves the epic whose %s run this machine owns',
    (state) => {
      const { ctx, epicId, revisionId, orchestrator } = editedEpic()
      insertRun(ctx, { epicId, revisionId, state })
      expect(save(orchestrator, epicId).status).toBe('pending')
      expect(pendingRevisions(ctx, epicId)).toBe(1)
    }
  )

})

describe('save_plan by an orchestrator without allowSave, refused', () => {
  it('is refused when the active run belongs to another machine', () => {
    const { ctx, epicId, revisionId, orchestrator } = editedEpic()
    const runId = insertRun(ctx, { epicId, revisionId, state: 'running' })
    ctx.db.run('UPDATE runs SET owner_machine_id = ? WHERE id = ?', OTHER_MACHINE, runId)
    expect(captureError(() => save(orchestrator, epicId))).toMatchObject({
      code: 'unauthorized',
      details: { role: 'orchestrator', capability: 'plan.save' }
    })
    expect(pendingRevisions(ctx, epicId)).toBe(0)
  })

  it('is refused when the epic has no run at all', () => {
    const { ctx, epicId, orchestrator } = editedEpic()
    expect(captureError(() => save(orchestrator, epicId)).code).toBe('unauthorized')
    expect(pendingRevisions(ctx, epicId)).toBe(0)
  })

  it.each<RunState>(['completed', 'canceled', 'failed'])('is refused when the epic only has a %s run', (state) => {
    const { ctx, epicId, revisionId, orchestrator } = editedEpic()
    insertRun(ctx, { epicId, revisionId, state })
    expect(captureError(() => save(orchestrator, epicId)).code).toBe('unauthorized')
  })

  it("is refused for an epic when this machine's active run is another epic's", () => {
    const { ctx, epicId, orchestrator } = editedEpic()
    const other = createSavedEpic(ctx, { title: 'Other' })
    insertRun(ctx, { epicId: other.epicId, revisionId: other.revisionId, state: 'running' })
    expect(captureError(() => save(orchestrator, epicId)).code).toBe('unauthorized')
  })

  it('still runs every other save check: draft revision, validation and branch', () => {
    const { ctx, epicId, revisionId, orchestrator } = editedEpic()
    insertRun(ctx, { epicId, revisionId, state: 'running' })
    const current = draftRevisionOf(ctx, epicId) ?? 0
    expect(captureError(() => requestSave(orchestrator, { epicId, expectedDraftRevision: current - 1 }))).toMatchObject({
      code: 'conflict',
      details: { currentDraftRevision: current }
    })
    const moved: TestCtx = {
      ...orchestrator,
      assertBranch: () => {
        throw new DomainError('branch_changed', 'The checkout moved to another branch.')
      }
    }
    expect(captureError(() => save(moved, epicId)).code).toBe('branch_changed')
    ctx.db.run("UPDATE drafts SET bundle_json = json_set(bundle_json, '$.epic.title', '') WHERE epic_id = ?", epicId)
    expect(captureError(() => save(orchestrator, epicId)).code).toBe('invalid_plan')
    expect(pendingRevisions(ctx, epicId)).toBe(0)
  })
})

describe('save_plan by other sessions without plan.save', () => {
  it.each(['planner', 'worker', 'reviewer', 'reader'] as const)(
    'refuses a %s even for an epic whose active run this machine owns',
    (role) => {
      const { ctx, epicId, revisionId } = editedEpic()
      insertRun(ctx, { epicId, revisionId, state: 'running' })
      expect(captureError(() => save(withRole(ctx, role, { allowSave: false }), epicId)).code).toBe('unauthorized')
      expect(pendingRevisions(ctx, epicId)).toBe(0)
    }
  )

  it('refuses an orchestrator session whose capabilities were narrowed to exclude run.adopt', () => {
    const { ctx, epicId, revisionId, orchestrator } = editedEpic()
    insertRun(ctx, { epicId, revisionId, state: 'running' })
    const narrowed = [...orchestrator.session.capabilities].filter((capability) => capability !== 'run.adopt')
    expect(captureError(() => save(withRole(ctx, 'orchestrator', { capabilities: narrowed }), epicId)).code).toBe('unauthorized')
  })

  it('still lets an orchestrator launched with allowSave save an epic with no run', () => {
    const { ctx, epicId } = editedEpic()
    expect(save(withRole(ctx, 'orchestrator', { allowSave: true }), epicId).status).toBe('pending')
  })
})

/** Sprint 1 = {Alpha, Beta (requires Alpha)}, sprint 2 = {Gamma}; a running run this machine owns pins it. */
function twoSprintRun(): World & { runId: string; beta: string; sprint2: string } {
  const ctx = createTestCtx()
  const ops: DraftOp[] = [
    ...TWO_TICKETS,
    { op: 'add_sprint', ref: 's2', sprint: { goal: 'Later' } },
    { op: 'add_ticket', sprint: 's2', ticket: { title: 'Gamma', acceptanceCriteria: ['Gamma works'] } }
  ]
  const { epicId, revisionId, refMap } = createSavedEpic(ctx, { ops })
  const sprints = getPlan(ctx, { epicId, view: 'saved' }).bundle.sprints
  const sprint2 = sprints.find((sprint) => sprint.ordinal === 2)?.id ?? ''
  const runId = insertRun(ctx, { epicId, revisionId, state: 'running', activeSprintId: sprints[0]?.id ?? null })
  const orchestrator = withRole(ctx, 'orchestrator', { allowSave: false })
  return { ctx, epicId, revisionId, orchestrator, runId, beta: refMap.b ?? '', sprint2 }
}

describe('save_plan on run ownership alone cannot grant retries', () => {
  it('refuses a draft that changes the retry limit, which only the person (or allowSave) saves', () => {
    const w = twoSprintRun()
    updatePlanDraft(w.ctx, { epicId: w.epicId, ops: [{ op: 'set_policies', patch: { retryLimit: 100 } }] })
    expect(captureError(() => save(w.orchestrator, w.epicId))).toMatchObject({ code: 'unauthorized', details: { field: 'policies' } })
    expect(pendingRevisions(w.ctx, w.epicId)).toBe(0)
    expect(save(withRole(w.ctx, 'orchestrator', { allowSave: true }), w.epicId).status).toBe('pending')
  })

  it('refuses moving a ticket with a spent attempt to a later sprint, which would reset its retry budget', () => {
    const w = twoSprintRun()
    insertAttempt(w.ctx, { runId: w.runId, ticketId: w.beta, state: 'failed' })
    updatePlanDraft(w.ctx, { epicId: w.epicId, ops: [{ op: 'move_ticket', ticket: w.beta, toSprint: w.sprint2 }] })
    expect(captureError(() => save(w.orchestrator, w.epicId))).toMatchObject({ code: 'unauthorized', details: { tickets: [w.beta] } })
    expect(pendingRevisions(w.ctx, w.epicId)).toBe(0)
  })

  it('lets it move a ticket that spent no attempts, and change a ticket in place', () => {
    const w = twoSprintRun()
    insertAttempt(w.ctx, { runId: w.runId, ticketId: w.beta, state: 'failed', superseded: true })
    updatePlanDraft(w.ctx, {
      epicId: w.epicId,
      ops: [
        { op: 'move_ticket', ticket: w.beta, toSprint: w.sprint2 },
        { op: 'update_ticket', ticket: w.beta, patch: { title: 'Beta, split' } }
      ]
    })
    expect(save(w.orchestrator, w.epicId).status).toBe('pending')
  })
})
