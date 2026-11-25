/**
 * DM-945: the assembled sprint learning lifecycle in one repository, end to end across commands, storage, Git and
 * main's real approval coordinator: a rejected attempt's exact WHY reaches its retry, the sprint advance queues exactly
 * one learning card, the card is claimed, classified, codified on its isolated branch and submitted, the person's
 * approval integrates and publishes it, later claims and orchestrator context select it by role and path, and
 * replacement and retirement change that selection. Also repository- and database-storage round trips, and ordinary
 * Kanban cards and legacy runs and links that behave as before.
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { kanbanCommands } from '../commands/kanban'
import { requireRunView } from '../commands/execution'
import { createGitAdapter } from '../repo/git'
import { buildKanbanEventRecord, buildLearningIntegrationRecord } from '../repo/portable'
import type { KanbanPacket, LearningBranchManifest } from '../../shared/domain/kanban'
import { sid } from '../../test/bundles'
import { captureError } from '../../test/authoring'
import { claim, startedRun, submitClaim } from '../../test/execution'
import { isolateGitConfig } from '../../test/gitRemotes'
import {
  advanceSprint1,
  commitRecords,
  codifyGuardrails,
  EPIC,
  learningApprovals,
  LIFECYCLE_LEARNING,
  type LifecycleProject,
  type LifecycleRepo,
  lifecycleProject,
  PATHS,
  rejectedSprint,
  type RejectedSprint,
  rows,
  submitLearningCard
} from '../../test/learningLifecycle'
import { createTestCtx, withRole } from '../../test/testContext'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { approveKanbanCard, claimKanbanCard, playKanbanCard } from './kanban/attempts'
import { createKanbanCard } from './kanban/cards'
import { listLocalPendingLearningIntegrations } from './learningIntegrations'
import { listLearnings, replaceLearning, retireLearning } from './learnings'

const cleanups: Array<() => void> = []
let harness: Harness

beforeEach(() => {
  isolateGitConfig(cleanups)
  harness = createHarness()
  cleanups.push(() => harness.cleanup())
})

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

const REASONS = ['Missing the  migration upgrade test.\n  Line two keeps its indent.', 'Uses "any" in src/core/db/migrations.ts — remove it.']
const NOTES = 'Reviewer notes:\n- exact text, *markdown* and trailing space '

interface Approved {
  p: LifecycleProject
  sprint: RejectedSprint
  packet: KanbanPacket
  learningId: string
}

/** Reject → retry → advance → claim → codify → submit → the person approves: the card is Done, one learning published. */
async function approvedLifecycle(mode?: 'repo' | 'db'): Promise<Approved> {
  const p = await lifecycleProject(harness, cleanups, [null], mode)
  const sprint = rejectedSprint(p, { reasons: REASONS, notes: NOTES })
  const { learningCard } = advanceSprint1(p, sprint)
  const packet = claimKanbanCard(withRole(p.ctx, 'orchestrator'), { cardId: learningCard.cardId })
  const manifests = codifyGuardrails(p, packet)
  const input = await submitLearningCard(p, packet, manifests)
  await commitRecords(p)
  const card = await learningApprovals(p).approve(p.root, input)
  expect(card).toMatchObject({ id: learningCard.cardId, lane: 'done' })
  const [learning] = rows.activeLearnings(p.ctx)
  return { p, sprint, packet, learningId: learning?.id ?? '' }
}

/** The worker packet's learning ids for a claim of ticket `n` of sprint 2. */
const packetLearnings = (p: LifecycleProject, runId: string, n: number) =>
  claim(withRole(p.ctx, 'orchestrator'), runId, n).packet.learnings?.learnings.map((item) => item.id) ?? []

/** The retry of DM-1 carries attempt 1's decision verbatim; attempt 1's own packet never had it. */
function expectRetryWhy(sprint: RejectedSprint): void {
  expect(sprint.rejected.packet).not.toHaveProperty('priorAttempts')
  expect(sprint.retry.packet.priorAttempts).toEqual([
    expect.objectContaining({
      attemptId: sprint.rejected.attempt.id,
      number: 1,
      state: 'rejected',
      decision: { outcome: 'rejected', reasons: REASONS, notes: NOTES, decidedBy: 'test reviewer' },
      failure: null
    })
  ])
}

/** One advance queues exactly one linked learning card at the increment; its replay returns the same card, writing nothing. */
function advanceQueuesOneCard(p: LifecycleProject, sprint: RejectedSprint): string {
  const first = advanceSprint1(p, sprint)
  expect(advanceSprint1(p, sprint).learningCard).toEqual(first.learningCard)
  const counts = p.ctx.db.get('SELECT (SELECT COUNT(*) FROM kanban_cards) AS cards, (SELECT COUNT(*) FROM sprint_learning_cards) AS links')
  expect(counts).toEqual({ cards: 1, links: 1 })
  expect(first.learningCard).toMatchObject({ sprintId: sid(1), lane: 'backlog', playPending: true, bases: [{ repo: null, branch: EPIC, commit: p.repos[0]?.increment }] })
  return first.learningCard.cardId
}

/** The claim carries the rejection verbatim in the immutable snapshot, and one isolated branch at the increment. */
function expectSnapshotAndBranch(p: LifecycleProject, sprint: RejectedSprint, packet: KanbanPacket): void {
  const rejectedItem = packet.learning?.snapshot?.items.find((item) => item.kind === 'rejected_attempt')
  expect(rejectedItem?.sourceId).toBe(sprint.rejected.attempt.id)
  expect(JSON.stringify(rejectedItem)).toContain(JSON.stringify(REASONS[0]))
  const base = expect.objectContaining({ commit: p.repos[0]?.increment })
  expect(packet.learning?.branches).toEqual([expect.objectContaining({ repo: null, branch: `learnings/${packet.key}/root`, base })])
}

describe('the single-repository learning lifecycle', () => {
  it('carries the exact rejection WHY to the retry, queues one card, and publishes the approved learning once', async () => {
    const p = await lifecycleProject(harness, cleanups, [null])
    const root = (p.repos[0] as LifecycleRepo).repo
    const sprint = rejectedSprint(p, { reasons: REASONS, notes: NOTES })
    expectRetryWhy(sprint)
    const packet = claimKanbanCard(withRole(p.ctx, 'orchestrator'), { cardId: advanceQueuesOneCard(p, sprint) })
    expectSnapshotAndBranch(p, sprint, packet)

    const headBefore = root.rev(EPIC)
    const manifests = codifyGuardrails(p, packet)
    const input = await submitLearningCard(p, packet, manifests)
    // Ready for review: nothing merged, nothing published, nothing selected yet.
    expect([rows.lane(p.ctx, packet.cardId), root.rev(EPIC), rows.publications(p.ctx), rows.activeLearnings(p.ctx)]).toEqual(['ready_for_review', headBefore, [], []])

    await commitRecords(p)
    expect((await learningApprovals(p).approve(p.root, input)).lane).toBe('done')
    expect(root.git('merge-base', '--is-ancestor', (manifests[0] as LearningBranchManifest).commit, EPIC)).toBe('')
    expect(rows.integrations(p.ctx)).toEqual([expect.objectContaining({ attempt_id: packet.attemptId, state: 'published', failure_json: null })])
    expect([rows.publications(p.ctx), rows.activeLearnings(p.ctx).length, rows.plans(p.ctx)]).toEqual([[{ attempt_id: packet.attemptId }], 1, []])
    // A replayed approval changes nothing.
    expect((await learningApprovals(p).approve(p.root, input)).lane).toBe('done')
    expect([rows.integrations(p.ctx).length, rows.publications(p.ctx).length, rows.integrated(root).length]).toEqual([1, 1, 1])
  })

  it('selects the published learning for the matching role and path, and follows replacement and retirement', async () => {
    const { p, sprint, packet, learningId } = await approvedLifecycle()
    const source = { runId: sprint.runId, sprintId: sid(1), cardId: packet.cardId, attemptId: packet.attemptId }
    const claimed = claim(withRole(p.ctx, 'orchestrator'), sprint.runId, 4).packet.learnings?.learnings
    expect(claimed).toEqual([{ id: learningId, title: LIFECYCLE_LEARNING.title, rule: LIFECYCLE_LEARNING.rule, check: LIFECYCLE_LEARNING.check, source }])
    expect(claim(withRole(p.ctx, 'orchestrator'), sprint.runId, 5).packet).not.toHaveProperty('learnings')

    const orchestrator = harness.open('orchestrator', { root: p.root, git: createGitAdapter(p.root) })
    const context = (paths: string[]) => orchestrator.getContext({ event: 'ticket.claimed', paths }).then((view) => view.learnings?.learnings.map((item) => item.id) ?? [])
    expect([await context([PATHS.migrations]), await context([PATHS.renderer])]).toEqual([[learningId], []])
    const reviewer = harness.open('reviewer', { root: p.root, git: createGitAdapter(p.root) })
    expect((await reviewer.getContext({ event: 'ticket.claimed', paths: [PATHS.migrations] })).learnings).toBeUndefined()

    // The person replaces it with guidance for the importer instead: selection follows the successor.
    const { replacement } = replaceLearning(p.ctx, {
      learningId,
      expectedRevision: 1,
      reason: 'The importer needs the same care.',
      replacement: { ...LIFECYCLE_LEARNING, title: 'Run the importer tests', applicability: { ...LIFECYCLE_LEARNING.applicability, paths: ['src/core/repo/**'] } }
    })
    expect([packetLearnings(p, sprint.runId, 6), packetLearnings(p, sprint.runId, 7)]).toEqual([[replacement.id], []])
    expect([await context([PATHS.importer]), await context([PATHS.migrations])]).toEqual([[replacement.id], []])

    // Retiring the successor removes it everywhere; both stay listed with their provenance.
    retireLearning(p.ctx, { learningId: replacement.id, expectedRevision: 1, reason: 'Covered by a guardrail test.' })
    expect([packetLearnings(p, sprint.runId, 8), await context([PATHS.importer])]).toEqual([[], []])
    expect(listLearnings(p.ctx, { state: 'all' }).map((item) => [item.id, item.state, item.replacedBy])).toEqual(
      expect.arrayContaining([[learningId, 'retired', replacement.id], [replacement.id, 'retired', null]])
    )
  })
})

describe('the learning lifecycle in each storage mode', () => {
  it('repository mode: a clone imports the published learning, its integration record and the submitted card event unchanged', async () => {
    const { p, packet, learningId } = await approvedLifecycle('repo')
    await p.workspace.flushPortableState()
    const [integration] = rows.integrations(p.ctx)
    const submitted = p.ctx.db.get<{ id: string }>("SELECT id FROM kanban_events WHERE card_id = ? AND kind = 'submitted'", packet.cardId)?.id ?? ''
    expect(existsSync(join(p.root, '.darkmechanicus', 'learnings', 'records', `${learningId}.json`))).toBe(true)

    const clone = harness.open('desktop', { root: harness.cloneTracked(p.root) })
    const cloned = clone.ctx()
    expect(listLearnings(cloned, {})).toEqual(listLearnings(p.ctx, {}))
    expect(buildLearningIntegrationRecord(cloned.db, integration?.id ?? '')).toEqual(buildLearningIntegrationRecord(p.ctx.db, integration?.id ?? ''))
    expect(buildKanbanEventRecord(cloned.db, submitted)).toEqual(buildKanbanEventRecord(p.ctx.db, submitted))
    expect(JSON.stringify(buildKanbanEventRecord(cloned.db, submitted))).toContain('"draftsHash"')
    // Imported, never owned: the clone has nothing to integrate, and a second reconcile imports nothing new.
    expect(listLocalPendingLearningIntegrations(cloned)).toEqual([])
    const again = await clone.reconcileRepository()
    expect([again.imported, again.rejected]).toEqual([[], []])
  })

  it('database mode: the same lifecycle settles every learning export without writing a record file', async () => {
    const { p, learningId } = await approvedLifecycle('db')
    await p.workspace.flushPortableState()
    expect(existsSync(join(p.root, '.darkmechanicus'))).toBe(false)
    expect(p.ctx.db.all("SELECT kind FROM outbox WHERE kind LIKE 'learning%' AND state <> 'done'")).toEqual([])
    expect([rows.integrations(p.ctx)[0]?.state, rows.activeLearnings(p.ctx)]).toEqual(['published', [{ id: learningId }]])
  })
})

describe('ordinary cards and legacy runs', () => {
  it('an ordinary card is claimed, submitted and approved as before, with no learning section or integration', async () => {
    const ctx = createTestCtx({ role: 'desktop' })
    const card = createKanbanCard(ctx, { title: 'Fix the upload test', acceptanceCriteria: ['It passes'] })
    playKanbanCard(ctx, { cardId: card.id })
    const packet = claimKanbanCard(withRole(ctx, 'orchestrator'), { cardId: card.id })
    expect(packet.learning).toBeUndefined()
    await kanbanCommands.submitKanbanCard.run({ ctx: () => withRole(ctx, 'worker') } as never, COMMAND_SCHEMAS.submitKanbanCard.parse({
      attemptId: packet.attemptId, claimToken: packet.claimToken, outputs: { summary: 'Fixed.' }
    }))
    expect(approveKanbanCard(ctx, { cardId: card.id }).lane).toBe('done')
    expect([ctx.db.all('SELECT * FROM learning_integrations'), ctx.db.all('SELECT * FROM learning_records')]).toEqual([[], []])
  })

  it('a legacy run without a learning card has no learning card, retry history or learnings on a first claim', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const first = claim(ctx, runId, 1)
    expect(first.packet).not.toHaveProperty('priorAttempts')
    expect(first.packet).not.toHaveProperty('learnings')
    submitClaim(ctx, first)
    expect(requireRunView(ctx, runId).learningCard).toBeNull()
  })

  it('a pre-v33 learning card link (no snapshot, no bases) is still claimed, and its submission is refused, not guessed', async () => {
    const ctx = createTestCtx({ role: 'desktop' })
    const { epicId, runId } = startedRun(ctx)
    const card = createKanbanCard(ctx, { title: 'Sprint 1 learnings', acceptanceCriteria: ['Classified'] })
    ctx.db.run(
      `INSERT INTO sprint_learning_cards (card_id, epic_id, run_id, sprint_id, report_id, evidence_hash, created_at)
       VALUES (?, ?, ?, ?, 'rp_report', ?, ?)`,
      card.id, epicId, runId, sid(1), `sha256:${'e'.repeat(64)}`, ctx.clock.nowIso()
    )
    playKanbanCard(ctx, { cardId: card.id })
    const packet = claimKanbanCard(withRole(ctx, 'orchestrator'), { cardId: card.id })
    expect(packet.learning).toMatchObject({ runId, sprintId: sid(1), checkpointId: null, snapshot: null, branches: [] })
    const worker = withRole(ctx, 'worker')
    const submit = (learning?: unknown) =>
      kanbanCommands.submitKanbanCard.run({ ctx: () => worker } as never, COMMAND_SCHEMAS.submitKanbanCard.parse({
        attemptId: packet.attemptId, claimToken: packet.claimToken, outputs: { summary: 'x' }, ...(learning === undefined ? {} : { learning })
      }))
    expect(await submit().then(() => 'submitted', (error: Error) => error.message)).toContain('is a sprint learning card')
    const empty = await submit({ dispositions: [], drafts: [], manifests: [] }).then(() => null, (error: { code: string; message: string }) => error)
    expect(empty).toMatchObject({ code: 'invalid_state', message: expect.stringContaining('has no stored evidence snapshot') })
    expect(captureError(() => approveKanbanCard(ctx, { cardId: card.id })).code).toBeDefined()
    expect(ctx.db.all('SELECT * FROM learning_stagings')).toEqual([])
  })
})
