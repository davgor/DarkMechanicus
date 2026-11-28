import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { serializedCredentialWithinBound } from '../../../resources/skitarii/extension/controlLimits'
import { createControlFrame } from './controlFrame'
import type { ControlProtocol, ControlReplyShape, ControlTransportCode } from './controlProtocol'

export interface ControlClientOptions {
  /** Chat PTYs receive the pipe address and DM_SESSION_TOKEN; no desktop/window identity comes from a caller. */
  env?: Readonly<Record<string, string | undefined>>
  connect?: (address: string) => Socket
  /** Injectable timer for total-deadline tests; production always uses the protocol's client bound. */
  after?: (callback: () => void, ms: number) => () => void
  requestId?: () => string
}
type AnyOperation = { op: string; args: unknown }
type AnyRequest = AnyOperation & { requestId: string; token: string }
/** The client logic is protocol-agnostic; the typed boundary is createControlClient's signature. */
type Setup = ControlClientOptions & { protocol: ControlProtocol<AnyOperation, AnyRequest, AnyReply, string>; envVar: string }
type AnyReply = ControlReplyShape<string>
interface Prepared { requestId: string; address: string; wire: string; op: string }

function inheritedAuthority(setup: Setup, requestId: string): { address: string; token: string } | { reply: AnyReply } {
  const env = setup.env ?? process.env
  const address = env[setup.envVar]
  if (address === undefined || address === '') return { reply: setup.protocol.failure(requestId, 'desktop_unavailable') }
  const token = env['DM_SESSION_TOKEN']
  if (token === undefined || token.trim() === '' || token.length > 1024) return { reply: setup.protocol.failure(requestId, 'unauthorized') }
  if (!serializedCredentialWithinBound(token)) return { reply: setup.protocol.failure(requestId, 'invalid_request') }
  return { address, token }
}

function prepare(setup: Setup, operation: AnyOperation): Prepared | { reply: AnyReply } {
  const { protocol } = setup
  const requestId = (setup.requestId ?? randomUUID)()
  const parsedOperation = protocol.operationSchema.safeParse(operation)
  if (!parsedOperation.success) return { reply: protocol.failure(requestId, 'invalid_request') }
  const authority = inheritedAuthority(setup, requestId)
  if ('reply' in authority) return authority
  const parsed = protocol.requestSchema.safeParse({ version: protocol.limits.version, requestId, token: authority.token, ...parsedOperation.data })
  if (!parsed.success) return { reply: protocol.failure(requestId, 'unauthorized') }
  const wire = JSON.stringify(parsed.data) + '\n'
  const limit = protocol.requestBytesOf?.(operation.op) ?? protocol.limits.requestBytes
  if (Buffer.byteLength(wire) > limit) return { reply: protocol.failure(requestId, 'invalid_request') }
  return { requestId, address: authority.address, wire, op: operation.op }
}

function transport(setup: Setup, prepared: Prepared, signal?: AbortSignal): Promise<AnyReply> {
  const { protocol } = setup
  const { failure } = protocol
  const { requestId, address, wire } = prepared
  return new Promise<AnyReply>((resolve) => {
    let socket: Socket | null = null
    let settled = false
    let reply: AnyReply | null = null
    const frame = createControlFrame(protocol.responseBytesOf?.(prepared.op) ?? protocol.limits.responseBytes, (code) => protocol.error(code))
    const after = setup.after ?? ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    })
    let cancelTimer = (): void => {}
    const finish = (result: AnyReply): void => {
      if (settled) { return }
      settled = true
      cancelTimer()
      frame.clear()
      signal?.removeEventListener('abort', onAbort)
      socket?.removeAllListeners('data')
      socket?.destroy()
      resolve(result)
    }
    const onAbort = (): void => finish(failure(requestId, 'cancelled'))
    cancelTimer = after(() => finish(failure(requestId, 'timeout')), protocol.limits.clientMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      socket = (setup.connect ?? ((path) => createConnection(path)))(address)
      // Keep the write side open until the response; EOF is cancellation, not a request terminator.
      socket.on('connect', () => socket?.write(wire))
      socket.on('data', (chunk: Buffer) => {
        try {
          const text = frame.push(chunk)
          if (text !== null) {
            const parsed = protocol.replySchema.safeParse(JSON.parse(text) as unknown)
            if (!parsed.success || parsed.data.requestId !== requestId) { throw protocol.error('invalid_request') }
            reply = parsed.data.ok ? parsed.data : failure(requestId, parsed.data.error.code, parsed.data.error.details)
          }
        } catch { finish(failure(requestId, 'invalid_request')) }
      })
      socket.on('end', () => finish(reply ?? failure(requestId, 'invalid_request')))
      socket.on('error', () => finish(failure(requestId, 'desktop_unavailable')))
      socket.on('close', () => finish(reply ?? failure(requestId, 'desktop_unavailable')))
    } catch { finish(failure(requestId, 'desktop_unavailable')) }
  })
}

/**
 * One connection per request, no retry. No Electron dependency. The pipe address comes from `envVar` and the
 * grant token from DM_SESSION_TOKEN; failures carry only the protocol's fixed messages.
 */
export function createControlClient<
  Op extends AnyOperation, Request extends Op & { requestId: string; token: string },
  Reply extends ControlReplyShape<Code | ControlTransportCode>, Code extends string
>(options: ControlClientOptions & { protocol: ControlProtocol<Op, Request, Reply, Code>; envVar: string }): {
  request(operation: Op, options?: { signal?: AbortSignal }): Promise<Reply>
} {
  const setup = options as unknown as Setup
  return {
    async request(operation, requestOptions = {}) {
      const prepared = prepare(setup, operation)
      if ('reply' in prepared) { return prepared.reply as Reply }
      if (requestOptions.signal?.aborted === true) { return options.protocol.failure(prepared.requestId, 'cancelled') }
      return await transport(setup, prepared, requestOptions.signal) as Reply
    }
  }
}
