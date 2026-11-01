/** Kanban cards driven through their services on a test database, for the record export and import tests. Not shipped. */
import { approveKanbanCard, claimKanbanCard, playKanbanCard, submitKanbanCard } from '../core/services/kanban/attempts'
import { createKanbanCard } from '../core/services/kanban/cards'
import type { Db } from '../core/db/database'
import type { IdGenerator } from '../core/ids'
import type { KanbanPacket } from '../shared/domain/kanban'
import { createSequentialIds, createTestCtx, type TestClock, type TestCtx, withRole } from './testContext'

/** The person at the desktop and the orchestrator that claims, on one machine's database. */
export interface KanbanSessions {
  desktop: TestCtx
  orchestrator: TestCtx
}

interface SessionOptions {
  machineId?: string
  ids?: IdGenerator
}

export function kanbanSessions(env: { db: Db; clock: TestClock }, options: SessionOptions = {}): KanbanSessions {
  const desktop = createTestCtx({ db: env.db, clock: env.clock, role: 'desktop', machineId: options.machineId, ids: options.ids })
  return { desktop, orchestrator: withRole(desktop, 'orchestrator') }
}

/** Sequential ids that start after `skip` ids, so a second machine's ids never collide with the first's. */
export function idsAfter(skip: number): IdGenerator {
  const ids = createSequentialIds()
  for (let index = 0; index < skip; index += 1) {
    ids.next('kanbanEvent')
  }
  return ids
}

export function tokenOf(packet: KanbanPacket): string {
  if (packet.claimToken === null) {
    throw new Error('The claim returned no token.')
  }
  return packet.claimToken
}

/** A card created, played and claimed: its packet. */
export function claimedCard(s: KanbanSessions, title = 'Fix the flaky upload test'): KanbanPacket {
  const card = createKanbanCard(s.desktop, { title, acceptanceCriteria: ['It passes'] })
  playKanbanCard(s.desktop, { cardId: card.id })
  return claimKanbanCard(s.orchestrator, { cardId: card.id })
}

export function submitCard(s: KanbanSessions, packet: KanbanPacket, summary = 'Made the upload test wait for the server.'): void {
  submitKanbanCard(s.orchestrator, {
    attemptId: packet.attemptId,
    claimToken: tokenOf(packet),
    outputs: { summary, commits: ['0123abc'] },
    evidence: { checks: [{ name: 'lint', status: 'passed', detail: '' }], criteria: [{ criterionId: 'c1', met: true, note: 'ok' }] }
  })
}

/** A card carried from Backlog to Done: create, Play, claim, submit, approve. Returns its claim packet. */
export function doneCard(s: KanbanSessions, title?: string): KanbanPacket {
  const packet = claimedCard(s, title)
  submitCard(s, packet)
  approveKanbanCard(s.desktop, { cardId: packet.cardId })
  return packet
}
