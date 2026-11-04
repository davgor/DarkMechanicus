/**
 * Whether a chat's run or Kanban card holds a lease (`chatLeases.ts`): an attempt that is `claimed` or `running` with
 * a lease that ends after now, counted only for the newest chat of the folder that carries the run or card. On fake
 * reads and a fixed clock.
 */
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { createLeaseHeld, type LeaseReads, type LeasedAttempt } from './chatLeases'

const NOW = Date.parse('2026-11-04T09:00:00.000Z')
const LATER = '2026-11-04T09:02:00.000Z'
const EARLIER = '2026-11-04T08:58:00.000Z'
const FOLDER = '/work/repo'

type Chat = Parameters<ReturnType<typeof createLeaseHeld>>[0]

const RUN_CHAT: Chat = { id: 'ch_1', folder: FOLDER, createdAt: '2026-11-04T08:00:00.000Z', runId: 'rn_1' }
const CARD_CHAT: Chat = { id: 'ch_2', folder: FOLDER, createdAt: '2026-11-04T08:00:00.000Z', cardId: 'kc_1' }

/** Reads that answer `run` for `rn_1` and `card` for `kc_1` in `FOLDER`, list `chats`, and write down every run and card read. */
function reads(attempts: { run?: LeasedAttempt[]; card?: LeasedAttempt[]; chats?: Chat[] }): LeaseReads & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    listChats: () => attempts.chats ?? [RUN_CHAT, CARD_CHAT],
    getRun: async (folder, runId) => {
      calls.push(`getRun ${folder} ${runId}`)
      return attempts.run === undefined ? null : { attempts: attempts.run }
    },
    getKanbanCard: async (folder, cardId) => {
      calls.push(`getKanbanCard ${folder} ${cardId}`)
      return { attempts: attempts.card ?? [] }
    }
  }
}

describe('chat leases', () => {
  it('finds a lease held when an attempt of the run is claimed or running and its lease ends after now', async () => {
    for (const state of ['claimed', 'running']) {
      const run = reads({ run: [{ state: 'accepted', leaseExpiresAt: null }, { state, leaseExpiresAt: LATER }] })

      expect(await createLeaseHeld(run, () => NOW)(RUN_CHAT)).toBe(true)
      expect(run.calls).toEqual([`getRun ${FOLDER} rn_1`])
    }
  })

  it('finds none for a lease that has ended or ends now, one with no or a malformed end, an attempt past its lease, or a run with no attempts', async () => {
    const cases: { run?: LeasedAttempt[] }[] = [
      { run: [{ state: 'running', leaseExpiresAt: EARLIER }] },
      { run: [{ state: 'running', leaseExpiresAt: new Date(NOW).toISOString() }] },
      { run: [{ state: 'running', leaseExpiresAt: null }] },
      { run: [{ state: 'running', leaseExpiresAt: 'soon' }] },
      { run: [{ state: 'submitted', leaseExpiresAt: LATER }] },
      { run: [{ state: 'lease_expired', leaseExpiresAt: LATER }] },
      {},
      { run: [] }
    ]
    for (const attempts of cases) {
      expect(await createLeaseHeld(reads(attempts), () => NOW)(RUN_CHAT)).toBe(false)
    }
  })

  it('reads the Kanban card a chat Play opened carries, by the same rule', async () => {
    const held = reads({ card: [{ state: 'rejected', leaseExpiresAt: null }, { state: 'claimed', leaseExpiresAt: LATER }] })
    const ended = reads({ card: [{ state: 'claimed', leaseExpiresAt: EARLIER }] })

    expect(await createLeaseHeld(held, () => NOW)(CARD_CHAT)).toBe(true)
    expect(await createLeaseHeld(ended, () => NOW)(CARD_CHAT)).toBe(false)
    expect(held.calls).toEqual([`getKanbanCard ${FOLDER} kc_1`])
  })
})

describe('chat leases: which chat carries the run or card, and failed reads', () => {
  it('finds none for an older chat once a newer chat of the folder carries the same card or run, and reads nothing for it', async () => {
    const leased = [{ state: 'claimed', leaseExpiresAt: LATER }]
    const newerCard: Chat = { ...CARD_CHAT, id: 'ch_3', createdAt: '2026-11-04T08:30:00.000Z' }
    const newerRun: Chat = { ...RUN_CHAT, id: 'ch_4', createdAt: '2026-11-04T08:30:00.000Z' }
    const cards = reads({ card: leased, chats: [CARD_CHAT, newerCard] })
    const runs = reads({ run: leased, chats: [RUN_CHAT, newerRun] })

    expect(await createLeaseHeld(cards, () => NOW)(CARD_CHAT)).toBe(false)
    expect(await createLeaseHeld(cards, () => NOW)(newerCard)).toBe(true)
    expect(await createLeaseHeld(runs, () => NOW)(RUN_CHAT)).toBe(false)
    expect(await createLeaseHeld(runs, () => NOW)(newerRun)).toBe(true)
    expect([cards.calls, runs.calls]).toEqual([[`getKanbanCard ${FOLDER} kc_1`], [`getRun ${FOLDER} rn_1`]])
  })

  it('is not superseded by a newer chat that carries another run or card', async () => {
    const other: Chat = { ...RUN_CHAT, id: 'ch_5', createdAt: '2026-11-04T08:30:00.000Z', runId: 'rn_2' }

    expect(await createLeaseHeld(reads({ run: [{ state: 'running', leaseExpiresAt: LATER }], chats: [RUN_CHAT, other] }), () => NOW)(RUN_CHAT)).toBe(true)
  })

  it('reads nothing for a chat that carries no run and no card', async () => {
    const none = reads({ run: [{ state: 'running', leaseExpiresAt: LATER }] })

    expect(await createLeaseHeld(none, () => NOW)({ id: 'ch_6', folder: FOLDER, createdAt: RUN_CHAT.createdAt })).toBe(false)
    expect(none.calls).toEqual([])
  })

  it('finds none for a run or card that is gone, and lets any other failed read reject, for the terminal to report', async () => {
    const gone: LeaseReads = {
      listChats: () => [],
      getRun: async () => {
        throw new DomainError('not_found', 'Run rn_1 not found.')
      },
      getKanbanCard: async () => {
        throw new DomainError('not_found', 'Card kc_1 not found.')
      }
    }
    const failing: LeaseReads = {
      ...gone,
      getRun: async () => {
        throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus.')
      }
    }

    expect(await createLeaseHeld(gone, () => NOW)(RUN_CHAT)).toBe(false)
    expect(await createLeaseHeld(gone, () => NOW)(CARD_CHAT)).toBe(false)
    await expect(createLeaseHeld(failing, () => NOW)(RUN_CHAT)).rejects.toThrow('not tracked')
  })
})
