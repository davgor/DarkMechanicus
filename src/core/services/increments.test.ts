/** What verification reads from a run, and how a run, a report and an attempt show each sprint's increment. */
import { describe, expect, it } from 'vitest'
import type { EpicBranch, PlanBundle } from '../../shared/domain/bundle'
import { makeBundle, sid, tid } from '../../test/bundles'
import { acceptTickets, incrementVerdict, seedAttempt, seedRun, type SeededRun, type SeedRunOptions } from '../../test/checkpointSeed'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { contentHash } from '../canonical'
import { attemptView, loadAttempt } from './execution'
import { incrementContextOf } from './increments'
import { getCheckpoint } from './checkpoints'
import { getSprintReport, submitSprintReport } from './reports'
import { getRun } from './runs'

const BRANCH: EpicBranch = { repository: null, name: 'epic/x', startCommit: 'a'.repeat(40) }

/** Sprint 1 = {DM-1, DM-2, DM-3}, sprint 2 = {DM-4, DM-5, DM-6}, sprint 3 = {DM-7, DM-8}; DM-3, DM-6 and DM-8 are acceptance nodes. */
function plan(): PlanBundle {
  const bundle = makeBundle([[1, 2, 3], [4, 5, 6], [7, 8]])
  bundle.tickets = bundle.tickets.map((ticket) =>
    [tid(3), tid(6), tid(8)].includes(ticket.id) ? { ...ticket, kind: 'acceptance' as const } : ticket
  )
  return bundle
}

function setup(options: SeedRunOptions = {}): { ctx: TestCtx; run: SeededRun } {
  const ctx = createTestCtx()
  return { ctx, run: seedRun(ctx, { bundle: plan(), branch: BRANCH, ...options }) }
}

describe('incrementContextOf: the sprint, the epic branch and the accepted work', () => {
  it('names the sprint and the epic branch the node belongs to', () => {
    const { ctx, run } = setup()
    const node = seedAttempt(ctx, run, { ticket: 6, state: 'running' })
    expect(incrementContextOf(ctx, node)).toEqual({ sprintId: sid(2), epicBranch: BRANCH, previous: null, workCommits: [] })
  })

  it('has no epic branch when none was bound', () => {
    const ctx = createTestCtx()
    const run = seedRun(ctx, { bundle: plan() })
    const node = seedAttempt(ctx, run, { ticket: 3, state: 'running' })
    expect(incrementContextOf(ctx, node)?.epicBranch).toBeNull()
  })

  it('is null for an attempt on a work ticket and for an attempt that does not exist', () => {
    const { ctx, run } = setup()
    const work = seedAttempt(ctx, run, { ticket: 1, state: 'running' })
    expect(incrementContextOf(ctx, work)).toBeNull()
    expect(incrementContextOf(ctx, 'at_00000000000000000000000000')).toBeNull()
  })

  it('collects each commit once from the sprint\'s accepted work attempts only', () => {
    const { ctx, run } = setup()
    seedAttempt(ctx, run, { ticket: 1, state: 'accepted', commits: ['1'.repeat(40), '2'.repeat(40)] })
    seedAttempt(ctx, run, { ticket: 2, state: 'accepted', commits: ['2'.repeat(40), '3'.repeat(40)] })
    seedAttempt(ctx, run, { ticket: 2, state: 'rejected', commits: ['4'.repeat(40)] })
    seedAttempt(ctx, run, { ticket: 1, state: 'accepted', superseded: true, commits: ['5'.repeat(40)] })
    seedAttempt(ctx, run, { ticket: 4, state: 'accepted', commits: ['7'.repeat(40)] })
    const node = seedAttempt(ctx, run, { ticket: 3, state: 'running', commits: ['8'.repeat(40)] })
    expect(incrementContextOf(ctx, node)?.workCommits).toEqual(['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)])
  })

  it('collects the commits the sprint\'s carried-forward work brings from the earlier run', () => {
    const { ctx, run } = setup()
    seedAttempt(ctx, run, { ticket: 1, state: 'accepted', kind: 'carry_forward', superseded: true, commits: ['5'.repeat(40)] })
    seedAttempt(ctx, run, { ticket: 1, state: 'accepted', kind: 'carry_forward', commits: ['1'.repeat(40)] })
    seedAttempt(ctx, run, { ticket: 2, state: 'accepted', kind: 'carry_forward', commits: ['2'.repeat(40)] })
    seedAttempt(ctx, run, { ticket: 4, state: 'accepted', kind: 'carry_forward', commits: ['7'.repeat(40)] })
    const node = seedAttempt(ctx, run, { ticket: 3, state: 'running' })
    expect(incrementContextOf(ctx, node)?.workCommits).toEqual(['1'.repeat(40), '2'.repeat(40)])
  })
})

describe('incrementContextOf: the previous increment', () => {
  it('is the nearest earlier sprint\'s verified increment', () => {
    const { ctx, run } = setup()
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted', increment: { commit: '1'.repeat(40) } })
    seedAttempt(ctx, run, { ticket: 6, state: 'accepted', increment: { commit: '2'.repeat(40) } })
    const node = seedAttempt(ctx, run, { ticket: 8, state: 'running' })
    expect(incrementContextOf(ctx, node)?.previous).toEqual({ sprintId: sid(2), commit: '2'.repeat(40) })
  })

  it('skips a sprint whose node named no increment, or one that failed, and reaches an earlier one', () => {
    const { ctx, run } = setup()
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted', increment: { commit: '1'.repeat(40) } })
    seedAttempt(ctx, run, { ticket: 6, state: 'accepted', increment: { commit: '2'.repeat(40), passed: false } })
    const node = seedAttempt(ctx, run, { ticket: 8, state: 'running' })
    expect(incrementContextOf(ctx, node)?.previous).toEqual({ sprintId: sid(1), commit: '1'.repeat(40) })
  })

  it('is null for the first sprint, and ignores a later sprint\'s increment', () => {
    const { ctx, run } = setup()
    seedAttempt(ctx, run, { ticket: 6, state: 'accepted', increment: {} })
    const node = seedAttempt(ctx, run, { ticket: 3, state: 'running' })
    expect(incrementContextOf(ctx, node)?.previous).toBeNull()
  })

  it('does not count an increment of a superseded acceptance', () => {
    const { ctx, run } = setup()
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted', superseded: true, increment: {} })
    const node = seedAttempt(ctx, run, { ticket: 6, state: 'running' })
    expect(incrementContextOf(ctx, node)?.previous).toBeNull()
  })
})

describe('the increment on an attempt view', () => {
  it('is the stored verdict on the submission that named it, and absent on every other attempt', () => {
    const { ctx, run } = setup()
    const named = seedAttempt(ctx, run, { ticket: 3, state: 'submitted', increment: { commit: '9'.repeat(40) } })
    const plain = seedAttempt(ctx, run, { ticket: 1, state: 'accepted' })
    expect(attemptView(loadAttempt(ctx, named)).increment).toEqual(incrementVerdict({ commit: '9'.repeat(40) }))
    expect(Object.keys(attemptView(loadAttempt(ctx, plain)))).not.toContain('increment')
  })
})

describe('the run view: each sprint\'s increment', () => {
  it('lists the increment of every sprint whose node named one, in sprint order, with the attempt that named it', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    const second = seedAttempt(ctx, run, { ticket: 6, state: 'submitted', increment: { commit: '2'.repeat(40) } })
    const first = seedAttempt(ctx, run, { ticket: 3, state: 'accepted', increment: { commit: '1'.repeat(40) } })
    expect(getRun(ctx, { runId: run.runId })?.increments).toEqual([
      {
        sprintId: sid(1),
        sprintOrdinal: 1,
        ticketId: tid(3),
        key: 'DM-3',
        attemptId: first,
        attemptState: 'accepted',
        increment: incrementVerdict({ commit: '1'.repeat(40) })
      },
      {
        sprintId: sid(2),
        sprintOrdinal: 2,
        ticketId: tid(6),
        key: 'DM-6',
        attemptId: second,
        attemptState: 'submitted',
        increment: incrementVerdict({ commit: '2'.repeat(40) })
      }
    ])
  })

  it('is empty when no node named an increment, and shows a rejected attempt\'s failed verdict until a new one stands', () => {
    const { ctx, run } = setup()
    expect(getRun(ctx, { runId: run.runId })?.increments).toEqual([])
    const failed = { passed: false, reasons: ['not squashed'] }
    const rejected = seedAttempt(ctx, run, { ticket: 3, state: 'rejected', increment: failed })
    expect(getRun(ctx, { runId: run.runId })?.increments).toMatchObject([{ attemptId: rejected, attemptState: 'rejected' }])
    const retried = seedAttempt(ctx, run, { ticket: 3, state: 'submitted', increment: { commit: '3'.repeat(40) } })
    expect(getRun(ctx, { runId: run.runId })?.increments).toMatchObject([{ attemptId: retried, attemptState: 'submitted' }])
  })
})

describe('the sprint report view: its sprint\'s increment', () => {
  it('shows the increment beside the report without changing the content hash', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2, 3])
    const submitted = submitSprintReport(ctx, { runId: run.runId, sprintId: sid(1), report: { summary: 'Done.' } })
    expect(submitted.increment).toMatchObject({ sprintId: sid(1), key: 'DM-3', increment: { commit: 'c'.repeat(40), passed: true } })
    expect(submitted.contentHash).toBe(contentHash(submitted.report))
    expect(getSprintReport(ctx, { runId: run.runId })).toEqual(submitted)
    expect(getCheckpoint(ctx, { runId: run.runId }).report).toEqual(submitted)
  })

  it('leaves the field out when the sprint\'s node named no increment', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2])
    const submitted = submitSprintReport(ctx, { runId: run.runId, sprintId: sid(1), report: { summary: 'Done.' } })
    expect(Object.keys(submitted)).not.toContain('increment')
  })
})
