/**
 * A sprint learning card over an in-memory database and a stub Git that proves every guardrail manifest: linked as
 * DM-937 writes it, claimed, submitted through the real command and approved, for core learning service tests that
 * need no real repository. Not shipped.
 */
import type { KanbanPacket } from '../shared/domain/kanban'
import type { LearningDraft, LearningEvidenceItem, LearningIntegrationManifest } from '../shared/domain/learnings'
import { contentHash } from '../core/canonical'
import { COMMAND_SCHEMAS } from '../core/commandSchemas'
import { kanbanCommands } from '../core/commands/kanban'
import type { GitAdapter } from '../core/repo/types'
import { claimKanbanCard, playKanbanCard } from '../core/services/kanban/attempts'
import { createKanbanCard } from '../core/services/kanban/cards'
import { collectLearningEvidence } from '../core/services/learningEvidence'
import { makeBundle, sid } from './bundles'
import { seedAttempt, seedRun, type SeededRun } from './checkpointSeed'
import { createStubGit } from './repoEnv'
import { createTestCtx, type TestCtx, withRole } from './testContext'

const EPIC = 'epic/x'
/** The completed increment every repository's isolated branch is rooted at. */
const BASE = 'a'.repeat(40)
/** The guardrail commit at the tip of every isolated branch. */
export const GUARDRAIL = 'b'.repeat(40)
export const OTHER_MACHINE = 'mc_00000000000000000000000002'

/** A Git that knows every full commit id, finds each one a descendant of the base and every branch at the guardrail. */
export function guardrailGit(onVerify: () => void = () => undefined): GitAdapter {
  return {
    ...createStubGit(EPIC),
    commitParents: async (ref) => (/^[0-9a-f]{40}$/.test(ref) ? { commit: ref, parents: [] } : null),
    isAncestor: async () => {
      onVerify()
      return true
    },
    branchCommit: () => GUARDRAIL
  }
}

export interface LearningWorld {
  desktop: TestCtx
  orchestrator: TestCtx
  worker: TestCtx
  run: SeededRun
  /** The rejected attempt of DM-1 in sprint 1: the one evidence item sprint 1's card snapshots. */
  rejected: string
}

export function learningWorld(): LearningWorld {
  const desktop = createTestCtx({ role: 'desktop', gitFor: () => guardrailGit() })
  const run = seedRun(desktop, { bundle: makeBundle([[1, 2], [3]]) })
  const rejected = seedAttempt(desktop, run, { ticket: 1, state: 'rejected' })
  desktop.db.run(
    'UPDATE attempts SET decision_json = ? WHERE id = ?',
    JSON.stringify({ outcome: 'rejected', notes: '', reasons: ['Missing migration test'], decidedBy: 'reviewer' }),
    rejected
  )
  return { desktop, orchestrator: withRole(desktop, 'orchestrator'), worker: withRole(desktop, 'worker'), run, rejected }
}

/** Sprint `sprint`'s learning card, linked with its snapshot and one base per repository of `repos`, played and claimed. */
export function claimedLearningCard(w: LearningWorld, sprint = 1, repos: (string | null)[] = [null]): KanbanPacket {
  const card = createKanbanCard(w.desktop, { title: `Learnings of sprint ${sprint}`, acceptanceCriteria: ['Classified'] })
  const snapshot = collectLearningEvidence(w.desktop, { runId: w.run.runId, sprintId: sid(sprint) })
  const bases = repos.map((repo) => ({ repo, branch: EPIC, commit: BASE, attemptId: 'at_acceptance' }))
  w.desktop.db.run(
    `INSERT INTO sprint_learning_cards (card_id, epic_id, run_id, sprint_id, report_id, evidence_hash, created_at, checkpoint_id, revision_id, snapshot_json, bases_json)
     VALUES (?, ?, ?, ?, 'rp_report', ?, ?, 'ck_checkpoint', ?, ?, ?)`,
    card.id, w.run.epicId, w.run.runId, sid(sprint), snapshot.contentHash, w.desktop.clock.nowIso(), snapshot.revisionId, JSON.stringify(snapshot), JSON.stringify(bases)
  )
  playKanbanCard(w.desktop, { cardId: card.id })
  return claimKanbanCard(w.orchestrator, { cardId: card.id })
}

/** The first snapshot item of the claimed card, cited by reference. */
export function firstItem(packet: KanbanPacket): LearningEvidenceItem {
  const item = packet.learning?.snapshot?.items[0]
  if (item === undefined) throw new Error('The card snapshot has no item')
  return item
}

export function learningDraft(item: LearningEvidenceItem, overrides: Partial<LearningDraft> = {}): LearningDraft {
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

/** Submits the card through the real command: cited items disposed as learning, every manifest at the guardrail. */
export async function submitLearningCard(w: LearningWorld, packet: KanbanPacket, drafts: LearningDraft[]): Promise<void> {
  const cited = new Set(drafts.flatMap((draft) => draft.evidence.map((ref) => `${ref.kind}/${ref.sourceId}`)))
  const learning = {
    dispositions: (packet.learning?.snapshot?.items ?? []).map((item) => ({
      kind: item.kind,
      sourceId: item.sourceId,
      disposition: cited.has(`${item.kind}/${item.sourceId}`) ? 'learning' : 'not_reusable',
      reason: 'Classified by the test.'
    })),
    drafts,
    manifests: (packet.learning?.branches ?? []).map((plan) => ({ repo: plan.repo, base: plan.base.commit, branch: plan.branch, commit: GUARDRAIL }))
  }
  const input = COMMAND_SCHEMAS.submitKanbanCard.parse({ attemptId: packet.attemptId, claimToken: packet.claimToken, outputs: { summary: 'Codified.' }, learning })
  await kanbanCommands.submitKanbanCard.run({ ctx: () => w.worker } as never, input)
}

/** Stores an open integration this machine prepared, as `prepareLearningIntegration` does: its id. */
export function ownIntegration(
  ctx: TestCtx,
  source: { cardId: string; attemptId: string; draftsHash?: string },
  change: { state: string; repos: (string | null)[]; targetState?: 'pending' | 'integrating' | 'integrated' }
): string {
  const id = ctx.ids.next('learningIntegration')
  const manifest: LearningIntegrationManifest = {
    formatVersion: 1,
    cardId: source.cardId,
    attemptId: source.attemptId,
    runId: 'rn_00000000000000000000000001',
    sprintId: 'sp_00000000000000000000000001',
    draftsHash: source.draftsHash ?? `sha256:${'c'.repeat(64)}`,
    targets: change.repos.map((repository) => ({
      repository,
      branch: EPIC,
      baseCommit: BASE,
      resultCommit: change.targetState === 'integrated' ? GUARDRAIL : null,
      state: change.targetState ?? 'pending'
    }))
  }
  ctx.db.run(
    `INSERT INTO learning_integrations (id, card_id, attempt_id, state, manifest_json, manifest_hash, failure_json, revision, created_at, updated_at, owner_machine_id)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
    id, source.cardId, source.attemptId, change.state, JSON.stringify(manifest), contentHash(manifest), ctx.clock.nowIso(), ctx.clock.nowIso(), ctx.machineId
  )
  return id
}
