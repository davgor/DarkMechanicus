/**
 * The `terminals:attach` and `agents:signIn` channels and the port each hands out (`docs/design/chat-shells.md`,
 * question 2, "How main keeps it to what the person chose"). Free of Electron runtime imports: the port pair comes
 * from `deps.channel` (`MessageChannelMain` in the app), so it is unit tested with Node's message ports.
 *
 * **Attach names a chat, not a program.** The request is a strict `{ folder, chatId }`, with `newSession: true`
 * when the pane asks for a new session instead of the one a start would resume; registered through the
 * sender guard. The folder is checked first, as every `chats:*` request's is (`chatFolder`: tracked, and not
 * swapped for a symlink), then the chat is loaded from the store and must be that folder's own. The session
 * manager's attach then refuses a moved or untracked folder and a disconnected agent before any grant is issued,
 * and builds the spawn from main's records alone. An attach that finds the CLI's sign-in check under way answers
 * once the start has ended.
 *
 * **Sign-in names an agent, not a program.** The request is an agent id and nothing else, registered through the
 * same guard. The agent is read from main's registry (not connected: `not_found`; a custom CLI, whose login the app
 * does not know: `invalid_input`), and the sign-in terminals start its registered executable with the CLI's own
 * login command, in the home folder, with no grant (`loginTerminals.ts`).
 *
 * **The port.** On `running`, main posts one end of a fresh port pair to the asking frame (`senderFrame`), with
 * an id the answer names. Main's end accepts only `input` (a string of at most 64 KiB of UTF-8) and `resize`
 * (whole numbers, clamped to 20-500 × 5-200) and drops anything else. It carries the terminal's output after the
 * snapshot and its exit, to the ports attached to that terminal only, then closes. A port the frame closes (or a
 * frame that goes away) stops hearing the terminal; for a sign-in, the last one closing stops the sign-in.
 */
import { randomUUID } from 'node:crypto'
import type { IpcMain } from 'electron'
import { z } from 'zod'
import { DomainError } from '../../core/errors'
import { parseInput } from '../../core/schemas'
import { chatIdSchema } from '../../shared/agents/chat'
import {
  TERMINAL_ATTACH_CHANNEL,
  TERMINAL_COLS,
  TERMINAL_INPUT_MAX_BYTES,
  TERMINAL_PORT_CHANNEL,
  TERMINAL_ROWS,
  TERMINAL_SIGN_IN_CHANNEL,
  type TerminalAttachWire,
  type TerminalPortEvent,
  type TerminalPortGrant,
  type TerminalPortRequest
} from '../../shared/agents/terminalApi'
import type { CommandResult } from '../../shared/desktop/api'
import { answer, chatFolder, folderSchema } from '../agents/chatHandlers'
import type { ChatRef, ChatStore } from '../agents/chatStore'
import { connectedAgent } from '../desktop/agentHandlers'
import type { AgentRegistry } from '../desktop/agentRegistry'
import type { FolderRegistry } from '../desktop/folderRegistry'
import type { LoginAttach, LoginTerminals } from './loginTerminals'
import type { TerminalAttach, TerminalEvent, TerminalListener, TerminalSessions } from './terminalSessions'

const attachSchema = z.strictObject({ folder: folderSchema, chatId: chatIdSchema, newSession: z.literal(true).optional() })
const inputSchema = z.strictObject({ type: z.literal('input'), data: z.string() })
const resizeSchema = z.strictObject({ type: z.literal('resize'), cols: z.int(), rows: z.int() })

const FRAME_GONE = 'The window closed before its terminal could be attached.'
const NO_WINDOW_SIGN_IN = 'Refused a sign-in that came from no window.'

/** Main's end of a port pair, as Electron's `MessagePortMain` has it. */
export interface TerminalMainPort {
  postMessage(message: TerminalPortEvent): void
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown
  on(event: 'close', listener: () => void): unknown
  start(): void
  close(): void
}

/** The attaching frame, as Electron's `WebFrameMain` has it. */
export interface TerminalFrame {
  postMessage(channel: string, message: TerminalPortGrant, transfer?: unknown[]): void
}

interface TerminalHandlerDeps {
  registry: Pick<FolderRegistry, 'resolve'>
  store: Pick<ChatStore, 'getChat'>
  sessions: Pick<TerminalSessions, 'attach' | 'detach' | 'write' | 'resize'>
  /** The connected agents, which a sign-in is started for. */
  agents: Pick<AgentRegistry, 'get'>
  logins: Pick<LoginTerminals, 'attach' | 'detach' | 'write' | 'resize'>
  /** A fresh port pair: `local` stays in main, `remote` is posted to the frame. */
  channel: () => { local: TerminalMainPort; remote: unknown }
  newPortId?: () => string
  /** Told about failures that are not DomainErrors (bugs, I/O), so main can log the stack. */
  onUnexpectedError?: (error: unknown) => void
}

/** Arguments are `unknown` because they come straight from IPC. */
export interface TerminalHandlers {
  attach(frame: TerminalFrame | null, request: unknown): Promise<CommandResult<TerminalAttachWire>>
  signIn(frame: TerminalFrame | null, request: unknown): Promise<CommandResult<TerminalAttachWire>>
}

/** A message from the renderer's end of a port, as main accepts it; null for anything to drop. */
export function parsePortRequest(data: unknown): TerminalPortRequest | null {
  const input = inputSchema.safeParse(data)
  if (input.success) {
    // UTF-16 length bounds the UTF-8 size from below, so a long string is dropped before it is measured.
    const fits = input.data.data.length <= TERMINAL_INPUT_MAX_BYTES && Buffer.byteLength(input.data.data, 'utf8') <= TERMINAL_INPUT_MAX_BYTES
    return fits ? input.data : null
  }
  const resize = resizeSchema.safeParse(data)
  if (resize.success) {
    const { cols, rows } = resize.data
    return {
      type: 'resize',
      cols: Math.min(TERMINAL_COLS.max, Math.max(TERMINAL_COLS.min, cols)),
      rows: Math.min(TERMINAL_ROWS.max, Math.max(TERMINAL_ROWS.min, rows))
    }
  }
  return null
}

/** How a start that an attach waited for ended. */
type StartEnd = Extract<TerminalEvent, { kind: 'started' | 'not_started' }>

/** One port's terminal: a chat's (by its id) or an agent's sign-in (by the agent's id). */
interface LinkTarget {
  detach: (listener: TerminalListener) => void
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
}

/** One attach's port: what it hears of the terminal goes out on `local`, and what arrives on it goes to the terminal. */
interface PortLink {
  listener: TerminalListener
  remote: unknown
  /** Settles with how the start ended, for an attach that found a sign-in check under way. */
  startEnded: Promise<StartEnd>
  /** Starts taking the renderer's messages. */
  start: () => void
  /** Stops hearing the terminal and closes the port; safe to call again. */
  close: () => void
}

function openLink(deps: TerminalHandlerDeps, target: LinkTarget): PortLink {
  const { local, remote } = deps.channel()
  let open = true
  let endStart: (event: StartEnd) => void = () => {}
  // Promise.withResolvers is outside the TypeScript lib this repo targets.
  const startEnded = new Promise<StartEnd>((resolve) => {
    endStart = resolve
  })
  const close = (): void => {
    if (open) {
      open = false
      target.detach(listener)
      local.close()
    }
  }
  const listener: TerminalListener = (event) => {
    if (event.kind === 'started' || event.kind === 'not_started') {
      endStart(event)
      return
    }
    if (event.kind === 'output') {
      local.postMessage({ type: 'output', data: event.data })
    } else {
      local.postMessage({ type: 'exit', exitCode: event.exitCode, signal: event.signal, message: event.message, resumed: event.resumed })
      close()
    }
  }
  local.on('message', ({ data }) => {
    const request = parsePortRequest(data)
    try {
      if (request?.type === 'input') {
        target.write(request.data)
      } else if (request?.type === 'resize') {
        target.resize(request.cols, request.rows)
      }
    } catch (error) {
      // node-pty's resize throws for a PTY whose exit is not reported yet; nothing the renderer sends may throw in main.
      deps.onUnexpectedError?.(error)
    }
  })
  local.on('close', close)
  return { listener, remote, startEnded, start: () => local.start(), close }
}

/**
 * The chat the request names, from the store: it must be in the request's (checked) folder and be that folder's
 * own. With it, whether the request asks for a new session.
 */
function chatRequest(deps: TerminalHandlerDeps, input: unknown): { ref: ChatRef; newSession: boolean } {
  const request = parseInput(attachSchema, input, 'terminal request')
  const folder = chatFolder(deps, request.folder)
  const chat = deps.store.getChat({ folder, id: request.chatId })
  if (chat === null) {
    throw new DomainError('not_found', `No chat ${request.chatId} in ${folder}.`)
  }
  if (chat.folder !== folder) {
    throw new DomainError('not_found', `The chat ${chat.id} belongs to ${chat.folder}, not to ${folder}.`)
  }
  return { ref: { folder, id: chat.id }, newSession: request.newSession === true }
}

async function attach(deps: TerminalHandlerDeps, frame: TerminalFrame | null, input: unknown): Promise<TerminalAttachWire> {
  if (frame === null) {
    throw new DomainError('unauthorized', 'Refused a terminal attach that came from no window.')
  }
  const { ref, newSession } = chatRequest(deps, input)
  const link = openLink(deps, {
    detach: (listener) => deps.sessions.detach(ref.id, listener),
    write: (data) => deps.sessions.write(ref.id, data),
    resize: (cols, rows) => deps.sessions.resize(ref.id, cols, rows)
  })
  let outcome: TerminalAttach
  try {
    outcome = await deps.sessions.attach(ref, link.listener, { newSession })
  } catch (error) {
    link.close()
    throw error
  }
  if (outcome.state === 'checking') {
    const ended = await link.startEnded
    // The listener has heard everything since the spawn, so the screen it starts from is empty.
    outcome = ended.kind === 'started' ? { state: 'running', pid: ended.pid, snapshot: '' } : { state: ended.state, message: ended.message }
  }
  if (outcome.state !== 'running') {
    link.close()
    return { state: outcome.state, message: outcome.message }
  }
  return grantPort(deps, frame, link, outcome.snapshot)
}

/** Posts the link's remote end to `frame` with a fresh id, and answers running with it; closes the link when that fails. */
function grantPort(deps: TerminalHandlerDeps, frame: TerminalFrame, link: PortLink, snapshot: string): TerminalAttachWire {
  const port = (deps.newPortId ?? randomUUID)()
  try {
    frame.postMessage(TERMINAL_PORT_CHANNEL, { port }, [link.remote])
  } catch (error) {
    // A frame disposed mid-attach throws here; whatever the cause, the port goes nowhere.
    link.close()
    deps.onUnexpectedError?.(error)
    return { state: 'failed', message: FRAME_GONE }
  }
  link.start()
  return { state: 'running', snapshot, port }
}

async function signIn(deps: TerminalHandlerDeps, frame: TerminalFrame | null, input: unknown): Promise<TerminalAttachWire> {
  if (frame === null) {
    throw new DomainError('unauthorized', NO_WINDOW_SIGN_IN)
  }
  const agent = connectedAgent(deps.agents, input)
  if (agent.kind === 'custom') {
    throw new DomainError('invalid_input', `${agent.displayName} is a custom CLI; the app has no sign-in command for it. Sign it in from a terminal.`)
  }
  const link = openLink(deps, {
    detach: (listener) => deps.logins.detach(agent.id, listener),
    write: (data) => deps.logins.write(agent.id, data),
    resize: (cols, rows) => deps.logins.resize(agent.id, cols, rows)
  })
  let outcome: LoginAttach
  try {
    outcome = await deps.logins.attach(agent, link.listener)
  } catch (error) {
    link.close()
    throw error
  }
  if (outcome.state !== 'running') {
    link.close()
    return { state: outcome.state, message: outcome.message }
  }
  return grantPort(deps, frame, link, outcome.snapshot)
}

export function createTerminalHandlers(deps: TerminalHandlerDeps): TerminalHandlers {
  return {
    attach: (frame, input) => answer(deps, () => attach(deps, frame, input)),
    signIn: (frame, input) => answer(deps, () => signIn(deps, frame, input))
  }
}

/** Registers `terminals:attach` and `agents:signIn` on `ipc`: the sender-guarded registrar from `guardIpc`, whose event names the frame. */
export function registerTerminalIpc(ipc: Pick<IpcMain, 'handle'>, handlers: TerminalHandlers): void {
  ipc.handle(TERMINAL_ATTACH_CHANNEL, (event, request: unknown) => handlers.attach(event.senderFrame, request))
  ipc.handle(TERMINAL_SIGN_IN_CHANNEL, (event, request: unknown) => handlers.signIn(event.senderFrame, request))
}
