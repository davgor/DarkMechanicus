/** Reconciling `kanban/<cardId>/` records: a fresh database rebuilds the board, and changed records never overwrite. */
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { claimedCard, doneCard, idsAfter, kanbanSessions, type KanbanSessions, submitCard, tokenOf } from '../../test/kanbanFixtures'
import { copyTracked, createRepoEnv, createStubGit, flush, importerDeps, initProject, type RepoEnv } from '../../test/repoEnv'
import { domainErrorOf } from '../../test/repoFixtures'
import { prettyJson } from '../canonical'
import {
  approveKanbanCard,
  claimKanbanCard,
  expireKanbanLeases,
  failKanbanCard,
  heartbeatKanbanCard,
  kickBackKanbanCard,
  playKanbanCard
} from '../services/kanban/attempts'
import { createKanbanCard, getKanbanCard, listKanbanCards, updateKanbanCard } from '../services/kanban/cards'
import type { ReconcileResultView } from '../../shared/domain/views'
import { reconcileRepository } from './importer'
import { ownedPaths } from './paths'

interface Machine {
  env: RepoEnv
  s: KanbanSessions
  machineId: string
}

const MACHINE_A = 'mc_0000000000000000000000000a'
const MACHINE_B = 'mc_0000000000000000000000000b'

/** The computer that starts the project. */
function machineA(): Machine {
  const env = createRepoEnv()
  initProject(env)
  return { env, s: kanbanSessions(env, { machineId: MACHINE_A }), machineId: MACHINE_A }
}

/** A second computer with a fresh database and ids that never collide with the first's. */
function machineB(): Machine {
  const env = createRepoEnv()
  return { env, s: kanbanSessions(env, { machineId: MACHINE_B, ids: idsAfter(1_000) }), machineId: MACHINE_B }
}

/** `from` exports its records, `to` pulls them and reconciles. */
function pull(from: Machine, to: Machine): ReconcileResultView {
  flush(from.env)
  copyTracked(from.env, to.env)
  return reconcile(to)
}

function reconcile(machine: Machine): ReconcileResultView {
  return reconcileRepository(importerDeps(machine.env, createStubGit('main'), machine.machineId))
}

function eventFile(machine: Machine, cardId: string, kind: string): string {
  const row = machine.env.db.get<{ id: string }>('SELECT id FROM kanban_events WHERE card_id = ? AND kind = ?', cardId, kind)
  return ownedPaths(machine.env.layout).kanbanEventFile(cardId, row?.id ?? '')
}

describe('importing Kanban records into a fresh database', () => {
  it('rebuilds the board and every card, then finds the records unchanged', () => {
    const a = machineA()
    const b = machineB()
    const done = doneCard(a.s)
    const open = claimedCard(a.s, 'Still open')
    const result = pull(a, b)
    expect([result.imported, result.rejected, result.kanbanConflicts]).toEqual([[`kanban:${done.cardId}`, `kanban:${open.cardId}`], [], []])
    expect(listKanbanCards(b.s.desktop, {})).toEqual(listKanbanCards(a.s.desktop, {}))
    for (const cardId of [done.cardId, open.cardId]) {
      expect(getKanbanCard(b.s.desktop, { cardId })).toEqual(getKanbanCard(a.s.desktop, { cardId }))
    }
    const again = reconcile(b)
    expect([again.imported, again.unchanged.filter((key) => key.startsWith('kanban:'))]).toEqual([[], [`kanban:${done.cardId}`, `kanban:${open.cardId}`]])
  })

  it('applies the transitions another computer made after the last import', () => {
    const a = machineA()
    const b = machineB()
    const packet = claimedCard(a.s)
    submitCard(a.s, packet)
    pull(a, b)
    expect(getKanbanCard(b.s.desktop, { cardId: packet.cardId }).lane).toBe('ready_for_review')
    a.env.clock.advanceSeconds(60)
    approveKanbanCard(a.s.desktop, { cardId: packet.cardId })
    expect(pull(a, b).imported).toEqual([`kanban:${packet.cardId}`])
    expect(getKanbanCard(b.s.desktop, { cardId: packet.cardId })).toEqual(getKanbanCard(a.s.desktop, { cardId: packet.cardId }))
  })

  it("takes another computer's approval of this computer's attempt, and keeps the attempt's claim secret", () => {
    const a = machineA()
    const b = machineB()
    const packet = claimedCard(a.s)
    submitCard(a.s, packet)
    pull(a, b)
    approveKanbanCard(b.s.desktop, { cardId: packet.cardId })
    const secret = a.env.db.get<{ claim_secret: string }>('SELECT claim_secret FROM kanban_attempts WHERE id = ?', packet.attemptId)
    expect(pull(b, a).imported).toEqual([`kanban:${packet.cardId}`])
    const card = getKanbanCard(a.s.desktop, { cardId: packet.cardId })
    expect([card.lane, card.attempts.map((attempt) => [attempt.state, attempt.machineId])]).toEqual(['done', [['accepted', MACHINE_A]]])
    expect(a.env.db.get('SELECT claim_secret FROM kanban_attempts WHERE id = ?', packet.attemptId)).toEqual(secret)
  })
})

describe('importing a card that failed, lapsed and was played again', () => {
  it('rebuilds each attempt and the pending Play exactly', () => {
    const a = machineA()
    const b = machineB()
    const first = claimedCard(a.s)
    a.env.clock.advanceSeconds(10)
    failKanbanCard(a.s.orchestrator, { attemptId: first.attemptId, claimToken: tokenOf(first), reason: 'The fixture server is down.' })
    playKanbanCard(a.s.desktop, { cardId: first.cardId })
    claimKanbanCard(a.s.orchestrator, { cardId: first.cardId, leaseSeconds: 60 })
    a.env.clock.advanceSeconds(61)
    expireKanbanLeases(a.s.desktop)
    playKanbanCard(a.s.desktop, { cardId: first.cardId })
    expect(pull(a, b).rejected).toEqual([])
    const imported = getKanbanCard(b.s.desktop, { cardId: first.cardId })
    expect(imported).toEqual(getKanbanCard(a.s.desktop, { cardId: first.cardId }))
    expect([imported.lane, imported.playPending, imported.attempts.map((attempt) => attempt.state)]).toEqual([
      'in_progress',
      true,
      ['failed', 'lease_expired']
    ])
  })
})

describe('Kanban records between two computers', () => {
  it('counts Plays pressed on both computers before they synced as one, which the claim consumes', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Pressed twice' })
    pull(a, b)
    playKanbanCard(a.s.desktop, { cardId: card.id })
    playKanbanCard(b.s.desktop, { cardId: card.id })
    pull(b, a)
    a.env.clock.advanceSeconds(30)
    const packet = claimKanbanCard(a.s.orchestrator, { cardId: card.id })
    pull(a, b)
    expect(getKanbanCard(b.s.desktop, { cardId: card.id })).toMatchObject({ playPending: false, openAttempt: { number: 1, state: 'claimed' } })
    failKanbanCard(a.s.orchestrator, { attemptId: packet.attemptId, claimToken: tokenOf(packet), reason: 'Stuck.' })
    pull(a, b)
    expect(getKanbanCard(b.s.desktop, { cardId: card.id }).playPending).toBe(false)
    expect(domainErrorOf(() => claimKanbanCard(b.s.orchestrator, { cardId: card.id })).code).toBe('play_required')
  })

  it('tells of an edit made on both computers before the local one is written over the other', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Original' })
    pull(a, b)
    updateKanbanCard(b.s.desktop, { cardId: card.id, expectedRevision: 1, title: 'B once' })
    updateKanbanCard(b.s.desktop, { cardId: card.id, expectedRevision: 2, title: 'B twice' })
    flush(b.env)
    copyTracked(b.env, a.env)
    updateKanbanCard(a.s.desktop, { cardId: card.id, expectedRevision: 1, title: 'A' })
    expect(flush(a.env).errors.join('\n')).toContain('holds a card record this machine has not imported')
    expect(reconcile(a).kanbanConflicts.map((conflict) => conflict.cardId)).toEqual([card.id])
    expect(flush(a.env).failed).toBe(0)
    expect(pull(a, b).kanbanConflicts).toEqual([])
    expect([getKanbanCard(a.s.desktop, { cardId: card.id }).title, getKanbanCard(b.s.desktop, { cardId: card.id }).title]).toEqual(['A', 'A'])
    expect(reconcile(a).kanbanConflicts).toEqual([])
  })

  it("refuses a card whose key a card made here already holds, naming both", () => {
    const a = machineA()
    const b = machineB()
    const theirs = createKanbanCard(a.s.desktop, { title: 'Made on A' })
    const mine = createKanbanCard(b.s.desktop, { title: 'Made on B' })
    expect(mine.key).toBe(theirs.key)
    const result = pull(a, b)
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/kanban/${theirs.id}`, message: expect.stringContaining(`has key ${theirs.key}, which card ${mine.id} already holds here`) }])
  })
})

describe('Kanban import conflicts', () => {
  it('keeps an event this computer holds when its tracked file says otherwise, and reports a conflict', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Immutable' })
    pull(a, b)
    const file = eventFile(b, card.id, 'created')
    const changed = { ...JSON.parse(b.env.fs.get(file) ?? '{}'), createdAt: '2025-01-01T00:00:00.000Z' }
    b.env.fs.put(file, prettyJson(changed))
    const result = reconcile(b)
    expect(result.kanbanConflicts).toHaveLength(1)
    expect(result.kanbanConflicts[0]?.cardId).toBe(card.id)
    expect(result.kanbanConflicts[0]?.message).toContain('already exists with different content')
    expect(getKanbanCard(b.s.desktop, { cardId: card.id }).createdAt).toBe(card.createdAt)
  })

  it('keeps a local edit waiting for export when the tracked card record changed too', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Original' })
    pull(a, b)
    updateKanbanCard(b.s.desktop, { cardId: card.id, expectedRevision: 1, title: 'Edited on B' })
    updateKanbanCard(a.s.desktop, { cardId: card.id, expectedRevision: 1, title: 'Edited on A' })
    const result = pull(a, b)
    expect(result.kanbanConflicts.map((conflict) => conflict.cardId)).toEqual([card.id])
    expect(result.kanbanConflicts[0]?.message).toContain('changed while local card changes are waiting to be exported')
    expect(getKanbanCard(b.s.desktop, { cardId: card.id }).title).toBe('Edited on B')
  })
})

describe('Kanban import rejections', () => {
  it('reports a linked kanban directory, reads it as empty, and goes on with the rest', () => {
    const a = machineA()
    const b = machineB()
    createKanbanCard(a.s.desktop, { title: 'Behind a link' })
    flush(a.env)
    copyTracked(a.env, b.env)
    b.env.fs.removeTree(b.env.layout.kanbanDir)
    b.env.fs.symlink(b.env.layout.kanbanDir, resolve('/outside'))
    const result = reconcile(b)
    expect(result.rejected.map((item) => item.path)).toEqual(['.darkmechanicus/kanban'])
    expect(result.rejected[0]?.message).toContain('symbolic links and junctions are not allowed')
    expect(listKanbanCards(b.s.desktop, {}).lanes.backlog).toEqual([])
  })

  it('rejects a card whose events name an attempt it never claimed, and imports nothing of it', () => {
    const a = machineA()
    const b = machineB()
    const packet = claimedCard(a.s)
    submitCard(a.s, packet)
    flush(a.env)
    copyTracked(a.env, b.env)
    b.env.fs.remove(eventFile(a, packet.cardId, 'claimed'))
    const result = reconcile(b)
    expect(result.rejected.map((item) => item.path)).toEqual([`.darkmechanicus/kanban/${packet.cardId}`])
    expect(result.rejected[0]?.message).toContain(`names attempt ${packet.attemptId}, which has no claimed event`)
    expect(b.env.db.all('SELECT id FROM kanban_cards')).toEqual([])
  })
})

describe('Kanban import rejections of record files', () => {
  it('rejects an event whose payload does not fit its kind, and holds back the whole card', () => {
    const a = machineA()
    const b = machineB()
    const packet = claimedCard(a.s)
    flush(a.env)
    copyTracked(a.env, b.env)
    const file = eventFile(a, packet.cardId, 'claimed')
    const record = JSON.parse(b.env.fs.get(file) ?? '{}')
    b.env.fs.put(file, prettyJson({ ...record, payload: { number: 1 } }))
    const result = reconcile(b)
    expect(result.rejected).toHaveLength(1)
    expect(result.rejected[0]?.path).toContain(`kanban/${packet.cardId}/events/`)
    expect(b.env.db.all('SELECT id FROM kanban_cards')).toEqual([])
  })

  it('rejects a card folder without card.json', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Headless' })
    flush(a.env)
    copyTracked(a.env, b.env)
    b.env.fs.remove(ownedPaths(b.env.layout).kanbanCardFile(card.id))
    const result = reconcile(b)
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/kanban/${card.id}`, message: expect.stringContaining('has no card.json') }])
  })
})

/** A valid id no machine of these tests ever makes. */
function strayId(kind: 'kanbanCard' | 'kanbanEvent'): string {
  return idsAfter(50_000).next(kind)
}

/** `from` exports its records and `to` receives them without reconciling yet. */
function copyFlushed(from: Machine, to: Machine): void {
  flush(from.env)
  copyTracked(from.env, to.env)
}

function rewriteRecord(machine: Machine, file: string, change: (record: Record<string, unknown>) => Record<string, unknown>): void {
  machine.env.fs.put(file, prettyJson(change(JSON.parse(machine.env.fs.get(file) ?? '{}'))))
}

function eventIdOf(machine: Machine, cardId: string, kind: string): string {
  return machine.env.db.get<{ id: string }>('SELECT id FROM kanban_events WHERE card_id = ? AND kind = ?', cardId, kind)?.id ?? ''
}

describe('Kanban import rejections of the folder layout', () => {
  it('reports a kanban path that is a file, and imports no card', () => {
    const a = machineA()
    const b = machineB()
    copyFlushed(a, b)
    b.env.fs.put(b.env.layout.kanbanDir, 'not a folder')
    const result = reconcile(b)
    expect(result.rejected).toEqual([{ path: '.darkmechanicus/kanban', message: expect.stringContaining('.darkmechanicus/kanban is not a directory') }])
    expect(b.env.db.all('SELECT id FROM kanban_cards')).toEqual([])
  })

  it('refuses a kanban directory listing more cards than the limit, unread', () => {
    const a = machineA()
    const b = machineB()
    createKanbanCard(a.s.desktop, { title: 'Crowded' })
    copyFlushed(a, b)
    b.env.fs.setReaddir(
      b.env.layout.kanbanDir,
      Array.from({ length: 10_001 }, (_, index) => `card-${index}`)
    )
    const result = reconcile(b)
    expect(result.rejected).toEqual([{ path: '.darkmechanicus/kanban', message: expect.stringContaining('holds more than 10000 cards') }])
    expect(b.env.db.all('SELECT id FROM kanban_cards')).toEqual([])
  })

  it('rejects a card entry that is a file, and imports the other cards', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Real card' })
    copyFlushed(a, b)
    const stray = strayId('kanbanCard')
    b.env.fs.put(ownedPaths(b.env.layout).kanbanCardDir(stray), '{}')
    const result = reconcile(b)
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/kanban/${stray}`, message: expect.stringContaining('is not a directory') }])
    expect(result.imported).toEqual([`kanban:${card.id}`])
  })
})

describe('Kanban import rejections of entries inside a card folder', () => {
  it('rejects an events entry that is a file', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Flat events' })
    copyFlushed(a, b)
    const eventsDir = ownedPaths(b.env.layout).kanbanEventsDir(card.id)
    b.env.fs.removeTree(eventsDir)
    b.env.fs.put(eventsDir, 'not a folder')
    const result = reconcile(b)
    expect(result.rejected).toEqual([
      { path: `.darkmechanicus/kanban/${card.id}`, message: expect.stringContaining(`kanban/${card.id}/events is not a directory`) }
    ])
    expect(b.env.db.all('SELECT id FROM kanban_cards')).toEqual([])
  })

  it('rejects a card.json that is a directory', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Folder for a file' })
    copyFlushed(a, b)
    const cardFile = ownedPaths(b.env.layout).kanbanCardFile(card.id)
    b.env.fs.remove(cardFile)
    b.env.fs.put(`${cardFile}/inner.json`, '{}')
    const result = reconcile(b)
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/kanban/${card.id}`, message: expect.stringContaining('card.json is not a regular file') }])
    expect(b.env.db.all('SELECT id FROM kanban_cards')).toEqual([])
  })

  it('rejects an event file the listing names but that is gone, under its own path', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Vanishing event' })
    copyFlushed(a, b)
    const missing = strayId('kanbanEvent')
    const eventsDir = ownedPaths(b.env.layout).kanbanEventsDir(card.id)
    b.env.fs.setReaddir(eventsDir, [...b.env.fs.readdir(eventsDir), `${missing}.json`])
    const result = reconcile(b)
    expect(result.rejected).toEqual([
      { path: `.darkmechanicus/kanban/${card.id}/events/${missing}.json`, message: expect.stringContaining(`${missing}.json is missing`) }
    ])
    expect(b.env.db.all('SELECT id FROM kanban_cards')).toEqual([])
  })
})

describe('Kanban import rejections of misplaced records', () => {
  it('rejects a card.json that names another card than its folder', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Misfiled' })
    copyFlushed(a, b)
    rewriteRecord(b, ownedPaths(b.env.layout).kanbanCardFile(card.id), (record) => ({ ...record, id: strayId('kanbanCard') }))
    const result = reconcile(b)
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/kanban/${card.id}`, message: expect.stringContaining('names a different card than its folder') }])
    expect(b.env.db.all('SELECT id FROM kanban_cards')).toEqual([])
  })

  it('rejects an event filed under another event id, and holds back the card', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Renamed event' })
    copyFlushed(a, b)
    const file = eventFile(a, card.id, 'created')
    const renamedId = strayId('kanbanEvent')
    b.env.fs.put(ownedPaths(b.env.layout).kanbanEventFile(card.id, renamedId), b.env.fs.get(file) ?? '')
    b.env.fs.remove(file)
    const result = reconcile(b)
    expect(result.rejected).toEqual([
      { path: `.darkmechanicus/kanban/${card.id}/events/${renamedId}.json`, message: expect.stringContaining('names a different event than its file name') }
    ])
    expect(b.env.db.all('SELECT id FROM kanban_cards')).toEqual([])
  })

  it("rejects an event filed in another card's folder", () => {
    const a = machineA()
    const b = machineB()
    const first = createKanbanCard(a.s.desktop, { title: 'Owner' })
    const second = createKanbanCard(a.s.desktop, { title: 'Wrong folder' })
    copyFlushed(a, b)
    const eventId = eventIdOf(a, first.id, 'created')
    b.env.fs.put(ownedPaths(b.env.layout).kanbanEventFile(second.id, eventId), b.env.fs.get(eventFile(a, first.id, 'created')) ?? '')
    const result = reconcile(b)
    expect(result.rejected).toEqual([
      { path: `.darkmechanicus/kanban/${second.id}/events/${eventId}.json`, message: expect.stringContaining('belongs to a different card than its folder') }
    ])
    expect(result.imported).toEqual([`kanban:${first.id}`])
  })
})

describe('Kanban import of attempt streams that do not add up', () => {
  it('rejects a card whose stream claims one attempt twice', () => {
    const a = machineA()
    const b = machineB()
    const packet = claimedCard(a.s)
    copyFlushed(a, b)
    const copyId = strayId('kanbanEvent')
    const claimed = JSON.parse(b.env.fs.get(eventFile(a, packet.cardId, 'claimed')) ?? '{}')
    b.env.fs.put(ownedPaths(b.env.layout).kanbanEventFile(packet.cardId, copyId), prettyJson({ ...claimed, id: copyId }))
    const result = reconcile(b)
    expect(result.rejected).toEqual([
      { path: `.darkmechanicus/kanban/${packet.cardId}`, message: expect.stringContaining(`claims attempt ${packet.attemptId} twice`) }
    ])
    expect(b.env.db.all('SELECT id FROM kanban_cards')).toEqual([])
  })

  it('rejects a card whose later event gives its attempt another number', () => {
    const a = machineA()
    const b = machineB()
    const packet = claimedCard(a.s)
    submitCard(a.s, packet)
    copyFlushed(a, b)
    rewriteRecord(b, eventFile(a, packet.cardId, 'submitted'), (record) => ({ ...record, payload: { ...(record.payload as object), number: 2 } }))
    const result = reconcile(b)
    expect(result.rejected).toEqual([
      { path: `.darkmechanicus/kanban/${packet.cardId}`, message: expect.stringContaining(`gives attempt ${packet.attemptId} two numbers`) }
    ])
    expect(b.env.db.all('SELECT id FROM kanban_attempts')).toEqual([])
  })

  it('rejects a card whose claim names an attempt another card holds here', () => {
    const a = machineA()
    const b = machineB()
    const [earlier, later] = [claimedCard(a.s, 'First'), claimedCard(a.s, 'Second')].sort((x, y) => x.cardId.localeCompare(y.cardId))
    copyFlushed(a, b)
    rewriteRecord(b, eventFile(a, later?.cardId ?? '', 'claimed'), (record) => ({ ...record, attemptId: earlier?.attemptId }))
    const result = reconcile(b)
    expect(result.rejected).toEqual([
      { path: `.darkmechanicus/kanban/${later?.cardId}`, message: expect.stringContaining(`Kanban attempt ${earlier?.attemptId} belongs to another card`) }
    ])
    expect(b.env.db.all('SELECT card_id FROM kanban_attempts')).toEqual([{ card_id: earlier?.cardId }])
  })
})

describe('Kanban import of streams this database holds differently', () => {
  it('rejects a card whose stored event this database can no longer read', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Corrupted here' })
    pull(a, b)
    const created = eventIdOf(b, card.id, 'created')
    b.env.db.run("UPDATE kanban_events SET payload_json = '{}' WHERE id = ?", created)
    playKanbanCard(a.s.desktop, { cardId: card.id })
    const result = pull(a, b)
    expect(result.rejected).toEqual([
      { path: `.darkmechanicus/kanban/${card.id}`, message: expect.stringContaining(`holds event ${created}, which is not a valid Kanban event`) }
    ])
    expect(getKanbanCard(b.s.desktop, { cardId: card.id }).playPending).toBe(false)
  })

  it('rejects events of a card whose definition this database marked synced but no longer holds', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Dropped here' })
    pull(a, b)
    b.env.db.run('DELETE FROM kanban_events WHERE card_id = ?', card.id)
    b.env.db.run('DELETE FROM kanban_cards WHERE id = ?', card.id)
    playKanbanCard(a.s.desktop, { cardId: card.id })
    const result = pull(a, b)
    expect(result.rejected).toEqual([{ path: `.darkmechanicus/kanban/${card.id}`, message: expect.stringContaining('has no imported card record') }])
    expect(b.env.db.all('SELECT id FROM kanban_events')).toEqual([])
  })
})

describe('Kanban import rebuilding attempts', () => {
  it('keeps the heartbeat-extended lease of an attempt this computer holds when another computer\'s events arrive', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Played on both computers' })
    pull(a, b)
    playKanbanCard(a.s.desktop, { cardId: card.id })
    playKanbanCard(b.s.desktop, { cardId: card.id })
    const packet = claimKanbanCard(b.s.orchestrator, { cardId: card.id, leaseSeconds: 60 })
    b.env.clock.advanceSeconds(30)
    heartbeatKanbanCard(b.s.orchestrator, { attemptId: packet.attemptId, claimToken: tokenOf(packet) })
    const leaseQuery = 'SELECT state, lease_expires_at, heartbeat_at FROM kanban_attempts WHERE id = ?'
    const extended = b.env.db.get<{ state: string; lease_expires_at: string; heartbeat_at: string }>(leaseQuery, packet.attemptId)
    expect(extended?.lease_expires_at).not.toBe(packet.leaseExpiresAt)
    expect(pull(a, b).imported).toEqual([`kanban:${card.id}`])
    expect(b.env.db.get(leaseQuery, packet.attemptId)).toEqual(extended)
    expect(extended?.state).toBe('running')
  })
})

describe('Kanban import of heartbeats, kick-backs and records already held', () => {
  it("takes another computer's heartbeat as running, with the lease its claim recorded", () => {
    const a = machineA()
    const b = machineB()
    const packet = claimedCard(a.s)
    pull(a, b)
    a.env.clock.advanceSeconds(120)
    heartbeatKanbanCard(a.s.orchestrator, { attemptId: packet.attemptId, claimToken: tokenOf(packet) })
    expect(pull(a, b).imported).toEqual([`kanban:${packet.cardId}`])
    expect(b.env.db.get('SELECT state, lease_expires_at FROM kanban_attempts WHERE id = ?', packet.attemptId)).toEqual({
      state: 'running',
      lease_expires_at: packet.leaseExpiresAt
    })
  })

  it('rebuilds a kick-back as a pending Play', () => {
    const a = machineA()
    const b = machineB()
    const packet = claimedCard(a.s)
    submitCard(a.s, packet)
    a.env.clock.advanceSeconds(30)
    kickBackKanbanCard(a.s.desktop, { cardId: packet.cardId, comment: 'Add the retry test.' })
    expect(pull(a, b).rejected).toEqual([])
    const imported = getKanbanCard(b.s.desktop, { cardId: packet.cardId })
    expect(imported).toEqual(getKanbanCard(a.s.desktop, { cardId: packet.cardId }))
    expect([imported.lane, imported.playPending, imported.attempts.map((attempt) => attempt.state)]).toEqual(['in_progress', true, ['rejected']])
  })

  it('marks event files synced again when they hold events this database already has', () => {
    const a = machineA()
    const b = machineB()
    const card = createKanbanCard(a.s.desktop, { title: 'Resynced' })
    playKanbanCard(a.s.desktop, { cardId: card.id })
    pull(a, b)
    const syncedEvents = "SELECT entity_id, imported_hash FROM sync_state WHERE kind = 'kanban_event' ORDER BY entity_id"
    const before = b.env.db.all(syncedEvents)
    b.env.db.run("DELETE FROM sync_state WHERE kind = 'kanban_event'")
    const result = reconcile(b)
    expect([result.imported, result.rejected, result.kanbanConflicts]).toEqual([[], [], []])
    expect(b.env.db.all(syncedEvents)).toEqual(before)
    expect(before).toHaveLength(2)
    expect(reconcile(b).unchanged).toContain(`kanban:${card.id}`)
  })
})
