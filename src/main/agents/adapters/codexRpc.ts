/**
 * A small JSON-RPC client for `codex app-server`, over a line transport.
 *
 * The app-server speaks JSON-RPC 2.0 without the `"jsonrpc"` field, one JSON message per line on
 * stdio (https://github.com/openai/codex, `codex-rs/app-server-protocol/src/rpc.rs`). This client
 * sends requests and notifications, matches responses to requests by id, hands the server's
 * notifications and requests to the caller, and answers each server request with what the handler
 * returns (or an error). It knows nothing about Codex's methods: the transport (a real process or a
 * recorded exchange) and the handlers are injected.
 */

/** Lines in and out of one app-server connection. The process side lives in `codexProcess.ts`. */
export interface RpcTransport {
  /** Writes one line (the transport adds the newline). */
  write(line: string): void
  /** Receives each line the server prints. */
  onLine(listener: (line: string) => void): void
  /** Called once when the connection ends, with why (the process exited, could not start, was stopped). */
  onClose(listener: (reason: string) => void): void
  /** Ends the process and every process it started; resolves once it is gone. */
  kill(): Promise<void>
}

/** A JSON-RPC error response, or an error to send back as one. */
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message)
    this.name = 'RpcError'
  }
}

export interface RpcHandlers {
  onNotification(method: string, params: unknown): void
  /** Answers a request from the server; a rejection becomes an error response. */
  onRequest(method: string, params: unknown): Promise<unknown>
  /** The connection ended without this side closing it. */
  onClose?(reason: string): void
}

export interface RpcClient {
  /** Sends a request and resolves with its result; rejects with an `RpcError` when the server refuses. */
  request(method: string, params?: unknown): Promise<unknown>
  /** Sends a notification (no answer expected). */
  notify(method: string, params?: unknown): void
  /** True once the connection ended or was closed. */
  readonly closed: boolean
  /** Ends this side: pending requests are rejected with `reason` and nothing more is written. */
  close(reason: string): void
}

type Id = number | string

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

const INTERNAL_ERROR = -32603

type Message = Record<string, unknown>

function parseMessage(line: string): Message | null {
  try {
    const value: unknown = JSON.parse(line)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Message) : null
  } catch {
    return null
  }
}

function isId(value: unknown): value is Id {
  return typeof value === 'number' || typeof value === 'string'
}

function errorBody(error: unknown): { code: number; message: string; data?: unknown } {
  if (error instanceof RpcError) {
    return { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
  }
  return { code: INTERNAL_ERROR, message: error instanceof Error ? error.message : String(error) }
}

function toRpcError(body: unknown): RpcError {
  const { code, message, data } = (typeof body === 'object' && body !== null ? body : {}) as Message
  return new RpcError(typeof code === 'number' ? code : INTERNAL_ERROR, typeof message === 'string' ? message : 'The request failed.', data)
}

class Client implements RpcClient {
  private readonly pending = new Map<Id, Pending>()
  private nextId = 0
  private closedReason: string | null = null

  constructor(
    private readonly transport: RpcTransport,
    private readonly handlers: RpcHandlers
  ) {
    transport.onLine((line) => {
      this.receive(line)
    })
    transport.onClose((reason) => {
      const alreadyClosed = this.closedReason !== null
      this.close(reason)
      if (!alreadyClosed) {
        handlers.onClose?.(reason)
      }
    })
  }

  get closed(): boolean {
    return this.closedReason !== null
  }

  request(method: string, params?: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      if (this.closedReason !== null) {
        reject(new Error(this.closedReason))
        return
      }
      this.nextId += 1
      const id = this.nextId
      this.pending.set(id, { resolve, reject })
      try {
        this.send({ id, method, params })
      } catch (error) {
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: unknown): void {
    this.send({ method, params })
  }

  close(reason: string): void {
    this.closedReason = this.closedReason ?? reason
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const request of waiting) {
      request.reject(new Error(reason))
    }
  }

  private send(message: Message): void {
    if (this.closedReason === null) {
      this.transport.write(JSON.stringify(message))
    }
  }

  private receive(line: string): void {
    const message = parseMessage(line)
    if (message === null || this.closedReason !== null) {
      return
    }
    if (typeof message.method !== 'string') {
      this.respond(message)
    } else if (isId(message.id)) {
      this.answer(message.id, message.method, message.params)
    } else {
      this.handlers.onNotification(message.method, message.params)
    }
  }

  /** Answers a request from the server with what the handler returns, or an error response. */
  private answer(id: Id, method: string, params: unknown): void {
    let work: Promise<unknown>
    try {
      work = this.handlers.onRequest(method, params)
    } catch (error) {
      work = Promise.reject(error)
    }
    work.then(
      (result) => {
        this.reply({ id, result })
      },
      (error: unknown) => {
        this.reply({ id, error: errorBody(error) })
      }
    )
  }

  private reply(message: Message): void {
    try {
      this.send(message)
    } catch {
      // The process went away between the request and the answer; its close reports that.
    }
  }

  /** Settles the pending request a response belongs to. */
  private respond(message: Message): void {
    const { id } = message
    const request = isId(id) ? this.pending.get(id) : undefined
    if (!isId(id) || request === undefined) {
      return
    }
    this.pending.delete(id)
    if ('error' in message) {
      request.reject(toRpcError(message.error))
    } else {
      request.resolve(message.result)
    }
  }
}

export function createRpcClient(transport: RpcTransport, handlers: RpcHandlers): RpcClient {
  return new Client(transport, handlers)
}
