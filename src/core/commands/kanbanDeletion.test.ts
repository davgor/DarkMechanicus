/** Deleting Kanban cards end to end through workspaces on scratch folders: the guard, authority and persistence. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { KanbanPacket } from '../../shared/domain/kanban'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import type { Workspace } from '../workspace'

let harness: Harness
let desktop: Workspace
let orchestrator: Workspace

beforeEach(async () => {
  harness = createHarness()
  desktop = harness.open('desktop', { mode: 'repo' })
  await desktop.initializeRepository({ name: 'kanban-delete', keyPrefix: 'KD' })
  orchestrator = harness.open('orchestrator')
})

afterEach(() => {
  harness.cleanup()
})

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
    return 'ok'
  } catch (error: unknown) {
    return (error as { code?: string }).code ?? 'thrown'
  }
}

function cardDir(cardId: string): string {
  return join(harness.root, '.darkmechanicus', 'kanban', cardId)
}

function tokenOf(packet: KanbanPacket): string {
  if (packet.claimToken === null) {
    throw new Error('A first claim returns its token.')
  }
  return packet.claimToken
}

async function playedAndClaimed(title: string, leaseSeconds?: number): Promise<KanbanPacket> {
  const card = await desktop.createKanbanCard({ title })
  await desktop.playKanbanCard({ cardId: card.id })
  return orchestrator.claimKanbanCard(leaseSeconds === undefined ? { cardId: card.id } : { cardId: card.id, leaseSeconds })
}

describe('deleteKanbanCard', () => {
  it('removes the card from its lane, the board and its tracked folder, and leaves other cards alone', async () => {
    const doomed = await desktop.createKanbanCard({ title: 'Promoted to an epic' })
    const kept = await desktop.createKanbanCard({ title: 'Keep me' })
    await desktop.updateKanbanCard({ cardId: doomed.id, expectedRevision: 1, body: 'Edited once.' })
    expect(existsSync(cardDir(doomed.id))).toBe(true)

    const result = await desktop.deleteKanbanCard({ cardId: doomed.id })

    expect([result.cardId, result.key, result.title]).toEqual([doomed.id, 'KD-1', 'Promoted to an epic'])
    expect(result.removedPaths).toEqual([`.darkmechanicus/kanban/${doomed.id}`])
    const board = await harness.open('reader').listKanbanCards({})
    expect(board.lanes.backlog.map((card) => card.id)).toEqual([kept.id])
    expect(await codeOf(desktop.getKanbanCard({ cardId: doomed.id }))).toBe('not_found')
    expect(existsSync(cardDir(doomed.id))).toBe(false)
    expect(existsSync(cardDir(kept.id))).toBe(true)
  })

  it('stays gone after a restart, a reconcile of the portable files and a clone made afterwards', async () => {
    const doomed = await desktop.createKanbanCard({ title: 'Gone for good' })
    await desktop.deleteKanbanCard({ cardId: doomed.id })

    const restarted = harness.open('desktop')
    const reconciled = await restarted.reconcileRepository()
    const clone = harness.open('desktop', { root: harness.cloneTracked() })

    expect(reconciled.rejected).toEqual([])
    for (const workspace of [restarted, clone]) {
      const board = await workspace.listKanbanCards({})
      expect([Object.values(board.lanes).flat(), board.doneTotal]).toEqual([[], 0])
      expect(await codeOf(workspace.getKanbanCard({ cardId: doomed.id }))).toBe('not_found')
    }
  })

  it('deletes a finished card from Done, with its attempts and events', async () => {
    const packet = await playedAndClaimed('Finished work')
    await orchestrator.submitKanbanCard({
      attemptId: packet.attemptId,
      claimToken: tokenOf(packet),
      outputs: { summary: 'Done.' }
    })
    await desktop.approveKanbanCard({ cardId: packet.cardId })

    await desktop.deleteKanbanCard({ cardId: packet.cardId })

    const board = await desktop.listKanbanCards({})
    expect([board.lanes.done, board.doneTotal]).toEqual([[], 0])
    expect(existsSync(cardDir(packet.cardId))).toBe(false)
    const clone = harness.open('desktop', { root: harness.cloneTracked() })
    expect(await codeOf(clone.getKanbanCard({ cardId: packet.cardId }))).toBe('not_found')
  })

})

describe('deleteKanbanCard replays and misses', () => {
  it('does not replay a cached create for the deleted card', async () => {
    const first = await desktop.createKanbanCard({ title: 'Once', idempotencyKey: 'same-key' })
    await desktop.deleteKanbanCard({ cardId: first.id })

    const again = await desktop.createKanbanCard({ title: 'Once', idempotencyKey: 'same-key' })

    expect(again.id).not.toBe(first.id)
    expect((await desktop.getKanbanCard({ cardId: again.id })).title).toBe('Once')
  })

  it('refuses a card that does not exist', async () => {
    const card = await desktop.createKanbanCard({ title: 'Ghost' })
    await desktop.deleteKanbanCard({ cardId: card.id })
    expect(await codeOf(desktop.deleteKanbanCard({ cardId: card.id }))).toBe('not_found')
  })
})

describe('deleteKanbanCard with an attempt in flight', () => {
  it('refuses a claimed, a running and a submitted attempt, naming it, and keeps the card and its files', async () => {
    const packet = await playedAndClaimed('In flight')
    const report = { attemptId: packet.attemptId, claimToken: tokenOf(packet) }
    const refuse = async (state: string): Promise<void> => {
      const failure = await desktop.deleteKanbanCard({ cardId: packet.cardId }).then(
        () => null,
        (error: unknown) => error as { code: string; message: string }
      )
      expect(failure?.code).toBe('invalid_state')
      expect(failure?.message).toContain(`attempt #1 in state ${state}, so it cannot be deleted`)
      expect((await desktop.getKanbanCard({ cardId: packet.cardId })).openAttempt?.state).toBe(state)
      expect(existsSync(cardDir(packet.cardId))).toBe(true)
    }

    await refuse('claimed')
    await orchestrator.heartbeatKanbanCard(report)
    await refuse('running')
    await orchestrator.submitKanbanCard({ ...report, outputs: { summary: 'Ready.' } })
    await refuse('submitted')
  })

  it('allows deleting once the lease has lapsed, and after the attempt failed', async () => {
    const lapsed = await playedAndClaimed('Lapsed', 30)
    harness.clock.advanceSeconds(31)
    await desktop.deleteKanbanCard({ cardId: lapsed.cardId })
    expect(await codeOf(desktop.getKanbanCard({ cardId: lapsed.cardId }))).toBe('not_found')

    const failed = await playedAndClaimed('Failed')
    await orchestrator.failKanbanCard({ attemptId: failed.attemptId, claimToken: tokenOf(failed), reason: 'Gave up' })
    await desktop.deleteKanbanCard({ cardId: failed.cardId })
    expect(await codeOf(desktop.getKanbanCard({ cardId: failed.cardId }))).toBe('not_found')
  })
})

describe('deleteKanbanCard authority', () => {
  it('is the desktop only: every agent role is refused and the card stays', async () => {
    const card = await desktop.createKanbanCard({ title: 'Mine' })
    for (const role of ['orchestrator', 'planner', 'worker', 'reviewer', 'reader'] as const) {
      expect(await codeOf(harness.open(role).deleteKanbanCard({ cardId: card.id }))).toBe('unauthorized')
    }
    expect((await desktop.getKanbanCard({ cardId: card.id })).title).toBe('Mine')
    expect(existsSync(cardDir(card.id))).toBe(true)
  })
})
