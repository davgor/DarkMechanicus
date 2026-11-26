/**
 * DM-950: preparation binds the exact approval it was asked for. A submission, staging or link row that no longer
 * agrees, a card that changed while Git verified it, or another integration of the card is refused; two concurrent
 * preparations of the same approval store one integration. In memory, over a stub Git that proves every manifest.
 */
import { describe, expect, it } from 'vitest'
import type { KanbanPacket } from '../../shared/domain/kanban'
import { claimedLearningCard, firstItem, guardrailGit, learningDraft, learningWorld, type LearningWorld, submitLearningCard } from '../../test/learningCardWorld'
import type { TestCtx } from '../../test/testContext'
import { DomainError } from '../errors'
import { approveKanbanCard } from './kanban/attempts'
import { prepareLearningIntegration } from './learningIntegrations'
import { getStagedLearningDrafts } from './learningPublication'

interface Approved {
  w: LearningWorld
  packet: KanbanPacket
  draftsHash: string
}

/** A submitted learning card, approved to Done unless `approve` is false. */
async function approvedCard(approve = true): Promise<Approved> {
  const w = learningWorld()
  const packet = claimedLearningCard(w)
  await submitLearningCard(w, packet, [learningDraft(firstItem(packet))])
  if (approve) approveKanbanCard(w.desktop, { cardId: packet.cardId })
  return { w, packet, draftsHash: getStagedLearningDrafts(w.desktop, { attemptId: packet.attemptId }).draftsHash }
}

async function refusal(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  const error = await promise.then(() => null, (caught: unknown) => caught)
  if (error instanceof DomainError) return { code: error.code, message: error.message }
  throw new Error(`Expected a refusal, got ${String(error)}`)
}

const prepare = (ctx: TestCtx, a: Approved) => prepareLearningIntegration(ctx, { cardId: a.packet.cardId, attemptId: a.packet.attemptId, draftsHash: a.draftsHash })

const integrations = (ctx: TestCtx) => ctx.db.all<{ id: string; state: string }>('SELECT id, state FROM learning_integrations ORDER BY id')

/** Rewrites the `learning` block of the attempt's submitted evidence. */
function rewriteSubmission(a: Approved, change: (learning: Record<string, unknown> & { manifests: Record<string, unknown>[] }) => void): void {
  const row = a.w.desktop.db.get<{ evidence_json: string }>('SELECT evidence_json FROM kanban_attempts WHERE id = ?', a.packet.attemptId)
  const evidence = JSON.parse(row?.evidence_json ?? '{}')
  change(evidence.learning)
  a.w.desktop.db.run('UPDATE kanban_attempts SET evidence_json = ? WHERE id = ?', JSON.stringify(evidence), a.packet.attemptId)
}

describe('preparation refuses a submission that no longer agrees with the approval', () => {
  it('refuses a submission whose manifests did not all pass verification', async () => {
    const a = await approvedCard()
    rewriteSubmission(a, (learning) => {
      learning.manifests[0] = { ...learning.manifests[0], passed: false }
    })
    expect(await refusal(prepare(a.w.desktop, a))).toEqual({
      code: 'conflict',
      message: `Attempt ${a.packet.attemptId} did not submit verified manifests for the approved drafts.`
    })
    expect(integrations(a.w.desktop)).toEqual([])
  })

  it('refuses a submission that classified another evidence snapshot than the card links', async () => {
    const a = await approvedCard()
    rewriteSubmission(a, (learning) => {
      learning.snapshotHash = `sha256:${'f'.repeat(64)}`
    })
    expect(await refusal(prepare(a.w.desktop, a))).toEqual({
      code: 'conflict',
      message: `Attempt ${a.packet.attemptId} classified another evidence snapshot.`
    })
  })

  it('refuses staged drafts that name another run than the card links', async () => {
    const a = await approvedCard()
    a.w.desktop.db.run('UPDATE learning_stagings SET run_id = ? WHERE attempt_id = ?', 'rn_00000000000000000000000099', a.packet.attemptId)
    expect(await refusal(prepare(a.w.desktop, a))).toEqual({
      code: 'conflict',
      message: `The staged drafts of attempt ${a.packet.attemptId} name another run or sprint.`
    })
  })

  it('refuses a submission under review on another card than the one named', async () => {
    const a = await approvedCard(false)
    const other = claimedLearningCard(a.w, 2)
    const error = await refusal(prepareLearningIntegration(a.w.desktop, { cardId: other.cardId, attemptId: a.packet.attemptId, draftsHash: a.draftsHash }))
    expect(error).toEqual({ code: 'approval_required', message: `Attempt ${a.packet.attemptId} is not the submission of ${other.key} under review.` })
    expect(integrations(a.w.desktop)).toEqual([])
  })
})

describe('preparation against what already exists', () => {
  it('refuses other drafts while the card already has an open integration of this machine', async () => {
    const a = await approvedCard()
    const first = await prepare(a.w.desktop, a)
    const error = await refusal(prepare(a.w.desktop, { ...a, draftsHash: `sha256:${'0'.repeat(64)}` }))
    expect(error).toEqual({
      code: 'conflict',
      message: `Card ${a.packet.cardId} already has prepared learning integration ${first.id} for attempt ${a.packet.attemptId}.`
    })
    expect(integrations(a.w.desktop)).toEqual([{ id: first.id, state: 'prepared' }])
  })

  it('stores one integration when two preparations of the same approval run at once', async () => {
    const a = await approvedCard()
    const [first, second] = await Promise.all([prepare(a.w.desktop, a), prepare(a.w.desktop, a)])
    expect(second).toEqual(first)
    expect(integrations(a.w.desktop)).toEqual([{ id: first.id, state: 'prepared' }])
  })

  it('refuses when the submitted manifests change while Git verifies them, storing nothing', async () => {
    const a = await approvedCard()
    let changed = false
    const racing: TestCtx = {
      ...a.w.desktop,
      gitFor: () =>
        guardrailGit(() => {
          if (changed) return
          changed = true
          rewriteSubmission(a, (learning) => {
            learning.manifests[0] = { ...learning.manifests[0], commit: 'e'.repeat(40) }
          })
        })
    }
    expect(await refusal(prepare(racing, a))).toEqual({
      code: 'conflict',
      message: 'The learning card changed while its manifests were verified; prepare it again.'
    })
    expect(integrations(a.w.desktop)).toEqual([])
  })
})

describe('an untouched approval', () => {
  it('prepares: every manifest verifies again and the integration binds the approved drafts', async () => {
    const a = await approvedCard()
    expect(await prepare(a.w.desktop, a)).toMatchObject({ state: 'prepared', local: true, manifest: { cardId: a.packet.cardId, draftsHash: a.draftsHash } })
  })
})
