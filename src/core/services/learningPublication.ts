/**
 * Staging and publication of a sprint learning card's proposed learnings (`src/shared/domain/learnings.ts`).
 *
 * The agent holding the card's attempt stages what it proposes: drafts whose every evidence reference names an item
 * of the card's own run and sprint snapshot (`collectLearningEvidence`) by kind, source id and exact content hash.
 * The cited items are stored verbatim with the drafts, so the evidence a person reviews is the evidence published.
 * Staging grants nothing: no draft becomes guidance until the approved-card flow publishes it.
 *
 * Publication is internal: the person's approval of the card (`kanban.review`, human-only) supplies the attempt and
 * the hash of the drafts that were reviewed. It publishes exactly those staged drafts of the card's accepted, latest
 * attempt, after checking every cited item still matches the stored evidence. Each record gets its first `published`
 * history entry. Publishing the same attempt again returns the first result and writes nothing; an empty draft list
 * is a valid no-learning publication. No agent-facing command reaches either function's authority: staging is an
 * agent's proposal, publication the person's approval.
 */
import { z } from 'zod'
import {
  type LearningDraft,
  learningDraftSchema,
  type LearningEvidenceItem,
  type LearningEvidenceSnapshot,
  type LearningView,
  type StagedLearningDraftsView
} from '../../shared/domain/learnings'
import { requireCapability } from '../authz'
import { contentHash } from '../canonical'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { verifyClaimToken } from './attempts'
import { type AttemptRow, loadSummaryRow } from './kanban/cards'
import { collectLearningEvidence } from './learningEvidence'
import { appendHistory as appendLearningHistory, loadRow as loadLearningRow, retireRow as retireLearningRow, toLearningView } from './learnings'

/** Drafts one card may propose. */
const MAX_DRAFTS = 20

const EXPIRED_CLAIM = 'The claim lease expired; the staged learnings were not changed.'

const stagedDraftsSchema = z.array(learningDraftSchema).max(MAX_DRAFTS)

interface ClaimRow extends AttemptRow {
  claim_secret: string
}

interface LearningCardRow {
  card_id: string
  run_id: string
  sprint_id: string
}

interface StagingRow {
  attempt_id: string
  card_id: string
  run_id: string
  sprint_id: string
  snapshot_hash: string
  drafts_json: string
  drafts_hash: string
  evidence_json: string
  staged_by_role: string
  staged_by_label: string
  staged_at: string
}

interface PublicationRow {
  attempt_id: string
  card_id: string
  run_id: string
  sprint_id: string
  drafts_hash: string
  evidence_json: string
  record_ids_json: string
  published_by_role: string
  published_by_label: string
  published_at: string
}

interface StageLearningDraftsInput {
  attemptId: string
  claimToken: string
  drafts: LearningDraft[]
}

interface PublishApprovedLearningDraftsInput {
  cardId: string
  attemptId: string
  /** The hash of the staged drafts the person approved (`StagedLearningDraftsView.draftsHash`). */
  draftsHash: string
}

export interface LearningPublicationView {
  cardId: string
  attemptId: string
  runId: string
  sprintId: string
  draftsHash: string
  /** The cited evidence items as stored when the drafts were staged. */
  evidence: LearningEvidenceItem[]
  records: LearningView[]
  publishedBy: { role: string; label: string }
  publishedAt: string
}

function loadAttempt(ctx: Ctx, attemptId: string): ClaimRow {
  return (
    ctx.db.get<ClaimRow>('SELECT * FROM kanban_attempts WHERE id = ?', attemptId) ??
    fail('not_found', `Kanban attempt ${attemptId} does not exist.`, { attemptId })
  )
}

function latestNumber(ctx: Ctx, cardId: string): number {
  return ctx.db.get<{ number: number }>('SELECT MAX(number) AS number FROM kanban_attempts WHERE card_id = ?', cardId)?.number ?? 0
}

/** The run and sprint a generated sprint learning card was made for; any other card has no learnings to stage. */
function learningCard(ctx: Ctx, cardId: string): LearningCardRow {
  return (
    ctx.db.get<LearningCardRow>('SELECT card_id, run_id, sprint_id FROM sprint_learning_cards WHERE card_id = ?', cardId) ??
    fail('invalid_state', `Card ${cardId} is not a sprint learning card.`, { cardId })
  )
}

const itemKey = (kind: string, sourceId: string): string => `${kind}\u0000${sourceId}`

/**
 * The snapshot items the drafts cite, in first-cited order, each checked against the card's own run and sprint:
 * an id the snapshot does not hold (another run's or sprint's item, a comment, an attachment) or a hash that differs
 * from the stored evidence is refused.
 */
function citedEvidence(snapshot: LearningEvidenceSnapshot, drafts: readonly LearningDraft[]): LearningEvidenceItem[] {
  const byKey = new Map(snapshot.items.map((item) => [itemKey(item.kind, item.sourceId), item]))
  const cited = new Map<string, LearningEvidenceItem>()
  for (const draft of drafts) {
    for (const ref of draft.evidence) {
      const key = itemKey(ref.kind, ref.sourceId)
      const item =
        byKey.get(key) ??
        fail('invalid_input', `Evidence ${ref.kind} ${ref.sourceId} is not part of sprint ${snapshot.sprintId} of run ${snapshot.runId}.`, {
          kind: ref.kind,
          sourceId: ref.sourceId
        })
      if (item.contentHash !== ref.contentHash) {
        fail('conflict', `Evidence ${ref.kind} ${ref.sourceId} does not match the stored evidence hash.`, {
          kind: ref.kind,
          sourceId: ref.sourceId,
          cited: ref.contentHash,
          stored: item.contentHash
        })
      }
      cited.set(key, item)
    }
  }
  return [...cited.values()]
}

/** A replacement must name an active learning, and no two drafts may replace the same one. */
function checkReplacements(ctx: Ctx, drafts: readonly LearningDraft[]): void {
  const seen = new Set<string>()
  for (const { replaces } of drafts) {
    if (replaces === null) continue
    if (seen.has(replaces)) fail('invalid_input', `Two drafts replace learning ${replaces}.`, { learningId: replaces })
    seen.add(replaces)
    if (loadLearningRow(ctx.db, replaces).state !== 'active') {
      fail('invalid_state', `Learning ${replaces} is already retired.`, { learningId: replaces })
    }
  }
}

function parseDrafts(drafts: unknown): LearningDraft[] {
  const parsed = stagedDraftsSchema.safeParse(drafts)
  if (!parsed.success) {
    fail('invalid_input', `Invalid learning drafts: ${parsed.error.issues[0]?.message ?? 'malformed drafts'}`)
  }
  return parsed.data
}

function stagingView(row: StagingRow): StagedLearningDraftsView {
  return {
    cardId: row.card_id,
    attemptId: row.attempt_id,
    runId: row.run_id,
    sprintId: row.sprint_id,
    snapshotHash: row.snapshot_hash,
    drafts: JSON.parse(row.drafts_json) as LearningDraft[],
    draftsHash: row.drafts_hash,
    evidence: JSON.parse(row.evidence_json) as LearningEvidenceItem[],
    stagedBy: { role: row.staged_by_role, label: row.staged_by_label },
    stagedAt: row.staged_at
  }
}

/**
 * The agent holding a sprint learning card's attempt stages (or restages) its proposed drafts. Every cited evidence
 * item must be in the card's run and sprint snapshot with the exact stored hash. An empty list proposes no learning.
 */
export function stageLearningDrafts(ctx: Ctx, input: StageLearningDraftsInput): StagedLearningDraftsView {
  requireCapability(ctx.session, 'kanban.report')
  const drafts = parseDrafts(input.drafts)
  return ctx.db.tx(() => {
    const attempt = loadAttempt(ctx, input.attemptId)
    if (attempt.machine_id !== null && attempt.machine_id !== ctx.machineId) {
      fail('card_not_owned', `Attempt ${attempt.id} was claimed on another computer; only that computer reports on it.`, { attemptId: attempt.id })
    }
    const superseded = attempt.number < latestNumber(ctx, attempt.card_id)
    verifyClaimToken({ id: attempt.id, claimSecret: attempt.claim_secret, state: attempt.state, superseded }, input.claimToken, EXPIRED_CLAIM)
    const card = learningCard(ctx, attempt.card_id)
    const snapshot = collectLearningEvidence(ctx, { runId: card.run_id, sprintId: card.sprint_id })
    const evidence = citedEvidence(snapshot, drafts)
    checkReplacements(ctx, drafts)
    ctx.db.run(
      `INSERT INTO learning_stagings (attempt_id, card_id, run_id, sprint_id, snapshot_hash, drafts_json, drafts_hash,
         evidence_json, staged_by_role, staged_by_label, staged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (attempt_id) DO UPDATE SET snapshot_hash = excluded.snapshot_hash, drafts_json = excluded.drafts_json,
         drafts_hash = excluded.drafts_hash, evidence_json = excluded.evidence_json, staged_by_role = excluded.staged_by_role,
         staged_by_label = excluded.staged_by_label, staged_at = excluded.staged_at`,
      attempt.id,
      card.card_id,
      card.run_id,
      card.sprint_id,
      snapshot.contentHash,
      JSON.stringify(drafts),
      contentHash(drafts),
      JSON.stringify(evidence),
      ctx.session.role,
      ctx.session.label,
      ctx.clock.nowIso()
    )
    return stagingView(loadStaging(ctx, attempt.id))
  })
}

export function loadStaging(ctx: Ctx, attemptId: string): StagingRow {
  return (
    ctx.db.get<StagingRow>('SELECT * FROM learning_stagings WHERE attempt_id = ?', attemptId) ??
    fail('invalid_state', `Attempt ${attemptId} staged no learning drafts.`, { attemptId })
  )
}

/** What an agent staged for an attempt; every role reads it. */
export function getStagedLearningDrafts(ctx: Ctx, input: { attemptId: string }): StagedLearningDraftsView {
  requireCapability(ctx.session, 'read')
  return stagingView(loadStaging(ctx, input.attemptId))
}

function publicationView(ctx: Ctx, row: PublicationRow): LearningPublicationView {
  const recordIds = JSON.parse(row.record_ids_json) as string[]
  return {
    cardId: row.card_id,
    attemptId: row.attempt_id,
    runId: row.run_id,
    sprintId: row.sprint_id,
    draftsHash: row.drafts_hash,
    evidence: JSON.parse(row.evidence_json) as LearningEvidenceItem[],
    records: recordIds.map((id) => toLearningView(loadLearningRow(ctx.db, id))),
    publishedBy: { role: row.published_by_role, label: row.published_by_label },
    publishedAt: row.published_at
  }
}

/** The publication of an attempt, if any; a replay of the same approval returns it, anything else conflicts. */
function existingPublication(ctx: Ctx, input: PublishApprovedLearningDraftsInput): PublicationRow | undefined {
  const row =
    ctx.db.get<PublicationRow>('SELECT * FROM learning_publications WHERE attempt_id = ?', input.attemptId) ??
    ctx.db.get<PublicationRow>('SELECT * FROM learning_publications WHERE card_id = ?', input.cardId)
  if (row === undefined) return undefined
  if (row.attempt_id !== input.attemptId || row.card_id !== input.cardId || row.drafts_hash !== input.draftsHash) {
    fail('conflict', `Card ${row.card_id} already published the learnings of attempt ${row.attempt_id}.`, {
      cardId: row.card_id,
      attemptId: row.attempt_id,
      draftsHash: row.drafts_hash
    })
  }
  return row
}

/** The card's accepted, latest attempt, approved in Done: anything else is not an approved card. */
export function approvedAttempt(ctx: Ctx, input: PublishApprovedLearningDraftsInput): ClaimRow {
  const attempt = loadAttempt(ctx, input.attemptId)
  if (attempt.card_id !== input.cardId) {
    fail('invalid_input', `Attempt ${attempt.id} belongs to card ${attempt.card_id}, not ${input.cardId}.`, { attemptId: attempt.id, cardId: input.cardId })
  }
  const card = loadSummaryRow(ctx, input.cardId)
  if (attempt.state !== 'accepted' || card.lane !== 'done') {
    fail('approval_required', `Attempt ${attempt.id} of ${card.key} is not approved; only an approved learning card publishes.`, {
      attemptId: attempt.id,
      state: attempt.state,
      lane: card.lane
    })
  }
  if (attempt.number < latestNumber(ctx, input.cardId)) {
    fail('stale_claim', `Attempt ${attempt.id} is not the latest attempt of ${card.key}.`, { attemptId: attempt.id })
  }
  return attempt
}

interface PublishScope {
  card: LearningCardRow
  attemptId: string
  cardKey: string
}

function insertRecord(ctx: Ctx, scope: PublishScope, draft: LearningDraft): string {
  const id = ctx.ids.next('learningRecord')
  ctx.db.run(
    `INSERT INTO learning_records (id, run_id, sprint_id, card_id, attempt_id, definition_json, definition_hash, state,
       replaces_id, replaced_by_id, created_at, retired_at, retired_reason, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL, ?, NULL, NULL, 1)`,
    id,
    scope.card.run_id,
    scope.card.sprint_id,
    scope.card.card_id,
    scope.attemptId,
    JSON.stringify(draft),
    contentHash(draft),
    draft.replaces,
    ctx.clock.nowIso()
  )
  const reason = `Published from approved learning card ${scope.cardKey}`
  appendLearningHistory(ctx, { learning: loadLearningRow(ctx.db, id), kind: 'published', relatedId: null, reason, revision: 1 })
  if (draft.replaces !== null) {
    const predecessor = loadLearningRow(ctx.db, draft.replaces)
    if (predecessor.state !== 'active') {
      fail('invalid_state', `Learning ${predecessor.id} is already retired.`, { learningId: predecessor.id })
    }
    const why = `Replaced by a learning of approved learning card ${scope.cardKey}`
    retireLearningRow(ctx, predecessor, why, id)
    appendLearningHistory(ctx, { learning: predecessor, kind: 'replaced', relatedId: id, reason: why, revision: predecessor.revision + 1 })
  }
  return id
}

/**
 * Publishes the exact staged drafts of a sprint learning card's approved attempt: internal to the approved-card flow
 * (human-only `kanban.review`). The staged drafts must hash to `draftsHash`, and every cited item must still match the
 * stored evidence of the card's run and sprint. Replaying the same approval returns the first publication unchanged.
 */
export function publishApprovedLearningDrafts(ctx: Ctx, input: PublishApprovedLearningDraftsInput): LearningPublicationView {
  requireCapability(ctx.session, 'kanban.review', 'Only the person approving a learning card publishes its learnings.')
  return ctx.db.tx(() => {
    const existing = existingPublication(ctx, input)
    if (existing !== undefined) return publicationView(ctx, existing)
    const attempt = approvedAttempt(ctx, input)
    const card = learningCard(ctx, attempt.card_id)
    const staging = loadStaging(ctx, attempt.id)
    const drafts = parseDrafts(JSON.parse(staging.drafts_json))
    if (staging.drafts_hash !== input.draftsHash || contentHash(drafts) !== staging.drafts_hash) {
      fail('conflict', `The staged drafts of attempt ${attempt.id} are not the drafts that were approved.`, {
        attemptId: attempt.id,
        staged: staging.drafts_hash,
        approved: input.draftsHash
      })
    }
    if (staging.card_id !== card.card_id || staging.run_id !== card.run_id || staging.sprint_id !== card.sprint_id) {
      fail('conflict', `The staged drafts of attempt ${attempt.id} name another card, run or sprint.`, { attemptId: attempt.id })
    }
    const snapshot = collectLearningEvidence(ctx, { runId: card.run_id, sprintId: card.sprint_id })
    const evidence = citedEvidence(snapshot, drafts)
    if (contentHash(evidence) !== contentHash(JSON.parse(staging.evidence_json))) {
      fail('conflict', `The evidence cited by attempt ${attempt.id} changed after it was staged.`, { attemptId: attempt.id })
    }
    checkReplacements(ctx, drafts)
    const scope: PublishScope = { card, attemptId: attempt.id, cardKey: loadSummaryRow(ctx, card.card_id).key }
    const recordIds = drafts.map((draft) => insertRecord(ctx, scope, draft))
    ctx.db.run(
      `INSERT INTO learning_publications (attempt_id, card_id, run_id, sprint_id, drafts_hash, evidence_json, record_ids_json,
         published_by_role, published_by_label, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      attempt.id,
      card.card_id,
      card.run_id,
      card.sprint_id,
      staging.drafts_hash,
      staging.evidence_json,
      JSON.stringify(recordIds),
      ctx.session.role,
      ctx.session.label,
      ctx.clock.nowIso()
    )
    return publicationView(ctx, existingPublication(ctx, input) ?? fail('internal', 'The publication was not stored.'))
  })
}
