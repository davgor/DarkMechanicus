/** A sprint carried forward from an earlier run passes its checkpoint on what that run's acceptance recorded. */
import { describe, expect, it } from 'vitest'
import type { EpicBranch, PlanBundle } from '../../shared/domain/bundle'
import type { CheckResult, DefinitionOfDoneCheck, GateCondition, GateConditionId } from '../../shared/domain/views'
import { makeBundle, sid, tid } from '../../test/bundles'
import { incrementVerdict, seedAttempt, seedRun } from '../../test/checkpointSeed'
import { SIMPLE_RETRO } from '../../test/retro'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { getCheckpoint } from './checkpoints'
import { submitSprintReport } from './reports'
import { getRun, startRun } from './runs'

const BRANCH: EpicBranch = { repository: null, name: 'epic/x', startCommit: 'a'.repeat(40) }

const DEFINITION: DefinitionOfDoneCheck[] = [
  { name: 'lint', command: 'npm run lint', description: 'Runs lint' },
  { name: 'test', command: 'npm test', description: 'Runs the tests' }
]

const PASSED: CheckResult[] = DEFINITION.map((check) => ({ name: check.name, status: 'passed', detail: 'ok' }))

/** Sprint 1 = {DM-1, DM-2, DM-3}, sprint 2 = {DM-4, DM-5}; DM-3 and DM-5 are the sprints' acceptance nodes. */
function plan(): PlanBundle {
  const bundle = makeBundle([[1, 2, 3], [4, 5]])
  bundle.tickets = bundle.tickets.map((ticket) =>
    [tid(3), tid(5)].includes(ticket.id) ? { ...ticket, kind: 'acceptance' as const } : ticket
  )
  return bundle
}

/**
 * Run 1 accepted all of sprint 1 (its node with a verified increment and every Definition of Done check passed)
 * and was canceled; run 2 starts by carrying sprint 1 forward and reports on it.
 */
function carriedForward(): { ctx: TestCtx; runId: string; nodeAttemptId: string } {
  const ctx = createTestCtx({ definitionOfDone: DEFINITION })
  const first = seedRun(ctx, { bundle: plan(), branch: BRANCH, state: 'canceled' })
  seedAttempt(ctx, first, { ticket: 1, state: 'accepted', commits: ['1'.repeat(40)] })
  seedAttempt(ctx, first, { ticket: 2, state: 'accepted', commits: ['2'.repeat(40)] })
  seedAttempt(ctx, first, { ticket: 3, state: 'accepted', increment: { commit: '3'.repeat(40) }, checks: PASSED })
  const carryForward = [1, 2, 3].map((ticket) => ({ ticketId: tid(ticket), note: 'Accepted in run 1' }))
  const second = startRun(ctx, { epicId: first.epicId, carryForward })
  submitSprintReport(ctx, { runId: second.id, sprintId: sid(1), report: { summary: 'Carried forward.', retro: SIMPLE_RETRO } })
  const node = second.attempts.find((attempt) => attempt.ticketId === tid(3))
  return { ctx, runId: second.id, nodeAttemptId: node?.id ?? '' }
}

function gate(ctx: TestCtx, runId: string, id: GateConditionId): GateCondition | undefined {
  return getCheckpoint(ctx, { runId }).conditions.find((item) => item.id === id)
}

describe('carrying forward an acceptance node', () => {
  it('copies the earlier acceptance\'s evidence and increment verdict along with its outputs', () => {
    const { ctx, runId, nodeAttemptId } = carriedForward()
    const node = getRun(ctx, { runId })?.attempts.find((attempt) => attempt.id === nodeAttemptId)
    expect(node).toMatchObject({
      kind: 'carry_forward',
      state: 'accepted',
      evidence: { checks: PASSED },
      increment: incrementVerdict({ commit: '3'.repeat(40) })
    })
  })
})

describe('the checkpoint of a sprint carried forward from an earlier run', () => {
  it('meets increment_merged with the increment the earlier acceptance verified', () => {
    const { ctx, runId } = carriedForward()
    expect(gate(ctx, runId, 'increment_merged')).toEqual({
      id: 'increment_merged',
      label: 'Sprint increment merged',
      met: true,
      detail: 'Increment 3333333 on epic/x is one squashed commit on the epic branch'
    })
  })

  it('meets definition_of_done with the checks the earlier acceptance reported', () => {
    const { ctx, runId } = carriedForward()
    expect(gate(ctx, runId, 'definition_of_done')).toEqual({
      id: 'definition_of_done',
      label: 'Definition of Done passed',
      met: true,
      detail: 'DM-3 reports all 2 Definition of Done checks as passed'
    })
  })

  it('leaves only the person\'s approval to give', () => {
    const { ctx, runId } = carriedForward()
    const view = getCheckpoint(ctx, { runId })
    expect(view.conditions.filter((item) => !item.met).map((item) => item.id)).toEqual(['approval'])
    expect(view.gatesMet).toBe(true)
  })
})
