import type { ZodType } from 'zod'
import {
  NAMING_CONTROL, NamingControlError, namingErrorCodeSchema, namingFailure, namingOperationSchema, namingReplySchema, namingRequestSchema,
  type NamingErrorCode, type NamingOperation, type NamingReply, type NamingRequest
} from '../../shared/agents/chatNaming'
import {
  BROWSER_CONTROL, BrowserControlError, browserErrorCodeSchema, browserFailure, browserOperationSchema, browserReplySchema, browserRequestSchema,
  type BrowserErrorCode, type BrowserOperation, type BrowserReply, type BrowserRequest
} from '../../shared/browser/browserControl'

/** Codes the generic server and client produce themselves; every protocol's error codes include them. */
export type ControlTransportCode =
  | 'desktop_unavailable' | 'unauthorized' | 'timeout' | 'cancelled' | 'invalid_request'
  | 'busy' | 'response_too_large' | 'operation_unavailable' | 'internal_error'

export interface ControlLimits {
  readonly version: number
  readonly connections: number
  /** Queued operations per chat lane behind its single active operation. */
  readonly queuedPerChat: number
  readonly frameMs: number
  readonly serverMs: number
  readonly clientMs: number
  readonly requestBytes: number
  readonly responseBytes: number
}
export type ControlReplyShape<Code> =
  | { readonly requestId: string; readonly ok: true }
  | { readonly requestId: string; readonly ok: false; readonly error: { readonly code: Code } }
/** One wire protocol over the authenticated local transport: schemas, limits and its fixed-message error factory. */
export interface ControlProtocol<
  Op extends { op: string; args: unknown },
  Request extends Op & { requestId: string; token: string },
  Reply extends ControlReplyShape<Code | ControlTransportCode>,
  Code extends string
> {
  readonly limits: ControlLimits
  readonly requestSchema: ZodType<Request>
  readonly operationSchema: ZodType<Op>
  readonly replySchema: ZodType<Reply>
  /** Only fixed messages cross the wire; exceptions can contain grants or transcripts. */
  failure(requestId: string, code: Code | ControlTransportCode): Reply
  error(code: Code | ControlTransportCode): Error
  errorCodeOf(error: unknown): Code | ControlTransportCode
  /** A tighter request bound for one operation; the frame already enforces `limits.requestBytes`. */
  requestBytesOf?(op: Op['op']): number
}

function namingErrorCodeOf(error: unknown): NamingErrorCode {
  if (error instanceof NamingControlError) { return error.code }
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const parsed = namingErrorCodeSchema.safeParse(error.code)
    if (parsed.success) { return parsed.data }
  }
  return 'internal_error'
}

/** The desktop pipe behind `name_chat` and the narrow tooling-recovery repair. */
export const NAMING_PROTOCOL: ControlProtocol<NamingOperation, NamingRequest, NamingReply, NamingErrorCode> = {
  limits: NAMING_CONTROL,
  requestSchema: namingRequestSchema,
  operationSchema: namingOperationSchema,
  replySchema: namingReplySchema,
  failure: namingFailure,
  error: (code) => new NamingControlError(code),
  errorCodeOf: namingErrorCodeOf,
  requestBytesOf: (op) => op === 'name_chat' ? NAMING_CONTROL.namingRequestBytes : NAMING_CONTROL.requestBytes
}

function browserErrorCodeOf(error: unknown): BrowserErrorCode {
  if (error instanceof BrowserControlError) { return error.code }
  if (error !== null && typeof error === 'object' && 'code' in error) {
    const parsed = browserErrorCodeSchema.safeParse(error.code)
    if (parsed.success) { return parsed.data }
  }
  return 'internal_error'
}

/** The desktop's second pipe (`DM_BROWSER_PIPE`), behind the `browser_*` commands: its own limits, never naming's. */
export const BROWSER_PROTOCOL: ControlProtocol<BrowserOperation, BrowserRequest, BrowserReply, BrowserErrorCode> = {
  limits: BROWSER_CONTROL,
  requestSchema: browserRequestSchema,
  operationSchema: browserOperationSchema,
  replySchema: browserReplySchema,
  failure: browserFailure,
  error: (code) => new BrowserControlError(code),
  errorCodeOf: browserErrorCodeOf
}
