import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { domainErrorOf } from '../../test/repoFixtures'
import { removeScratch } from '../../test/removeScratch'
import { createTestClock, createTestCtx, createTestDb, type TestCtx } from '../../test/testContext'
import type { Db } from '../db/database'
import { isStableId } from '../ids'
import {
  acceptMessage,
  acknowledgeMessages,
  AGENT_MAIL_LIMITS,
  beginEndpointDeletion,
  bindEndpoint,
  closeBinding,
  finishEndpointDeletion,
  findEndpointByChat,
  getBinding,
  getEndpoint,
  listOpenEndpoints,
  type MailEndpoint,
  markHumanSeen,
  provisionEndpoint,
  pruneAgentMail,
  readHumanMailState,
  readInbox,
  readMailStatus,
  resumeEndpoint,
  suspendEndpoint
} from './agentMailStore'

const DAY_SECONDS = 24 * 60 * 60
const WEEK_SECONDS = 7 * DAY_SECONDS

const scratch: string[] = []
const opened: Db[] = []

afterEach(() => {
  for (const db of opened.splice(0)) {
    db.close()
  }
  for (const dir of scratch.splice(0)) {
    removeScratch(dir)
  }
})

function endpoint(ctx: TestCtx, chatId: string, machineId = ctx.machineId): MailEndpoint {
  return provisionEndpoint(ctx, { machineId, chatId, name: `Chat ${chatId}` })
}

function mailbox(): { ctx: TestCtx; a: MailEndpoint; b: MailEndpoint; c: MailEndpoint } {
  const ctx = createTestCtx()
  return { ctx, a: endpoint(ctx, 'chat-a'), b: endpoint(ctx, 'chat-b'), c: endpoint(ctx, 'chat-c') }
}

/** `message` is the client message id, then optionally the body and the id of the message replied to. */
function send(ctx: TestCtx, from: MailEndpoint, to: MailEndpoint, ...message: [clientMessageId: string, body?: string, inReplyTo?: string]) {
  const [clientMessageId, body = 'hello', inReplyTo] = message
  return acceptMessage(ctx, { senderEndpointId: from.id, to: to.id, clientMessageId, body, ...(inReplyTo === undefined ? {} : { inReplyTo }) })
}

/** Sends `count` messages with client ids `<prefix>-<n>` in one transaction (the store nests a savepoint per send). */
function sendMany(ctx: TestCtx, from: MailEndpoint, to: MailEndpoint, ...batch: [count: number, prefix: string]): string[] {
  const [total, prefix] = batch
  return ctx.db.tx(() => Array.from({ length: total }, (_, index) => send(ctx, from, to, `${prefix}-${index}`).messageId))
}

function ackAll(ctx: TestCtx, owner: MailEndpoint, ids: string[]): void {
  for (let start = 0; start < ids.length; start += AGENT_MAIL_LIMITS.ackBatch) {
    acknowledgeMessages(ctx, { endpointId: owner.id, messageIds: ids.slice(start, start + AGENT_MAIL_LIMITS.ackBatch) })
  }
}

function count(db: Db, sql: string, ...params: string[]): number {
  return db.get<{ n: number }>(sql, ...params)?.n ?? 0
}

function fileDb(): { path: string; open(): Db } {
  const dir = mkdtempSync(join(tmpdir(), 'dm-mail-'))
  scratch.push(dir)
  const path = join(dir, 'state.sqlite')
  return {
    path,
    open: () => {
      const db = createTestDb(path)
      opened.push(db)
      return db
    }
  }
}

describe('mail endpoints', () => {
  it('gives one (machine, chat) the same opaque id every time, and a rename keeps it', () => {
    const ctx = createTestCtx()
    const first = provisionEndpoint(ctx, { machineId: ctx.machineId, chatId: 'chat-1', name: 'Planner' })
    const again = provisionEndpoint(ctx, { machineId: ctx.machineId, chatId: 'chat-1', name: 'Renamed planner' })
    expect(again.id).toBe(first.id)
    expect(again.name).toBe('Renamed planner')
    expect(isStableId(first.id, 'mailEndpoint')).toBe(true)
    expect(first.id).not.toContain('chat-1')
    expect(findEndpointByChat(ctx, { machineId: ctx.machineId, chatId: 'chat-1' })?.id).toBe(first.id)
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_endpoints')).toBe(1)
  })

  it('gives the same chat id on another logical machine its own endpoint', () => {
    const ctx = createTestCtx()
    const here = endpoint(ctx, 'chat-1')
    const copied = endpoint(ctx, 'chat-1', 'mc_00000000000000000000000002')
    expect(copied.id).not.toBe(here.id)
  })

  it('refuses a name that would not render as plain text', () => {
    const ctx = createTestCtx()
    for (const name of ['', '   ', 'bell\u0007', 'evil\u202Eflip', 'x'.repeat(AGENT_MAIL_LIMITS.nameChars + 1)]) {
      expect(domainErrorOf(() => provisionEndpoint(ctx, { machineId: ctx.machineId, chatId: 'c', name })).code).toBe('invalid_input')
    }
    expect(provisionEndpoint(ctx, { machineId: ctx.machineId, chatId: 'c', name: '  <b>Reviewer</b>  ' }).name).toBe('<b>Reviewer</b>')
  })

  it('lists open endpoints in bounded pages', () => {
    const ctx = createTestCtx()
    const ids = Array.from({ length: 53 }, (_, index) => endpoint(ctx, `chat-${index}`).id)
    suspendEndpoint(ctx, ids[0] ?? '')
    const first = listOpenEndpoints(ctx)
    expect(first.endpoints).toHaveLength(50)
    expect(first.hasMore).toBe(true)
    const second = listOpenEndpoints(ctx, { afterId: first.nextAfterId ?? '' })
    expect(second).toMatchObject({ hasMore: false })
    expect([...first.endpoints, ...second.endpoints].map((item) => item.id)).toEqual(ids.slice(1).sort())
    expect(domainErrorOf(() => listOpenEndpoints(ctx, { limit: 51 })).code).toBe('invalid_input')
  })
})

describe('grant bindings', () => {
  const where = { machineId: 'mc_00000000000000000000000001', canonicalFolder: '/projects/test' }

  it('binds a grant once, idempotently, with its folder and machine', () => {
    const { ctx, a } = mailbox()
    const binding = bindEndpoint(ctx, { endpointId: a.id, grantId: 'gr_1', ...where })
    expect(binding).toMatchObject({ endpointId: a.id, canonicalFolder: '/projects/test', closedAt: null })
    expect(bindEndpoint(ctx, { endpointId: a.id, grantId: 'gr_1', ...where })).toEqual(binding)
    expect(domainErrorOf(() => bindEndpoint(ctx, { endpointId: a.id, grantId: 'gr_1', ...where, canonicalFolder: '/copy' })).code).toBe('conflict')
  })

  it('closes the previous binding for good when a fresh grant binds, and never reopens it', () => {
    const { ctx, a, b } = mailbox()
    bindEndpoint(ctx, { endpointId: a.id, grantId: 'gr_1', ...where })
    bindEndpoint(ctx, { endpointId: a.id, grantId: 'gr_2', ...where })
    expect(getBinding(ctx, 'gr_1')).toMatchObject({ closeReason: 'replaced' })
    expect(getBinding(ctx, 'gr_2')).toMatchObject({ closedAt: null })
    expect(domainErrorOf(() => bindEndpoint(ctx, { endpointId: a.id, grantId: 'gr_1', ...where })).code).toBe('conflict')
    expect(domainErrorOf(() => bindEndpoint(ctx, { endpointId: b.id, grantId: 'gr_2', ...where })).code).toBe('conflict')
    expect(closeBinding(ctx, 'gr_2')).toMatchObject({ closeReason: 'grant_ended' })
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_bindings WHERE closed_at IS NULL')).toBe(0)
  })

  it('suspension closes the binding, and resuming needs a fresh grant', () => {
    const { ctx, a } = mailbox()
    bindEndpoint(ctx, { endpointId: a.id, grantId: 'gr_1', ...where })
    expect(suspendEndpoint(ctx, a.id).state).toBe('suspended')
    expect(getBinding(ctx, 'gr_1')).toMatchObject({ closeReason: 'suspended' })
    expect(domainErrorOf(() => bindEndpoint(ctx, { endpointId: a.id, grantId: 'gr_2', ...where })).code).toBe('invalid_state')
    expect(resumeEndpoint(ctx, a.id).state).toBe('open')
    expect(getBinding(ctx, 'gr_1')?.closedAt).not.toBeNull()
    expect(domainErrorOf(() => bindEndpoint(ctx, { endpointId: a.id, grantId: 'gr_1', ...where })).code).toBe('conflict')
    expect(bindEndpoint(ctx, { endpointId: a.id, grantId: 'gr_2', ...where }).closedAt).toBeNull()
  })
})

describe('transactional persistence', () => {
  it('keeps endpoints, messages, acknowledgements and the seen cursor across a reopen', () => {
    const file = fileDb()
    const clock = createTestClock('2026-05-01T08:00:00.000Z')
    const first = createTestCtx({ db: file.open(), clock })
    const a = endpoint(first, 'chat-a')
    const b = endpoint(first, 'chat-b')
    const kept = send(first, a, b, 'm-1', 'kept body')
    const acked = send(first, a, b, 'm-2', 'acked body')
    acknowledgeMessages(first, { endpointId: b.id, messageIds: [acked.messageId] })
    markHumanSeen(first, { endpointId: b.id, throughSeq: 1 })
    first.db.close()
    opened.splice(0)

    const reopened = createTestCtx({ db: file.open(), clock })
    expect(getEndpoint(reopened, b.id)).toMatchObject({ lastSeq: 2, humanSeenSeq: 1, state: 'open' })
    const inbox = readInbox(reopened, { endpointId: b.id })
    expect(inbox.messages.map((message) => [message.id, message.body, message.acknowledgedAt !== null])).toEqual([
      [kept.messageId, 'kept body', false],
      [acked.messageId, 'acked body', true]
    ])
    expect(send(reopened, a, b, 'm-1', 'kept body')).toMatchObject({ messageId: kept.messageId, duplicate: true })
  })

  it('leaves nothing behind when the surrounding transaction rolls back', () => {
    const { ctx, a, b } = mailbox()
    expect(() =>
      ctx.db.tx(() => {
        send(ctx, a, b, 'm-1')
        throw new Error('caller failed after the send')
      })
    ).toThrow('caller failed')
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_messages')).toBe(0)
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_receipts')).toBe(0)
    expect(getEndpoint(ctx, b.id)?.lastSeq).toBe(0)
  })
})

describe('sender-scoped client message ids', () => {
  it('replays the original acceptance for the same sender and payload, storing one message', () => {
    const { ctx, a, b } = mailbox()
    const original = send(ctx, a, b, 'retry-me', 'same body')
    ctx.clock.advanceSeconds(60)
    const retry = send(ctx, a, b, 'retry-me', 'same body')
    expect(original.duplicate).toBe(false)
    expect(retry).toEqual({ ...original, duplicate: true })
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_messages')).toBe(1)
  })

  it('refuses the same client id with a changed body, recipient or reply target', () => {
    const { ctx, a, b, c } = mailbox()
    const parent = send(ctx, b, a, 'parent')
    send(ctx, a, b, 'once', 'first body')
    expect(domainErrorOf(() => send(ctx, a, b, 'once', 'second body')).code).toBe('idempotency_mismatch')
    expect(domainErrorOf(() => send(ctx, a, c, 'once', 'first body')).code).toBe('idempotency_mismatch')
    expect(domainErrorOf(() => send(ctx, a, b, 'once', 'first body', parent.messageId)).code).toBe('idempotency_mismatch')
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_messages WHERE sender_endpoint_id = ?', a.id)).toBe(1)
  })

  it('treats identical client ids from different senders as different messages', () => {
    const { ctx, a, b, c } = mailbox()
    const fromA = send(ctx, a, c, 'shared-id', 'from a')
    const fromB = send(ctx, b, c, 'shared-id', 'from b')
    expect(fromB.duplicate).toBe(false)
    expect(fromB.messageId).not.toBe(fromA.messageId)
    expect(readInbox(ctx, { endpointId: c.id }).messages.map((message) => message.body)).toEqual(['from a', 'from b'])
  })

  it('accepts a reused client id as new once its seven-day receipt has expired', () => {
    const { ctx, a, b } = mailbox()
    const first = send(ctx, a, b, 'weekly', 'week one')
    ctx.clock.advanceSeconds(WEEK_SECONDS - 1)
    expect(domainErrorOf(() => send(ctx, a, b, 'weekly', 'week two')).code).toBe('idempotency_mismatch')
    ctx.clock.advanceSeconds(1)
    const second = send(ctx, a, b, 'weekly', 'week two')
    expect(second).toMatchObject({ duplicate: false })
    expect(second.messageId).not.toBe(first.messageId)
  })

  it('refuses a malformed client id', () => {
    const { ctx, a, b } = mailbox()
    for (const id of ['', '-lead', 'has space', 'x'.repeat(AGENT_MAIL_LIMITS.clientMessageIdChars + 1)]) {
      expect(domainErrorOf(() => send(ctx, a, b, id)).code).toBe('invalid_input')
    }
  })
})

describe('message bodies', () => {
  it('measures the 16 KiB limit in UTF-8 bytes, not characters', () => {
    const { ctx, a, b } = mailbox()
    // 5461 three-byte euro signs and one ASCII byte: exactly 16384 bytes in 5462 characters.
    const atLimit = `${'€'.repeat(5461)}a`
    expect(Buffer.byteLength(atLimit, 'utf8')).toBe(AGENT_MAIL_LIMITS.bodyBytes)
    expect(send(ctx, a, b, 'at-limit', atLimit).duplicate).toBe(false)
    expect(readInbox(ctx, { endpointId: b.id }).messages[0]).toMatchObject({ body: atLimit, bodyBytes: 16384 })
    const over = domainErrorOf(() => send(ctx, a, b, 'over', `${'€'.repeat(5461)}ab`))
    expect(over).toMatchObject({ code: 'invalid_input', details: { bytes: 16385, limit: 16384 } })
    // 4096 four-byte characters fit exactly; one more does not.
    expect(send(ctx, a, b, 'emoji', '😀'.repeat(4096)).duplicate).toBe(false)
    expect(domainErrorOf(() => send(ctx, a, b, 'emoji-over', '😀'.repeat(4097))).code).toBe('invalid_input')
  })

  it('refuses an empty body and text that is not well-formed Unicode', () => {
    const { ctx, a, b } = mailbox()
    expect(domainErrorOf(() => send(ctx, a, b, 'empty', '')).code).toBe('invalid_input')
    expect(domainErrorOf(() => send(ctx, a, b, 'lone', 'half \uD83D pair')).code).toBe('invalid_input')
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_messages')).toBe(0)
  })
})

describe('replies', () => {
  it('records a reply to a message in the replier’s own inbox, going back to its sender', () => {
    const { ctx, a, b } = mailbox()
    const question = send(ctx, a, b, 'q', 'question')
    const answer = send(ctx, b, a, 'a', 'answer', question.messageId)
    expect(answer.inReplyTo).toBe(question.messageId)
    expect(readInbox(ctx, { endpointId: a.id }).messages[0]).toMatchObject({ body: 'answer', inReplyTo: question.messageId, from: { endpointId: b.id } })
  })

  it('refuses a reply to a message the replier never received, without saying whose it is', () => {
    const { ctx, a, b, c } = mailbox()
    const toB = send(ctx, a, b, 'q', 'question for b')
    expect(domainErrorOf(() => send(ctx, c, a, 'r', 'eavesdrop', toB.messageId)).code).toBe('reply_unavailable')
    expect(domainErrorOf(() => send(ctx, c, a, 'r2', 'made up', 'mm_00000000000000000000000099')).code).toBe('reply_unavailable')
  })

  it('refuses a reply addressed to anyone but the original sender', () => {
    const { ctx, a, b, c } = mailbox()
    const question = send(ctx, a, b, 'q')
    expect(domainErrorOf(() => send(ctx, b, c, 'a', 'misdirected', question.messageId)).code).toBe('invalid_input')
  })

  it('refuses a reply once the parent has expired, and keeps replies when the parent mailbox is purged', () => {
    const { ctx, a, b } = mailbox()
    const question = send(ctx, a, b, 'q', 'question')
    const answer = send(ctx, b, a, 'a', 'answer', question.messageId)
    acknowledgeMessages(ctx, { endpointId: b.id, messageIds: [question.messageId] })
    ctx.clock.advanceSeconds(WEEK_SECONDS)
    expect(domainErrorOf(() => send(ctx, b, a, 'late', 'late answer', question.messageId)).code).toBe('reply_unavailable')
    beginEndpointDeletion(ctx, b.id)
    finishEndpointDeletion(ctx, b.id)
    expect(readInbox(ctx, { endpointId: a.id }).messages.map((message) => [message.id, message.inReplyTo])).toEqual([
      [answer.messageId, question.messageId]
    ])
  })
})

describe('mailbox quotas', () => {
  it('refuses the 1025th unacknowledged message with mailbox_full, evicting nothing and using no sequence', () => {
    const { ctx, a, b } = mailbox()
    const ids = sendMany(ctx, a, b, AGENT_MAIL_LIMITS.pendingPerRecipient, 'p')
    const refused = domainErrorOf(() => send(ctx, a, b, 'one-too-many'))
    expect(refused.code).toBe('mailbox_full')
    expect(readMailStatus(ctx, { endpointId: b.id, limit: 1 }).pendingCount).toBe(1024)
    expect(getEndpoint(ctx, b.id)?.lastSeq).toBe(1024)
    // The refused send left no receipt, so the same id succeeds once there is room.
    acknowledgeMessages(ctx, { endpointId: b.id, messageIds: [ids[0] ?? ''] })
    expect(send(ctx, a, b, 'one-too-many')).toMatchObject({ duplicate: false })
    expect(getEndpoint(ctx, b.id)?.lastSeq).toBe(1025)
  })

  it('counts acknowledged mail against the 4096 retained quota until it expires seven days after acknowledgement', () => {
    const { ctx, a, b } = mailbox()
    // 4095 acknowledged, unexpired messages, as earlier sends and acknowledgements would have left them.
    const acknowledgedAt = ctx.clock.nowIso()
    const expiresAt = new Date(ctx.clock.nowMs() + WEEK_SECONDS * 1000).toISOString()
    ctx.db.tx(() => {
      for (let seq = 1; seq < AGENT_MAIL_LIMITS.retainedPerRecipient; seq += 1) {
        ctx.db.run(
          `INSERT INTO agent_mail_messages (id, recipient_endpoint_id, recipient_seq, sender_endpoint_id, client_message_id, body,
             body_bytes, accepted_at, acked_at, expires_at)
           VALUES (?, ?, ?, ?, ?, 'old', 3, ?, ?, ?)`,
          ctx.ids.next('mailMessage'), b.id, seq, a.id, `old-${seq}`, acknowledgedAt, acknowledgedAt, expiresAt
        )
      }
      ctx.db.run('UPDATE agent_mail_endpoints SET last_seq = ? WHERE id = ?', AGENT_MAIL_LIMITS.retainedPerRecipient - 1, b.id)
    })
    expect(send(ctx, a, b, 'last-allowed').duplicate).toBe(false)
    expect(readHumanMailState(ctx, b.id)).toMatchObject({ retainedCount: 4096, pendingCount: 1 })
    expect(domainErrorOf(() => send(ctx, a, b, 'full')).code).toBe('mailbox_full')
    ctx.clock.advanceSeconds(WEEK_SECONDS - 1)
    expect(domainErrorOf(() => send(ctx, a, b, 'still-full')).code).toBe('mailbox_full')
    ctx.clock.advanceSeconds(1)
    expect(send(ctx, a, b, 'room-again').duplicate).toBe(false)
    // The pending message never expired with the acknowledged ones.
    expect(readInbox(ctx, { endpointId: b.id }).messages.map((message) => message.seq)).toEqual([4096, 4097])
  })
})

describe('the sender receipt quota', () => {
  it('refuses a sender’s 8193rd unexpired receipt with receipt_quota_full, but still replays its receipts', () => {
    const { ctx, a, b, c } = mailbox()
    // 8191 earlier receipts, as accepted sends would have left them (body-free and unlinked to any message).
    ctx.db.tx(() => {
      for (let index = 0; index < AGENT_MAIL_LIMITS.receiptsPerSender - 1; index += 1) {
        ctx.db.run(
          `INSERT INTO agent_mail_receipts (sender_endpoint_id, client_message_id, payload_hash, result_json, accepted_at, expires_at)
           VALUES (?, ?, 'sha256:x', '{}', ?, ?)`,
          a.id,
          `old-${index}`,
          ctx.clock.nowIso(),
          new Date(ctx.clock.nowMs() + WEEK_SECONDS * 1000).toISOString()
        )
      }
    })
    const last = send(ctx, a, b, 'last-allowed')
    expect(last.duplicate).toBe(false)
    expect(domainErrorOf(() => send(ctx, a, c, 'one-more')).code).toBe('receipt_quota_full')
    expect(send(ctx, a, b, 'last-allowed')).toEqual({ ...last, duplicate: true })
    // Another sender is unaffected.
    expect(send(ctx, b, c, 'one-more').duplicate).toBe(false)
    ctx.clock.advanceSeconds(WEEK_SECONDS)
    expect(send(ctx, a, c, 'one-more').duplicate).toBe(false)
  })
})

describe('acknowledgement', () => {
  it('acknowledges owned messages once, keeping the first time, and expires them seven days later', () => {
    const { ctx, a, b } = mailbox()
    const message = send(ctx, a, b, 'm')
    const first = acknowledgeMessages(ctx, { endpointId: b.id, messageIds: [message.messageId] })
    expect(first.acknowledged).toEqual([
      { messageId: message.messageId, acknowledgedAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-08T00:00:00.000Z' }
    ])
    ctx.clock.advanceSeconds(3600)
    expect(acknowledgeMessages(ctx, { endpointId: b.id, messageIds: [message.messageId, message.messageId] })).toEqual(first)
  })

  it('changes nothing when any id is foreign or unknown', () => {
    const { ctx, a, b, c } = mailbox()
    const mine = send(ctx, a, b, 'mine')
    const theirs = send(ctx, a, c, 'theirs')
    expect(domainErrorOf(() => acknowledgeMessages(ctx, { endpointId: b.id, messageIds: [mine.messageId, theirs.messageId] })).code).toBe('not_found')
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_messages WHERE acked_at IS NOT NULL')).toBe(0)
  })

  it('takes 1 to 100 ids, and reading never acknowledges', () => {
    const { ctx, a, b } = mailbox()
    const ids = sendMany(ctx, a, b, 101, 'm')
    readInbox(ctx, { endpointId: b.id })
    expect(readMailStatus(ctx, { endpointId: b.id }).pendingCount).toBe(101)
    expect(domainErrorOf(() => acknowledgeMessages(ctx, { endpointId: b.id, messageIds: [] })).code).toBe('invalid_input')
    expect(domainErrorOf(() => acknowledgeMessages(ctx, { endpointId: b.id, messageIds: ids })).code).toBe('invalid_input')
    expect(acknowledgeMessages(ctx, { endpointId: b.id, messageIds: ids.slice(0, 100) }).acknowledged).toHaveLength(100)
  })
})

describe('bounded paging', () => {
  it('pages ascending under a pinned horizon, leaving later arrivals for the next sweep', () => {
    const { ctx, a, b } = mailbox()
    sendMany(ctx, a, b, 60, 'm')
    const first = readInbox(ctx, { endpointId: b.id })
    expect([first.messages.length, first.messages[0]?.seq, first.nextCursor, first.throughSeq, first.hasMore]).toEqual([50, 1, 50, 60, true])
    send(ctx, a, b, 'late')
    const second = readInbox(ctx, { endpointId: b.id, afterSeq: first.nextCursor, throughSeq: first.throughSeq })
    expect([second.messages.map((message) => message.seq).at(-1), second.hasMore, second.nextCursor]).toEqual([60, false, 60])
    const sweep = readInbox(ctx, { endpointId: b.id, afterSeq: second.nextCursor })
    expect(sweep.messages.map((message) => message.seq)).toEqual([61])
  })

  it('pages unacknowledged metadata without bodies, past more than 50 older unacknowledged rows', () => {
    const { ctx, a, b } = mailbox()
    const ids = sendMany(ctx, a, b, 70, 'm')
    ackAll(ctx, b, ids.slice(0, 10))
    const first = readMailStatus(ctx, { endpointId: b.id })
    expect(first.pendingCount).toBe(60)
    expect(first.messages[0]).not.toHaveProperty('body')
    expect(first.messages.map((message) => message.seq).slice(0, 2)).toEqual([11, 12])
    const second = readMailStatus(ctx, { endpointId: b.id, afterSeq: first.nextCursor, throughSeq: first.throughSeq })
    expect(second.messages.map((message) => message.seq)).toEqual([61, 62, 63, 64, 65, 66, 67, 68, 69, 70])
    expect(readInbox(ctx, { endpointId: b.id, unacknowledgedOnly: true, limit: 1 }).messages[0]?.seq).toBe(11)
  })

  it('refuses pages over 50, a horizon beyond the head and a cursor beyond the horizon', () => {
    const { ctx, a, b } = mailbox()
    sendMany(ctx, a, b, 3, 'm')
    expect(domainErrorOf(() => readInbox(ctx, { endpointId: b.id, limit: 51 })).code).toBe('invalid_input')
    expect(domainErrorOf(() => readInbox(ctx, { endpointId: b.id, throughSeq: 4 })).code).toBe('invalid_input')
    expect(domainErrorOf(() => readMailStatus(ctx, { endpointId: b.id, afterSeq: 3, throughSeq: 2 })).code).toBe('invalid_input')
  })
})

describe('seven-day retention', () => {
  it('drops acknowledged bodies seven days after acknowledgement and never ages out pending mail', () => {
    const { ctx, a, b } = mailbox()
    const acked = send(ctx, a, b, 'acked', 'read and done')
    const pending = send(ctx, a, b, 'pending', 'still waiting')
    ctx.clock.advanceSeconds(DAY_SECONDS)
    acknowledgeMessages(ctx, { endpointId: b.id, messageIds: [acked.messageId] })
    ctx.clock.advanceSeconds(WEEK_SECONDS - 1)
    expect(readInbox(ctx, { endpointId: b.id }).messages.map((message) => message.id)).toEqual([acked.messageId, pending.messageId])
    ctx.clock.advanceSeconds(1)
    expect(readInbox(ctx, { endpointId: b.id }).messages.map((message) => message.id)).toEqual([pending.messageId])
    expect(pruneAgentMail(ctx)).toEqual({ messages: 1, receipts: 2 })
    ctx.clock.advanceSeconds(365 * DAY_SECONDS)
    expect(pruneAgentMail(ctx)).toEqual({ messages: 0, receipts: 0 })
    expect(readInbox(ctx, { endpointId: b.id }).messages.map((message) => message.body)).toEqual(['still waiting'])
  })

  it('cleans up in bounded batches', () => {
    const { ctx, a, b } = mailbox()
    ackAll(ctx, b, sendMany(ctx, a, b, 130, 'm'))
    ctx.clock.advanceSeconds(WEEK_SECONDS)
    expect(pruneAgentMail(ctx, { limit: 100 })).toEqual({ messages: 100, receipts: 100 })
    expect(pruneAgentMail(ctx)).toEqual({ messages: 30, receipts: 30 })
    expect(domainErrorOf(() => pruneAgentMail(ctx, { limit: 101 })).code).toBe('invalid_input')
  })

  it('keeps a receipt for seven days after acceptance even when its message is gone', () => {
    const { ctx, a, b } = mailbox()
    const original = send(ctx, a, b, 'm', 'body')
    acknowledgeMessages(ctx, { endpointId: b.id, messageIds: [original.messageId] })
    ctx.clock.advanceSeconds(WEEK_SECONDS - 1)
    ctx.db.run('DELETE FROM agent_mail_messages')
    expect(send(ctx, a, b, 'm', 'body')).toEqual({ ...original, duplicate: true })
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_messages')).toBe(0)
  })
})

describe('deletion tombstones', () => {
  it('replays receipts and never reuses a sequence after the recipient is deleted', () => {
    const { ctx, a, b } = mailbox()
    const sent = send(ctx, a, b, 'before-delete', 'body')
    beginEndpointDeletion(ctx, b.id)
    expect(finishEndpointDeletion(ctx, b.id)).toMatchObject({ purged: 1, done: true, endpoint: { state: 'deleted', lastSeq: 1 } })
    expect(send(ctx, a, b, 'before-delete', 'body')).toEqual({ ...sent, duplicate: true })
    expect(domainErrorOf(() => send(ctx, a, b, 'after-delete')).code).toBe('not_found')
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_receipts WHERE sender_endpoint_id = ?', a.id)).toBe(1)
  })

  it('never hands out a sequence twice, even after every message has been purged', () => {
    const { ctx, a, b } = mailbox()
    ackAll(ctx, b, sendMany(ctx, a, b, 3, 'm'))
    ctx.clock.advanceSeconds(WEEK_SECONDS)
    pruneAgentMail(ctx)
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_messages')).toBe(0)
    send(ctx, a, b, 'next')
    expect(readInbox(ctx, { endpointId: b.id }).messages.map((message) => message.seq)).toEqual([4])
  })

  it('purges the deleted inbox in batches, keeps delivered copies with a deleted sender and never reopens', () => {
    const { ctx, a, b } = mailbox()
    sendMany(ctx, a, b, 5, 'to-b')
    const delivered = send(ctx, b, a, 'to-a', 'from soon-deleted b')
    bindEndpoint(ctx, { endpointId: b.id, grantId: 'gr_b', machineId: ctx.machineId, canonicalFolder: '/projects/test' })
    expect(beginEndpointDeletion(ctx, b.id).state).toBe('deleting')
    expect(getBinding(ctx, 'gr_b')).toMatchObject({ closeReason: 'deleted' })
    expect(domainErrorOf(() => provisionEndpoint(ctx, { machineId: ctx.machineId, chatId: 'chat-b', name: 'Back' })).code).toBe('invalid_state')
    expect(domainErrorOf(() => send(ctx, b, a, 'after', 'x')).code).toBe('invalid_state')
    expect(domainErrorOf(() => resumeEndpoint(ctx, b.id)).code).toBe('invalid_state')
    expect(finishEndpointDeletion(ctx, b.id, { limit: 2 })).toMatchObject({ purged: 2, done: false })
    expect(finishEndpointDeletion(ctx, b.id, { limit: 2 })).toMatchObject({ purged: 2, done: false })
    expect(finishEndpointDeletion(ctx, b.id, { limit: 2 })).toMatchObject({ purged: 1, done: true, endpoint: { state: 'deleted' } })
    expect(domainErrorOf(() => provisionEndpoint(ctx, { machineId: ctx.machineId, chatId: 'chat-b', name: 'Back' })).code).toBe('invalid_state')
    expect(readInbox(ctx, { endpointId: a.id }).messages).toMatchObject([
      { id: delivered.messageId, body: 'from soon-deleted b', from: { endpointId: b.id, deleted: true } }
    ])
  })
})

describe('the person’s seen cursor', () => {
  it('advances only forward, only to a retained displayed message, independent of acknowledgement', () => {
    const { ctx, a, b } = mailbox()
    const ids = sendMany(ctx, a, b, 3, 'm')
    expect(markHumanSeen(ctx, { endpointId: b.id, throughSeq: 2 })).toEqual({ humanSeenSeq: 2 })
    expect(markHumanSeen(ctx, { endpointId: b.id, throughSeq: 1 })).toEqual({ humanSeenSeq: 2 })
    expect(domainErrorOf(() => markHumanSeen(ctx, { endpointId: b.id, throughSeq: 9 })).code).toBe('invalid_input')
    expect(readHumanMailState(ctx, b.id)).toEqual({ humanSeenSeq: 2, unseenCount: 1, pendingCount: 3, retainedCount: 3, retentionDays: 7 })
    ackAll(ctx, b, ids)
    expect(readHumanMailState(ctx, b.id)).toMatchObject({ humanSeenSeq: 2, unseenCount: 1, pendingCount: 0 })
  })

  it('counts only retained rows, and cannot be moved onto an expired one', () => {
    const { ctx, a, b } = mailbox()
    ackAll(ctx, b, sendMany(ctx, a, b, 2, 'old'))
    ctx.clock.advanceSeconds(WEEK_SECONDS)
    send(ctx, a, b, 'new')
    expect(readHumanMailState(ctx, b.id)).toMatchObject({ unseenCount: 1, retainedCount: 1 })
    expect(domainErrorOf(() => markHumanSeen(ctx, { endpointId: b.id, throughSeq: 2 })).code).toBe('invalid_input')
    expect(markHumanSeen(ctx, { endpointId: b.id, throughSeq: 3 })).toEqual({ humanSeenSeq: 3 })
  })
})

describe('unknown mailboxes', () => {
  it('answers null for lookups and not_found for operations, never inventing an endpoint', () => {
    const { ctx, a } = mailbox()
    const unknown = 'me_00000000000000000000000099'
    expect(getEndpoint(ctx, unknown)).toBeNull()
    expect(findEndpointByChat(ctx, { machineId: ctx.machineId, chatId: 'never-provisioned' })).toBeNull()
    expect(findEndpointByChat(ctx, { machineId: 'mc_00000000000000000000000002', chatId: 'chat-a' })).toBeNull()
    expect(domainErrorOf(() => suspendEndpoint(ctx, unknown)).code).toBe('not_found')
    expect(domainErrorOf(() => readInbox(ctx, { endpointId: unknown })).code).toBe('not_found')
    expect(domainErrorOf(() => acceptMessage(ctx, { senderEndpointId: unknown, to: a.id, clientMessageId: 'x', body: 'hi' })).code).toBe('not_found')
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_endpoints')).toBe(3)
  })

  it('ends the endpoint listing with no cursor when nothing is open', () => {
    const { ctx, a, b, c } = mailbox()
    for (const item of [a, b, c]) {
      suspendEndpoint(ctx, item.id)
    }
    expect(listOpenEndpoints(ctx)).toEqual({ endpoints: [], nextAfterId: null, hasMore: false })
  })
})

describe('idempotent lifecycle steps', () => {
  it('leaves an endpoint untouched when provisioning, suspending or resuming changes nothing', () => {
    const { ctx, a } = mailbox()
    ctx.clock.advanceSeconds(60)
    expect(endpoint(ctx, 'chat-a')).toEqual(a)
    const suspended = suspendEndpoint(ctx, a.id)
    ctx.clock.advanceSeconds(60)
    expect(suspendEndpoint(ctx, a.id)).toEqual(suspended)
    const resumed = resumeEndpoint(ctx, a.id)
    ctx.clock.advanceSeconds(60)
    expect(resumeEndpoint(ctx, a.id)).toEqual(resumed)
  })

  it('keeps the first deletion time when deletion begins or finishes again', () => {
    const { ctx, a } = mailbox()
    const deleting = beginEndpointDeletion(ctx, a.id)
    ctx.clock.advanceSeconds(60)
    expect(beginEndpointDeletion(ctx, a.id)).toEqual(deleting)
    const finished = finishEndpointDeletion(ctx, a.id)
    ctx.clock.advanceSeconds(60)
    expect(beginEndpointDeletion(ctx, a.id)).toEqual(finished.endpoint)
    expect(finishEndpointDeletion(ctx, a.id)).toEqual({ endpoint: finished.endpoint, purged: 0, done: true })
  })
})

describe('lifecycle refusals', () => {
  it('never suspends a deleting or deleted mailbox back into a resumable state', () => {
    const { ctx, a } = mailbox()
    beginEndpointDeletion(ctx, a.id)
    expect(domainErrorOf(() => suspendEndpoint(ctx, a.id)).code).toBe('invalid_state')
    finishEndpointDeletion(ctx, a.id)
    expect(domainErrorOf(() => suspendEndpoint(ctx, a.id)).code).toBe('invalid_state')
    expect(getEndpoint(ctx, a.id)?.state).toBe('deleted')
  })

  it('purges nothing from a mailbox whose deletion never began', () => {
    const { ctx, a, b } = mailbox()
    send(ctx, a, b, 'keep')
    expect(domainErrorOf(() => finishEndpointDeletion(ctx, b.id)).code).toBe('invalid_state')
    suspendEndpoint(ctx, b.id)
    expect(domainErrorOf(() => finishEndpointDeletion(ctx, b.id)).code).toBe('invalid_state')
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_messages WHERE recipient_endpoint_id = ?', b.id)).toBe(1)
  })
})

describe('send refusals', () => {
  it('refuses a message to its own sender, storing neither a message nor a receipt', () => {
    const { ctx, a } = mailbox()
    expect(domainErrorOf(() => send(ctx, a, a, 'self')).code).toBe('invalid_input')
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_messages')).toBe(0)
    expect(count(ctx.db, 'SELECT COUNT(*) AS n FROM agent_mail_receipts')).toBe(0)
  })

  it('reuses a client id whose expired receipt outlived the send’s cleanup batch, never replaying it', () => {
    const { ctx, a, b, c } = mailbox()
    // One more receipt than a send's cleanup batch removes, each expiring a second after the one before.
    const sent = Array.from({ length: AGENT_MAIL_LIMITS.cleanupBatch + 1 }, (_, index) => {
      ctx.clock.advanceSeconds(1)
      return send(ctx, a, b, `m-${index}`)
    })
    ctx.clock.advanceSeconds(WEEK_SECONDS)
    const reused = send(ctx, a, c, `m-${AGENT_MAIL_LIMITS.cleanupBatch}`, 'a new message')
    expect(reused).toMatchObject({ to: c.id, duplicate: false })
    expect(reused.messageId).not.toBe(sent.at(-1)?.messageId)
    expect(send(ctx, a, c, `m-${AGENT_MAIL_LIMITS.cleanupBatch}`, 'a new message')).toEqual({ ...reused, duplicate: true })
  })
})

describe('sequence validation', () => {
  it('refuses a negative or non-integer cursor, horizon or seen sequence', () => {
    const { ctx, a, b } = mailbox()
    send(ctx, a, b, 'm')
    for (const bad of [-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
      expect(domainErrorOf(() => readInbox(ctx, { endpointId: b.id, afterSeq: bad })).code).toBe('invalid_input')
      expect(domainErrorOf(() => readMailStatus(ctx, { endpointId: b.id, throughSeq: bad })).code).toBe('invalid_input')
      expect(domainErrorOf(() => markHumanSeen(ctx, { endpointId: b.id, throughSeq: bad })).code).toBe('invalid_input')
    }
    expect(readHumanMailState(ctx, b.id).humanSeenSeq).toBe(0)
  })
})
