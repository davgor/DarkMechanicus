import { describe, expect, it } from 'vitest'
import { draftRevisionOf } from '../../test/authoring'
import { makeBundle, tid } from '../../test/bundles'
import { domainError, seedEpic } from '../../test/execution'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { openDraft, updatePlanDraft } from './drafts'
import { requestSave } from './plans'
import { queueRun, startRun } from './runs'
import { deleteTicket } from './ticketDeletion'
import { cancelTransfer, queueTransfer, startTransfer } from './transfers'

const OPEN_TRANSFER = 'Finish or cancel the Linear transfer of this epic first.'

type OpenState = 'queued' | 'in_progress'

/** A saved epic (desktop session) whose transfer is queued, or started by an orchestrator. */
function transferringEpic(state: OpenState): { ctx: TestCtx; epicId: string } {
  const ctx = createTestCtx({ role: 'desktop' })
  const { epicId } = seedEpic(ctx, { bundle: makeBundle([[1, 2]]) })
  queueTransfer(ctx, { epicId })
  if (state === 'in_progress') {
    startTransfer(withRole(ctx, 'orchestrator'), { epicId })
  }
  return { ctx, epicId }
}

/** Opens a draft and changes it: draft edits stay allowed while a transfer is open. Returns the draft revision. */
function editDraft(ctx: TestCtx, epicId: string): number {
  openDraft(ctx, { epicId })
  return updatePlanDraft(ctx, {
    epicId,
    ops: [{ op: 'update_ticket', ticket: tid(1), patch: { title: 'Changed while transferring' } }]
  }).draftRevision
}

function count(ctx: TestCtx, table: 'runs' | 'plan_revisions'): number {
  return ctx.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)?.n ?? 0
}

function refusal(action: () => unknown): [string, string] {
  const error = domainError(action)
  return [error.code, error.message]
}

describe.each<OpenState>(['queued', 'in_progress'])('while a transfer is %s', (state) => {
  it('refuses queueRun with conflict', () => {
    const { ctx, epicId } = transferringEpic(state)
    expect(refusal(() => queueRun(ctx, { epicId }))).toEqual(['conflict', OPEN_TRANSFER])
    expect(domainError(() => queueRun(ctx, { epicId })).details).toEqual({ epicId, transferStatus: state })
    expect(count(ctx, 'runs')).toBe(0)
  })

  it('refuses startRun with conflict', () => {
    const { ctx, epicId } = transferringEpic(state)
    expect(refusal(() => startRun(withRole(ctx, 'orchestrator'), { epicId }))).toEqual(['conflict', OPEN_TRANSFER])
    expect(count(ctx, 'runs')).toBe(0)
  })

  it('allows draft edits but refuses Save with conflict', () => {
    const { ctx, epicId } = transferringEpic(state)
    const draftRevision = editDraft(ctx, epicId)
    expect(refusal(() => requestSave(ctx, { epicId, expectedDraftRevision: draftRevision }))).toEqual([
      'conflict',
      OPEN_TRANSFER
    ])
    expect([count(ctx, 'plan_revisions'), draftRevisionOf(ctx, epicId)]).toEqual([1, draftRevision])
  })

  it('refuses the one-step ticket deletion, which saves, and leaves the plan and draft untouched', () => {
    const { ctx, epicId } = transferringEpic(state)
    expect(refusal(() => deleteTicket(ctx, { epicId, ticketId: tid(2) }))).toEqual(['conflict', OPEN_TRANSFER])
    expect([count(ctx, 'plan_revisions'), draftRevisionOf(ctx, epicId)]).toEqual([1, null])
  })
})

describe.each<OpenState>(['queued', 'in_progress'])('after a %s transfer is canceled', (state) => {
  it('allows Save, queueRun and startRun again', () => {
    const { ctx, epicId } = transferringEpic(state)
    const draftRevision = editDraft(ctx, epicId)
    cancelTransfer(ctx, { epicId })
    expect(requestSave(ctx, { epicId, expectedDraftRevision: draftRevision }).status).toBe('pending')
    const queued = queueRun(ctx, { epicId })
    expect(queued.state).toBe('queued')
    const started = startRun(withRole(ctx, 'orchestrator'), { epicId })
    expect([started.id, started.state]).toEqual([queued.id, 'running'])
  })
})

describe('a transfer that is no longer open', () => {
  it('does not refuse once verified', () => {
    const { ctx, epicId } = transferringEpic('in_progress')
    ctx.db.run("UPDATE transfers SET status = 'verified' WHERE epic_id = ?", epicId)
    expect(startRun(withRole(ctx, 'orchestrator'), { epicId }).state).toBe('running')
  })
})
