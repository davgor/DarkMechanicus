/**
 * The plan trace the Plan Forge council reads (`planTrace.ts`): an epic's saved and draft revisions, and its draft
 * changes and save requests after a sequence number, each with the draft revision it produced when it names one.
 */
import { describe, expect, it } from 'vitest'
import { TWO_TICKETS } from '../../test/authoring'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { updatePlanDraft } from './drafts'
import { createEpic } from './epics'
import { latestSeq } from './events'
import { planTrace } from './planTrace'

function epicWithDraft(ctx: TestCtx): { epicId: string; before: number } {
  const epic = createEpic(ctx, { title: 'Checkout', successCriteria: ['Customers can pay'] })
  return { epicId: epic.id, before: latestSeq(ctx, 0) }
}

describe('plan trace', () => {
  it('refuses an epic that does not exist with not_found', () => {
    const ctx = createTestCtx()
    expect(() => planTrace(ctx, 'ep_missing', null)).toThrow(expect.objectContaining({ code: 'not_found', message: 'Epic ep_missing does not exist.' }))
  })

  it('reads no draft revision from a change whose payload names none, and the revision of one that does', () => {
    const ctx = createTestCtx()
    const { epicId, before } = epicWithDraft(ctx)
    const at = latestSeq(ctx, 0)
    ctx.db.run(
      "INSERT INTO events (at, kind, epic_id, payload_json) VALUES ('2026-01-01T00:00:00.000Z', 'draft.discarded', ?, ?)",
      epicId,
      JSON.stringify({ draftRevision: 'three' })
    )
    ctx.db.run("INSERT INTO events (at, kind, epic_id, payload_json) VALUES ('2026-01-01T00:00:00.000Z', 'draft.updated', ?, 'null')", epicId)
    const { draftRevision } = updatePlanDraft(ctx, { epicId, ops: TWO_TICKETS })
    const trace = planTrace(ctx, epicId, at)
    expect(trace.changes.map((change) => [change.kind, change.draftRevision])).toEqual([
      ['draft.discarded', null], ['draft.updated', null], ['draft.updated', draftRevision]
    ])
    expect(trace).toMatchObject({ savedRevision: null, draftRevision, eventSeq: latestSeq(ctx, 0) })
    expect(planTrace(ctx, epicId, null).changes).toEqual([])
    expect(planTrace(ctx, epicId, before).changes.length).toBeGreaterThanOrEqual(3)
  })

  it('cuts a trace past 1000 changes to the first 1000 and a trace.truncated marker', () => {
    const ctx = createTestCtx()
    const { epicId } = epicWithDraft(ctx)
    const at = latestSeq(ctx, 0)
    ctx.db.tx(() => {
      for (let revision = 1; revision <= 1001; revision++) {
        ctx.db.run(
          "INSERT INTO events (at, kind, epic_id, payload_json) VALUES ('2026-01-01T00:00:00.000Z', 'draft.updated', ?, ?)",
          epicId,
          JSON.stringify({ draftRevision: revision })
        )
      }
    })
    const { changes } = planTrace(ctx, epicId, at)
    expect(changes).toHaveLength(1001)
    expect(changes[999]).toEqual({ kind: 'draft.updated', grantId: null, draftRevision: 1000 })
    expect(changes[1000]).toEqual({ kind: 'trace.truncated', grantId: null, draftRevision: null })
  })
})
