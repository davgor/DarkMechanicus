/**
 * The client side of the Agent Client Protocol (https://agentclientprotocol.com): JSON-RPC 2.0, one
 * message per line, over the standard streams of an agent process. This module only speaks
 * JSON-RPC; what the methods mean belongs to the adapter. The process is behind a transport
 * (spawned by `acpProcess.ts`, replayed from a recording in tests), so nothing here imports Node.
 */
import type { ProbeLaunch } from '../../desktop/agentProbe'

/** What the transport tells the connection. */
export interface TransportSink {
  /** One complete line the agent wrote, without its line ending. */
  line(text: string): void
  /** The process ended or could not start; `detail` says how, for the person to read. */
  closed(detail: string): void
}

/** What the connection can do to the process. */
export interface TransportHandle {
  write(line: string): void
  /** Ends the process and everything it started; resolves once they are gone. */
  kill(): Promise<void>
}

/** Starts the agent process in `cwd`; its output is reported to `sink`. */
export type TransportFactory = (launch: ProbeLaunch, cwd: string, sink: TransportSink) => TransportHandle

export type RpcId = number | string

/** The JSON-RPC error codes this client answers with. */
export const RPC_METHOD_NOT_FOUND = -32601
const RPC_INTERNAL_ERROR = -32603

/** An error answer from the agent, or the end of the process while a request waited. */
export class AcpError extends Error {
  constructor(
    message: string,
    readonly code: number | null = null,
    readonly data: unknown = undefined
  ) {
    super(message)
    this.name = 'AcpError'
  }
}

export interface AcpHandlers {
  /** A message with a method and no id. */
  notification(method: string, params: unknown): void
  /** A message with a method and an id; whoever handles it must answer through `respond` or `fail`. */
  request(id: RpcId, method: string, params: unknown): void
  /** The process ended on its own (not through `kill`). */
  closed(detail: string): void
}

export interface AcpConnection {
  /** Sends a request; settles with the result, or rejects when the agent answers with an error or the process ends. */
  request(method: string, params: unknown): Promise<unknown>
  notify(method: string, params: unknown): void
  respond(id: RpcId, result: unknown): void
  fail(id: RpcId, code: number, message: string): void
  isClosed(): boolean
  /** Ends the process tree; waiting requests are rejected at once and `closed` is not reported. Resolves once the tree is gone. */
  kill(): Promise<void>
}

interface Waiting {
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

type Message = Record<string, unknown>

function isMessage(value: unknown): value is Message {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is RpcId {
  return typeof value === 'number' || typeof value === 'string'
}

function errorOf(value: unknown): AcpError {
  const body = isMessage(value) ? value : {}
  const message = typeof body.message === 'string' ? body.message : 'The agent reported an error.'
  return new AcpError(message, typeof body.code === 'number' ? body.code : null, body.data)
}

class Connection implements AcpConnection {
  private handle: TransportHandle | null = null
  private closed = false
  private nextId = 1
  private readonly waiting = new Map<RpcId, Waiting>()

  constructor(
    factory: TransportFactory,
    launch: ProbeLaunch,
    cwd: string,
    private readonly handlers: AcpHandlers
  ) {
    this.handle = factory(launch, cwd, {
      line: (text) => {
        this.hear(text)
      },
      closed: (detail) => {
        this.end(detail)
      }
    })
  }

  isClosed(): boolean {
    return this.closed
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new AcpError('The Cursor agent stopped.'))
    }
    const id = this.nextId
    this.nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      // Registered before the write: an agent may answer before write() returns.
      this.waiting.set(id, { resolve, reject })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.waiting.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params: unknown): void {
    this.sendQuietly({ jsonrpc: '2.0', method, params })
  }

  respond(id: RpcId, result: unknown): void {
    this.sendQuietly({ jsonrpc: '2.0', id, result })
  }

  fail(id: RpcId, code: number, message: string): void {
    this.sendQuietly({ jsonrpc: '2.0', id, error: { code, message } })
  }

  async kill(): Promise<void> {
    if (this.closed) {
      return
    }
    this.closed = true
    const treeGone = this.handle?.kill()
    this.rejectAll(new AcpError('The Cursor agent was stopped.'))
    await treeGone
  }

  private send(message: Message): void {
    if (this.handle === null || this.closed) {
      throw new AcpError('The Cursor agent stopped.')
    }
    this.handle.write(JSON.stringify(message))
  }

  /** Answers and notifications are best effort: a process that is gone cannot be told anything. */
  private sendQuietly(message: Message): void {
    try {
      this.send(message)
    } catch {
      // Nothing left to tell.
    }
  }

  private end(detail: string): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.rejectAll(new AcpError(`The Cursor agent stopped: ${detail}`))
    this.handlers.closed(detail)
  }

  private rejectAll(error: Error): void {
    const waiting = [...this.waiting.values()]
    this.waiting.clear()
    for (const entry of waiting) {
      entry.reject(error)
    }
  }

  private hear(text: string): void {
    const message = parseLine(text)
    if (message === null) {
      return
    }
    if (typeof message.method === 'string') {
      this.dispatch(message.method, message)
    } else if (isId(message.id)) {
      this.settle(message.id, message)
    }
  }

  private settle(id: RpcId, message: Message): void {
    const entry = this.waiting.get(id)
    if (entry === undefined) {
      return
    }
    this.waiting.delete(id)
    if ('error' in message) {
      entry.reject(errorOf(message.error))
    } else {
      entry.resolve(message.result)
    }
  }

  private dispatch(method: string, message: Message): void {
    if (!isId(message.id)) {
      this.guarded(() => {
        this.handlers.notification(method, message.params)
      })
      return
    }
    const { id } = message
    try {
      this.handlers.request(id, method, message.params)
    } catch (error) {
      this.fail(id, RPC_INTERNAL_ERROR, error instanceof Error ? error.message : String(error))
    }
  }

  /** A handler that throws must not take the stream down with it. */
  private guarded(action: () => void): void {
    try {
      action()
    } catch {
      // The handler's own failure; the stream carries on.
    }
  }
}

function parseLine(text: string): Message | null {
  const trimmed = text.trim()
  if (trimmed === '') {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    return isMessage(parsed) ? parsed : null
  } catch {
    // Agents may print banners and logs on stdout; only JSON objects are messages.
    return null
  }
}

/** Starts the agent process and returns the connection to it. */
export function openAcpConnection(factory: TransportFactory, launch: ProbeLaunch, cwd: string, handlers: AcpHandlers): AcpConnection {
  return new Connection(factory, launch, cwd, handlers)
}
