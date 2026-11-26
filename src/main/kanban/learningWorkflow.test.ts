/**
 * DM-945: the two-repository learning workflow through main's real approval coordinator, the desktop workspace's
 * production operation allow-list and real Git, as one story: the approval prepares one integration; a conflict in
 * one repository refuses it, leaving the card in Ready for review, every epic branch and isolated branch unmoved and
 * nothing published; the agent resolves it in a new attempt and the person approves again; the app dies right after
 * the first repository's receipt; the next launch's recovery completes that same operation and publishes exactly once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { claimKanbanCard, kickBackKanbanCard } from '../../core/services/kanban/attempts'
import { isolateGitConfig } from '../../test/gitRemotes'
import { put } from '../../test/gitScratch'
import type { ApproveLearningCardRequest } from '../../shared/desktop/api'
import type { KanbanPacket, LearningBranchManifest } from '../../shared/domain/kanban'
import {
  codifyGuardrails,
  Crash,
  crashingAfterFirstReceipt,
  EPIC,
  learningApprovals,
  type LifecycleProject,
  type LifecycleRepo,
  lifecycleProject,
  linkedLearningCard,
  restartWorkspace,
  rows,
  submitLearningCard
} from '../../test/learningLifecycle'
import { type TestCtx, withRole } from '../../test/testContext'
import { createHarness, type Harness } from '../../test/workspaceHarness'

const GUARDRAIL = 'GUARDRAILS.md'
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

/** The epic itself wrote `GUARDRAIL` in `entry` after the sprint: the guardrail no longer merges cleanly there. */
function epicWritesGuardrail(entry: LifecycleRepo, content: string): void {
  put(entry.repo.root, GUARDRAIL, content)
  entry.repo.git('add', '--', GUARDRAIL)
  entry.repo.git('commit', '-q', '-m', 'epic change')
}

/**
 * Beta's epic branch wrote the guardrail file too: one prepared operation is refused at beta, the card stays in Ready
 * for review with the conflict on it, no epic branch moved, every isolated branch is intact and nothing is published.
 */
async function expectConflictRefused(p: LifecycleProject, first: KanbanPacket, manifests: LearningBranchManifest[], input: ApproveLearningCardRequest): Promise<string[]> {
  epicWritesGuardrail(p.repos[1] as LifecycleRepo, 'the epic wrote this first\n')
  const heads = p.repos.map((entry) => entry.repo.rev(EPIC))
  const refusal = await learningApprovals(p).approve(p.root, input).then(() => null, (caught: unknown) => caught)
  expect(refusal).toBeInstanceOf(DomainError)
  expect((refusal as DomainError).message).toMatch(/beta[\s\S]*GUARDRAILS\.md|GUARDRAILS\.md[\s\S]*beta/)
  expect(rows.integrations(p.ctx)).toEqual([expect.objectContaining({ attempt_id: first.attemptId, state: 'conflicted', failure_json: expect.stringContaining(GUARDRAIL) })])
  expect([rows.lane(p.ctx, first.cardId), rows.publications(p.ctx), rows.activeLearnings(p.ctx), rows.plans(p.ctx)]).toEqual(['ready_for_review', [], [], []])
  expect(p.repos.map((entry) => entry.repo.rev(EPIC))).toEqual(heads)
  expect(manifests.map((manifest, index) => p.repos[index]?.repo.rev(manifest.branch))).toEqual(manifests.map((manifest) => manifest.commit))
  expect((await p.workspace.listKanbanMessages({ cardId: first.cardId })).at(-1)?.body).toContain(GUARDRAIL)
  return heads
}

/** The person sends it back; a new attempt on the same isolated branches codifies a guardrail that no longer collides. */
async function resolvedAttempt(p: LifecycleProject, first: KanbanPacket, firstInput: ApproveLearningCardRequest) {
  kickBackKanbanCard(p.ctx, { cardId: first.cardId, comment: 'beta already has GUARDRAILS.md; codify elsewhere.' })
  const second = claimKanbanCard(withRole(p.ctx, 'orchestrator'), { cardId: first.cardId })
  expect(second.learning?.branches).toEqual(first.learning?.branches)
  const manifests = codifyGuardrails(p, second)
  const input = await submitLearningCard(p, second, manifests)
  const stale = await learningApprovals(p).approve(p.root, firstInput).then(() => null, (caught: DomainError) => caught)
  expect(stale?.code).toBe('approval_required')
  return { second, manifests, input }
}

describe('the two-repository learning workflow', () => {
  it('refuses a conflict without publishing, approves the resolved attempt, and recovers a crash after the first receipt once', async () => {
    const p = await lifecycleProject(harness, cleanups, ['alpha', 'beta'])
    const [alpha, beta] = p.repos as [LifecycleRepo, LifecycleRepo]
    const first = linkedLearningCard(p)
    const firstManifests = codifyGuardrails(p, first, GUARDRAIL)
    const firstInput = await submitLearningCard(p, first, firstManifests)
    expect(rows.lane(p.ctx, first.cardId)).toBe('ready_for_review')
    const heads = await expectConflictRefused(p, first, firstManifests, firstInput)
    const { second, manifests: secondManifests, input } = await resolvedAttempt(p, first, firstInput)

    // The app dies after alpha's receipt: alpha landed, beta untouched, the card still Ready, nothing published.
    const crash = await learningApprovals(p, crashingAfterFirstReceipt(p.workspace)).approve(p.root, input).catch((caught: unknown) => caught)
    expect(crash).toBeInstanceOf(Crash)
    const operation = rows.integrations(p.ctx).at(-1)
    expect(operation).toMatchObject({ attempt_id: second.attemptId, state: 'integrating' })
    expect([rows.integrated(alpha.repo).length, beta.repo.rev(EPIC)]).toEqual([1, heads[1]])
    expect([rows.lane(p.ctx, first.cardId), rows.publications(p.ctx), rows.activeLearnings(p.ctx)]).toEqual(['ready_for_review', [], []])

    // The next launch recovers that same operation from its plan and Git heads: both repositories, one publication.
    const restarted = restartWorkspace(p)
    const ctx = restarted.ctx() as TestCtx
    await learningApprovals(p, restarted).recover(p.root)
    expect(rows.lane(ctx, first.cardId)).toBe('done')
    for (const [index, entry] of p.repos.entries()) {
      expect(entry.repo.git('merge-base', '--is-ancestor', secondManifests[index]?.commit ?? '', EPIC)).toBe('')
      expect(rows.integrated(entry.repo)).toHaveLength(1)
    }
    expect(rows.integrations(ctx).map((row) => [row.id, row.state])).toEqual([[rows.integrations(ctx)[0]?.id, 'conflicted'], [operation?.id, 'published']])
    expect([rows.publications(ctx), rows.activeLearnings(ctx).length, rows.plans(ctx)]).toEqual([[{ attempt_id: second.attemptId }], 1, []])

    // Another recovery or a replayed approval starts no second operation and publishes nothing more.
    const again = learningApprovals(p, restarted)
    await again.recover(p.root)
    expect((await again.approve(p.root, input)).lane).toBe('done')
    expect([rows.integrations(ctx).length, rows.publications(ctx).length, rows.integrated(alpha.repo).length, rows.integrated(beta.repo).length]).toEqual([2, 1, 1, 1])
  })
})
