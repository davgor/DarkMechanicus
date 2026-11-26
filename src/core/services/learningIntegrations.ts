/**
 * DM-950: machine-local execution authority over learning integrations (`learning_integrations`, v31/v36).
 *
 * An integration may be executed only by the machine that prepared it: `owner_machine_id` is set when this machine
 * prepares one and is never written to or read from a portable file. An imported integration is inert, and so is a
 * local one whose file another machine changed (`learningImport.ts` clears the owner). Inert integrations never run on
 * their own: every executor calls `requireLocalIntegrationAuthority` first, and desktop startup recovery reads only
 * `listLocalPendingLearningIntegrations`.
 *
 * The only way out of an inert integration is the person's explicit re-preparation at the desktop (`kanban.review`,
 * human-only, with `recover`). It validates again, from current local state, the card's accepted latest attempt, the
 * staged drafts the person approved, the submission's verified manifests and each repository's Git state (read-only),
 * then stores a new integration owned by this machine and closes the inert one as `aborted`, superseded by it, as
 * terminal evidence. Nothing of the imported state (targets' progress, result commits) is carried over.
 */
import type { LearningSubmissionEvidence } from '../../shared/domain/kanban'
import {
  LEARNING_INTEGRATION_OPEN_STATES,
  type LearningIntegrationManifest,
  learningIntegrationManifestSchema
} from '../../shared/domain/learnings'
import { requireCapability } from '../authz'
import { contentHash } from '../canonical'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { fail } from '../errors'
import { loadSummaryRow } from './kanban/cards'
import { learningLinkOf } from './kanban/learningCards'
import { verifyLearningManifests } from './learningBranches'
import { approvedAttempt, loadStaging } from './learningPublication'
import { enqueueOutbox } from './outbox'

const SUPERSEDED = 'superseded_by_local_preparation'

interface IntegrationRow {
  id: string
  card_id: string
  attempt_id: string
  state: string
  manifest_json: string
  manifest_hash: string
  failure_json: string | null
  revision: number
  created_at: string
  updated_at: string
  owner_machine_id: string | null
  superseded_by: string | null
}

/** A learning integration as this machine sees it; `local` is whether this machine may execute it. */
interface LocalLearningIntegrationView {
  id: string
  cardId: string
  attemptId: string
  state: string
  manifest: LearningIntegrationManifest
  manifestHash: string
  revision: number
  local: boolean
  supersededBy: string | null
  createdAt: string
  updatedAt: string
}

interface PrepareLearningIntegrationInput {
  cardId: string
  attemptId: string
  /** The hash of the staged drafts the person approved (`StagedLearningDraftsView.draftsHash`). */
  draftsHash: string
  /**
   * The person's explicit choice to replace an inert (imported or externally changed) open integration of the card
   * with a fresh local one. Without it an inert integration is never replaced.
   */
  recover?: boolean
}

const OPEN_STATES_SQL = LEARNING_INTEGRATION_OPEN_STATES.map((state) => `'${state}'`).join(', ')

function view(ctx: Ctx, row: IntegrationRow): LocalLearningIntegrationView {
  return {
    id: row.id,
    cardId: row.card_id,
    attemptId: row.attempt_id,
    state: row.state,
    manifest: JSON.parse(row.manifest_json) as LearningIntegrationManifest,
    manifestHash: row.manifest_hash,
    revision: row.revision,
    local: row.owner_machine_id === ctx.machineId,
    supersededBy: row.superseded_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * The open integration this machine may execute, or a refusal: an executor calls this before every step. An
 * imported integration, one another machine changed since, or one another machine prepared is inert until a person
 * re-prepares it at the desktop; a closed one, or one whose stored manifest no longer hashes to its record, never runs.
 */
export function requireLocalIntegrationAuthority(ctx: Ctx, integrationId: string): LocalLearningIntegrationView {
  const row =
    ctx.db.get<IntegrationRow>('SELECT * FROM learning_integrations WHERE id = ?', integrationId) ??
    fail('not_found', `Learning integration ${integrationId} does not exist.`, { integrationId })
  if (!(LEARNING_INTEGRATION_OPEN_STATES as readonly string[]).includes(row.state)) {
    fail('invalid_state', `Learning integration ${row.id} is ${row.state}; only an open integration runs.`, { integrationId: row.id, state: row.state })
  }
  if (row.owner_machine_id !== ctx.machineId) {
    fail(
      'approval_required',
      `Learning integration ${row.id} was not prepared on this machine (imported or changed elsewhere), so it does not run here. A person must re-prepare it at the desktop.`,
      { integrationId: row.id }
    )
  }
  if (contentHash(JSON.parse(row.manifest_json)) !== row.manifest_hash) {
    fail('conflict', `Learning integration ${row.id} no longer matches its manifest hash; it does not run.`, { integrationId: row.id })
  }
  return view(ctx, row)
}

/** Open integrations this machine prepared and may resume, oldest first: what desktop startup recovery offers. */
export function listLocalPendingLearningIntegrations(ctx: Ctx): LocalLearningIntegrationView[] {
  requireCapability(ctx.session, 'read')
  return ctx.db
    .all<IntegrationRow>(
      `SELECT * FROM learning_integrations WHERE state IN (${OPEN_STATES_SQL}) AND owner_machine_id = ? ORDER BY created_at, id`,
      ctx.machineId
    )
    .map((row) => view(ctx, row))
}

/** The submission evidence of the approved attempt: the drafts the person approved and every manifest verified. */
function submittedLearning(ctx: Ctx, input: PrepareLearningIntegrationInput): LearningSubmissionEvidence {
  const row = ctx.db.get<{ evidence_json: string | null }>('SELECT evidence_json FROM kanban_attempts WHERE id = ?', input.attemptId)
  const learning = parseJson<{ learning?: LearningSubmissionEvidence }>(row?.evidence_json, {}).learning
  if (learning === undefined || learning.draftsHash !== input.draftsHash || !learning.manifests.every((manifest) => manifest.passed)) {
    fail('conflict', `Attempt ${input.attemptId} did not submit verified manifests for the approved drafts.`, { attemptId: input.attemptId })
  }
  return learning
}

/**
 * The attempt the person is approving: the card's latest attempt, either already accepted on a Done card or (DM-956,
 * the desktop's one approval action) still submitted on a card in Ready for review, which the coordinator approves to
 * Done only after every repository is integrated. An older, superseded or unsubmitted attempt is refused.
 */
function boundAttempt(ctx: Ctx, input: PrepareLearningIntegrationInput): { id: string; card_id: string } {
  const row =
    ctx.db.get<{ id: string; card_id: string; state: string; number: number }>('SELECT id, card_id, state, number FROM kanban_attempts WHERE id = ?', input.attemptId) ??
    fail('not_found', `Kanban attempt ${input.attemptId} does not exist.`, { attemptId: input.attemptId })
  if (row.state !== 'submitted') return approvedAttempt(ctx, input)
  const card = loadSummaryRow(ctx, input.cardId)
  const latest = ctx.db.get<{ number: number }>('SELECT MAX(number) AS number FROM kanban_attempts WHERE card_id = ?', input.cardId)?.number
  if (row.card_id !== input.cardId || card.lane !== 'ready_for_review' || row.number !== latest) {
    fail('approval_required', `Attempt ${row.id} is not the submission of ${card.key} under review.`, { attemptId: row.id, lane: card.lane })
  }
  return row
}

/** Every current local fact the integration binds: approval, staged drafts, link row and submitted manifests. */
function boundSource(ctx: Ctx, input: PrepareLearningIntegrationInput) {
  const attempt = boundAttempt(ctx, input)
  const link = learningLinkOf(ctx, attempt.card_id) ?? fail('invalid_state', `Card ${attempt.card_id} is not a sprint learning card.`, { cardId: attempt.card_id })
  const staging = loadStaging(ctx, attempt.id)
  if (staging.drafts_hash !== input.draftsHash || contentHash(JSON.parse(staging.drafts_json)) !== staging.drafts_hash) {
    fail('conflict', `The staged drafts of attempt ${attempt.id} are not the drafts that were approved.`, { attemptId: attempt.id })
  }
  if (staging.run_id !== link.runId || staging.sprint_id !== link.sprintId) {
    fail('conflict', `The staged drafts of attempt ${attempt.id} name another run or sprint.`, { attemptId: attempt.id })
  }
  const learning = submittedLearning(ctx, input)
  if (learning.snapshotHash !== link.evidenceHash) {
    fail('conflict', `Attempt ${attempt.id} classified another evidence snapshot.`, { attemptId: attempt.id })
  }
  const manifests = learning.manifests.map(({ repo, base, branch, commit }) => ({ repo, base, branch, commit }))
  return { attempt, link, manifests }
}

/**
 * The card's open integration, else its published one. A replay of the same approval returns it; an inert open one
 * is handed back for replacement only with `recover`; anything else conflicts.
 */
function existingFor(ctx: Ctx, input: PrepareLearningIntegrationInput): { replay: IntegrationRow } | { inert: IntegrationRow } | undefined {
  const row = ctx.db.get<IntegrationRow>(
    `SELECT * FROM learning_integrations WHERE card_id = ? AND state IN (${OPEN_STATES_SQL}, 'published') ORDER BY state = 'published' LIMIT 1`,
    input.cardId
  )
  if (row === undefined) return undefined
  if (row.state !== 'published' && row.owner_machine_id !== ctx.machineId) {
    if (input.recover !== true) {
      fail(
        'approval_required',
        `Learning integration ${row.id} of card ${input.cardId} was imported or changed elsewhere and is inert; only the person's explicit re-preparation replaces it.`,
        { integrationId: row.id }
      )
    }
    return { inert: row }
  }
  const manifest = JSON.parse(row.manifest_json) as LearningIntegrationManifest
  if (row.attempt_id === input.attemptId && manifest.draftsHash === input.draftsHash) return { replay: row }
  return fail('conflict', `Card ${input.cardId} already has ${row.state} learning integration ${row.id} for attempt ${row.attempt_id}.`, {
    integrationId: row.id
  })
}

/** Closes the inert open integration as terminal evidence that names its local successor. */
function supersede(ctx: Ctx, row: IntegrationRow, successor: string, now: string): void {
  const failure = { code: SUPERSEDED, message: `Replaced by learning integration ${successor}, prepared again on this machine by the person.` }
  ctx.db.run(
    `UPDATE learning_integrations SET state = 'aborted', failure_json = ?, superseded_by = ?, revision = revision + 1, updated_at = ?
     WHERE id = ?`,
    JSON.stringify(failure),
    successor,
    now,
    row.id
  )
  enqueueOutbox(ctx, { kind: 'learning_integration', entityId: row.id })
  // DM-956: an aborted integration never runs again, so its machine-local native plan (if any) goes with it.
  ctx.db.run('DELETE FROM meta WHERE key = ?', `learning_integration_plan:${row.id}`)
}

/**
 * The person prepares the integration of an approved learning card at the desktop: a new integration this machine
 * owns, with every target pending at its recorded base, and its export queued. The approval, staged drafts, link row
 * and submitted manifests are read from current local state and each manifest is verified against Git again
 * (read-only). A replay returns the same integration; an inert open one is replaced only with `recover`, never by an
 * agent or an automatic caller (`kanban.review` is human-only).
 */
export async function prepareLearningIntegration(ctx: Ctx, input: PrepareLearningIntegrationInput): Promise<LocalLearningIntegrationView> {
  requireCapability(ctx.session, 'kanban.review', 'Only the person approving a learning card prepares its integration.')
  const replay = existingFor(ctx, input)
  if (replay !== undefined && 'replay' in replay) return view(ctx, replay.replay)
  const source = boundSource(ctx, input)
  const proof = await verifyLearningManifests(ctx.gitFor, { cardKey: source.link.cardKey, bases: source.link.bases, manifests: source.manifests })
  if (!proof.passed) {
    fail('conflict', `The learning manifests no longer verify: ${proof.reasons.join(' ')}`, { reasons: proof.reasons })
  }
  return ctx.db.tx(() => {
    proof.assertCurrent()
    const again = existingFor(ctx, input)
    if (again !== undefined && 'replay' in again) return view(ctx, again.replay)
    const current = boundSource(ctx, input)
    if (contentHash(current.manifests) !== proof.manifestsHash || contentHash(current.link.bases) !== contentHash(source.link.bases)) {
      fail('conflict', 'The learning card changed while its manifests were verified; prepare it again.', { cardId: input.cardId })
    }
    const manifest = learningIntegrationManifestSchema.parse({
      formatVersion: 1,
      cardId: current.attempt.card_id,
      attemptId: current.attempt.id,
      runId: current.link.runId,
      sprintId: current.link.sprintId,
      draftsHash: input.draftsHash,
      targets: current.link.bases.map((base) => ({ repository: base.repo, branch: base.branch, baseCommit: base.commit, resultCommit: null, state: 'pending' }))
    })
    const id = ctx.ids.next('learningIntegration')
    const now = ctx.clock.nowIso()
    if (again !== undefined) supersede(ctx, again.inert, id, now)
    ctx.db.run(
      `INSERT INTO learning_integrations (id, card_id, attempt_id, state, manifest_json, manifest_hash, failure_json, revision,
         created_at, updated_at, owner_machine_id, superseded_by)
       VALUES (?, ?, ?, 'prepared', ?, ?, NULL, 1, ?, ?, ?, NULL)`,
      id,
      manifest.cardId,
      manifest.attemptId,
      JSON.stringify(manifest),
      contentHash(manifest),
      now,
      now,
      ctx.machineId
    )
    enqueueOutbox(ctx, { kind: 'learning_integration', entityId: id })
    return requireLocalIntegrationAuthority(ctx, id)
  })
}
