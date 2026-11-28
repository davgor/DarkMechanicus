/**
 * DM-938: an ordinary card's claim packet and stored submission keep their exact bytes. The goldens below are what the
 * code before learning cards produced; this file uses only APIs that existed then, so it runs unchanged against both.
 */
import { describe, expect, it } from 'vitest'
import type { KanbanPacket } from '../../../shared/domain/kanban'
import { createTestCtx, withRole } from '../../../test/testContext'
import { claimKanbanCard, playKanbanCard, submitKanbanCard } from './attempts'
import { createKanbanCard } from './cards'

function ordinaryClaim() {
  const desktop = createTestCtx({ role: 'desktop', checkout: { branch: 'feature/cards', commit: null } })
  desktop.clock.set('2026-10-31T09:00:00.000Z')
  const card = createKanbanCard(desktop, { title: 'Fix the flaky upload test', body: 'Only this.', acceptanceCriteria: ['It passes'] })
  playKanbanCard(desktop, { cardId: card.id })
  const packet = claimKanbanCard(withRole(desktop, 'orchestrator'), { cardId: card.id })
  return { desktop, packet }
}

/** The packet an ordinary card's claim produced before learning cards, for this card and claim. */
function goldenPacket(packet: KanbanPacket): unknown {
  return {
    cardId: packet.cardId,
    key: packet.key,
    attemptId: packet.attemptId,
    claimToken: packet.claimToken,
    leaseExpiresAt: '2026-10-31T10:00:00.000Z',
    heartbeatIntervalSeconds: 1200,
    card: {
      title: 'Fix the flaky upload test',
      body: 'Only this.',
      acceptanceCriteria: [{ id: 'c1', text: 'It passes' }],
      expectedArtifacts: [],
      references: [],
      priority: 'normal',
      size: null
    },
    branch: 'feature/cards',
    reviewComments: [],
    reporting: {
      heartbeatTool: 'heartbeat_kanban_card',
      submitTool: 'submit_kanban_card',
      failTool: 'fail_kanban_card',
      instructions:
        'Work on the checked-out branch feature/cards; cards get no branch of their own. Work only on this card and stay within its acceptance criteria. ' +
        'Call heartbeat_kanban_card with the claim token at least every heartbeatIntervalSeconds, or the lease expires. ' +
        'When finished, call submit_kanban_card with outputs (summary, artifacts, commits, changed files, branch) and evidence for each acceptance criterion. ' +
        'If you cannot finish, call fail_kanban_card with the reason. Submitting moves the card to Ready for review; only a person approves it or kicks it back.'
    },
    definitionOfDone: []
  }
}

describe('ordinary card compatibility', () => {
  it('claims the same packet, byte for byte, with no learning section', () => {
    const { packet } = ordinaryClaim()
    expect(JSON.stringify(packet)).toBe(JSON.stringify(goldenPacket(packet)))
    expect(Object.keys(packet)).not.toContain('learning')
  })

  it('stores the same submission, byte for byte', () => {
    const { desktop, packet } = ordinaryClaim()
    desktop.clock.set('2026-10-31T09:05:00.000Z')
    submitKanbanCard(withRole(desktop, 'worker'), {
      attemptId: packet.attemptId,
      claimToken: packet.claimToken ?? '',
      outputs: { summary: 'Made the upload test wait.', commits: ['0123abc'] },
      evidence: { checks: [{ name: 'lint', status: 'passed', detail: '' }], criteria: [{ criterionId: 'c1', met: true, note: 'ok' }] }
    })
    const row = desktop.db.get<{ outputs_json: string; evidence_json: string; state: string }>(
      'SELECT outputs_json, evidence_json, state FROM kanban_attempts WHERE id = ?',
      packet.attemptId
    )
    expect(row).toEqual({
      state: 'submitted',
      outputs_json: '{"summary":"Made the upload test wait.","artifacts":[],"commits":["0123abc"],"changedFiles":[],"branch":null}',
      evidence_json: '{"checks":[{"name":"lint","status":"passed","detail":""}],"criteria":[{"criterionId":"c1","met":true,"note":"ok"}],"notes":""}'
    })
  })
})
