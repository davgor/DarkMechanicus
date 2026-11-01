/**
 * Kanban cards in both storage modes, end to end through workspaces on scratch folders: in `repo` mode every card
 * travels as `kanban/<cardId>/card.json` plus one immutable event file per transition, and a clone rebuilds the same
 * board from them; in `db` mode the repository folder gains nothing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { KanbanPacket } from '../../shared/domain/kanban'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { kanbanCardRecord, kanbanEventRecord, parseRecord } from '../repo/portable'
import { dbProjectDir } from '../repo/storageMode'
import type { Workspace } from '../workspace'

let harness: Harness

beforeEach(() => {
  harness = createHarness()
})

afterEach(() => {
  harness.cleanup()
})

interface Sessions {
  desktop: Workspace
  orchestrator: Workspace
}

async function sessions(mode: 'repo' | 'db'): Promise<Sessions> {
  const desktop = harness.open('desktop', { mode })
  await desktop.initializeRepository({ name: 'kanban-records', keyPrefix: 'KR' })
  return { desktop, orchestrator: harness.open('orchestrator') }
}

function tokenOf(packet: KanbanPacket): string {
  if (packet.claimToken === null) {
    throw new Error('The claim returned no token.')
  }
  return packet.claimToken
}

/** The worker pastes the claim token into its report, as agents do; the stored report masks it. */
async function submitWithToken(orchestrator: Workspace, packet: KanbanPacket, summary: string): Promise<void> {
  const token = tokenOf(packet)
  await orchestrator.submitKanbanCard({
    attemptId: packet.attemptId,
    claimToken: token,
    outputs: { summary: `${summary} (claimed with ${token})`, commits: ['0123abc'] },
    evidence: { checks: [{ name: 'lint', status: 'passed', detail: `token ${token}` }], notes: token }
  })
}

/** Create, Play, claim, submit and approve: returns the card id and the claim token. */
async function cardToDone(s: Sessions): Promise<{ cardId: string; token: string }> {
  const card = await s.desktop.createKanbanCard({ title: 'Fix the flaky upload test', acceptanceCriteria: ['It passes'] })
  await s.desktop.playKanbanCard({ cardId: card.id })
  const packet = await s.orchestrator.claimKanbanCard({ cardId: card.id })
  await submitWithToken(s.orchestrator, packet, 'Made the upload test wait for the server.')
  await s.desktop.approveKanbanCard({ cardId: card.id })
  return { cardId: card.id, token: tokenOf(packet) }
}

/** Every file under `dir`, recursively, relative to it. */
function filesUnder(dir: string, prefix = ''): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const path = join(dir, entry)
      const shown = `${prefix}${entry}`
      return statSync(path).isDirectory() ? filesUnder(path, `${shown}/`) : [shown]
    })
}

function recordsDir(root = harness.root): string {
  return join(root, '.darkmechanicus')
}

describe('Kanban records in repo mode', () => {
  it('writes card.json and one event file per transition, and no file holds the claim secret', async () => {
    const s = await sessions('repo')
    const { cardId, token } = await cardToDone(s)
    const cardDir = join(recordsDir(), 'kanban', cardId)
    const card = parseRecord(kanbanCardRecord, readFileSync(join(cardDir, 'card.json'), 'utf8'), 'card.json')
    expect(card).toMatchObject({ format: 'darkmechanicus.kanban-card', formatVersion: 1, id: cardId, key: 'KR-1', generation: 1 })
    const eventFiles = readdirSync(join(cardDir, 'events')).sort()
    const kinds = eventFiles.map((name) => {
      const event = parseRecord(kanbanEventRecord, readFileSync(join(cardDir, 'events', name), 'utf8'), name)
      expect([event.format, event.cardId, `${event.id}.json`]).toEqual(['darkmechanicus.kanban-event', cardId, name])
      return event.kind
    })
    expect(kinds).toEqual(['created', 'played', 'claimed', 'submitted', 'approved'])
    const secret = token.slice(token.indexOf('.') + 1)
    const tracked = filesUnder(recordsDir()).filter((path) => !path.startsWith('local/'))
    expect(tracked.filter((path) => path.startsWith('kanban/'))).toHaveLength(6)
    for (const path of tracked) {
      const text = readFileSync(join(recordsDir(), path), 'utf8')
      expect([path, text.includes(secret)]).toEqual([path, false])
    }
    expect((await s.desktop.getStorageStatus()).outbox).toEqual({ pending: 0, failed: 0, lastError: null })
  })
})

describe('Kanban cards in db mode', () => {
  it('writes nothing under the repository, and the board still lists the card in Done', async () => {
    const s = await sessions('db')
    const { cardId } = await cardToDone(s)
    expect(readdirSync(harness.root)).toEqual([])
    const projectDir = dbProjectDir(harness.root, harness.homeDir)
    expect(existsSync(join(projectDir, 'kanban'))).toBe(false)
    expect(filesUnder(projectDir).filter((path) => !path.startsWith('local/'))).toEqual(['project.json'])
    const board = await s.desktop.listKanbanCards({})
    expect([board.lanes.done.map((card) => card.id), board.doneTotal]).toEqual([[cardId], 1])
    expect(board.lanes.done[0]?.summary?.outcome).toMatch(/^Made the upload test wait for the server\./)
    expect((await s.desktop.getStorageStatus()).outbox).toEqual({ pending: 0, failed: 0, lastError: null })
  })
})

/** A card edited, kicked back once and approved, and a second card claimed and still open. */
async function richBoard(s: Sessions): Promise<{ done: string; open: KanbanPacket }> {
  const card = await s.desktop.createKanbanCard({ title: 'Ship the export', body: 'Write it.', priority: 'high' })
  await s.desktop.updateKanbanCard({ cardId: card.id, expectedRevision: 1, body: 'Write it carefully.' })
  await s.desktop.playKanbanCard({ cardId: card.id })
  const first = await s.orchestrator.claimKanbanCard({ cardId: card.id, leaseSeconds: 600 })
  harness.clock.advanceSeconds(30)
  await s.orchestrator.heartbeatKanbanCard({ attemptId: first.attemptId, claimToken: tokenOf(first) })
  await submitWithToken(s.orchestrator, first, 'First try.')
  await s.desktop.kickBackKanbanCard({ cardId: card.id, comment: 'Cover the empty export too.' })
  harness.clock.advanceSeconds(30)
  const second = await s.orchestrator.claimKanbanCard({ cardId: card.id })
  await submitWithToken(s.orchestrator, second, 'Covered the empty export.')
  harness.clock.advanceSeconds(30)
  await s.desktop.approveKanbanCard({ cardId: card.id })
  const other = await s.desktop.createKanbanCard({ title: 'Still running' })
  await s.desktop.playKanbanCard({ cardId: other.id })
  const open = await s.orchestrator.claimKanbanCard({ cardId: other.id })
  return { done: card.id, open }
}

describe('importing Kanban records into a fresh database', () => {
  it('rebuilds the same board and the same cards from the records', async () => {
    const s = await sessions('repo')
    const { done, open } = await richBoard(s)
    const clone = harness.open('desktop', { root: harness.cloneTracked() })
    expect(await clone.listKanbanCards({})).toEqual(await s.desktop.listKanbanCards({}))
    for (const cardId of [done, open.cardId]) {
      expect(await clone.getKanbanCard({ cardId })).toEqual(await s.desktop.getKanbanCard({ cardId }))
    }
    const reconciled = await clone.reconcileRepository()
    expect([reconciled.imported, reconciled.rejected, reconciled.kanbanConflicts]).toEqual([[], [], []])
  })

  it('keeps an open attempt from another computer, which this computer refuses to report on', async () => {
    const s = await sessions('repo')
    const { open } = await richBoard(s)
    const cloneRoot = harness.cloneTracked()
    const cloneAgent = harness.open('orchestrator', { root: cloneRoot })
    const original = await s.desktop.getKanbanCard({ cardId: open.cardId })
    const imported = await cloneAgent.getKanbanCard({ cardId: open.cardId })
    const machineFile = readFileSync(join(recordsDir(cloneRoot), 'local', 'machine.json'), 'utf8')
    const cloneMachine = z.object({ machineId: z.string() }).parse(JSON.parse(machineFile)).machineId
    expect(imported.attempts[0]?.machineId).toBe(original.attempts[0]?.machineId)
    expect(imported.attempts[0]?.machineId).not.toBe(cloneMachine)
    expect(imported.openAttempt).toEqual({ number: 1, state: 'claimed' })
    const report = { attemptId: open.attemptId, claimToken: tokenOf(open) }
    await expect(cloneAgent.heartbeatKanbanCard(report)).rejects.toMatchObject({ code: 'card_not_owned' })
    await expect(cloneAgent.failKanbanCard({ ...report, reason: 'Not mine' })).rejects.toMatchObject({ code: 'card_not_owned' })
    // The computer that claimed it still reports on it.
    expect((await s.orchestrator.heartbeatKanbanCard(report)).state).toBe('running')
  })
})
