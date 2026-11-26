/**
 * DM-937: the one sprint learning card a successful checkpoint advance generates. It is written inside the advancing
 * transaction, after the checkpoint row, and linked (`sprint_learning_cards`, unique per run and sprint) to the
 * epic, run, sprint, report, pinned revision, checkpoint, the exact evidence snapshot and the completed increment of
 * every affected repository. It is queued (Play pending) for the run's orchestrator and never gates the next sprint.
 */
import type { LearningEvidenceSnapshot, SprintLearningCardView } from '../../shared/domain/learnings'
import type { KanbanLane } from '../../shared/domain/kanban'
import type { SprintReportView } from '../../shared/domain/views'
import type { Ctx } from '../context'
import { parseJson, toJson } from '../db/database'
import { appendEvent } from './events'
import { insertGeneratedCard } from './kanban/cards'
import { collectLearningEvidence } from './learningEvidence'

type LearningIncrementBase = SprintLearningCardView['bases'][number]

interface LinkRow {
  card_id: string
  key: string
  epic_id: string
  run_id: string
  sprint_id: string
  report_id: string
  revision_id: string | null
  checkpoint_id: string | null
  evidence_hash: string
  snapshot_json: string | null
  bases_json: string
  created_at: string
  lane: KanbanLane
  play_requested_at: string | null
}

const LINK_SELECT = `SELECT l.*, c.key, c.lane, c.play_requested_at FROM sprint_learning_cards l JOIN kanban_cards c ON c.id = l.card_id`

function toView(row: LinkRow): SprintLearningCardView {
  const snapshot = parseJson<LearningEvidenceSnapshot | null>(row.snapshot_json, null)
  return {
    cardId: row.card_id,
    key: row.key,
    epicId: row.epic_id,
    runId: row.run_id,
    sprintId: row.sprint_id,
    reportId: row.report_id,
    revisionId: row.revision_id,
    checkpointId: row.checkpoint_id,
    evidenceHash: row.evidence_hash,
    evidenceItems: snapshot?.items.length ?? 0,
    bases: parseJson<LearningIncrementBase[]>(row.bases_json, []),
    lane: row.lane,
    playPending: row.play_requested_at !== null,
    createdAt: row.created_at
  }
}

function linkOf(ctx: Ctx, runId: string, sprintId: string): SprintLearningCardView | null {
  const row = ctx.db.get<LinkRow>(`${LINK_SELECT} WHERE l.run_id = ? AND l.sprint_id = ?`, runId, sprintId)
  return row === undefined ? null : toView(row)
}

/** The run's newest generated learning card, which the owning orchestrator claims before its next sprint; null without one. */
export function latestSprintLearningCard(ctx: Ctx, runId: string): SprintLearningCardView | null {
  const row = ctx.db.get<LinkRow>(`${LINK_SELECT} WHERE l.run_id = ? ORDER BY l.created_at DESC, c.rowid DESC LIMIT 1`, runId)
  return row === undefined ? null : toView(row)
}

/** The completed increment of every repository the report's acceptance node verified, in repository order. */
function incrementBases(report: SprintReportView): LearningIncrementBase[] {
  const views = report.increments ?? (report.increment === undefined ? [] : [report.increment])
  return views
    .filter((view) => view.increment.passed)
    .map((view) => ({ repo: view.repo ?? null, branch: view.increment.branch, commit: view.increment.commit, attemptId: view.attemptId }))
}

function cardBody(snapshot: LearningEvidenceSnapshot, bases: LearningIncrementBase[], checkpointId: string): string {
  const evidence =
    snapshot.items.length === 0
      ? 'The evidence snapshot holds no items: this sprint recorded no negative evidence. Conclude whether any reusable rule remains.'
      : `The evidence snapshot holds ${snapshot.items.length} item(s).`
  const baseLines = bases.length === 0 ? ['- none recorded'] : bases.map((base) => `- ${base.repo ?? '(repository)'}: ${base.branch} @ ${base.commit}`)
  return [
    `Codify durable learnings from sprint ${snapshot.sprintOrdinal} of run ${snapshot.runId}.`,
    '',
    evidence,
    `Snapshot: ${snapshot.contentHash} (revision ${snapshot.revisionId}, checkpoint ${checkpointId}).`,
    '',
    'Completed increment bases:',
    ...baseLines
  ].join('\n')
}

/**
 * Generates and queues the sprint's learning card unless the run and sprint already have one, which is returned
 * unchanged: a replay or an alternate advance path never writes a second card, Play or event. Call it only inside the
 * advancing transaction, after the checkpoint is recorded, so a failed advance leaves nothing behind.
 */
export function generateSprintLearningCard(
  ctx: Ctx,
  input: { epicId: string; runId: string; sprintId: string; report: SprintReportView; checkpointId: string }
): SprintLearningCardView {
  const existing = linkOf(ctx, input.runId, input.sprintId)
  if (existing !== null) {
    return existing
  }
  const snapshot = collectLearningEvidence(ctx, { runId: input.runId, sprintId: input.sprintId })
  const bases = incrementBases(input.report)
  const card = insertGeneratedCard(ctx, {
    title: `Sprint ${snapshot.sprintOrdinal} learnings`,
    body: cardBody(snapshot, bases, input.checkpointId),
    acceptanceCriteria: [
      { id: 'c1', text: 'Each snapshot item is classified, and only reusable rules backed by cited evidence are staged as learning drafts.' }
    ],
    priority: 'high'
  })
  ctx.db.run(
    `INSERT INTO sprint_learning_cards (card_id, epic_id, run_id, sprint_id, report_id, evidence_hash, created_at,
       checkpoint_id, revision_id, snapshot_json, bases_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    card.id,
    input.epicId,
    input.runId,
    input.sprintId,
    input.report.id,
    snapshot.contentHash,
    ctx.clock.nowIso(),
    input.checkpointId,
    snapshot.revisionId,
    toJson(snapshot),
    toJson(bases)
  )
  appendEvent(ctx, {
    kind: 'sprint.learning_card_queued',
    epicId: input.epicId,
    runId: input.runId,
    payload: { cardId: card.id, key: card.key, sprintId: input.sprintId, checkpointId: input.checkpointId, evidenceHash: snapshot.contentHash }
  })
  return linkOf(ctx, input.runId, input.sprintId) as SprintLearningCardView
}
