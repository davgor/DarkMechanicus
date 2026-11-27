import { z } from 'zod'
import { toolingRecoveryInputSchema, toolingRecoveryResultSchema } from './toolingRecovery'
import { DESKTOP_CONTROL_LIMITS, serializedCredentialWithinBound } from '../../../resources/skitarii/extension/controlLimits'
import {
  CULT_ERROR_CODES, CULT_ERROR_MESSAGES, CULT_OPERATION_SCHEMAS, CULT_RESULT_SCHEMAS, cultErrorDetailsSchema, isCultOperation,
  LONG_TEXT_OPERATIONS, type CultErrorDetails
} from '../cults/cultControl'

/** Generation-bound local desktop control; each operation has its own server-side authority. */
export const NAMING_CONTROL = {
  version: 1, ...DESKTOP_CONTROL_LIMITS,
  /**
   * A cult chronicle or report (32 KiB) or order (16 KiB) as JSON, with the credential: the largest frame either side
   * reads. Every other operation keeps its own smaller bound, checked once its frame is parsed.
   */
  cultRequestBytes: 72 * 1024,
  /** A cult result (the acolyte list) can outgrow `responseBytes`; only cult operations get this bound. */
  cultResponseBytes: 32 * 1024,
  connections: 32, queuedPerChat: 8, frameMs: 2_000, serverMs: 20_000, clientMs: 25_000
} as const
const text = z.string().min(1).max(256).refine((value) => !/[\p{Cc}\u2028\u2029]/u.test(value))
export const nameChatArgsSchema = z.union([
  z.strictObject({ title: text.pipe(z.string().trim().min(1).max(120)).refine((value) => value.split(/\s+/u).length <= 5, 'Use at most five words.') }),
  z.strictObject({ error: text })
])
export type NameChatArgs = z.infer<typeof nameChatArgsSchema>
const nameOperationSchema = z.strictObject({ op: z.literal('name_chat'), args: nameChatArgsSchema })
const recoveryOperationSchema = z.strictObject({ op: z.literal('recover_tooling'), args: toolingRecoveryInputSchema })
const recoveryContextSchema = z.strictObject({ op: z.literal('recovery_context'), args: z.strictObject({
  chatId: z.string().min(1).max(128), generation: z.string().min(1).max(128)
}) })
const OPERATIONS = [nameOperationSchema, recoveryOperationSchema, recoveryContextSchema, ...CULT_OPERATION_SCHEMAS] as const
export const namingOperationSchema = z.discriminatedUnion('op', OPERATIONS)
export type NamingOperation = z.infer<typeof namingOperationSchema>
const authority = { version: z.literal(1), requestId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/), token: z.string().min(1).max(1024).refine(serializedCredentialWithinBound) }
export const namingRequestSchema = z.discriminatedUnion('op', [
  nameOperationSchema.extend(authority), recoveryOperationSchema.extend(authority), recoveryContextSchema.extend(authority),
  ...CULT_OPERATION_SCHEMAS.map((operation) => operation.extend(authority))
])
export type NamingRequest = z.infer<typeof namingRequestSchema>

/** The largest request frame an operation may take: naming is smallest, a long cult text the largest. */
export function requestBound(op: string): number {
  if (op === 'name_chat') return NAMING_CONTROL.namingRequestBytes
  return LONG_TEXT_OPERATIONS.includes(op) ? NAMING_CONTROL.cultRequestBytes : NAMING_CONTROL.requestBytes
}
/** The largest reply frame an operation may receive. */
export function responseBound(op: string): number {
  return isCultOperation(op) ? NAMING_CONTROL.cultResponseBytes : NAMING_CONTROL.responseBytes
}

export const namingErrorCodeSchema = z.enum([
  'desktop_unavailable', 'unauthorized', 'timeout', 'cancelled', 'invalid_request',
  'busy', 'response_too_large', 'operation_unavailable', 'internal_error', 'not_found', 'invalid_input', ...CULT_ERROR_CODES
])
export type NamingErrorCode = z.infer<typeof namingErrorCodeSchema>
export const namingReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ version: z.literal(1), requestId: z.string().max(128), ok: z.literal(true), data: z.union([
    z.strictObject({ applied: z.boolean() }), toolingRecoveryResultSchema,
    z.strictObject({ messages: z.array(z.strictObject({ id: z.string(), text: z.string().max(6000) })).max(1) }),
    ...CULT_RESULT_SCHEMAS
  ]) }),
  z.strictObject({ version: z.literal(1), requestId: z.string().max(128), ok: z.literal(false), error: z.strictObject({
    code: namingErrorCodeSchema, message: z.string().max(256), details: cultErrorDetailsSchema.optional()
  }) })
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
  invalid_input: 'The inferred chat title is invalid.',
  ...CULT_ERROR_MESSAGES
}
/** Only fixed messages cross the wire; exceptions can contain grants or transcripts. Details are a refused model's alternatives. */
export function namingFailure(requestId: string, code: NamingErrorCode, details?: CultErrorDetails): Extract<NamingReply, { ok: false }> {
  return { version: 1, requestId, ok: false, error: { code, message: MESSAGES[code], ...(details === undefined ? {} : { details }) } }
}
export class NamingControlError extends Error {
  constructor(readonly code: NamingErrorCode, readonly details?: CultErrorDetails) { super(MESSAGES[code]); this.name = 'NamingControlError' }
}
