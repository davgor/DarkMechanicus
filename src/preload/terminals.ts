/**
 * `window.dm.terminals` (`docs/design/chat-shells.md`, question 2): one `terminals:attach` invoke naming a folder
 * and a chat, or one `agents:signIn` invoke naming an agent. For a running terminal main posts this frame one end of
 * a message port on `terminals:port`, with the id its answer names; the two can arrive in either order, so each
 * request claims its own port by that id (`PortClaims`). The handle built from the port sends only `input` and
 * `resize`, and tells output and the exit to its listeners. Free of Electron runtime imports, so it is unit tested
 * with Node's own message ports.
 */
import {
  TERMINAL_ATTACH_CHANNEL,
  TERMINAL_PORT_CHANNEL,
  TERMINAL_SIGN_IN_CHANNEL,
  type TerminalAttachment,
  type TerminalAttachRequest,
  type TerminalAttachWire,
  type TerminalExit,
  type TerminalHandle,
  type TerminalPortEvent,
  type TerminalPortRequest,
  type TerminalsApi
} from '../shared/agents/terminalApi'
import type { AgentId, CommandResult } from '../shared/desktop/api'

/** What the handle needs of the renderer's `MessagePort`. */
export interface RendererPort {
  postMessage(message: TerminalPortRequest): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  start(): void
  close(): void
}

/** What the terminals need of `ipcRenderer`. */
export interface TerminalIpc {
  invoke(channel: typeof TERMINAL_ATTACH_CHANNEL, request: TerminalAttachRequest): Promise<CommandResult<TerminalAttachWire>>
  invoke(channel: typeof TERMINAL_SIGN_IN_CHANNEL, agentId: AgentId): Promise<CommandResult<TerminalAttachWire>>
  on(channel: typeof TERMINAL_PORT_CHANNEL, listener: (event: { ports: readonly RendererPort[] }, grant: unknown) => void): unknown
}

/**
 * The handle over a running terminal's port. The port starts delivering when the first listener is added, so
 * what main sent before that waits in the port instead of being missed.
 */
function terminalHandle(port: RendererPort): TerminalHandle {
  const output = new Set<(data: string) => void>()
  const exits = new Set<(exit: TerminalExit) => void>()
  let started = false
  const dispatch = (event: { data: unknown }): void => {
    // Main holds the only other end of this port, and posts only TerminalPortEvents on it.
    const message = event.data as TerminalPortEvent
    if (message.type === 'output') {
      for (const listener of output) {
        listener(message.data)
      }
    } else {
      const { exitCode, signal, message: why, resumed } = message
      for (const listener of exits) {
        listener({ exitCode, signal, message: why, resumed })
      }
    }
  }
  const listen = <T>(listeners: Set<T>, listener: T): (() => void) => {
    listeners.add(listener)
    if (!started) {
      started = true
      port.addEventListener('message', dispatch)
      port.start()
    }
    return () => {
      listeners.delete(listener)
    }
  }
  return {
    write: (data) => {
      port.postMessage({ type: 'input', data })
    },
    resize: (cols, rows) => {
      port.postMessage({ type: 'resize', cols, rows })
    },
    onOutput: (listener) => listen(output, listener),
    onExit: (listener) => listen(exits, listener),
    close: () => {
      port.close()
    }
  }
}

/**
 * The ports main posted to this page, matched to the attaches that asked for them by the id each answer names.
 * A port can arrive before or after its answer. One that no attach of this page will claim (posted, say, after a
 * long attach to the page this frame showed before a reload) is closed, so main stops sending to it.
 */
class PortClaims {
  /** Ports that arrived before their attach's answer, and attaches whose answer arrived before their port. */
  private readonly arrived = new Map<string, RendererPort>()
  private readonly waiting = new Map<string, (port: RendererPort) => void>()
  /** Attaches whose answer has not arrived yet: only they can still claim a port waiting in `arrived`. */
  private answering = 0

  /** A port main posted, with the grant it came with. */
  receive(port: RendererPort | undefined, grant: unknown): void {
    const id = typeof grant === 'object' && grant !== null && 'port' in grant ? grant.port : null
    const claim = typeof id === 'string' ? this.waiting.get(id) : undefined
    if (port === undefined) {
      return
    }
    if (typeof id === 'string' && claim !== undefined) {
      this.waiting.delete(id)
      claim(port)
    } else if (typeof id === 'string' && !this.arrived.has(id)) {
      this.arrived.set(id, port)
      this.dropUnclaimed()
    } else {
      port.close()
    }
  }

  /** An attach is waiting for its answer. */
  begin(): void {
    this.answering += 1
  }

  /**
   * The attach has its answer, naming `id` or no port. The claim is registered at once, in the same step as the
   * count goes down: a port arriving in between would otherwise be dropped as nobody's.
   */
  end(id: string | undefined): Promise<RendererPort> | null {
    this.answering -= 1
    const claimed = id === undefined ? null : this.claim(id)
    this.dropUnclaimed()
    return claimed
  }

  private claim(id: string): Promise<RendererPort> {
    const port = this.arrived.get(id)
    if (port !== undefined) {
      this.arrived.delete(id)
      return Promise.resolve(port)
    }
    // Promise.withResolvers is outside the TypeScript lib this repo targets.
    return new Promise((resolve) => this.waiting.set(id, resolve))
  }

  private dropUnclaimed(): void {
    if (this.answering === 0) {
      for (const port of this.arrived.values()) {
        port.close()
      }
      this.arrived.clear()
    }
  }
}

export function createTerminalsApi(ipc: TerminalIpc): TerminalsApi {
  const claims = new PortClaims()
  ipc.on(TERMINAL_PORT_CHANNEL, (event, grant) => {
    claims.receive(event.ports[0], grant)
  })
  /** One request that answers like an attach: the answer, with the terminal built from the port it names. */
  const request = async (invoke: () => Promise<CommandResult<TerminalAttachWire>>): Promise<CommandResult<TerminalAttachment>> => {
    claims.begin()
    let answer: CommandResult<TerminalAttachWire>
    try {
      answer = await invoke()
    } catch (error) {
      claims.end(undefined)
      throw error
    }
    // Main names a port in a running answer only.
    const claimed = claims.end(answer.ok ? answer.data.port : undefined)
    if (!answer.ok) {
      return answer
    }
    const { port: _named, ...view } = answer.data
    return { ok: true, data: { ...view, terminal: claimed === null ? null : terminalHandle(await claimed) } }
  }
  return {
    // The key goes only when asked for: main's request schema is strict.
    attach: (folder, chatId, options) =>
      request(() => ipc.invoke(TERMINAL_ATTACH_CHANNEL, options?.newSession === true ? { folder, chatId, newSession: true } : { folder, chatId })),
    signIn: (agentId) => request(() => ipc.invoke(TERMINAL_SIGN_IN_CHANNEL, agentId))
  }
}
