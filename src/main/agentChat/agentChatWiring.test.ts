/**
 * The production wiring of the two owners (`wireAgentChats`) over the real terminal manager (fake PTYs) and the real
 * GUI manager (the fake CLI), with the real `agentChat:*` handlers behind the sender guard and the real native
 * confirmation over an injected dialog. No Electron import: bootstrap passes only Electron's own pieces in.
 */
import type { IpcMain, IpcMainInvokeEvent, MessageBoxOptions } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CHAT_CHANNELS, type AttentionItem, type PendingPrompt } from '../../shared/agents/agentChat'
import type { ChatPushEvent, StartOrchestratorResult } from '../../shared/agents/chatApi'
import type { ChatRecord } from '../../shared/agents/chat'
import type { CommandResult } from '../../shared/desktop/api'
import { DEFAULT_NOTIFICATION_SETTINGS } from '../../shared/desktop/notificationSettings'
import type { AttemptTimelineView } from '../../shared/domain/activity'
import type { EpicDetailView, RunView, TicketDetailView } from '../../shared/domain/views'
import { removeScratch } from '../../test/removeScratch'
import { createChatHandlers } from '../agents/chatHandlers'
import { createChatRecords } from '../agents/chatRecords'
import type { ChatRef } from '../agents/chatStore'
import { guardIpc } from '../ipcGuard'
import type { ArbiterResult, startArbiter } from '../magos/arbiterRunner'
import { arbitrationExclusion, exclusionText } from '../magos/arbitrationRules'
import { createNotifier, type NotificationEvent } from '../notify/notifier'
import { disposeBeforeQuit } from '../quitDisposal'
import { gate, settle, startTerminal, terminalRig, type TerminalRig } from '../terminals/__mocks__/terminalSessionsRig'
import { agentChatRig } from './__mocks__/agentChatRig'
import { createAgentChatHandlers, registerAgentChatIpc } from './agentChatIpc'
import { endingAgentChats, nativeTerminalStopConfirmation, releasingChatOwners, wireAgentChats, type AgentChatAttention, type AgentChatOwnerDeps, type ArbiterWiring } from './agentChatWiring'

type Listener = Parameters<IpcMain['handle']>[1]
const APP_URL = 'http://localhost:5173'
const WINDOW = { id: 'app-window' }
const SENDER = { id: 'app-contents' }
const TRUSTED = { sender: SENDER, senderFrame: { url: `${APP_URL}/`, parent: null, detached: false, isDestroyed: () => false } } as unknown as IpcMainInvokeEvent

/** One app: the terminals and the GUI over one store, wired as bootstrap wires them, with the guarded handlers. */
function app(
  dialog: (window: unknown, options: MessageBoxOptions) => Promise<{ response: number }> = async () => ({ response: 0 }),
  arbiterOverrides: Partial<ArbiterWiring> = {}, attentionOverrides: Partial<AgentChatAttention> = {}
) {
  // The rig builds the GUI manager; it reaches the terminals and the Magos gate only through what `wireAgentChats` hands its factory.
  let owned: AgentChatOwnerDeps | undefined
  const gui = agentChatRig('claude', {
    terminalLive: ref => owned!.terminalLive(ref), terminalOwner: ref => owned!.terminalOwner(ref),
    stopTerminal: (ref, generation) => owned!.stopTerminal(ref, generation), onChatChanged: ref => owned!.onChatChanged(ref),
    arbitrate: input => owned!.arbitrate(input), ticketKeyOfAttempt: (folder, attemptId) => owned!.ticketKeyOfAttempt(folder, attemptId),
    onAttention: event => owned!.onAttention(event)
  })
  const arbiter: ArbiterWiring = {
    settings: () => DEFAULT_NOTIFICATION_SETTINGS, arbiterReads: () => { throw new Error('No workspace in this test.') },
    bindings: gui.deps.bindings, allowedRoots: async () => [], platform: process.platform, env: gui.env, arbiterRoot: join(gui.root, 'arbiter'),
    log: { info: vi.fn(), warn: vi.fn() },
    ...arbiterOverrides
  }
  const notify = vi.fn<AgentChatAttention['notify']>(), onError = vi.fn<AgentChatAttention['onError']>()
  const attention: AgentChatAttention = { notify, chat: ref => gui.store.getChat(ref), onError, ...attentionOverrides }
  let terminalsRig: TerminalRig | undefined
  const pushes: ChatPushEvent[] = []
  const wiring = wireAgentChats({
    terminalsFactory: agentChatLive => {
      terminalsRig = terminalRig({ killSettlesAtOnce: true, deps: () => ({ store: gui.store, folders: { trackedFolder: path => path }, agentChatLive }) })
      return terminalsRig.sessions
    },
    agentChatsFactory: deps => { owned = deps; return gui.sessions },
    push: event => { pushes.push(event) },
    arbiter,
    attention
  })
  const showMessageBox = vi.fn(dialog)
  const listeners = new Map<string, Listener>()
  const handlers = createAgentChatHandlers({
    registry: { resolve: path => path === gui.repo ? path : null },
    sessions: wiring.agentChats,
    confirmTerminalStop: nativeTerminalStopConfirmation<unknown, unknown>({ windowFor: sender => sender === SENDER ? WINDOW : null, showMessageBox }),
    models: { chatModels: async () => [], catalogModels: async () => [] },
    evidence: { chats: gui.store, chatImages: gui.chatImages, workspace: () => { throw new Error('No evidence is attached in these tests.') } }
  })
  registerAgentChatIpc(guardIpc({ handle: (channel, listener) => void listeners.set(channel, listener) }, { appUrl: APP_URL }), handlers, event => event.sender)
  const invoke = async <T>(channel: string, request: unknown, event = TRUSTED) => (await listeners.get(channel)!(event, request)) as CommandResult<T>
  const terminalChat = (): ChatRecord => gui.store.createChat({ folder: gui.repo, agent: 'claude', model: null, role: 'worker', allowSave: false, surface: 'terminal' })
  return { gui, terminals: terminalsRig!, wiring, pushes, showMessageBox, listeners, invoke, terminalChat, notify, onError, owned: () => owned! }
}

let current: ReturnType<typeof app> | undefined
function open(dialog?: Parameters<typeof app>[0], arbiter?: Parameters<typeof app>[1], attention?: Parameters<typeof app>[2]): ReturnType<typeof app> {
  current = app(dialog, arbiter, attention)
  return current
}
afterEach(async () => {
  // Terminal dispose resolves once each PTY reports its exit; the fake PTYs exit only when told to.
  const disposed = current?.wiring.dispose()
  for (const pty of current?.terminals.host.spawns ?? []) if (!pty.exited) pty.exit()
  await disposed
  await current?.gui.cleanup()
  current?.terminals.cleanup()
  current = undefined
})

const RUN = 'rn_01j0000000000000000000000r'
const EPIC_ID = 'ep_01j0000000000000000000000e'
const ATTEMPT = 'at_01j0000000000000000000000a'
const WORKER_THREAD = 'thread:toolu_T1_claim_worker'

/** A run's Magos chat in the GUI whose fake CLI raises a worker's Bash approval. */
function magosChat(state: ReturnType<typeof app>): ChatRef {
  return state.gui.store.createChat({ folder: state.gui.repo, agent: 'claude', role: 'orchestrator', runId: RUN, allowSave: false, model: null, surface: 'gui', firstPrompt: '[worker_approval]' })
}

/** A prompt's notification dedupe key: scoped to its chat ref as well as its id. */
const promptKey = (chat: ChatRef, promptId: string): string => `prompt:${JSON.stringify([chat.folder, chat.id, promptId])}`

/** The folder's workspace reads: the run's epic with a Standards section, and the worker attempt's saved ticket. */
function projectReads() {
  return {
    getRun: vi.fn(async () => ({ id: RUN, epicId: EPIC_ID }) as RunView),
    getEpic: vi.fn(async () => ({ id: EPIC_ID, intent: '# Epic\n## Standards\nRun targeted checks only.\n## Design\nInternal.' }) as EpicDetailView),
    getAttemptTimeline: vi.fn(async () => ({ attemptId: ATTEMPT, runId: RUN, ticketId: 'tk_1' }) as AttemptTimelineView),
    getTicket: vi.fn(async () => ({ ticket: { key: 'DM-442', title: 'Run the tests', body: 'Run them all.', acceptanceCriteria: [{ id: 'c1', text: 'Tests pass' }] } }) as TicketDetailView)
  }
}

/** A stub runner: each start records its options; `verdict` settles it, and `stuck` ignores cancellation forever. */
function stubRunner(options: { verdict?: ArbiterResult; stuck?: boolean } = {}) {
  const cancels = vi.fn()
  const start = vi.fn((_input: Parameters<typeof startArbiter>[0]) => {
    let resolve!: (result: ArbiterResult) => void
    const promise = new Promise<ArbiterResult>(settle => { resolve = settle })
    if (options.verdict) resolve(options.verdict)
    return { result: promise, cancel: () => { cancels(); if (!options.stuck) resolve({ decision: 'escalate', cause: 'cancelled', reason: 'Arbiter cancelled.' }) } }
  })
  return { start, cancels }
}

const requestOf = (runner: ReturnType<typeof stubRunner>) => JSON.parse(runner.start.mock.calls[0][0].input.replace(/^REQUEST:\n/, '')) as Record<string, unknown>
const withArbitration = (arbitration: Partial<typeof DEFAULT_NOTIFICATION_SETTINGS.arbitration>) =>
  ({ ...DEFAULT_NOTIFICATION_SETTINGS, arbitration: { ...DEFAULT_NOTIFICATION_SETTINGS.arbitration, ...arbitration } })

describe('agent chat wiring: the Magos arbiter', () => {
  it('reaches the sessions with the main settings, the bound ticket and Standards context, and the ticket-key lookup', async () => {
    const reads = projectReads(), runner = stubRunner({ verdict: { decision: 'allow_once', reason: 'Routine.' } })
    const settings = vi.fn(() => withArbitration({ autoHandleNotes: 'Allow test runs.' }))
    const folders: string[] = []
    const state = open(undefined, { settings, arbiterReads: folder => { folders.push(folder); return reads }, startArbiter: runner.start })
    const chat = magosChat(state)
    state.gui.deps.bindings.bind({ chatId: chat.id, folder: state.gui.repo, threadId: WORKER_THREAD, kind: 'attempt', attemptId: ATTEMPT, role: 'worker' })
    await state.wiring.agentChats.start(chat)
    await vi.waitFor(() => expect(state.gui.store.readTranscript(chat)!.items.some(item => item.kind === 'approval_decision')).toBe(true), { timeout: 5_000 })
    expect(runner.start).toHaveBeenCalledOnce()
    expect(requestOf(runner)).toMatchObject({
      ticket: { key: 'DM-442', title: 'Run the tests', body: 'Run them all.', acceptance: ['Tests pass'] },
      standards: 'Run targeted checks only.', autoHandle: 'Allow test runs.', prompt: { tool: 'Bash', input: { command: 'echo tests' } }
    })
    expect(runner.start.mock.calls[0][0].tempRoot).toBe(join(state.gui.root, 'arbiter'))
    expect(settings).toHaveBeenCalled()
    expect(new Set(folders)).toEqual(new Set([state.gui.repo]))
    expect(state.gui.store.readTranscript(chat)!.items.find(item => item.kind === 'approval_decision')).toMatchObject({ decision: 'allow_once', decidedBy: 'magos', reason: 'Routine.' })
    // The bound attempt's ticket key, through the same reads, stamps the worker thread.
    await vi.waitFor(() => expect(state.gui.store.readTranscript(chat)!.items.find(item => item.id === WORKER_THREAD)).toMatchObject({ callsign: { ticketKey: 'DM-442', ticketVerified: true } }))
  })

  it('a failing context read escalates to the person and starts no arbiter (DM-1011)', async () => {
    const runner = stubRunner({ verdict: { decision: 'deny', reason: 'Not needed.' } })
    const state = open(undefined, { startArbiter: runner.start }), chat = magosChat(state)
    await state.wiring.agentChats.start(chat)
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledOnce(), { timeout: 5_000 })
    expect(state.wiring.agentChats.snapshot(chat).pending?.arbitration).toEqual({
      state: 'escalated', reason: 'The Magos could not read the ticket or the Standards for this request; decide this yourself.'
    })
    expect(runner.start).not.toHaveBeenCalled()
  })

  it('settings with the arbiter off reach the gate: no arbiter runs and the OS notifier is told', async () => {
    const runner = stubRunner()
    const state = open(undefined, { settings: () => withArbitration({ enabled: false }), startArbiter: runner.start }), chat = magosChat(state)
    await state.wiring.agentChats.start(chat)
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledOnce(), { timeout: 5_000 })
    expect(state.notify.mock.calls[0][0]).toMatchObject({ kind: 'approval_needed', key: promptKey(chat, 'req_T1_worker_approval'), target: { kind: 'chat', folder: chat.folder, chatId: chat.id } })
    expect(runner.start).not.toHaveBeenCalled()
  })
})

describe('agent chat wiring: quit cancels every arbiter', () => {
  it('quit cancels a hanging real arbiter within 5 s, its process gone and its working folder removed', async () => {
    // The fake CLI's arbiter mode hangs on the `[arbiter:hang]` keyword, which the auto-handle notes carry into its stdin.
    const state = open(undefined, { settings: () => withArbitration({ autoHandleNotes: '[arbiter:hang]' }), arbiterReads: () => projectReads() }), chat = magosChat(state)
    await state.wiring.agentChats.start(chat)
    const log = join(state.gui.root, 'agent.jsonl')
    const arbiterPid = await vi.waitFor(() => {
      const entry = readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map(text => JSON.parse(text) as { mode: string; pid: number }).find(line => line.mode === 'arbiter')
      expect(entry).toBeDefined()
      return entry!.pid
    }, { timeout: 10_000 })
    expect(state.wiring.agentChats.snapshot(chat).pending?.arbitration.state).toBe('deciding')
    const started = performance.now()
    await state.wiring.dispose()
    expect(performance.now() - started).toBeLessThan(5_000)
    expect(alive(arbiterPid)).toBe(false)
    expect(readdirSync(join(state.gui.root, 'arbiter'))).toEqual([])
  })

  it('a stuck arbiter whose runner never settles still lets the quit finish within the 5 s bound', async () => {
    const runner = stubRunner({ stuck: true })
    const state = open(undefined, { startArbiter: runner.start, arbiterReads: () => projectReads() }), chat = magosChat(state)
    await state.wiring.agentChats.start(chat)
    await vi.waitFor(() => expect(runner.start).toHaveBeenCalledOnce(), { timeout: 5_000 })
    const listeners: ((event: { preventDefault(): void }) => void)[] = []
    const quitApp = { on: (_name: 'before-quit', listener: (event: { preventDefault(): void }) => void) => { listeners.push(listener) }, quit: vi.fn() }
    const disposed = vi.fn(), released = vi.fn()
    disposeBeforeQuit(quitApp, { busy: () => state.wiring.busy(), dispose: () => state.wiring.dispose().then(disposed), release: released, waitForRelease: true, timeoutMs: 5_000 })
    const started = performance.now()
    listeners[0]({ preventDefault: vi.fn() })
    await vi.waitFor(() => expect(quitApp.quit).toHaveBeenCalledOnce(), { timeout: 6_000 })
    expect(performance.now() - started).toBeLessThan(5_000)
    // The arbiter's own 4 s bound ended the dispose, not the quit's 5 s cut-off.
    expect([runner.cancels.mock.calls.length, disposed.mock.calls.length, released.mock.calls.length]).toEqual([1, 1, 1])
  })
})

describe('agent chat wiring: the arbiter root', () => {
  it('sweeps stale arbiter working folders at startup, keeping the root', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm arbiter sweep ')))
    try {
      const arbiterRoot = join(root, 'agents', 'arbiter')
      mkdirSync(join(arbiterRoot, 'dm-arbiter-stale', 'nested'), { recursive: true })
      writeFileSync(join(arbiterRoot, 'dm-arbiter-stale', 'nested', 'request.txt'), 'old')
      writeFileSync(join(arbiterRoot, 'stray.txt'), 'old')
      open(undefined, { arbiterRoot })
      expect([existsSync(arbiterRoot), readdirSync(arbiterRoot)]).toEqual([true, []])
    } finally {
      removeScratch(root)
    }
  })

  it('starts with no arbiter root yet, and creates none', () => {
    const state = open()
    expect(existsSync(join(state.gui.root, 'arbiter'))).toBe(false)
  })
})

describe('agent chat wiring: attention reaches the OS notifier', () => {
  it('an escalated worker approval names its callsign and lands on the chat, thread and prompt', async () => {
    const runner = stubRunner({ verdict: { decision: 'escalate', cause: 'verdict', reason: 'Needs the person.' } })
    const state = open(undefined, { startArbiter: runner.start, arbiterReads: () => projectReads() }), chat = magosChat(state)
    await state.wiring.agentChats.start(chat)
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledOnce(), { timeout: 5_000 })
    const prompt = state.wiring.agentChats.snapshot(chat).pending!
    expect(prompt).toMatchObject({ id: 'req_T1_worker_approval', threadId: WORKER_THREAD, arbitration: { state: 'escalated' } })
    expect(state.notify).toHaveBeenCalledExactlyOnceWith({
      kind: 'approval_needed', key: promptKey(chat, 'req_T1_worker_approval'), title: 'Acolyte:DM-442 needs you', body: `wants to run: ${prompt.title}`,
      target: { kind: 'chat', folder: state.gui.repo, chatId: chat.id, threadId: WORKER_THREAD, promptId: 'req_T1_worker_approval' }
    })
    // Never the prompt's detail or tool input.
    expect(JSON.stringify(state.notify.mock.calls)).not.toContain('echo tests')
  })

  it("a stalled Magos chat goes quiet under its title, keyed by its chat and the silent span's start", () => {
    const state = open(), chat = state.gui.store.createChat({ folder: state.gui.repo, agent: 'claude', role: 'orchestrator', runId: RUN, allowSave: false, model: null, surface: 'gui' })
    state.gui.store.updateChat(chat, { title: 'Sprint 1 Magos' })
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000_000 })
    try {
      // The GUI manager's stall seam (DM-820) is the one the wiring hands its factory.
      state.owned().onAttention({ kind: 'run_stalled', ref: { folder: chat.folder, id: chat.id }, silentMs: 300_000 })
    } finally {
      vi.useRealTimers()
    }
    expect(state.notify).toHaveBeenCalledExactlyOnceWith({
      kind: 'run_stalled', key: `stall:${chat.id}:999700000`, title: 'Sprint 1 Magos went quiet', body: 'No output for 5 minutes.',
      target: { kind: 'chat', folder: state.gui.repo, chatId: chat.id }
    })
  })

  it("a question in the Magos chat's own thread names it by its root callsign, before the chat's title", async () => {
    const state = open(), chat = state.gui.store.createChat({ folder: state.gui.repo, agent: 'claude', role: 'orchestrator', runId: RUN, allowSave: false, model: null, surface: 'gui', firstPrompt: '[question]' })
    state.gui.store.updateChat(chat, { title: 'Sprint 1 Magos' })
    await state.wiring.agentChats.start(chat)
    await vi.waitFor(() => expect(state.notify).toHaveBeenCalledOnce(), { timeout: 5_000 })
    const prompt = state.wiring.agentChats.snapshot(chat).pending!
    expect(prompt).toMatchObject({ kind: 'question', threadId: null, callsign: { role: 'Magos' } })
    expect(state.notify).toHaveBeenCalledExactlyOnceWith({
      kind: 'question', key: promptKey(chat, prompt.id), title: 'Magos needs you', body: `has a question: ${prompt.title}`,
      target: { kind: 'chat', folder: state.gui.repo, chatId: chat.id, promptId: prompt.id }
    })
  })

  it('a failing notifier never throws into the gate or the session; the failure is logged', () => {
    const failure = new Error('notifier closed')
    const state = open(undefined, {}, { notify: () => { throw failure } })
    expect(() => state.owned().onAttention({ kind: 'run_stalled', ref: { folder: state.gui.repo, id: 'gone' }, silentMs: 300_000 })).not.toThrow()
    expect(state.onError).toHaveBeenCalledExactlyOnceWith(failure)
  })
})

describe('agent chat wiring: the prompt dedupe key is scoped to the chat', () => {
  it('the same prompt id waiting in two chats shows two OS notifications: the dedupe key is scoped to the chat', async () => {
    const shown: { title: string; body: string }[] = []
    class ShownNotification {
      static isSupported(): boolean { return true }
      constructor(readonly options: { title: string; body: string; silent: boolean }) {}
      on(): this { return this }
      show(): void { shown.push({ title: this.options.title, body: this.options.body }) }
    }
    const notifier = createNotifier({
      Notification: ShownNotification, windows: () => [], settings: () => DEFAULT_NOTIFICATION_SETTINGS,
      push: vi.fn(), logger: { info: vi.fn() }, now: () => 1_000_000
    })
    const notify = vi.fn((event: NotificationEvent) => notifier.notify(event))
    const state = open(undefined, { settings: () => withArbitration({ enabled: false }) }, { notify })
    const first = magosChat(state), second = magosChat(state)
    await Promise.all([state.wiring.agentChats.start(first), state.wiring.agentChats.start(second)])
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(2), { timeout: 5_000 })
    // Both chats' fake CLIs raise the same prompt id; each reaches the person.
    expect(notify.mock.calls.map(([event]) => event.key).sort()).toEqual([promptKey(first, 'req_T1_worker_approval'), promptKey(second, 'req_T1_worker_approval')].sort())
    expect(shown).toHaveLength(2)
    // The same prompt of the same chat still shows once.
    notifier.notify(notify.mock.calls[0][0])
    expect(shown).toHaveLength(2)
  })
})

const siteItem = (chatId: string, promptId: string, title: string): AttentionItem =>
  ({ chatId, promptId, kind: 'site', threadId: null, callsign: null, arbitration: 'off', title, shown: true })
const attentionPushes = (state: ReturnType<typeof app>) => state.gui.pushes.filter(event => event.type === 'attention')

describe('agent chat wiring: a pending browser origin (DM-897 c1)', () => {
  it('notifies browser_site under the chat title and becomes a site needs-you item, pushed and read, until it clears', () => {
    const state = open(), chat = state.terminalChat(), folder = state.gui.repo
    state.gui.store.updateChat(chat, { title: 'Docs worker' })
    state.wiring.sitePrompt({ kind: 'site', folder, chatId: chat.id, promptId: 'p-1', origin: 'https://new.example', requestedBy: 'agent' })
    expect(state.notify).toHaveBeenCalledExactlyOnceWith({
      kind: 'browser_site', key: 'site:p-1', title: 'Docs worker wants a site', body: 'https://new.example',
      target: { kind: 'chat', folder, chatId: chat.id }
    })
    const item = siteItem(chat.id, 'p-1', 'https://new.example')
    expect(state.wiring.agentChats.attention(folder)).toEqual([item])
    expect(state.wiring.agentChats.attention(null)).toEqual([])
    expect(attentionPushes(state)).toEqual([{ type: 'attention', folder, chatId: chat.id, items: [item] }])
    state.wiring.sitePrompt({ kind: 'site_cleared', folder, chatId: chat.id })
    expect(state.wiring.agentChats.attention(folder)).toEqual([])
    expect(attentionPushes(state).at(-1)).toEqual({ type: 'attention', folder, chatId: chat.id, items: [] })
    // Clearing what is not pending pushes nothing, and only a raised prompt notifies.
    state.wiring.sitePrompt({ kind: 'site_cleared', folder, chatId: chat.id })
    expect(attentionPushes(state)).toHaveLength(2)
    expect(state.notify).toHaveBeenCalledOnce()
  })

  it("never notifies the person's own ask, yet keeps its needs-you item until it clears", () => {
    const state = open(), chat = state.terminalChat(), folder = state.gui.repo
    state.wiring.sitePrompt({ kind: 'site', folder, chatId: chat.id, promptId: 'p-person', origin: 'https://mine.example', requestedBy: 'person' })
    expect(state.notify).not.toHaveBeenCalled()
    expect(state.wiring.agentChats.attention(folder)).toEqual([siteItem(chat.id, 'p-person', 'https://mine.example')])
    state.wiring.sitePrompt({ kind: 'site', folder, chatId: chat.id, promptId: 'p-page', origin: 'https://page.example', requestedBy: 'page' })
    expect(state.notify).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: 'browser_site', key: 'site:p-page' }))
    state.wiring.sitePrompt({ kind: 'site_cleared', folder, chatId: chat.id })
    expect(state.wiring.agentChats.attention(folder)).toEqual([])
  })
})

describe('agent chat wiring: a pending browser origin through the real notifier (DM-897 c1)', () => {
  it('through the real notifier, keyed by the prompt id and gated by the browser_site setting', () => {
    const shown: string[] = []
    class ShownNotification {
      static isSupported(): boolean { return true }
      constructor(readonly options: { title: string; body: string; silent: boolean }) {}
      on(): this { return this }
      show(): void { shown.push(`${this.options.title} | ${this.options.body}`) }
    }
    let settings = DEFAULT_NOTIFICATION_SETTINGS
    const notifier = createNotifier({ Notification: ShownNotification, windows: () => [], settings: () => settings, push: vi.fn(), logger: { info: vi.fn() }, now: () => 1_000_000 })
    const state = open(undefined, {}, { notify: event => notifier.notify(event) }), chat = state.terminalChat(), folder = state.gui.repo
    const raise = (promptId: string) => state.wiring.sitePrompt({ kind: 'site', folder, chatId: chat.id, promptId, origin: 'https://new.example', requestedBy: 'page' })
    raise('p-1')
    raise('p-1')
    expect(shown).toEqual(['New chat wants a site | https://new.example'])
    settings = { ...DEFAULT_NOTIFICATION_SETTINGS, events: { ...DEFAULT_NOTIFICATION_SETTINGS.events, browser_site: false } }
    raise('p-2')
    expect(shown).toHaveLength(1)
    // The item stands whether or not the OS notification shows.
    expect(state.wiring.agentChats.attention(folder)).toEqual([siteItem(chat.id, 'p-2', 'https://new.example')])
  })
})

describe('agent chat wiring: a pending browser origin of a live GUI chat (DM-897 c1)', () => {
  it("joins a live GUI chat's own prompt queue in one push", async () => {
    const state = open(undefined, { settings: () => withArbitration({ enabled: false }) }), chat = magosChat(state), folder = state.gui.repo
    await state.wiring.agentChats.start(chat)
    await vi.waitFor(() => expect(state.wiring.agentChats.attention(folder)).toHaveLength(1), { timeout: 5_000 })
    state.wiring.sitePrompt({ kind: 'site', folder, chatId: chat.id, promptId: 'p-9', origin: 'https://docs.example', requestedBy: 'agent' })
    const items = state.wiring.agentChats.attention(folder)
    expect(items.map(item => [item.kind, item.promptId, item.shown])).toEqual([['approval', 'req_T1_worker_approval', true], ['site', 'p-9', true]])
    expect(attentionPushes(state).at(-1)).toEqual({ type: 'attention', folder, chatId: chat.id, items })
  })
})

describe('agent chat wiring: browser tool approvals never reach the arbiter (DM-897 c2, R19-1)', () => {
  const approval = (id: string, tool: NonNullable<PendingPrompt['tool']>): PendingPrompt => ({
    id, kind: 'approval', title: `${tool.name} wants to run`, detail: '', threadId: null, callsign: null, attributed: true,
    arbitration: { state: 'off', reason: null }, tool, options: [{ id: 'allow_once', label: 'Allow once' }, { id: 'deny', label: 'Deny' }]
  })
  const gateOf = (state: ReturnType<typeof app>, chat: ChatRef, prompt: PendingPrompt) => state.owned().arbitrate({
    ref: chat, chat: state.gui.store.getChat(chat)!, agent: state.gui.deps.agentFor('claude')!, prompt, inputClipped: false
  })

  it("Claude's Bash `dm call browser_*` and MCP browser_* prompts go to the person; another Bash command reaches the runner", async () => {
    const runner = stubRunner({ verdict: { decision: 'allow_once', reason: 'Routine.' } })
    const state = open(undefined, { startArbiter: runner.start, arbiterReads: () => projectReads() }), chat = magosChat(state)
    const browserPrompts = [
      approval('p-cli', { name: 'Bash', input: { command: 'dm call browser_navigate --args-file nav.json' } }),
      approval('p-cli-path', { name: 'Bash', input: { command: 'node dm.mjs call  browser_click --ref e12' } }),
      approval('p-mcp', { name: 'mcp__darkmechanicus__browser_navigate', input: { url: 'docs' } }),
      approval('p-bare', { name: 'browser_screenshot', input: {} })
    ]
    for (const prompt of browserPrompts) {
      const gate = gateOf(state, chat, prompt)
      expect([prompt.id, gate.state, gate.state === 'deciding' ? null : gate.reason]).toEqual([prompt.id, 'escalated', exclusionText('never_arbitrate')])
    }
    expect(runner.start).not.toHaveBeenCalled()
    const other = gateOf(state, chat, approval('p-echo', { name: 'Bash', input: { command: 'echo tests' } }))
    expect(other.state).toBe('deciding')
    await vi.waitFor(() => expect(runner.start).toHaveBeenCalledOnce(), { timeout: 5_000 })
    // A command that only mentions a browser tool without calling one is not excluded by this rule.
    expect(gateOf(state, chat, approval('p-grep', { name: 'Bash', input: { command: 'echo browser_navigate' } })).state).toBe('deciding')
  })

  it('the rule is removed when the wiring is disposed', async () => {
    const state = open(), chat = magosChat(state)
    const record = state.gui.store.getChat(chat)!
    await state.wiring.dispose()
    // The registry is process-wide: once disposed, the wiring's browser rule no longer excludes.
    expect(arbitrationExclusion({
      chat: record, agentKind: 'claude', folder: record.folder, settings: DEFAULT_NOTIFICATION_SETTINGS, platform: process.platform, allowedRoots: [],
      prompt: approval('p-mcp', { name: 'mcp__darkmechanicus__browser_navigate', input: { url: 'docs' } })
    })).toBeNull()
  })
})

const surfaceRequest = (state: ReturnType<typeof app>, chat: ChatRef, extra: Record<string, unknown> = {}) => ({ folder: state.gui.repo, chatId: chat.id, surface: 'gui', ...extra })
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true } catch { return false } }

describe('agent chat wiring: quit', () => {
  it('holds quit while a GUI chat starts and quits only after its process is disposed', async () => {
    const state = open(), chat = state.gui.newChat()
    const started = state.wiring.agentChats.start(chat)
    expect(state.wiring.busy()).toBe(true)
    await started
    const pid = state.gui.children[0].pid!
    const listeners: ((event: { preventDefault(): void }) => void)[] = []
    const order: string[] = []
    const quitApp = { on: (_name: 'before-quit', listener: (event: { preventDefault(): void }) => void) => { listeners.push(listener) }, quit: vi.fn(() => { order.push(`quit:${alive(pid)}`) }) }
    disposeBeforeQuit(quitApp, { busy: () => state.wiring.busy(), dispose: () => state.wiring.dispose(), release: () => { order.push(`release:${alive(pid)}`) }, waitForRelease: true, timeoutMs: 5_000 })
    const preventDefault = vi.fn()
    listeners[0]({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    await vi.waitFor(() => expect(quitApp.quit).toHaveBeenCalledOnce(), { timeout: 5_000 })
    expect(order).toEqual(['release:false', 'quit:false'])
    expect(state.wiring.agentChats.isLive(chat)).toBe(false)
  })

  it('is busy while a chat terminal runs, and disposes it with the GUI', async () => {
    const state = open(), chat = state.terminalChat()
    const { pty } = await startTerminal(state.terminals, chat)
    expect(state.wiring.busy()).toBe(true)
    let settled = false
    const disposed = state.wiring.dispose().then(() => { settled = true })
    await settle()
    expect([pty.kills, settled]).toEqual([1, false])
    pty.exit()
    await disposed
    expect(state.terminals.revoked).toEqual(['gr_1'])
  })
})

describe('agent chat wiring: the chat handlers share the one GUI manager', () => {
  const EPIC = { id: 'ep_01m418epbg8qkqa2e2krvdkqk5', title: 'Agent chats', branch: null } as EpicDetailView
  const RUN = { id: 'rn_2', number: 2, epicId: EPIC.id, state: 'queued' } as RunView

  it('starts a GUI orchestrator through wiring.agentChats, which quit holds and disposes, and reads it live', async () => {
    const state = open(), agent = state.gui.deps.agentFor('claude')!
    const refuse = (): Promise<never> => Promise.reject(new Error('Not used here.'))
    const handlers = createChatHandlers({
      registry: { resolve: path => path === state.gui.repo ? path : null, list: () => [] },
      agents: { get: id => id === agent.id ? agent : null },
      chats: createChatRecords({ store: state.gui.store, agentFor: id => id === agent.id ? agent : null }),
      terminals: state.terminals.sessions,
      agentChats: state.wiring.agentChats,
      plannerAgents: { list: () => [agent], checkAuth: refuse },
      runs: { getEpic: async () => EPIC, queueRun: async () => RUN },
      transfers: { getEpic: refuse, getTransfer: refuse },
      kanban: { play: refuse, kickBack: refuse, branch: refuse }
    })

    const started = await handlers.startOrchestrator({ folder: state.gui.repo, epicId: EPIC.id, agent: agent.id }) as CommandResult<StartOrchestratorResult>

    if (!started.ok || started.data.chat === null) throw new Error(`not started: ${JSON.stringify(started)}`)
    const chat = started.data.chat
    expect([started.data.problem, chat.surface, state.gui.store.getChat(chat)?.epicId]).toEqual([null, 'gui', EPIC.id])
    expect([state.wiring.agentChats.isLive(chat), state.wiring.busy(), state.gui.children.length, state.terminals.host.spawns.length]).toEqual([true, true, 1, 0])
    expect(await handlers.read({ folder: chat.folder, chatId: chat.id })).toMatchObject({ ok: true, data: { chat: { id: chat.id } } })
    const pid = state.gui.children[0].pid!
    await state.wiring.dispose()
    expect([state.wiring.agentChats.isLive(chat), alive(pid)]).toEqual([false, false])
  })
})

describe('agent chat wiring: one owner per chat', () => {
  it('refuses a terminal start while the GUI process of the chat is live', async () => {
    const state = open(), chat = state.gui.newChat()
    await state.wiring.agentChats.start(chat)
    await expect(state.terminals.sessions.attach(chat)).rejects.toMatchObject({ code: 'busy_elsewhere' })
    expect(state.terminals.host.spawns).toHaveLength(0)
  })

  it('refuses a GUI start while the terminal of the chat is live, through the IPC too', async () => {
    const state = open(), chat = state.terminalChat()
    await startTerminal(state.terminals, chat)
    expect(await state.wiring.agentChats.start(chat)).toEqual({ code: 'busy_elsewhere' })
    expect(await state.invoke(AGENT_CHAT_CHANNELS.start, { folder: state.gui.repo, chatId: chat.id })).toMatchObject({ ok: false, error: { code: 'busy_elsewhere' } })
    expect(state.gui.children).toHaveLength(0)
  })
})

describe('agent chat wiring: deletion', () => {
  it('stops the GUI process and revokes its grant before the record goes', async () => {
    const state = open(), chat = state.gui.newChat()
    await state.wiring.agentChats.start(chat)
    const pid = state.gui.children[0].pid!
    const seen: boolean[] = []
    const records = { deleteChat: async (ref: ChatRef) => { seen.push(alive(pid), state.gui.revoked.includes('grant-1')); state.gui.store.deleteChat(ref) } }
    await endingAgentChats(records, state.terminals.sessions, state.wiring.agentChats).deleteChat(chat)
    expect(seen).toEqual([false, true])
    expect(state.gui.store.getChat(chat)).toBeNull()
  })

  it('refuses a GUI start while the chat is being deleted', async () => {
    const state = open(), chat = state.gui.newChat(), held = gate<void>()
    const records = { deleteChat: async (ref: ChatRef) => { await held.promise; state.gui.store.deleteChat(ref) } }
    const deleting = endingAgentChats(records, state.terminals.sessions, state.wiring.agentChats).deleteChat(chat)
    await settle()
    await expect(state.wiring.agentChats.start(chat)).rejects.toThrow('The chat is stopping.')
    held.open()
    await deleting
    expect(state.gui.children).toHaveLength(0)
  })
})

describe('agent chat wiring: untrack and agent removal', () => {
  it('untracking a folder stops its GUI process and its terminal, revokes both grants, then forgets it', async () => {
    const state = open(), chat = state.gui.newChat(), terminalChat = state.terminalChat()
    await state.wiring.agentChats.start(chat)
    const { pty } = await startTerminal(state.terminals, terminalChat)
    const pid = state.gui.children[0].pid!
    const seen: unknown[] = []
    await releasingChatOwners(state.terminals.sessions, state.wiring.agentChats).releaseFolder(state.gui.repo, async () => {
      seen.push(alive(pid), state.gui.revoked, pty.kills, state.terminals.revoked.length)
      await state.wiring.agentChats.start(chat).catch((error: Error) => seen.push(error.message))
    })
    expect(seen).toEqual([false, ['grant-1'], 1, 1, "The chat's folder is being untracked."])
    // The fake PTY exits only when told; its kill and revocation, asked before `forget`, are what untrack waits for.
    expect(state.wiring.agentChats.isLive(chat)).toBe(false)
  })

  it('removing an agent stops the GUI processes and terminals of its chats', async () => {
    const state = open(), chat = state.gui.newChat(), terminalChat = state.terminalChat()
    await state.wiring.agentChats.start(chat)
    const { pty } = await startTerminal(state.terminals, terminalChat)
    const pid = state.gui.children[0].pid!
    await releasingChatOwners(state.terminals.sessions, state.wiring.agentChats).endAgent('claude')
    expect([alive(pid), state.gui.revoked, pty.kills]).toEqual([false, ['grant-1'], 1])
    expect(state.wiring.agentChats.isLive(chat)).toBe(false)
  })
})

describe('agent chat wiring: the native confirmation of a terminal→GUI switch', () => {
  it('asks Cancel-first, modal to the requesting window, and changes nothing on Cancel', async () => {
    const state = open(async () => ({ response: 0 })), chat = state.terminalChat()
    const { pty } = await startTerminal(state.terminals, chat)
    const owner = state.terminals.sessions.owner(chat)
    expect(await state.invoke(AGENT_CHAT_CHANNELS.setSurface, surfaceRequest(state, chat))).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    const [window, options] = state.showMessageBox.mock.calls[0]
    expect(window).toBe(WINDOW)
    expect(options).toMatchObject({ buttons: ['Cancel', 'Stop terminal and switch'], defaultId: 0, cancelId: 0 })
    expect(`${options.message} ${options.detail}`).toMatch(/interrupted[\s\S]*same session/)
    expect([state.terminals.sessions.owner(chat), pty.kills, state.terminals.revoked, state.gui.store.getChat(chat)!.surface, state.pushes]).toEqual([owner, 0, [], 'terminal', []])
  })

  for (const [label, dialog] of [
    ['the dialog fails', async () => { throw new Error('dialog failed') }],
    ['the dialog is closed', async () => ({ response: -1 })]
  ] as const) it(`refuses without side effects when ${label}`, async () => {
    const state = open(dialog), chat = state.terminalChat()
    const { pty } = await startTerminal(state.terminals, chat)
    expect(await state.invoke(AGENT_CHAT_CHANNELS.setSurface, surfaceRequest(state, chat))).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect([pty.kills, state.terminals.revoked, state.gui.store.getChat(chat)!.surface, state.pushes]).toEqual([0, [], 'terminal', []])
  })

  it('asks no window but the sender’s: a request from a window that is gone refuses', async () => {
    const state = open(async () => ({ response: 1 })), chat = state.terminalChat()
    const { pty } = await startTerminal(state.terminals, chat)
    const elsewhere = { ...TRUSTED, sender: { id: 'closed' } } as unknown as IpcMainInvokeEvent
    expect(await state.invoke(AGENT_CHAT_CHANNELS.setSurface, surfaceRequest(state, chat), elsewhere)).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect([state.showMessageBox.mock.calls.length, pty.kills, state.gui.store.getChat(chat)!.surface]).toEqual([0, 0, 'terminal'])
  })

  it('after a Cancel, a fresh approved request stops only that owner, keeps the session and pushes once', async () => {
    const answers = [0, 1]
    const state = open(async () => ({ response: answers.shift()! })), chat = state.terminalChat()
    const { pty } = await startTerminal(state.terminals, chat)
    const session = state.gui.store.getChat(chat)!.sessionId
    expect(await state.invoke(AGENT_CHAT_CHANNELS.setSurface, surfaceRequest(state, chat))).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    const switching = state.invoke(AGENT_CHAT_CHANNELS.setSurface, surfaceRequest(state, chat))
    await vi.waitFor(() => expect(pty.kills).toBe(1))
    pty.exit()
    expect(await switching).toMatchObject({ ok: true, data: { surface: 'gui' } })
    expect(state.showMessageBox).toHaveBeenCalledTimes(2)
    expect(state.terminals.revoked).toEqual(['gr_1'])
    expect(state.terminals.sessions.isLive(chat)).toBe(false)
    expect(state.gui.store.getChat(chat)).toMatchObject({ surface: 'gui', sessionId: session })
    expect(state.pushes).toEqual([{ type: 'chats_changed', folder: state.gui.repo, chatId: chat.id }])
  })
})

describe('agent chat wiring: stale, duplicate and renderer-shaped terminal→GUI requests', () => {
  it('refuses an approval given while the owner was replaced, leaving the new owner untouched', async () => {
    const answer = gate<{ response: number }>()
    const state = open(() => answer.promise), chat = state.terminalChat()
    const first = await startTerminal(state.terminals, chat)
    const switching = state.invoke(AGENT_CHAT_CHANNELS.setSurface, surfaceRequest(state, chat))
    await vi.waitFor(() => expect(state.showMessageBox).toHaveBeenCalledOnce())
    first.pty.exit()
    await settle()
    const second = await startTerminal(state.terminals, chat)
    const replaced = state.terminals.sessions.owner(chat)
    answer.open({ response: 1 })
    expect(await switching).toMatchObject({ ok: false, error: { code: 'busy' } })
    expect([state.terminals.sessions.owner(chat), second.pty.kills, state.gui.store.getChat(chat)!.surface, state.pushes]).toEqual([replaced, 0, 'terminal', []])
  })

  it('refuses a duplicate request while the dialog waits, and shows one dialog', async () => {
    const answer = gate<{ response: number }>()
    const state = open(() => answer.promise), chat = state.terminalChat()
    const { pty } = await startTerminal(state.terminals, chat)
    const first = state.invoke(AGENT_CHAT_CHANNELS.setSurface, surfaceRequest(state, chat))
    await vi.waitFor(() => expect(state.showMessageBox).toHaveBeenCalledOnce())
    expect(await state.invoke(AGENT_CHAT_CHANNELS.setSurface, surfaceRequest(state, chat))).toMatchObject({ ok: false, error: { code: 'busy' } })
    answer.open({ response: 0 })
    expect(await first).toMatchObject({ ok: false, error: { code: 'cancelled' } })
    expect([state.showMessageBox.mock.calls.length, pty.kills, state.gui.store.getChat(chat)!.surface]).toEqual([1, 0, 'terminal'])
  })

  for (const flag of ['confirmed', 'force']) it(`refuses a renderer \`${flag}\` flag before any dialog or stop`, async () => {
    const state = open(async () => ({ response: 1 })), chat = state.terminalChat()
    const { pty } = await startTerminal(state.terminals, chat)
    expect(await state.invoke(AGENT_CHAT_CHANNELS.setSurface, surfaceRequest(state, chat, { [flag]: true }))).toMatchObject({ ok: false, error: { code: 'invalid_input' } })
    expect([state.showMessageBox.mock.calls.length, pty.kills, state.gui.store.getChat(chat)!.surface]).toEqual([0, 0, 'terminal'])
  })

  it('switches without a dialog when no terminal runs', async () => {
    const state = open(), chat = state.terminalChat()
    expect(await state.invoke(AGENT_CHAT_CHANNELS.setSurface, surfaceRequest(state, chat))).toMatchObject({ ok: true, data: { surface: 'gui' } })
    expect(state.showMessageBox).not.toHaveBeenCalled()
  })
})

describe('agent chat preload bridge', () => {
  const preload = readFileSync(fileURLToPath(new URL('../../preload/index.ts', import.meta.url)), 'utf8')

  it('invokes and listens on exactly the channels main registers and pushes', () => {
    const state = open()
    const invoked = [...preload.matchAll(/ipcRenderer\.invoke\(AGENT_CHAT_CHANNELS\.([A-Za-z]+)/g)].map(match => AGENT_CHAT_CHANNELS[match[1] as keyof typeof AGENT_CHAT_CHANNELS]).sort()
    const listened = [...preload.matchAll(/ipcRenderer\.on\(AGENT_CHAT_CHANNELS\.([A-Za-z]+)/g)].map(match => AGENT_CHAT_CHANNELS[match[1] as keyof typeof AGENT_CHAT_CHANNELS])
    expect(invoked).toEqual([...state.listeners.keys()].sort())
    expect([...invoked, ...listened].sort()).toEqual(Object.values(AGENT_CHAT_CHANNELS).sort())
    expect(listened).toEqual([AGENT_CHAT_CHANNELS.event])
  })
})
