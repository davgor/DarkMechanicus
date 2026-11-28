/**
 * DM-975: renewing a lease after a call that carried a claim token. `renewAttemptLease` and `renewCardLease` say whether
 * the token named their kind of attempt at all (so `renewClaimAfter` tries the other kind only when it did not), and
 * renew only a live claim the token proves.
 */
import { describe, expect, it } from 'vitest'
import type { KanbanPacket } from '../../shared/domain/kanban'
import { attemptRow, claim, startedRun } from '../../test/execution'
import { createTestCtx, type TestCtx, withRole } from '../../test/testContext'
import { addSeconds } from '../clock'
import { failAttempt, renewAttemptLease } from './attempts'
import { renewClaimAfter } from './claimRenewal'
import { claimKanbanCard, failKanbanCard, playKanbanCard, renewCardLease } from './kanban/attempts'
import { createKanbanCard } from './kanban/cards'

const OTHER_MACHINE = 'mc_0000000000000000000000000z'

describe('renewAttemptLease', () => {
  it('renews a live plan claim by the length it holds and says the token named a plan attempt', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const { attempt, packet } = claim(ctx, runId, 1)
    ctx.clock.advanceSeconds(600)
    const now = ctx.clock.nowIso()
    expect(renewAttemptLease(ctx, packet.claimToken)).toBe(true)
    expect(attemptRow(ctx, attempt.id)).toMatchObject({ lease_expires_at: addSeconds(now, 3600), heartbeat_at: now, updated_at: now })
  })

  it('says an ended claim\'s token named a plan attempt, and renews nothing', () => {
    const ctx = createTestCtx()
    const { runId } = startedRun(ctx)
    const { attempt, packet } = claim(ctx, runId, 1)
    failAttempt(ctx, { attemptId: attempt.id, claimToken: packet.claimToken, failure: { reason: 'Gave up' } })
    const before = attemptRow(ctx, attempt.id)
    ctx.clock.advanceSeconds(600)
    expect(renewAttemptLease(ctx, packet.claimToken)).toBe(true)
    expect(attemptRow(ctx, attempt.id)).toEqual(before)
  })

  it('says a token naming no plan attempt named none', () => {
    const ctx = createTestCtx()
    expect(renewAttemptLease(ctx, 'no-attempt.secret')).toBe(false)
    expect(renewAttemptLease(ctx, 'no separator')).toBe(false)
  })
})

interface Card {
  ctx: TestCtx
  packet: KanbanPacket
  token: string
  row: () => Record<string, unknown> | undefined
}

function claimedCard(): Card {
  const ctx = createTestCtx({ role: 'desktop' })
  const card = createKanbanCard(ctx, { title: 'Fix the flaky upload test', acceptanceCriteria: ['It passes 50 runs in a row'] })
  playKanbanCard(ctx, { cardId: card.id })
  const packet = claimKanbanCard(withRole(ctx, 'orchestrator'), { cardId: card.id })
  return {
    ctx,
    packet,
    token: packet.claimToken ?? '',
    row: () => ctx.db.get<Record<string, unknown>>('SELECT * FROM kanban_attempts WHERE id = ?', packet.attemptId)
  }
}

describe('renewCardLease', () => {
  it('renews a live card claim by the length it holds and says the token named a card attempt', () => {
    const { ctx, token, row } = claimedCard()
    ctx.clock.advanceSeconds(600)
    const now = ctx.clock.nowIso()
    expect(renewCardLease(ctx, token)).toBe(true)
    expect(row()).toMatchObject({ state: 'claimed', lease_expires_at: addSeconds(now, 3600), heartbeat_at: now })
  })

  it('renews a claim still live at the last second of its lease', () => {
    const { ctx, token, row } = claimedCard()
    ctx.clock.advanceSeconds(3600)
    const now = ctx.clock.nowIso()
    expect(row()?.lease_expires_at).toBe(now)
    expect(renewCardLease(ctx, token)).toBe(true)
    expect(row()?.lease_expires_at).toBe(addSeconds(now, 3600))
  })

  it.each([
    ['an overdue claim', (card: Card) => card.ctx.clock.advanceSeconds(3601)],
    ['a claim on another computer', (card: Card) => card.ctx.db.run('UPDATE kanban_attempts SET machine_id = ? WHERE id = ?', OTHER_MACHINE, card.packet.attemptId)],
    ['an ended claim', (card: Card) => failKanbanCard(withRole(card.ctx, 'worker'), { attemptId: card.packet.attemptId, claimToken: card.token, reason: 'Gave up' })]
  ])('says %s\'s token named a card attempt, and renews nothing', (_name, arrange) => {
    const card = claimedCard()
    arrange(card)
    const before = card.row()
    card.ctx.clock.advanceSeconds(60)
    expect(renewCardLease(card.ctx, card.token)).toBe(true)
    expect(card.row()).toEqual(before)
  })

  it('says a forged token for a card attempt named it, and renews nothing', () => {
    const { ctx, packet, row } = claimedCard()
    const before = row()
    ctx.clock.advanceSeconds(600)
    expect(renewCardLease(ctx, `${packet.attemptId}.forgedSecretAAAAAAAA`)).toBe(true)
    expect(row()).toEqual(before)
  })

  it('says a token naming no card attempt named none', () => {
    const ctx = createTestCtx()
    expect(renewCardLease(ctx, 'no-attempt.secret')).toBe(false)
  })

  it('is reached through renewClaimAfter for a card token a plan renewal did not recognise', () => {
    const { ctx, token, row } = claimedCard()
    ctx.clock.advanceSeconds(600)
    renewClaimAfter(ctx, 'addKanbanMessage', { cardId: 'any', body: 'Still working', claimToken: token })
    expect(row()?.lease_expires_at).toBe(addSeconds(ctx.clock.nowIso(), 3600))
  })
})
