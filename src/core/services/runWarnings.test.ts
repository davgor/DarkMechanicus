/**
 * While a run is active, validate_plan and the result of every draft edit carry the run-aware warnings:
 * editing a sprint the run has passed, and inserting a sprint before the active one. They are warnings:
 * the plan stays valid and can still be saved.
 */
import { describe, expect, it } from 'vitest'
import type { DraftOp } from '../../shared/domain/api'
import type { RunState } from '../../shared/domain/status'
import type { ValidationReport } from '../../shared/domain/views'
import { makeBundle, sid, tid } from '../../test/bundles'
import { seedEpic, seedRevision, seedRun, setRunState, type SeededRun } from '../../test/checkpointSeed'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { updatePlanDraft } from './drafts'
import { validatePlanView } from './plans'

const RUN_CODES = ['edits_passed_sprint', 'sprint_before_active']

const RETITLE_PASSED: DraftOp = { op: 'update_ticket', ticket: 'DM-1', patch: { title: 'Rewritten history' } }
const INSERT_BEFORE_ACTIVE: DraftOp = { op: 'add_sprint', sprint: { goal: 'Squeezed in' }, position: 2 }

/** Sprint 1 {DM-1}, sprint 2 {DM-2, DM-3}, sprint 3 {DM-4}; the run is on sprint 2. */
function setup(state: RunState = 'running'): { ctx: TestCtx; run: SeededRun } {
  const ctx = createTestCtx()
  return { ctx, run: seedRun(ctx, { bundle: makeBundle([[1], [2, 3], [4]]), activeSprint: 2, state }) }
}

function runCodes(report: ValidationReport): string[] {
  return report.warnings.map((warning) => warning.code).filter((code) => RUN_CODES.includes(code))
}

function edit(ctx: TestCtx, epicId: string, ...ops: DraftOp[]): ValidationReport {
  return updatePlanDraft(ctx, { epicId, ops }).validation
}

describe('validate_plan while a run is active', () => {
  it.each(['running', 'awaiting_checkpoint', 'paused'] as const)('warns about edits to a passed sprint while the run is %s', (state) => {
    const { ctx, run } = setup(state)
    edit(ctx, run.epicId, RETITLE_PASSED)
    const report = validatePlanView(ctx, { epicId: run.epicId, view: 'draft' })
    expect(runCodes(report)).toEqual(['edits_passed_sprint'])
    expect(report.warnings.find((warning) => warning.code === 'edits_passed_sprint')).toMatchObject({
      sprintIds: [sid(1)],
      ticketIds: [tid(1)]
    })
  })

  it('warns about a sprint inserted before the active one', () => {
    const { ctx, run } = setup()
    edit(ctx, run.epicId, INSERT_BEFORE_ACTIVE)
    expect(runCodes(validatePlanView(ctx, { epicId: run.epicId, view: 'draft' }))).toEqual(['sprint_before_active'])
  })

  it('keeps the plan valid: the warnings never block saving', () => {
    const { ctx, run } = setup()
    edit(ctx, run.epicId, RETITLE_PASSED, INSERT_BEFORE_ACTIVE)
    const report = validatePlanView(ctx, { epicId: run.epicId, view: 'draft' })
    expect(runCodes(report).sort()).toEqual(['edits_passed_sprint', 'sprint_before_active'])
    expect(report).toMatchObject({ valid: true, errors: [] })
  })

  it('is quiet about edits to the active sprint and later ones, and about a sprint added at the end', () => {
    const { ctx, run } = setup()
    edit(
      ctx,
      run.epicId,
      { op: 'update_ticket', ticket: 'DM-2', patch: { title: 'Active, revised' } },
      { op: 'update_ticket', ticket: 'DM-4', patch: { title: 'Later, revised' } },
      { op: 'add_sprint', sprint: { goal: 'After it all' } }
    )
    expect(runCodes(validatePlanView(ctx, { epicId: run.epicId, view: 'draft' }))).toEqual([])
  })

  it('reads the saved view against the run too: a newer saved revision that edits a passed sprint warns', () => {
    const { ctx, run } = setup()
    const edited = makeBundle([[1], [2, 3], [4]])
    edited.tickets = edited.tickets.map((ticket) => (ticket.id === tid(1) ? { ...ticket, title: 'Rewritten history' } : ticket))
    seedRevision(ctx, run.epicId, edited)
    expect(runCodes(validatePlanView(ctx, { epicId: run.epicId, view: 'saved' }))).toEqual(['edits_passed_sprint'])
  })

  it('has no run warnings for the revision the run itself executes', () => {
    const { ctx, run } = setup()
    expect(runCodes(validatePlanView(ctx, { epicId: run.epicId, view: 'saved' }))).toEqual([])
  })
})

describe('the result of a draft edit while a run is active', () => {
  it('carries the same warnings as validate_plan', () => {
    const { ctx, run } = setup()
    const result = edit(ctx, run.epicId, RETITLE_PASSED, INSERT_BEFORE_ACTIVE)
    expect(runCodes(result).sort()).toEqual(['edits_passed_sprint', 'sprint_before_active'])
    expect(result.valid).toBe(true)
  })
})

describe('when no run is executing the epic', () => {
  it('adds no run warnings without a run', () => {
    const ctx = createTestCtx()
    const epicId = seedEpic(ctx)
    seedRevision(ctx, epicId, makeBundle([[1], [2, 3], [4]]))
    expect(runCodes(edit(ctx, epicId, RETITLE_PASSED, INSERT_BEFORE_ACTIVE))).toEqual([])
  })

  it.each(['completed', 'canceled', 'failed', 'queued'] as const)('adds none for a %s run', (state) => {
    const { ctx, run } = setup()
    setRunState(ctx, run.runId, state)
    if (state === 'queued') {
      ctx.db.run('UPDATE runs SET active_sprint_id = NULL WHERE id = ?', run.runId)
    }
    expect(runCodes(edit(ctx, run.epicId, RETITLE_PASSED, INSERT_BEFORE_ACTIVE))).toEqual([])
  })

  it('adds none for another epic\'s run', () => {
    const { ctx } = setup()
    seedRun(ctx, { bundle: makeBundle([[11], [12, 13], [14]]), activeSprint: 2, state: 'running' })
    const own = seedEpic(ctx, 'Own epic')
    seedRevision(ctx, own, makeBundle([[1], [2, 3], [4]]))
    expect(runCodes(edit(ctx, own, RETITLE_PASSED, INSERT_BEFORE_ACTIVE))).toEqual([])
  })
})
