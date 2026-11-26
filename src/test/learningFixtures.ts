/** Published learnings and learning integrations for portable-record tests. Not shipped. */
import type { LearningDraft, LearningIntegrationManifest } from '../shared/domain/learnings'
import { contentHash } from '../core/canonical'
import type { Db } from '../core/db/database'
import { enqueueOutbox } from '../core/services/outbox'
import { replaceLearning, retireLearning } from '../core/services/learnings'
import { idOf } from './repoFixtures'
import type { RepoEnv } from './repoEnv'
import { createTestCtx, withRole } from './testContext'

export const LEARNING_SOURCE = {
  runId: idOf('run', 901),
  sprintId: idOf('sprint', 902),
  cardId: idOf('kanbanCard', 903),
  attemptId: idOf('kanbanAttempt', 904)
}

function learningDraft(title: string): LearningDraft {
  return {
    title,
    rule: `Follow the rule called ${title}.`,
    check: 'The attempt evidence shows it.',
    applicability: { roles: ['worker'], events: ['ticket.claimed'], paths: ['src/core/repo/**'] },
    evidence: [{ kind: 'rejected_attempt', sourceId: `at_${title.replace(/\W/g, '-')}`, contentHash: `sha256:${'b'.repeat(64)}` }],
    replaces: null
  }
}

/** Stores a published learning and its `published` history, and queues its export, as publication does. */
export function publishLearning(env: Pick<RepoEnv, 'db' | 'clock'>, n: number, title = `Learning ${n}`): string {
  const learningId = idOf('learningRecord', n)
  const definition = learningDraft(title)
  const { runId, sprintId, cardId, attemptId } = LEARNING_SOURCE
  env.db.run(
    `INSERT INTO learning_records (id, run_id, sprint_id, card_id, attempt_id, definition_json, definition_hash, state, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    learningId, runId, sprintId, cardId, attemptId, JSON.stringify(definition), contentHash(definition), env.clock.nowIso()
  )
  env.db.run(
    `INSERT INTO learning_events (learning_id, kind, reason, revision, actor_role, actor_label, run_id, sprint_id, card_id, attempt_id, at)
     VALUES (?, 'published', 'Published from approved learning card DM-1', 1, 'desktop', 'Ada', ?, ?, ?, ?, ?)`,
    learningId, runId, sprintId, cardId, attemptId, env.clock.nowIso()
  )
  enqueueOutbox({ db: env.db, clock: env.clock }, { kind: 'learning_record', entityId: learningId })
  env.clock.advanceSeconds(60)
  return learningId
}

function humanCtx(env: Pick<RepoEnv, 'db' | 'clock'>) {
  return withRole(createTestCtx({ db: env.db, clock: env.clock, ids: undefined }), 'desktop')
}

/** One active, one retired, and one replaced learning with its active successor. */
export function seedLifecycle(env: Pick<RepoEnv, 'db' | 'clock'>): { active: string; retired: string; replaced: string; successor: string } {
  const active = publishLearning(env, 1, 'Run the importer tests')
  const retired = publishLearning(env, 2, 'Pin fixture clocks')
  const replaced = publishLearning(env, 3, 'Check containment')
  const ctx = humanCtx(env)
  retireLearning(ctx, { learningId: retired, expectedRevision: 1, reason: 'No longer needed' })
  env.clock.advanceSeconds(60)
  const { title, rule, check, applicability } = learningDraft('Check containment and links')
  const result = replaceLearning(ctx, {
    learningId: replaced,
    expectedRevision: 1,
    reason: 'Covers links too',
    replacement: { title, rule, check, applicability }
  })
  env.clock.advanceSeconds(60)
  return { active, retired, replaced, successor: result.replacement.id }
}

export function integrationManifest(overrides: Partial<LearningIntegrationManifest> = {}): LearningIntegrationManifest {
  return {
    formatVersion: 1,
    cardId: LEARNING_SOURCE.cardId,
    attemptId: LEARNING_SOURCE.attemptId,
    runId: LEARNING_SOURCE.runId,
    sprintId: LEARNING_SOURCE.sprintId,
    draftsHash: `sha256:${'c'.repeat(64)}`,
    targets: [
      { repository: 'api', branch: 'main', baseCommit: 'a'.repeat(40), resultCommit: 'b'.repeat(40), state: 'integrated' },
      { repository: 'web', branch: 'main', baseCommit: 'c'.repeat(40), resultCommit: null, state: 'integrating' }
    ],
    ...overrides
  }
}

/** Stores an integration in progress (one repository landed, one still integrating) and queues its export. */
export function startIntegration(env: Pick<RepoEnv, 'db' | 'clock'>, n: number, manifest = integrationManifest()): string {
  const integrationId = idOf('learningIntegration', n)
  insertIntegrationRow(env.db, { id: integrationId, manifest, now: env.clock.nowIso() })
  enqueueOutbox({ db: env.db, clock: env.clock }, { kind: 'learning_integration', entityId: integrationId })
  return integrationId
}

function insertIntegrationRow(db: Db, row: { id: string; manifest: LearningIntegrationManifest; now: string }): void {
  db.run(
    `INSERT INTO learning_integrations (id, card_id, attempt_id, state, manifest_json, manifest_hash, failure_json, revision, created_at, updated_at)
     VALUES (?, ?, ?, 'integrating', ?, ?, NULL, 2, ?, ?)`,
    row.id, row.manifest.cardId, row.manifest.attemptId, JSON.stringify(row.manifest), contentHash(row.manifest), row.now, row.now
  )
}
