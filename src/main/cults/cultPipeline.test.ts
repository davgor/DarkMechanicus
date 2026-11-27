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
    expect(entries.map((entry) => entry.at)).toEqual([...entries.map((entry) => entry.at)].sort())
  })

  it('pages without gaps or duplicates, appends what arrives later after what was shown, and keeps a departed member’s name', async () => {
    for (let n = 1; n <= 5; n += 1) send(n % 2 === 0 ? 'vox' : 'magos', n % 2 === 0 ? 'magos' : 'vox', `round ${n}`)
    const whole = await pageAll(200)
    const paged = await pageAll(2)
    expect(paged.entries).toEqual(whole.entries)
    expect(paged.pages).toBe(Math.ceil(whole.entries.length / 2))
    expect(new Set(paged.entries.map((entry) => entry.seq)).size).toBe(paged.entries.length)
    expect(paged.entries.map((entry) => entry.seq)).toEqual([...paged.entries.map((entry) => entry.seq)].sort((a, b) => a - b))

    rig.clock.advanceSeconds(1)
    rig.cults.updateMember(rig.run.id, 'chat_vox', { state: 'dismissed' })
    send('vox', 'magos', 'Leaving my notes.')
    const later = await pageAll(2, paged.last)
    expect(later.entries.map(line)).toEqual([
      `event:dismissed ${NAMES.vox} -> -: ${later.entries[0]?.text}`,
      `message ${NAMES.vox} -> ${NAMES.magos}: Leaving my notes.`
    ])
    expect(later.entries[0]!.seq).toBeGreaterThan(paged.last)
    // Shown entries never move: a full read is the earlier pages followed by the new ones.
    expect((await pageAll(200)).entries).toEqual([...whole.entries, ...later.entries])
    expect((await pageAll(200)).entries.filter((entry) => entry.sender?.chatId === 'chat_vox').every((entry) => entry.sender?.displayName === NAMES.vox)).toBe(true)
  })

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
})
