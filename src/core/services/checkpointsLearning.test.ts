import { describe, expect, it } from 'vitest'
import type { PlanBundle } from '../../shared/domain/bundle'
import type { SprintLearningCardView } from '../../shared/domain/learnings'
import { makeBundle, sid, tid } from '../../test/bundles'
import { acceptTickets, errorOf, eventLog, incrementVerdict, seedAttempt, seedRun, type SeededRun, type SeedRunOptions } from '../../test/checkpointSeed'
import { SIMPLE_RETRO } from '../../test/retro'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import { requireRunView } from '../commands/execution'
import { advanceSprint, approveAndAdvance, approveCheckpoint, authorizeAutoContinue, getCheckpoint } from './checkpoints'
import { collectLearningEvidence } from './learningEvidence'
import { submitSprintReport } from './reports'
import { generateSprintLearningCard } from './sprintLearningCards'

function started(options: SeedRunOptions = {}): { agent: TestCtx; desktop: TestCtx; run: SeededRun } {
  const agent = createTestCtx()
  return { agent, desktop: withRole(agent, 'desktop'), run: seedRun(agent, options) }
}

function report(ctx: TestCtx, run: SeededRun, sprint = 1, final = false) {
  const outcome = final ? { epicOutcome: { summary: 'Shipped.', successCriteria: [{ criterionId: 's1', met: true, note: 'ok' }] } } : {}
  return submitSprintReport(ctx, { runId: run.runId, sprintId: sid(sprint), report: { summary: `Sprint ${sprint} done.`, ...outcome } })
}

function count(ctx: TestCtx, sql: string): number {
  return ctx.db.get<{ n: number }>(sql)?.n ?? 0
}

/** Cards, link rows, Play events and queued events: each must exist exactly once per generated card. */
function footprint(ctx: TestCtx): Record<string, number> {
  const kinds = eventLog(ctx).map((event) => event.kind)
  return {
    cards: count(ctx, 'SELECT COUNT(*) AS n FROM kanban_cards'),
    links: count(ctx, 'SELECT COUNT(*) AS n FROM sprint_learning_cards'),
    played: count(ctx, "SELECT COUNT(*) AS n FROM kanban_events WHERE kind = 'played'"),
    created: count(ctx, "SELECT COUNT(*) AS n FROM kanban_events WHERE kind = 'created'"),
    queued: kinds.filter((kind) => kind === 'sprint.learning_card_queued').length,
    checkpoints: count(ctx, 'SELECT COUNT(*) AS n FROM checkpoints')
  }
}

const ONE = { cards: 1, links: 1, played: 1, created: 1, queued: 1, checkpoints: 1 }

interface LinkRow {
  card_id: string
  epic_id: string
  run_id: string
  sprint_id: string
  report_id: string
  revision_id: string
  checkpoint_id: string
  evidence_hash: string
  snapshot_json: string
  bases_json: string
}

function linkRow(ctx: TestCtx, sprintId: string): LinkRow | undefined {
  return ctx.db.get<LinkRow>('SELECT * FROM sprint_learning_cards WHERE sprint_id = ?', sprintId)
}

describe('advancing an intermediate sprint', () => {
  it('generates and queues exactly one linked card after the checkpoint, even for an empty snapshot', () => {
    const { agent, desktop, run } = started()
    acceptTickets(agent, run, [1, 2])
    const submitted = report(agent, run)
    approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id })
    const result = advanceSprint(agent, { runId: run.runId })
    expect(footprint(agent)).toEqual(ONE)
    const checkpoint = agent.db.get<{ id: string }>('SELECT id FROM checkpoints')
    const link = linkRow(agent, sid(1))
    expect(link).toMatchObject({
      card_id: result.learningCard.cardId,
      epic_id: run.epicId,
      run_id: run.runId,
      sprint_id: sid(1),
      report_id: submitted.id,
      revision_id: run.revisionId,
      checkpoint_id: checkpoint?.id
    })
    const snapshot = JSON.parse(String(link?.snapshot_json))
    expect(snapshot.items).toEqual([])
    expect(snapshot.contentHash).toBe(link?.evidence_hash)
    expect(result.learningCard).toMatchObject({ evidenceItems: 0, lane: 'backlog', playPending: true, checkpointId: checkpoint?.id })
    const card = agent.db.get<{ lane: string; play_requested_at: string | null; title: string; body: string }>(
      'SELECT lane, play_requested_at, title, body FROM kanban_cards WHERE id = ?',
      result.learningCard.cardId
    )
    expect(card).toMatchObject({ lane: 'backlog', title: 'Sprint 1 learnings' })
    expect(card?.play_requested_at).not.toBeNull()
    expect(card?.body).toContain('no negative evidence')
    // Recorded after the checkpoint: its queued event follows the checkpoint's.
    const kinds = eventLog(agent).map((event) => event.kind)
    expect(kinds.indexOf('sprint.learning_card_queued')).toBeGreaterThan(kinds.indexOf('checkpoint.advanced'))
  })

  it('stores the exact evidence snapshot the sprint had when it advanced', () => {
    const { agent, desktop, run } = started()
    seedAttempt(agent, run, { ticket: 1, state: 'rejected' })
    acceptTickets(agent, run, [1, 2])
    const submitted = report(agent, run)
    const expected = collectLearningEvidence(agent, { runId: run.runId, sprintId: sid(1) })
    expect(expected.items.length).toBeGreaterThan(0)
    approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id })
    const result = advanceSprint(agent, { runId: run.runId })
    expect(JSON.parse(String(linkRow(agent, sid(1))?.snapshot_json))).toEqual(expected)
    expect(result.learningCard).toMatchObject({ evidenceHash: expected.contentHash, evidenceItems: expected.items.length })
  })
})

describe('advancing the final sprint', () => {
  it('also generates one card while the run and epic complete', () => {
    const { agent, desktop, run } = started({ activeSprint: 2 })
    acceptTickets(agent, run, [1, 2, 3])
    const submitted = report(agent, run, 2, true)
    approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id })
    const result = advanceSprint(agent, { runId: run.runId })
    expect(result).toMatchObject({ outcome: 'completed', learningCard: { sprintId: sid(2), playPending: true } })
    expect(footprint(agent)).toEqual(ONE)
    expect(requireRunView(agent, run.runId)).toMatchObject({ state: 'completed', learningCard: { cardId: result.learningCard.cardId } })
  })
})

function autoBundle(): PlanBundle {
  const bundle = makeBundle([[1, 2], [3]])
  return { ...bundle, sprints: bundle.sprints.map((sprint) => ({ ...sprint, checkpoint: { mode: 'auto' } })) }
}

describe('every advance path', () => {
  it('desktop approveAndAdvance queues one card, and its replay returns the same card', () => {
    const { agent, desktop, run } = started()
    acceptTickets(agent, run, [1, 2])
    const submitted = report(agent, run)
    const first = approveAndAdvance(desktop, { runId: run.runId, reportId: submitted.id, idempotencyKey: 'click' })
    const replay = approveAndAdvance(desktop, { runId: run.runId, reportId: submitted.id, idempotencyKey: 'click' })
    expect(replay.learningCard.cardId).toBe(first.learningCard.cardId)
    expect(footprint(agent)).toEqual(ONE)
  })

  it('auto continuation queues one card without a grant', () => {
    const { agent, desktop, run } = started({ bundle: autoBundle() })
    authorizeAutoContinue(desktop, { runId: run.runId, enabled: true })
    acceptTickets(agent, run, [1, 2])
    report(agent, run)
    const result = advanceSprint(agent, { runId: run.runId, idempotencyKey: 'auto-1' })
    expect(advanceSprint(agent, { runId: run.runId, idempotencyKey: 'auto-1' })).toEqual(result)
    expect(footprint(agent)).toEqual(ONE)
    expect(linkRow(agent, sid(1))?.card_id).toBe(result.learningCard.cardId)
  })

  it('a repeated generation for the same run and sprint returns the existing card and writes nothing', () => {
    const { agent, desktop, run } = started()
    acceptTickets(agent, run, [1, 2])
    const submitted = report(agent, run)
    approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id })
    const { learningCard } = advanceSprint(agent, { runId: run.runId })
    const before = footprint(agent)
    const again = agent.db.tx(() =>
      generateSprintLearningCard(agent, { epicId: run.epicId, runId: run.runId, sprintId: sid(1), report: submitted, checkpointId: 'ck_other' })
    )
    expect(again).toEqual(learningCard)
    expect(footprint(agent)).toEqual(before)
    // A second advance of the already advanced sprint is refused and adds nothing either.
    expect(errorOf(() => advanceSprint(agent, { runId: run.runId })).code).toBe('run_not_active')
    expect(footprint(agent)).toEqual(before)
  })
})

describe('a failed advance', () => {
  it('creates nothing when the gates block it', () => {
    const { agent, run } = started({ autoContinue: true })
    acceptTickets(agent, run, [1])
    expect(errorOf(() => advanceSprint(agent, { runId: run.runId })).code).toBeDefined()
    expect(footprint(agent)).toEqual({ cards: 0, links: 0, played: 0, created: 0, queued: 0, checkpoints: 0 })
  })

  it('rolls back the checkpoint, the run move and the card when generation fails inside the transaction', () => {
    const { agent, desktop, run } = started()
    acceptTickets(agent, run, [1, 2])
    const submitted = report(agent, run)
    approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id })
    agent.db.exec(`CREATE TRIGGER fail_link BEFORE INSERT ON sprint_learning_cards BEGIN SELECT RAISE(ABORT, 'link failed'); END;`)
    expect(() => advanceSprint(agent, { runId: run.runId })).toThrow(/link failed/)
    expect(footprint(agent)).toEqual({ cards: 0, links: 0, played: 0, created: 0, queued: 0, checkpoints: 0 })
    expect(agent.db.get<{ state: string; active_sprint_id: string }>('SELECT state, active_sprint_id FROM runs WHERE id = ?', run.runId))
      .toEqual({ state: 'awaiting_checkpoint', active_sprint_id: sid(1) })
    expect(agent.db.get<{ consumed_at: string | null }>('SELECT consumed_at FROM approvals')?.consumed_at).toBeNull()
    agent.db.exec('DROP TRIGGER fail_link')
    expect(advanceSprint(agent, { runId: run.runId }).outcome).toBe('advanced')
    expect(footprint(agent)).toEqual(ONE)
  })
})

describe('the advanced run', () => {
  it('exposes the pending card while the next sprint stays ready and its checkpoint ungated by it', () => {
    const { agent, desktop, run } = started()
    acceptTickets(agent, run, [1, 2])
    const submitted = report(agent, run)
    approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id })
    const { learningCard } = advanceSprint(agent, { runId: run.runId })
    const view = requireRunView(agent, run.runId)
    expect(view.learningCard).toEqual(learningCard)
    expect(view.learningCard).toMatchObject({ playPending: true, sprintId: sid(1) })
    expect(view.tickets.find((ticket) => ticket.ticketId === tid(3))?.state).toBe('ready')
    // The card stays unclaimed, yet sprint 2 reaches and passes its checkpoint.
    acceptTickets(agent, run, [3])
    const final = report(agent, run, 2, true)
    const gates = getCheckpoint(agent, { runId: run.runId })
    expect(gates.gatesMet).toBe(true)
    approveCheckpoint(desktop, { runId: run.runId, reportId: final.id })
    const done = advanceSprint(agent, { runId: run.runId })
    expect(done.learningCard.sprintId).toBe(sid(2))
    expect(requireRunView(agent, run.runId).learningCard?.cardId).toBe(done.learningCard.cardId)
    expect(count(agent, 'SELECT COUNT(*) AS n FROM sprint_learning_cards')).toBe(2)
  })
})

/** Sprint 1 = {DM-1 alpha, DM-2 beta, DM-3 node}, sprint 2 = {DM-4, DM-5 node}, in a folder of alpha and beta. */
function folderRun(): { ctx: TestCtx; run: SeededRun } {
  const bundle = makeBundle([[1, 2, 3], [4, 5]])
  const repos: Record<string, string> = { [tid(1)]: 'alpha', [tid(2)]: 'beta', [tid(4)]: 'alpha' }
  bundle.tickets = bundle.tickets.map((ticket) => {
    const kind = ticket.id === tid(3) || ticket.id === tid(5) ? ('acceptance' as const) : ticket.kind
    const repo = repos[ticket.id]
    return repo === undefined ? { ...ticket, kind } : { ...ticket, kind, repo, title: `${repo} - ${ticket.title}` }
  })
  const ctx = createTestCtx({ repositories: ['alpha', 'beta'] })
  return { ctx, run: seedRun(ctx, { bundle }) }
}

describe('repository bases', () => {
  it('records the completed increment of the single repository', () => {
    const bundle = makeBundle([[1, 2, 3], [4, 5]])
    bundle.tickets = bundle.tickets.map((ticket) => (ticket.id === tid(3) || ticket.id === tid(5) ? { ...ticket, kind: 'acceptance' as const } : ticket))
    const { agent, desktop, run } = started({ bundle })
    acceptTickets(agent, run, [1, 2, 3])
    const submitted = submitSprintReport(agent, { runId: run.runId, sprintId: sid(1), report: { summary: 'Done.', retro: SIMPLE_RETRO } })
    approveCheckpoint(desktop, { runId: run.runId, reportId: submitted.id })
    const { learningCard } = advanceSprint(agent, { runId: run.runId })
    const verdict = incrementVerdict()
    expect(learningCard.bases).toEqual([{ repo: null, branch: verdict.branch, commit: verdict.commit, attemptId: expect.stringMatching(/^at_/) }])
    expect(JSON.parse(String(linkRow(agent, sid(1))?.bases_json))).toEqual(learningCard.bases)
  })

  it('records one base per affected repository in a folder of repositories', () => {
    const { ctx, run } = folderRun()
    acceptTickets(ctx, run, [1, 2])
    const node = seedAttempt(ctx, run, { ticket: 3, state: 'accepted' })
    const verdicts = [incrementVerdict({ repo: 'alpha', commit: 'a'.repeat(40) }), incrementVerdict({ repo: 'beta', commit: 'b'.repeat(40) })]
    ctx.db.run('UPDATE attempts SET increment_json = ? WHERE id = ?', JSON.stringify(verdicts), node)
    const submitted = submitSprintReport(ctx, { runId: run.runId, sprintId: sid(1), report: { summary: 'Done.', retro: SIMPLE_RETRO } })
    approveCheckpoint(withRole(ctx, 'desktop'), { runId: run.runId, reportId: submitted.id })
    const { learningCard } = advanceSprint(ctx, { runId: run.runId })
    expect(learningCard.bases).toEqual([
      { repo: 'alpha', branch: verdicts[0]?.branch, commit: 'a'.repeat(40), attemptId: node },
      { repo: 'beta', branch: verdicts[1]?.branch, commit: 'b'.repeat(40), attemptId: node }
    ])
  })
})

describe('the sprint learning card link', () => {
  it('is immutable once written', () => {
    const { agent, desktop, run } = started()
    acceptTickets(agent, run, [1, 2])
    approveCheckpoint(desktop, { runId: run.runId, reportId: report(agent, run).id })
    const { learningCard }: { learningCard: SprintLearningCardView } = advanceSprint(agent, { runId: run.runId })
    expect(() => agent.db.run("UPDATE sprint_learning_cards SET bases_json = '[]' WHERE card_id = ?", learningCard.cardId)).toThrow(/immutable/)
  })
})
