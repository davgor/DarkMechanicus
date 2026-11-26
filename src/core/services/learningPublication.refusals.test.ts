/**
 * DM-938/DM-939: staging and publication refuse what does not belong to the attempt they were asked about: an
 * unknown or foreign attempt, replacements that are not one active learning each, an attempt that is not the
 * card's latest, and staged drafts or evidence that no longer agree with the card. Nothing is staged or published.
 */
import { describe, expect, it } from 'vitest'
import type { KanbanPacket } from '../../shared/domain/kanban'
import type { LearningDraft } from '../../shared/domain/learnings'
import { captureError } from '../../test/authoring'
import { claimedLearningCard, firstItem, learningDraft, learningWorld, OTHER_MACHINE, submitLearningCard } from '../../test/learningCardWorld'
import { learningDraft as storedDefinition, retireLearningRow, seedLearning } from '../../test/learningRecords'
import type { TestCtx } from '../../test/testContext'
import { approveKanbanCard } from './kanban/attempts'
import { getStagedLearningDrafts, publishApprovedLearningDrafts, stageLearningDrafts } from './learningPublication'

const stage = (ctx: TestCtx, packet: KanbanPacket, drafts: LearningDraft[]) =>
  stageLearningDrafts(ctx, { attemptId: packet.attemptId, claimToken: packet.claimToken ?? 'missing', drafts })

const stored = (ctx: TestCtx): unknown[] => ['learning_stagings', 'learning_publications'].map((table) => ctx.db.all(`SELECT * FROM ${table}`))

/** A learning card submitted with one draft citing its first item and approved to Done: what publishing it needs. */
async function approved() {
  const w = learningWorld()
  const packet = claimedLearningCard(w)
  await submitLearningCard(w, packet, [learningDraft(firstItem(packet))])
  approveKanbanCard(w.desktop, { cardId: packet.cardId })
  const { draftsHash } = getStagedLearningDrafts(w.desktop, { attemptId: packet.attemptId })
  const publish = () => publishApprovedLearningDrafts(w.desktop, { cardId: packet.cardId, attemptId: packet.attemptId, draftsHash })
  return { w, packet, publish }
}

describe('staging refusals', () => {
  it('refuses an unknown attempt, and reports an attempt that staged nothing yet', () => {
    const w = learningWorld()
    const packet = claimedLearningCard(w)
    expect(captureError(() => stage(w.worker, { ...packet, attemptId: 'ka_000000000000000000000000zz' }, []))).toMatchObject({
      code: 'not_found',
      message: 'Kanban attempt ka_000000000000000000000000zz does not exist.'
    })
    expect(captureError(() => getStagedLearningDrafts(w.desktop, { attemptId: packet.attemptId }))).toMatchObject({
      code: 'invalid_state',
      message: `Attempt ${packet.attemptId} staged no learning drafts.`
    })
  })

  it('refuses an attempt claimed on another computer', () => {
    const w = learningWorld()
    const packet = claimedLearningCard(w)
    w.desktop.db.run('UPDATE kanban_attempts SET machine_id = ? WHERE id = ?', OTHER_MACHINE, packet.attemptId)
    expect(captureError(() => stage(w.worker, packet, []))).toMatchObject({
      code: 'card_not_owned',
      message: `Attempt ${packet.attemptId} was claimed on another computer; only that computer reports on it.`
    })
    expect(stored(w.desktop)).toEqual([[], []])
  })

  it('refuses two drafts that replace the same learning, and a draft that replaces a retired one', () => {
    const w = learningWorld()
    const packet = claimedLearningCard(w)
    const active = seedLearning(w.desktop.db, 1, storedDefinition(), w.desktop.clock.nowIso())
    const retired = seedLearning(w.desktop.db, 2, storedDefinition({ title: 'Pin fixture clocks' }), w.desktop.clock.nowIso())
    retireLearningRow(w.desktop.db, retired, w.desktop.clock.nowIso())
    const item = firstItem(packet)
    const twice = [learningDraft(item, { replaces: active }), learningDraft(item, { title: 'Run every migration test', replaces: active })]
    expect(captureError(() => stage(w.worker, packet, twice))).toMatchObject({ code: 'invalid_input', message: `Two drafts replace learning ${active}.` })
    expect(captureError(() => stage(w.worker, packet, [learningDraft(item, { replaces: retired })]))).toMatchObject({
      code: 'invalid_state',
      message: `Learning ${retired} is already retired.`
    })
    expect(stored(w.desktop)).toEqual([[], []])
  })
})

describe('publication refusals', () => {
  it('refuses an approved attempt that is no longer the card latest', async () => {
    const { w, packet, publish } = await approved()
    // A later attempt of the card, as an import from another machine records it.
    w.desktop.db.run(
      `INSERT INTO kanban_attempts (id, card_id, number, state, claim_secret, machine_id, created_at)
       VALUES ('ka_00000000000000000000000088', ?, 2, 'failed', 'secret', ?, ?)`,
      packet.cardId, OTHER_MACHINE, w.desktop.clock.nowIso()
    )
    expect(captureError(publish)).toMatchObject({ code: 'stale_claim', message: `Attempt ${packet.attemptId} is not the latest attempt of ${packet.key}.` })
    expect(w.desktop.db.all('SELECT * FROM learning_publications')).toEqual([])
  })

  it('refuses staged drafts that name another run than the card', async () => {
    const { w, packet, publish } = await approved()
    w.desktop.db.run('UPDATE learning_stagings SET run_id = ? WHERE attempt_id = ?', 'rn_00000000000000000000000099', packet.attemptId)
    expect(captureError(publish)).toMatchObject({
      code: 'conflict',
      message: `The staged drafts of attempt ${packet.attemptId} name another card, run or sprint.`
    })
    expect(w.desktop.db.all('SELECT * FROM learning_records')).toEqual([])
  })

  it('refuses when the evidence stored with the staged drafts is not what the drafts cite now', async () => {
    const { w, packet, publish } = await approved()
    w.desktop.db.run("UPDATE learning_stagings SET evidence_json = '[]' WHERE attempt_id = ?", packet.attemptId)
    expect(captureError(publish)).toMatchObject({
      code: 'conflict',
      message: `The evidence cited by attempt ${packet.attemptId} changed after it was staged.`
    })
    expect(w.desktop.db.all('SELECT * FROM learning_records')).toEqual([])
  })

  it('publishes the untouched approval: one active record with the approved title', async () => {
    const { publish } = await approved()
    expect(publish().records.map((record) => [record.title, record.state])).toEqual([['Run the migration tests', 'active']])
  })
})
