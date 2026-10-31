/** What verification reads from a run, and how a run, a report and an attempt show each sprint's increment. */
import { describe, expect, it } from 'vitest'
import type { EpicBranch, PlanBundle } from '../../shared/domain/bundle'
import { makeBundle, sid, tid } from '../../test/bundles'
import { acceptTickets, incrementVerdict, seedAttempt, seedRun, type SeededRun, type SeedRunOptions } from '../../test/checkpointSeed'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { contentHash } from '../canonical'
import { attemptView, loadAttempt } from './execution'
import { incrementContextOf, incrementRefusal } from './increments'
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

  it('counts an accepted work attempt that recorded no outputs as bringing no commits', () => {
    const { ctx, run } = setup()
    seedAttempt(ctx, run, { ticket: 1, state: 'accepted' })
    seedAttempt(ctx, run, { ticket: 2, state: 'accepted', commits: ['2'.repeat(40)] })
    const node = seedAttempt(ctx, run, { ticket: 3, state: 'running' })
    expect(incrementContextOf(ctx, node)?.workCommits).toEqual(['2'.repeat(40)])
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

  it('passes over an earlier sprint that has no acceptance node', () => {
    const bundle = makeBundle([[1, 2, 3], [4, 5], [6, 7]])
    bundle.tickets = bundle.tickets.map((ticket) => ([tid(3), tid(7)].includes(ticket.id) ? { ...ticket, kind: 'acceptance' as const } : ticket))
    const ctx = createTestCtx()
    const run = seedRun(ctx, { bundle, branch: BRANCH })
    seedAttempt(ctx, run, { ticket: 3, state: 'accepted', increment: { commit: '1'.repeat(40) } })
    const node = seedAttempt(ctx, run, { ticket: 7, state: 'running' })
    expect(incrementContextOf(ctx, node)?.previous).toEqual({ sprintId: sid(1), commit: '1'.repeat(40) })
  })
})

describe("incrementContextOf: a repository's own epic branch in a folder of repositories", () => {
  it("is that repository's bound branch, and null for a repository with none bound", () => {
    const ctx = createTestCtx({ repositories: ['alpha', 'beta'] })
    const run = seedRun(ctx, { bundle: plan(), branch: { repository: null, name: 'epic/x', startCommit: null } })
    const alpha: EpicBranch = { repository: 'alpha', name: 'epic/x', startCommit: '1'.repeat(40) }
    ctx.db.run('UPDATE epics SET repository_branches_json = ? WHERE id = ?', JSON.stringify([alpha]), run.epicId)
    const node = seedAttempt(ctx, run, { ticket: 3, state: 'running' })
    expect(incrementContextOf(ctx, node, 'alpha')?.epicBranch).toEqual(alpha)
    expect(incrementContextOf(ctx, node, 'beta')?.epicBranch).toBeNull()
  })
})

describe('incrementRefusal in a folder of repositories', () => {
  /** A folder whose plan's work tickets name no repository, with sprint 1's work accepted. */
  function folderWithoutTargets(): TestCtx {
    const ctx = createTestCtx({ repositories: ['alpha'] })
    const run = seedRun(ctx, { bundle: plan(), branch: { repository: null, name: 'epic/x', startCommit: null } })
    seedAttempt(ctx, run, { ticket: 1, state: 'accepted' })
    seedAttempt(ctx, run, { ticket: 2, state: 'accepted' })
    return ctx
  }

  it('takes a submission that names no increment at all', () => {
    expect(incrementRefusal(folderWithoutTargets(), sid(1), {})).toBeNull()
  })

  it('refuses an empty increments list for a sprint whose accepted work targets no repository', () => {
    expect(incrementRefusal(folderWithoutTargets(), sid(1), { increments: [] })).toEqual({
      message: 'the sprint touched no repository (no accepted work ticket targets one), so it has no increment to name.',
      details: { touched: [] }
    })
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

describe('the run view in a folder of repositories: one increment per repository', () => {
  it('lists each repository\'s verdict as its own view, in repository name order', () => {
    const { ctx, run } = setup()
    const node = seedAttempt(ctx, run, { ticket: 3, state: 'submitted' })
    const beta = incrementVerdict({ repo: 'beta', commit: '2'.repeat(40) })
    const alpha = incrementVerdict({ repo: 'alpha', commit: '1'.repeat(40), passed: false, reasons: ['not squashed'] })
    ctx.db.run('UPDATE attempts SET increment_json = ? WHERE id = ?', JSON.stringify([beta, alpha]), node)
    const base = { sprintId: sid(1), sprintOrdinal: 1, ticketId: tid(3), key: 'DM-3', attemptId: node, attemptState: 'submitted' }
    expect(getRun(ctx, { runId: run.runId })?.increments).toEqual([
      { ...base, repo: 'alpha', increment: alpha },
      { ...base, repo: 'beta', increment: beta }
    ])
  })

  it('sorts stored verdicts by repository whatever their stored order, and shows one stored without a repository first, unnamed', () => {
    const { ctx, run } = setup()
    const node = seedAttempt(ctx, run, { ticket: 3, state: 'submitted' })
    const gamma = incrementVerdict({ repo: 'gamma', commit: '3'.repeat(40) })
    const alpha = incrementVerdict({ repo: 'alpha', commit: '1'.repeat(40) })
    const beta = incrementVerdict({ repo: 'beta', commit: '2'.repeat(40) })
    const unnamed = incrementVerdict({ commit: '4'.repeat(40) })
    ctx.db.run('UPDATE attempts SET increment_json = ? WHERE id = ?', JSON.stringify([gamma, alpha, unnamed, beta]), node)
    const views = getRun(ctx, { runId: run.runId })?.increments ?? []
    expect(views.map((view) => [view.repo, view.increment.commit])).toEqual([
      [undefined, '4'.repeat(40)],
      ['alpha', '1'.repeat(40)],
      ['beta', '2'.repeat(40)],
      ['gamma', '3'.repeat(40)]
    ])
    expect(views[0]).not.toHaveProperty('repo')
  })
})

describe('the sprint report view: increment in a single repository, increments in a folder', () => {
  it('sets increment and leaves increments out for a single repository', () => {
    const { ctx, run } = setup()
    acceptTickets(ctx, run, [1, 2, 3])
    const report = submitSprintReport(ctx, { runId: run.runId, sprintId: sid(1), report: { summary: 'Done.' } })
    expect(report.increment).toMatchObject({ key: 'DM-3', increment: { commit: 'c'.repeat(40) } })
    expect(report.increments).toBeUndefined()
    expect(getCheckpoint(ctx, { runId: run.runId }).report?.increments).toBeUndefined()
  })

  it('sets increments, one per repository in name order, and leaves increment out for a folder', () => {
    const ctx = createTestCtx({ repositories: ['alpha', 'beta'] })
    const run = seedRun(ctx, { bundle: plan(), branch: BRANCH })
    acceptTickets(ctx, run, [1, 2])
    const node = seedAttempt(ctx, run, { ticket: 3, state: 'accepted' })
    const beta = incrementVerdict({ repo: 'beta', commit: '2'.repeat(40) })
    const alpha = incrementVerdict({ repo: 'alpha', commit: '1'.repeat(40) })
    ctx.db.run('UPDATE attempts SET increment_json = ? WHERE id = ?', JSON.stringify([beta, alpha]), node)
    const report = submitSprintReport(ctx, { runId: run.runId, sprintId: sid(1), report: { summary: 'Done.' } })
    expect(report.increment).toBeUndefined()
    expect(report.increments?.map((view) => [view.repo, view.increment.commit])).toEqual([
      ['alpha', '1'.repeat(40)],
      ['beta', '2'.repeat(40)]
    ])
    expect(getSprintReport(ctx, { runId: run.runId })).toEqual(report)
  })
})
