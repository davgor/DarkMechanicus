/** Building Kanban card and event records from the database for export. */
import { describe, expect, it } from 'vitest'
import { idsAfter, kanbanSessions } from '../../test/kanbanFixtures'
import { createRepoEnv } from '../../test/repoEnv'
import { domainErrorOf } from '../../test/repoFixtures'
import { createKanbanCard } from '../services/kanban/cards'
import { buildKanbanCardRecord, buildKanbanEventRecord } from './portable'

describe('Kanban record builders', () => {
  it('refuses a card this database does not hold with not_found', () => {
    const env = createRepoEnv()
    const cardId = idsAfter(50_000).next('kanbanCard')
    const error = domainErrorOf(() => buildKanbanCardRecord(env.db, cardId, { generation: 1 }))
    expect([error.code, error.message]).toEqual(['not_found', `Kanban card ${cardId} does not exist.`])
  })

  it('refuses an event this database does not hold with not_found', () => {
    const env = createRepoEnv()
    const eventId = idsAfter(50_000).next('kanbanEvent')
    const error = domainErrorOf(() => buildKanbanEventRecord(env.db, eventId))
    expect([error.code, error.message]).toEqual(['not_found', `Kanban event ${eventId} does not exist.`])
  })

  it('dates the definition at the card creation when no create or edit event is held', () => {
    const env = createRepoEnv()
    const s = kanbanSessions(env)
    const card = createKanbanCard(s.desktop, { title: 'Eventless' })
    env.clock.advanceSeconds(90)
    env.db.run("UPDATE kanban_cards SET updated_at = ? WHERE id = ?", env.clock.nowIso(), card.id)
    env.db.run('DELETE FROM kanban_events WHERE card_id = ?', card.id)
    const record = buildKanbanCardRecord(env.db, card.id, { generation: 2 })
    expect([record.createdAt, record.updatedAt, record.generation]).toEqual([card.createdAt, card.createdAt, 2])
  })
})
