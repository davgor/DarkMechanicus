import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createControlFrame } from '../../core/desktop/controlFrame'
import type { ControlProtocol, ControlReplyShape, ControlTransportCode } from '../../core/desktop/controlProtocol'

/** Created only by a live grant registry, never reconstructed from historical chat records. */
export interface ControlBinding {
  /** The bound chat's folder; null for a project-less chat. */
  readonly folder: string | null
  readonly chatId: string
  readonly signal: AbortSignal
  /** Synchronous current DB grant/capability, generation check. */
  assertCurrent(): void
}
export interface ControlOperationContext<Binding extends ControlBinding> {
  readonly binding: Binding
  readonly signal: AbortSignal
  /** Absolute monotonic milliseconds, including queue time. */
  readonly deadline: number
  remainingMs(): number
  assertActive(): void
  verifyActive?(): Promise<void>
  /** Chat metadata mutation must occur synchronously inside this final guard, never after an await. */
  publish<T>(publication: () => T extends PromiseLike<unknown> ? never : T): T | Promise<T>
}
export interface ControlClock {
  now(): number
  after(callback: () => void, ms: number): () => void
}
const nodeClock: ControlClock = {
  now: () => performance.now(),
  after: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer) }
}

type AnyOperation = { op: string; args: unknown }
type AnyRequest = AnyOperation & { requestId: string; token: string }
type AnyReply = ControlReplyShape<string>

/** Server-side per-operation authority and lane rules a protocol adds to its wire contract. */
export interface ControlServerProtocol<
  Op extends AnyOperation, Request extends Op & { requestId: string; token: string }, Reply extends ControlReplyShape<C | ControlTransportCode>, C extends string,
  Binding extends ControlBinding
>
  extends ControlProtocol<Op, Request, Reply, C> {
  /** Operations sharing a chat and lane run one at a time, in order. */
  laneOf?(operation: Op): string
  /** Synchronous operation-specific authority, rechecked with the binding on every activity check. */
  assertOperation?(binding: Binding, operation: Op): void
  /** Asynchronous operation-specific authority, checked before dispatch, after it and while it runs. */
  verifyOperation?(binding: Binding, operation: Op): Promise<void>
}
export type ControlDispatcher<Op, Binding extends ControlBinding> = (operation: Op, context: ControlOperationContext<Binding>) => Promise<unknown> | unknown
interface ControlServerOptions<
  Op extends AnyOperation, Request extends Op & { requestId: string; token: string }, Reply extends ControlReplyShape<C | ControlTransportCode>, C extends string,
  Binding extends ControlBinding
> {
  readonly protocol: ControlServerProtocol<Op, Request, Reply, C, Binding>
  authorize(token: string): Binding
  dispatch?: ControlDispatcher<Op, Binding>
  clock?: ControlClock
  /** Unix socket directory prefix (`mkdtemp`) and Windows pipe name prefix (`\\.\pipe\<prefix><uuid>`). */
  readonly addressPrefix: { readonly unix: string; readonly win32: string }
}
export interface ControlServerHandle {
  readonly address: string
  /** Idempotent: cancels work immediately, closes clients/listeners and removes the Unix directory. */
  close(): Promise<void>
}
// Internal classes are protocol-agnostic; the typed boundary is createControlServer's signature.
type Options = ControlServerOptions<AnyOperation, AnyRequest, AnyReply, string, ControlBinding>
interface Lane { active: ControlOperation | null; queued: ControlOperation[] }

/** Drain unread Unix input after admission closes, avoiding a reset that discards the reply. */
function endReply(socket: Socket, wire: string, frameMs: number): void {
  const kill = setTimeout(() => socket.destroy(), frameMs)
  socket.once('close', () => clearTimeout(kill))
  socket.resume()
  socket.end(wire)
}

class ControlServer implements ControlServerHandle {
  readonly clock: ControlClock
  readonly protocol: Options['protocol']
  readonly connections = new Set<ControlConnection>()
  readonly lanes = new Map<string, Lane>()
  readonly work = new Set<ControlOperation>()
  readonly server: Server
  closing = false
  private closed: Promise<void> | null = null

  constructor(readonly address: string, private readonly directory: string | null, readonly options: Options) {
    this.clock = options.clock ?? nodeClock
    this.protocol = options.protocol
    this.server = createServer({ allowHalfOpen: true }, (socket) => this.accept(socket))
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(this.address, () => { this.server.removeListener('error', reject); resolve() })
    })
    this.server.on('error', () => { void this.close() })
  }
  private accept(socket: Socket): void {
    if (this.closing || this.connections.size >= this.protocol.limits.connections) {
      socket.on('error', () => {})
      endReply(socket, `${JSON.stringify(this.protocol.failure('', 'busy'))}\n`, this.protocol.limits.frameMs)
      return
    }
    const connection = new ControlConnection(this, socket)
    this.connections.add(connection)
  }
  enqueue(operation: ControlOperation): void {
    const lane = this.lanes.get(operation.key) ?? { active: null, queued: [] }
    if (lane.active !== null && lane.queued.length >= this.protocol.limits.queuedPerChat) {
      operation.connection.finish(this.protocol.failure(operation.connection.requestId, 'busy'))
      return
    }
    this.lanes.set(operation.key, lane)
    this.work.add(operation)
    operation.watch()
    if (lane.active === null) { lane.active = operation; void operation.start() } else { lane.queued.push(operation) }
  }
  removeQueued(operation: ControlOperation): void {
    const lane = this.lanes.get(operation.key)
    const index = lane?.queued.indexOf(operation) ?? -1
    if (lane !== undefined && index !== -1) { lane.queued.splice(index, 1); this.work.delete(operation) }
  }
  release(operation: ControlOperation): void {
    this.work.delete(operation)
    const lane = this.lanes.get(operation.key)
    if (lane === undefined || lane.active !== operation) { return }
    lane.active = null
    if (this.closing) { return }
    const next = lane.queued.shift()
    if (next === undefined) { this.lanes.delete(operation.key) } else { lane.active = next; void next.start() }
  }
  close(): Promise<void> {
    if (this.closed !== null) { return this.closed }
    this.closing = true
    for (const operation of this.work) { operation.cancel('cancelled') }
    for (const connection of this.connections) { connection.shutdown() }
    this.closed = new Promise<void>((resolve) => this.server.close(() => {
      this.lanes.clear()
      if (this.directory !== null) { rmSync(this.directory, { recursive: true, force: true }) }
      resolve()
    }))
    return this.closed
  }
}

class ControlConnection {
  requestId = ''
  finished = false
  current: ControlOperation | null = null
  private readonly frame: ReturnType<typeof createControlFrame>
  private readonly cancelFrame: () => void
  constructor(readonly owner: ControlServer, readonly socket: Socket) {
    const { protocol } = owner
    this.frame = createControlFrame(protocol.limits.requestBytes, (code) => protocol.error(code))
    this.cancelFrame = owner.clock.after(() => this.finish(protocol.failure(this.requestId, 'timeout')), protocol.limits.frameMs)
    socket.on('data', this.onData)
    socket.on('end', this.onEnd)
    socket.on('error', () => { this.current?.cancel('cancelled'); this.finish() })
    socket.on('close', () => { owner.connections.delete(this); this.current?.cancel('cancelled'); this.finish() })
  }
  private readonly onData = (chunk: Buffer): void => {
    try {
      const text = this.frame.push(chunk)
      if (text !== null) { this.cancelFrame(); this.admit(text) }
    } catch {
      this.current?.cancel('invalid_request')
      this.finish(this.owner.protocol.failure(this.requestId, 'invalid_request'))
    }
  }
  // A request is written, not half-closed: EOF means the caller has disconnected/cancelled.
  private readonly onEnd = (): void => {
    if (this.current !== null) { this.current.cancel('cancelled') } else { this.finish(this.owner.protocol.failure(this.requestId, 'invalid_request')) }
  }
  private admit(text: string): void {
    const { protocol } = this.owner
    let raw: unknown
    try { raw = JSON.parse(text) } catch { this.finish(protocol.failure('', 'invalid_request')); return }
    const parsed = protocol.requestSchema.safeParse(raw)
    if (!parsed.success) { this.finish(protocol.failure('', 'invalid_request')); return }
    const request = parsed.data
    this.requestId = request.requestId
    const limit = protocol.requestBytesOf?.(request.op)
    if (limit !== undefined && Buffer.byteLength(text) + 1 > limit) {
      this.finish(protocol.failure(this.requestId, 'invalid_request')); return
    }
    const deadline = this.owner.clock.now() + protocol.limits.serverMs
    let binding: ControlBinding
    try { binding = this.owner.options.authorize(request.token); binding.assertCurrent() } catch { this.finish(protocol.failure(this.requestId, 'unauthorized')); return }
    const operation = protocol.operationSchema.parse({ op: request.op, args: request.args })
    this.current = new ControlOperation(this, binding, operation, deadline)
    this.owner.enqueue(this.current)
  }
  finish(reply?: unknown): void {
    if (this.finished) { return }
    this.finished = true
    this.frame.clear()
    this.cancelFrame()
    this.current?.stopWatching()
    this.socket.removeListener('data', this.onData)
    this.socket.removeListener('end', this.onEnd)
    if (reply === undefined || this.socket.destroyed) { this.socket.destroy(); return }
    const { protocol } = this.owner
    let wire: string
    try {
      const parsed = protocol.replySchema.safeParse(reply)
      wire = JSON.stringify(parsed.success ? parsed.data : protocol.failure(this.requestId, 'internal_error')) + '\n'
      if (Buffer.byteLength(wire) > protocol.limits.responseBytes) { wire = JSON.stringify(protocol.failure(this.requestId, 'response_too_large')) + '\n' }
    } catch { wire = JSON.stringify(protocol.failure(this.requestId, 'internal_error')) + '\n' }
    endReply(this.socket, wire, protocol.limits.frameMs)
  }
  shutdown(): void {
    this.current?.cancel('cancelled')
    if (!this.socket.writableEnded) { this.socket.destroy() }
  }
}

class ControlOperation {
  readonly key: string
  readonly context: ControlOperationContext<ControlBinding>
  private readonly controller = new AbortController()
  private cancelDeadline = (): void => {}
  private cancelWatch = (): void => {}
  private unbind = (): void => {}
  constructor(readonly connection: ControlConnection, readonly binding: ControlBinding, private readonly operation: AnyOperation, readonly deadline: number) {
    this.key = JSON.stringify([binding.folder, binding.chatId, connection.owner.protocol.laneOf?.(operation) ?? 'write'])
    this.context = {
      binding, signal: this.controller.signal, deadline,
      remainingMs: () => Math.max(0, deadline - connection.owner.clock.now()),
      assertActive: () => this.assertActive(),
      verifyActive: () => this.verifyActive(),
      publish: async (publication) => { await this.verifyActive(); this.assertActive(); return publication() }
    }
  }
  private assertActive(): void {
    const { owner } = this.connection
    if (owner.clock.now() >= this.deadline) { throw owner.protocol.error('timeout') }
    if (owner.closing || this.connection.finished || this.controller.signal.aborted || this.binding.signal.aborted || this.connection.socket.destroyed) {
      throw owner.protocol.error('cancelled')
    }
    this.binding.assertCurrent()
    owner.protocol.assertOperation?.(this.binding, this.operation)
  }
  private async verifyActive(): Promise<void> {
    this.assertActive()
    await this.connection.owner.protocol.verifyOperation?.(this.binding, this.operation)
    this.assertActive()
  }
  watch(): void {
    const { clock, protocol } = this.connection.owner
    this.cancelDeadline = clock.after(() => this.cancel('timeout'), Math.max(0, this.deadline - clock.now()))
    const onAbort = (): void => this.cancel('unauthorized')
    this.binding.signal.addEventListener('abort', onAbort, { once: true })
    this.unbind = () => this.binding.signal.removeEventListener('abort', onAbort)
    const poll = (): void => {
      void this.verifyActive().then(
        () => { if (!this.controller.signal.aborted) this.cancelWatch = clock.after(poll, 50) },
        (error: unknown) => { if (!this.controller.signal.aborted) this.cancel(protocol.errorCodeOf(error)) }
      )
    }
    this.cancelWatch = clock.after(poll, 50)
  }
  stopWatching(): void {
    this.cancelDeadline()
    this.cancelWatch()
    this.unbind()
  }
  cancel(code: string): void {
    this.controller.abort()
    this.connection.owner.removeQueued(this)
    this.connection.finish(this.connection.owner.protocol.failure(this.connection.requestId, code))
    // An ignored cancellation retains the active slot until the handler settles: no overlapping mutations.
  }
  async start(): Promise<void> {
    const { protocol } = this.connection.owner
    try {
      await this.verifyActive()
      let data: unknown
      {
        const dispatch = this.connection.owner.options.dispatch
        if (dispatch === undefined) { throw protocol.error('operation_unavailable') }
        data = await dispatch(this.operation, this.context)
      }
      await this.verifyActive()
      this.connection.finish({ version: protocol.limits.version, requestId: this.connection.requestId, ok: true, data })
    } catch (error) { this.connection.finish(protocol.failure(this.connection.requestId, protocol.errorCodeOf(error))) } finally {
      this.controller.abort()
      this.connection.owner.release(this)
    }
  }
}

/**
 * Authenticated local IPC for one protocol. Windows Node pipe default ACLs are NOT user-exclusive: authority comes from
 * the token `authorize` checks, never from the address. On POSIX the socket sits in a 0700 directory with mode 0600.
 */
export async function createControlServer<
  Op extends AnyOperation, Request extends Op & { requestId: string; token: string }, Reply extends ControlReplyShape<C | ControlTransportCode>, C extends string,
  Binding extends ControlBinding
>(options: ControlServerOptions<Op, Request, Reply, C, Binding>): Promise<ControlServerHandle> {
  const { unix, win32 } = options.addressPrefix
  const directory = process.platform === 'win32' ? null : mkdtempSync(join(tmpdir(), unix))
  if (directory !== null) { chmodSync(directory, 0o700) }
  const address = directory === null ? `\\\\.\\pipe\\${win32}${randomUUID()}` : join(directory, 'p')
  const runtime = new ControlServer(address, directory, options as unknown as Options)
  try {
    await runtime.listen()
    if (directory !== null) { chmodSync(address, 0o600) }
    return runtime
  } catch (error) {
    await runtime.close()
    throw error
  }
}
