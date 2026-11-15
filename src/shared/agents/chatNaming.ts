import { z } from 'zod'

/** Naming metadata only. No UI, filesystem, navigation, or caller-selected target operations. */
export const NAMING_CONTROL = {
  version: 1, requestBytes: 4096, responseBytes: 4096,
  connections: 32, queuedPerChat: 8, frameMs: 2_000, serverMs: 20_000, clientMs: 25_000
} as const
const text = z.string().min(1).max(256).refine((value) => !/[\p{Cc}\u2028\u2029]/u.test(value))
export const nameChatArgsSchema = z.union([
  z.strictObject({ title: text.pipe(z.string().trim().min(1).max(120)).refine((value) => value.split(/\s+/u).length <= 5, 'Use at most five words.') }),
  z.strictObject({ error: text })
])
export type NameChatArgs = z.infer<typeof nameChatArgsSchema>
export const namingOperationSchema = z.strictObject({ op: z.literal('name_chat'), args: nameChatArgsSchema })
export type NamingOperation = z.infer<typeof namingOperationSchema>
export const namingRequestSchema = namingOperationSchema.extend({
  version: z.literal(1), requestId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/), token: z.string().min(1).max(1024)
})
export type NamingRequest = z.infer<typeof namingRequestSchema>
export const namingErrorCodeSchema = z.enum([
  'desktop_unavailable', 'unauthorized', 'timeout', 'cancelled', 'invalid_request',
  'busy', 'response_too_large', 'operation_unavailable', 'internal_error', 'not_found', 'invalid_input'
])
export type NamingErrorCode = z.infer<typeof namingErrorCodeSchema>
export const namingReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ version: z.literal(1), requestId: z.string().max(128), ok: z.literal(true), data: z.strictObject({ applied: z.boolean() }) }),
  z.strictObject({ version: z.literal(1), requestId: z.string().max(128), ok: z.literal(false), error: z.strictObject({ code: namingErrorCodeSchema, message: z.string().max(256) }) })
])
export type NamingReply = z.infer<typeof namingReplySchema>
const MESSAGES: Record<NamingErrorCode, string> = {
  desktop_unavailable: 'The desktop naming transport is unavailable.',
  unauthorized: 'The chat naming authority is not usable.',
  timeout: 'The chat naming deadline expired.', cancelled: 'The chat naming operation was cancelled.',
  invalid_request: 'The chat naming request is invalid.', busy: 'The chat naming transport is busy.',
  response_too_large: 'The chat naming response exceeds its size limit.',
  operation_unavailable: 'Chat naming is not available in this desktop.',
  internal_error: 'The chat naming operation failed.', not_found: 'The bound chat was not found.',
  invalid_input: 'The inferred chat title is invalid.'
}
/** Only fixed messages cross the wire; exceptions can contain grants or transcripts. */
export function namingFailure(requestId: string, code: NamingErrorCode): Extract<NamingReply, { ok: false }> {
  return { version: 1, requestId, ok: false, error: { code, message: MESSAGES[code] } }
}
export class NamingControlError extends Error {
  constructor(readonly code: NamingErrorCode) { super(MESSAGES[code]); this.name = 'NamingControlError' }
}
