/**
 * DM-943: the read model a person reviews a sprint learning card with (`KanbanCardView.learning`) and the source
 * card's published integration on every learning it published (`LearningView.integration`).
 */
import { describe, expect, it } from 'vitest'
import type { LearningIntegrationManifest } from '../../shared/domain/learnings'
import type { LearningIntegrationPlan } from '../../shared/git/learningIntegration'
import { integrationManifest, LEARNING_SOURCE, publishLearning } from '../../test/learningFixtures'
import { idOf } from '../../test/repoFixtures'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { contentHash } from '../canonical'
import { createKanbanCard, getKanbanCard } from './kanban/cards'
import { getLearning, listLearnings, replaceLearning } from './learnings'

const BASE = 'a'.repeat(40)
const OLD_HEAD = '1'.repeat(40)
const NEW_HEAD = '2'.repeat(40)
const IDENTITY_TOKEN = 'identity-token-never-shown'

function linkCard(ctx: TestCtx): { cardId: string; key: string } {
  const card = createKanbanCard(ctx, { title: 'Sprint 1 learnings' })
  const bases = [
    { repo: 'api', branch: 'epic/x', commit: BASE, attemptId: 'at_acceptance' },
    { repo: 'web', branch: 'epic/x', commit: 'c'.repeat(40), attemptId: 'at_acceptance' }
  ]
  ctx.db.run(
    `INSERT INTO sprint_learning_cards (card_id, epic_id, run_id, sprint_id, report_id, evidence_hash, created_at,
       checkpoint_id, revision_id, snapshot_json, bases_json)
     VALUES (?, 'ep_x', ?, ?, 'rp_report', ?, ?, 'ck_checkpoint', 'rv_revision', NULL, ?)`,
    card.id,
    LEARNING_SOURCE.runId,
    LEARNING_SOURCE.sprintId,
    `sha256:${'e'.repeat(64)}`,
    ctx.clock.nowIso(),
    JSON.stringify(bases)
  )
  return { cardId: card.id, key: card.key }
}

function insertIntegration(ctx: TestCtx, row: { n: number; state: string; manifest: LearningIntegrationManifest; failure?: string }): string {
  const id = idOf('learningIntegration', row.n)
  ctx.db.run(
    `INSERT INTO learning_integrations (id, card_id, attempt_id, state, manifest_json, manifest_hash, failure_json, revision, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    id,
    row.manifest.cardId,
    row.manifest.attemptId,
    row.state,
    JSON.stringify(row.manifest),
    contentHash(row.manifest),
    row.failure ?? null,
    ctx.clock.nowIso(),
    ctx.clock.nowIso()
  )
  ctx.clock.advanceSeconds(60)
  return id
}

/** The machine-local plan as the approval stores it: absolute checkouts and each repository's identity token. */
function storePlan(ctx: TestCtx, integrationId: string, cardId: string): void {
  const target = (repository: string) => ({
    repository,
    checkout: `C:/secret/${repository}`,
    targetRef: 'refs/heads/main',
    oldHead: OLD_HEAD,
    newHead: NEW_HEAD,
    outcome: 'merge' as const,
    source: { branch: `learnings/DM-1/${repository}`, commit: '3'.repeat(40), base: BASE },
    preparedRef: `refs/darkmechanicus/learning-prep/${cardId}/${repository}`,
    identity: { commonDir: `C:/secret/${repository}/.git`, token: IDENTITY_TOKEN }
  })
  const plan: LearningIntegrationPlan = { cardId, attemptId: LEARNING_SOURCE.attemptId, targets: [target('api'), target('web')] }
  ctx.db.run('INSERT INTO meta (key, value) VALUES (?, ?)', `learning_integration_plan:${integrationId}`, JSON.stringify(plan))
}

describe('the learning review section of a Kanban card', () => {
  it('is absent on an ordinary card', () => {
    const ctx = createTestCtx({ role: 'desktop' })
    const card = createKanbanCard(ctx, { title: 'Fix the flaky upload test' })
    expect(getKanbanCard(ctx, { cardId: card.id })).not.toHaveProperty('learning')
  })

  it('shows provenance and each isolated branch before any integration or publication', () => {
    const ctx = createTestCtx({ role: 'desktop' })
    const { cardId, key } = linkCard(ctx)
    expect(getKanbanCard(ctx, { cardId }).learning).toEqual({
      runId: LEARNING_SOURCE.runId,
      sprintId: LEARNING_SOURCE.sprintId,
      reportId: 'rp_report',
      revisionId: 'rv_revision',
      checkpointId: 'ck_checkpoint',
      evidenceHash: `sha256:${'e'.repeat(64)}`,
      snapshot: null,
      branches: [
        { repo: 'api', base: { branch: 'epic/x', commit: BASE, attemptId: 'at_acceptance' }, branch: `learnings/${key}/api` },
        { repo: 'web', base: { branch: 'epic/x', commit: 'c'.repeat(40), attemptId: 'at_acceptance' }, branch: `learnings/${key}/web` }
      ],
      integration: null,
      publication: null
    })
  })
})

describe('the learning review integration and publication', () => {
  it("summarizes the card's newest integration with its planned heads, never the plan's paths or identity tokens", () => {
    const ctx = createTestCtx({ role: 'desktop' })
    const { cardId } = linkCard(ctx)
    const conflictManifest = integrationManifest({ cardId, targets: [{ repository: 'api', branch: 'main', baseCommit: BASE, resultCommit: null, state: 'conflicted' }] })
    insertIntegration(ctx, { n: 1, state: 'conflicted', manifest: conflictManifest, failure: JSON.stringify({ code: 'conflicted', message: 'api: README.md' }) })
    expect(getKanbanCard(ctx, { cardId }).learning?.integration).toMatchObject({
      state: 'conflicted',
      failure: { code: 'conflicted', message: 'api: README.md' },
      targets: [{ repository: 'api', state: 'conflicted', oldHead: null, newHead: null }]
    })
    const manifest = integrationManifest({
      cardId,
      targets: [
        { repository: 'api', branch: 'main', baseCommit: BASE, resultCommit: NEW_HEAD, state: 'integrated' },
        { repository: 'web', branch: 'main', baseCommit: BASE, resultCommit: null, state: 'integrating' }
      ]
    })
    const operationId = insertIntegration(ctx, { n: 2, state: 'integrating', manifest })
    storePlan(ctx, operationId, cardId)
    const view = getKanbanCard(ctx, { cardId })
    expect(view.learning?.integration).toEqual({
      operationId,
      state: 'integrating',
      failure: null,
      targets: [
        { repository: 'api', branch: 'main', baseCommit: BASE, oldHead: OLD_HEAD, newHead: NEW_HEAD, state: 'integrated' },
        { repository: 'web', branch: 'main', baseCommit: BASE, oldHead: OLD_HEAD, newHead: null, state: 'integrating' }
      ]
    })
    const text = JSON.stringify(view)
    expect(text).not.toContain(IDENTITY_TOKEN)
    expect(text).not.toContain('C:/secret')
    expect(text).not.toContain('learning-prep')
  })
})

describe('the learning review publication', () => {
  it('reports the publication once the approved drafts are active records', () => {
    const ctx = createTestCtx({ role: 'desktop' })
    const { cardId } = linkCard(ctx)
    ctx.db.run(
      `INSERT INTO learning_publications (attempt_id, card_id, run_id, sprint_id, drafts_hash, evidence_json, record_ids_json,
         published_by_role, published_by_label, published_at)
       VALUES (?, ?, ?, ?, ?, '[]', ?, 'desktop', 'Ada', ?)`,
      LEARNING_SOURCE.attemptId,
      cardId,
      LEARNING_SOURCE.runId,
      LEARNING_SOURCE.sprintId,
      `sha256:${'d'.repeat(64)}`,
      JSON.stringify(['lr_one']),
      ctx.clock.nowIso()
    )
    expect(getKanbanCard(ctx, { cardId }).learning?.publication).toEqual({
      attemptId: LEARNING_SOURCE.attemptId,
      draftsHash: `sha256:${'d'.repeat(64)}`,
      recordIds: ['lr_one'],
      publishedAt: ctx.clock.nowIso()
    })
  })
})

describe('the integration provenance of a published learning', () => {
  it('is absent until the source card has a published integration', () => {
    const ctx = createTestCtx({ role: 'desktop' })
    const learningId = publishLearning(ctx, 1)
    insertIntegration(ctx, { n: 1, state: 'integrating', manifest: integrationManifest() })
    expect(getLearning(ctx, { learningId }).learning).not.toHaveProperty('integration')
  })

  it("carries the source card's published integration, and a successor keeps it", () => {
    const ctx = createTestCtx({ role: 'desktop' })
    const learningId = publishLearning(ctx, 1)
    insertIntegration(ctx, { n: 1, state: 'aborted', manifest: integrationManifest({ targets: [{ repository: 'api', branch: 'main', baseCommit: BASE, resultCommit: null, state: 'pending' }] }) })
    const published = integrationManifest({
      targets: [
        { repository: 'api', branch: 'main', baseCommit: BASE, resultCommit: NEW_HEAD, state: 'integrated' },
        { repository: 'web', branch: 'main', baseCommit: BASE, resultCommit: '4'.repeat(40), state: 'integrated' }
      ]
    })
    const operationId = insertIntegration(ctx, { n: 2, state: 'published', manifest: published })
    const expected = {
      operationId,
      state: 'published',
      failure: null,
      targets: [
        { repository: 'api', branch: 'main', baseCommit: BASE, oldHead: null, newHead: NEW_HEAD, state: 'integrated' },
        { repository: 'web', branch: 'main', baseCommit: BASE, oldHead: null, newHead: '4'.repeat(40), state: 'integrated' }
      ]
    }
    expect(getLearning(ctx, { learningId }).learning.integration).toEqual(expected)
    const { title, rule, check, applicability } = getLearning(ctx, { learningId }).learning
    const result = replaceLearning(ctx, { learningId, expectedRevision: 1, reason: 'Sharper wording', replacement: { title, rule: `${rule} Always.`, check, applicability } })
    expect(getLearning(ctx, { learningId: result.replacement.id }).learning.integration).toEqual(expected)
    expect(listLearnings(ctx, { state: 'all' }).map((learning) => learning.integration)).toEqual([expected, expected])
  })
})
