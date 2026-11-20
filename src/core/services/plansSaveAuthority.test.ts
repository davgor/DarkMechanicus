/**
 * DM-900: an orchestrator without `allowSave` saves the plan of an epic whose active run this machine owns, so it can
 * fix the sprint it runs and adopt the revision; every other session without `plan.save` is refused as before.
 */
import { describe, expect, it } from 'vitest'
import type { DraftOp } from '../../shared/domain/api'
import type { RunState } from '../../shared/domain/status'
import { captureError, createSavedEpic, draftRevisionOf, insertAttempt, insertRun, saveNow, TWO_TICKETS } from '../../test/authoring'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { DomainError } from '../errors'
import { adoptRevision } from './adoption'
import { claimTicket, failAttempt } from './attempts'
import { retryTicket } from './autoRetry'
import { updatePlanDraft } from './drafts'
import { getPlan, requestSave } from './plans'
import { startRun } from './runs'

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

describe('save_plan on run ownership alone cannot remove a spent ticket', () => {
  it('refuses removing a ticket with a spent attempt, and says what to do instead', () => {
    const w = twoSprintRun()
    insertAttempt(w.ctx, { runId: w.runId, ticketId: w.beta, state: 'rejected' })
    updatePlanDraft(w.ctx, {
      epicId: w.epicId,
      ops: [
        { op: 'remove_ticket', ticket: w.beta },
        { op: 'add_ticket', sprint: '1', ticket: { title: 'Beta', acceptanceCriteria: ['Beta works'] } }
      ]
    })
    const error = captureError(() => save(w.orchestrator, w.epicId))
    expect(error).toMatchObject({ code: 'unauthorized', details: { tickets: [w.beta] } })
    for (const hint of ['update_ticket keeps its id', 'add new tickets', 'retry_ticket', 'the person saves']) {
      expect(error.message).toContain(hint)
    }
    expect(pendingRevisions(w.ctx, w.epicId)).toBe(0)
  })

  it('counts an abandoned expired lease as spent, but not an accepted, canceled or superseded attempt', () => {
    const w = twoSprintRun()
    insertAttempt(w.ctx, { runId: w.runId, ticketId: w.beta, state: 'lease_expired' })
    w.ctx.db.run("UPDATE attempts SET reconciled_at = '2026-01-01T00:00:00.000Z' WHERE ticket_id = ?", w.beta)
    updatePlanDraft(w.ctx, { epicId: w.epicId, ops: [{ op: 'remove_ticket', ticket: w.beta }] })
    expect(captureError(() => save(w.orchestrator, w.epicId)).code).toBe('unauthorized')
    w.ctx.db.run("UPDATE attempts SET superseded_at = '2026-01-01T00:00:00.000Z' WHERE ticket_id = ?", w.beta)
    insertAttempt(w.ctx, { runId: w.runId, ticketId: w.beta, state: 'canceled' })
    expect(save(w.orchestrator, w.epicId).status).toBe('pending')
  })

  it('still saves once the person has removed the spent ticket and the run adopted that revision', () => {
    const w = twoSprintRun()
    insertAttempt(w.ctx, { runId: w.runId, ticketId: w.beta, state: 'failed' })
    const desktop = withRole(w.ctx, 'desktop')
    updatePlanDraft(desktop, { epicId: w.epicId, ops: [{ op: 'remove_ticket', ticket: w.beta }] })
    adoptRevision(desktop, { runId: w.runId, revisionId: saveNow(desktop, w.epicId) })
    updatePlanDraft(w.orchestrator, { epicId: w.epicId, ops: [{ op: 'set_rationale', rationale: 'Beta was dropped by the person.' }] })
    expect(save(w.orchestrator, w.epicId).status).toBe('pending')
  })

  it('lets it remove a ticket that spent no attempts, and lets allowSave and the desktop remove a spent one', () => {
    const w = twoSprintRun()
    insertAttempt(w.ctx, { runId: w.runId, ticketId: w.beta, state: 'failed' })
    const alpha = getPlan(w.ctx, { epicId: w.epicId, view: 'saved' }).bundle.tickets.find((t) => t.title === 'Alpha')?.id ?? ''
    // Alpha is Beta's prerequisite: drop the edge with it.
    updatePlanDraft(w.ctx, { epicId: w.epicId, ops: [{ op: 'remove_ticket', ticket: alpha }] })
    expect(save(w.orchestrator, w.epicId).status).toBe('pending')
    const v = twoSprintRun()
    insertAttempt(v.ctx, { runId: v.runId, ticketId: v.beta, state: 'failed' })
    updatePlanDraft(v.ctx, { epicId: v.epicId, ops: [{ op: 'remove_ticket', ticket: v.beta }] })
    expect(save(withRole(v.ctx, 'orchestrator', { allowSave: true }), v.epicId).status).toBe('pending')
    const d = twoSprintRun()
    insertAttempt(d.ctx, { runId: d.runId, ticketId: d.beta, state: 'failed' })
    updatePlanDraft(d.ctx, { epicId: d.epicId, ops: [{ op: 'remove_ticket', ticket: d.beta }] })
    expect(save(withRole(d.ctx, 'desktop'), d.epicId).status).toBe('pending')
  })
})

const RETRY_REASON = 'The migration kept timing out on the large fixture.'

/**
 * A started run whose Alpha (one attempt, one orchestrator retry) used up both through the real services, driven by an
 * orchestrator without `allowSave`.
 */
function spentAlpha(): { ctx: TestCtx; epicId: string; runId: string; alpha: string; orchestrator: TestCtx } {
  const ctx = createTestCtx()
  const { epicId } = createSavedEpic(ctx, {
    ops: [
      { op: 'set_policies', patch: { retryLimit: 1, autoRetryLimit: 1 } },
      { op: 'add_ticket', ref: 'a', sprint: '1', ticket: { title: 'Alpha', acceptanceCriteria: ['Alpha works'] } },
      { op: 'add_ticket', ref: 'b', sprint: '1', ticket: { title: 'Beta', acceptanceCriteria: ['Beta works'] } }
    ]
  })
  const orchestrator = withRole(ctx, 'orchestrator', { allowSave: false })
  const worker = withRole(ctx, 'worker')
  const runId = startRun(orchestrator, { epicId }).id
  const alpha = getPlan(ctx, { epicId, view: 'saved' }).bundle.tickets.find((t) => t.title === 'Alpha')?.id ?? ''
  for (let i = 0; i < 2; i += 1) {
    const claimed = claimTicket(orchestrator, { runId, ticketId: alpha, worker: { label: 'w' } })
    failAttempt(worker, { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken ?? '', failure: { reason: 'broken', retryable: true } })
    if (i === 0) {
      retryTicket(orchestrator, { runId, ticketId: alpha, failureReason: RETRY_REASON, newApproach: 'Split the migration into two batches.' })
    }
  }
  return { ctx, epicId, runId, alpha, orchestrator }
}

describe('the remove-and-re-add loop, through the real services', () => {
  it('stops at the save: the spent ticket cannot be swapped for a fresh copy, so its limits stay bounded', () => {
    const { ctx, epicId, runId, alpha, orchestrator } = spentAlpha()
    const again = (): unknown =>
      retryTicket(orchestrator, { runId, ticketId: alpha, failureReason: RETRY_REASON, newApproach: 'Move the work to a higher model tier.' })
    expect(captureError(again).code).toBe('retry_escalation_required')
    updatePlanDraft(orchestrator, {
      epicId,
      ops: [
        { op: 'remove_ticket', ticket: alpha },
        { op: 'add_ticket', sprint: '1', ticket: { title: 'Alpha', acceptanceCriteria: ['Alpha works'] } }
      ]
    })
    expect(captureError(() => save(orchestrator, epicId))).toMatchObject({ code: 'unauthorized', details: { tickets: [alpha] } })
    expect(pendingRevisions(ctx, epicId)).toBe(0)
    // Nothing to adopt either: the epic's current revision is still the one the run executes.
    const current = getPlan(ctx, { epicId, view: 'saved' }).revisionId ?? ''
    const adopt = (): unknown => adoptRevision(orchestrator, { runId, revisionId: current, reason: 'Re-planning the failing ticket as a fresh one.' })
    expect(captureError(adopt)).toMatchObject({ code: 'conflict', message: 'The run already executes this revision.' })
  })
})

describe('save_plan on run ownership alone keeps the policies the person saved last', () => {
  /** The person saves a newer revision with a stricter retry limit, not adopted, so the run still executes the old one. */
  function stricterSaved(): ReturnType<typeof twoSprintRun> {
    const w = twoSprintRun()
    updatePlanDraft(w.ctx, { epicId: w.epicId, ops: [{ op: 'set_policies', patch: { retryLimit: 1 } }] })
    saveNow(withRole(w.ctx, 'desktop'), w.epicId)
    return w
  }

  it('saves an in-place edit on top of the stricter policies the run has not adopted yet', () => {
    const w = stricterSaved()
    updatePlanDraft(w.orchestrator, { epicId: w.epicId, ops: [{ op: 'update_ticket', ticket: w.beta, patch: { title: 'Beta, clarified' } }] })
    expect(save(w.orchestrator, w.epicId).status).toBe('pending')
  })

  it("refuses a draft that reverts them to the run's pinned policies", () => {
    const w = stricterSaved()
    const pinned = getPlan(w.ctx, { epicId: w.epicId, view: 'saved', revisionId: w.revisionId }).bundle.policies
    updatePlanDraft(w.orchestrator, { epicId: w.epicId, ops: [{ op: 'set_policies', patch: { retryLimit: pinned.retryLimit } }] })
    expect(captureError(() => save(w.orchestrator, w.epicId))).toMatchObject({ code: 'unauthorized', details: { field: 'policies' } })
    expect(pendingRevisions(w.ctx, w.epicId)).toBe(0)
  })
})
