/**
 * DM-956: the core steps of one learning approval against an in-memory store: the stored native plan, each receipt,
 * a preparation conflict and finishing. Every step refuses a request that does not match what was planned or reviewed.
 */
import { describe, expect, it } from 'vitest'
import { learningIntegrationManifestSchema } from '../../shared/domain/learnings'
import type { LearningIntegrationPlan, PlannedLearningTarget } from '../../shared/git/learningIntegration'
import { captureError } from '../../test/authoring'
import {
  claimedLearningCard,
  firstItem,
  GUARDRAIL,
  learningDraft,
  learningWorld,
  ownIntegration,
  submitLearningCard
} from '../../test/learningCardWorld'
import { createTestCtx, type TestCtx } from '../../test/testContext'
import { approveKanbanCard } from './kanban/attempts'
import { createKanbanCard, getKanbanCard, listKanbanMessages } from './kanban/cards'
import {
  finishLearningApproval,
  learningApprovalState,
  recordLearningIntegrationConflict,
  recordLearningIntegrationPlan,
  recordLearningIntegrationReceipt
} from './learningApproval'
import { listLearnings } from './learnings'
import { getStagedLearningDrafts } from './learningPublication'

const OLD = 'd'.repeat(40)
const ATTEMPT = 'ka_00000000000000000000000077'

function target(repository: string | null): PlannedLearningTarget {
  const name = repository ?? 'root'
  return {
    repository,
    checkout: `/checkouts/${name}`,
    targetRef: 'refs/heads/epic/x',
    oldHead: OLD,
    newHead: GUARDRAIL,
    outcome: 'fastForward',
    source: { branch: `learnings/DM-1/${name}`, commit: GUARDRAIL, base: OLD },
    preparedRef: `refs/darkmechanicus/learning-prep/card/${name}`,
    identity: { commonDir: `/checkouts/${name}/.git`, token: `token-${name}` }
  }
}

interface Prepared {
  ctx: TestCtx
  cardId: string
  integrationId: string
  plan: LearningIntegrationPlan
}

/** A prepared integration of an ordinary card over `repos`, and the plan that names exactly them. */
function prepared(repos: (string | null)[], state = 'prepared'): Prepared {
  const ctx = createTestCtx({ role: 'desktop' })
  const cardId = createKanbanCard(ctx, { title: 'Sprint 1 learnings', acceptanceCriteria: ['Classified'] }).id
  const integrationId = ownIntegration(ctx, { cardId, attemptId: ATTEMPT }, { state, repos })
  return { ctx, cardId, integrationId, plan: { cardId, attemptId: ATTEMPT, targets: repos.map(target) } }
}

const row = (ctx: TestCtx, id: string) =>
  ctx.db.get<{ state: string; revision: number; manifest_json: string; failure_json: string | null }>(
    'SELECT state, revision, manifest_json, failure_json FROM learning_integrations WHERE id = ?',
    id
  )

const targetStates = (ctx: TestCtx, id: string): string[] =>
  learningIntegrationManifestSchema.parse(JSON.parse(row(ctx, id)?.manifest_json ?? '{}')).targets.map((entry) => entry.state)

describe('storing the native plan', () => {
  it('stores the plan once, moves every target to integrating, and replays the same plan without a write', () => {
    const p = prepared(['api', 'web'])
    recordLearningIntegrationPlan(p.ctx, p.integrationId, p.plan)
    expect(row(p.ctx, p.integrationId)).toMatchObject({ state: 'integrating', revision: 2 })
    expect(targetStates(p.ctx, p.integrationId)).toEqual(['integrating', 'integrating'])
    expect(learningApprovalState(p.ctx, p.integrationId)).toMatchObject({ state: 'integrating', plan: p.plan, manifests: [] })
    recordLearningIntegrationPlan(p.ctx, p.integrationId, p.plan)
    expect(row(p.ctx, p.integrationId)?.revision).toBe(2)
  })

  it('refuses another plan once one is stored, and any plan for an integration that is no longer prepared', () => {
    const p = prepared([null])
    recordLearningIntegrationPlan(p.ctx, p.integrationId, p.plan)
    const other = { ...p.plan, targets: [{ ...target(null), newHead: 'e'.repeat(40) }] }
    expect(captureError(() => recordLearningIntegrationPlan(p.ctx, p.integrationId, other))).toMatchObject({
      code: 'invalid_state',
      message: `Learning integration ${p.integrationId} is integrating; its plan was already stored.`
    })
    const late = prepared([null], 'integrating')
    expect(captureError(() => recordLearningIntegrationPlan(late.ctx, late.integrationId, late.plan)).code).toBe('invalid_state')
    expect(row(late.ctx, late.integrationId)?.revision).toBe(1)
  })

  it('refuses a plan for another attempt, or one naming a repository the integration does not target', () => {
    const p = prepared([null])
    expect(captureError(() => recordLearningIntegrationPlan(p.ctx, p.integrationId, { ...p.plan, attemptId: 'ka_00000000000000000000000078' }))).toMatchObject({
      code: 'conflict',
      message: `The plan does not match learning integration ${p.integrationId}.`
    })
    expect(captureError(() => recordLearningIntegrationPlan(p.ctx, p.integrationId, { ...p.plan, targets: [target('web')] }))).toMatchObject({
      code: 'conflict',
      message: 'The integration plan names no target for the root repository.'
    })
    const named = prepared(['api'])
    expect(captureError(() => recordLearningIntegrationPlan(named.ctx, named.integrationId, { ...named.plan, targets: [target('web')] }))).toMatchObject({
      code: 'conflict',
      message: 'The integration plan names no target for api.'
    })
    expect(row(p.ctx, p.integrationId)).toMatchObject({ state: 'prepared', revision: 1 })
    expect(learningApprovalState(p.ctx, p.integrationId).plan).toBeNull()
  })
})

describe('recording receipts', () => {
  it('refuses a receipt before the plan is stored', () => {
    const p = prepared([null])
    expect(captureError(() => recordLearningIntegrationReceipt(p.ctx, p.integrationId, { repository: null, oldHead: OLD, newHead: GUARDRAIL }))).toMatchObject({
      code: 'invalid_state',
      message: `Learning integration ${p.integrationId} has no stored plan.`
    })
  })

  it('refuses a receipt that is not the planned transition, naming the root or the named repository', () => {
    const root = prepared([null])
    recordLearningIntegrationPlan(root.ctx, root.integrationId, root.plan)
    expect(captureError(() => recordLearningIntegrationReceipt(root.ctx, root.integrationId, { repository: null, oldHead: OLD, newHead: OLD }))).toMatchObject({
      code: 'conflict',
      message: 'The receipt of the root repository is not the planned transition.'
    })
    const named = prepared(['api', 'web'])
    recordLearningIntegrationPlan(named.ctx, named.integrationId, named.plan)
    expect(captureError(() => recordLearningIntegrationReceipt(named.ctx, named.integrationId, { repository: 'api', oldHead: GUARDRAIL, newHead: GUARDRAIL }))).toMatchObject({
      code: 'conflict',
      message: 'The receipt of api is not the planned transition.'
    })
    expect(targetStates(named.ctx, named.integrationId)).toEqual(['integrating', 'integrating'])
  })

  it('integrates one repository at a time, ignores a repeated receipt and ends integrated', () => {
    const p = prepared(['api', 'web'])
    recordLearningIntegrationPlan(p.ctx, p.integrationId, p.plan)
    recordLearningIntegrationReceipt(p.ctx, p.integrationId, { repository: 'api', oldHead: OLD, newHead: GUARDRAIL })
    recordLearningIntegrationReceipt(p.ctx, p.integrationId, { repository: 'api', oldHead: OLD, newHead: GUARDRAIL })
    expect(row(p.ctx, p.integrationId)).toMatchObject({ state: 'integrating', revision: 3 })
    recordLearningIntegrationReceipt(p.ctx, p.integrationId, { repository: 'web', oldHead: OLD, newHead: GUARDRAIL })
    expect(row(p.ctx, p.integrationId)).toMatchObject({ state: 'integrated', revision: 4 })
    expect(targetStates(p.ctx, p.integrationId)).toEqual(['integrated', 'integrated'])
  })
})

describe('recording a preparation conflict', () => {
  it('marks the conflicting root target, tells the card why with Git detail when no file is listed, and drops the plan', () => {
    const p = prepared([null, 'web'])
    const message = recordLearningIntegrationConflict(p.ctx, p.integrationId, [
      { repository: null, targetRef: 'refs/heads/epic/x', oldHead: OLD, sourceCommit: GUARDRAIL, files: [], detail: 'refusing to merge\u0007 unrelated histories' }
    ])
    expect(message.split('\n').slice(1)).toEqual(['root repository (refs/heads/epic/x): refusing to merge  unrelated histories'])
    expect(row(p.ctx, p.integrationId)?.state).toBe('conflicted')
    expect(JSON.parse(row(p.ctx, p.integrationId)?.failure_json ?? '{}')).toEqual({ code: 'conflicted', message })
    expect(targetStates(p.ctx, p.integrationId)).toEqual(['conflicted', 'pending'])
    expect(listKanbanMessages(p.ctx, { cardId: p.cardId }).map((entry) => entry.body)).toEqual([message])
  })

  it('refuses a conflict once integration has started', () => {
    const p = prepared(['api'])
    recordLearningIntegrationPlan(p.ctx, p.integrationId, p.plan)
    const conflict = { repository: 'api', targetRef: 'refs/heads/epic/x', oldHead: OLD, sourceCommit: GUARDRAIL, files: ['a.ts'], detail: '' }
    expect(captureError(() => recordLearningIntegrationConflict(p.ctx, p.integrationId, [conflict]))).toMatchObject({
      code: 'invalid_state',
      message: `Learning integration ${p.integrationId} is integrating; only preparation conflicts.`
    })
    expect(listKanbanMessages(p.ctx, { cardId: p.cardId })).toEqual([])
  })
})

describe('reading the approval state', () => {
  it('refuses an unknown integration', () => {
    const p = prepared([null])
    expect(captureError(() => learningApprovalState(p.ctx, 'li_000000000000000000000000zz'))).toMatchObject({
      code: 'not_found',
      message: 'Learning integration li_000000000000000000000000zz does not exist.'
    })
  })
})

describe('finishing an approval', () => {
  it('refuses to finish before every repository is integrated, and publishes nothing', () => {
    const p = prepared(['api'])
    recordLearningIntegrationPlan(p.ctx, p.integrationId, p.plan)
    expect(captureError(() => finishLearningApproval(p.ctx, p.integrationId))).toMatchObject({
      code: 'invalid_state',
      message: `Learning integration ${p.integrationId} is integrating; every repository must be integrated first.`
    })
    expect(listLearnings(p.ctx, { state: 'all' })).toEqual([])
  })

  it('refuses when the card under review now holds another submission than the one integrated', async () => {
    const w = learningWorld()
    const packet = claimedLearningCard(w)
    await submitLearningCard(w, packet, [learningDraft(firstItem(packet))])
    const integrationId = ownIntegration(w.desktop, { cardId: packet.cardId, attemptId: ATTEMPT }, { state: 'integrated', repos: [null], targetState: 'integrated' })
    expect(captureError(() => finishLearningApproval(w.desktop, integrationId))).toMatchObject({
      code: 'conflict',
      message: `Attempt ${ATTEMPT} is no longer the submission under review.`
    })
    expect(getKanbanCard(w.desktop, { cardId: packet.cardId }).lane).toBe('ready_for_review')
    expect(row(w.desktop, integrationId)?.state).toBe('integrated')
  })

  it('publishes the approved drafts of a card that is already Done without approving it again', async () => {
    const w = learningWorld()
    const packet = claimedLearningCard(w)
    await submitLearningCard(w, packet, [learningDraft(firstItem(packet))])
    approveKanbanCard(w.desktop, { cardId: packet.cardId })
    const { draftsHash } = getStagedLearningDrafts(w.desktop, { attemptId: packet.attemptId })
    const source = { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash }
    const integrationId = ownIntegration(w.desktop, source, { state: 'integrated', repos: [null], targetState: 'integrated' })
    expect(finishLearningApproval(w.desktop, integrationId).lane).toBe('done')
    expect(listLearnings(w.desktop, {}).map((learning) => learning.title)).toEqual(['Run the migration tests'])
    // Once published, the state is read from the stored manifest, with the submission's verified manifests.
    expect(learningApprovalState(w.desktop, integrationId)).toMatchObject({
      state: 'published',
      draftsHash,
      targets: [{ repository: null, branch: 'epic/x' }],
      manifests: [expect.objectContaining({ repo: null, commit: GUARDRAIL, passed: true })],
      plan: null
    })
  })
})
