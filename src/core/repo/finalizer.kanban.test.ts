/** Flushing Kanban cards into `kanban/<cardId>/`: card.json by generation, event files once and never rewritten. */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claimedCard, doneCard, kanbanSessions, type KanbanSessions, submitCard, tokenOf } from '../../test/kanbanFixtures'
import { createRepoEnv, flush, type RepoEnv } from '../../test/repoEnv'
import { idOf } from '../../test/repoFixtures'
import { prettyJson } from '../canonical'
import { playKanbanCard } from '../services/kanban/attempts'
import { createKanbanCard, updateKanbanCard } from '../services/kanban/cards'
import { flushOutbox } from './finalizer'
import { ownedPaths } from './paths'
import {
  buildKanbanCardRecord,
  buildKanbanEventRecord,
  kanbanCardRecord,
  kanbanEventRecord,
  parseRecord,
  trackedKanbanCardHash,
  trackedKanbanEventHash
} from './portable'

function setup(): { env: RepoEnv; s: KanbanSessions } {
  const env = createRepoEnv()
  return { env, s: kanbanSessions(env) }
}

function eventIds(env: RepoEnv, cardId: string): string[] {
  return env.db.all<{ id: string }>('SELECT id FROM kanban_events WHERE card_id = ? ORDER BY rowid', cardId).map((row) => row.id)
}

function pendingKinds(env: RepoEnv): string[] {
  return env.db.all<{ kind: string }>("SELECT kind FROM outbox WHERE state <> 'done' ORDER BY id").map((row) => row.kind)
}

function syncRow(env: RepoEnv, kind: string, entityId: string): unknown {
  return env.db.get('SELECT exported_hash, imported_hash, generation, conflict FROM sync_state WHERE kind = ? AND entity_id = ?', kind, entityId)
}

describe('flushOutbox Kanban exports', () => {
  it('writes card.json and one event file per transition, recording each exported hash', () => {
    const { env, s } = setup()
    const packet = doneCard(s)
    expect(flush(env)).toMatchObject({ flushed: 6, failed: 0, errors: [] })
    const paths = ownedPaths(env.layout)
    const cardText = env.fs.get(paths.kanbanCardFile(packet.cardId)) ?? ''
    expect(cardText).toBe(prettyJson(buildKanbanCardRecord(env.db, packet.cardId, { generation: 1 })))
    expect(parseRecord(kanbanCardRecord, cardText, 'card')).toMatchObject({ id: packet.cardId, title: 'Fix the flaky upload test', generation: 1 })
    expect(syncRow(env, 'kanban_card', packet.cardId)).toEqual({ exported_hash: trackedKanbanCardHash(cardText), imported_hash: null, generation: 1, conflict: null })
    const kinds = eventIds(env, packet.cardId).map((eventId) => {
      const text = env.fs.get(paths.kanbanEventFile(packet.cardId, eventId)) ?? ''
      expect(syncRow(env, 'kanban_event', eventId)).toMatchObject({ exported_hash: trackedKanbanEventHash(text) })
      return parseRecord(kanbanEventRecord, text, eventId).kind
    })
    expect(kinds).toEqual(['created', 'played', 'claimed', 'submitted', 'approved'])
    expect(pendingKinds(env)).toEqual([])
  })

  it('rewrites card.json at the next generation when the card is edited, and not on a transition', () => {
    const { env, s } = setup()
    const card = createKanbanCard(s.desktop, { title: 'Draft' })
    flush(env)
    updateKanbanCard(s.desktop, { cardId: card.id, expectedRevision: 1, title: 'Final' })
    flush(env)
    const file = ownedPaths(env.layout).kanbanCardFile(card.id)
    expect(parseRecord(kanbanCardRecord, env.fs.get(file) ?? '', 'card')).toMatchObject({ title: 'Final', generation: 2 })
    const writes = env.fs.writes.filter((path) => path === resolve(file)).length
    claimedCard(s, 'Another card')
    flush(env)
    expect(env.fs.writes.filter((path) => path === resolve(file))).toHaveLength(writes)
  })

  it('never writes the claim secret, even one that reached an event payload', () => {
    const { env, s } = setup()
    const packet = claimedCard(s)
    const secret = tokenOf(packet).split('.')[1] ?? ''
    submitCard(s, packet, `Done with ${tokenOf(packet)}`)
    // A payload that leaked the bare secret through some path the services did not mask.
    env.db.run("UPDATE kanban_events SET payload_json = json_set(payload_json, '$.outputs.summary', ?) WHERE kind = 'submitted'", `held ${secret}`)
    expect(flush(env).failed).toBe(0)
    const texts = [...env.fs.files().values()]
    expect(texts.filter((text) => text.includes(secret))).toEqual([])
    const submitted = eventIds(env, packet.cardId).map((eventId) => buildKanbanEventRecord(env.db, eventId)).find((event) => event.kind === 'submitted')
    expect(submitted?.payload).toMatchObject({ outputs: { summary: 'held [claim token masked]' } })
  })
})

describe('flushOutbox Kanban immutability', () => {
  it('reports an existing event file with different content as a conflict and leaves it unchanged', () => {
    const { env, s } = setup()
    const card = createKanbanCard(s.desktop, { title: 'Immutable' })
    const [created] = eventIds(env, card.id)
    const file = ownedPaths(env.layout).kanbanEventFile(card.id, created ?? '')
    const foreign = prettyJson({ ...buildKanbanEventRecord(env.db, created ?? ''), createdAt: '2025-01-01T00:00:00.000Z' })
    env.fs.put(file, foreign)
    const outcome = flush(env)
    expect(outcome.failed).toBe(1)
    expect(outcome.errors[0]).toContain('already exists with different content; Kanban events are never rewritten')
    expect(env.fs.get(file)).toBe(foreign)
    expect(syncRow(env, 'kanban_event', created ?? '')).toBeUndefined()
    // Later events of the card wait behind it, so the card's records are never written out of order.
    playKanbanCard(s.desktop, { cardId: card.id })
    expect(flush(env).errors).toHaveLength(1)
    expect(pendingKinds(env)).toEqual(['kanban_event', 'kanban_event'])
  })

  it('keeps an identical event file without rewriting it', () => {
    const { env, s } = setup()
    const card = createKanbanCard(s.desktop, { title: 'Interrupted' })
    const [created] = eventIds(env, card.id)
    const file = ownedPaths(env.layout).kanbanEventFile(card.id, created ?? '')
    const existing = prettyJson(buildKanbanEventRecord(env.db, created ?? '')).replace(/\n/g, '\r\n')
    env.fs.put(file, existing)
    expect(flush(env).failed).toBe(0)
    expect(env.fs.writes).not.toContain(resolve(file))
    expect(syncRow(env, 'kanban_event', created ?? '')).toMatchObject({ exported_hash: trackedKanbanEventHash(existing) })
  })
})

describe('flushOutbox Kanban card generations', () => {
  it('refuses to write over a card record this machine has not imported, and leaves it unchanged', () => {
    const { env, s } = setup()
    const card = createKanbanCard(s.desktop, { title: 'Mine' })
    const file = ownedPaths(env.layout).kanbanCardFile(card.id)
    const foreign = prettyJson({ ...buildKanbanCardRecord(env.db, card.id, { generation: 1 }), title: 'Edited elsewhere' })
    env.fs.put(file, foreign)
    const outcome = flush(env)
    expect(outcome.errors[0]).toContain(`kanban_card ${card.id}: `)
    expect(outcome.errors[0]).toContain('holds a card record this machine has not imported')
    expect(env.fs.get(file)).toBe(foreign)
    expect(pendingKinds(env)).toEqual(['kanban_card', 'kanban_event'])
  })

  it('writes over a record a reconcile noted as seen, past its generation', () => {
    const { env, s } = setup()
    const card = createKanbanCard(s.desktop, { title: 'Mine' })
    const file = ownedPaths(env.layout).kanbanCardFile(card.id)
    const foreign = prettyJson({ ...buildKanbanCardRecord(env.db, card.id, { generation: 3 }), title: 'Edited elsewhere' })
    env.fs.put(file, foreign)
    const seen = "INSERT INTO sync_state (kind, entity_id, generation, imported_hash, conflict, updated_at) VALUES ('kanban_card', ?, 3, ?, 'seen', 'x')"
    env.db.run(seen, card.id, trackedKanbanCardHash(foreign))
    expect(flush(env).failed).toBe(0)
    expect(parseRecord(kanbanCardRecord, env.fs.get(file) ?? '', 'card')).toMatchObject({ title: 'Mine', generation: 4 })
    expect(syncRow(env, 'kanban_card', card.id)).toMatchObject({ imported_hash: null, generation: 4, conflict: null })
  })
})

describe('flushOutbox Kanban path safety and scope', () => {
  it('refuses to write through a linked kanban directory with unsafe_path', () => {
    const { env, s } = setup()
    createKanbanCard(s.desktop, { title: 'Contained' })
    env.fs.put(resolve('/outside/keep.txt'), 'x')
    env.fs.symlink(env.layout.kanbanDir, resolve('/outside'))
    const outcome = flush(env)
    expect(outcome.errors[0]).toContain('Unsafe repository path .darkmechanicus/kanban: symbolic links and junctions are not allowed')
    expect(env.fs.writes.filter((path) => path.startsWith(resolve('/outside')))).toEqual([])
    expect([...env.fs.files().keys()].filter((path) => path.startsWith(resolve('/outside')))).toEqual([resolve('/outside/keep.txt')])
  })

  it('leaves Kanban entries pending in an epic-scoped flush, and writes them in an unscoped one', () => {
    const { env, s } = setup()
    const card = createKanbanCard(s.desktop, { title: 'Not an epic record' })
    const scoped = flushOutbox(env, env.hook, { epicId: idOf('epic', 1) })
    expect([scoped.flushed, pendingKinds(env)]).toEqual([0, ['kanban_card', 'kanban_event']])
    expect(env.fs.get(ownedPaths(env.layout).kanbanCardFile(card.id))).toBeUndefined()
    expect(flush(env).flushed).toBe(2)
    expect(pendingKinds(env)).toEqual([])
    expect(env.fs.get(ownedPaths(env.layout).kanbanCardFile(card.id))).toBeDefined()
  })
})

describe('flushOutbox Kanban records it does not write', () => {
  it('refuses an event record over the 8 MiB limit, leaving no file and the entry pending', () => {
    const { env, s } = setup()
    const packet = claimedCard(s)
    submitCard(s, packet)
    const changedFiles = Array.from({ length: 4_500 }, (_, index) => `${String(index).padStart(6, '0')}${'x'.repeat(1_990)}`)
    env.db.run("UPDATE kanban_events SET payload_json = json_set(payload_json, '$.outputs.changedFiles', json(?)) WHERE kind = 'submitted'", JSON.stringify(changedFiles))
    const submitted = eventIds(env, packet.cardId)[3] ?? ''
    const outcome = flush(env)
    expect(outcome.failed).toBe(1)
    expect(outcome.errors[0]).toContain(`kanban/${packet.cardId}/events/${submitted}.json would be larger than the 8 MiB record limit, so it is not written`)
    expect(env.fs.get(ownedPaths(env.layout).kanbanEventFile(packet.cardId, submitted))).toBeUndefined()
    expect(pendingKinds(env)).toEqual(['kanban_event'])
  })

  it('keeps a card.json that already holds the exported text without rewriting it', () => {
    const { env, s } = setup()
    const card = createKanbanCard(s.desktop, { title: 'Already there' })
    const file = ownedPaths(env.layout).kanbanCardFile(card.id)
    const text = prettyJson(buildKanbanCardRecord(env.db, card.id, { generation: 1 }))
    env.fs.put(file, text)
    expect(flush(env)).toMatchObject({ flushed: 2, failed: 0 })
    expect(env.fs.writes).not.toContain(resolve(file))
    expect(syncRow(env, 'kanban_card', card.id)).toEqual({ exported_hash: trackedKanbanCardHash(text), imported_hash: null, generation: 1, conflict: null })
  })

  it('holds back an event while the checkout has no card.json for its card', () => {
    const { env, s } = setup()
    const card = createKanbanCard(s.desktop, { title: 'Other branch' })
    flush(env)
    env.fs.remove(ownedPaths(env.layout).kanbanCardFile(card.id))
    playKanbanCard(s.desktop, { cardId: card.id })
    const played = eventIds(env, card.id)[1] ?? ''
    const outcome = flush(env)
    expect(outcome.errors).toEqual([expect.stringContaining(`Kanban event ${played} is not exported: the record of card ${card.id} is not in this checkout.`)])
    expect(env.fs.get(ownedPaths(env.layout).kanbanEventFile(card.id, played))).toBeUndefined()
    expect(pendingKinds(env)).toEqual(['kanban_event'])
  })
})
