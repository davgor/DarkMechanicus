import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createControlFrame } from '../../core/desktop/controlFrame'
import {
  NAMING_CONTROL, NamingControlError, namingErrorCodeSchema, namingFailure, namingOperationSchema, namingReplySchema, namingRequestSchema,
  type NamingErrorCode, type NamingOperation
} from '../../shared/agents/chatNaming'

/** Created only by the live grant registry, never reconstructed from historical chat records. */
export interface NamingControlBinding {
  readonly grantId: string
  /** The bound chat's folder; null for a project-less chat. */
  readonly folder: string | null
  readonly chatId: string
  readonly generation: string
  readonly runId?: string
  readonly cardId?: string
  readonly signal: AbortSignal
  /** Synchronous current DB grant/capability, generation check. */
  assertCurrent(): void
  /** Narrow repair authority, rechecked independently of naming (not granted to workers/reviewers). */
  assertRecovery?(): void
}
export interface NamingOperationContext {
  readonly binding: NamingControlBinding
  readonly signal: AbortSignal
  /** Absolute monotonic milliseconds, including queue time. */
  readonly deadline: number
  remainingMs(): number
  assertActive(): void
  /** Chat metadata mutation must occur synchronously inside this final guard, never after an await. */
  publish<T>(publication: () => T extends PromiseLike<unknown> ? never : T): T
}
export type NamingDispatcher = (operation: NamingOperation, context: NamingOperationContext) => Promise<unknown> | unknown
interface ControlClock {
  now(): number
  after(callback: () => void, ms: number): () => void
}
const nodeClock: ControlClock = {
  now: () => performance.now(),
  after: (callback, ms) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer) }
}
interface ControlPipeOptions {
  authorize(token: string): NamingControlBinding
  dispatch?: NamingDispatcher
  clock?: ControlClock
}
export interface ControlPipe {
  readonly address: string
  /** Idempotent: cancels work immediately, closes clients/listeners and removes the Unix directory. */
  close(): Promise<void>
}
interface Lane { active: ControlOperation | null; queued: ControlOperation[] }

function errorCode(error: unknown): NamingErrorCode {
  if (error instanceof NamingControlError) { return error.code }
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const parsed = namingErrorCodeSchema.safeParse(error.code)
    if (parsed.success) { return parsed.data }
  }
  return 'internal_error'
}

/** Drain unread Unix input after admission closes, avoiding a reset that discards the reply. */
function endReply(socket: Socket, wire: string): void {
  const kill = setTimeout(() => socket.destroy(), NAMING_CONTROL.frameMs)
  socket.once('close', () => clearTimeout(kill))
  socket.resume()
  socket.end(wire)
}

class ControlServer implements ControlPipe {
  readonly clock: ControlClock
  readonly connections = new Set<ControlConnection>()
  readonly lanes = new Map<string, Lane>()
  readonly work = new Set<ControlOperation>()
  readonly server: Server
  closing = false
  private closed: Promise<void> | null = null

  constructor(readonly address: string, private readonly directory: string | null, readonly options: ControlPipeOptions) {
    this.clock = options.clock ?? nodeClock
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
    if (this.closing || this.connections.size >= NAMING_CONTROL.connections) {
      socket.on('error', () => {})
      endReply(socket, `${JSON.stringify(namingFailure('', 'busy'))}\n`)
      return
    }
    const connection = new ControlConnection(this, socket)
    this.connections.add(connection)
  }
  enqueue(operation: ControlOperation): void {
    const lane = this.lanes.get(operation.key) ?? { active: null, queued: [] }
    if (lane.active !== null && lane.queued.length >= NAMING_CONTROL.queuedPerChat) {
      operation.connection.finish(namingFailure(operation.connection.requestId, 'busy'))
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
  private readonly frame = createControlFrame(NAMING_CONTROL.requestBytes)
  private readonly cancelFrame: () => void
  constructor(readonly owner: ControlServer, readonly socket: Socket) {
    this.cancelFrame = owner.clock.after(() => this.finish(namingFailure(this.requestId, 'timeout')), NAMING_CONTROL.frameMs)
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
      this.finish(namingFailure(this.requestId, 'invalid_request'))
    }
  }
  // A request is written, not half-closed: EOF means the caller has disconnected/cancelled.
  private readonly onEnd = (): void => {
    if (this.current !== null) { this.current.cancel('cancelled') } else { this.finish(namingFailure(this.requestId, 'invalid_request')) }
  }
  private admit(text: string): void {
    let raw: unknown
    try { raw = JSON.parse(text) } catch { this.finish(namingFailure('', 'invalid_request')); return }
    const parsed = namingRequestSchema.safeParse(raw)
    if (!parsed.success) { this.finish(namingFailure('', 'invalid_request')); return }
    const request = parsed.data
    this.requestId = request.requestId
    if (request.op === 'name_chat' && Buffer.byteLength(text) + 1 > NAMING_CONTROL.namingRequestBytes) {
      this.finish(namingFailure(this.requestId, 'invalid_request')); return
    }
    const deadline = this.owner.clock.now() + NAMING_CONTROL.serverMs
    let binding: NamingControlBinding
    try { binding = this.owner.options.authorize(request.token); binding.assertCurrent() } catch { this.finish(namingFailure(this.requestId, 'unauthorized')); return }
    const operation = namingOperationSchema.parse({ op: request.op, args: request.args })
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
    let wire: string
    try {
      const parsed = namingReplySchema.safeParse(reply)
      wire = JSON.stringify(parsed.success ? parsed.data : namingFailure(this.requestId, 'internal_error')) + '\n'
      if (Buffer.byteLength(wire) > NAMING_CONTROL.responseBytes) { wire = JSON.stringify(namingFailure(this.requestId, 'response_too_large')) + '\n' }
    } catch { wire = JSON.stringify(namingFailure(this.requestId, 'internal_error')) + '\n' }
    endReply(this.socket, wire)
  }
  shutdown(): void {
    this.current?.cancel('cancelled')
    if (!this.socket.writableEnded) { this.socket.destroy() }
  }
}

class ControlOperation {
  readonly key: string
  readonly context: NamingOperationContext
  private readonly controller = new AbortController()
  private cancelDeadline = (): void => {}
  private cancelWatch = (): void => {}
  private unbind = (): void => {}
  constructor(readonly connection: ControlConnection, readonly binding: NamingControlBinding, private readonly operation: NamingOperation, readonly deadline: number) {
    this.key = JSON.stringify([binding.folder, binding.chatId, operation.op === 'recovery_context' ? 'recovery-read' : 'write'])
    this.context = {
      binding, signal: this.controller.signal, deadline,
      remainingMs: () => Math.max(0, deadline - connection.owner.clock.now()),
      assertActive: () => this.assertActive(),
      publish: (publication) => { this.assertActive(); return publication() }
    }
  }
  private assertActive(): void {
    if (this.connection.owner.clock.now() >= this.deadline) { throw new NamingControlError('timeout') }
    if (this.connection.owner.closing || this.connection.finished || this.controller.signal.aborted || this.binding.signal.aborted || this.connection.socket.destroyed) {
      throw new NamingControlError('cancelled')
    }
    this.binding.assertCurrent()
    if (this.operation.op === 'recover_tooling' || this.operation.op === 'recovery_context') {
      if (this.binding.assertRecovery === undefined) throw new NamingControlError('unauthorized')
      this.binding.assertRecovery()
    }
  }
  watch(): void {
    const clock = this.connection.owner.clock
    this.cancelDeadline = clock.after(() => this.cancel('timeout'), Math.max(0, this.deadline - clock.now()))
    const onAbort = (): void => this.cancel('unauthorized')
    this.binding.signal.addEventListener('abort', onAbort, { once: true })
    this.unbind = () => this.binding.signal.removeEventListener('abort', onAbort)
    const poll = (): void => {
      try { this.assertActive() } catch (error) { this.cancel(errorCode(error)); return }
      this.cancelWatch = clock.after(poll, 50)
    }
    this.cancelWatch = clock.after(poll, 50)
  }
  stopWatching(): void {
    this.cancelDeadline()
    this.cancelWatch()
    this.unbind()
  }
  cancel(code: NamingErrorCode): void {
    this.controller.abort()
    this.connection.owner.removeQueued(this)
    this.connection.finish(namingFailure(this.connection.requestId, code))
    // An ignored cancellation retains the active slot until the handler settles: no overlapping mutations.
  }
  async start(): Promise<void> {
    try {
      this.assertActive()
      let data: unknown
      {
        const dispatch = this.connection.owner.options.dispatch
        if (dispatch === undefined) { throw new NamingControlError('operation_unavailable') }
        data = await dispatch(this.operation, this.context)
      }
      this.assertActive()
      this.connection.finish({ version: 1, requestId: this.connection.requestId, ok: true, data })
    } catch (error) { this.connection.finish(namingFailure(this.connection.requestId, errorCode(error))) } finally {
      this.controller.abort()
      this.connection.owner.release(this)
    }
  }
}

/** Authenticated local IPC. Windows Node pipe default ACLs are NOT user-exclusive. */
export async function createControlPipe(options: ControlPipeOptions): Promise<ControlPipe> {
  const directory = process.platform === 'win32' ? null : mkdtempSync(join(tmpdir(), 'dm-n-'))
  if (directory !== null) { chmodSync(directory, 0o700) }
  const address = directory === null ? `\\\\.\\pipe\\dm-desktop-${randomUUID()}` : join(directory, 'p')
  const runtime = new ControlServer(address, directory, options)
  try {
    await runtime.listen()
    if (directory !== null) { chmodSync(address, 0o600) }
    return runtime
  } catch (error) {
    await runtime.close()
    throw error
  }
}
