import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KanbanPacket } from '../../shared/domain/kanban'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { LIMITS } from '../schemas'
import type { Workspace } from '../workspace'

async function failureOf(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await promise
  } catch (error: unknown) {
    const { code, message } = error as { code: string; message: string }
    return { code, message }
  }
  return { code: 'ok', message: '' }
}

let harness: Harness
let desktop: Workspace

beforeEach(async () => {
  harness = createHarness()
  desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'kanban-repo', keyPrefix: 'KB' })
})

afterEach(() => {
  harness.cleanup()
})

describe('kanban card commands', () => {
  it('creates, edits, lists and reads a card across sessions', async () => {
    const planner = harness.open('planner')
    const card = await planner.createKanbanCard({
      title: 'Isolated fix',
      body: 'Only this.',
      acceptanceCriteria: ['It is fixed'],
      priority: 'high'
    })
    expect(card).toMatchObject({
      key: 'KB-1',
      lane: 'backlog',
      revision: 1,
      createdBy: { role: 'planner', label: 'planner session' },
      acceptanceCriteria: [{ id: 'c1', text: 'It is fixed' }]
    })

    const edited = await desktop.updateKanbanCard({ cardId: card.id, expectedRevision: 1, body: 'Only this, carefully.' })
    expect([edited.body, edited.revision]).toEqual(['Only this, carefully.', 2])

    const reader = harness.open('reader')
    const board = await reader.listKanbanCards({})
    expect(board.lanes.backlog).toEqual([
      {
        id: card.id,
        key: 'KB-1',
        title: 'Isolated fix',
        lane: 'backlog',
        priority: 'high',
        updatedAt: edited.updatedAt,
        playPending: false,
        openAttempt: null,
        kickBackCount: 0,
        summary: null
      }
    ])
    expect(await reader.getKanbanCard({ cardId: card.id })).toEqual(edited)
  })

  it('refuses card writes to reader and worker sessions', async () => {
    for (const role of ['reader', 'worker'] as const) {
      const session = harness.open(role)
      expect((await failureOf(session.createKanbanCard({ title: 'Not allowed' }))).code).toBe('unauthorized')
    }
    expect((await desktop.listKanbanCards({})).lanes.backlog).toEqual([])
  })
})

describe('kanban card command input', () => {
  it('takes no lane, key or author from the input', async () => {
    const raw = desktop.createKanbanCard as (input: unknown) => Promise<unknown>
    for (const extra of [{ lane: 'done' }, { key: 'DM-99' }, { createdBy: { role: 'desktop', label: 'Ada' } }]) {
      const failure = await failureOf(raw({ title: 'Forged', ...extra }))
      expect(failure.code).toBe('invalid_input')
      expect(failure.message).toContain(Object.keys(extra)[0])
    }
    expect((await desktop.listKanbanCards({})).lanes.backlog).toEqual([])
  })

  it('requires a title and an expectedRevision, and bounds doneLimit to 1..100', async () => {
    const raw = (name: 'createKanbanCard' | 'updateKanbanCard' | 'listKanbanCards') =>
      desktop[name] as (input: unknown) => Promise<unknown>
    expect((await failureOf(raw('createKanbanCard')({ title: '' }))).code).toBe('invalid_input')
    expect((await failureOf(raw('createKanbanCard')({ title: 'x', priority: 'urgent' }))).code).toBe('invalid_input')
    const card = await desktop.createKanbanCard({ title: 'Bounded' })
    expect((await failureOf(raw('updateKanbanCard')({ cardId: card.id, title: 'No revision' }))).code).toBe('invalid_input')
    expect((await failureOf(raw('updateKanbanCard')({ cardId: 'KB-1', expectedRevision: 1 }))).code).toBe('invalid_input')
    expect((await failureOf(raw('listKanbanCards')({ doneLimit: 101 }))).code).toBe('invalid_input')
    expect((await failureOf(raw('listKanbanCards')({ doneLimit: 0 }))).code).toBe('invalid_input')
    expect((await desktop.listKanbanCards({ doneLimit: 100 })).lanes.backlog.map((item) => item.id)).toEqual([card.id])
  })
})

/** A card the person created and pressed Play on, claimed by an orchestrator session. */
async function claimed(leaseSeconds?: number): Promise<{ packet: KanbanPacket; claimToken: string }> {
  const card = await desktop.createKanbanCard({ title: 'Isolated fix', acceptanceCriteria: ['It is fixed'] })
  await desktop.playKanbanCard({ cardId: card.id })
  const packet = await harness
    .open('orchestrator')
    .claimKanbanCard(leaseSeconds === undefined ? { cardId: card.id } : { cardId: card.id, leaseSeconds })
  if (packet.claimToken === null) {
    throw new Error('A first claim returns its token.')
  }
  return { packet, claimToken: packet.claimToken }
}

describe('kanban card lifecycle commands', () => {
  it('carries a card across sessions: the person plays and approves, the orchestrator claims, the worker reports', async () => {
    const { packet, claimToken } = await claimed()
    expect(packet).toMatchObject({ key: 'KB-1', card: { title: 'Isolated fix' }, reviewComments: [] })

    const worker = harness.open('worker')
    const running = await worker.heartbeatKanbanCard({ attemptId: packet.attemptId, claimToken, progressNote: 'Editing the fix' })
    expect([running.state, running.progressNote]).toEqual(['running', 'Editing the fix'])
    // As an agent sends it, leaving out what the schema defaults.
    const submit = worker.submitKanbanCard as (input: unknown) => Promise<unknown>
    await submit({
      attemptId: packet.attemptId,
      claimToken,
      outputs: { summary: 'Fixed the isolated bug.', commits: ['0123abc'] },
      evidence: { checks: [{ name: 'lint', status: 'passed' }], criteria: [{ criterionId: 'c1', met: true }] }
    })
    const review = await desktop.getKanbanCard({ cardId: packet.cardId })
    expect(review.lane).toBe('ready_for_review')
    expect(review.attempts[0]?.evidence).toEqual({
      checks: [{ name: 'lint', status: 'passed', detail: '' }],
      criteria: [{ criterionId: 'c1', met: true, note: '' }],
      notes: ''
    })

    await desktop.approveKanbanCard({ cardId: packet.cardId })
    const board = await harness.open('reader').listKanbanCards({})
    expect(board.lanes.done.map((card) => [card.key, card.summary?.outcome, card.summary?.commits])).toEqual([
      ['KB-1', 'Fixed the isolated bug.', ['0123abc']]
    ])
  })

  it('kicks a card back to the same orchestrator, whose next claim lists the comment', async () => {
    const { packet, claimToken } = await claimed()
    const orchestrator = harness.open('orchestrator')
    await orchestrator.submitKanbanCard({ attemptId: packet.attemptId, claimToken, outputs: { summary: 'First try.' } })
    const kicked = await desktop.kickBackKanbanCard({ cardId: packet.cardId, comment: 'Handle the empty input.' })
    expect([kicked.lane, kicked.playPending, kicked.kickBackCount]).toEqual(['in_progress', true, 1])
    expect((await orchestrator.claimKanbanCard({ cardId: packet.cardId })).reviewComments).toEqual(['Handle the empty input.'])
  })
})

describe('kanban card lifecycle authority and leases', () => {
  it('refuses Play, approve and kick back to agent sessions, and the claim and every report to the desktop', async () => {
    const { packet, claimToken } = await claimed()
    for (const role of ['orchestrator', 'planner', 'worker', 'reviewer'] as const) {
      const agent = harness.open(role)
      expect((await failureOf(agent.playKanbanCard({ cardId: packet.cardId }))).code).toBe('unauthorized')
      expect((await failureOf(agent.approveKanbanCard({ cardId: packet.cardId }))).code).toBe('unauthorized')
      expect((await failureOf(agent.kickBackKanbanCard({ cardId: packet.cardId, comment: 'Redo' }))).code).toBe('unauthorized')
    }
    const { attemptId } = packet
    expect((await failureOf(desktop.claimKanbanCard({ cardId: packet.cardId }))).code).toBe('unauthorized')
    expect((await failureOf(desktop.heartbeatKanbanCard({ attemptId, claimToken }))).code).toBe('unauthorized')
    expect((await failureOf(desktop.submitKanbanCard({ attemptId, claimToken, outputs: { summary: 'x' } }))).code).toBe('unauthorized')
    expect((await failureOf(desktop.failKanbanCard({ attemptId, claimToken, reason: 'x' }))).code).toBe('unauthorized')
    expect((await desktop.getKanbanCard({ cardId: packet.cardId })).attempts.map((attempt) => attempt.state)).toEqual(['claimed'])
  })

  it('expires a lapsed lease when the board is read, so the card shows In progress with no open attempt', async () => {
    const { packet } = await claimed(30)
    harness.clock.advanceSeconds(31)

    const board = await desktop.listKanbanCards({})

    expect(board.lanes.in_progress.map((card) => [card.id, card.openAttempt, card.playPending])).toEqual([[packet.cardId, null, false]])
    expect((await desktop.getKanbanCard({ cardId: packet.cardId })).attempts.map((attempt) => attempt.state)).toEqual(['lease_expired'])
    expect((await desktop.playKanbanCard({ cardId: packet.cardId })).playPending).toBe(true)
  })
})

describe('kanban card lifecycle command input', () => {
  it('refuses a blank or oversized kick-back comment, an oversized progress note and a lease under 30 seconds', async () => {
    const { packet, claimToken } = await claimed()
    const worker = harness.open('worker')
    const heartbeat = worker.heartbeatKanbanCard as (input: unknown) => Promise<unknown>
    const note = 'n'.repeat(LIMITS.progressNote + 1)
    expect((await failureOf(heartbeat({ attemptId: packet.attemptId, claimToken, progressNote: note }))).code).toBe('invalid_input')
    expect((await desktop.getKanbanCard({ cardId: packet.cardId })).attempts[0]?.progressNote).toBeNull()
    await worker.submitKanbanCard({ attemptId: packet.attemptId, claimToken, outputs: { summary: 'Done.' } })

    const kickBack = desktop.kickBackKanbanCard as (input: unknown) => Promise<unknown>
    for (const comment of ['', '   ', 'c'.repeat(LIMITS.comment + 1)]) {
      expect((await failureOf(kickBack({ cardId: packet.cardId, comment }))).code).toBe('invalid_input')
    }
    expect((await failureOf(kickBack({ cardId: packet.cardId }))).code).toBe('invalid_input')
    expect((await desktop.getKanbanCard({ cardId: packet.cardId })).lane).toBe('ready_for_review')

    const second = await desktop.createKanbanCard({ title: 'Second' })
    await desktop.playKanbanCard({ cardId: second.id })
    const claim = harness.open('orchestrator').claimKanbanCard as (input: unknown) => Promise<unknown>
    expect((await failureOf(claim({ cardId: second.id, leaseSeconds: 29 }))).code).toBe('invalid_input')
    expect((await desktop.getKanbanCard({ cardId: second.id })).attempts).toEqual([])
  })

  it('takes no lane, attempt or player from the input', async () => {
    const card = await desktop.createKanbanCard({ title: 'Strict' })
    const play = desktop.playKanbanCard as (input: unknown) => Promise<unknown>
    for (const extra of [{ lane: 'in_progress' }, { playRequestedBy: 'someone else' }]) {
      const failure = await failureOf(play({ cardId: card.id, ...extra }))
      expect(failure.code).toBe('invalid_input')
      expect(failure.message).toContain(Object.keys(extra)[0])
    }
    expect((await desktop.getKanbanCard({ cardId: card.id })).playPending).toBe(false)
  })
})
