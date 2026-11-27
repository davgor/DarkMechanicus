import { z } from 'zod'
import type { ControlLimits, ControlProtocol } from '../controlProtocol'

/** A toy protocol on the generic control transport: one `echo` op returning `bytes` characters. */
const echoCodeSchema = z.enum([
  'desktop_unavailable', 'unauthorized', 'timeout', 'cancelled', 'invalid_request',
  'busy', 'response_too_large', 'operation_unavailable', 'internal_error', 'echo_refused'
])
type EchoCode = z.infer<typeof echoCodeSchema>
const echoOperationSchema = z.strictObject({ op: z.literal('echo'), args: z.strictObject({ bytes: z.number().int().min(0).max(1_000_000) }) })
type EchoOperation = z.infer<typeof echoOperationSchema>
const echoRequestSchema = echoOperationSchema.extend({
  version: z.literal(1), requestId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/), token: z.string().min(1).max(1024)
})
const echoReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ version: z.literal(1), requestId: z.string().max(128), ok: z.literal(true), data: z.strictObject({ text: z.string() }) }),
  z.strictObject({ version: z.literal(1), requestId: z.string().max(128), ok: z.literal(false), error: z.strictObject({ code: echoCodeSchema, message: z.string().max(64) }) })
])
type EchoReply = z.infer<typeof echoReplySchema>

export class EchoError extends Error {
  constructor(readonly code: EchoCode) { super(`echo failed: ${code}`); this.name = 'EchoError' }
}
const ECHO_LIMITS: ControlLimits = {
  version: 1, connections: 4, queuedPerChat: 1, frameMs: 2_000, serverMs: 5_000, clientMs: 10_000, requestBytes: 4096, responseBytes: 65_536
}
export function echoProtocol(limits: Partial<ControlLimits> = {}): ControlProtocol<EchoOperation, z.infer<typeof echoRequestSchema>, EchoReply, EchoCode> {
  return {
    limits: { ...ECHO_LIMITS, ...limits },
    requestSchema: echoRequestSchema,
    operationSchema: echoOperationSchema,
    replySchema: echoReplySchema,
    failure: (requestId, code) => ({ version: 1, requestId, ok: false, error: { code, message: `Echo: ${code}.` } }),
    error: (code) => new EchoError(code),
    errorCodeOf: (error) => error instanceof EchoError ? error.code : 'internal_error'
  }
}
