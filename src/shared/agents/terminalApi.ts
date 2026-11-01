/**
 * The terminal surface of the desktop bridge (`window.dm.terminals`, `docs/design/chat-shells.md`, question 2).
 * The renderer names a tracked folder and one of its chats, nothing else: which program runs, its arguments, its
 * folder and its environment come from main's own records. Once a chat's terminal runs, the attaching frame gets
 * one end of a message port for it, and only bytes typed and sizes travel back on it.
 */
import type { AgentId, CommandResult } from '../desktop/api'

/**
 * The one starting call: `TerminalAttachRequest`, a strict object. A start resumes the chat's earlier session
 * when its CLI has one, unless the request asks for a new session.
 */
export const TERMINAL_ATTACH_CHANNEL = 'terminals:attach'
/** Main posts the port of a running attach to the attaching frame on this channel, with a `TerminalPortGrant`. */
export const TERMINAL_PORT_CHANNEL = 'terminals:port'
/**
 * The sign-in terminal (`docs/design/chat-shells.md`, "Sign-in detection"): takes an agent id and nothing else, and
 * answers as `terminals:attach` does, posting the port of a running sign-in on `TERMINAL_PORT_CHANNEL`. Main runs the
 * agent's registered executable with the CLI's own login command, in the home folder, with no grant. Closing the
 * port (Back) stops the sign-in.
 */
export const TERMINAL_SIGN_IN_CHANNEL = 'agents:signIn'

/** The most an `input` message may carry, in UTF-8 bytes; a longer one is dropped. */
export const TERMINAL_INPUT_MAX_BYTES = 64 * 1024
/** What a `resize` is clamped to. */
export const TERMINAL_COLS = { min: 20, max: 500 } as const
export const TERMINAL_ROWS = { min: 5, max: 200 } as const

/**
 * How an attach ended: `running` (the PTY runs, and a port was posted), or why nothing runs. An attach that finds
 * the CLI's sign-in check under way (up to 30 s) answers once the start has ended.
 */
export type TerminalState = 'running' | 'refused' | 'signed_out' | 'failed'

/** What `terminals:attach` answers. */
export interface TerminalAttachView {
  state: TerminalState
  /** The screen as it is now (`running` only; empty for a start the attach waited for); what follows it comes on the port. */
  snapshot?: string
  /** Why nothing runs (`refused`, `signed_out`, `failed`). */
  message?: string
}

/** The answer as it crosses IPC: on `running`, also the id of the port main posted with it, which the preload claims. */
export interface TerminalAttachWire extends TerminalAttachView {
  port?: string
}

/** What comes with a posted port: the id its attach answer names. */
export interface TerminalPortGrant {
  port: string
}

/** What `terminals:attach` takes. `newSession` forgets the chat's stored session before a start (not while one runs). */
export interface TerminalAttachRequest {
  folder: string
  chatId: string
  newSession?: true
}

/** The renderer's side of the port: the only messages main accepts on it. */
export type TerminalPortRequest = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number }

/**
 * How the chat's PTY ended; `message` says why when main stopped it (a moved folder, idle, quit), and `resumed`
 * whether it ran on an earlier session of the chat, which the CLI may have refused (the pane then offers a new one).
 */
export interface TerminalExit {
  exitCode: number
  signal: number | null
  message: string | null
  resumed: boolean
}

/** Main's side of the port: the PTY's output, then its exit, after which the port is closed. */
export type TerminalPortEvent = { type: 'output'; data: string } | ({ type: 'exit' } & TerminalExit)

/** A running chat terminal, as the preload builds it from the posted port. */
export interface TerminalHandle {
  /** Input for the CLI, as typed; at most `TERMINAL_INPUT_MAX_BYTES` per call, or main drops it. */
  write(data: string): void
  /** The pane's size in whole cells; main clamps it to `TERMINAL_COLS` × `TERMINAL_ROWS`. */
  resize(cols: number, rows: number): void
  /** Subscribes to what the CLI prints after the snapshot; returns the unsubscribe function. */
  onOutput(listener: (data: string) => void): () => void
  /** Subscribes to the PTY's exit; returns the unsubscribe function. */
  onExit(listener: (exit: TerminalExit) => void): () => void
  /** Stops hearing the terminal (the PTY runs on). */
  close(): void
}

/** An attach as the renderer gets it: the answer, and the terminal when it runs (null otherwise). */
export interface TerminalAttachment extends TerminalAttachView {
  terminal: TerminalHandle | null
}

/** How an attach starts the chat's CLI when none runs. */
export interface TerminalAttachOptions {
  /** Start on a new session instead of resuming the chat's stored one. */
  newSession?: boolean
}

export interface TerminalsApi {
  /** Attaches to the chat's terminal, starting its CLI when none runs. */
  attach(folder: string, chatId: string, options?: TerminalAttachOptions): Promise<CommandResult<TerminalAttachment>>
  /**
   * Opens the agent's sign-in terminal (`TERMINAL_SIGN_IN_CHANNEL`), starting the CLI's own login when none runs; the
   * agent id is all it sends. Closing the terminal's handle (Back) stops the sign-in once no other view shows it.
   */
  signIn(agentId: AgentId): Promise<CommandResult<TerminalAttachment>>
}
