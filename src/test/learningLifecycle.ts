/**
 * DM-945: the assembled sprint learning lifecycle over a real desktop project workspace (its production operation
 * allow-list), real temporary Git repositories and main's real approval coordinator. A thin composition of the
 * existing helpers (`workspaceHarness`, `gitRepo`, `checkpointSeed`, `execution`) for the lifecycle tests. Not shipped.
 */
import { join } from 'node:path'
import { COMMAND_SCHEMAS } from '../core/commandSchemas'
import { kanbanCommands } from '../core/commands/kanban'
import { createGitAdapter } from '../core/repo/git'
import { acceptAttempt, rejectAttempt } from '../core/services/attempts'
import { approveAndAdvance } from '../core/services/checkpoints'
import { claimKanbanCard, playKanbanCard } from '../core/services/kanban/attempts'
import { createKanbanCard } from '../core/services/kanban/cards'
import { collectLearningEvidence } from '../core/services/learningEvidence'
import { getStagedLearningDrafts } from '../core/services/learningPublication'
import { submitSprintReport } from '../core/services/reports'
import { type TestWorkspace, testWorkspace } from '../main/desktop/__mocks__/projectWorkspaceFixture'
import { createLearningIntegrationLocks } from '../main/git/learningIntegration'
import { createOperationLocks } from '../main/git/operationLock'
import { createGitRunner, type GitRunner } from '../main/git/runner'
import { createLearningApprovals, type LearningApprovalController } from '../main/kanban/approveLearningCard'
import type { ApproveLearningCardRequest } from '../shared/desktop/api'
import type { PlanBundle } from '../shared/domain/bundle'
import type { KanbanPacket, LearningBranchManifest } from '../shared/domain/kanban'
import type { LearningDraft, LearningEvidenceItem } from '../shared/domain/learnings'
import { makeBundle, makeTicket, sid, tid } from './bundles'
import { seedAttempt, seedRun } from './checkpointSeed'
import { claim, type IssuedClaim, startedRun, submitClaim } from './execution'
import { createGitRepo, type GitRepo } from './gitRepo'
import { put } from './gitScratch'
import { SIMPLE_RETRO } from './retro'
import { type TestCtx, withRole } from './testContext'
import type { Harness } from './workspaceHarness'

/** The epic branch every repository's completed increment is on. */
export const EPIC = 'epic/x'

export interface LifecycleRepo {
  name: string | null
  repo: GitRepo
  increment: string
}

export interface LifecycleProject {
  harness: Harness
  root: string
  repos: LifecycleRepo[]
  workspace: TestWorkspace
  /** The desktop session's context of `workspace` (human: `kanban.review`, `learning.manage`). */
  ctx: TestCtx
}

/**
 * A desktop project on one repository (`[null]`, in `mode`, repository storage by default) or on a folder of child
 * repositories (database storage), each repository at its completed increment on `EPIC`.
 */
export async function lifecycleProject(
  harness: Harness,
  cleanups: Array<() => void>,
  names: (string | null)[],
  mode?: 'repo' | 'db'
): Promise<LifecycleProject> {
  const single = names.length === 1 && names[0] === null
  const repos = names.map((name) => {
    const repo = createGitRepo(name === null ? {} : { root: join(harness.root, name) })
    cleanups.push(repo.cleanup)
    repo.branch(EPIC)
    return { name, repo, increment: repo.commit(`increment of ${name ?? 'root'}`) }
  })
  const root = single ? (repos[0] as LifecycleRepo).repo.root : harness.root
  const core = harness.open('desktop', single ? { root, git: createGitAdapter(root) } : {})
  const workspace = testWorkspace(core, harness.homeDir)
  await workspace.initializeRepository(single ? { name: 'learnings', ...(mode && { mode }) } : { name: 'learnings', layout: 'multi_repo' })
  return { harness, root, repos, workspace, ctx: workspace.ctx() as TestCtx }
}

/** The paths the published learning is scoped to, and a ticket reference inside and outside them. */
export const PATHS = {
  migrations: 'src/core/db/migrations.ts',
  importer: 'src/core/repo/importer.ts',
  renderer: 'src/renderer/src/App.tsx'
}

/**
 * Sprint 1 = {DM-1, DM-2, DM-3 acceptance node}; sprint 2 = {DM-4 and DM-7 on the migrations, DM-5 on the renderer,
 * DM-6 and DM-8 on the importer}: each sprint 2 claim asks for the learnings of its own file reference.
 */
function lifecycleBundle(): PlanBundle {
  const bundle = makeBundle([[1, 2, 3], [4, 5, 6, 7, 8]])
  const references: Record<number, string> = { 4: PATHS.migrations, 5: PATHS.renderer, 6: PATHS.importer, 7: PATHS.migrations, 8: PATHS.importer }
  bundle.tickets = bundle.tickets.map((ticket, index) => {
    const n = index + 1
    if (n === 3) return makeTicket(3, { kind: 'acceptance' })
    const location = references[n]
    return location === undefined ? ticket : makeTicket(n, { references: [{ kind: 'file', label: location, location, hash: null, remoteOnly: false }] })
  })
  return bundle
}

export interface RejectedSprint {
  runId: string
  /** The first claim of DM-1, which the reviewer rejected. */
  rejected: IssuedClaim
  /** The reclaim of DM-1 after the rejection. */
  retry: IssuedClaim
  reportId: string
}

/**
 * Starts a run, rejects DM-1's first attempt with `decision`, reclaims and accepts it, completes DM-2, records the
 * acceptance node's passing increment at the single repository's real increment commit, and reports sprint 1.
 */
export function rejectedSprint(p: LifecycleProject, decision: { reasons: string[]; notes: string }): RejectedSprint {
  const orchestrator = withRole(p.ctx, 'orchestrator')
  const reviewer = withRole(p.ctx, 'reviewer')
  const started = startedRun(p.ctx, { bundle: lifecycleBundle() })
  const rejected = claim(orchestrator, started.runId, 1)
  p.ctx.clock.advanceSeconds(30)
  submitClaim(orchestrator, rejected)
  p.ctx.clock.advanceSeconds(30)
  rejectAttempt(reviewer, { attemptId: rejected.attempt.id, ...decision })
  const retry = claim(orchestrator, started.runId, 1)
  submitClaim(orchestrator, retry)
  acceptAttempt(reviewer, { attemptId: retry.attempt.id })
  const two = claim(orchestrator, started.runId, 2)
  submitClaim(orchestrator, two)
  acceptAttempt(reviewer, { attemptId: two.attempt.id })
  const base = p.repos[0] as LifecycleRepo
  seedAttempt(p.ctx, { ...started, revisionId: started.revisionId ?? '' }, { ticket: 3, state: 'accepted', increment: { branch: EPIC, commit: base.increment } })
  p.ctx.db.run("UPDATE ticket_status SET status = 'completed' WHERE ticket_id = ?", tid(3))
  const report = submitSprintReport(orchestrator, { runId: started.runId, sprintId: sid(1), report: { summary: 'Sprint 1 done.', retro: SIMPLE_RETRO } })
  return { runId: started.runId, rejected, retry, reportId: report.id }
}

/** The person's one-click checkpoint approval and advance of sprint 1 (a replay uses the same key). */
export function advanceSprint1(p: LifecycleProject, sprint: RejectedSprint) {
  return approveAndAdvance(withRole(p.ctx, 'desktop'), { runId: sprint.runId, reportId: sprint.reportId, idempotencyKey: 'advance-sprint-1' })
}

/** The learning the lifecycle drafts: for workers and orchestrators claiming tickets that touch the migrations. */
export const LIFECYCLE_LEARNING = {
  title: 'Run the migration tests',
  rule: 'Run the migration upgrade tests before submitting a schema change.',
  check: 'The attempt evidence lists the migration test run.',
  applicability: { roles: ['worker', 'orchestrator'], events: ['ticket.claimed'], paths: ['src/core/db/**'] }
} satisfies Omit<LearningDraft, 'evidence' | 'replaces'>

/**
 * A sprint learning card linked as DM-937 writes it over a completed run (one rejected attempt in its snapshot, one
 * base per repository at its increment), played and claimed: for a folder of repositories, whose advance needs
 * per-repository acceptance verdicts the lifecycle story does not need to repeat.
 */
export function linkedLearningCard(p: LifecycleProject): KanbanPacket {
  const run = seedRun(p.ctx, { bundle: makeBundle([[1, 2], [3]]) })
  const rejected = seedAttempt(p.ctx, run, { ticket: 1, state: 'rejected' })
  const decision = { outcome: 'rejected', notes: '', reasons: ['Missing the migration test.'], decidedBy: 'reviewer' }
  p.ctx.db.run('UPDATE attempts SET decision_json = ? WHERE id = ?', JSON.stringify(decision), rejected)
  const card = createKanbanCard(p.ctx, { title: 'Sprint 1 learnings', acceptanceCriteria: ['Classified'] })
  const snapshot = collectLearningEvidence(p.ctx, { runId: run.runId, sprintId: sid(1) })
  const bases = p.repos.map((entry) => ({ repo: entry.name, branch: EPIC, commit: entry.increment, attemptId: 'at_acceptance' }))
  p.ctx.db.run(
    `INSERT INTO sprint_learning_cards (card_id, epic_id, run_id, sprint_id, report_id, evidence_hash, created_at, checkpoint_id, revision_id, snapshot_json, bases_json)
     VALUES (?, ?, ?, ?, 'rp_report', ?, ?, 'ck_checkpoint', ?, ?, ?)`,
    card.id, run.epicId, run.runId, sid(1), snapshot.contentHash, p.ctx.clock.nowIso(), snapshot.revisionId, JSON.stringify(snapshot), JSON.stringify(bases)
  )
  playKanbanCard(p.ctx, { cardId: card.id })
  return claimKanbanCard(withRole(p.ctx, 'orchestrator'), { cardId: card.id })
}

/**
 * Commits the guardrail on each isolated branch of the packet, created from its base, then returns to `EPIC`. With
 * `file`, every repository's guardrail writes that same path (so a later epic change to it conflicts).
 */
export function codifyGuardrails(p: LifecycleProject, packet: KanbanPacket, file?: string): LearningBranchManifest[] {
  return (packet.learning?.branches ?? []).map((plan) => {
    const entry = p.repos.find((candidate) => candidate.name === plan.repo) as LifecycleRepo
    entry.repo.git('branch', '-f', plan.branch, plan.base.commit)
    entry.repo.switchTo(plan.branch)
    if (file !== undefined) {
      put(entry.repo.root, file, 'guardrail\n')
      entry.repo.git('add', '--', file)
      entry.repo.git('commit', '-q', '-m', 'guardrail')
    }
    const commit = file === undefined ? entry.repo.commit(`guardrail for ${plan.repo ?? 'root'}`) : entry.repo.rev('HEAD')
    entry.repo.switchTo(EPIC)
    return { repo: plan.repo, base: plan.base.commit, branch: plan.branch, commit }
  })
}

/**
 * Submits the claimed learning card through the real command (schema, read-only Git verification, storing
 * transaction): the rejected attempt's item becomes the learning, every other item is not reusable. Returns the
 * person's exact reviewed approval input.
 */
export async function submitLearningCard(p: LifecycleProject, packet: KanbanPacket, manifests: LearningBranchManifest[]): Promise<ApproveLearningCardRequest> {
  const items = packet.learning?.snapshot?.items ?? []
  const learning = items.find((item) => item.kind === 'rejected_attempt') ?? (items[0] as LearningEvidenceItem)
  const dispositions = items.map((item) => ({
    kind: item.kind,
    sourceId: item.sourceId,
    disposition: item === learning ? ('learning' as const) : ('not_reusable' as const),
    reason: item === learning ? 'A reusable rule.' : 'One-off.'
  }))
  const draft: LearningDraft = { ...LIFECYCLE_LEARNING, evidence: [{ kind: learning.kind, sourceId: learning.sourceId, contentHash: learning.contentHash }], replaces: null }
  const input = COMMAND_SCHEMAS.submitKanbanCard.parse({
    attemptId: packet.attemptId,
    claimToken: packet.claimToken,
    outputs: { summary: 'Learnings codified.' },
    learning: { dispositions, drafts: [draft], manifests }
  })
  await kanbanCommands.submitKanbanCard.run({ ctx: () => withRole(p.ctx, 'worker') } as never, input)
  return { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash: getStagedLearningDrafts(p.ctx, { attemptId: packet.attemptId }).draftsHash }
}

/** The person commits every record written so far, so the registered root checkout is clean before approval. */
export async function commitRecords(p: LifecycleProject): Promise<void> {
  await p.workspace.flushPortableState()
  const root = p.repos.find((entry) => entry.name === null)?.repo
  if (root === undefined || root.git('status', '--porcelain', '--untracked-files=all', '--', '.darkmechanicus') === '') return
  root.git('add', '--', '.darkmechanicus')
  root.git('commit', '-q', '-m', 'records')
}

/** Main's approval coordinator over the project's workspace, composed as bootstrap composes it. */
export function learningApprovals(p: LifecycleProject, workspace: TestWorkspace = p.workspace, runner: GitRunner = createGitRunner()): LearningApprovalController {
  return createLearningApprovals({
    resolve: (folder) => (folder === p.root ? p.root : null),
    workspace: () => workspace,
    git: { runner, operations: createOperationLocks(runner), cards: createLearningIntegrationLocks() }
  })
}

/** Closes the workspace and opens a new one on the same folder: the app restarted. */
export function restartWorkspace(p: LifecycleProject): TestWorkspace {
  p.workspace.close()
  const single = p.repos.length === 1 && p.repos[0]?.name === null
  return testWorkspace(p.harness.open('desktop', single ? { root: p.root, git: createGitAdapter(p.root) } : {}), p.harness.homeDir)
}

export class Crash extends Error {}

/** The workspace as a dying app saw it: the process ends right after the first repository's receipt is stored. */
export function crashingAfterFirstReceipt(workspace: TestWorkspace): TestWorkspace {
  let receipts = 0
  async function call(name: string, ...args: unknown[]): Promise<unknown> {
    const result = await (workspace.call as (name: string, ...args: unknown[]) => Promise<unknown>)(name, ...args)
    if (name === 'recordLearningReceipt' && ++receipts === 1) throw new Crash('the app died after the first receipt')
    return result
  }
  return Object.assign(Object.create(workspace) as TestWorkspace, { call: call as TestWorkspace['call'] })
}

/** The stored rows the lifecycle assertions read. */
export const rows = {
  integrations: (ctx: TestCtx) =>
    ctx.db.all<{ id: string; attempt_id: string; state: string; failure_json: string | null }>(
      'SELECT id, attempt_id, state, failure_json FROM learning_integrations ORDER BY created_at, id'
    ),
  publications: (ctx: TestCtx) => ctx.db.all<{ attempt_id: string }>('SELECT attempt_id FROM learning_publications'),
  activeLearnings: (ctx: TestCtx) => ctx.db.all<{ id: string }>("SELECT id FROM learning_records WHERE state = 'active'"),
  plans: (ctx: TestCtx) => ctx.db.all<{ key: string }>("SELECT key FROM meta WHERE key LIKE 'learning_integration_plan:%'"),
  lane: (ctx: TestCtx, cardId: string) => ctx.db.get<{ lane: string }>('SELECT lane FROM kanban_cards WHERE id = ?', cardId)?.lane,
  /** The learning integrations Git recorded on `EPIC` of `repo`. */
  integrated: (repo: GitRepo) => repo.git('reflog', 'show', '--format=%gs', `refs/heads/${EPIC}`).split('\n').filter((line) => line.startsWith('learning integration'))
}
