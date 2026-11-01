import { describe, expect, it } from 'vitest'
import type { KanbanPacket } from '../../../shared/domain/kanban'
import type { DefinitionOfDoneCheck, SessionRole } from '../../../shared/domain/views'
import { captureError } from '../../../test/authoring'
import { createSequentialIds, createTestCtx, type TestCtx, withRole } from '../../../test/testContext'
import type { IdGenerator } from '../../ids'
import { LIMITS } from '../../schemas'
import {
  approveKanbanCard,
  claimKanbanCard,
  expireKanbanLeases,
  failKanbanCard,
  heartbeatKanbanCard,
  kickBackKanbanCard,
  playKanbanCard,
  submitKanbanCard
} from './attempts'
import { createKanbanCard, getKanbanCard, listKanbanCards } from './cards'

const DEFINITION_OF_DONE: DefinitionOfDoneCheck[] = [
  { name: 'lint', command: 'npm run lint', description: 'oxlint' },
  { name: 'test', command: 'npm test', description: 'vitest' }
]

interface Board {
  desktop: TestCtx
  orchestrator: TestCtx
  worker: TestCtx
}

/** One database seen by the person at the desktop, the orchestrator that claims and the worker that reports. */
function board(options: { ids?: IdGenerator; branch?: string | null } = {}): Board {
  const desktop = createTestCtx({
    role: 'desktop',
    ids: options.ids,
    checkout: { branch: options.branch === undefined ? 'feature/cards' : options.branch, commit: null },
    definitionOfDone: DEFINITION_OF_DONE
  })
  return { desktop, orchestrator: withRole(desktop, 'orchestrator'), worker: withRole(desktop, 'worker') }
}

function token(packet: KanbanPacket): string {
  if (packet.claimToken === null) {
    throw new Error('The packet carries no claim token.')
  }
  return packet.claimToken
}

/** A card in Backlog with a pending Play. */
function playedCard(ctx: Board, title = 'Fix the flaky upload test'): string {
  const card = createKanbanCard(ctx.desktop, { title, acceptanceCriteria: ['It passes 50 runs in a row'] })
  playKanbanCard(ctx.desktop, { cardId: card.id })
  return card.id
}

/** A card that was played and claimed: its packet. */
function claimedCard(ctx: Board, leaseSeconds?: number): KanbanPacket {
  const cardId = playedCard(ctx)
  return claimKanbanCard(ctx.orchestrator, leaseSeconds === undefined ? { cardId } : { cardId, leaseSeconds })
}

function submit(ctx: Board, packet: KanbanPacket, summary = 'Made the upload test wait for the server.'): void {
  submitKanbanCard(ctx.worker, {
    attemptId: packet.attemptId,
    claimToken: token(packet),
    outputs: { summary, commits: ['0123abc'] },
    evidence: { checks: [{ name: 'lint', status: 'passed', detail: '' }], criteria: [{ criterionId: 'c1', met: true, note: '50/50' }] }
  })
}

/** A card with a submission awaiting the person's review: its packet. */
function cardInReview(ctx: Board): KanbanPacket {
  const packet = claimedCard(ctx)
  submit(ctx, packet)
  return packet
}

function cardRow(ctx: TestCtx, cardId: string): Record<string, unknown> | undefined {
  return ctx.db.get('SELECT * FROM kanban_cards WHERE id = ?', cardId)
}

function attemptRow(ctx: TestCtx, attemptId: string): Record<string, unknown> | undefined {
  return ctx.db.get('SELECT * FROM kanban_attempts WHERE id = ?', attemptId)
}

function attemptCount(ctx: TestCtx): number {
  return ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM kanban_attempts')?.n ?? -1
}

/** Each `kanban_events` row as [kind, attempt id], oldest first. */
function kanbanEvents(ctx: TestCtx): [string, string | null][] {
  return ctx.db
    .all<{ kind: string; attempt_id: string | null }>('SELECT kind, attempt_id FROM kanban_events ORDER BY created_at, id')
    .map((row) => [row.kind, row.attempt_id])
}

/** The payload of the latest `kanban_events` row of `kind`. */
function kanbanEventPayload(ctx: TestCtx, kind: string): unknown {
  const row = ctx.db.get<{ payload_json: string }>('SELECT payload_json FROM kanban_events WHERE kind = ? ORDER BY id DESC LIMIT 1', kind)
  return row === undefined ? undefined : JSON.parse(row.payload_json)
}

function workspaceEvents(ctx: TestCtx): { kind: string; epicId: string | null; cardId: unknown }[] {
  return ctx.db
    .all<{ kind: string; epic_id: string | null; payload_json: string }>("SELECT kind, epic_id, payload_json FROM events WHERE kind LIKE 'kanban.%' ORDER BY seq")
    .map((row) => {
      const payload: unknown = JSON.parse(row.payload_json)
      const cardId = typeof payload === 'object' && payload !== null && 'cardId' in payload ? payload.cardId : undefined
      return { kind: row.kind, epicId: row.epic_id, cardId }
    })
}

describe('a card from Backlog to Done', () => {
  it('plays, claims, submits and approves a card, compacting it into its Done summary', () => {
    const ctx = board()
    ctx.desktop.clock.set('2026-10-31T09:00:00.000Z')
    const card = createKanbanCard(ctx.desktop, { title: 'Fix the flaky upload test' })

    const played = playKanbanCard(ctx.desktop, { cardId: card.id })
    expect([played.lane, played.playPending, played.openAttempt]).toEqual(['backlog', true, null])
    expect(cardRow(ctx.desktop, card.id)).toMatchObject({ play_requested_at: '2026-10-31T09:00:00.000Z', play_requested_by: 'test desktop' })

    ctx.desktop.clock.set('2026-10-31T09:05:00.000Z')
    const packet = claimKanbanCard(ctx.orchestrator, { cardId: card.id })
    const claimed = getKanbanCard(ctx.desktop, { cardId: card.id })
    expect([claimed.lane, claimed.playPending, claimed.openAttempt]).toEqual(['in_progress', false, { number: 1, state: 'claimed' }])
    expect(cardRow(ctx.desktop, card.id)).toMatchObject({ play_requested_at: null, play_requested_by: null })

    ctx.desktop.clock.set('2026-10-31T09:15:00.000Z')
    const summary = `Made the upload test wait for the server before it asserts. ${'It now passes fifty runs in a row. '.repeat(10)}`
    submitKanbanCard(ctx.worker, {
      attemptId: packet.attemptId,
      claimToken: token(packet),
      outputs: { summary, commits: ['0123abc', '4567def'] }
    })
    const inReview = getKanbanCard(ctx.desktop, { cardId: card.id })
    expect([inReview.lane, inReview.openAttempt]).toEqual(['ready_for_review', { number: 1, state: 'submitted' }])
    expect(inReview.attempts[0]).toMatchObject({ state: 'submitted', submittedAt: '2026-10-31T09:15:00.000Z', leaseExpiresAt: null })

    ctx.desktop.clock.set('2026-10-31T11:00:00.000Z')
    const done = approveKanbanCard(ctx.desktop, { cardId: card.id })

    expect(done).toMatchObject({ lane: 'done', completedAt: '2026-10-31T11:00:00.000Z', playPending: false, openAttempt: null })
    expect(done.attempts.map((attempt) => [attempt.number, attempt.state, attempt.decidedAt])).toEqual([
      [1, 'accepted', '2026-10-31T11:00:00.000Z']
    ])
    expect(done.summary).toEqual({
      outcome: `${summary.slice(0, 279)}…`,
      commits: ['0123abc', '4567def'],
      completedAt: '2026-10-31T11:00:00.000Z',
      approvedBy: 'test desktop'
    })
    expect(done.summary?.outcome).toHaveLength(280)
    expect(cardRow(ctx.desktop, card.id)).toMatchObject({ completed_at: '2026-10-31T11:00:00.000Z', compacted_at: '2026-10-31T11:00:00.000Z' })
    expect(listKanbanCards(ctx.desktop, {}).lanes.done.map((item) => [item.id, item.summary])).toEqual([[card.id, done.summary]])
  })
})

describe('transition records and the Done summary', () => {
  it('records every transition as a kanban event of the attempt and a workspace event with the card id and no epic', () => {
    const ctx = board()
    const packet = cardInReview(ctx)
    approveKanbanCard(ctx.desktop, { cardId: packet.cardId })

    expect(kanbanEvents(ctx.desktop)).toEqual([
      ['created', null],
      ['played', null],
      ['claimed', packet.attemptId],
      ['submitted', packet.attemptId],
      ['approved', packet.attemptId]
    ])
    expect(workspaceEvents(ctx.desktop)).toEqual(
      ['kanban.created', 'kanban.played', 'kanban.claimed', 'kanban.submitted', 'kanban.approved'].map((kind) => ({
        kind,
        epicId: null,
        cardId: packet.cardId
      }))
    )
    expect(kanbanEventPayload(ctx.desktop, 'claimed')).toEqual({
      number: 1,
      machineId: 'mc_00000000000000000000000001',
      leaseExpiresAt: packet.leaseExpiresAt
    })
    expect(kanbanEventPayload(ctx.desktop, 'approved')).toMatchObject({
      number: 1,
      summary: { outcome: 'Made the upload test wait for the server.', commits: ['0123abc'] }
    })
  })

  it('keeps a short summary as the outcome, on one line', () => {
    const ctx = board()
    const packet = claimedCard(ctx)
    submit(ctx, packet, '  Fixed the wait.\n\nAll fifty runs pass.  ')
    expect(approveKanbanCard(ctx.desktop, { cardId: packet.cardId }).summary?.outcome).toBe('Fixed the wait. All fifty runs pass.')
  })
})

describe('the outcome cut and a submission without outputs', () => {
  it('drops a high surrogate the outcome cut would split, so no half character is kept', () => {
    const ctx = board()
    const packet = claimedCard(ctx)
    submit(ctx, packet, `${'a'.repeat(278)}\u{1F600}${'b'.repeat(40)}`)
    const outcome = approveKanbanCard(ctx.desktop, { cardId: packet.cardId }).summary?.outcome
    expect(outcome).toBe(`${'a'.repeat(278)}…`)
  })

  it('keeps a surrogate pair that fits whole before the cut', () => {
    const ctx = board()
    const packet = claimedCard(ctx)
    submit(ctx, packet, `${'a'.repeat(277)}\u{1F600}${'b'.repeat(40)}`)
    const outcome = approveKanbanCard(ctx.desktop, { cardId: packet.cardId }).summary?.outcome
    expect(outcome).toBe(`${'a'.repeat(277)}\u{1F600}…`)
  })

  it('approves a submission whose outputs were never stored with an empty outcome and no commits', () => {
    const ctx = board()
    const packet = cardInReview(ctx)
    ctx.desktop.db.run('UPDATE kanban_attempts SET outputs_json = NULL WHERE id = ?', packet.attemptId)
    const done = approveKanbanCard(ctx.desktop, { cardId: packet.cardId })
    expect([done.lane, done.summary?.outcome, done.summary?.commits]).toEqual(['done', '', []])
    expect(kanbanEventPayload(ctx.desktop, 'approved')).toMatchObject({ number: 1, summary: { outcome: '', commits: [] } })
  })
})

describe('the claim packet', () => {
  it('hands over the card content, a one-time token, the lease, the checkout branch, the reporting tools and the Definition of Done', () => {
    const ctx = board()
    ctx.desktop.clock.set('2026-10-31T09:00:00.000Z')
    const card = createKanbanCard(ctx.desktop, {
      title: 'Fix the flaky upload test',
      body: 'It times out **sometimes**.',
      acceptanceCriteria: ['It passes 50 runs in a row'],
      expectedArtifacts: ['src/upload.test.ts'],
      priority: 'high',
      size: 'small'
    })
    playKanbanCard(ctx.desktop, { cardId: card.id })

    const packet = claimKanbanCard(ctx.orchestrator, { cardId: card.id, leaseSeconds: 120 })

    expect(packet).toEqual({
      cardId: card.id,
      key: 'DM-1',
      attemptId: expect.stringMatching(/^ka_[0-9a-hjkmnp-tv-z]{26}$/),
      claimToken: `${packet.attemptId}.secret-1`,
      leaseExpiresAt: '2026-10-31T09:02:00.000Z',
      heartbeatIntervalSeconds: 40,
      card: {
        title: 'Fix the flaky upload test',
        body: 'It times out **sometimes**.',
        acceptanceCriteria: [{ id: 'c1', text: 'It passes 50 runs in a row' }],
        expectedArtifacts: ['src/upload.test.ts'],
        references: [],
        priority: 'high',
        size: 'small'
      },
      branch: 'feature/cards',
      reviewComments: [],
      reporting: { heartbeatTool: 'heartbeat_kanban_card', submitTool: 'submit_kanban_card', failTool: 'fail_kanban_card', instructions: expect.any(String) },
      definitionOfDone: DEFINITION_OF_DONE
    } satisfies KanbanPacket)
    for (const tool of ['heartbeat_kanban_card', 'submit_kanban_card', 'fail_kanban_card', 'definitionOfDone', 'feature/cards']) {
      expect(packet.reporting.instructions).toContain(tool)
    }
    const row = attemptRow(ctx.desktop, packet.attemptId)
    expect(row).toMatchObject({ number: 1, state: 'claimed', machine_id: 'mc_00000000000000000000000001', lease_expires_at: '2026-10-31T09:02:00.000Z' })
  })
})

describe('claim leases and replays', () => {
  it('uses the plan default lease of 900 seconds, and a null branch outside Git', () => {
    const ctx = board({ branch: null })
    ctx.desktop.clock.set('2026-10-31T09:00:00.000Z')
    const packet = claimedCard(ctx)
    expect([packet.leaseExpiresAt, packet.heartbeatIntervalSeconds, packet.branch]).toEqual(['2026-10-31T09:15:00.000Z', 300, null])
  })

  it('replays a claim with the same idempotency key as the same packet without its token, and makes no second attempt', () => {
    const ctx = board()
    const cardId = playedCard(ctx)
    const first = claimKanbanCard(ctx.orchestrator, { cardId, idempotencyKey: 'claim-1' })
    const replay = claimKanbanCard(ctx.orchestrator, { cardId, idempotencyKey: 'claim-1' })
    expect(replay).toEqual({ ...first, claimToken: null })
    expect(attemptCount(ctx.desktop)).toBe(1)
  })
})

describe('claim refusals', () => {
  it('returns play_required for a card nobody pressed Play on, and creates no attempt', () => {
    const ctx = board()
    const card = createKanbanCard(ctx.desktop, { title: 'Not started' })
    const refusal = captureError(() => claimKanbanCard(ctx.orchestrator, { cardId: card.id }))
    expect(refusal).toMatchObject({ code: 'play_required', details: { cardId: card.id } })
    expect(attemptCount(ctx.desktop)).toBe(0)
    expect(getKanbanCard(ctx.desktop, { cardId: card.id }).lane).toBe('backlog')
  })

  it('returns already_claimed for a second claim while the attempt is claimed, running or submitted', () => {
    const ctx = board()
    const packet = claimedCard(ctx)
    expect(captureError(() => claimKanbanCard(ctx.orchestrator, { cardId: packet.cardId })).code).toBe('already_claimed')
    heartbeatKanbanCard(ctx.worker, { attemptId: packet.attemptId, claimToken: token(packet) })
    expect(captureError(() => claimKanbanCard(ctx.orchestrator, { cardId: packet.cardId })).code).toBe('already_claimed')
    submit(ctx, packet)
    expect(captureError(() => claimKanbanCard(ctx.orchestrator, { cardId: packet.cardId })).code).toBe('already_claimed')
    expect(attemptCount(ctx.desktop)).toBe(1)
  })

  it('returns not_found for a card that does not exist', () => {
    const ctx = board()
    expect(captureError(() => claimKanbanCard(ctx.orchestrator, { cardId: 'kc_0000000000000000000000zzzz' })).code).toBe('not_found')
  })

  it('checks the branch before claiming', () => {
    const ctx = board()
    const cardId = playedCard(ctx)
    const moved = {
      ...ctx.orchestrator,
      assertBranch: () => {
        throw new Error('branch moved')
      }
    }
    expect(() => claimKanbanCard(moved, { cardId })).toThrow('branch moved')
    expect(attemptCount(ctx.desktop)).toBe(0)
  })
})

describe('claim refusals of a Done card', () => {
  it('returns invalid_state for a Done card, even with a pending Play', () => {
    const ctx = board()
    const packet = cardInReview(ctx)
    approveKanbanCard(ctx.desktop, { cardId: packet.cardId })
    ctx.desktop.db.run("UPDATE kanban_cards SET play_requested_at = '2026-01-01T00:00:00.000Z' WHERE id = ?", packet.cardId)
    const refusal = captureError(() => claimKanbanCard(ctx.orchestrator, { cardId: packet.cardId }))
    expect(refusal).toMatchObject({ code: 'invalid_state', message: 'DM-1 is Done.', details: { cardId: packet.cardId, lane: 'done' } })
    expect(attemptCount(ctx.desktop)).toBe(1)
  })

  it('returns invalid_state for a Done card without a pending Play, not play_required', () => {
    const ctx = board()
    const packet = cardInReview(ctx)
    approveKanbanCard(ctx.desktop, { cardId: packet.cardId })
    const refusal = captureError(() => claimKanbanCard(ctx.orchestrator, { cardId: packet.cardId }))
    expect([refusal.code, refusal.message]).toEqual(['invalid_state', 'DM-1 is Done.'])
  })
})

describe('claim tokens', () => {
  it('refuses a token with another secret, another attempt id or no separator as stale_claim on every report, and changes nothing', () => {
    const ctx = board()
    const packet = claimedCard(ctx)
    const forged = [`${packet.attemptId}.secret-2`, `ka_0000000000000000000000zzzz.secret-1`, packet.attemptId, 'secret-1']
    for (const claimToken of forged) {
      const { attemptId } = packet
      expect(captureError(() => heartbeatKanbanCard(ctx.worker, { attemptId, claimToken, progressNote: 'forged' })).code).toBe('stale_claim')
      expect(captureError(() => submitKanbanCard(ctx.worker, { attemptId, claimToken, outputs: { summary: 'forged' } })).code).toBe(
        'stale_claim'
      )
      expect(captureError(() => failKanbanCard(ctx.worker, { attemptId, claimToken, reason: 'forged' })).code).toBe('stale_claim')
    }
    expect(attemptRow(ctx.desktop, packet.attemptId)).toMatchObject({ state: 'claimed', progress_note: null, outputs_json: null })
    expect(getKanbanCard(ctx.desktop, { cardId: packet.cardId }).lane).toBe('in_progress')
  })

  it('refuses the token of an attempt that was submitted, kicked back or failed as stale_claim', () => {
    const ctx = board()
    const first = cardInReview(ctx)
    const submitAgain = (packet: KanbanPacket) => () =>
      submitKanbanCard(ctx.worker, { attemptId: packet.attemptId, claimToken: token(packet), outputs: { summary: 'again' } })
    expect(captureError(submitAgain(first)).code).toBe('stale_claim')
    kickBackKanbanCard(ctx.desktop, { cardId: first.cardId, comment: 'Not yet.' })
    expect(captureError(submitAgain(first)).code).toBe('stale_claim')

    const second = claimKanbanCard(ctx.orchestrator, { cardId: first.cardId })
    failKanbanCard(ctx.worker, { attemptId: second.attemptId, claimToken: token(second), reason: 'The fixture server is down.' })
    expect(captureError(submitAgain(second)).code).toBe('stale_claim')
    expect(captureError(submitAgain(first)).code).toBe('stale_claim')
    expect(getKanbanCard(ctx.desktop, { cardId: first.cardId }).attempts.map((attempt) => attempt.state)).toEqual(['rejected', 'failed'])
  })
})

describe('expired claims', () => {
  it('refuses a token whose lease lapsed as expired_claim, and keeps the expiry although the report failed', () => {
    const ctx = board()
    const packet = claimedCard(ctx, 60)
    ctx.desktop.clock.advanceSeconds(61)

    const refusal = captureError(() =>
      submitKanbanCard(ctx.worker, { attemptId: packet.attemptId, claimToken: token(packet), outputs: { summary: 'Too late' } })
    )

    expect(refusal).toMatchObject({ code: 'expired_claim', details: { attemptId: packet.attemptId } })
    expect(attemptRow(ctx.desktop, packet.attemptId)).toMatchObject({ state: 'lease_expired', outputs_json: null })
    expect(kanbanEvents(ctx.desktop).at(-1)).toEqual(['lease_expired', packet.attemptId])
    expect(getKanbanCard(ctx.desktop, { cardId: packet.cardId }).lane).toBe('in_progress')
    expect(captureError(() => heartbeatKanbanCard(ctx.worker, { attemptId: packet.attemptId, claimToken: token(packet) })).code).toBe(
      'expired_claim'
    )
    expect(captureError(() => failKanbanCard(ctx.worker, { attemptId: packet.attemptId, claimToken: token(packet), reason: 'x' })).code).toBe(
      'expired_claim'
    )
  })

  it('returns not_found for an attempt that does not exist', () => {
    const ctx = board()
    const attemptId = 'ka_0000000000000000000000zzzz'
    expect(captureError(() => heartbeatKanbanCard(ctx.worker, { attemptId, claimToken: `${attemptId}.secret-1` })).code).toBe('not_found')
  })
})

describe('heartbeats', () => {
  it('moves the claim to running once, keeps the lease length it was claimed with, and stores the latest progress note', () => {
    const ctx = board()
    ctx.desktop.clock.set('2026-10-31T09:00:00.000Z')
    const packet = claimedCard(ctx, 120)
    ctx.desktop.clock.set('2026-10-31T09:01:30.000Z')

    const first = heartbeatKanbanCard(ctx.worker, { attemptId: packet.attemptId, claimToken: token(packet), progressNote: 'editing upload.test.ts' })
    expect(first).toMatchObject({
      state: 'running',
      heartbeatAt: '2026-10-31T09:01:30.000Z',
      leaseExpiresAt: '2026-10-31T09:03:30.000Z',
      progressNote: 'editing upload.test.ts'
    })

    ctx.desktop.clock.set('2026-10-31T09:03:00.000Z')
    const second = heartbeatKanbanCard(ctx.orchestrator, { attemptId: packet.attemptId, claimToken: token(packet) })
    expect([second.leaseExpiresAt, second.progressNote]).toEqual(['2026-10-31T09:05:00.000Z', 'editing upload.test.ts'])
    expect(kanbanEvents(ctx.desktop).filter(([kind]) => kind === 'running')).toEqual([['running', packet.attemptId]])
  })
})

describe('heartbeat notes and lease lengths', () => {
  it('records a progress refresh, but no kanban event, for a later heartbeat that carries a note', () => {
    const ctx = board()
    const packet = claimedCard(ctx)
    const claim = { attemptId: packet.attemptId, claimToken: token(packet) }
    heartbeatKanbanCard(ctx.worker, claim)
    heartbeatKanbanCard(ctx.worker, claim)
    expect(workspaceEvents(ctx.desktop).map((event) => event.kind)).not.toContain('kanban.progress')

    const noted = heartbeatKanbanCard(ctx.worker, { ...claim, progressNote: 'running the suite' })

    expect([noted.state, noted.progressNote]).toEqual(['running', 'running the suite'])
    expect(workspaceEvents(ctx.desktop).at(-1)).toEqual({ kind: 'kanban.progress', epicId: null, cardId: packet.cardId })
    expect(kanbanEvents(ctx.desktop).map(([kind]) => kind)).toEqual(['created', 'played', 'claimed', 'running'])
  })

  it('extends a claim that holds no lease length by the default 900 seconds', () => {
    const ctx = board()
    ctx.desktop.clock.set('2026-10-31T09:00:00.000Z')
    const packet = claimedCard(ctx, 120)
    ctx.desktop.db.run('UPDATE kanban_attempts SET lease_expires_at = NULL WHERE id = ?', packet.attemptId)
    ctx.desktop.clock.set('2026-10-31T09:01:00.000Z')

    const view = heartbeatKanbanCard(ctx.worker, { attemptId: packet.attemptId, claimToken: token(packet) })

    expect([view.state, view.leaseExpiresAt]).toEqual(['running', '2026-10-31T09:16:00.000Z'])
  })

  it('extends by the default 900 seconds when the held lease had already ended as it was granted', () => {
    const ctx = board()
    ctx.desktop.clock.set('2026-10-31T09:00:00.000Z')
    const packet = claimedCard(ctx, 120)
    ctx.desktop.db.run('UPDATE kanban_attempts SET lease_expires_at = created_at WHERE id = ?', packet.attemptId)

    const view = heartbeatKanbanCard(ctx.worker, { attemptId: packet.attemptId, claimToken: token(packet) })

    expect(view.leaseExpiresAt).toBe('2026-10-31T09:15:00.000Z')
  })

  it('masks the claim token and its bare secret wherever the agent pasted them', () => {
    const ctx = board()
    const packet = claimedCard(ctx)
    const view = heartbeatKanbanCard(ctx.worker, {
      attemptId: packet.attemptId,
      claimToken: token(packet),
      progressNote: `using ${token(packet)} and secret-1`
    })
    expect(view.progressNote).toBe('using [claim token masked] and [claim token masked]')

    const submitted = submitKanbanCard(ctx.worker, {
      attemptId: packet.attemptId,
      claimToken: token(packet),
      outputs: { summary: `Done with ${token(packet)}`, commits: ['0123abc'] },
      evidence: { notes: 'secret-1 was handy' }
    })
    expect([submitted.outputs?.summary, submitted.evidence?.notes]).toEqual(['Done with [claim token masked]', '[claim token masked] was handy'])
  })
})

/** Every `kanban_events`, `events` and `idempotency` row, as JSON text to search. */
function storedRows(ctx: TestCtx): string[] {
  return [
    ...ctx.db.all('SELECT * FROM kanban_events'),
    ...ctx.db.all('SELECT * FROM events'),
    ...ctx.db.all('SELECT * FROM idempotency')
  ].map((row) => JSON.stringify(row))
}

describe('tokens of other claims', () => {
  it("masks another attempt's whole token pasted into a note or a report, in views, events and stored responses", () => {
    const ctx = board({ ids: scannableIds() })
    const cardA = claimedCard(ctx)
    const cardB = claimedCard(ctx)
    const tokenA = token(cardA)
    const secretA = tokenA.slice(tokenA.indexOf('.') + 1)
    const claimB = { attemptId: cardB.attemptId, claimToken: token(cardB) }

    heartbeatKanbanCard(ctx.worker, { ...claimB, progressNote: `card A uses ${tokenA}` })
    const outputs = { summary: `see ${tokenA}` }
    const submitted = submitKanbanCard(ctx.worker, { ...claimB, outputs, evidence: { notes: tokenA }, idempotencyKey: 'submit-b' })
    const view = getKanbanCard(ctx.desktop, { cardId: cardB.cardId })

    expect(view.attempts[0]).toMatchObject({
      progressNote: 'card A uses [claim token masked]',
      outputs: { summary: 'see [claim token masked]' },
      evidence: { notes: '[claim token masked]' }
    })
    expect(JSON.stringify([submitted, view])).not.toContain(secretA)
    expect(storedRows(ctx.desktop).filter((row) => row.includes(secretA))).toEqual([])
  })

  it('keeps attempt ids that are not tokens in a report, such as a retry note or a path', () => {
    const ctx = board({ ids: scannableIds() })
    const earlier = claimedCard(ctx)
    const packet = claimedCard(ctx)
    const outputs = {
      summary: `Retry of ${earlier.attemptId}.`,
      changedFiles: [`docs/${earlier.attemptId}.json`, 'docs/at_01m6a1p7qamc63weyayqxnxp8c.json']
    }
    const submitted = submitKanbanCard(ctx.worker, { attemptId: packet.attemptId, claimToken: token(packet), outputs })
    expect([submitted.outputs?.summary, submitted.outputs?.changedFiles]).toEqual([outputs.summary, outputs.changedFiles])
  })
})

describe('failing an attempt', () => {
  it('fails the attempt and leaves the card In progress without a pending play, where Play is allowed again', () => {
    const ctx = board()
    const packet = claimedCard(ctx)

    const failed = failKanbanCard(ctx.worker, { attemptId: packet.attemptId, claimToken: token(packet), reason: 'The fixture server is down.' })

    expect([failed.state, failed.leaseExpiresAt]).toEqual(['failed', null])
    const card = getKanbanCard(ctx.desktop, { cardId: packet.cardId })
    expect([card.lane, card.playPending, card.openAttempt]).toEqual(['in_progress', false, null])
    expect(kanbanEventPayload(ctx.desktop, 'failed')).toEqual({ number: 1, reason: 'The fixture server is down.' })
    expect(captureError(() => claimKanbanCard(ctx.orchestrator, { cardId: packet.cardId })).code).toBe('play_required')

    expect(playKanbanCard(ctx.desktop, { cardId: packet.cardId }).playPending).toBe(true)
    const retry = claimKanbanCard(ctx.orchestrator, { cardId: packet.cardId })
    expect(getKanbanCard(ctx.desktop, { cardId: retry.cardId }).openAttempt).toEqual({ number: 2, state: 'claimed' })
  })
})

describe('play', () => {
  it('marks one pending play: pressing Play again changes nothing and records no second event', () => {
    const ctx = board()
    ctx.desktop.clock.set('2026-10-31T09:00:00.000Z')
    const cardId = playedCard(ctx)
    ctx.desktop.clock.set('2026-10-31T09:30:00.000Z')
    const before = cardRow(ctx.desktop, cardId)

    const again = playKanbanCard(ctx.desktop, { cardId })

    expect(again.playPending).toBe(true)
    expect(cardRow(ctx.desktop, cardId)).toEqual(before)
    expect(kanbanEvents(ctx.desktop).map(([kind]) => kind)).toEqual(['created', 'played'])
  })

  it('returns invalid_state while an attempt is open, and in Ready for review and Done', () => {
    const ctx = board()
    const packet = claimedCard(ctx)
    const play = () => playKanbanCard(ctx.desktop, { cardId: packet.cardId })
    expect(captureError(play)).toMatchObject({ code: 'invalid_state', details: { cardId: packet.cardId } })
    heartbeatKanbanCard(ctx.worker, { attemptId: packet.attemptId, claimToken: token(packet) })
    expect(captureError(play).code).toBe('invalid_state')
    submit(ctx, packet)
    expect(captureError(play)).toMatchObject({ code: 'invalid_state', details: { lane: 'ready_for_review' } })
    approveKanbanCard(ctx.desktop, { cardId: packet.cardId })
    expect(captureError(play)).toMatchObject({ code: 'invalid_state', details: { lane: 'done' } })
    expect(cardRow(ctx.desktop, packet.cardId)).toMatchObject({ play_requested_at: null })
  })

  it('returns not_found for a card that does not exist', () => {
    const ctx = board()
    expect(captureError(() => playKanbanCard(ctx.desktop, { cardId: 'kc_0000000000000000000000zzzz' })).code).toBe('not_found')
  })
})

describe('kick back', () => {
  it('returns the card to In progress with a pending play, and every later claim lists the comments in order', () => {
    const ctx = board()
    const first = cardInReview(ctx)

    const kicked = kickBackKanbanCard(ctx.desktop, { cardId: first.cardId, comment: 'Cover the empty upload too.' })

    expect(kicked).toMatchObject({ lane: 'in_progress', playPending: true, openAttempt: null, kickBackCount: 1 })
    expect(kicked.attempts.map((attempt) => [attempt.number, attempt.state, attempt.reviewComment])).toEqual([
      [1, 'rejected', 'Cover the empty upload too.']
    ])
    expect(kanbanEventPayload(ctx.desktop, 'kicked_back')).toEqual({ number: 1, comment: 'Cover the empty upload too.' })

    const second = claimKanbanCard(ctx.orchestrator, { cardId: first.cardId })
    expect(second.reviewComments).toEqual(['Cover the empty upload too.'])
    expect(second.reporting.instructions).toContain('reviewComments')
    submit(ctx, second)
    kickBackKanbanCard(ctx.desktop, { cardId: first.cardId, comment: 'And the oversized one.' })

    const third = claimKanbanCard(ctx.orchestrator, { cardId: first.cardId })
    expect(third.reviewComments).toEqual(['Cover the empty upload too.', 'And the oversized one.'])
    submit(ctx, third)
    const done = approveKanbanCard(ctx.desktop, { cardId: first.cardId })
    expect([done.lane, done.kickBackCount]).toEqual(['done', 2])
    expect(done.attempts.map((attempt) => attempt.state)).toEqual(['rejected', 'rejected', 'accepted'])
  })

  it.each(['', '  \n\t '])('refuses the blank comment %j and leaves the card in review', (comment) => {
    const ctx = board()
    const packet = cardInReview(ctx)
    expect(captureError(() => kickBackKanbanCard(ctx.desktop, { cardId: packet.cardId, comment })).code).toBe('invalid_input')
    const card = getKanbanCard(ctx.desktop, { cardId: packet.cardId })
    expect([card.lane, card.openAttempt, card.playPending]).toEqual(['ready_for_review', { number: 1, state: 'submitted' }, false])
    expect(kanbanEvents(ctx.desktop).map(([kind]) => kind)).not.toContain('kicked_back')
  })

  it('takes a comment of exactly the comment limit and refuses one character more', () => {
    const ctx = board()
    const packet = cardInReview(ctx)
    const tooLong = 'x'.repeat(LIMITS.comment + 1)
    expect(captureError(() => kickBackKanbanCard(ctx.desktop, { cardId: packet.cardId, comment: tooLong })).code).toBe('invalid_input')
    const kicked = kickBackKanbanCard(ctx.desktop, { cardId: packet.cardId, comment: 'x'.repeat(LIMITS.comment) })
    expect(kicked.attempts[0]?.reviewComment).toHaveLength(LIMITS.comment)
  })
})

describe('review refusals', () => {
  it('returns invalid_state for approve and kick back outside Ready for review, and changes nothing', () => {
    const ctx = board()
    const backlog = createKanbanCard(ctx.desktop, { title: 'Waiting' })
    const inProgress = claimedCard(ctx)
    for (const cardId of [backlog.id, inProgress.cardId]) {
      expect(captureError(() => approveKanbanCard(ctx.desktop, { cardId })).code).toBe('invalid_state')
      expect(captureError(() => kickBackKanbanCard(ctx.desktop, { cardId, comment: 'No.' })).code).toBe('invalid_state')
    }
    expect(attemptRow(ctx.desktop, inProgress.attemptId)).toMatchObject({ state: 'claimed', review_comment: null })
    expect(getKanbanCard(ctx.desktop, { cardId: backlog.id }).lane).toBe('backlog')
  })

  it('refuses to approve or kick back a card that is already Done', () => {
    const ctx = board()
    const packet = cardInReview(ctx)
    approveKanbanCard(ctx.desktop, { cardId: packet.cardId })
    expect(captureError(() => approveKanbanCard(ctx.desktop, { cardId: packet.cardId })).code).toBe('invalid_state')
    expect(captureError(() => kickBackKanbanCard(ctx.desktop, { cardId: packet.cardId, comment: 'Reopen' })).code).toBe('invalid_state')
    expect(getKanbanCard(ctx.desktop, { cardId: packet.cardId }).attempts.map((attempt) => attempt.state)).toEqual(['accepted'])
  })

  it('refuses to approve or kick back a card in Ready for review that has no submitted attempt', () => {
    const ctx = board()
    const packet = cardInReview(ctx)
    ctx.desktop.db.run("UPDATE kanban_attempts SET state = 'failed' WHERE id = ?", packet.attemptId)
    const approve = captureError(() => approveKanbanCard(ctx.desktop, { cardId: packet.cardId }))
    const kickBack = captureError(() => kickBackKanbanCard(ctx.desktop, { cardId: packet.cardId, comment: 'Again.' }))
    for (const refusal of [approve, kickBack]) {
      expect(refusal).toMatchObject({ code: 'invalid_state', message: 'DM-1 has no submission to review.', details: { cardId: packet.cardId } })
    }
    expect(getKanbanCard(ctx.desktop, { cardId: packet.cardId })).toMatchObject({ lane: 'ready_for_review', completedAt: null, summary: null })
  })
})

describe('who may do what', () => {
  const AGENTS: SessionRole[] = ['orchestrator', 'planner', 'worker', 'reviewer', 'reader']

  it.each(AGENTS)('refuses Play, approve and kick back to a %s session, and changes nothing', (role) => {
    const ctx = board()
    const backlog = createKanbanCard(ctx.desktop, { title: 'Not started' })
    const review = cardInReview(ctx)
    const agent = withRole(ctx.desktop, role)

    expect(captureError(() => playKanbanCard(agent, { cardId: backlog.id })).code).toBe('unauthorized')
    expect(captureError(() => approveKanbanCard(agent, { cardId: review.cardId })).code).toBe('unauthorized')
    expect(captureError(() => kickBackKanbanCard(agent, { cardId: review.cardId, comment: 'Redo it' })).code).toBe('unauthorized')

    expect(getKanbanCard(ctx.desktop, { cardId: backlog.id }).playPending).toBe(false)
    expect(getKanbanCard(ctx.desktop, { cardId: review.cardId })).toMatchObject({ lane: 'ready_for_review', kickBackCount: 0 })
  })

  it('refuses claim, heartbeat, submit and fail to the desktop, even with a valid token', () => {
    const ctx = board()
    const pending = playedCard(ctx, 'Pending')
    const packet = claimedCard(ctx)
    const claimToken = token(packet)
    const { attemptId } = packet

    expect(captureError(() => claimKanbanCard(ctx.desktop, { cardId: pending })).code).toBe('unauthorized')
    expect(captureError(() => heartbeatKanbanCard(ctx.desktop, { attemptId, claimToken })).code).toBe('unauthorized')
    expect(captureError(() => submitKanbanCard(ctx.desktop, { attemptId, claimToken, outputs: { summary: 'Mine' } })).code).toBe('unauthorized')
    expect(captureError(() => failKanbanCard(ctx.desktop, { attemptId, claimToken, reason: 'Mine' })).code).toBe('unauthorized')

    expect(getKanbanCard(ctx.desktop, { cardId: pending })).toMatchObject({ playPending: true, openAttempt: null })
    expect(attemptRow(ctx.desktop, attemptId)).toMatchObject({ state: 'claimed', heartbeat_at: null })
  })

  it('refuses a claim to a worker, which may only report on a claim it was handed', () => {
    const ctx = board()
    const cardId = playedCard(ctx)
    expect(captureError(() => claimKanbanCard(ctx.worker, { cardId })).code).toBe('unauthorized')
    expect(attemptCount(ctx.desktop)).toBe(0)
  })
})

describe('lease expiry', () => {
  it('expires a claim whose lease lapsed to lease_expired and leaves the card In progress, where Play is allowed again', () => {
    const ctx = board()
    const packet = claimedCard(ctx, 60)
    ctx.desktop.clock.advanceSeconds(60)
    expect(expireKanbanLeases(ctx.desktop)).toEqual([])
    expect(attemptRow(ctx.desktop, packet.attemptId)).toMatchObject({ state: 'claimed' })

    ctx.desktop.clock.advanceSeconds(1)
    expect(expireKanbanLeases(ctx.desktop)).toEqual([packet.attemptId])

    const card = getKanbanCard(ctx.desktop, { cardId: packet.cardId })
    expect([card.lane, card.openAttempt, card.playPending]).toEqual(['in_progress', null, false])
    expect(card.attempts.map((attempt) => attempt.state)).toEqual(['lease_expired'])
    expect(kanbanEvents(ctx.desktop).at(-1)).toEqual(['lease_expired', packet.attemptId])
    expect(kanbanEventPayload(ctx.desktop, 'lease_expired')).toEqual({ number: 1, leaseExpiresAt: packet.leaseExpiresAt })
    expect(workspaceEvents(ctx.desktop).at(-1)).toEqual({ kind: 'kanban.lease_expired', epicId: null, cardId: packet.cardId })
    expect(expireKanbanLeases(ctx.desktop)).toEqual([])

    expect(captureError(() => claimKanbanCard(ctx.orchestrator, { cardId: packet.cardId })).code).toBe('play_required')
    playKanbanCard(ctx.desktop, { cardId: packet.cardId })
    claimKanbanCard(ctx.orchestrator, { cardId: packet.cardId })
    expect(getKanbanCard(ctx.desktop, { cardId: packet.cardId }).openAttempt).toEqual({ number: 2, state: 'claimed' })
  })

  it('expires a lapsed lease when the person presses Play, without a separate sweep', () => {
    const ctx = board()
    const packet = claimedCard(ctx, 60)
    ctx.desktop.clock.advanceSeconds(61)
    expect(playKanbanCard(ctx.desktop, { cardId: packet.cardId })).toMatchObject({ lane: 'in_progress', playPending: true, openAttempt: null })
    expect(attemptRow(ctx.desktop, packet.attemptId)).toMatchObject({ state: 'lease_expired' })
  })

  it('expires only the lapsed leases, and only the named card when one is given', () => {
    const ctx = board()
    const short = claimedCard(ctx, 60)
    const long = claimedCard(ctx, 600)
    const other = claimedCard(ctx, 60)
    ctx.desktop.clock.advanceSeconds(61)
    expect(expireKanbanLeases(ctx.desktop, short.cardId)).toEqual([short.attemptId])
    expect(attemptRow(ctx.desktop, other.attemptId)).toMatchObject({ state: 'claimed' })
    expect(expireKanbanLeases(ctx.desktop)).toEqual([other.attemptId])
    expect(attemptRow(ctx.desktop, long.attemptId)).toMatchObject({ state: 'claimed' })
  })

  it('never expires a submission, which holds no lease', () => {
    const ctx = board()
    const packet = cardInReview(ctx)
    ctx.desktop.clock.advanceSeconds(86_400)
    expect(expireKanbanLeases(ctx.desktop)).toEqual([])
    expect(getKanbanCard(ctx.desktop, { cardId: packet.cardId }).openAttempt).toEqual({ number: 1, state: 'submitted' })
  })
})

describe('an attempt claimed on another computer', () => {
  const OTHER_MACHINE = 'mc_0000000000000000000000000z'

  it('refuses heartbeat, submit and fail with card_not_owned even with the right token, and changes nothing', () => {
    const ctx = board()
    const packet = claimedCard(ctx)
    ctx.desktop.db.run('UPDATE kanban_attempts SET machine_id = ? WHERE id = ?', OTHER_MACHINE, packet.attemptId)
    const report = { attemptId: packet.attemptId, claimToken: token(packet) }
    const refusals = [
      captureError(() => heartbeatKanbanCard(ctx.worker, report)),
      captureError(() => submitKanbanCard(ctx.worker, { ...report, outputs: { summary: 'Not mine to submit.' } })),
      captureError(() => failKanbanCard(ctx.worker, { ...report, reason: 'Not mine to fail.' }))
    ]
    expect(refusals.map((error) => error.code)).toEqual(['card_not_owned', 'card_not_owned', 'card_not_owned'])
    expect(refusals[0]?.message).toBe(`Attempt ${packet.attemptId} was claimed on another computer; only that computer reports on it.`)
    expect(attemptRow(ctx.desktop, packet.attemptId)).toMatchObject({ state: 'claimed', machine_id: OTHER_MACHINE })
    expect(kanbanEvents(ctx.desktop).at(-1)).toEqual(['claimed', packet.attemptId])
  })

  it('never expires its lease here, since that computer may still be extending it', () => {
    const ctx = board()
    const foreign = claimedCard(ctx, 60)
    const own = claimedCard(ctx, 60)
    ctx.desktop.db.run('UPDATE kanban_attempts SET machine_id = ? WHERE id = ?', OTHER_MACHINE, foreign.attemptId)
    ctx.desktop.clock.advanceSeconds(61)
    expect(expireKanbanLeases(ctx.desktop)).toEqual([own.attemptId])
    expect(attemptRow(ctx.desktop, foreign.attemptId)).toMatchObject({ state: 'claimed' })
  })
})

/** Ids as the tests make them, with secrets long and distinct enough to search stored text for. */
function scannableIds(): IdGenerator {
  const ids = createSequentialIds()
  let secrets = 0
  return {
    next: (kind) => ids.next(kind),
    secret: () => {
      secrets += 1
      return `Zq8${String(secrets).padStart(3, '0')}kanbanClaimSecretWx7Rt`
    }
  }
}

/** Takes one card through every transition, the agent pasting its token into what it reports; returns every view it got. */
function everyTransition(ctx: Board): unknown[] {
  const returned: unknown[] = []
  const claim = (input: { cardId: string; idempotencyKey?: string; leaseSeconds?: number }): KanbanPacket => {
    const packet = claimKanbanCard(ctx.orchestrator, input)
    returned.push({ ...packet, claimToken: null })
    return packet
  }
  const card = createKanbanCard(ctx.desktop, { title: 'Scan me' })
  returned.push(card, playKanbanCard(ctx.desktop, { cardId: card.id }))

  // Attempt 1 heartbeats and submits, pasting its token both times, and is kicked back.
  const first = claim({ cardId: card.id, idempotencyKey: 'claim-1' })
  claim({ cardId: card.id, idempotencyKey: 'claim-1' })
  const outputs = { summary: `Done, token ${token(first)}`, commits: ['0123abc'] }
  returned.push(
    heartbeatKanbanCard(ctx.worker, { attemptId: first.attemptId, claimToken: token(first), progressNote: `token ${token(first)}` }),
    submitKanbanCard(ctx.worker, { attemptId: first.attemptId, claimToken: token(first), outputs, idempotencyKey: 'submit-1' }),
    kickBackKanbanCard(ctx.desktop, { cardId: card.id, comment: 'Again, please.' })
  )

  // Attempt 2 fails, attempt 3's lease lapses, attempt 4 is approved.
  const second = claim({ cardId: card.id })
  returned.push(
    failKanbanCard(ctx.worker, { attemptId: second.attemptId, claimToken: token(second), reason: `stuck on ${token(second)}` }),
    playKanbanCard(ctx.desktop, { cardId: card.id })
  )
  claim({ cardId: card.id, leaseSeconds: 60 })
  ctx.desktop.clock.advanceSeconds(61)
  returned.push(listKanbanCards(ctx.desktop, {}), expireKanbanLeases(ctx.desktop), playKanbanCard(ctx.desktop, { cardId: card.id }))
  const fourth = claim({ cardId: card.id })
  returned.push(
    submitKanbanCard(ctx.worker, { attemptId: fourth.attemptId, claimToken: token(fourth), outputs: { summary: 'Fixed.' } }),
    approveKanbanCard(ctx.desktop, { cardId: card.id }),
    getKanbanCard(ctx.desktop, { cardId: card.id }),
    listKanbanCards(ctx.desktop, {})
  )
  return returned
}

describe('the claim secret', () => {
  it('never appears in a kanban event, a workspace event, a stored response or a returned view after a full lifecycle', () => {
    const ctx = board({ ids: scannableIds() })

    const views = JSON.stringify(everyTransition(ctx))

    const attempts = ctx.desktop.db.all<{ state: string; claim_secret: string }>('SELECT state, claim_secret FROM kanban_attempts ORDER BY number')
    expect(attempts.map((row) => row.state)).toEqual(['rejected', 'failed', 'lease_expired', 'accepted'])
    const secrets = attempts.map((row) => row.claim_secret)
    expect(secrets).toEqual(['Zq8001kanbanClaimSecretWx7Rt', 'Zq8002kanbanClaimSecretWx7Rt', 'Zq8003kanbanClaimSecretWx7Rt', 'Zq8004kanbanClaimSecretWx7Rt'])
    const stored = storedRows(ctx.desktop)
    expect(kanbanEvents(ctx.desktop).map(([kind]) => kind)).toEqual(
      expect.arrayContaining(['played', 'claimed', 'running', 'submitted', 'kicked_back', 'failed', 'lease_expired', 'approved'])
    )
    for (const secret of secrets) {
      expect(stored.filter((row) => row.includes(secret))).toEqual([])
      expect(views).not.toContain(secret)
    }
    expect(views).toContain('[claim token masked]')
  })
})
