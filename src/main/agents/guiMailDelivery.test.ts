/**
 * Pending person bodies reaching a chat over the production same-chat transport (`resumeChatOnSurface`,
 * `pasteBoardOnSurface`) with the real ledger and host-transcript observer, a fake GUI session manager and fake
 * terminals: a GUI recipient is started in the GUI (never a PTY) and gets each body once, a terminal recipient keeps its
 * terminal, and a GUI start that fails leaves the body pending with the real reason.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../core/errors'
import type { AgentChatSnapshot } from '../../shared/agents/agentChat'
import type { ChatRecord } from '../../shared/agents/chat'
import type { TerminalAttach, TerminalStart } from '../terminals/terminalSessions'
import { createAgentContextDelivery, type BoardContextTransport } from './agentContextDelivery'
import { pasteBoardOnSurface, resumeChatOnSurface } from './chatSurfaceStart'
import { createConversationDeliveries } from './conversationDeliveries'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const at = '2026-11-27T00:00:00.000Z'
const FOLDER = '/fixture'
const CLAUDE_SESSION = '11111111-2222-4333-8444-555555555555'
const MESSAGE = { id: 'board_gui', text: '[Board message from the person]\nComplete request for the GUI recipient.' }
const CONTENT = `[DarkMechanicus board delivery ${MESSAGE.id}]\n${MESSAGE.text}`

type GuiStart = AgentChatSnapshot | { code: 'busy_elsewhere' }
const snapshot = (status: string): GuiStart => ({ status }) as unknown as AgentChatSnapshot

/** The one GUI session manager, faked: `start` runs `answer` and a send is recorded with its text. */
function guiManager(answer: () => Promise<GuiStart> = () => Promise.resolve(snapshot('idle'))) {
  return {
    start: vi.fn((_ref: { folder: string | null; id: string }) => answer()),
    send: vi.fn((_ref: { folder: string | null; id: string }, _input: { text: string }) => Promise.resolve())
  }
}

function fakeTerminals() {
  return {
    attach: vi.fn(() => Promise.resolve<TerminalAttach>({ state: 'running', pid: 7 } as TerminalAttach)),
    detach: vi.fn(),
    paste: vi.fn((_chat: ChatRecord, _text: string, _id?: string) => Promise.resolve<TerminalStart>({ state: 'running', pid: 7 }))
  }
}

function rig(kind: 'omp' | 'claude', surface: ChatRecord['surface'], gui = guiManager()) {
  const root = mkdtempSync(join(tmpdir(), 'dm1048-gui-mail-'))
  roots.push(root)
  const config = join(root, 'claude-config')
  const chat: ChatRecord = {
    id: 'chat_gui_recipient', folder: FOLDER, agent: kind, role: 'worker', allowSave: false, endpointId: 'me_gui_recipient',
    model: null, title: 'Recipient', sessionId: kind === 'claude' ? CLAUDE_SESSION : null, createdAt: at, updatedAt: at, surface
  }
  const ledger = createConversationDeliveries({ userData: root, onChanged: vi.fn() })
  const delivery = createAgentContextDelivery({ userData: root, deliveries: ledger, agentKind: () => kind, env: { CLAUDE_CONFIG_DIR: config }, platform: process.platform })
  const transcript = kind === 'omp'
    ? join(root, 'agents', 'omp', chat.id, 'sessions', '2026-11-27T00-00-00-000Z_01234567-89ab-4cde-8123-456789abcdef.jsonl')
    : join(config, 'projects', '-fixture', `${CLAUDE_SESSION}.jsonl`)
  mkdirSync(dirname(transcript), { recursive: true })
  /** The host's own record of the body as a user turn: the only proof of delivery. */
  const hostReceives = (): void => {
    appendFileSync(transcript, JSON.stringify(kind === 'omp'
      ? { type: 'message', id: 'omp_entry', message: { role: 'user', content: CONTENT } }
      : { type: 'user', uuid: 'claude_entry', sessionId: CLAUDE_SESSION, message: { role: 'user', content: CONTENT } }) + '\n')
  }
  const terminals = fakeTerminals()
  const transport: BoardContextTransport = {
    resolveFolder: folder => folder,
    getChat: () => chat,
    resume: recipient => resumeChatOnSurface({ terminals, agentChats: gui }, recipient),
    paste: (recipient, message) => pasteBoardOnSurface({
      terminals, agentChats: gui, reserveBoardInput: (target, id, content) => delivery.reserveBoardInput(target, id, content)
    }, recipient, message)
  }
  const proof = () => ledger.proof(FOLDER, chat.id, 'board', MESSAGE.id)
  return { chat, gui, terminals, ledger, delivery, transport, hostReceives, proof }
}

describe('a stopped GUI recipient', () => {
  it('starts in the GUI with no PTY and takes the body once as a queued user turn, delivered only once its transcript shows it', async () => {
    const state = rig('claude', 'gui')
    await state.delivery.queueBoard(state.chat, MESSAGE)
    await state.delivery.reconcileBoard(FOLDER, state.transport)
    expect(state.gui.start).toHaveBeenCalledTimes(1)
    expect(state.gui.send.mock.calls).toEqual([[state.chat, { text: CONTENT }]])
    expect(state.terminals.attach).not.toHaveBeenCalled()
    expect(state.terminals.paste).not.toHaveBeenCalled()
    // Handed over is not delivered: the body stays pending, claimed so no later sweep sends it again.
    expect(state.proof()).toMatchObject({ state: 'pending', inputUncertain: true })
    await state.delivery.reconcileBoard(FOLDER, state.transport)
    expect(state.gui.send).toHaveBeenCalledTimes(1)
    state.hostReceives()
    await state.delivery.reconcileBoard(FOLDER, state.transport)
    await state.delivery.reconcileBoard(FOLDER, state.transport)
    expect(state.proof()).toMatchObject({ state: 'delivered' })
    expect(state.ledger.pending()).toEqual([])
    expect(state.gui.send).toHaveBeenCalledTimes(1)
    expect(state.terminals.paste).not.toHaveBeenCalled()
  })

  it('wakes a stopped GUI OMP recipient through the GUI manager and leaves the body to its extension', async () => {
    const state = rig('omp', 'gui')
    await state.delivery.queueBoard(state.chat, MESSAGE)
    await state.delivery.reconcileBoard(FOLDER, state.transport)
    expect(state.gui.start.mock.calls).toEqual([[state.chat]])
    expect(state.terminals.attach).not.toHaveBeenCalled()
    expect(state.proof()).toMatchObject({ state: 'pending', problem: null })
    state.hostReceives()
    await state.delivery.reconcileBoard(FOLDER, state.transport)
    expect(state.proof()).toMatchObject({ state: 'delivered' })
    expect(state.gui.send).not.toHaveBeenCalled()
    expect(state.terminals.paste).not.toHaveBeenCalled()
  })
})

describe('a live GUI recipient', () => {
  it('is not sent a body its extension already delivered', async () => {
    const state = rig('omp', 'gui')
    await state.delivery.queueBoard(state.chat, MESSAGE)
    state.hostReceives()
    await state.delivery.reconcileBoard(FOLDER, state.transport)
    await state.delivery.reconcileBoard(FOLDER, state.transport)
    expect(state.proof()).toMatchObject({ state: 'delivered' })
    expect(state.gui.start).not.toHaveBeenCalled()
    expect(state.gui.send).not.toHaveBeenCalled()
  })

  it('gets the body exactly once across the host receipt and the fallback send', async () => {
    const state = rig('claude', 'gui')
    // The live host records the turn as soon as it is sent.
    state.gui.send.mockImplementation(() => { state.hostReceives(); return Promise.resolve() })
    await state.delivery.queueBoard(state.chat, MESSAGE)
    for (let sweep = 0; sweep < 3; sweep += 1) await state.delivery.reconcileBoard(FOLDER, state.transport)
    expect(state.gui.send).toHaveBeenCalledTimes(1)
    expect(state.proof()).toMatchObject({ state: 'delivered' })
    expect(state.ledger.pending()).toEqual([])
  })

  it('does not send a body whose earlier input attempt is still unverified', async () => {
    const state = rig('claude', 'gui')
    await state.delivery.queueBoard(state.chat, MESSAGE)
    expect(state.delivery.reserveBoardInput(state.chat, MESSAGE.id, CONTENT)).toBe(true)
    expect(await state.transport.paste(state.chat, MESSAGE)).toMatch(/already sent/)
    expect(state.gui.send).not.toHaveBeenCalled()
  })
})

describe('a terminal recipient', () => {
  it('keeps its terminal paste and attach, never the GUI manager', async () => {
    const claude = rig('claude', 'terminal')
    await claude.delivery.queueBoard(claude.chat, MESSAGE)
    await claude.delivery.reconcileBoard(FOLDER, claude.transport)
    expect(claude.terminals.paste.mock.calls).toEqual([[claude.chat, CONTENT, MESSAGE.id]])
    const omp = rig('omp', undefined)
    await omp.delivery.queueBoard(omp.chat, MESSAGE)
    await omp.delivery.reconcileBoard(FOLDER, omp.transport)
    expect(omp.terminals.attach).toHaveBeenCalledTimes(1)
    for (const state of [claude, omp]) {
      expect(state.gui.start).not.toHaveBeenCalled()
      expect(state.gui.send).not.toHaveBeenCalled()
    }
  })
})

describe('a GUI start that fails', () => {
  it.each([
    ['failed', 'The agent process did not start.'],
    ['signed_out', 'The agent is signed out. Sign in from Agents, then start the chat again.']
  ])('leaves the body pending, unclaimed and unsent, with the real reason (%s)', async (status, reason) => {
    const state = rig('claude', 'gui', guiManager(() => Promise.resolve(snapshot(status))))
    await state.delivery.queueBoard(state.chat, MESSAGE)
    await state.delivery.reconcileBoard(FOLDER, state.transport)
    expect(state.proof()).toMatchObject({ state: 'pending', problem: reason })
    expect(state.proof()?.inputUncertain).toBeUndefined()
    expect(state.gui.send).not.toHaveBeenCalled()
    expect(state.terminals.paste).not.toHaveBeenCalled()
    state.gui.start.mockImplementation(() => Promise.resolve(snapshot('idle')))
    await state.delivery.reconcileBoard(FOLDER, state.transport)
    expect(state.gui.send).toHaveBeenCalledTimes(1)
  })

  it('records a refused GUI start as the blocker of a woken OMP recipient', async () => {
    const state = rig('omp', 'gui', guiManager(() => Promise.reject(new DomainError('unsupported', 'Forge setup conversations run only in the terminal.'))))
    await state.delivery.queueBoard(state.chat, MESSAGE)
    await state.delivery.reconcileBoard(FOLDER, state.transport)
    expect(state.proof()).toMatchObject({ state: 'pending', problem: 'Forge setup conversations run only in the terminal.' })
    expect(state.terminals.attach).not.toHaveBeenCalled()
  })

  it('reports a GUI recipient running in a terminal instead of pasting into it', async () => {
    const state = rig('claude', 'gui', guiManager(() => Promise.resolve({ code: 'busy_elsewhere' })))
    await state.delivery.queueBoard(state.chat, MESSAGE)
    await state.delivery.reconcileBoard(FOLDER, state.transport)
    expect(state.proof()).toMatchObject({ state: 'pending', problem: 'The chat is running in a terminal.' })
    expect(state.terminals.paste).not.toHaveBeenCalled()
  })
})
