import { describe, expect, it } from 'vitest'
import type { RecordRowCheckInput } from '../../shared/domain/api'
import { makeBundle, sid, tid } from '../../test/bundles'
import {
  claim,
  clearOutbox,
  completeTicket,
  domainError,
  errorCode,
  eventKinds,
  lastEventPayload,
  pendingOutbox,
  startedRun
} from '../../test/execution'
import { createTestCtx, withRole } from '../../test/testContext'
import { runExecution } from './execution'
import { recordRowCheck } from './rowChecks'
import { cancelRun, getRun } from './runs'

const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'

/** Sprint 1: tickets 1 and 2 are row 1, 3 needs both (row 2), 4 needs 3 (row 3). Sprint 2: ticket 5. */
function rowedRun(): { ctx: ReturnType<typeof createTestCtx>; runId: string } {
  const ctx = createTestCtx()
  const bundle = makeBundle([[1, 2, 3, 4], [5]], [[1, 3], [2, 3], [3, 4], [4, 5]])
  const { runId } = startedRun(ctx, { bundle })
  return { ctx, runId }
}

function check(runId: string, overrides: Partial<RecordRowCheckInput> = {}): RecordRowCheckInput {
  return {
    runId,
    sprintId: sid(1),
    row: 1,
    commit: COMMIT,
    checks: [{ name: 'combined tests', status: 'passed', detail: '42 passed' }],
    ...overrides
  }
}

function failing(runId: string, overrides: Partial<RecordRowCheckInput> = {}): RecordRowCheckInput {
  return check(runId, { checks: [{ name: 'combined tests', status: 'failed', detail: '2 failed' }], ...overrides })
}

describe('recordRowCheck', () => {
  it('stores the check and returns it with who recorded it and whether it passed', () => {
    const { ctx, runId } = rowedRun()
    const view = recordRowCheck(ctx, check(runId))
    expect(view).toEqual({
      id: expect.stringMatching(/^rk_/),
      runId,
      sprintId: sid(1),
      row: 1,
      number: 1,
      commit: COMMIT,
      checks: [{ name: 'combined tests', status: 'passed', detail: '42 passed' }],
      passed: true,
      recordedBy: 'test orchestrator',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    expect(ctx.db.all('SELECT id, run_id, sprint_id, row_no, number, commit_ref FROM row_checks')).toEqual([
      { id: view.id, run_id: runId, sprint_id: sid(1), row_no: 1, number: 1, commit_ref: COMMIT }
    ])
  })

  it('numbers the checks of a run in the order they were recorded, across rows', () => {
    const { ctx, runId } = rowedRun()
    const numbers = [
      recordRowCheck(ctx, check(runId)).number,
      recordRowCheck(ctx, check(runId, { row: 2 })).number,
      recordRowCheck(ctx, check(runId)).number
    ]
    expect(numbers).toEqual([1, 2, 3])
  })

  it('replays the original result for a repeated idempotency key', () => {
    const { ctx, runId } = rowedRun()
    const first = recordRowCheck(ctx, check(runId, { idempotencyKey: 'row-1' }))
    expect(recordRowCheck(ctx, check(runId, { idempotencyKey: 'row-1' }))).toEqual(first)
    expect(ctx.db.all('SELECT id FROM row_checks')).toHaveLength(1)
  })
})

describe('recordRowCheck — what it records', () => {
  it('records a run event and queues the run history for export', () => {
    const { ctx, runId } = rowedRun()
    clearOutbox(ctx)
    const view = recordRowCheck(ctx, failing(runId))
    expect(eventKinds(ctx, 'run.row_check')).toEqual(['run.row_check_recorded'])
    expect(lastEventPayload(ctx, 'run.row_check_recorded')).toEqual({
      rowCheckId: view.id,
      sprintId: sid(1),
      row: 1,
      number: 1,
      commit: COMMIT,
      passed: false
    })
    const epicId = ctx.db.get<{ epic_id: string }>('SELECT epic_id FROM runs WHERE id = ?', runId)?.epic_id
    expect(pendingOutbox(ctx)).toEqual([`run_history:${epicId}:${runId}`])
  })

  it.each([
    ['every entry passed', ['passed', 'passed'], true],
    ['an entry failed', ['passed', 'failed'], false],
    ['an entry was skipped', ['passed', 'skipped'], false],
    ['the only entry was skipped', ['skipped'], false]
  ] as const)('counts a check as passed only when every entry passed: %s', (_label, statuses, passed) => {
    const { ctx, runId } = rowedRun()
    const checks = statuses.map((status, index) => ({ name: `check ${index}`, status, detail: '' }))
    expect(recordRowCheck(ctx, check(runId, { checks })).passed).toBe(passed)
  })
})

describe('recordRowCheck — what it refuses', () => {
  it('names a sprint that is not in the run\'s pinned plan', () => {
    const { ctx, runId } = rowedRun()
    const error = domainError(() => recordRowCheck(ctx, check(runId, { sprintId: sid(9) })))
    expect(error.code).toBe('not_found')
  })

  it('refuses a row the sprint does not have', () => {
    const { ctx, runId } = rowedRun()
    const error = domainError(() => recordRowCheck(ctx, check(runId, { row: 4 })))
    expect([error.code, error.message]).toEqual(['invalid_input', 'Sprint 1 has 3 rows; there is no row 4.'])
    expect(errorCode(() => recordRowCheck(ctx, check(runId, { sprintId: sid(2), row: 2 })))).toBe('invalid_input')
  })

  it('needs an active run this machine owns', () => {
    const { ctx, runId } = rowedRun()
    ctx.db.run("UPDATE runs SET owner_machine_id = 'mc_other' WHERE id = ?", runId)
    expect(errorCode(() => recordRowCheck(ctx, check(runId)))).toBe('run_not_owned')
    ctx.db.run('UPDATE runs SET owner_machine_id = ? WHERE id = ?', ctx.machineId, runId)
    cancelRun(ctx, { runId })
    expect(errorCode(() => recordRowCheck(ctx, check(runId)))).toBe('run_not_active')
    expect(errorCode(() => recordRowCheck(ctx, check('rn_00000000000000000000000099')))).toBe('not_found')
  })

  it.each(['worker', 'reviewer', 'planner', 'desktop'] as const)('is not for a %s session', (role) => {
    const { ctx, runId } = rowedRun()
    expect(errorCode(() => recordRowCheck(withRole(ctx, role), check(runId)))).toBe('unauthorized')
    expect(ctx.db.all('SELECT id FROM row_checks')).toEqual([])
  })
})

describe('row checks in the run view', () => {
  it('reports each ticket\'s row and each row\'s tickets and latest check', () => {
    const { ctx, runId } = rowedRun()
    const view = recordRowCheck(ctx, failing(runId))
    const run = getRun(ctx, { runId })
    expect(run?.tickets.map((ticket) => [ticket.key, ticket.row])).toEqual([
      ['DM-1', 1],
      ['DM-2', 1],
      ['DM-3', 2],
      ['DM-4', 3],
      ['DM-5', 1]
    ])
    expect(run?.rows.map((item) => [item.sprintId, item.row, item.tickets.map((ticket) => ticket.key)])).toEqual([
      [sid(1), 1, ['DM-1', 'DM-2']],
      [sid(1), 2, ['DM-3']],
      [sid(1), 3, ['DM-4']],
      [sid(2), 1, ['DM-5']]
    ])
    expect(run?.rows[0]?.latestCheck).toEqual(view)
    expect(run?.rows[1]?.latestCheck).toBeNull()
  })

  it('shows the newest check of a row, whether it passed or not', () => {
    const { ctx, runId } = rowedRun()
    recordRowCheck(ctx, failing(runId))
    const passing = recordRowCheck(ctx, check(runId))
    expect(getRun(ctx, { runId })?.rows[0]?.latestCheck).toEqual(passing)
  })
})

describe('row checks hold work back', () => {
  function accepted(): { ctx: ReturnType<typeof createTestCtx>; runId: string } {
    const { ctx, runId } = rowedRun()
    completeTicket(ctx, runId, 1)
    completeTicket(ctx, runId, 2)
    return { ctx, runId }
  }

  function viewOf(ctx: ReturnType<typeof createTestCtx>, runId: string, n: number) {
    return runExecution(ctx, runId).tickets.find((ticket) => ticket.ticketId === tid(n))
  }

  it('holds the dependents of a row whose latest check failed, until a passing check is recorded', () => {
    const { ctx, runId } = accepted()
    expect(viewOf(ctx, runId, 3)?.state).toBe('ready')
    const failed = recordRowCheck(ctx, failing(runId))
    expect(viewOf(ctx, runId, 3)).toMatchObject({
      state: 'waiting',
      blockers: [{ kind: 'row_check_failed', sprintId: sid(1), row: 1, checkId: failed.id }]
    })
    const refused = domainError(() => claim(ctx, runId, 3))
    expect(refused.code).toBe('unmet_prerequisite')
    expect(refused.message).toBe(
      "DM-3 is waiting for its prerequisites to be accepted. Row 1 of a prerequisite's sprint failed its row check; record a passing check with record_row_check to release it."
    )
    recordRowCheck(ctx, check(runId))
    expect(viewOf(ctx, runId, 3)).toMatchObject({ state: 'ready', blockers: [] })
    expect(claim(ctx, runId, 3).attempt.state).toBe('claimed')
  })

  it('does not hold work while no check has been recorded', () => {
    const { ctx, runId } = accepted()
    expect(claim(ctx, runId, 3).attempt.state).toBe('claimed')
  })
})
