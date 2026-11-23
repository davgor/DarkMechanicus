/**
 * The person's side of chat mailboxes over real desktop workspaces, the real chat store on disk, real grants and real
 * agent CLI sessions: inbox reads and the seen cursor never acknowledge for the agent, counts follow retention, the
 * mailbox comes only from a tracked folder's own OMP chat, automatic insertion progress is independent of ack/seen, and the central
 * monitor catches up, pushes metadata only, keeps one sweep in flight in bounded pages, discards late results of a
 * stopped folder and leaves no timer behind.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HUMAN_ONLY_CAPABILITIES } from '../../core/authz'
import { DomainError } from '../../core/errors'
import { provisionAgentMailEndpoint, readHumanAgentInbox } from '../../core/services/agentMail'
import { openWorkspace, type Workspace } from '../../core/workspace'
import type { ChatRecord } from '../../shared/agents/chat'
import type { ChatMailPage, ChatMailPushEvent, ChatMailSnapshot, ChatMailState } from '../../shared/agents/chatApi'
import type { CommandResult } from '../../shared/desktop/api'
import { createSequentialIds, createTestClock, type TestClock } from '../../test/testContext'
import { createFakeGit, TEST_STORAGE } from '../../test/workspaceHarness'
import { buildCliConfig } from '../desktop/cliConfig'
import { createTestWorkspacePool as createWorkspacePool, type TestWorkspacePool as WorkspacePool } from '../desktop/__mocks__/projectWorkspaceFixture'
import { gate, type Gate } from '../terminals/__mocks__/terminalSessionsRig'
import { builtInAgent, connectedAgents, folderOf } from './__mocks__/chatFixtures'
import { createAgentMailDesktop, type AgentMailDesktop, type AgentMailDesktopDeps } from './agentMailDesktop'
import { createChatGrants, type ChatGrants } from './chatGrants'
import { createChatMailboxes } from './chatMailboxes'
import { createChatRecords, type ChatRecords } from './chatRecords'
import { createChatStore, nodeChatStoreFs, type ChatStore } from './chatStore'

let root: string
let repoA: string
let repoB: string
let opened: Workspace[]
let pools: WorkspacePool[]
/**
 * Every service a test made. A monitor left running keeps its 2 s poll on the real clock after its test; firing in a
 * later test that faked `setTimeout`, it reschedules on the fake clock and that test counts its timer.
 */
let services: AgentMailDesktop[]

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-agent-mail-desktop-')))
  repoA = join(root, 'a')
  repoB = join(root, 'b')
  mkdirSync(repoA)
  mkdirSync(repoB)
  opened = []
  pools = []
  services = []
})

afterEach(async () => {
  // Before the real timers return, so a monitor's fake timer is cleared on the fake clock that holds it.
  for (const service of services) service.dispose()
  vi.useRealTimers()
  for (const workspace of opened) workspace.close()
  for (const pool of pools) await pool.closeAll()
  rmSync(root, { recursive: true, force: true })
})

interface Rig {
  clock: TestClock
  pool: WorkspacePool
  tracked: Set<string>
  store: ChatStore
  records: ChatRecords
  grants: ChatGrants
  mail: AgentMailDesktop
  pushes: ChatMailPushEvent[]
  /** How often the service asked for a folder's desktop context and listed a folder's chats. */
  counts: { contexts: number; lists: number }
  /** A `dm` CLI session on a fresh grant bound to the chat's mailbox, as its terminal's start issues it. */
  agentOf: (chat: ChatRecord) => Promise<Workspace>
}

/** `realYield` keeps the service's own yield between pages instead of the rig's immediate one. */
type RigOptions = Pick<AgentMailDesktopDeps, 'pageSize' | 'yieldPage' | 'onUnexpectedError' | 'board' | 'routedChats'> & {
  newId?: () => string
  realYield?: boolean
  autoMonitor?: boolean
  delivery?: {
    hasMessage(chat: ChatRecord, message: { id: string; body: string }): boolean
    resume(chat: ChatRecord): Promise<string | null>
  }
}

async function rig(options: RigOptions = {}): Promise<Rig> {
  const clock = createTestClock('2026-04-01T09:00:00.000Z')
  const ids = createSequentialIds()
  const git = createFakeGit({ branch: 'main', commit: 'b'.repeat(40), detached: false })
  const homeDir = join(root, 'dm-home')
  const pool = createWorkspacePool((repoRoot) => openWorkspace({ repoRoot, role: 'desktop', label: 'Desktop', transport: 'desktop', homeDir, clock, ids, git, ...TEST_STORAGE }))
  pools.push(pool)
  await pool.get(repoA).initializeRepository({ name: 'a' })
  await pool.get(repoB).initializeRepository({ name: 'b' })
  const tracked = new Set([repoA, repoB])
  const workspaceFor = (folder: string) => {
    if (!tracked.has(folder)) throw new DomainError('unauthorized', 'That folder is not tracked by Dark Mechanicus.')
    return pool.get(folder)
  }
  const store = createChatStore({ root: join(root, 'chats'), ...(options.newId === undefined ? {} : { newId: options.newId }) })
  const mailboxes = createChatMailboxes({
    workspaceFor,
    store,
    ledger: { file: join(root, 'mailboxes.jsonl'), fs: nodeChatStoreFs },
    log: () => {}
  })
  const records = createChatRecords({ store, agentFor: connectedAgents([builtInAgent('omp'), builtInAgent('claude')]), mailboxes })
  const grants = createChatGrants({
    workspaceFor,
    cliFor: (folder) => buildCliConfig({ execPath: '/bin/electron', appPath: '/app', repoPath: folder }),
    minutes: 12 * 60,
    log: () => {}
  })
  const { mail, pushes, counts } = watchedMail({ store, tracked, workspaceFor }, options)
  const agentOf = async (chat: ChatRecord): Promise<Workspace> => {
    const folder = folderOf(chat)
    const issued = await grants.issueChatCli(folder, { role: 'worker', allowSave: false, label: chat.title }, { id: chat.id, agent: chat.agent, title: chat.title, kind: 'omp' })
    const workspace = openWorkspace({ repoRoot: folder, role: 'reader', label: 'Agent', transport: 'cli', grantToken: issued.cli.env['DM_SESSION_TOKEN'] ?? '', homeDir, clock, ids, git, ...TEST_STORAGE })
    opened.push(workspace)
    return workspace
  }
  return { clock, pool, tracked, store, records, grants, mail, pushes, counts, agentOf }
}

/** The service under test over the rig's store and desktop workspaces, counting lookups and recording every push. */
function watchedMail(
  over: { store: ChatStore; tracked: Set<string>; workspaceFor: (folder: string) => ReturnType<WorkspacePool['get']> },
  options: RigOptions
): Pick<Rig, 'mail' | 'pushes' | 'counts'> {
  const pushes: ChatMailPushEvent[] = []
  const counts = { contexts: 0, lists: 0 }
  const mail = createAgentMailDesktop({
    registry: { resolve: (folder) => (over.tracked.has(folder) ? folder : null) },
    store: {
      getChat: (ref) => over.store.getChat(ref),
      listChats: (folder) => {
        counts.lists += 1
        return over.store.listChats(folder)
      }
    },
    workspaceFor: (folder) => {
      counts.contexts += 1
      return over.workspaceFor(folder)
    },
    push: (event) => pushes.push(event),
    ...(options.autoMonitor ? { folders: () => [...over.tracked] } : {}),
    ...(options.delivery === undefined ? {} : { delivery: options.delivery }),
    ...(options.board === undefined ? {} : { board: options.board }),
    ...(options.routedChats === undefined ? {} : { routedChats: options.routedChats }),
    pageSize: options.pageSize,
    onUnexpectedError: options.onUnexpectedError,
    yieldPage: options.realYield === true ? undefined : (options.yieldPage ?? (() => Promise.resolve()))
  })
  services.push(mail)
  return { mail, pushes, counts }
}

async function newOmp(state: Rig, folder: string, title: string): Promise<ChatRecord> {
  return await state.records.createChat({ folder, agent: 'omp', role: 'worker', title })
}

function data<T>(result: CommandResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.data
}

function code(result: CommandResult<unknown>): string {
  return result.ok ? 'ok' : result.error.code
}

/** Sends `bodies` from `sender` to `recipient`, one message each. */
async function send(sender: Workspace, recipient: ChatRecord, bodies: string[], prefix = 'm'): Promise<void> {
  for (const [index, body] of bodies.entries()) {
    await sender.sendAgentMessage({ to: recipient.endpointId ?? '', clientMessageId: `${prefix}${index}`, body })
  }
}

type Counts = Pick<ChatMailState, 'humanSeenSeq' | 'unseenCount' | 'pendingCount' | 'retainedCount'>

function counts(state: ChatMailState): Counts {
  const { humanSeenSeq, unseenCount, pendingCount, retainedCount } = state
  return { humanSeenSeq, unseenCount, pendingCount, retainedCount }
}

async function stateOf(state: Rig, chat: ChatRecord): Promise<ChatMailState> {
  return data(await state.mail.handlers.state({ folder: chat.folder, chatId: chat.id }))
}

/** Lets every queued promise of a poll run (real `setImmediate`; only `setTimeout` is faked). */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve))
}

describe('world mailbox monitoring', () => {
  it('monitors a world chat mailbox in its member and resumes the world owner without mixing project receipts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const routed = new Map<string, ChatRecord[]>()
    const inspected: string[] = []
    const resumed: ChatRecord[] = []
    const state = await rig({
      autoMonitor: true,
      routedChats: folder => routed.get(folder) ?? [],
      delivery: {
        hasMessage: (_chat, message) => { inspected.push('project' in message ? String(message.project) : 'missing'); return false },
        resume: async chat => { resumed.push(chat); return null }
      }
    })
    const world = state.store.createChat({ folder: root, agent: 'omp', role: 'worker', model: null, allowSave: false, title: 'World owner' })
    const endpoint = provisionAgentMailEndpoint(state.pool.get(repoA).ctx(), { chatId: world.id, name: world.title })
    const projection = { ...world, endpointId: endpoint.id }
    routed.set(repoA, [projection])
    await send(await state.agentOf(await newOmp(state, repoA, 'Member sender')), projection, ['for world owner'])
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(resumed).toEqual([projection])
    expect(resumed[0]?.folder).toBe(root)
    expect(inspected).toContain(repoA)
    expect(data(await state.mail.handlers.read({ folder: repoA, chatId: world.id })).messages.map(message => message.body)).toEqual(['for world owner'])
    expect(code(await state.mail.handlers.read({ folder: repoB, chatId: world.id }))).toBe('not_found')
    routed.set(repoA, [{ ...projection, archived: true }])
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(resumed).toHaveLength(1)
    routed.clear()
    expect(code(await state.mail.handlers.read({ folder: repoA, chatId: world.id }))).toBe('not_found')
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(resumed).toHaveLength(1)
  })

})

describe('automatic monitoring without opening an inbox', () => {
  it('discovers pending mail in every tracked folder without a snapshot request', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const state = await rig({ autoMonitor: true })
    const inbox = await newOmp(state, repoB, 'Stopped recipient')
    const sender = await state.agentOf(await newOmp(state, repoB, 'Sender'))
    await send(sender, inbox, ['must not depend on opening the inbox'])
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(state.pushes).toContainEqual(expect.objectContaining({
      type: 'mail_state',
      state: expect.objectContaining({ folder: repoB, chatId: inbox.id, pendingCount: 1 })
    }))
  })

  it('resumes the same stopped recipient, and never wakes already-inserted unacknowledged mail again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const received = new Map<string, string>()
    const resumed: string[] = []
    const state = await rig({
      autoMonitor: true,
      delivery: {
        hasMessage: (_chat, message) => received.get(message.id) === message.body,
        resume: async (chat) => { resumed.push(chat.id); return null }
      }
    })
    const inbox = await newOmp(state, repoA, 'Existing stopped recipient')
    const sender = await state.agentOf(await newOmp(state, repoA, 'Sender'))
    await send(sender, inbox, ['first full body'])
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(resumed).toEqual([inbox.id])
    const page = readHumanAgentInbox(state.pool.get(repoA).ctx(), { endpointId: inbox.endpointId ?? '' })
    for (const message of page.messages) received.set(message.id, message.body)
    await vi.advanceTimersByTimeAsync(4_000)
    await settle()
    expect(resumed).toEqual([inbox.id])
    expect((await stateOf(state, inbox)).pendingCount).toBe(1)
    await send(sender, inbox, ['independent second full body'], 'second')
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(resumed).toEqual([inbox.id, inbox.id])
    expect(state.store.listChats(repoA).filter((chat) => chat.title === inbox.title)).toHaveLength(1)
  })

})

describe('automatic monitoring while its recipient is unavailable', () => {
  it('preserves undelivered bodies and exposes the real unavailable-runtime blocker until recovery', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let problem: string | null = 'Sign in to the existing recipient runtime.'
    const state = await rig({
      autoMonitor: true,
      delivery: { hasMessage: () => false, resume: async () => problem }
    })
    const inbox = await newOmp(state, repoA, 'Unavailable recipient')
    const sender = await state.agentOf(await newOmp(state, repoA, 'Sender'))
    await send(sender, inbox, ['retained while signed out'])
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(await stateOf(state, inbox)).toMatchObject({
      delivery: { pendingCount: 1, problem: 'Sign in to the existing recipient runtime.' },
      pendingCount: 1
    })
    problem = null
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(await stateOf(state, inbox)).toMatchObject({ delivery: { pendingCount: 1, problem: null } })
    expect(readHumanAgentInbox(state.pool.get(repoA).ctx(), { endpointId: inbox.endpointId ?? '' }).messages[0]?.body)
      .toBe('retained while signed out')
  })
})

describe('the person’s inbox: read and seen without agent acknowledgement', () => {
  it('reads bodies and moves the seen cursor while the agent’s pending mail stays pending, and counts follow seven-day retention', async () => {
    const state = await rig()
    const inbox = await newOmp(state, repoA, 'Inbox')
    const sender = await state.agentOf(await newOmp(state, repoA, 'Sender'))
    await send(sender, inbox, ['first body', 'second body', 'third body'])

    const snapshot = data(await state.mail.handlers.snapshot(repoA))
    const shown = snapshot.chats.find((chat) => chat.chatId === inbox.id)
    expect(shown && counts(shown)).toEqual({ humanSeenSeq: 0, unseenCount: 3, pendingCount: 3, retainedCount: 3 })
    expect(shown?.retentionDays).toBe(7)

    const page = data(await state.mail.handlers.read({ folder: repoA, chatId: inbox.id, limit: 2 }))
    expect(page.messages.map((message) => [message.seq, message.body, message.acknowledgedAt])).toEqual([
      [1, 'first body', null],
      [2, 'second body', null]
    ])
    expect(counts(data(await state.mail.handlers.markSeen({ folder: repoA, chatId: inbox.id, throughSeq: 2 })))).toEqual({
      humanSeenSeq: 2,
      unseenCount: 1,
      pendingCount: 3,
      retainedCount: 3
    })

    // The agent still has all three to acknowledge: the person's read and seen are not its acknowledgement.
    const agent = await state.agentOf(inbox)
    const pending = await agent.readAgentInbox({ unacknowledgedOnly: true })
    expect(pending.messages.map((message) => message.seq)).toEqual([1, 2, 3])
    await agent.acknowledgeAgentMessages({ messageIds: [pending.messages[0]?.id ?? ''] })
    expect(counts(await stateOf(state, inbox))).toEqual({ humanSeenSeq: 2, unseenCount: 1, pendingCount: 2, retainedCount: 3 })

    // Seven days after acknowledgement the message expires and no count includes it.
    state.clock.advanceSeconds(7 * 24 * 60 * 60 + 1)
    expect(counts(await stateOf(state, inbox))).toEqual({ humanSeenSeq: 2, unseenCount: 1, pendingCount: 2, retainedCount: 2 })
  })

  it('keeps a message that arrived after the window rendered unseen, refuses a sequence never shown and never moves back', async () => {
    const state = await rig()
    const inbox = await newOmp(state, repoA, 'Inbox')
    const sender = await state.agentOf(await newOmp(state, repoA, 'Sender'))
    await send(sender, inbox, ['one', 'two'])
    const ref = { folder: repoA, chatId: inbox.id }

    // Nothing was shown yet: no sequence can be marked, not even one the inbox holds.
    expect(code(await state.mail.handlers.markSeen({ ...ref, throughSeq: 1 }))).toBe('invalid_input')
    const page = data(await state.mail.handlers.read(ref))
    expect(page.messages.map((message) => message.seq)).toEqual([1, 2])
    await send(sender, inbox, ['three, arriving while the window shows two'], 'late')

    // A future sequence (the new arrival, or beyond the head) is refused; the shown head is accepted.
    expect(code(await state.mail.handlers.markSeen({ ...ref, throughSeq: 3 }))).toBe('invalid_input')
    expect(code(await state.mail.handlers.markSeen({ ...ref, throughSeq: 99 }))).toBe('invalid_input')
    expect(counts(data(await state.mail.handlers.markSeen({ ...ref, throughSeq: 2 })))).toEqual({ humanSeenSeq: 2, unseenCount: 1, pendingCount: 3, retainedCount: 3 })
    expect(data(await state.mail.handlers.markSeen({ ...ref, throughSeq: 1 })).humanSeenSeq).toBe(2)
  })
})

describe('the person’s inbox: which mailbox', () => {
  it('derives the mailbox from a tracked folder’s own OMP chat and refuses every other target or shape', async () => {
    const state = await rig()
    const inbox = await newOmp(state, repoA, 'Inbox')
    const elsewhere = await newOmp(state, repoB, 'Elsewhere')
    const claude = await state.records.createChat({ folder: repoA, agent: 'claude', role: 'worker', title: 'Claude' })
    const doomed = await newOmp(state, repoA, 'Doomed')
    await state.records.deleteChat(doomed)
    const untracked = join(root, 'untracked')
    mkdirSync(untracked)

    expect(code(await state.mail.handlers.state({ folder: repoA, chatId: inbox.id }))).toBe('ok')
    expect(code(await state.mail.handlers.state({ folder: untracked, chatId: inbox.id }))).toBe('unauthorized')
    expect(code(await state.mail.handlers.snapshot(untracked))).toBe('unauthorized')
    // A chat of another folder, another CLI's chat and a deleted chat have no mailbox here.
    expect(code(await state.mail.handlers.state({ folder: repoA, chatId: elsewhere.id }))).toBe('not_found')
    expect(code(await state.mail.handlers.read({ folder: repoA, chatId: claude.id }))).toBe('not_found')
    expect(code(await state.mail.handlers.state({ folder: repoA, chatId: doomed.id }))).toBe('not_found')
    // The renderer never names an endpoint, and every request is a strict object.
    expect(code(await state.mail.handlers.read({ folder: repoA, chatId: inbox.id, endpointId: elsewhere.endpointId }))).toBe('invalid_input')
    expect(code(await state.mail.handlers.state({ folder: repoA, chatId: '../x' }))).toBe('invalid_input')
    expect(code(await state.mail.handlers.read({ folder: repoA, chatId: inbox.id, limit: 51 }))).toBe('invalid_input')
    expect(code(await state.mail.handlers.snapshot(undefined))).toBe('invalid_input')

    // The snapshot lists only the folder's OMP chats that have a mailbox.
    expect(data(await state.mail.handlers.snapshot(repoA)).chats.map((chat) => chat.chatId)).toEqual([inbox.id])
  })

  it('keeps the person’s mail powers human-only: an agent cannot inspect another inbox', async () => {
    const state = await rig()
    const inbox = await newOmp(state, repoA, 'Inbox')
    const agent = await state.agentOf(await newOmp(state, repoA, 'Agent'))
    expect(HUMAN_ONLY_CAPABILITIES).toContain('mail.manage')

    expect(() => readHumanAgentInbox(agent.ctx(), { endpointId: inbox.endpointId ?? '' })).toThrow(expect.objectContaining({ code: 'unauthorized' }))
  })
})


describe('the central mail monitor', () => {
  it('catches up on mail that arrived before it started, then pushes only changed metadata and never a body', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const state = await rig()
    const inbox = await newOmp(state, repoA, 'Inbox')
    const sender = await state.agentOf(await newOmp(state, repoA, 'Sender'))
    await send(sender, inbox, ['secret body before start'])

    const snapshot: ChatMailSnapshot = data(await state.mail.handlers.snapshot(repoA))
    expect(snapshot.chats.find((chat) => chat.chatId === inbox.id)?.unseenCount).toBe(1)
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(state.pushes).toEqual([])

    await send(sender, inbox, ['secret body while watched'], 'w')
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(state.pushes).toEqual([{ type: 'mail_state', state: expect.objectContaining({ folder: repoA, chatId: inbox.id, unseenCount: 2, pendingCount: 2 }) }])
    const pushed = JSON.stringify(state.pushes)
    expect(pushed).not.toContain('secret body')
    expect(pushed).not.toContain(inbox.endpointId ?? 'me_')
    // Versions only grow: a pushed state is newer than the snapshot's.
    const first = state.pushes[0]
    expect(first?.type === 'mail_state' && first.state.version).toBeGreaterThan(snapshot.chats[0]?.version ?? Infinity)

    await state.records.deleteChat(inbox)
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(state.pushes.at(-1)).toMatchObject({ type: 'mail_removed', folder: repoA, chatId: inbox.id })
  })

  it('keeps two folders’ chats with the same id apart', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const ids = ['chat_same', 'chat_same', 'chat_sender']
    const state = await rig({ newId: () => ids.shift() ?? 'chat_other' })
    const inA = await newOmp(state, repoA, 'Twin A')
    const inB = await newOmp(state, repoB, 'Twin B')
    const sender = await state.agentOf(await newOmp(state, repoA, 'Sender'))
    expect([inA.id, inB.id]).toEqual(['chat_same', 'chat_same'])
    data(await state.mail.handlers.snapshot(repoA))
    data(await state.mail.handlers.snapshot(repoB))

    await send(sender, inA, ['for A only'])
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()

    expect(state.pushes.map((event) => event.type === 'mail_state' && [event.state.folder, event.state.chatId, event.state.unseenCount])).toEqual([[repoA, 'chat_same', 1]])
    expect(data(await state.mail.handlers.snapshot(repoB)).chats.map((chat) => chat.unseenCount)).toEqual([0])
  })
})

describe('the central mail monitor: pages, generations and timers', () => {
  it('reads in bounded pages with one sweep in flight, and discards a sweep’s late results once its folder stops', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let hold: Gate<void> | null = null
    const state = await rig({ pageSize: 2, yieldPage: () => hold?.promise ?? Promise.resolve() })
    const workerTimers = vi.getTimerCount()
    const chats = await Promise.all([1, 2, 3, 4].map(async n => await newOmp(state, repoA, `Inbox ${n}`)))
    const sender = await state.agentOf(await newOmp(state, repoA, 'Sender'))
    data(await state.mail.handlers.snapshot(repoA))
    // Five mailboxes in pages of two: three contexts, one per page transaction.
    state.counts.contexts = 0
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(state.counts.contexts).toBe(3)

    await send(sender, chats[0] ?? (await newOmp(state, repoA, 'never')), ['late'])
    hold = gate<void>()
    state.counts.lists = 0
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    // The sweep read its first page and waits; however much time passes, no second sweep starts.
    await vi.advanceTimersByTimeAsync(20_000)
    await settle()
    expect(state.counts.lists).toBe(1)
    expect(vi.getTimerCount() - workerTimers).toBe(0)

    // Untracked and tracked again while the old sweep waits: its late page must not reach the new generation's watch.
    state.mail.stopFolder(repoA)
    const restarted = state.mail.handlers.snapshot(repoA)
    hold.open()
    hold = null
    await settle()
    expect(code(await restarted)).toBe('ok')
    expect(state.pushes).toEqual([])
    expect(vi.getTimerCount() - workerTimers).toBe(1)
    state.mail.dispose()
    expect(vi.getTimerCount() - workerTimers).toBe(0)
  })
})

describe('the central mail monitor: stopping', () => {
  it('answers a snapshot whose folder stopped meanwhile with unauthorized, not the old folder’s data', async () => {
    let hold: Gate<void> | null = gate<void>()
    const state = await rig({ yieldPage: () => hold?.promise ?? Promise.resolve() })
    await newOmp(state, repoA, 'Inbox')

    const pending: Promise<CommandResult<ChatMailSnapshot>> = state.mail.handlers.snapshot(repoA)
    await settle()
    state.mail.stopFolder(repoA)
    hold.open()
    hold = null

    expect(code(await pending)).toBe('unauthorized')
  })

  it('leaves no timer after a stop or quit, and a quit app starts no monitor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const state = await rig()
    const workerTimers = vi.getTimerCount()
    await newOmp(state, repoA, 'Inbox')
    await newOmp(state, repoB, 'Other')

    data(await state.mail.handlers.snapshot(repoA))
    data(await state.mail.handlers.snapshot(repoB))
    expect(vi.getTimerCount() - workerTimers).toBe(2)
    state.mail.stopFolder(repoA)
    expect(vi.getTimerCount() - workerTimers).toBe(1)
    // A folder the registry forgot without a stop stops itself at its next poll.
    state.tracked.delete(repoB)
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(vi.getTimerCount() - workerTimers).toBe(0)

    data(await state.mail.handlers.snapshot(repoA))
    state.mail.dispose()
    expect(vi.getTimerCount() - workerTimers).toBe(0)
    const afterQuit: ChatMailSnapshot = data(await state.mail.handlers.snapshot(repoA))
    expect(afterQuit.chats).toHaveLength(1)
    expect(vi.getTimerCount() - workerTimers).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(state.pushes).toEqual([])
  })
})

describe('the central mail monitor: a chat deleted mid-sweep', () => {
  it('leaves the deleted chat out and reports it removed, while the rest of the sweep still lands', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let hold: Gate<void> | null = null
    const ids = ['chat_a', 'chat_b', 'chat_c', 'chat_s']
    const state = await rig({ pageSize: 1, newId: () => ids.shift() ?? 'chat_other', yieldPage: () => hold?.promise ?? Promise.resolve() })
    await newOmp(state, repoA, 'First')
    const doomed = await newOmp(state, repoA, 'Doomed')
    const last = await newOmp(state, repoA, 'Last')
    const sender = await state.agentOf(await newOmp(state, repoA, 'Sender'))
    data(await state.mail.handlers.snapshot(repoA))
    await send(sender, last, ['after the delete'])

    hold = gate<void>()
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    // The sweep listed every chat and waits after its first page; the doomed chat's mailbox goes before its page.
    await state.records.deleteChat(doomed)
    hold.open()
    hold = null
    await settle()

    expect(state.pushes).toEqual([
      { type: 'mail_state', state: expect.objectContaining({ chatId: last.id, unseenCount: 1 }) },
      { type: 'mail_removed', folder: repoA, chatId: doomed.id, version: expect.any(Number) }
    ])
  })
})

describe('the central mail monitor: failures', () => {
  it('reports a failure that is not a DomainError for logging, and keeps polling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const unexpected: unknown[] = []
    const state = await rig({ onUnexpectedError: (error) => unexpected.push(error) })
    const inbox = await newOmp(state, repoA, 'Inbox')
    const sender = await state.agentOf(await newOmp(state, repoA, 'Sender'))
    data(await state.mail.handlers.snapshot(repoA))
    const db = state.pool.get(repoA).ctx().db

    // A broken database (a bug or I/O, not a refusal) fails the sweep's page read.
    db.exec('ALTER TABLE agent_mail_endpoints RENAME TO agent_mail_endpoints_away')
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(unexpected).toHaveLength(1)
    expect(unexpected[0]).toBeInstanceOf(Error)
    expect(unexpected[0]).not.toBeInstanceOf(DomainError)
    expect(state.pushes).toEqual([])

    db.exec('ALTER TABLE agent_mail_endpoints_away RENAME TO agent_mail_endpoints')
    await send(sender, inbox, ['after recovery'])
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(state.pushes).toEqual([{ type: 'mail_state', state: expect.objectContaining({ chatId: inbox.id, unseenCount: 1 }) }])
    expect(unexpected).toHaveLength(1)
  })

  it('treats a folder untracked mid-sweep as a refusal, not a bug, and stops at the next poll', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let hold: Gate<void> | null = null
    const unexpected: unknown[] = []
    const state = await rig({ pageSize: 1, yieldPage: () => hold?.promise ?? Promise.resolve(), onUnexpectedError: (error) => unexpected.push(error) })
    const workerTimers = vi.getTimerCount()
    await newOmp(state, repoA, 'First')
    await newOmp(state, repoA, 'Second')
    data(await state.mail.handlers.snapshot(repoA))

    hold = gate<void>()
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    // Untracked between pages: the next page's desktop context is refused.
    state.tracked.delete(repoA)
    hold.open()
    hold = null
    await settle()
    expect(unexpected).toEqual([])
    expect(state.pushes).toEqual([])
    expect(vi.getTimerCount() - workerTimers).toBe(1)

    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(vi.getTimerCount() - workerTimers).toBe(0)
    expect(unexpected).toEqual([])
  })
})

describe('the central mail monitor: yielding between pages', () => {
  it('lets the event loop run between pages by default, so a large folder never holds the window’s requests back', async () => {
    const state = await rig({ pageSize: 1, realYield: true })
    await newOmp(state, repoA, 'First')
    await newOmp(state, repoA, 'Second')
    let ticked = false
    setImmediate(() => {
      ticked = true
    })

    const answered = await state.mail.handlers.snapshot(repoA).then((result) => ({ chats: data(result).chats.length, ticked }))

    expect(answered).toEqual({ chats: 2, ticked: true })
  })
})

describe('the person’s inbox page', () => {
  it('pages with a pinned horizon so a later page skips no arrival', async () => {
    const state = await rig()
    const inbox = await newOmp(state, repoA, 'Inbox')
    const sender = await state.agentOf(await newOmp(state, repoA, 'Sender'))
    await send(sender, inbox, ['a', 'b', 'c'])
    const ref = { folder: repoA, chatId: inbox.id }

    const first: ChatMailPage = data(await state.mail.handlers.read({ ...ref, limit: 2 }))
    await send(sender, inbox, ['d'], 'later')
    const second = data(await state.mail.handlers.read({ ...ref, afterSeq: first.nextCursor, throughSeq: first.snapshotHighWater, limit: 2 }))

    expect([first.messages.map((m) => m.body), first.hasMore]).toEqual([['a', 'b'], true])
    expect([second.messages.map((m) => m.body), second.hasMore]).toEqual([['c'], false])
  })
})

describe('automatic context monitoring without an open inbox', () => {
  it('monitors person-board pending work even when the tracked folder has no eligible peer mailbox', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const boardPoll = vi.fn(async (_folder: string) => {})
    const state = await rig({ autoMonitor: true, board: { poll: boardPoll } })
    await state.records.createChat({ folder: repoA, agent: 'claude', role: 'worker', title: 'Native recipient' })
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(boardPoll.mock.calls.map(([folder]) => folder)).toEqual(expect.arrayContaining([repoA, repoB]))
    state.mail.dispose()
    const calls = boardPoll.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(boardPoll).toHaveBeenCalledTimes(calls)
  })

  it('exposes an unobservable transcript as a blocker without blindly resuming, then recovers on a later sweep', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    let inaccessible = true
    const resume = vi.fn(async () => null)
    const state = await rig({ autoMonitor: true, delivery: {
      hasMessage: () => {
        if (inaccessible) throw new Error('EACCES: recipient transcript is unreadable.')
        return false
      },
      resume
    } })
    const inbox = await newOmp(state, repoA, 'Blocked observer')
    const sender = await state.agentOf(await newOmp(state, repoA, 'Sender'))
    await send(sender, inbox, ['Keep this complete pending body.'])
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect((await stateOf(state, inbox)).delivery).toMatchObject({ pendingCount: 1, problem: expect.stringContaining('EACCES') })
    expect(resume).not.toHaveBeenCalled()
    inaccessible = false
    await vi.advanceTimersByTimeAsync(2_000)
    await settle()
    expect(resume).toHaveBeenCalledWith(expect.objectContaining({ id: inbox.id }))
  })
})
