/** Kanban attempts under saved delivery standards and recorded YOLO usage, and launch failures that are not card errors. */
import { describe, expect, it } from 'vitest'
import { baselineDeliveryPolicy } from '../../../shared/domain/standardsPrompts'
import type { KanbanPacket } from '../../../shared/domain/kanban'
import { captureError } from '../../../test/authoring'
import { createTestCtx, type TestCtx, withRole } from '../../../test/testContext'
import type { Db } from '../../db/database'
import { encodeStandards, type AppliedStandard } from '../workStandards'
import { approveKanbanCard, claimKanbanCard, heartbeatKanbanCard, launchKanbanCards, playKanbanCard, submitKanbanCard } from './attempts'
import { createKanbanCard, getKanbanCard } from './cards'

interface Board {
  desktop: TestCtx
  orchestrator: TestCtx
  worker: TestCtx
}

function board(configured = false): Board {
  const desktop = createTestCtx({ role: 'desktop', checkout: { branch: 'feature/cards', commit: null } })
  if (configured) desktop.deliveryStandards = () => ({ revision: 1, policy: baselineDeliveryPolicy })
  return { desktop, orchestrator: withRole(desktop, 'orchestrator'), worker: withRole(desktop, 'worker') }
}

function claimed(ctx: Board, title = 'Fix the flaky upload test'): KanbanPacket {
  const card = createKanbanCard(ctx.desktop, { title })
  playKanbanCard(ctx.desktop, { cardId: card.id })
  return claimKanbanCard(ctx.orchestrator, { cardId: card.id })
}

function claimToken(packet: KanbanPacket): string {
  if (packet.claimToken === null) throw new Error('The packet carries no claim token.')
  return packet.claimToken
}

function setCardStandard(ctx: TestCtx, cardId: string, rule: Omit<AppliedStandard, 'id' | 'kind'>): void {
  ctx.db.run('UPDATE kanban_cards SET standards_json = ? WHERE id = ?', JSON.stringify(encodeStandards([{ id: cardId, kind: 'kanban', ...rule }])), cardId)
}

const revised = (revision: number): Omit<AppliedStandard, 'id' | 'kind'> => ({
  revision,
  disposition: 'updated',
  workflow: 'custom',
  reason: 'The upload tests now need a retry budget.',
  requirements: 'Record the retry budget the upload test uses.'
})

describe('heartbeat delivery requirements', () => {
  it('hands the card its pinned delivery requirements on every heartbeat, and none to a card without standards', () => {
    const ctx = board(true)
    const pinned = claimed(ctx)
    const beat = heartbeatKanbanCard(ctx.worker, { attemptId: pinned.attemptId, claimToken: claimToken(pinned) })
    expect(beat.deliveryRequirements).toMatchObject({ id: pinned.cardId, kind: 'kanban', revision: 1, disposition: 'compliant', workflow: 'default' })

    const plain = board()
    const bare = claimed(plain)
    expect(heartbeatKanbanCard(plain.worker, { attemptId: bare.attemptId, claimToken: claimToken(bare) })).not.toHaveProperty('deliveryRequirements')
  })
})

describe('approving against revised standards', () => {
  it('refuses a submission made before its requirements were revised, and approves one made against the revision', () => {
    const ctx = board()
    const packet = claimed(ctx)
    setCardStandard(ctx.desktop, packet.cardId, revised(2))
    submitKanbanCard(ctx.worker, { attemptId: packet.attemptId, claimToken: claimToken(packet), outputs: { summary: 'Added the retry budget.' },
      evidence: { notes: 'Checked the retry budget against the revised requirement.' } })
    setCardStandard(ctx.desktop, packet.cardId, revised(3))
    const refusal = captureError(() => approveKanbanCard(ctx.desktop, { cardId: packet.cardId }))
    expect([refusal.code, refusal.message]).toEqual(['conflict', 'The card requirements changed after submission. Kick it back for evidence against the revised standards.'])
    expect(getKanbanCard(ctx.desktop, { cardId: packet.cardId }).lane).toBe('ready_for_review')

    setCardStandard(ctx.desktop, packet.cardId, revised(2))
    expect(approveKanbanCard(ctx.desktop, { cardId: packet.cardId }).lane).toBe('done')
  })
})

describe('server-recorded YOLO usage', () => {
  it('appends the complete YOLO usage of the card to the submitted evidence notes', () => {
    const ctx = board()
    const packet = claimed(ctx)
    ctx.desktop.db.run(
      `INSERT INTO yolo_audit (time, grant_id, session_id, folder, run_id, capability, command, result, target_id, card_id)
       VALUES ('2026-01-01T00:00:00.000Z', 'gr_1', 'ss_1', '/projects/test', NULL, 'kanban.report', 'submitKanbanCard', 'succeeded', NULL, ?)`,
      packet.cardId
    )
    const view = submitKanbanCard(ctx.worker, { attemptId: packet.attemptId, claimToken: claimToken(packet), outputs: { summary: 'Done.' },
      evidence: { notes: 'Ran the upload test 50 times.' } })
    expect(view.evidence?.notes).toBe(
      'Ran the upload test 50 times.\n\nServer-recorded YOLO usage (complete card history through submission, across all grants and attempts; recommendations above grant no authority):\n' +
        '1 | 2026-01-01T00:00:00.000Z | grant=gr_1 | session=ss_1 | folder=/projects/test | run=none | card=' + packet.cardId +
        ' | kanban.report | submitKanbanCard | succeeded | target=none'
    )
  })
})

describe('launch failures that are not card errors', () => {
  it('surfaces a storage failure unchanged instead of listing it as a card error, and queues nothing', () => {
    const ctx = board()
    const card = createKanbanCard(ctx.desktop, { title: 'Launch me' })
    const { db } = ctx.desktop
    const failing: Db = {
      path: db.path, all: db.all.bind(db), run: db.run.bind(db), exec: db.exec.bind(db), inTransaction: db.inTransaction.bind(db),
      close: db.close.bind(db), tx: db.tx.bind(db),
      get: () => {
        throw new Error('disk I/O error')
      }
    }
    expect(() => launchKanbanCards({ ...ctx.orchestrator, db: failing }, { cardIds: [card.id] })).toThrow(new Error('disk I/O error'))
    expect(getKanbanCard(ctx.desktop, { cardId: card.id }).playPending).toBe(false)
  })
})
