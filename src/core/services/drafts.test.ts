import { describe, expect, it } from 'vitest'
import type { DraftOp } from '../../shared/domain/api'
import type { PlanBundle } from '../../shared/domain/bundle'
import {
  captureError,
  createSavedEpic,
  draftRevisionOf,
  eventKinds,
  TWO_TICKETS
} from '../../test/authoring'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { isStableId } from '../ids'
import { META_KEYS, setMeta } from '../meta'
import { discardPlanDraft, openDraft, updatePlanDraft } from './drafts'
import { createEpic } from './epics'
import { getPlan } from './plans'

function draftRow(ctx: TestCtx, epicId: string): { bundle_json: string; draft_revision: number } | undefined {
  return ctx.db.get('SELECT bundle_json, draft_revision FROM drafts WHERE epic_id = ?', epicId)
}

function draftBundle(ctx: TestCtx, epicId: string): PlanBundle {
  return JSON.parse(draftRow(ctx, epicId)?.bundle_json ?? '{}') as PlanBundle
}

function lastPayload(ctx: TestCtx): Record<string, unknown> {
  const row = ctx.db.get<{ payload_json: string }>('SELECT payload_json FROM events ORDER BY seq DESC LIMIT 1')
  return JSON.parse(row?.payload_json ?? '{}') as Record<string, unknown>
}

function addTicket(title: string): Extract<DraftOp, { op: 'add_ticket' }> {
  return { op: 'add_ticket', sprint: '1', ticket: { title } }
}

describe('updatePlanDraft with client-local refs', () => {
  it('maps refs to stable ids and advances the draft by one revision', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Checkout', successCriteria: ['Customers can pay'] })
    const result = updatePlanDraft(ctx, { epicId: epic.id, ops: TWO_TICKETS, expectedDraftRevision: 1 })
    expect(result).toEqual({
      epicId: epic.id,
      draftRevision: 2,
      refMap: { a: result.refMap.a, b: result.refMap.b },
      validation: { valid: true, errors: [], warnings: result.validation.warnings }
    })
    // The sprint acceptance node has no criteria yet, so it covers neither ticket.
    expect(result.validation.warnings.map((warning) => warning.code)).toEqual([
      'missing_acceptance_criteria',
      'ticket_not_covered',
      'ticket_not_covered'
    ])
    expect(isStableId(result.refMap.a, 'ticket')).toBe(true)
    expect(result.refMap.b).not.toBe(result.refMap.a)
    const bundle = draftBundle(ctx, epic.id)
    expect(bundle.tickets.map((ticket) => [ticket.id, ticket.key, ticket.title])).toEqual([
      [bundle.tickets[0].id, 'DM-1', 'Sprint 1 acceptance'],
      [result.refMap.a, 'DM-2', 'Alpha'],
      [result.refMap.b, 'DM-3', 'Beta']
    ])
    expect(bundle.sprints[0].ticketIds).toEqual([result.refMap.a, result.refMap.b, bundle.tickets[0].id])
    expect(bundle.edges).toEqual([{ from: result.refMap.a, to: result.refMap.b }])
    expect(eventKinds(ctx)).toEqual(['epic.created', 'draft.updated'])
    expect(lastPayload(ctx)).toEqual({ draftRevision: 2, ops: 3 })
  })

  it('returns warnings from whole-plan validation without blocking the edit', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Checkout' })
    const result = updatePlanDraft(ctx, { epicId: epic.id, ops: [addTicket('Lonely')] })
    expect(result.validation.valid).toBe(true)
    expect(result.validation.warnings.map((warning) => warning.code)).toEqual([
      'missing_success_criteria',
      'missing_acceptance_criteria',
      'missing_acceptance_criteria',
      'ticket_not_covered'
    ])
    expect(draftRow(ctx, epic.id)?.draft_revision).toBe(2)
  })

})

describe('updatePlanDraft with sprints', () => {
  it('gives each sprint an op adds its own acceptance node, with the next ticket key', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Checkout' })
    const result = updatePlanDraft(ctx, {
      epicId: epic.id,
      ops: [{ op: 'add_sprint', ref: 'two', sprint: { goal: 'Second' } }]
    })
    const bundle = draftBundle(ctx, epic.id)
    const second = bundle.sprints[1]
    const node = bundle.tickets.find((ticket) => ticket.id === second.ticketIds[0])
    expect(second.id).toBe(result.refMap.two)
    expect(node).toMatchObject({ key: 'DM-2', title: 'Sprint 2 acceptance', kind: 'acceptance' })
    expect(bundle.tickets).toHaveLength(2)
    expect(result.validation.errors).toEqual([])
  })
})

describe('updatePlanDraft rejections', () => {
  it('rejects a stale expected draft revision and changes nothing', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Checkout' })
    updatePlanDraft(ctx, { epicId: epic.id, ops: TWO_TICKETS })
    const before = draftRow(ctx, epic.id)
    const error = captureError(() =>
      updatePlanDraft(ctx, { epicId: epic.id, ops: [addTicket('Late')], expectedDraftRevision: 1 })
    )
    expect(error).toEqual({
      code: 'conflict',
      message: 'The draft changed (now revision 2). Reload and reapply your edit.',
      details: { currentDraftRevision: 2 }
    })
    expect(draftRow(ctx, epic.id)).toEqual(before)
    expect(eventKinds(ctx)).toEqual(['epic.created', 'draft.updated'])
  })

  it('propagates a rejected op with its index and persists nothing', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Checkout' })
    const before = draftRow(ctx, epic.id)
    const error = captureError(() =>
      updatePlanDraft(ctx, {
        epicId: epic.id,
        ops: [{ ...addTicket('Kept?'), ref: 'x' }, { op: 'add_dependency', from: 'x', to: 'missing' }]
      })
    )
    expect(error.code).toBe('not_found')
    expect(error.details).toMatchObject({ opIndex: 1, op: 'add_dependency' })
    expect(draftRow(ctx, epic.id)).toEqual(before)
    expect(eventKinds(ctx)).toEqual(['epic.created'])
  })

  it('rejects completed epics and sessions without draft.edit', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Checkout' })
    const reviewer = withRole(ctx, 'reviewer')
    expect(captureError(() => updatePlanDraft(reviewer, { epicId: epic.id, ops: TWO_TICKETS })).code).toBe('unauthorized')
    ctx.db.run("UPDATE epics SET status = 'completed' WHERE id = ?", epic.id)
    expect(captureError(() => updatePlanDraft(ctx, { epicId: epic.id, ops: TWO_TICKETS })).code).toBe('completed_epic')
    expect(draftRow(ctx, epic.id)?.draft_revision).toBe(1)
  })
})

describe('updatePlanDraft implicit open', () => {
  it('opens a draft from the saved plan before applying ops', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const result = updatePlanDraft(ctx, { epicId: saved.epicId, ops: [addTicket('Gamma')], expectedDraftRevision: 1 })
    expect(result.draftRevision).toBe(2)
    const plan = getPlan(ctx, { epicId: saved.epicId, view: 'draft' })
    expect(plan.baseRevisionId).toBe(saved.revisionId)
    expect(plan.bundle.tickets.map((ticket) => ticket.title)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(eventKinds(ctx).slice(-2)).toEqual(['draft.opened', 'draft.updated'])
  })

  it('leaves no draft behind when the ops are rejected', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const events = eventKinds(ctx)
    const error = captureError(() =>
      updatePlanDraft(ctx, { epicId: saved.epicId, ops: [{ op: 'remove_ticket', ticket: 'DM-404' }] })
    )
    expect(error.details).toMatchObject({ opIndex: 0 })
    expect(draftRow(ctx, saved.epicId)).toBeUndefined()
    expect(eventKinds(ctx)).toEqual(events)
  })
})

describe('updatePlanDraft ticket keys', () => {
  it('continues after every key in any revision or draft of the project', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const other = createEpic(ctx, { title: 'Other' })
    updatePlanDraft(ctx, { epicId: other.id, ops: [addTicket('Third')] })
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [{ op: 'remove_ticket', ticket: 'DM-2' }] })
    updatePlanDraft(ctx, { epicId: other.id, ops: [addTicket('Fourth')] })
    // DM-1 and DM-2 are the saved epic's tickets; the other epic's acceptance node continues after them.
    expect(draftBundle(ctx, other.id).tickets.map((ticket) => ticket.key)).toEqual(['DM-3', 'DM-4', 'DM-5'])
  })

  it('uses the project key prefix and numbers several new tickets consecutively', () => {
    const ctx = createTestCtx()
    ctx.db.tx(() => setMeta(ctx.db, META_KEYS.keyPrefix, 'XY'))
    const epic = createEpic(ctx, { title: 'Prefixed' })
    updatePlanDraft(ctx, { epicId: epic.id, ops: [addTicket('One'), addTicket('Two'), addTicket('Three')] })
    expect(draftBundle(ctx, epic.id).tickets.map((ticket) => ticket.key)).toEqual(['XY-1', 'XY-2', 'XY-3', 'XY-4'])
  })
})

describe('updatePlanDraft idempotency', () => {
  it('applies a repeated request once and returns the original result', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Checkout' })
    const first = updatePlanDraft(ctx, { epicId: epic.id, ops: TWO_TICKETS, idempotencyKey: 'edit-1' })
    const again = updatePlanDraft(ctx, { epicId: epic.id, ops: TWO_TICKETS, idempotencyKey: 'edit-1' })
    expect(again).toEqual(first)
    expect(draftRevisionOf(ctx, epic.id)).toBe(2)
    expect(draftBundle(ctx, epic.id).tickets).toHaveLength(3)
    const mismatch = captureError(() =>
      updatePlanDraft(ctx, { epicId: epic.id, ops: [addTicket('Other')], idempotencyKey: 'edit-1' })
    )
    expect(mismatch.code).toBe('idempotency_mismatch')
  })
})

describe('openDraft', () => {
  it('creates a draft from the current saved revision once', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    const plan = openDraft(ctx, { epicId: saved.epicId })
    expect(plan).toMatchObject({
      view: 'draft',
      revisionId: null,
      baseRevisionId: saved.revisionId,
      baseRevisionNumber: 1,
      draftRevision: 1,
      readOnly: false,
      readOnlyReason: null,
      changes: [],
      stale: false
    })
    expect(lastPayload(ctx)).toEqual({ baseRevisionId: saved.revisionId })
    const events = eventKinds(ctx)
    expect(openDraft(ctx, { epicId: saved.epicId }).draftRevision).toBe(1)
    expect(eventKinds(ctx)).toEqual(events)
    expect(events.at(-1)).toBe('draft.opened')
  })

  it('recreates an initial draft for a never-saved epic that lost its draft', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Recovered', intent: 'Gone' })
    ctx.db.run('DELETE FROM drafts WHERE epic_id = ?', epic.id)
    const plan = openDraft(ctx, { epicId: epic.id })
    expect(plan.baseRevisionId).toBeNull()
    expect(plan.bundle.epic).toEqual({ title: 'Recovered', intent: '', successCriteria: [], ownerRole: null })
    expect(plan.bundle.sprints).toHaveLength(1)
    expect(plan.bundle.tickets.map((ticket) => [ticket.key, ticket.kind])).toEqual([['DM-1', 'acceptance']])
    expect(plan.bundle.sprints[0].ticketIds).toEqual([plan.bundle.tickets[0].id])
  })

  it('rejects completed epics and sessions without draft.edit', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    expect(captureError(() => openDraft(withRole(ctx, 'worker'), { epicId: saved.epicId })).code).toBe('unauthorized')
    ctx.db.run("UPDATE epics SET status = 'completed' WHERE id = ?", saved.epicId)
    expect(captureError(() => openDraft(ctx, { epicId: saved.epicId })).code).toBe('completed_epic')
    expect(draftRow(ctx, saved.epicId)).toBeUndefined()
  })
})

describe('discardPlanDraft for saved epics', () => {
  it('restores the last saved plan by deleting the draft', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [addTicket('Gamma')] })
    expect(discardPlanDraft(ctx, { epicId: saved.epicId, expectedDraftRevision: 2 })).toEqual({ discarded: true })
    expect(draftRow(ctx, saved.epicId)).toBeUndefined()
    expect(getPlan(ctx, { epicId: saved.epicId, view: 'saved' }).bundle.tickets.map((ticket) => ticket.title)).toEqual([
      'Alpha',
      'Beta'
    ])
    expect(eventKinds(ctx).at(-1)).toBe('draft.discarded')
    expect(lastPayload(ctx)).toEqual({ reset: false })
    expect(discardPlanDraft(ctx, { epicId: saved.epicId })).toEqual({ discarded: false })
    expect(eventKinds(ctx).at(-1)).toBe('draft.discarded')
  })

  it('rejects a stale expected draft revision and keeps the draft', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [addTicket('Gamma')] })
    const error = captureError(() => discardPlanDraft(ctx, { epicId: saved.epicId, expectedDraftRevision: 1 }))
    expect(error).toMatchObject({ code: 'conflict', details: { currentDraftRevision: 2 } })
    expect(draftRevisionOf(ctx, saved.epicId)).toBe(2)
  })

  it('cleans up a leftover draft of a completed epic but requires draft.edit', () => {
    const ctx = createTestCtx()
    const saved = createSavedEpic(ctx)
    updatePlanDraft(ctx, { epicId: saved.epicId, ops: [addTicket('Gamma')] })
    ctx.db.run("UPDATE epics SET status = 'completed' WHERE id = ?", saved.epicId)
    expect(captureError(() => discardPlanDraft(withRole(ctx, 'reviewer'), { epicId: saved.epicId })).code).toBe(
      'unauthorized'
    )
    expect(discardPlanDraft(ctx, { epicId: saved.epicId })).toEqual({ discarded: true })
    expect(draftRow(ctx, saved.epicId)).toBeUndefined()
  })
})

describe('discardPlanDraft for never-saved epics', () => {
  it('resets the draft to an empty plan that keeps the epic content', () => {
    const ctx = createTestCtx()
    const epic = createEpic(ctx, { title: 'Checkout', intent: 'Ship it', successCriteria: ['Pays'], ownerRole: 'qa' })
    updatePlanDraft(ctx, {
      epicId: epic.id,
      ops: [...TWO_TICKETS, { op: 'set_epic', intent: 'Edited intent' }, { op: 'set_rationale', rationale: 'Why' }]
    })
    const firstSprint = draftBundle(ctx, epic.id).sprints[0].id
    expect(discardPlanDraft(ctx, { epicId: epic.id, expectedDraftRevision: 2 })).toEqual({ discarded: true })
    const bundle = draftBundle(ctx, epic.id)
    expect(bundle.epic).toEqual({
      title: 'Checkout',
      intent: 'Edited intent',
      successCriteria: [{ id: 's1', text: 'Pays' }],
      ownerRole: 'qa'
    })
    // The reset plan is a fresh one: one sprint holding only its new acceptance node.
    expect(bundle.tickets.map((ticket) => [ticket.kind, ticket.title])).toEqual([['acceptance', 'Sprint 1 acceptance']])
    expect(bundle.edges).toEqual([])
    expect(bundle.rationale).toBe('')
    expect(bundle.sprints.map((sprint) => [sprint.ordinal, sprint.ticketIds])).toEqual([[1, [bundle.tickets[0].id]]])
    expect(bundle.sprints[0].id).not.toBe(firstSprint)
    expect(draftRevisionOf(ctx, epic.id)).toBe(3)
    expect(lastPayload(ctx)).toEqual({ reset: true })
  })
})
