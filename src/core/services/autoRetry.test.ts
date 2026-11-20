import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_POLICIES, type PlanBundle } from '../../shared/domain/bundle'
import { makeBundle, tid } from '../../test/bundles'
import { errorOf, eventLog, outboxEntries, runRow, seedAttempt, seedRun, type SeededRun, type SeedRunOptions } from '../../test/checkpointSeed'
import { claim, errorCode, startedRun } from '../../test/execution'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import { contentHash } from '../canonical'
import { planBundle } from '../schemas'
import { failAttempt } from './attempts'
import { acknowledgeAutoRetry, approachKey, listAutoRetries, retryTicket } from './autoRetry'
import { grantRetry } from './checkpoints'
import { runExecution } from './execution'
import { cancelRun, startRun } from './runs'

const TOKEN = `at_${'0'.repeat(26)}.${'s'.repeat(32)}`
const GRANT = `dmg_${'a'.repeat(64)}`

const REASON = 'The migration kept timing out on the large fixture.'
const APPROACHES = [
  'Split the migration into two tickets and batch the fixture load.',
  'Move the work to a higher model tier with a smaller context.',
  'Fix the test environment so the database starts before the suite.',
  'Redesign the import to stream rows instead of loading them at once.'
]

interface World {
  agent: TestCtx
  run: SeededRun
}

/** A run with DM-1 at its retry limit (3 failed attempts of the default 3). */
function atLimit(options: SeedRunOptions = {}): World {
  const agent = createTestCtx()
  const run = seedRun(agent, options)
  fail3(agent, run)
  return { agent, run }
}

function fail3(agent: TestCtx, run: SeededRun, ticket = 1): void {
  for (let i = 0; i < 3; i += 1) seedAttempt(agent, run, { ticket, state: 'failed' })
}

function stateOf(agent: TestCtx, run: SeededRun, ticket = 1): { state: string; blockers: string[] } {
  const snapshot = runExecution(agent, run.runId).tickets.find((item) => item.ticketId === tid(ticket))
  return { state: snapshot?.state ?? 'none', blockers: snapshot?.blockers.map((blocker) => blocker.kind) ?? [] }
}

function extra(agent: TestCtx, run: SeededRun, ticket = 1): number | undefined {
  return agent.db.get<{ extra: number }>('SELECT extra FROM retry_grants WHERE run_id = ? AND ticket_id = ?', run.runId, tid(ticket))?.extra
}

function retry(agent: TestCtx, run: SeededRun, approach = APPROACHES[0], reason = REASON): { autoRetry: number; autoRetriesLeft: number } {
  return retryTicket(agent, { runId: run.runId, ticketId: tid(1), failureReason: reason, newApproach: approach ?? '' })
}

/** Uses up the retry the orchestrator just gave: one more failed attempt puts DM-1 back at its limit. */
function failAgain(agent: TestCtx, run: SeededRun): void {
  seedAttempt(agent, run, { ticket: 1, state: 'failed' })
}

describe('retryTicket', () => {
  it('gives a ticket at its limit exactly one more attempt, so it is claimable again without a person', () => {
    const { agent, run } = atLimit()
    expect(stateOf(agent, run)).toEqual({ state: 'failed', blockers: ['retry_limit'] })
    agent.clock.advanceSeconds(10)
    expect(retry(agent, run)).toEqual({ autoRetry: 1, autoRetriesLeft: 2 })
    expect(extra(agent, run)).toBe(1)
    expect(stateOf(agent, run)).toEqual({ state: 'ready', blockers: [] })
    expect(eventLog(agent).at(-1)).toEqual({
      kind: 'ticket.retry_granted',
      epicId: run.epicId,
      runId: run.runId,
      ticketId: tid(1),
      payload: { extra: 1, grantedBy: 'orchestrator', failureReason: REASON, newApproach: APPROACHES[0], autoRetry: 1 }
    })
    expect(outboxEntries(agent)).toEqual([{ kind: 'run_history', epic_id: run.epicId, run_id: run.runId }])
    // One attempt only: failing it puts the ticket back at its limit.
    failAgain(agent, run)
    expect(stateOf(agent, run)).toEqual({ state: 'failed', blockers: ['retry_limit'] })
  })

  it('lets the orchestrator claim the ticket again through the real services, with no person involved', () => {
    const ctx = createTestCtx()
    const worker = withRole(ctx, 'worker')
    const base = makeBundle([[1]])
    const { runId } = startedRun(ctx, { bundle: { ...base, policies: { ...base.policies, retryLimit: 1 } } })
    const first = claim(ctx, runId, 1)
    failAttempt(worker, { attemptId: first.attempt.id, claimToken: first.packet.claimToken, failure: { reason: 'broken', retryable: true } })
    expect(errorCode(() => claim(ctx, runId, 1))).toBe('retry_limit_reached')
    retryTicket(ctx, { runId, ticketId: tid(1), failureReason: REASON, newApproach: APPROACHES[0] ?? '' })
    expect(claim(ctx, runId, 1).attempt.number).toBe(2)
  })

  it('moves a run waiting at its checkpoint back to running, and leaves a paused run paused', () => {
    const waiting = atLimit({ state: 'awaiting_checkpoint' })
    retry(waiting.agent, waiting.run)
    expect(runRow(waiting.agent, waiting.run.runId)).toMatchObject({ state: 'running', revision: 2 })
    const paused = atLimit({ state: 'paused' })
    retry(paused.agent, paused.run)
    expect(runRow(paused.agent, paused.run.runId)?.state).toBe('paused')
    expect(extra(paused.agent, paused.run)).toBe(1)
  })

  it('trims both texts and masks claim and grant tokens before storing them', () => {
    const { agent, run } = atLimit()
    retry(agent, run, `  ${APPROACHES[1]} Token ${TOKEN}  `, `\n${REASON} The worker pasted ${GRANT} here.\n`)
    const [stored] = listAutoRetries(agent, run.epicId, tid(1))
    expect(stored?.failureReason).toBe(`${REASON} The worker pasted [grant token masked] here.`)
    expect(stored?.newApproach).toBe(`${APPROACHES[1]} Token [claim token masked]`)
    expect(JSON.stringify(eventLog(agent))).not.toContain(TOKEN)
    expect(JSON.stringify(eventLog(agent))).not.toContain(GRANT)
  })
})

describe('retryTicket refusals', () => {
  it('refuses a ticket that is not held by its retry limit', () => {
    const agent = createTestCtx()
    const run = seedRun(agent)
    seedAttempt(agent, run, { ticket: 1, state: 'failed' })
    seedAttempt(agent, run, { ticket: 1, state: 'failed' })
    expect(errorOf(() => retry(agent, run))).toMatchObject({ code: 'conflict', details: { ticketId: tid(1), state: 'ready' } })
    // Nor a ticket whose third attempt is still open.
    seedAttempt(agent, run, { ticket: 1, state: 'running' })
    expect(errorOf(() => retry(agent, run))).toMatchObject({ code: 'conflict', details: { state: 'running' } })
    expect(extra(agent, run)).toBe(undefined)
    expect(eventLog(agent).filter((event) => event.kind === 'ticket.retry_granted')).toEqual([])
  })

  it('refuses a run another machine owns, and one that ended', () => {
    const owned = atLimit({ ownerMachineId: 'mc_00000000000000000000000009' })
    expect(errorOf(() => retry(owned.agent, owned.run)).code).toBe('run_not_owned')
    expect(extra(owned.agent, owned.run)).toBe(undefined)
    const ended = atLimit({ state: 'canceled' })
    expect(errorOf(() => retry(ended.agent, ended.run)).code).toBe('run_not_active')
  })

  it('refuses a ticket outside the run plan', () => {
    const { agent, run } = atLimit()
    const result = errorOf(() => retryTicket(agent, { runId: run.runId, ticketId: tid(99), failureReason: REASON, newApproach: APPROACHES[0] ?? '' }))
    expect(result.code).toBe('not_found')
  })

  it.each([
    ['an empty reason', '', APPROACHES[0], 'failureReason'],
    ['a blank reason', ' '.repeat(40), APPROACHES[0], 'failureReason'],
    ['a short reason', 'It failed again.', APPROACHES[0], 'failureReason'],
    ['a reason padded to length with spaces', `   ${'x'.repeat(19)}   `, APPROACHES[0], 'failureReason'],
    ['an empty approach', REASON, '', 'newApproach'],
    ['a short approach', REASON, 'Try again harder.', 'newApproach'],
    ['a long approach', REASON, 'x'.repeat(2_001), 'newApproach']
  ])('refuses %s', (_label, reason, approach, field) => {
    const { agent, run } = atLimit()
    expect(errorOf(() => retry(agent, run, approach, reason))).toMatchObject({ code: 'invalid_input', details: { field } })
    expect(extra(agent, run)).toBe(undefined)
  })

})

describe('retryTicket refusals of texts, repeated approaches and sessions', () => {
  it('accepts texts of exactly 20 characters once trimmed', () => {
    const { agent, run } = atLimit()
    expect(retry(agent, run, ` ${'b'.repeat(20)} `, ` ${'a'.repeat(20)} `).autoRetry).toBe(1)
  })

  it('refuses an approach already tried for the ticket in this run, whatever its case, spacing or punctuation', () => {
    const { agent, run } = atLimit()
    retry(agent, run, 'Split the migration into two tickets.')
    failAgain(agent, run)
    for (const same of ['split the MIGRATION   into two tickets', '  Split\tthe migration\ninto two tickets!!  ', 'SPLIT THE MIGRATION INTO TWO TICKETS.']) {
      expect(errorOf(() => retry(agent, run, same))).toMatchObject({ code: 'conflict', message: expect.stringContaining('already tried') })
    }
    expect(extra(agent, run)).toBe(1)
    // A genuinely different approach is accepted.
    expect(retry(agent, run, APPROACHES[1]).autoRetry).toBe(2)
  })

  it('does not count an approach of another ticket or another run', () => {
    const agent = createTestCtx()
    const run = seedRun(agent)
    fail3(agent, run, 1)
    fail3(agent, run, 2)
    retry(agent, run, APPROACHES[0])
    expect(retryTicket(agent, { runId: run.runId, ticketId: tid(2), failureReason: REASON, newApproach: APPROACHES[0] ?? '' }).autoRetry).toBe(1)
  })

  it('refuses worker, planner, reviewer, reader and desktop sessions', () => {
    const { agent, run } = atLimit()
    const codes = (['worker', 'planner', 'reviewer', 'reader', 'desktop'] as const).map((role) => errorOf(() => retry(withRole(agent, role), run)).code)
    expect(codes).toEqual(['unauthorized', 'unauthorized', 'unauthorized', 'unauthorized', 'unauthorized'])
    expect(extra(agent, run)).toBe(undefined)
  })
})

describe('the orchestrator retry budget', () => {
  it('returns retry_escalation_required after the default 3, and only the person can add attempts then', () => {
    const { agent, run } = atLimit()
    for (const [index, approach] of APPROACHES.slice(0, 3).entries()) {
      expect(retry(agent, run, approach)).toEqual({ autoRetry: index + 1, autoRetriesLeft: 2 - index })
      failAgain(agent, run)
    }
    const refused = errorOf(() => retry(agent, run, APPROACHES[3]))
    expect(refused).toMatchObject({ code: 'retry_escalation_required', details: { ticketId: tid(1), autoRetries: 3, autoRetryLimit: 3 } })
    expect(extra(agent, run)).toBe(3)
    expect(stateOf(agent, run)).toEqual({ state: 'failed', blockers: ['retry_limit'] })
    // The person's grant still works, and does not refill the orchestrator's budget.
    grantRetry(withRole(agent, 'desktop'), { runId: run.runId, ticketId: tid(1) })
    expect(extra(agent, run)).toBe(4)
    expect(stateOf(agent, run)).toEqual({ state: 'ready', blockers: [] })
    failAgain(agent, run)
    expect(errorOf(() => retry(agent, run, APPROACHES[3])).code).toBe('retry_escalation_required')
  })

  it("does not count the person's grants against it", () => {
    const { agent, run } = atLimit()
    const desktop = withRole(agent, 'desktop')
    grantRetry(desktop, { runId: run.runId, ticketId: tid(1) })
    grantRetry(desktop, { runId: run.runId, ticketId: tid(1) })
    grantRetry(desktop, { runId: run.runId, ticketId: tid(1) })
    for (let i = 0; i < 3; i += 1) failAgain(agent, run)
    expect(retry(agent, run)).toEqual({ autoRetry: 1, autoRetriesLeft: 2 })
  })

  it("follows the plan's autoRetryLimit, 0 included", () => {
    const one = makeBundle([[1, 2], [3]])
    const limited = atLimit({ bundle: { ...one, policies: { ...one.policies, autoRetryLimit: 1 } } })
    retry(limited.agent, limited.run)
    failAgain(limited.agent, limited.run)
    expect(errorOf(() => retry(limited.agent, limited.run, APPROACHES[1])).code).toBe('retry_escalation_required')
    const none = atLimit({ bundle: { ...one, policies: { ...one.policies, autoRetryLimit: 0 } } })
    expect(errorOf(() => retry(none.agent, none.run)).code).toBe('retry_escalation_required')
  })
})

/** A started run of a one-ticket epic whose plan allows one attempt and two orchestrator retries. */
function restartableEpic(): { ctx: TestCtx; epicId: string; firstRun: string; failOnce: (runId: string) => void } {
  const ctx = createTestCtx()
  const worker = withRole(ctx, 'worker')
  const base = makeBundle([[1]])
  const { epicId, runId } = startedRun(ctx, { bundle: { ...base, policies: { ...base.policies, retryLimit: 1, autoRetryLimit: 2 } } })
  const failOnce = (target: string): void => {
    const claimed = claim(ctx, target, 1)
    failAttempt(worker, { attemptId: claimed.attempt.id, claimToken: claimed.packet.claimToken, failure: { reason: 'broken', retryable: true } })
  }
  return { ctx, epicId, firstRun: runId, failOnce }
}

/** Cancels the run and starts a new one of the same epic. */
function restart(ctx: TestCtx, epicId: string, runId: string): string {
  cancelRun(withRole(ctx, 'orchestrator'), { runId, reason: 'restart' })
  return startRun(withRole(ctx, 'orchestrator'), { epicId }).id
}

function retryIn(ctx: TestCtx, runId: string, approach: number): { autoRetry: number; autoRetriesLeft: number } {
  return retryTicket(ctx, { runId, ticketId: tid(1), failureReason: REASON, newApproach: APPROACHES[approach] ?? '' })
}

describe('the orchestrator retry budget across runs', () => {
  it('counts every run of the epic: canceling the run and starting a new one gives no fresh retries or approaches', () => {
    const { ctx, epicId, firstRun, failOnce } = restartableEpic()
    failOnce(firstRun)
    expect(retryIn(ctx, firstRun, 0).autoRetry).toBe(1)
    failOnce(firstRun)
    const second = restart(ctx, epicId, firstRun)
    failOnce(second)
    // The approach tried in the first run is refused in the second, and the second retry is the epic's last.
    expect(errorOf(() => retryIn(ctx, second, 0)).code).toBe('conflict')
    expect(retryIn(ctx, second, 1)).toEqual({ autoRetry: 2, autoRetriesLeft: 0 })
    failOnce(second)
    const third = restart(ctx, epicId, second)
    failOnce(third)
    expect(errorOf(() => retryIn(ctx, third, 2))).toMatchObject({
      code: 'retry_escalation_required',
      details: { autoRetries: 2, autoRetryLimit: 2 }
    })
    // The person's grant still adds an attempt in the new run.
    grantRetry(withRole(ctx, 'desktop'), { runId: third, ticketId: tid(1) })
    expect(claim(ctx, third, 1).attempt.number).toBe(2)
  })

  it("counts another epic's retries of a ticket with the same id on their own", () => {
    const agent = createTestCtx()
    const first = seedRun(agent)
    fail3(agent, first)
    for (const approach of APPROACHES.slice(0, 3)) {
      retry(agent, first, approach)
      failAgain(agent, first)
    }
    const second = seedRun(agent)
    expect(second.epicId).not.toBe(first.epicId)
    fail3(agent, second)
    expect(retry(agent, second, APPROACHES[0]).autoRetry).toBe(1)
  })
})

describe('autoRetryLimit in a saved plan', () => {
  it('is never stored by default, so a plan saved without it keeps its hash', () => {
    expect(Object.keys(DEFAULT_POLICIES)).not.toContain('autoRetryLimit')
    const bundle = makeBundle([[1, 2], [3]])
    const parsed = planBundle.parse(bundle) as PlanBundle
    expect(Object.keys(parsed.policies)).not.toContain('autoRetryLimit')
    expect(contentHash(parsed)).toBe(contentHash(bundle))
    // A plan snapshot saved before the policy existed still hashes to the hash it was saved with.
    const snapshot = JSON.parse(
      readFileSync(join(__dirname, '../repo/__mocks__/legacy/epics/ep_01m3txy30qavmd5wewct90804g/snapshots/rv_01m3txzpv9ws6fbj6p211ghkn9.json'), 'utf8')
    ) as { bundle: PlanBundle; contentHash: string }
    expect(contentHash(planBundle.parse(snapshot.bundle))).toBe(snapshot.contentHash)
  })

  it('is stored, and hashed, only when a plan sets it', () => {
    const bundle = makeBundle([[1, 2], [3]])
    const set = planBundle.parse({ ...bundle, policies: { ...bundle.policies, autoRetryLimit: 5 } }) as PlanBundle
    expect(set.policies.autoRetryLimit).toBe(5)
    expect(contentHash(set)).not.toBe(contentHash(bundle))
    expect(planBundle.safeParse({ ...bundle, policies: { ...bundle.policies, autoRetryLimit: -1 } }).success).toBe(false)
  })
})

describe('approachKey', () => {
  it('ignores case, spacing and punctuation only', () => {
    expect(approachKey('  Split, the WORK.  ')).toBe(approachKey('split the work'))
    expect(approachKey('Split the work')).not.toBe(approachKey('Split the design'))
  })
})

describe('acknowledgeAutoRetry', () => {
  it('records that the person read a retry, once, without touching attempts, grants or the run', () => {
    const { agent, run } = atLimit({ state: 'awaiting_checkpoint' })
    retry(agent, run)
    const before = { run: runRow(agent, run.runId), extra: extra(agent, run), state: stateOf(agent, run) }
    expect(listAutoRetries(agent, run.epicId, tid(1))).toEqual([
      {
        runId: run.runId,
        runNumber: 1,
        ticketId: tid(1),
        number: 1,
        failureReason: REASON,
        newApproach: APPROACHES[0],
        at: '2026-01-01T00:00:00.000Z',
        acknowledgedAt: null
      }
    ])
    const desktop = withRole(agent, 'desktop')
    agent.clock.advanceSeconds(60)
    const acknowledged = acknowledgeAutoRetry(desktop, { runId: run.runId, ticketId: tid(1), number: 1 })
    expect(acknowledged.acknowledgedAt).toBe('2026-01-01T00:01:00.000Z')
    agent.clock.advanceSeconds(60)
    expect(acknowledgeAutoRetry(desktop, { runId: run.runId, ticketId: tid(1), number: 1 }).acknowledgedAt).toBe('2026-01-01T00:01:00.000Z')
    expect(listAutoRetries(agent, run.epicId, tid(1))[0]?.acknowledgedAt).toBe('2026-01-01T00:01:00.000Z')
    expect(eventLog(agent).filter((event) => event.kind === 'ticket.auto_retry_acknowledged')).toHaveLength(1)
    expect({ run: runRow(agent, run.runId), extra: extra(agent, run), state: stateOf(agent, run) }).toEqual(before)
  })

  it('is the person’s alone, and refuses a retry that does not exist', () => {
    const { agent, run } = atLimit()
    retry(agent, run)
    const codes = (['orchestrator', 'planner', 'worker', 'reviewer', 'reader'] as const).map(
      (role) => errorOf(() => acknowledgeAutoRetry(withRole(agent, role), { runId: run.runId, ticketId: tid(1), number: 1 })).code
    )
    expect(new Set(codes)).toEqual(new Set(['unauthorized']))
    const desktop = withRole(agent, 'desktop')
    expect(errorOf(() => acknowledgeAutoRetry(desktop, { runId: run.runId, ticketId: tid(1), number: 2 })).code).toBe('not_found')
    // The person's own grant is not an orchestrator retry to acknowledge.
    grantRetry(desktop, { runId: run.runId, ticketId: tid(2) })
    expect(errorOf(() => acknowledgeAutoRetry(desktop, { runId: run.runId, ticketId: tid(2), number: 1 })).code).toBe('not_found')
    expect(listAutoRetries(agent, run.epicId, tid(2))).toEqual([])
  })
})
