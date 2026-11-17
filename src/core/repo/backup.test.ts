import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { domainErrorOf, idOf, insertEpic } from '../../test/repoFixtures'
import { createTempRepo, type TempRepo } from '../../test/tempRepo'
import { createTestClock, createTestCtx, createTestDb } from '../../test/testContext'
import { openDatabase, type Db } from '../db/database'
import { readSchemaVersion, SCHEMA_VERSION } from '../db/migrations'
import {
  acceptMessage,
  acknowledgeMessages,
  getEndpoint,
  markHumanSeen,
  provisionEndpoint,
  readHumanMailState,
  readInbox
} from '../services/agentMailStore'
import { backupDatabase } from './backup'
import { nodeFs } from './nodeFs'

let repo: TempRepo
const opened: Db[] = []

beforeEach(() => {
  repo = createTempRepo()
})

afterEach(() => {
  for (const db of opened.splice(0)) {
    db.close()
  }
  repo.cleanup()
})

function sourceDb(): Db {
  const db = createTestDb()
  opened.push(db)
  insertEpic(db, { id: idOf('epic', 1), title: 'Backed up' })
  return db
}

function open(path: string): Db {
  const db = openDatabase(path)
  opened.push(db)
  return db
}

describe('backupDatabase', () => {
  it('writes a consistent snapshot under local/backups by default', () => {
    const db = sourceDb()
    const clock = createTestClock('2026-03-04T05:06:07.890Z')
    const result = backupDatabase({ db, layout: repo.layout, fs: nodeFs, clock })
    expect(result).toEqual({ path: join(repo.layout.localDir, 'backups', 'state-2026-03-04T05-06-07.890Z.sqlite') })
    const copy = open(result.path)
    expect(copy.all('SELECT id, title FROM epics')).toEqual([{ id: idOf('epic', 1), title: 'Backed up' }])
    expect(readSchemaVersion(copy)).toBe(SCHEMA_VERSION)
  })

  it('writes to an explicit target, creating its directory', () => {
    const db = sourceDb()
    const target = join(repo.outside, 'nested', 'copy.sqlite')
    expect(backupDatabase({ db, layout: repo.layout, fs: nodeFs, clock: createTestClock() }, target)).toEqual({ path: target })
    expect(open(target).get('SELECT COUNT(*) AS count FROM epics')).toEqual({ count: 1 })
  })

  it('refuses to overwrite an existing file', () => {
    const db = sourceDb()
    const target = join(repo.outside, 'existing.sqlite')
    writeFileSync(target, 'keep me')
    const error = domainErrorOf(() => backupDatabase({ db, layout: repo.layout, fs: nodeFs, clock: createTestClock() }, target))
    expect(error.code).toBe('conflict')
    expect(error.message).toContain('already exists')
    const deps = { db, layout: repo.layout, fs: nodeFs, clock: createTestClock() }
    backupDatabase(deps)
    expect(domainErrorOf(() => backupDatabase(deps)).code).toBe('conflict')
  })

  it('refuses to run inside a transaction', () => {
    const db = sourceDb()
    const target = join(repo.outside, 'in-tx.sqlite')
    const error = db.tx(() => domainErrorOf(() => backupDatabase({ db, layout: repo.layout, fs: nodeFs, clock: createTestClock() }, target)))
    expect(error.code).toBe('internal')
    expect(existsSync(target)).toBe(false)
  })
})

describe('backupDatabase with local agent mail', () => {
  it('copies local agent mail, so a restored copy keeps endpoints, messages, acknowledgements and the seen cursor', () => {
    const db = sourceDb()
    const ctx = createTestCtx({ db })
    const a = provisionEndpoint(ctx, { machineId: ctx.machineId, chatId: 'chat-a', name: 'Planner' })
    const b = provisionEndpoint(ctx, { machineId: ctx.machineId, chatId: 'chat-b', name: 'Worker' })
    const acked = acceptMessage(ctx, { senderEndpointId: a.id, to: b.id, clientMessageId: 'm-1', body: 'acknowledged' })
    acceptMessage(ctx, { senderEndpointId: a.id, to: b.id, clientMessageId: 'm-2', body: 'pending' })
    acknowledgeMessages(ctx, { endpointId: b.id, messageIds: [acked.messageId] })
    markHumanSeen(ctx, { endpointId: b.id, throughSeq: 1 })

    const target = join(repo.outside, 'with-mail.sqlite')
    backupDatabase({ db, layout: repo.layout, fs: nodeFs, clock: ctx.clock }, target)
    const restored = createTestCtx({ db: open(target), clock: ctx.clock })
    expect(getEndpoint(restored, b.id)).toEqual(getEndpoint(ctx, b.id))
    expect(readInbox(restored, { endpointId: b.id })).toEqual(readInbox(ctx, { endpointId: b.id }))
    expect(readHumanMailState(restored, b.id)).toMatchObject({ humanSeenSeq: 1, pendingCount: 1, retainedCount: 2 })
    // The restored copy carries the sender's receipts too: a retry replays rather than delivering twice.
    expect(acceptMessage(restored, { senderEndpointId: a.id, to: b.id, clientMessageId: 'm-1', body: 'acknowledged' })).toMatchObject({
      messageId: acked.messageId,
      duplicate: true
    })
  })
})
