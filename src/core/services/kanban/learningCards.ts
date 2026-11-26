/**
 * DM-938: what makes a generated sprint learning card's claim and submission differ from an ordinary card's. A card is
 * a learning card only when it has a `sprint_learning_cards` link row; any other card's packet and submission never
 * reach this module's additions.
 *
 * The packet carries the link row's immutable snapshot and bases as stored (nothing is collected again), one isolated
 * branch per affected repository, and the reporting contract. The submission must disposition every snapshot item
 * exactly once with a reason, stage its drafts through DM-934's `stageLearningDrafts` (whose validation is the one
 * applied), and name a manifest per base that `verifyLearningManifests` proved before the storing transaction.
 */
import type {
  KanbanLearningPacket,
  KanbanLearningSubmission,
  LearningSubmissionEvidence
} from '../../../shared/domain/kanban'
import type { LearningEvidenceSnapshot, SprintLearningCardView } from '../../../shared/domain/learnings'
import { contentHash } from '../../canonical'
import type { Ctx } from '../../context'
import { parseJson } from '../../db/database'
import { fail } from '../../errors'
import { learningBranchInstruction, learningBranchName, type LearningManifestProof } from '../learningBranches'
import { stageLearningDrafts } from '../learningPublication'

type LearningIncrementBase = SprintLearningCardView['bases'][number]

/** A learning card's link row as the claim and the submission read it. */
interface LearningLink {
  cardKey: string
  runId: string
  sprintId: string
  checkpointId: string | null
  evidenceHash: string
  snapshot: LearningEvidenceSnapshot | null
  bases: LearningIncrementBase[]
}

interface LinkRow {
  key: string
  run_id: string
  sprint_id: string
  checkpoint_id: string | null
  evidence_hash: string
  snapshot_json: string | null
  bases_json: string
}

/** The card's link row, or null for an ordinary card. */
export function learningLinkOf(ctx: Ctx, cardId: string): LearningLink | null {
  const row = ctx.db.get<LinkRow>(
    `SELECT c.key, l.run_id, l.sprint_id, l.checkpoint_id, l.evidence_hash, l.snapshot_json, l.bases_json
     FROM sprint_learning_cards l JOIN kanban_cards c ON c.id = l.card_id WHERE l.card_id = ?`,
    cardId
  )
  if (row === undefined) return null
  return {
    cardKey: row.key,
    runId: row.run_id,
    sprintId: row.sprint_id,
    checkpointId: row.checkpoint_id,
    evidenceHash: row.evidence_hash,
    snapshot: parseJson<LearningEvidenceSnapshot | null>(row.snapshot_json, null),
    bases: parseJson<LearningIncrementBase[]>(row.bases_json, [])
  }
}

const LEARNING_REPORTING = [
  'This is a sprint learning card.',
  'Classify every item of learning.snapshot exactly once in learning.dispositions (kind, sourceId, disposition learning | duplicate | not_reusable, and the reason).',
  'Put each proposed learning in learning.drafts, citing by kind, sourceId and contentHash only items disposed as learning; every learning item must be cited.',
  'Codify guardrails only on the isolated branch of each learning.branches entry, created from its base commit in a worktree of its own.',
  'Report one learning.manifests entry per branch (repo, base commit, branch, branch tip commit). The server verifies each read-only before the card reaches Ready for review; nothing is merged.'
].join(' ')

/** The packet section of a learning card: the stored snapshot and bases, and one isolated branch per base. */
export function learningPacketOf(link: LearningLink): KanbanLearningPacket {
  return {
    runId: link.runId,
    sprintId: link.sprintId,
    checkpointId: link.checkpointId,
    evidenceHash: link.evidenceHash,
    snapshot: link.snapshot,
    branches: link.bases.map((base) => {
      const branch = learningBranchName(link.cardKey, base.repo)
      return {
        repo: base.repo,
        base: { branch: base.branch, commit: base.commit, attemptId: base.attemptId },
        branch,
        instruction: learningBranchInstruction(base, branch)
      }
    }),
    reporting: LEARNING_REPORTING
  }
}

const itemKey = (kind: string, sourceId: string): string => `${kind}\u0000${sourceId}`

/** Exactly one justified disposition per snapshot item: the disposition of each item, by `itemKey`. */
function dispositionsByItem(link: LearningLink, learning: KanbanLearningSubmission): Map<string, string> {
  const snapshot = link.snapshot ?? fail('invalid_state', `Learning card ${link.cardKey} has no stored evidence snapshot to disposition.`)
  const items = new Set(snapshot.items.map((item) => itemKey(item.kind, item.sourceId)))
  const disposed = new Map<string, string>()
  for (const { kind, sourceId, disposition, reason } of learning.dispositions) {
    const key = itemKey(kind, sourceId)
    const problem = !items.has(key)
      ? `Disposition ${kind} ${sourceId} names no item of the card's evidence snapshot.`
      : disposed.has(key)
        ? `${kind} ${sourceId} has more than one disposition; give exactly one.`
        : reason.trim() === ''
          ? `The disposition of ${kind} ${sourceId} needs a reason.`
          : null
    if (problem !== null) fail('invalid_input', problem, { kind, sourceId })
    disposed.set(key, disposition)
  }
  const missing = snapshot.items.filter((item) => !disposed.has(itemKey(item.kind, item.sourceId)))
  if (missing.length > 0) {
    fail('invalid_input', `${missing.length} snapshot item(s) have no disposition, first ${missing[0]?.kind} ${missing[0]?.sourceId}.`, {
      missing: missing.map((item) => ({ kind: item.kind, sourceId: item.sourceId }))
    })
  }
  return disposed
}

/** Drafts rest only on items disposed as learning, and every learning item is cited by a draft. */
function checkDraftsMatch(disposed: Map<string, string>, learning: KanbanLearningSubmission): void {
  const cited = new Set<string>()
  for (const draft of learning.drafts) {
    for (const ref of draft.evidence) {
      const key = itemKey(ref.kind, ref.sourceId)
      if (disposed.has(key) && disposed.get(key) !== 'learning') {
        fail('invalid_input', `Draft "${draft.title}" cites ${ref.kind} ${ref.sourceId}, which is disposed as ${disposed.get(key)}, not learning.`)
      }
      cited.add(key)
    }
  }
  for (const [key, disposition] of disposed) {
    if (disposition === 'learning' && !cited.has(key)) {
      const [kind, sourceId] = key.split('\u0000')
      fail('invalid_input', `${kind} ${sourceId} is disposed as learning, but no draft cites it.`, { kind, sourceId })
    }
  }
}

/**
 * The submission's learning block, checked and its drafts staged (inside the caller's transaction), or undefined for
 * an ordinary card that sent none. An ordinary card sending one, a learning card omitting one, an unverified or
 * failed manifest proof, an incomplete or duplicated disposition, and anything `stageLearningDrafts` refuses all
 * refuse the whole submission.
 */
export function checkLearningSubmission(
  ctx: Ctx,
  attempt: { id: string; card_id: string },
  input: { claimToken: string; learning?: KanbanLearningSubmission },
  proof: LearningManifestProof | undefined
): LearningSubmissionEvidence | undefined {
  const link = learningLinkOf(ctx, attempt.card_id)
  if (link === null) {
    if (input.learning !== undefined) fail('invalid_input', 'Only a sprint learning card takes a learning submission.')
    return undefined
  }
  const learning =
    input.learning ??
    fail('invalid_input', `${link.cardKey} is a sprint learning card: submit learning.dispositions, learning.drafts and learning.manifests.`)
  if (proof === undefined || proof.manifestsHash !== contentHash(learning.manifests)) {
    fail('invalid_state', 'The learning manifests were not verified against Git before the submission.')
  }
  proof.assertCurrent()
  if (!proof.passed) {
    fail('invalid_input', `The learning manifests failed verification: ${proof.reasons.join(' ')}`, { reasons: proof.reasons })
  }
  checkDraftsMatch(dispositionsByItem(link, learning), learning)
  const staged = stageLearningDrafts(ctx, { attemptId: attempt.id, claimToken: input.claimToken, drafts: learning.drafts })
  return {
    snapshotHash: link.evidenceHash,
    dispositions: learning.dispositions,
    draftsHash: staged.draftsHash,
    manifests: proof.manifests
  }
}
