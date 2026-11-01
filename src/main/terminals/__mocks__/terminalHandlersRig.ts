/**
 * The `terminals:attach` and `agents:signIn` channels on fakes, for their tests: the real handlers registered through
 * the real sender guard on a fake `ipcMain`, over the terminal session manager's rig (fake PTY host, real folder
 * checks on a scratch folder), sign-in terminals on the same fake host, and real message ports. The manager is
 * wrapped to write down every listener attached and detached. Not shipped.
 */
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { MessagePort } from 'node:worker_threads'
import type { ChatRecord } from '../../../shared/agents/chat'
import { TERMINAL_ATTACH_CHANNEL, TERMINAL_SIGN_IN_CHANNEL, type TerminalAttachWire } from '../../../shared/agents/terminalApi'
import type { CommandResult } from '../../../shared/desktop/api'
import type { ChatStore } from '../../agents/chatStore'
import { guardIpc } from '../../ipcGuard'
import { builtInAgent, connectedAgents } from '../../agents/__mocks__/chatFixtures'
import { createLoginTerminals, type LoginTerminals } from '../loginTerminals'
import { createTerminalHandlers, registerTerminalIpc, type TerminalHandlers } from '../terminalHandlers'
import type { TerminalListener, TerminalSessions } from '../terminalSessions'
import { FakeFrame, Ports } from './terminalPorts'
import { CUSTOM_AGENT, terminalRig, type TerminalRig } from './terminalSessionsRig'

/** The packaged renderer page: the only sender the guard trusts here. */
export const PAGE = pathToFileURL('/opt/app/out/renderer/index.html').href

type Listener = Parameters<IpcMain['handle']>[1]

/** `ipcMain` as the guard wraps it: each channel's listener, invoked with a sender frame. */
class FakeIpcMain {
  private readonly listeners = new Map<string, Listener>()

  handle(channel: string, listener: Listener): void {
    this.listeners.set(channel, listener)
  }

  channels(): string[] {
    return [...this.listeners.keys()].sort()
  }

  async invoke(channel: string, frame: FakeFrame | null, ...args: unknown[]): Promise<unknown> {
    return this.listeners.get(channel)?.({ senderFrame: frame } as IpcMainInvokeEvent, ...args)
  }
}

export interface HandlersRig {
  rig: TerminalRig
  ports: Ports
  ipc: FakeIpcMain
  /** The handlers themselves, past the guard. */
  handlers: TerminalHandlers
  /** The trusted frame attaches come from unless a test names another. */
  frame: FakeFrame
  /** Every listener the handlers attached to the manager, and every one they detached, in order. */
  attached: TerminalListener[]
  detached: TerminalListener[]
  /** Every failure the handlers reported that was not a refusal. */
  errors: unknown[]
  /** `terminals:attach` with `payload`, from `frame` (the trusted one by default). */
  attach: (payload: unknown, frame?: FakeFrame | null) => Promise<CommandResult<TerminalAttachWire>>
  /** `agents:signIn` with `payload`, from `frame` (the trusted one by default). */
  signIn: (payload: unknown, frame?: FakeFrame | null) => Promise<CommandResult<TerminalAttachWire>>
  cleanup: () => void
}

/** The manager, writing down the listeners attached and detached. */
function recordingSessions(sessions: TerminalSessions, attached: TerminalListener[], detached: TerminalListener[]): TerminalSessions {
  return {
    ...sessions,
    attach: (ref, listener, options) => {
      if (listener !== undefined) {
        attached.push(listener)
      }
      return sessions.attach(ref, listener, options)
    },
    detach: (chatId, listener) => {
      detached.push(listener)
      sessions.detach(chatId, listener)
    }
  }
}

interface HandlersRigOptions {
  /** The chat store the handlers read; the rig's own by default. */
  store?: (store: ChatStore) => Pick<ChatStore, 'getChat'>
  /** The session manager the handlers use, over the rig's own. */
  sessions?: (sessions: TerminalSessions) => TerminalSessions
}

/** Sign-in terminals on the rig's fake PTY host, in its scratch home folder; a kill ends the fake PTY at once. */
function rigLogins(rig: TerminalRig): LoginTerminals {
  return createLoginTerminals({
    host: async () => rig.host,
    killTree: (tree) => {
      if (!tree.hasExited()) {
        tree.kill()
      }
      return Promise.resolve(true)
    },
    home: rig.root,
    platform: 'darwin',
    env: { PATH: '/usr/bin:/bin', HOME: rig.root }
  })
}

/** Resolves as the folder registry does: a tracked path as it is (even once it is gone), else the tracked real path. */
function rigResolve(rig: TerminalRig, path: string): string | null {
  if (rig.tracked.has(path)) {
    return path
  }
  try {
    const real = realpathSync.native(path)
    return rig.tracked.has(real) ? real : null
  } catch {
    return null
  }
}

export function handlersRig(options: HandlersRigOptions = {}): HandlersRig {
  const rig = terminalRig()
  const ports = new Ports()
  const ipc = new FakeIpcMain()
  const attached: TerminalListener[] = []
  const detached: TerminalListener[] = []
  const errors: unknown[] = []
  let portIds = 0
  const handlers = createTerminalHandlers({
    registry: { resolve: (path) => rigResolve(rig, path) },
    store: options.store?.(rig.store) ?? rig.store,
    sessions: recordingSessions(options.sessions?.(rig.sessions) ?? rig.sessions, attached, detached),
    // Connected: Claude Code, Autonomous and a custom CLI, as the session manager's rig has them.
    agents: { get: connectedAgents([builtInAgent('claude'), builtInAgent('autonomous'), CUSTOM_AGENT]) },
    logins: rigLogins(rig),
    channel: ports.channel,
    newPortId: () => `port-${(portIds += 1)}`,
    onUnexpectedError: (error) => {
      errors.push(error)
    }
  })
  registerTerminalIpc(guardIpc(ipc, { appUrl: PAGE }), handlers)
  const frame = new FakeFrame(PAGE)
  return {
    rig,
    ports,
    ipc,
    handlers,
    frame,
    attached,
    detached,
    errors,
    attach: async (payload, from = frame) => (await ipc.invoke(TERMINAL_ATTACH_CHANNEL, from, payload)) as CommandResult<TerminalAttachWire>,
    signIn: async (payload, from = frame) => (await ipc.invoke(TERMINAL_SIGN_IN_CHANNEL, from, payload)) as CommandResult<TerminalAttachWire>,
    cleanup: () => {
      ports.closeAll()
      rig.cleanup()
    }
  }
}

/** Attaches `chat` from `frame`, which must answer running, and answers with the answer and the port posted for it. */
export async function attachRunning(rig: HandlersRig, chat: Pick<ChatRecord, 'folder' | 'id'>, frame: FakeFrame = rig.frame): Promise<{ answer: TerminalAttachWire; port: MessagePort }> {
  const answer = await rig.attach({ folder: chat.folder, chatId: chat.id }, frame)
  if (!answer.ok) {
    throw new Error(`The attach was refused: ${answer.error.code}: ${answer.error.message}`)
  }
  if (answer.data.state !== 'running') {
    throw new Error(`The terminal did not start: ${answer.data.state}: ${answer.data.message ?? ''}`)
  }
  return { answer: answer.data, port: postedPort(frame, answer.data.port) }
}

/** The port main posted to `frame` with the id `id`. */
function postedPort(frame: FakeFrame, id: string | undefined): MessagePort {
  const posted = frame.posted.find(({ message }) => typeof message === 'object' && message !== null && 'port' in message && message.port === id)
  const port = posted?.transfer.find((candidate) => candidate instanceof MessagePort)
  if (port === undefined) {
    throw new Error(`No port was posted for ${id ?? '(no port id)'}.`)
  }
  return port
}

/** Opens the sign-in terminal of `agentId` from the rig's frame, which must answer running, with the port posted for it. */
export async function signInRunning(rig: HandlersRig, agentId: string): Promise<{ answer: TerminalAttachWire; port: MessagePort }> {
  const answer = await rig.signIn(agentId)
  if (!answer.ok || answer.data.state !== 'running') {
    throw new Error(`The sign-in did not start: ${JSON.stringify(answer)}`)
  }
  return { answer: answer.data, port: postedPort(rig.frame, answer.data.port) }
}
