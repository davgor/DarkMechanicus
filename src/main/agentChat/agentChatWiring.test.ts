/**
 * The production wiring of the two owners (`wireAgentChats`) over the real terminal manager (fake PTYs) and the real
 * GUI manager (the fake CLI), with the real `agentChat:*` handlers behind the sender guard and the real native
 * confirmation over an injected dialog. No Electron import: bootstrap passes only Electron's own pieces in.
 */
import type { IpcMain, IpcMainInvokeEvent, MessageBoxOptions } from 'electron'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CHAT_CHANNELS } from '../../shared/agents/agentChat'
import type { ChatPushEvent, StartOrchestratorResult } from '../../shared/agents/chatApi'
import type { ChatRecord } from '../../shared/agents/chat'
import type { CommandResult } from '../../shared/desktop/api'
import type { EpicDetailView, RunView } from '../../shared/domain/views'
import { createChatHandlers } from '../agents/chatHandlers'
import { createChatRecords } from '../agents/chatRecords'
import type { ChatRef } from '../agents/chatStore'
import { guardIpc } from '../ipcGuard'
import { disposeBeforeQuit } from '../quitDisposal'
import { gate, settle, startTerminal, terminalRig, type TerminalRig } from '../terminals/__mocks__/terminalSessionsRig'
import { agentChatRig } from './__mocks__/agentChatRig'
import { createAgentChatHandlers, registerAgentChatIpc } from './agentChatIpc'
import { endingAgentChats, nativeTerminalStopConfirmation, wireAgentChats, type AgentChatOwnerDeps } from './agentChatWiring'

type Listener = Parameters<IpcMain['handle']>[1]
const APP_URL = 'http://localhost:5173'
const WINDOW = { id: 'app-window' }
const SENDER = { id: 'app-contents' }
const TRUSTED = { sender: SENDER, senderFrame: { url: `${APP_URL}/`, parent: null, detached: false, isDestroyed: () => false } } as unknown as IpcMainInvokeEvent

/** One app: the terminals and the GUI over one store, wired as bootstrap wires them, with the guarded handlers. */
function app(dialog: (window: unknown, options: MessageBoxOptions) => Promise<{ response: number }> = async () => ({ response: 0 })) {
  // The rig builds the GUI manager; it reaches the terminals only through what `wireAgentChats` hands its factory.
  let owned: AgentChatOwnerDeps | undefined
  const gui = agentChatRig('claude', {
    terminalLive: ref => owned!.terminalLive(ref), terminalOwner: ref => owned!.terminalOwner(ref),
    stopTerminal: (ref, generation) => owned!.stopTerminal(ref, generation), onChatChanged: ref => owned!.onChatChanged?.(ref)
  })
  let terminalsRig: TerminalRig | undefined
  const pushes: ChatPushEvent[] = []
  const wiring = wireAgentChats({
    terminalsFactory: agentChatLive => {
      terminalsRig = terminalRig({ killSettlesAtOnce: true, deps: () => ({ store: gui.store, folders: { trackedFolder: path => path }, agentChatLive }) })
      return terminalsRig.sessions
    },
    agentChatsFactory: deps => { owned = deps; return gui.sessions },
    push: event => { pushes.push(event) }
  })
  const showMessageBox = vi.fn(dialog)
  const listeners = new Map<string, Listener>()
  const handlers = createAgentChatHandlers({
    registry: { resolve: path => path === gui.repo ? path : null },
    sessions: wiring.agentChats,
    confirmTerminalStop: nativeTerminalStopConfirmation<unknown, unknown>({ windowFor: sender => sender === SENDER ? WINDOW : null, showMessageBox })
  })
  registerAgentChatIpc(guardIpc({ handle: (channel, listener) => void listeners.set(channel, listener) }, { appUrl: APP_URL }), handlers, event => event.sender)
  const invoke = async <T>(channel: string, request: unknown, event = TRUSTED) => (await listeners.get(channel)!(event, request)) as CommandResult<T>
  const terminalChat = (): ChatRecord => gui.store.createChat({ folder: gui.repo, agent: 'claude', model: null, role: 'worker', allowSave: false, surface: 'terminal' })
  return { gui, terminals: terminalsRig!, wiring, pushes, showMessageBox, listeners, invoke, terminalChat }
}

let current: ReturnType<typeof app> | undefined
function open(dialog?: Parameters<typeof app>[0]): ReturnType<typeof app> {
  current = app(dialog)
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
