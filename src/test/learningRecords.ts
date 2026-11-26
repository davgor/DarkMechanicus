/** Published learning records for tests of context selection (DM-936), stored as publication stores them. */
import type { LearningDraft } from '../shared/domain/learnings'
import { contentHash } from '../core/canonical'
import type { Db } from '../core/db/database'
import { encodeBase32 } from '../core/ids'

const id = (prefix: string, n: number): string => `${prefix}_${encodeBase32(BigInt(n), 26)}`

export const LEARNING_SOURCE = { runId: id('rn', 901), sprintId: id('sp', 902), cardId: id('kc', 903), attemptId: id('ka', 904) }

export function learningDraft(overrides: Partial<LearningDraft> = {}): LearningDraft {
  return {
    title: 'Run the migration tests',
    rule: 'Run the migration upgrade tests before submitting a schema change.',
    check: 'The attempt evidence lists the migration test run.',
    applicability: { roles: ['worker'], events: ['ticket.claimed'], paths: [] },
    evidence: [{ kind: 'rejected_attempt', sourceId: 'at_rejected-1', contentHash: `sha256:${'a'.repeat(64)}` }],
    replaces: null,
    ...overrides
  }
}

/** Stores active learning number `n` (`lr_…` id far above test ids), created at `createdAt`; returns its id. */
export function seedLearning(db: Db, n: number, definition: LearningDraft, createdAt: string): string {
  const learningId = id('lr', 20_000 + n)
  db.run(
    `INSERT INTO learning_records (id, run_id, sprint_id, card_id, attempt_id, definition_json, definition_hash, replaces_id, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    learningId, LEARNING_SOURCE.runId, LEARNING_SOURCE.sprintId, LEARNING_SOURCE.cardId, LEARNING_SOURCE.attemptId,
    JSON.stringify(definition), contentHash(definition), definition.replaces, createdAt
  )
  return learningId
}

/** Retires learning `learningId`, as replaced by `replacedBy` when given. */
export function retireLearningRow(db: Db, learningId: string, at: string, replacedBy: string | null = null): void {
  db.run(
    "UPDATE learning_records SET state = 'retired', retired_at = ?, retired_reason = 'Obsolete', replaced_by_id = ?, revision = revision + 1 WHERE id = ?",
    at, replacedBy, learningId
  )
}
