/** The `definition_of_done` gate: the node's accepted attempt must report every named check as passed. */
import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { CheckResult, DefinitionOfDoneCheck, GateCondition } from '../../shared/domain/views'
import { makeBundle, sid, tid } from '../../test/bundles'
import { acceptTickets, errorOf, seedAttempt, seedRun, type SeededRun } from '../../test/checkpointSeed'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { advanceSprint, getCheckpoint } from './checkpoints'
import { submitSprintReport } from './reports'

function check(name: string): DefinitionOfDoneCheck {
  return { name, command: `npm run ${name}`, description: `Runs ${name}` }
}

const DEFINITION = [check('lint'), check('typecheck'), check('test')]

function passed(...names: string[]): CheckResult[] {
  return names.map((name) => ({ name, status: 'passed', detail: 'ok' }))
}

/** Sprint 1 = {DM-1, DM-2, DM-3}, sprint 2 = {DM-4, DM-5}; DM-3 and DM-5 are the sprints' acceptance nodes. */
function plan(withNode = true): PlanBundle {
  const bundle = makeBundle([[1, 2, 3], [4, 5]])
  const nodes = withNode ? [tid(3), tid(5)] : []
  bundle.tickets = bundle.tickets.map((ticket) => (nodes.includes(ticket.id) ? { ...ticket, kind: 'acceptance' as const } : ticket))
  return bundle
}

function setup(definition: DefinitionOfDoneCheck[] = DEFINITION, withNode = true): { ctx: TestCtx; run: SeededRun } {
  const ctx = createTestCtx({ definitionOfDone: definition })
  return { ctx, run: seedRun(ctx, { bundle: plan(withNode) }) }
}

function gate(ctx: TestCtx, run: SeededRun): GateCondition | undefined {
  return getCheckpoint(ctx, { runId: run.runId }).conditions.find((item) => item.id === 'definition_of_done')
}

/** Sprint 1's work accepted, then the node accepted with `checks` as its evidence. */
function acceptNodeWith(ctx: TestCtx, run: SeededRun, checks: CheckResult[]): void {
  acceptTickets(ctx, run, [1, 2])
  seedAttempt(ctx, run, { ticket: 3, state: 'accepted', increment: {}, checks })
}

describe('definition_of_done gate: which sprints get it', () => {
  it('is left out for a project with no Definition of Done, so such sprints are gated exactly as before', () => {
    const { ctx, run } = setup([])
    acceptNodeWith(ctx, run, [])
    const ids = getCheckpoint(ctx, { runId: run.runId }).conditions.map((item) => item.id)
    expect(ids).toEqual(['report_submitted', 'no_active_leases', 'required_accepted', 'acceptance_accepted', 'increment_merged', 'exit_criteria', 'approval'])
  })

  it('is left out for a sprint without an acceptance node, even when the project has a Definition of Done', () => {
    const { ctx, run } = setup(DEFINITION, false)
    expect(gate(ctx, run)).toBeUndefined()
  })

  it('never reads the Definition of Done for a sprint without a node, so a plan without nodes does not depend on project.json', () => {
    const { ctx, run } = setup(DEFINITION, false)
    const unreadable = {
      ...ctx,
      definitionOfDone: (): DefinitionOfDoneCheck[] => {
        throw new Error('project.json was read')
      }
    }
    expect(getCheckpoint(unreadable, { runId: run.runId }).conditions.map((item) => item.id)).not.toContain('definition_of_done')
  })

  it('sits after the increment gate on a sprint with a node, and on the final sprint as well', () => {
    const { ctx, run } = setup()
    const first = getCheckpoint(ctx, { runId: run.runId }).conditions.map((item) => item.id)
    expect(first).toEqual([
      'report_submitted',
      'no_active_leases',
      'required_accepted',
      'acceptance_accepted',
      'increment_merged',
      'definition_of_done',
      'exit_criteria',
      'approval'
    ])
    const last = seedRun(ctx, { bundle: plan(), activeSprint: 2 })
    expect(gate(ctx, last)).toBeDefined()
  })
})

describe('definition_of_done gate: unmet while no attempt of the node is accepted', () => {
  it('names every check while the node has no accepted attempt', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    expect(gate(ctx, run)).toEqual({
      id: 'definition_of_done',
      label: 'Definition of Done passed',
      met: false,
      detail: 'DM-3 has no accepted attempt yet; it must report these checks as passed: lint, typecheck, test'
    })
  })

  it('does not count a submission still awaiting review, however many checks it reports', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    seedAttempt(ctx, run, { ticket: 3, state: 'submitted', increment: {}, checks: passed('lint', 'typecheck', 'test') })
    expect(gate(ctx, run)).toMatchObject({ met: false, detail: expect.stringContaining('no accepted attempt yet') })
  })
})

describe('definition_of_done gate: unmet by an accepted attempt that falls short', () => {
  it('names the checks the accepted attempt did not report, in the order of the Definition of Done', () => {
    const { ctx, run } = setup()
    acceptNodeWith(ctx, run, passed('lint'))
    expect(gate(ctx, run)).toMatchObject({
      met: false,
      detail: "DM-3's accepted attempt does not report these checks as passed: typecheck (not reported), test (not reported)"
    })
  })

  it('says whether a check that was reported failed or was skipped', () => {
    const { ctx, run } = setup()
    acceptNodeWith(ctx, run, [
      { name: 'lint', status: 'passed', detail: '' },
      { name: 'typecheck', status: 'failed', detail: '3 errors' },
      { name: 'test', status: 'skipped', detail: 'full gate at the checkpoint' }
    ])
    expect(gate(ctx, run)?.detail).toBe(
      "DM-3's accepted attempt does not report these checks as passed: typecheck (failed), test (skipped)"
    )
  })

  it('does not take checks from an attempt that was rejected, or from one an adopted revision superseded', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    seedAttempt(ctx, run, { ticket: 3, state: 'rejected', checks: passed('lint', 'typecheck', 'test') })
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted', superseded: true, checks: passed('lint', 'typecheck', 'test') })
    expect(gate(ctx, run)).toMatchObject({ met: false, detail: expect.stringContaining('no accepted attempt yet') })
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted', checks: passed('lint') })
    expect(gate(ctx, run)?.detail).toContain('typecheck (not reported), test (not reported)')
  })

  it('does not take checks from the work tickets: only the acceptance node reports the Definition of Done', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [2])
    seedAttempt(ctx, run, { ticket: 1, state: 'accepted', checks: passed('lint', 'typecheck', 'test') })
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted', increment: {} })
    expect(gate(ctx, run)).toMatchObject({ met: false, detail: expect.stringContaining('lint (not reported)') })
  })

  it('blocks the checkpoint, and the block names the missing checks', () => {
    const { ctx, run } = setup()
    acceptNodeWith(ctx, run, passed('lint', 'test'))
    submitSprintReport(ctx, { runId: run.runId, sprintId: sid(1), report: { summary: 'Done.' } })
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect(view.conditions.filter((item) => !item.met).map((item) => item.id)).toEqual(['definition_of_done', 'approval'])
    expect([view.gatesMet, view.canAdvance]).toEqual([false, false])
    const blocked = errorOf(() => advanceSprint(ctx, { runId: run.runId }))
    expect(blocked.code).toBe('gate_blocked')
    expect(blocked.message).toContain('typecheck (not reported)')
  })
})

describe('definition_of_done gate: met', () => {
  it('is met when the accepted attempt reports every named check as passed', () => {
    const { ctx, run } = setup()
    acceptNodeWith(ctx, run, passed('lint', 'typecheck', 'test'))
    expect(gate(ctx, run)).toEqual({
      id: 'definition_of_done',
      label: 'Definition of Done passed',
      met: true,
      detail: 'DM-3 reports all 3 Definition of Done checks as passed'
    })
  })

  it('matches names ignoring case and surrounding spaces, and ignores checks the Definition does not name', () => {
    const { ctx, run } = setup()
    acceptNodeWith(ctx, run, [...passed(' LINT', 'TypeCheck ', 'Test'), { name: 'extra', status: 'failed', detail: '' }])
    expect(gate(ctx, run)?.met).toBe(true)
  })

  it('uses the latest accepted attempt of the node', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted', superseded: true, checks: passed('lint') })
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted', checks: passed('lint', 'typecheck', 'test') })
    expect(gate(ctx, run)?.met).toBe(true)
  })

  it('says "1 Definition of Done check" for a single check', () => {
    const { ctx, run } = setup([check('lint')])
    acceptNodeWith(ctx, run, passed('lint'))
    expect(gate(ctx, run)?.detail).toBe('DM-3 reports all 1 Definition of Done check as passed')
  })

  it('lets a sprint through once the other gates are met too', () => {
    const { ctx, run } = setup()
    acceptNodeWith(ctx, run, passed('lint', 'typecheck', 'test'))
    submitSprintReport(ctx, { runId: run.runId, sprintId: sid(1), report: { summary: 'Done.' } })
    const view = getCheckpoint(ctx, { runId: run.runId })
    expect(view.gatesMet).toBe(true)
  })
})

describe('definition_of_done gate: the Definition of Done changes', () => {
  it('is read afresh on every evaluation: a check added later is missing, and removing every check removes the gate', () => {
    const { ctx, run } = setup()
    acceptNodeWith(ctx, run, passed('lint', 'typecheck', 'test'))
    expect(gate(ctx, run)?.met).toBe(true)
    const stricter = { ...ctx, definitionOfDone: () => [...DEFINITION, check('build')] }
    expect(gate(stricter, run)?.detail).toContain('build (not reported)')
    const none = { ...ctx, definitionOfDone: () => [] }
    expect(gate(none, run)).toBeUndefined()
  })
})
