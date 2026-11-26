/**
 * DM-938: claiming and submitting a generated sprint learning card against real temporary repositories: the packet's
 * immutable snapshot and isolated branches, replay-safe claims, complete dispositions, staged drafts, read-only manifest
 * verification before Ready for review, and the merge-to-main requirement replaced only for learning cards.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { KanbanLearningSubmission, KanbanPacket, LearningBranchManifest, LearningItemDisposition } from '../../../shared/domain/kanban'
import type { LearningDraft, LearningEvidenceItem, SprintLearningCardView } from '../../../shared/domain/learnings'
import { baselineDeliveryPolicy } from '../../../shared/domain/standardsPrompts'
import { captureError } from '../../../test/authoring'
import { makeBundle, sid } from '../../../test/bundles'
import { seedAttempt, seedRun, type SeededRun } from '../../../test/checkpointSeed'
import { createGitRepo, type GitRepo } from '../../../test/gitRepo'
import { createTestCtx, type TestCtx, withRole } from '../../../test/testContext'
import { COMMAND_SCHEMAS } from '../../commandSchemas'
import { kanbanCommands } from '../../commands/kanban'
import { createGitAdapter } from '../../repo/git'
import { collectLearningEvidence } from '../learningEvidence'
import { getStagedLearningDrafts } from '../learningPublication'
import { verifyLearningManifests } from '../learningBranches'
import { claimKanbanCard, failKanbanCard, playKanbanCard, submitKanbanCard } from './attempts'
import { createKanbanCard, getKanbanCard } from './cards'
import { buildKanbanEventRecord, kanbanEventRecord } from '../../repo/portable'

const EPIC = 'epic/x'
type Base = SprintLearningCardView['bases'][number]

const repos: GitRepo[] = []
afterEach(() => {
  for (const repo of repos.splice(0)) repo.cleanup()
})

interface Repo {
  name: string | null
  repo: GitRepo
  increment: string
}

/** A repository whose epic branch holds the sprint's completed increment. */
function repository(name: string | null): Repo {
  const repo = createGitRepo()
  repos.push(repo)
  repo.branch(EPIC)
  const increment = repo.commit(`increment of ${name ?? 'root'}`)
  return { name, repo, increment }
}

interface World {
  desktop: TestCtx
  orchestrator: TestCtx
  worker: TestCtx
  run: SeededRun
  repos: Repo[]
}

function world(names: (string | null)[] = [null]): World {
  const built = names.map(repository)
  const gitFor = (repo: string | null) => {
    const found = built.find((entry) => entry.name === repo) ?? built[0]
    return createGitAdapter((found as Repo).repo.root)
  }
  const desktop = createTestCtx({ role: 'desktop', gitFor, checkout: { branch: 'main', commit: null } })
  const run = seedRun(desktop, { bundle: makeBundle([[1, 2], [3]]) })
  const rejected = seedAttempt(desktop, run, { ticket: 1, state: 'rejected' })
  desktop.db.run(
    'UPDATE attempts SET decision_json = ? WHERE id = ?',
    JSON.stringify({ outcome: 'rejected', notes: '', reasons: ['Missing migration test'], decidedBy: 'reviewer' }),
    rejected
  )
  seedAttempt(desktop, run, { ticket: 2, state: 'failed' })
  return { desktop, orchestrator: withRole(desktop, 'orchestrator'), worker: withRole(desktop, 'worker'), run, repos: built }
}

/** A learning card linked as DM-937 writes it (snapshot and bases stored), played. */
function learningCard(w: World): string {
  const card = createKanbanCard(w.desktop, { title: 'Sprint 1 learnings', acceptanceCriteria: ['Classified'] })
  const snapshot = collectLearningEvidence(w.desktop, { runId: w.run.runId, sprintId: sid(1) })
  const bases: Base[] = w.repos.map((entry) => ({ repo: entry.name, branch: EPIC, commit: entry.increment, attemptId: 'at_acceptance' }))
  w.desktop.db.run(
    `INSERT INTO sprint_learning_cards (card_id, epic_id, run_id, sprint_id, report_id, evidence_hash, created_at,
       checkpoint_id, revision_id, snapshot_json, bases_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    card.id,
    w.run.epicId,
    w.run.runId,
    sid(1),
    'rp_report',
    snapshot.contentHash,
    w.desktop.clock.nowIso(),
    'ck_checkpoint',
    snapshot.revisionId,
    JSON.stringify(snapshot),
    JSON.stringify(bases)
  )
  playKanbanCard(w.desktop, { cardId: card.id })
  return card.id
}

const tokenOf = (packet: KanbanPacket): string => packet.claimToken ?? 'missing'

function items(packet: KanbanPacket): LearningEvidenceItem[] {
  return packet.learning?.snapshot?.items ?? []
}

function draftFor(item: LearningEvidenceItem, overrides: Partial<LearningDraft> = {}): LearningDraft {
  return {
    title: 'Run the migration tests',
    rule: 'Run the migration upgrade tests before submitting a schema change.',
    check: 'The attempt evidence lists the migration test run.',
    applicability: { roles: ['worker'], events: ['ticket.claimed'], paths: ['src/core/db/**'] },
    evidence: [{ kind: item.kind, sourceId: item.sourceId, contentHash: item.contentHash }],
    replaces: null,
    ...overrides
  }
}

/** Commits a guardrail on each packet branch, created from its base, without touching any checked-out branch. */
function codify(w: World, packet: KanbanPacket): LearningBranchManifest[] {
  return (packet.learning?.branches ?? []).map((plan) => {
    const entry = w.repos.find((candidate) => candidate.name === plan.repo) as Repo
    entry.repo.git('branch', plan.branch, plan.base.commit)
    entry.repo.switchTo(plan.branch)
    const commit = entry.repo.commit(`guardrail for ${plan.repo ?? 'root'}`)
    entry.repo.switchTo(EPIC)
    return { repo: plan.repo, base: plan.base.commit, branch: plan.branch, commit }
  })
}

/** The first item is the learning, the rest are not reusable. */
function completeLearning(packet: KanbanPacket, manifests: LearningBranchManifest[]): KanbanLearningSubmission {
  const [first, ...rest] = items(packet)
  return {
    dispositions: [
      { kind: (first as LearningEvidenceItem).kind, sourceId: (first as LearningEvidenceItem).sourceId, disposition: 'learning', reason: 'A reusable rule.' },
      ...rest.map((item) => ({ kind: item.kind, sourceId: item.sourceId, disposition: 'not_reusable' as const, reason: 'One-off.' }))
    ],
    drafts: [draftFor(first as LearningEvidenceItem)],
    manifests
  }
}

/** Runs the real submit command (schema, read-only Git verification, then the storing transaction). */
async function submitCommand(w: World, packet: KanbanPacket, learning: KanbanLearningSubmission | undefined, evidence = {}) {
  const input = COMMAND_SCHEMAS.submitKanbanCard.parse({
    attemptId: packet.attemptId,
    claimToken: tokenOf(packet),
    outputs: { summary: 'Learnings codified.' },
    evidence,
    ...(learning && { learning })
  })
  return kanbanCommands.submitKanbanCard.run({ ctx: () => w.worker } as never, input)
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (error: unknown) {
    return error as { code: string; message: string }
  }
  return { code: 'ok', message: '' }
}

const lane = (w: World, packet: KanbanPacket) => getKanbanCard(w.desktop, { cardId: packet.cardId }).lane

describe('learning card packet', () => {
  it('carries the stored snapshot and one isolated branch rooted at the increment of a single repository', () => {
    const w = world()
    const cardId = learningCard(w)
    const stored = w.desktop.db.get<{ snapshot_json: string }>('SELECT snapshot_json FROM sprint_learning_cards WHERE card_id = ?', cardId)
    const packet = claimKanbanCard(w.orchestrator, { cardId })
    expect(packet.learning).toMatchObject({ runId: w.run.runId, sprintId: sid(1), checkpointId: 'ck_checkpoint' })
    expect(JSON.stringify(packet.learning?.snapshot)).toBe(stored?.snapshot_json)
    expect(packet.learning?.evidenceHash).toBe(packet.learning?.snapshot?.contentHash)
    expect(items(packet).length).toBeGreaterThan(0)
    expect(packet.learning?.branches).toEqual([
      {
        repo: null,
        base: { branch: EPIC, commit: w.repos[0]?.increment, attemptId: 'at_acceptance' },
        branch: `learnings/${packet.key}/root`,
        instruction: expect.stringContaining(`git worktree add -b learnings/${packet.key}/root <new-worktree> ${w.repos[0]?.increment}`)
      }
    ])
    expect(packet.reporting.instructions).toContain('This is a sprint learning card.')
  })

  it('reads the immutable snapshot, never collecting evidence again', () => {
    const w = world()
    const cardId = learningCard(w)
    seedAttempt(w.desktop, w.run, { ticket: 1, state: 'failed' })
    const fresh = collectLearningEvidence(w.desktop, { runId: w.run.runId, sprintId: sid(1) })
    const packet = claimKanbanCard(w.orchestrator, { cardId })
    expect(fresh.contentHash).not.toBe(packet.learning?.evidenceHash)
    expect(items(packet)).toHaveLength(fresh.items.length - 1)
  })
})

describe('learning card packet across repositories and claims', () => {
  it('names one isolated branch per affected repository of a folder of repositories', () => {
    const w = world(['api', 'web'])
    const packet = claimKanbanCard(w.orchestrator, { cardId: learningCard(w) })
    expect(packet.learning?.branches.map((plan) => [plan.repo, plan.branch, plan.base.commit])).toEqual([
      ['api', `learnings/${packet.key}/api`, w.repos[0]?.increment],
      ['web', `learnings/${packet.key}/web`, w.repos[1]?.increment]
    ])
  })

  it('replays a claim with its learning section and no token; a reclaim after a lost token names the same branches', () => {
    const w = world(['api', 'web'])
    const cardId = learningCard(w)
    const first = claimKanbanCard(w.orchestrator, { cardId, idempotencyKey: 'claim-1' })
    const replay = claimKanbanCard(w.orchestrator, { cardId, idempotencyKey: 'claim-1' })
    expect(replay).toEqual({ ...first, claimToken: null })
    failKanbanCard(w.orchestrator, { attemptId: first.attemptId, reason: 'Lost the claim token.' })
    const second = claimKanbanCard(w.orchestrator, { cardId, idempotencyKey: 'claim-2' })
    expect(second.attemptId).not.toBe(first.attemptId)
    expect(second.learning).toEqual(first.learning)
    expect(captureError(() => submitKanbanCard(w.worker, { attemptId: first.attemptId, claimToken: tokenOf(first), outputs: { summary: 'late' } })).code).toBe(
      'stale_claim'
    )
  })
})

describe('learning card submission', () => {
  it('verifies the manifests read-only, stages the drafts and moves the card to Ready for review', async () => {
    const w = world(['api', 'web'])
    const packet = claimKanbanCard(w.orchestrator, { cardId: learningCard(w) })
    const manifests = codify(w, packet)
    const heads = w.repos.map((entry) => [entry.repo.git('rev-parse', '--abbrev-ref', 'HEAD'), entry.repo.rev(EPIC)])
    const view = await submitCommand(w, packet, completeLearning(packet, manifests))
    expect(lane(w, packet)).toBe('ready_for_review')
    expect(view.evidence?.learning).toMatchObject({
      snapshotHash: packet.learning?.evidenceHash,
      draftsHash: getStagedLearningDrafts(w.desktop, { attemptId: packet.attemptId }).draftsHash,
      manifests: manifests.map((manifest) => ({ ...manifest, passed: true }))
    })
    expect(view.evidence?.learning?.dispositions).toHaveLength(items(packet).length)
    expect(getStagedLearningDrafts(w.desktop, { attemptId: packet.attemptId }).drafts).toHaveLength(1)
    // Nothing was checked out, merged or moved.
    expect(w.repos.map((entry) => [entry.repo.git('rev-parse', '--abbrev-ref', 'HEAD'), entry.repo.rev(EPIC)])).toEqual(heads)
  })

  it('exports the submitted event with its learning evidence as a portable record that parses back unchanged', async () => {
    const w = world([null])
    const packet = claimKanbanCard(w.orchestrator, { cardId: learningCard(w) })
    await submitCommand(w, packet, completeLearning(packet, codify(w, packet)))
    const submitted = w.desktop.db.get<{ id: string }>("SELECT id FROM kanban_events WHERE kind = 'submitted'")
    const record = buildKanbanEventRecord(w.desktop.db, submitted?.id ?? '')
    const parsed = kanbanEventRecord.parse(JSON.parse(JSON.stringify(record)))
    expect(parsed).toEqual(record)
    expect(JSON.stringify(record)).toContain('"draftsHash"')
  })

  it('refuses before Ready for review when a manifest fails verification, and stores nothing', async () => {
    const w = world(['api', 'web'])
    const packet = claimKanbanCard(w.orchestrator, { cardId: learningCard(w) })
    const [api, web] = codify(w, packet) as [LearningBranchManifest, LearningBranchManifest]
    const cases: LearningBranchManifest[][] = [
      [api],
      [api, { ...web, base: api.base }],
      [api, { ...web, commit: 'f'.repeat(40) }],
      [api, { ...web, branch: 'main' }]
    ]
    for (const manifests of cases) {
      const error = await refusal(submitCommand(w, packet, completeLearning(packet, manifests)))
      expect(error.code).toBe('invalid_input')
      expect(error.message).toContain('The learning manifests failed verification')
    }
    expect(lane(w, packet)).toBe('in_progress')
    expect(captureError(() => getStagedLearningDrafts(w.desktop, { attemptId: packet.attemptId })).code).toBe('invalid_state')
  })
})

describe('learning card dispositions', () => {
  it('refuses incomplete, duplicated, unknown or unjustified dispositions and drafts that do not match them', async () => {
    const w = world()
    const packet = claimKanbanCard(w.orchestrator, { cardId: learningCard(w) })
    const manifests = codify(w, packet)
    const complete = completeLearning(packet, manifests)
    const [first, second] = complete.dispositions as [LearningItemDisposition, LearningItemDisposition]
    const proof = await verifyLearningManifests(w.worker.gitFor, { cardKey: packet.key, bases: [{ repo: null, branch: EPIC, commit: w.repos[0]?.increment ?? '', attemptId: 'at_acceptance' }], manifests })
    const submit = (learning: KanbanLearningSubmission) =>
      captureError(() => submitKanbanCard(w.worker, { attemptId: packet.attemptId, claimToken: tokenOf(packet), outputs: { summary: 'x' }, learning }, false, { learning: proof }))
    expect(submit({ ...complete, dispositions: [first] }).message).toContain('have no disposition')
    expect(submit({ ...complete, dispositions: [...complete.dispositions, second] }).message).toContain('more than one disposition')
    expect(submit({ ...complete, dispositions: [...complete.dispositions, { ...second, sourceId: 'unknown:item' }] }).message).toContain('names no item')
    expect(submit({ ...complete, dispositions: [{ ...first, reason: '   ' }, ...complete.dispositions.slice(1)] }).message).toContain('needs a reason')
    expect(submit({ ...complete, drafts: [] }).message).toContain('no draft cites it')
    const relabeled = complete.dispositions.map((entry) => ({ ...entry, disposition: 'duplicate' as const }))
    expect(submit({ ...complete, dispositions: relabeled }).message).toContain('not learning')
    // DM-934's validation applies to drafts: a wrong evidence hash and an unbounded role list are refused.
    const firstItem = items(packet)[0] as LearningEvidenceItem
    expect(submit({ ...complete, drafts: [draftFor({ ...firstItem, contentHash: `sha256:${'0'.repeat(64)}` })] }).code).toBe('conflict')
    expect(submit({ ...complete, drafts: [draftFor(firstItem, { applicability: { roles: [], events: [], paths: [] } })] }).code).toBe('invalid_input')
    // The schema refuses a blank reason and an unknown disposition before the service sees them.
    const parse = (disposition: unknown) =>
      COMMAND_SCHEMAS.submitKanbanCard.safeParse({ attemptId: packet.attemptId, claimToken: 'x', outputs: { summary: 'x' }, learning: { ...complete, dispositions: [disposition] } }).success
    expect(parse({ ...first, reason: ' ' })).toBe(false)
    expect(parse({ ...first, disposition: 'maybe' })).toBe(false)
    expect(parse(first)).toBe(true)
    expect(lane(w, packet)).toBe('in_progress')
  })
})

describe('learning card submission refusals', () => {
  it('refuses a learning card without its learning block, an unverified submission, and a learning block on an ordinary card', async () => {
    const w = world()
    const packet = claimKanbanCard(w.orchestrator, { cardId: learningCard(w) })
    const manifests = codify(w, packet)
    expect((await refusal(submitCommand(w, packet, undefined))).message).toContain('is a sprint learning card')
    const unverified = captureError(() =>
      submitKanbanCard(w.worker, { attemptId: packet.attemptId, claimToken: tokenOf(packet), outputs: { summary: 'x' }, learning: completeLearning(packet, manifests) })
    )
    expect(unverified.message).toContain('were not verified')
    const proof = await verifyLearningManifests(w.worker.gitFor, { cardKey: packet.key, bases: [{ repo: null, branch: EPIC, commit: w.repos[0]?.increment ?? '', attemptId: 'at_acceptance' }], manifests: [] })
    const swapped = captureError(() =>
      submitKanbanCard(w.worker, { attemptId: packet.attemptId, claimToken: tokenOf(packet), outputs: { summary: 'x' }, learning: completeLearning(packet, manifests) }, false, { learning: proof })
    )
    expect(swapped.message).toContain('were not verified')

    const plain = createKanbanCard(w.desktop, { title: 'Ordinary', acceptanceCriteria: ['Done'] })
    playKanbanCard(w.desktop, { cardId: plain.id })
    const plainPacket = claimKanbanCard(w.orchestrator, { cardId: plain.id })
    expect(plainPacket.learning).toBeUndefined()
    const error = await refusal(submitCommand(w, plainPacket, completeLearning(packet, manifests)))
    expect(error.message).toContain('Only a sprint learning card takes a learning submission')
    expect(lane(w, plainPacket)).toBe('in_progress')
  })
})

describe('Ticket standards on learning cards', () => {
  const checks = { checks: [{ name: 'learning tests', status: 'passed', detail: '9 passed' }], notes: 'verified' }

  it('replaces the merge to main with verified manifests only for a learning card, keeping the other requirements', async () => {
    const w = world()
    w.desktop.deliveryStandards = () => ({ revision: 4, policy: baselineDeliveryPolicy })
    const cardId = learningCard(w)
    const plain = createKanbanCard(w.desktop, { title: 'Ordinary', acceptanceCriteria: ['Done'] })
    playKanbanCard(w.desktop, { cardId: plain.id })
    const plainPacket = claimKanbanCard(w.orchestrator, { cardId: plain.id })
    const plainRefusal = await refusal(submitCommand(w, plainPacket, undefined, checks))
    expect(plainRefusal.message).toContain('origin/main')
    expect(lane(w, plainPacket)).toBe('in_progress')

    const packet = claimKanbanCard(w.orchestrator, { cardId })
    expect(packet.deliveryStandards?.revision).toBe(4)
    const learning = completeLearning(packet, codify(w, packet))
    const failing = await refusal(submitCommand(w, packet, learning, { checks: [{ name: 'learning tests', status: 'failed', detail: '1 failed' }] }))
    expect(failing.code).toBe('invalid_input')
    expect(lane(w, packet)).toBe('in_progress')
    const view = await submitCommand(w, packet, learning, checks)
    expect(view.evidence?.standardsRevision).toBe(4)
    expect(view.evidence?.merge).toBeUndefined()
    expect(lane(w, packet)).toBe('ready_for_review')
  })
})
