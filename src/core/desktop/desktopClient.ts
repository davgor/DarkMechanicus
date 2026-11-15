import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { NAMING_CONTROL, NamingControlError, namingFailure, namingOperationSchema, namingReplySchema, namingRequestSchema, type NamingOperation, type NamingReply } from '../../shared/agents/chatNaming'
import { createControlFrame } from './controlFrame'

interface DesktopClientOptions {
  /** Chat PTYs receive these two values; no desktop/window identity comes from a caller. */
  env?: Readonly<Record<string, string | undefined>>
  connect?: (address: string) => Socket
  /** Injectable timer for total-deadline tests; production always uses the shared 25s bound. */
  after?: (callback: () => void, ms: number) => () => void
  requestId?: () => string
}
export interface DesktopClient {
  request(operation: NamingOperation, options?: { signal?: AbortSignal }): Promise<NamingReply>
}
interface Prepared { requestId: string; address: string; wire: string }

function prepare(options: DesktopClientOptions, operation: NamingOperation): Prepared | { reply: NamingReply } {
  const requestId = (options.requestId ?? randomUUID)()
  const parsedOperation = namingOperationSchema.safeParse(operation)
  if (!parsedOperation.success) { return { reply: namingFailure(requestId, 'invalid_request') } }
  const env = options.env ?? process.env
  const address = env['DM_DESKTOP_PIPE']
  if (address === undefined || address === '') { return { reply: namingFailure(requestId, 'desktop_unavailable') } }
  const token = env['DM_SESSION_TOKEN']
  if (token === undefined || token.trim() === '') { return { reply: namingFailure(requestId, 'unauthorized') } }
  const parsed = namingRequestSchema.safeParse({ version: 1, requestId, token, ...parsedOperation.data })
  if (!parsed.success) { return { reply: namingFailure(requestId, 'unauthorized') } }
  const wire = JSON.stringify(parsed.data) + '\n'
  if (Buffer.byteLength(wire) > NAMING_CONTROL.requestBytes) { return { reply: namingFailure(requestId, 'invalid_request') } }
  return { requestId, address, wire }
}

function transport(options: DesktopClientOptions, prepared: Prepared, signal?: AbortSignal): Promise<NamingReply> {
  const { requestId, address, wire } = prepared
  return new Promise<NamingReply>((resolve) => {
    let socket: Socket | null = null
    let settled = false
    let reply: NamingReply | null = null
    const frame = createControlFrame(NAMING_CONTROL.responseBytes)
    const after = options.after ?? ((callback: () => void, ms: number) => {
      const timer = setTimeout(callback, ms)
      return () => clearTimeout(timer)
    })
    let cancelTimer = (): void => {}
    const finish = (result: NamingReply): void => {
      if (settled) { return }
      settled = true
      cancelTimer()
      frame.clear()
      signal?.removeEventListener('abort', onAbort)
      socket?.removeAllListeners('data')
      socket?.destroy()
      resolve(result)
    }
    const onAbort = (): void => finish(namingFailure(requestId, 'cancelled'))
    cancelTimer = after(() => finish(namingFailure(requestId, 'timeout')), NAMING_CONTROL.clientMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      socket = (options.connect ?? ((path) => createConnection(path)))(address)
      // Keep the write side open until the response; EOF is cancellation, not a request terminator.
      socket.on('connect', () => socket?.write(wire))
      socket.on('data', (chunk: Buffer) => {
        try {
          const text = frame.push(chunk)
          if (text !== null) {
            const parsed = namingReplySchema.safeParse(JSON.parse(text) as unknown)
            if (!parsed.success || parsed.data.requestId !== requestId) { throw new NamingControlError('invalid_request') }
            reply = parsed.data.ok ? parsed.data : namingFailure(requestId, parsed.data.error.code)
          }
        } catch { finish(namingFailure(requestId, 'invalid_request')) }
      })
      socket.on('end', () => finish(reply ?? namingFailure(requestId, 'invalid_request')))
      socket.on('error', () => finish(namingFailure(requestId, 'desktop_unavailable')))
      socket.on('close', () => finish(reply ?? namingFailure(requestId, 'desktop_unavailable')))
    } catch { finish(namingFailure(requestId, 'desktop_unavailable')) }
  })
}

/** One connection per request, no retry (naming changes metadata). No Electron dependency. */
export function createDesktopClient(options: DesktopClientOptions = {}): DesktopClient {
  return {
    async request(operation, requestOptions = {}) {
      const prepared = prepare(options, operation)
      if ('reply' in prepared) { return prepared.reply }
      if (requestOptions.signal?.aborted === true) { return namingFailure(prepared.requestId, 'cancelled') }
      return transport(options, prepared, requestOptions.signal)
    }
  }
}
