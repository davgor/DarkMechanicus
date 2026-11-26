/**
 * DM-943: what a person reviewing a sprint learning card, or a published learning, reads about where it came from and
 * how far its integration got. Read-only: no schema change and no authority. Integration summaries are built from the
 * portable manifest (`learning_integrations`); the machine-local native plan contributes only each target's planned
 * old and new heads, never its checkout paths or repository identity tokens.
 */
import type { KanbanLearningReviewView } from '../../shared/domain/kanban'
import type {
  LearningEvidenceSnapshot,
  LearningIntegrationManifest,
  LearningIntegrationSummaryView,
  LearningView,
  SprintLearningCardView
} from '../../shared/domain/learnings'
import type { LearningIntegrationPlan } from '../../shared/git/learningIntegration'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { learningBranchName } from './learningBranches'

type LearningIncrementBase = SprintLearningCardView['bases'][number]

interface IntegrationRow {
  id: string
  state: LearningIntegrationSummaryView['state']
  manifest_json: string
  failure_json: string | null
}

interface LinkRow {
  key: string
  run_id: string
  sprint_id: string
  report_id: string
  revision_id: string | null
  checkpoint_id: string | null
  evidence_hash: string
  snapshot_json: string | null
  bases_json: string
}

interface PublicationRow {
  attempt_id: string
  drafts_hash: string
  record_ids_json: string
  published_at: string
}

/** The planned heads of each repository while this machine still holds the plan; nothing else of the plan. */
function plannedHeads(ctx: Ctx, integrationId: string): Map<string, { oldHead: string; newHead: string }> {
  const row = ctx.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', `learning_integration_plan:${integrationId}`)
  const plan = parseJson<LearningIntegrationPlan | null>(row?.value, null)
  return new Map((plan?.targets ?? []).map((target) => [target.repository ?? '', { oldHead: target.oldHead, newHead: target.newHead }]))
}

function summaryOf(ctx: Ctx, row: IntegrationRow): LearningIntegrationSummaryView {
  const manifest = JSON.parse(row.manifest_json) as LearningIntegrationManifest
  const heads = plannedHeads(ctx, row.id)
  return {
    operationId: row.id,
    state: row.state,
    failure: parseJson<{ code: string; message: string } | null>(row.failure_json, null),
    targets: manifest.targets.map((target) => {
      const planned = heads.get(target.repository ?? '')
      return {
        repository: target.repository,
        branch: target.branch,
        baseCommit: target.baseCommit,
        oldHead: planned?.oldHead ?? null,
        newHead: target.resultCommit ?? null,
        state: target.state
      }
    })
  }
}

/** The card's newest integration operation, whatever its state; null when none was started on this clone. */
function latestIntegration(ctx: Ctx, cardId: string): LearningIntegrationSummaryView | null {
  const row = ctx.db.get<IntegrationRow>(
    'SELECT id, state, manifest_json, failure_json FROM learning_integrations WHERE card_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    cardId
  )
  return row === undefined ? null : summaryOf(ctx, row)
}

/** The card's published integration: the one that made its learnings active. */
function publishedIntegration(ctx: Ctx, cardId: string): LearningIntegrationSummaryView | null {
  const row = ctx.db.get<IntegrationRow>(
    "SELECT id, state, manifest_json, failure_json FROM learning_integrations WHERE card_id = ? AND state = 'published' ORDER BY created_at DESC, rowid DESC LIMIT 1",
    cardId
  )
  return row === undefined ? null : summaryOf(ctx, row)
}

/**
 * The review section of a sprint learning card: its immutable link (provenance, snapshot, isolated branches), its
 * newest integration and its publication. Null for an ordinary card, whose view never carries the section.
 */
export function learningReviewOf(ctx: Ctx, cardId: string): KanbanLearningReviewView | null {
  const link = ctx.db.get<LinkRow>(
    `SELECT c.key, l.run_id, l.sprint_id, l.report_id, l.revision_id, l.checkpoint_id, l.evidence_hash, l.snapshot_json, l.bases_json
     FROM sprint_learning_cards l JOIN kanban_cards c ON c.id = l.card_id WHERE l.card_id = ?`,
    cardId
  )
  if (link === undefined) return null
  const publication = ctx.db.get<PublicationRow>(
    'SELECT attempt_id, drafts_hash, record_ids_json, published_at FROM learning_publications WHERE card_id = ?',
    cardId
  )
  return {
    runId: link.run_id,
    sprintId: link.sprint_id,
    reportId: link.report_id,
    revisionId: link.revision_id,
    checkpointId: link.checkpoint_id,
    evidenceHash: link.evidence_hash,
    snapshot: parseJson<LearningEvidenceSnapshot | null>(link.snapshot_json, null),
    branches: parseJson<LearningIncrementBase[]>(link.bases_json, []).map((base) => ({
      repo: base.repo,
      base: { branch: base.branch, commit: base.commit, attemptId: base.attemptId },
      branch: learningBranchName(link.key, base.repo)
    })),
    integration: latestIntegration(ctx, cardId),
    publication:
      publication === undefined
        ? null
        : {
            attemptId: publication.attempt_id,
            draftsHash: publication.drafts_hash,
            recordIds: parseJson<string[]>(publication.record_ids_json, []),
            publishedAt: publication.published_at
          }
  }
}

/** A learning with its source card's published integration, when this clone holds one; successors share the source. */
export function withIntegration(ctx: Ctx, learning: LearningView): LearningView {
  const integration = publishedIntegration(ctx, learning.source.cardId)
  return integration === null ? learning : { ...learning, integration }
}
