/**
 * DM-956: the core steps of one human approval of a sprint learning card, driven by main's coordinator
 * (`src/main/kanban/approveLearningCard.ts`) around the native integration (`src/main/git/learningApply.ts`).
 *
 * After `prepareLearningIntegration`, each step re-checks this machine's authority over the integration
 * (`requireLocalIntegrationAuthority`) before it changes anything: storing the exact native plan as the integration
 * moves to `integrating`, recording each repository's receipt, recording a conflict, and finishing. The plan names
 * absolute checkouts and each repository's owned identity token, so it is kept machine-locally in the `meta` table
 * (never flushed, exported or imported) under `learning_integration_plan:<li>`, in the same transaction as the state
 * change, and deleted once the integration is published or conflicts. The portable manifest records only each
 * target's state and result commit. Finishing approves the card to Done, publishes the approved drafts and marks the
 * integration published in one transaction, so a failure leaves the card Ready for review with nothing published.
 */
import type { KanbanCardView, LearningSubmissionEvidence, VerifiedLearningManifest } from '../../shared/domain/kanban'
import { type LearningIntegrationManifest, learningIntegrationFailureSchema } from '../../shared/domain/learnings'
import type { LearningIntegrationConflict, LearningIntegrationPlan, LearningIntegrationReceipt } from '../../shared/git/learningIntegration'
import { requireCapability } from '../authz'
import { contentHash } from '../canonical'
import type { Ctx } from '../context'
import { parseJson } from '../db/database'
import { fail } from '../errors'
import { approveKanbanCard } from './kanban/attempts'
import { cardView, loadSummaryRow, recordCardEvent } from './kanban/cards'
import { requireLocalIntegrationAuthority } from './learningIntegrations'
import { publishApprovedLearningDrafts } from './learningPublication'
import { enqueueOutbox } from './outbox'

/** Where one approval stands, as main's coordinator continues it: the manifests to apply and the stored plan, if any. */
export interface LearningApprovalState {
  integrationId: string
  cardId: string
  attemptId: string
  state: string
  /** The exact staged drafts the person approved. */
  draftsHash: string
  /** Each affected repository and its target branch, in manifest order. */
  targets: { repository: string | null; branch: string }[]
  /** The approved attempt's verified manifests (`evidence.learning.manifests`). */
  manifests: VerifiedLearningManifest[]
  /** The exact native plan stored when the integration started; null before that. */
  plan: LearningIntegrationPlan | null
}

const REVIEW = 'Only the person approving a learning card integrates and publishes it.'
const planKey = (integrationId: string): string => `learning_integration_plan:${integrationId}`

/** The stored native plan of an integration, or null. */
function storedPlan(ctx: Ctx, integrationId: string): LearningIntegrationPlan | null {
  const row = ctx.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', planKey(integrationId))
  return row === undefined ? null : (JSON.parse(row.value) as LearningIntegrationPlan)
}

function submittedManifests(ctx: Ctx, attemptId: string): VerifiedLearningManifest[] {
  const row = ctx.db.get<{ evidence_json: string | null }>('SELECT evidence_json FROM kanban_attempts WHERE id = ?', attemptId)
  return parseJson<{ learning?: LearningSubmissionEvidence }>(row?.evidence_json, {}).learning?.manifests ?? []
}

/**
 * The approval's current state: a published integration, or an open one this machine may execute
 * (`requireLocalIntegrationAuthority`; an imported, foreign or closed one is refused).
 */
export function learningApprovalState(ctx: Ctx, integrationId: string): LearningApprovalState {
  const row =
    ctx.db.get<{ state: string; manifest_json: string }>('SELECT state, manifest_json FROM learning_integrations WHERE id = ?', integrationId) ??
    fail('not_found', `Learning integration ${integrationId} does not exist.`, { integrationId })
  const manifest = row.state === 'published' ? (JSON.parse(row.manifest_json) as LearningIntegrationManifest) : requireLocalIntegrationAuthority(ctx, integrationId).manifest
  return {
    integrationId,
    cardId: manifest.cardId,
    attemptId: manifest.attemptId,
    state: row.state,
    draftsHash: manifest.draftsHash,
    targets: manifest.targets.map(({ repository, branch }) => ({ repository, branch })),
    manifests: submittedManifests(ctx, manifest.attemptId),
    plan: storedPlan(ctx, integrationId)
  }
}

function store(ctx: Ctx, integrationId: string, change: { state: string; manifest: LearningIntegrationManifest; failure: string | null }): void {
  ctx.db.run(
    `UPDATE learning_integrations SET state = ?, manifest_json = ?, manifest_hash = ?, failure_json = ?, revision = revision + 1, updated_at = ?
     WHERE id = ?`,
    change.state,
    JSON.stringify(change.manifest),
    contentHash(change.manifest),
    change.failure,
    ctx.clock.nowIso(),
    integrationId
  )
  enqueueOutbox(ctx, { kind: 'learning_integration', entityId: integrationId })
}

function plannedTarget(plan: LearningIntegrationPlan, repository: string | null) {
  return (
    plan.targets.find((target) => target.repository === repository) ??
    fail('conflict', `The integration plan names no target for ${repository ?? 'the root repository'}.`, { repository })
  )
}

/**
 * Before the first canonical change: stores the exact native plan machine-locally and moves the integration and every
 * target to `integrating`, in one transaction. Replaying the same plan changes nothing.
 */
export function recordLearningIntegrationPlan(ctx: Ctx, integrationId: string, plan: LearningIntegrationPlan): void {
  requireCapability(ctx.session, 'kanban.review', REVIEW)
  ctx.db.tx(() => {
    const integration = requireLocalIntegrationAuthority(ctx, integrationId)
    const stored = storedPlan(ctx, integrationId)
    if (stored !== null && contentHash(stored) === contentHash(plan)) return
    if (integration.state !== 'prepared' || stored !== null) {
      fail('invalid_state', `Learning integration ${integrationId} is ${integration.state}; its plan was already stored.`, { integrationId })
    }
    if (plan.cardId !== integration.cardId || plan.attemptId !== integration.attemptId || plan.targets.length !== integration.manifest.targets.length) {
      fail('conflict', `The plan does not match learning integration ${integrationId}.`, { integrationId })
    }
    for (const target of integration.manifest.targets) plannedTarget(plan, target.repository)
    ctx.db.run('INSERT INTO meta (key, value) VALUES (?, ?)', planKey(integrationId), JSON.stringify(plan))
    const targets = integration.manifest.targets.map((target) => ({ ...target, state: 'integrating' as const }))
    store(ctx, integrationId, { state: 'integrating', manifest: { ...integration.manifest, targets }, failure: null })
  })
}

/**
 * After one repository's canonical target moved (or was found moved): records its exact receipt before the next
 * repository starts. Once every target is integrated the integration is `integrated`. A repeated receipt changes nothing.
 */
export function recordLearningIntegrationReceipt(ctx: Ctx, integrationId: string, receipt: LearningIntegrationReceipt): void {
  requireCapability(ctx.session, 'kanban.review', REVIEW)
  ctx.db.tx(() => {
    const integration = requireLocalIntegrationAuthority(ctx, integrationId)
    const plan = storedPlan(ctx, integrationId) ?? fail('invalid_state', `Learning integration ${integrationId} has no stored plan.`, { integrationId })
    const planned = plannedTarget(plan, receipt.repository)
    if (planned.oldHead !== receipt.oldHead || planned.newHead !== receipt.newHead) {
      fail('conflict', `The receipt of ${receipt.repository ?? 'the root repository'} is not the planned transition.`, { integrationId })
    }
    const targets = integration.manifest.targets.map((target) =>
      target.repository === receipt.repository ? { ...target, state: 'integrated' as const, resultCommit: receipt.newHead } : target
    )
    const manifest = { ...integration.manifest, targets }
    if (contentHash(manifest) === integration.manifestHash) return
    const state = targets.every((target) => target.state === 'integrated') ? 'integrated' : 'integrating'
    store(ctx, integrationId, { state, manifest, failure: null })
  })
}

/** One line per conflicting repository, control characters removed so the failure stays a valid paragraph. */
function conflictMessage(conflicts: readonly LearningIntegrationConflict[]): string {
  const lines = conflicts.map((conflict) => `${conflict.repository ?? 'root repository'} (${conflict.targetRef}): ${conflict.files.join(', ') || conflict.detail}`)
  const text = `The approved guardrails conflict with their target branches, so nothing was integrated or published and the isolated learnings branches are unchanged.\n${lines.join('\n')}`
  return text.replace(/[^\P{Cc}\n]/gu, ' ').slice(0, 2000).trim()
}

/**
 * Preparation found conflicts: the integration is `conflicted` with its failure recorded, the conflicting targets
 * are marked, the card keeps waiting in Ready for review with a message saying why, and nothing is published.
 */
export function recordLearningIntegrationConflict(ctx: Ctx, integrationId: string, conflicts: readonly LearningIntegrationConflict[]): string {
  requireCapability(ctx.session, 'kanban.review', REVIEW)
  return ctx.db.tx(() => {
    const integration = requireLocalIntegrationAuthority(ctx, integrationId)
    if (integration.state !== 'prepared') {
      fail('invalid_state', `Learning integration ${integrationId} is ${integration.state}; only preparation conflicts.`, { integrationId })
    }
    const message = conflictMessage(conflicts)
    const conflicted = (repository: string | null): boolean => conflicts.some((conflict) => conflict.repository === repository)
    const targets = integration.manifest.targets.map((target) => (conflicted(target.repository) ? { ...target, state: 'conflicted' as const } : target))
    const failure = learningIntegrationFailureSchema.parse({ code: 'conflicted', message })
    store(ctx, integrationId, { state: 'conflicted', manifest: { ...integration.manifest, targets }, failure: JSON.stringify(failure) })
    ctx.db.run('DELETE FROM meta WHERE key = ?', planKey(integrationId))
    const card = loadSummaryRow(ctx, integration.cardId)
    recordCardEvent(ctx, { id: card.id, key: card.key }, { kind: 'message', payload: { body: message }, attachments: [] })
    return message
  })
}

/**
 * Every repository is integrated: approves the card to Done (unless it already is), publishes the exact approved
 * drafts once and marks the integration published, in one transaction. Returns the Done card.
 */
export function finishLearningApproval(ctx: Ctx, integrationId: string): KanbanCardView {
  requireCapability(ctx.session, 'kanban.review', REVIEW)
  return ctx.db.tx(() => {
    const integration = requireLocalIntegrationAuthority(ctx, integrationId)
    if (integration.state !== 'integrated') {
      fail('invalid_state', `Learning integration ${integrationId} is ${integration.state}; every repository must be integrated first.`, { integrationId })
    }
    const { cardId, attemptId } = integration
    if (loadSummaryRow(ctx, cardId).lane === 'ready_for_review') {
      const submitted = ctx.db.get<{ id: string }>("SELECT id FROM kanban_attempts WHERE card_id = ? AND state = 'submitted'", cardId)
      if (submitted?.id !== attemptId) fail('conflict', `Attempt ${attemptId} is no longer the submission under review.`, { attemptId })
      approveKanbanCard(ctx, { cardId })
    }
    publishApprovedLearningDrafts(ctx, { cardId, attemptId, draftsHash: integration.manifest.draftsHash })
    store(ctx, integrationId, { state: 'published', manifest: integration.manifest, failure: null })
    ctx.db.run('DELETE FROM meta WHERE key = ?', planKey(integrationId))
    return cardView(ctx, cardId)
  })
}
