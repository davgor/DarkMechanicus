import { afterEach, beforeEach, expect, it } from 'vitest'
import { baselineDeliveryPolicy } from '../../shared/domain/standardsPrompts'
import { createHarness, type Harness } from '../../test/workspaceHarness'
import { openDatabase } from '../db/database'
import type { Workspace } from '../workspace'

let harness: Harness
let desktop: Workspace

beforeEach(async () => {
  harness = createHarness()
  desktop = harness.open('desktop')
  await desktop.initializeRepository({ name: 'Concurrent Kanban review' })
})

afterEach(() => harness.cleanup())

it.each(['no claim', 'live local claim', 'overdue foreign claim', 'submitted evidence'] as const)(
  'reads preserved card evidence after standardization while another connection writes: %s',
  async (state) => {
    const card = await desktop.createKanbanCard({ title: 'Review preserved evidence', body: 'Keep the original requirements.' })
    if (state !== 'no claim') {
      await desktop.playKanbanCard({ cardId: card.id })
      const packet = await harness.open('orchestrator').claimKanbanCard({ cardId: card.id, leaseSeconds: 60 })
      if (state === 'submitted evidence') {
        if (packet.claimToken === null) throw new Error('A first claim must return its token.')
        await harness.open('worker').submitKanbanCard({
          attemptId: packet.attemptId, claimToken: packet.claimToken,
          outputs: { summary: 'Preserve the completed repair.', commits: ['abc123'] },
          evidence: { checks: [{ name: 'regression', status: 'passed', detail: 'Original evidence' }] }
        })
      }
      if (state === 'overdue foreign claim') {
        desktop.ctx().db.run('UPDATE kanban_attempts SET machine_id = ? WHERE id = ?', 'another-machine', packet.attemptId)
        harness.clock.advanceSeconds(61)
      }
    }
    await desktop.setDeliveryStandards({ expectedRevision: 0, policy: baselineDeliveryPolicy })
    const inventory = await desktop.standardizeProjectWork({ expectedRevision: 1, includeInProgress: true })
    expect(inventory.items).toMatchObject([{ id: card.id, disposition: 'pending' }])
    const preserved = await desktop.getKanbanCard({ cardId: card.id })
    const reader = harness.open('reader')
    // An actual second SQLite connection holds the WAL writer. Reads must not request its lock merely to sweep no leases.
    const writer = openDatabase(reader.ctx().db.path, { busyTimeoutMs: 0, beginRetries: 0, synchronous: 'off' })
    reader.ctx().db.exec('PRAGMA busy_timeout = 0')
    try {
      writer.exec('BEGIN IMMEDIATE')
      writer.run('UPDATE kanban_cards SET body = ? WHERE id = ?', 'Uncommitted requirements', card.id)
      expect(await reader.getKanbanCard({ cardId: card.id })).toEqual(preserved)
      const board = await reader.listKanbanCards({})
      expect([...board.lanes.backlog, ...board.lanes.in_progress, ...board.lanes.ready_for_review])
        .toContainEqual(expect.objectContaining({ id: card.id }))
    } finally {
      writer.exec('ROLLBACK')
      writer.close()
    }
    expect(await desktop.getKanbanCard({ cardId: card.id })).toEqual(preserved)
  }
)
