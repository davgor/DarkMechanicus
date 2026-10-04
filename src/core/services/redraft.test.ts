/**
 * redraft_next_sprint at the service: it reads the retro of the run's latest report for the active sprint,
 * rewrites the epic's draft (never the saved plan or the run), and says what it did.
 */
import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { SprintRetroInput } from '../../shared/domain/retro'
import type { SessionRole } from '../../shared/domain/views'
import { makeBundle, sid, tid } from '../../test/bundles'
import { errorOf, eventLog, outboxEntries, seedRun, setRunState, type SeededRun, type SeedRunOptions } from '../../test/checkpointSeed'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { updatePlanDraft } from './drafts'
import { getPlan } from './plans'
import { redraftNextSprint } from './redraft'
import { submitSprintReport } from './reports'

/** Sprint 1: work DM-1..DM-3 and node DM-4. Sprint 2: work DM-5 and node DM-6. */
function plan(): PlanBundle {
  const bundle = makeBundle([[1, 2, 3, 4], [5, 6]], [[2, 3]])
  bundle.tickets = bundle.tickets.map((ticket) =>
    ticket.id === tid(4) || ticket.id === tid(6)
      ? { ...ticket, kind: 'acceptance' as const, title: `Sprint ${ticket.id === tid(4) ? 1 : 2} acceptance` }
      : ticket
  )
  return bundle
}

const RETRO: SprintRetroInput = {
  leftovers: [{ ticket: 'DM-2', reason: 'Waiting on a signing identity' }],
  discoveries: [{ title: 'Cache the host catalog', body: 'Every claim reloads it.', ticket: 'DM-1' }]
}

interface Setup {
  ctx: TestCtx
  run: SeededRun
}

function setup(options: SeedRunOptions = {}): Setup {
  const ctx = createTestCtx()
  return { ctx, run: seedRun(ctx, { bundle: plan(), state: 'awaiting_checkpoint', ...options }) }
}

/** Submits the sprint's report; `'omitted'` leaves the retro out of it altogether. */
function report(ctx: TestCtx, run: SeededRun, retro: SprintRetroInput | null | 'omitted' = RETRO, sprint = 1) {
  return submitSprintReport(ctx, {
    runId: run.runId,
    sprintId: sid(sprint),
    report: { summary: `Sprint ${sprint} is over.`, ...(retro === 'omitted' ? {} : { retro }) }
  })
}

function draftOf(ctx: TestCtx, run: SeededRun): PlanBundle {
  return getPlan(ctx, { epicId: run.epicId, view: 'draft' }).bundle
}

/** The draft events, oldest first: the audit trail of what happened to the epic's draft. */
function draftEvents(ctx: TestCtx): string[] {
  return eventLog(ctx).map((event) => event.kind).filter((kind) => kind.startsWith('draft.'))
}

function idsIn(bundle: PlanBundle, ordinal: number): string[] {
  return bundle.sprints.find((sprint) => sprint.ordinal === ordinal)?.ticketIds ?? []
}

describe('redraftNextSprint', () => {
  it('rewrites the epic draft from the latest report\'s retro and returns what changed', () => {
    const { ctx, run } = setup()
    const submitted = report(ctx, run)
    const result = redraftNextSprint(ctx, { runId: run.runId })
    expect(result).toMatchObject({
      epicId: run.epicId,
      runId: run.runId,
      reportId: submitted.id,
      reportRevision: 1,
      draftRevision: 2,
      changed: true,
      sprintId: sid(1),
      nextSprintId: sid(2),
      sprintAdded: false,
      moved: [{ ticketId: tid(2), key: 'DM-2', reason: 'Waiting on a signing identity' }],
      dependentsMoved: [{ ticketId: tid(3), key: 'DM-3', requires: 'DM-2' }],
      added: [{ key: 'DM-7', title: 'Cache the host catalog', source: 'DM-1' }]
    })
    expect(result.validation.valid).toBe(true)
    const draft = draftOf(ctx, run)
    expect(idsIn(draft, 1)).toEqual([tid(1), tid(4)])
    expect(idsIn(draft, 2)).toEqual([tid(5), tid(2), tid(3), result.added[0]?.ticketId, tid(6)])
  })

  it('leaves the saved plan and the run exactly as they were', () => {
    const { ctx, run } = setup()
    report(ctx, run)
    redraftNextSprint(ctx, { runId: run.runId })
    expect(getPlan(ctx, { epicId: run.epicId, view: 'saved' }).bundle).toEqual(run.bundle)
    expect(ctx.db.get('SELECT revision_id, state, active_sprint_id FROM runs WHERE id = ?', run.runId)).toEqual({
      revision_id: run.revisionId,
      state: 'awaiting_checkpoint',
      active_sprint_id: sid(1)
    })
  })

  it('adds a sprint after the final one, with its own acceptance node, and keys that continue the plan\'s', () => {
    const { ctx, run } = setup({ bundle: makeBundle([[1, 2, 3]]) })
    report(ctx, run, { leftovers: [{ ticket: 'DM-2', reason: 'Not finished' }], discoveries: [{ title: 'Follow-up' }] })
    const result = redraftNextSprint(ctx, { runId: run.runId })
    expect(result).toMatchObject({ sprintAdded: true, nextSprintOrdinal: 2, added: [{ key: 'DM-5', title: 'Follow-up', source: null }] })
    const draft = draftOf(ctx, run)
    expect(draft.sprints).toHaveLength(2)
    const node = draft.tickets.find((ticket) => idsIn(draft, 2).includes(ticket.id) && ticket.kind === 'acceptance')
    expect(node).toMatchObject({ key: 'DM-4', title: 'Sprint 2 acceptance' })
    expect(idsIn(draft, 2)).toEqual([tid(2), result.added[0]?.ticketId, node?.id])
    expect(result.validation.valid).toBe(true)
  })

})

describe('redraftNextSprint against the draft and the reports', () => {
  it('builds on the edits already in the draft and keeps them', () => {
    const { ctx, run } = setup()
    updatePlanDraft(ctx, {
      epicId: run.epicId,
      ops: [{ op: 'update_ticket', ticket: 'DM-5', patch: { title: 'Planner edit' } }]
    })
    report(ctx, run)
    const result = redraftNextSprint(ctx, { runId: run.runId })
    expect(result.draftRevision).toBe(3)
    expect(draftOf(ctx, run).tickets.find((ticket) => ticket.id === tid(5))?.title).toBe('Planner edit')
  })

  it('uses the newest report revision of the active sprint', () => {
    const { ctx, run } = setup()
    report(ctx, run)
    const second = report(ctx, run, { leftovers: [{ ticket: 'DM-3', reason: 'Blocked' }] })
    const result = redraftNextSprint(ctx, { runId: run.runId })
    expect(result).toMatchObject({ reportId: second.id, reportRevision: 2, moved: [{ key: 'DM-3' }], added: [] })
  })

  it('skips a leftover that belongs to an earlier sprint than the active one', () => {
    const bundle = makeBundle([[1], [2, 3], [4]])
    const { ctx, run } = setup({ bundle, activeSprint: 2 })
    report(ctx, run, { leftovers: [{ ticket: 'DM-1', reason: 'Old news' }] }, 2)
    const result = redraftNextSprint(ctx, { runId: run.runId })
    expect(result.moved).toEqual([])
    expect(result.skipped).toMatchObject([{ label: 'DM-1', code: 'not_in_active_sprint' }])
  })
})

describe('redraftNextSprint called twice', () => {
  it('changes nothing the second time: same draft, same revision, no second event, no duplicates', () => {
    const { ctx, run } = setup()
    report(ctx, run)
    const first = redraftNextSprint(ctx, { runId: run.runId })
    const draftAfterFirst = draftOf(ctx, run)
    const second = redraftNextSprint(ctx, { runId: run.runId })
    expect(second).toMatchObject({ changed: false, draftRevision: first.draftRevision, moved: [], dependentsMoved: [], added: [] })
    expect(second.skipped.map((item) => [item.label, item.code])).toEqual([
      ['DM-2', 'already_in_next_sprint'],
      ['Cache the host catalog', 'already_drafted']
    ])
    expect(draftOf(ctx, run)).toEqual(draftAfterFirst)
    expect(draftEvents(ctx)).toEqual(['draft.opened', 'draft.redrafted'])
  })

  it('opens the draft but does not change it when the retro has nothing to move or add', () => {
    const { ctx, run } = setup()
    report(ctx, run, { wentWell: ['Smooth sprint'] })
    const result = redraftNextSprint(ctx, { runId: run.runId })
    expect(result).toMatchObject({ changed: false, draftRevision: 1, moved: [], added: [], nextSprintId: sid(2) })
    expect(draftOf(ctx, run)).toEqual(run.bundle)
    expect(draftEvents(ctx)).toEqual(['draft.opened'])
  })
})

describe('redraftNextSprint records what it did', () => {
  it('appends one draft.redrafted event naming the run, the sprints and the tickets, and queues no export', () => {
    const { ctx, run } = setup()
    report(ctx, run)
    const result = redraftNextSprint(ctx, { runId: run.runId })
    expect(eventLog(ctx).filter((event) => event.kind === 'draft.redrafted')).toEqual([
      {
        kind: 'draft.redrafted',
        epicId: run.epicId,
        runId: run.runId,
        ticketId: null,
        payload: {
          sprintId: sid(1),
          nextSprintId: sid(2),
          draftRevision: 2,
          moved: [tid(2)],
          dependentsMoved: [tid(3)],
          added: [result.added[0]?.ticketId]
        }
      }
    ])
    expect(outboxEntries(ctx).filter((entry) => entry.kind !== 'run_history')).toEqual([])
  })

  it('adds the run-aware draft warnings to its validation', () => {
    const { ctx, run } = setup({ bundle: makeBundle([[1], [2, 3], [4]]), activeSprint: 2 })
    updatePlanDraft(ctx, { epicId: run.epicId, ops: [{ op: 'update_ticket', ticket: 'DM-1', patch: { title: 'Rewritten history' } }] })
    report(ctx, run, { leftovers: [{ ticket: 'DM-2', reason: 'Not done' }] }, 2)
    const result = redraftNextSprint(ctx, { runId: run.runId })
    expect(result.validation.warnings.filter((warning) => warning.code === 'edits_passed_sprint')).toMatchObject([
      { sprintIds: [sid(1)], ticketIds: [tid(1)] }
    ])
  })
})

describe('redraftNextSprint refusals', () => {
  it.each(['running', 'paused', 'queued'] as const)('refuses a run that is %s', (state) => {
    const { ctx, run } = setup()
    report(ctx, run)
    setRunState(ctx, run.runId, state)
    expect(errorOf(() => redraftNextSprint(ctx, { runId: run.runId }))).toMatchObject({ code: 'run_not_active' })
    expect(ctx.db.get('SELECT 1 AS found FROM drafts WHERE epic_id = ?', run.epicId)).toBeUndefined()
  })

  it('refuses a run with no active sprint', () => {
    const { ctx, run } = setup({ activeSprint: null })
    expect(errorOf(() => redraftNextSprint(ctx, { runId: run.runId }))).toMatchObject({ code: 'run_not_active' })
  })

  it('refuses when no report was submitted for the active sprint, and says so', () => {
    const { ctx, run } = setup()
    expect(errorOf(() => redraftNextSprint(ctx, { runId: run.runId }))).toMatchObject({
      code: 'not_found',
      message: expect.stringContaining('No report for Sprint 1')
    })
  })

  it.each([
    ['no retro', 'omitted'],
    ['a null retro', null],
    ['an empty retro', {}]
  ] as const)('refuses a report with %s, and says what to submit', (_label, retro) => {
    const { ctx, run } = setup()
    report(ctx, run, retro)
    expect(errorOf(() => redraftNextSprint(ctx, { runId: run.runId }))).toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('retro')
    })
    expect(ctx.db.get('SELECT 1 AS found FROM drafts WHERE epic_id = ?', run.epicId)).toBeUndefined()
  })

  it('refuses a run that belongs to another machine', () => {
    const { ctx, run } = setup({ ownerMachineId: 'mc_00000000000000000000000002' })
    expect(errorOf(() => redraftNextSprint(ctx, { runId: run.runId }))).toMatchObject({ code: 'run_not_owned' })
  })

  it('refuses a run that does not exist', () => {
    const { ctx } = setup()
    expect(errorOf(() => redraftNextSprint(ctx, { runId: 'rn_00000000000000000000000099' }))).toMatchObject({ code: 'not_found' })
  })

  it('refuses a completed epic', () => {
    const { ctx, run } = setup()
    report(ctx, run)
    ctx.db.run("UPDATE epics SET status = 'completed' WHERE id = ?", run.epicId)
    expect(errorOf(() => redraftNextSprint(ctx, { runId: run.runId }))).toMatchObject({ code: 'completed_epic' })
  })
})

describe('who may redraft', () => {
  it.each(['worker', 'reviewer', 'planner'] as const)('refuses a %s session before it touches anything', (role: SessionRole) => {
    const { ctx, run } = setup()
    report(ctx, run)
    expect(errorOf(() => redraftNextSprint(withRole(ctx, role), { runId: run.runId }))).toMatchObject({ code: 'unauthorized' })
    expect(ctx.db.get('SELECT 1 AS found FROM drafts WHERE epic_id = ?', run.epicId)).toBeUndefined()
    expect(draftEvents(ctx)).toEqual([])
  })

  it.each(['orchestrator', 'desktop'] as const)('lets an %s session redraft', (role: SessionRole) => {
    const { ctx, run } = setup()
    report(ctx, run)
    expect(redraftNextSprint(withRole(ctx, role), { runId: run.runId })).toMatchObject({ changed: true, moved: [{ key: 'DM-2' }] })
  })
})
