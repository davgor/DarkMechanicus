/**
 * The cult pipeline over a real temporary app database (the cult store) and a real temporary mailbox database read
 * through the human read path: every message between the run's members, in both directions, merged with the run's
 * events in one named order that pages without gaps or duplicates; outsiders' mail never appears; reading changes no
 * acknowledgement and no seen cursor; an `order_all` comes back as one entry with its recipients.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Db } from '../../core/db/database'
import { getHumanAgentMailState, markHumanAgentMailSeen, provisionAgentMailEndpoint, readHumanAgentInbox } from '../../core/services/agentMail'
import { acceptMessage, acknowledgeMessages } from '../../core/services/agentMailStore'
import type { CultInput, CultRunView } from '../../shared/cults/cult'
import type { CultPipelineEntry } from '../../shared/cults/cultApi'
import { createTestClock, createTestCtx, createTestDb, type TestClock, type TestCtx } from '../../test/testContext'
import { openAppDatabase } from '../desktop/appDatabase'
import { createCultPipeline, PIPELINE_PREVIEW_CHARS, type CultPipeline } from './cultPipeline'
import { createCultStore, type CultStore } from './cultStore'

const CULT: CultInput = {
  name: 'Gerry cult', charter: 'Build the shrine.', scope: 'sanctum', folderPath: null, archetype: 'general',
  magosName: 'Magos Vettius', magosModelId: null, defaultTimeLimitMs: 30 * 60_000
}
const NAMES = { magos: 'Magos Vettius', ferrum: 'Acolyte Ferrum-3', vox: 'Acolyte Vox-4', aurum: 'Acolyte Aurum-3' }
type Member = keyof typeof NAMES

interface Rig {
  dir: string
  appDb: Db
  mailDb: Db
  clock: TestClock
  mail: TestCtx
  cults: CultStore
  run: CultRunView
  /** Each member's and the outsider's mailbox endpoint. */
  endpoints: Record<Member | 'outsider', string>
  pipeline: CultPipeline
  /** How many inbox pages the pipeline read. */
  reads: string[]
}

let rig: Rig

function setUp(): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'dm-cult-pipeline-'))
  const clock = createTestClock('2026-11-27T12:00:00.000Z')
  const appDb = openAppDatabase(dir)
  const mailDb = createTestDb(join(dir, 'mail.sqlite'))
  const mail = createTestCtx({ db: mailDb, clock, role: 'desktop' })
  const cults = createCultStore({ db: appDb, now: () => clock.nowIso() })
  const cult = cults.createCult(CULT)
  const run = cults.transitionRun(cults.startRun(cult.id, { workDir: '/tmp/sanctum' }).id, { type: 'started' })
  const endpoints = {} as Rig['endpoints']
  for (const [key, name] of Object.entries(NAMES) as [Member, string][]) {
    clock.advanceSeconds(1)
    cults.addMember(run.id, { chatId: `chat_${key}`, role: key === 'magos' ? 'magos' : 'acolyte', displayName: name })
    endpoints[key] = provisionAgentMailEndpoint(mail, { chatId: `chat_${key}`, name }).id
  }
  endpoints.outsider = provisionAgentMailEndpoint(mail, { chatId: 'chat_outsider', name: 'Some other chat' }).id
  const reads: string[] = []
  const pipeline = createCultPipeline({
    db: appDb, cults,
    endpointOf: (_run, chatId) => (chatId.startsWith('chat_') ? (endpoints[chatId.slice(5) as Member] ?? null) : null),
    readInbox: async (_run, endpointId, window) => {
      reads.push(endpointId)
      return readHumanAgentInbox(mail, { ...window, endpointId })
    }
  })
  return { dir, appDb, mailDb, clock, mail, cults, run, endpoints, pipeline, reads }
}

beforeEach(() => {
  rig = setUp()
})

afterEach(() => {
  rig.appDb.close()
  rig.mailDb.close()
  rmSync(rig.dir, { recursive: true, force: true })
})

let sent = 0
/** One message accepted into `to`'s inbox, a second after the last thing that happened. */
function send(from: Member | 'outsider', to: Member | 'outsider', body: string, inReplyTo?: string): string {
  rig.clock.advanceSeconds(1)
  sent += 1
  return acceptMessage(rig.mail, { senderEndpointId: rig.endpoints[from], to: rig.endpoints[to], clientMessageId: `m${sent}`, body, inReplyTo }).messageId
}

/** A run event a second after the last thing that happened. */
function pause(): void {
  rig.clock.advanceSeconds(1)
  rig.cults.transitionRun(rig.run.id, { type: 'pause' })
}

/** Every entry from `afterSeq`, `limit` at a time, as the renderer pages. */
async function pageAll(limit: number, afterSeq = 0): Promise<{ entries: CultPipelineEntry[]; pages: number; last: number }> {
  const entries: CultPipelineEntry[] = []
  let cursor = afterSeq
  let pages = 0
  for (;;) {
    const page = await rig.pipeline.page(rig.run.id, { afterSeq: cursor, limit })
    pages += 1
    entries.push(...page.entries)
    cursor = page.nextAfterSeq
    if (!page.hasMore) return { entries, pages, last: cursor }
  }
}

const line = (entry: CultPipelineEntry): string =>
  `${entry.kind}${entry.eventKind === null ? '' : `:${entry.eventKind}`} ${entry.sender?.displayName ?? '-'} -> ${entry.recipients.map((member) => member.displayName).join(', ') || '-'}: ${entry.text}`

describe('cult pipeline: merged, named and ordered (c1)', () => {
  it('returns messages between members in both directions merged with the run events, by time, with sender and recipient names', async () => {
    const order = send('magos', 'ferrum', 'Draft the shrine layout.')
    send('ferrum', 'magos', 'Layout drafted.', undefined)
    pause()
    send('vox', 'ferrum', 'Your IPC call needs a schema.')
    const reply = send('ferrum', 'vox', 'Added one.')
    const { entries } = await pageAll(50)
    expect(entries.map(line)).toEqual([
      `event:summoned ${NAMES.magos} -> -: ${NAMES.magos} was summoned.`,
      `event:summoned ${NAMES.ferrum} -> -: ${NAMES.ferrum} was summoned.`,
      `event:summoned ${NAMES.vox} -> -: ${NAMES.vox} was summoned.`,
      `event:summoned ${NAMES.aurum} -> -: ${NAMES.aurum} was summoned.`,
      `message ${NAMES.magos} -> ${NAMES.ferrum}: Draft the shrine layout.`,
      `message ${NAMES.ferrum} -> ${NAMES.magos}: Layout drafted.`,
      `event:paused - -> -: ${entries[6]?.text}`,
      `message ${NAMES.vox} -> ${NAMES.ferrum}: Your IPC call needs a schema.`,
      `message ${NAMES.ferrum} -> ${NAMES.vox}: Added one.`
    ])
    expect(entries[4]).toMatchObject({ messageIds: [order], sender: { chatId: 'chat_magos', role: 'magos' }, recipients: [{ chatId: 'chat_ferrum', role: 'acolyte' }] })
    expect(entries[8]?.messageIds).toEqual([reply])
    expect(entries.map((entry) => entry.at)).toEqual(entries.map((entry) => entry.at).sort())
  })

  it('pages without gaps or duplicates', async () => {
    for (let n = 1; n <= 5; n += 1) send(n % 2 === 0 ? 'vox' : 'magos', n % 2 === 0 ? 'magos' : 'vox', `round ${n}`)
    const whole = await pageAll(200)
    const paged = await pageAll(2)
    expect(paged.entries).toEqual(whole.entries)
    expect(paged.pages).toBe(Math.ceil(whole.entries.length / 2))
    expect(new Set(paged.entries.map((entry) => entry.seq)).size).toBe(paged.entries.length)
    expect(paged.entries.map((entry) => entry.seq)).toEqual(paged.entries.map((entry) => entry.seq).sort((a, b) => a - b))
  })

  it('appends what arrives later after what was shown, and keeps a departed member’s name', async () => {
    send('vox', 'magos', 'round 1')
    const shown = await pageAll(2)
    rig.clock.advanceSeconds(1)
    rig.cults.updateMember(rig.run.id, 'chat_vox', { state: 'dismissed' })
    send('vox', 'magos', 'Leaving my notes.')
    const later = await pageAll(2, shown.last)
    expect(later.entries.map(line)).toEqual([
      `event:dismissed ${NAMES.vox} -> -: ${later.entries[0]?.text}`,
      `message ${NAMES.vox} -> ${NAMES.magos}: Leaving my notes.`
    ])
    expect(later.entries[0]!.seq).toBeGreaterThan(shown.last)
    // Shown entries never move: a full read is the earlier pages followed by the new ones.
    const all = (await pageAll(200)).entries
    expect(all).toEqual([...shown.entries, ...later.entries])
    expect(all.filter((entry) => entry.sender?.chatId === 'chat_vox').every((entry) => entry.sender?.displayName === NAMES.vox)).toBe(true)
  })
})

describe('cult pipeline: ties, long runs and members without a mailbox', () => {
  it('orders arrivals of the same instant by id: events before messages, messages by id whichever inbox holds them', async () => {
    rig.clock.advanceSeconds(1)
    const first = acceptMessage(rig.mail, { senderEndpointId: rig.endpoints.magos, to: rig.endpoints.ferrum, clientMessageId: 'tie1', body: 'first' }).messageId
    const second = acceptMessage(rig.mail, { senderEndpointId: rig.endpoints.ferrum, to: rig.endpoints.magos, clientMessageId: 'tie2', body: 'second' }).messageId
    rig.cults.transitionRun(rig.run.id, { type: 'pause' })
    const { entries } = await pageAll(50)
    const tied = entries.slice(-3)
    expect(new Set(tied.map((entry) => entry.at)).size).toBe(1)
    expect(tied.map((entry) => entry.kind === 'message' ? entry.messageIds[0] : entry.eventKind)).toEqual(['paused', first, second])
  })

  it('reads every event of a run with more than one page of them', async () => {
    for (let n = 0; n < 251; n += 1) {
      rig.cults.transitionRun(rig.run.id, { type: 'pause' })
      rig.cults.transitionRun(rig.run.id, { type: 'resume' })
    }
    const { entries } = await pageAll(1000)
    expect(entries).toHaveLength(4 + 502)
    expect(entries.filter((entry) => entry.eventKind === 'paused')).toHaveLength(251)
    expect(entries.map((entry) => entry.seq)).toEqual(entries.map((_entry, index) => index + 1))
  })

  it('reads every message of an inbox with more than one page of them, without reading them again', async () => {
    for (let n = 1; n <= 51; n += 1) send('magos', 'ferrum', `order ${n}`)
    const { entries } = await pageAll(100)
    expect(entries.filter((entry) => entry.kind === 'message').map((entry) => entry.text)).toEqual(Array.from({ length: 51 }, (_v, n) => `order ${n + 1}`))
    expect(rig.reads.filter((endpoint) => endpoint === rig.endpoints.ferrum)).toHaveLength(2)
    const again = await pageAll(100)
    expect(again.entries).toEqual(entries)
    expect(rig.reads.filter((endpoint) => endpoint === rig.endpoints.ferrum)).toHaveLength(3)
  })
})

describe('cult pipeline: members without a mailbox and rows missing their records', () => {
  it('shows a member without a mailbox by its events and reads no inbox for it', async () => {
    rig.clock.advanceSeconds(1)
    rig.cults.addMember(rig.run.id, { chatId: 'chat_ghost', role: 'acolyte', displayName: 'Acolyte Ghost' })
    const { entries } = await pageAll(50)
    expect(entries.at(-1)).toMatchObject({ kind: 'event', eventKind: 'summoned', sender: { chatId: 'chat_ghost', displayName: 'Acolyte Ghost' } })
    expect(rig.reads).toHaveLength(4)
    expect(rig.appDb.all('SELECT chat_id FROM cult_pipeline_cursors WHERE run_id = ? ORDER BY chat_id', rig.run.id)).toEqual(
      ['chat_aurum', 'chat_ferrum', 'chat_magos', 'chat_vox'].map((chat_id) => ({ chat_id })))
  })

  it('answers a page after the end with no entries and the same cursor', async () => {
    const { last } = await pageAll(50)
    expect(await rig.pipeline.page(rig.run.id, { afterSeq: last, limit: 10 })).toEqual({ entries: [], nextAfterSeq: last, hasMore: false })
  })

  it('shows a row whose records are missing as it can: no sender, no recipient, an empty body or summary', async () => {
    const { last } = await pageAll(50)
    rig.appDb.run(
      `INSERT INTO cult_pipeline (run_id, seq, at, event_seq, message_id, sender_chat_id, recipient_chat_id, in_reply_to, body)
       VALUES (?, ?, 'x', NULL, 'mm_a', NULL, NULL, NULL, NULL), (?, ?, 'x', NULL, 'mm_b', 'chat_gone', 'chat_gone', 'mm_a', 'kept'), (?, ?, 'x', 999, NULL, NULL, NULL, NULL, NULL)`,
      rig.run.id, last + 1, rig.run.id, last + 2, rig.run.id, last + 3
    )
    rig.appDb.run("INSERT INTO cult_events (run_id, seq, at, member_name, kind, summary, data) VALUES (?, 1000, 'x', ?, 'order_all', 'An order without its data.', NULL)", rig.run.id, NAMES.magos)
    rig.appDb.run('INSERT INTO cult_pipeline (run_id, seq, at, event_seq) VALUES (?, ?, ?, 1000)', rig.run.id, last + 4, 'x')
    const { entries } = await rig.pipeline.page(rig.run.id, { afterSeq: last, limit: 4 })
    expect(entries.map(({ kind, eventKind, sender, recipients, messageIds, inReplyTo, text }) => ({ kind, eventKind, sender: sender?.chatId ?? null, recipients, messageIds, inReplyTo, text }))).toEqual([
      { kind: 'message', eventKind: null, sender: null, recipients: [], messageIds: ['mm_a'], inReplyTo: null, text: '' },
      { kind: 'message', eventKind: null, sender: null, recipients: [], messageIds: ['mm_b'], inReplyTo: 'mm_a', text: 'kept' },
      { kind: 'event', eventKind: null, sender: null, recipients: [], messageIds: [], inReplyTo: null, text: '' },
      { kind: 'event', eventKind: 'order_all', sender: 'chat_magos', recipients: [], messageIds: [], inReplyTo: null, text: 'An order without its data.' }
    ])
  })
})

describe('cult pipeline: bodies and unknown runs (c1, c3)', () => {
  it('returns a long body as a preview unless the whole body is asked for, as inert text', async () => {
    const body = `<script>alert(1)</script> ${'x'.repeat(PIPELINE_PREVIEW_CHARS)}`
    send('magos', 'aurum', body)
    const preview = (await rig.pipeline.page(rig.run.id, { limit: 50 })).entries.at(-1)!
    expect(preview).toMatchObject({ truncated: true, text: body.slice(0, PIPELINE_PREVIEW_CHARS) })
    const full = (await rig.pipeline.page(rig.run.id, { limit: 50, full: true })).entries.at(-1)!
    expect(full).toMatchObject({ truncated: false, text: body })
  })

  it('refuses an unknown run with not_found', async () => {
    await expect(rig.pipeline.page('cr_unknown', { limit: 50 })).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('cult pipeline: outsiders and acknowledgement (c2)', () => {
  it('never shows mail to or from a chat outside the run', async () => {
    send('outsider', 'magos', 'Join my other project.')
    send('magos', 'outsider', 'No.')
    send('ferrum', 'magos', 'Ready.')
    const { entries } = await pageAll(50)
    expect(entries.filter((entry) => entry.kind === 'message').map(line)).toEqual([`message ${NAMES.ferrum} -> ${NAMES.magos}: Ready.`])
    expect(rig.reads).not.toContain(rig.endpoints.outsider)
  })

  it('changes no agent acknowledgement and no human-seen cursor of any member', async () => {
    const acked = send('magos', 'ferrum', 'Acknowledged already.')
    send('magos', 'ferrum', 'Not acknowledged.')
    send('ferrum', 'magos', 'Reply.')
    acknowledgeMessages(rig.mail, { endpointId: rig.endpoints.ferrum, messageIds: [acked] })
    markHumanAgentMailSeen(rig.mail, { endpointId: rig.endpoints.ferrum, throughSeq: 1 })
    const members = ['magos', 'ferrum', 'vox', 'aurum'] as const
    const states = () => members.map((member) => getHumanAgentMailState(rig.mail, { endpointId: rig.endpoints[member] }))
    const acks = () => rig.mailDb.all('SELECT id, acked_at, expires_at FROM agent_mail_messages ORDER BY id')
    const before = { states: states(), acks: acks() }
    await pageAll(1)
    await rig.pipeline.page(rig.run.id, { limit: 50, full: true })
    expect({ states: states(), acks: acks() }).toEqual(before)
    expect(before.states[1]).toMatchObject({ humanSeenSeq: 1, pendingCount: 1 })
  })
})

describe('cult pipeline: order_all (c5)', () => {
  it('returns an order to three acolytes as one entry with its id, its three recipients and one body', async () => {
    const acolytes = ['ferrum', 'vox', 'aurum'] as const
    const messageIds = acolytes.map((to, index) => {
      rig.clock.advanceSeconds(1)
      return acceptMessage(rig.mail, { senderEndpointId: rig.endpoints.magos, to: rig.endpoints[to], clientMessageId: `co_1:${index + 1}`, body: 'Conclude your reports.' }).messageId
    })
    rig.clock.advanceSeconds(1)
    rig.cults.recordOrder(rig.run.id, NAMES.magos, { orderId: 'co_1', messageIds, recipients: acolytes.map((key) => NAMES[key]) })
    send('vox', 'magos', 'Concluding.')
    const { entries } = await pageAll(50)
    const orders = entries.filter((entry) => entry.kind === 'order_all')
    expect(orders).toHaveLength(1)
    expect(orders[0]).toMatchObject({
      orderId: 'co_1', eventKind: 'order_all', messageIds, text: 'Conclude your reports.', sender: { displayName: NAMES.magos, role: 'magos' },
      recipients: acolytes.map((key) => ({ chatId: `chat_${key}`, displayName: NAMES[key], role: 'acolyte' }))
    })
    expect(entries.filter((entry) => entry.kind === 'message').map(line)).toEqual([`message ${NAMES.vox} -> ${NAMES.magos}: Concluding.`])
  })

  it('shows an order whose messages were never read as its summary, naming a sender or recipient that is no member as such', async () => {
    rig.clock.advanceSeconds(1)
    rig.cults.recordOrder(rig.run.id, 'Magos Departed', { orderId: 'co_8', messageIds: [], recipients: [NAMES.ferrum, 'Acolyte Gone'] })
    rig.clock.advanceSeconds(1)
    rig.cults.recordOrder(rig.run.id, NAMES.magos, { orderId: 'co_9', messageIds: ['mm_never_read'], recipients: [NAMES.vox] })
    const orders = (await pageAll(50)).entries.filter((entry) => entry.kind === 'order_all')
    expect(orders).toEqual([
      expect.objectContaining({
        orderId: 'co_8', sender: null, messageIds: [], truncated: false, text: `Order to every acolyte (2): ${NAMES.ferrum}, Acolyte Gone`,
        recipients: [{ chatId: 'chat_ferrum', displayName: NAMES.ferrum, role: 'acolyte' }, { chatId: '', displayName: 'Acolyte Gone', role: 'acolyte' }]
      }),
      expect.objectContaining({ orderId: 'co_9', sender: expect.objectContaining({ chatId: 'chat_magos' }), messageIds: ['mm_never_read'], text: `Order to every acolyte (1): ${NAMES.vox}` })
    ])
  })
})

describe('cult pipeline: an order written in one exclusive step (DM-667)', () => {
  it('holds a page asked while the order is sent until its event is recorded, so its messages never come alone', async () => {
    const acolytes = ['ferrum', 'vox'] as const
    let release = (): void => undefined
    // The repository's ES library predates Promise.withResolvers.
    const gate = new Promise<void>((resolve) => { release = resolve })
    const ordering = rig.pipeline.exclusive(rig.run.id, async () => {
      const messageIds = acolytes.map((to, index) =>
        acceptMessage(rig.mail, { senderEndpointId: rig.endpoints.magos, to: rig.endpoints[to], clientMessageId: `co_2:${index + 1}`, body: 'Kneel.' }).messageId)
      await gate
      rig.clock.advanceSeconds(1)
      rig.cults.recordOrder(rig.run.id, NAMES.magos, { orderId: 'co_2', messageIds, recipients: acolytes.map((key) => NAMES[key]) })
      return messageIds
    })
    const paging = rig.pipeline.page(rig.run.id, { limit: 50 })
    await Promise.resolve()
    expect(rig.reads).toEqual([])
    release()
    const messageIds = await ordering
    const { entries } = await paging
    expect(entries.filter((entry) => entry.kind !== 'event').map((entry) => [entry.kind, entry.orderId, entry.messageIds])).toEqual([['order_all', 'co_2', messageIds]])
  })
})
