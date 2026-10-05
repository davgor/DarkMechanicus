/**
 * What `codex app-server` says when the person's login has expired, been revoked, or was never done,
 * built from the Codex source. NOT captured from a running Codex (it is not installed where this was
 * written, and no real expired session could be made); each shape below is read from
 * https://github.com/openai/codex at the paths named, as of 2026-10-05:
 *
 * - A turn that fails for a rejected login ends with `turn/completed` whose turn has status `failed`
 *   and an `error` of the `TurnError` type (`codex-rs/app-server-protocol/schema/typescript/v2/
 *   TurnError.ts`: `message`, `codexErrorInfo`, `additionalDetails`); an `error` notification
 *   (`ErrorNotification.ts`: `error`, `willRetry`, `threadId`, `turnId`) comes first.
 * - `codexErrorInfo` is `"unauthorized"` when the access token could not be refreshed
 *   (`codex-rs/protocol/src/error.rs`, `CodexErrorDetails::RefreshTokenFailed` maps to
 *   `CodexErrorInfo::Unauthorized`); its message is one of the `REFRESH_TOKEN_*_MESSAGE` texts in
 *   `codex-rs/login/src/auth/manager.rs`.
 * - With no login at all the request goes out without credentials and the API answers 401, which
 *   `error.rs` classifies as `httpConnectionFailed` with `httpStatusCode: 401` and words it
 *   `unexpected status 401 Unauthorized: <body message>, url: ..., request id: ...` (its `Display`
 *   for `UnexpectedResponseError`). The body message here is illustrative.
 * - `thread/start`, `thread/resume` and `turn/start` can be refused before any turn runs: when the
 *   configuration cannot be loaded because the login cannot be refreshed, the JSON-RPC error is an
 *   invalid-request error (-32600) "failed to load configuration: ..." whose `data` is
 *   `{ reason: "cloudConfigBundle", errorCode: "Auth", action: "relogin", statusCode: 401, detail }`
 *   (`codex-rs/app-server/src/request_processors/config_errors.rs`, asserted in
 *   `codex-rs/app-server/tests/suite/v2/thread_start.rs`).
 *
 * Not shipped.
 */
import { step, type Json, type Step } from './codexReplay'

export const THREAD = 'thr_1'
export const TURN = 'turn_1'

/** The words Codex uses when the refresh token has expired (`REFRESH_TOKEN_EXPIRED_MESSAGE`). */
export const EXPIRED_MESSAGE =
  'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.'

/** The words for a revoked refresh token (`REFRESH_TOKEN_INVALIDATED_MESSAGE`). */
export const REVOKED_MESSAGE =
  'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.'

/** The `Display` of an `UnexpectedResponseError` for a 401 with no login (see above). */
export const NO_LOGIN_MESSAGE =
  'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, request id: req_0123456789'

const INITIALIZE: Step[] = [
  step.expect('initialize'),
  step.reply({ userAgent: 'codex/0.99.0', codexHome: '/home/me/.codex', platformFamily: 'unix', platformOs: 'linux' }),
  step.expect('initialized')
]

const THREAD_RESULT: Json = { thread: { id: THREAD, turns: [] }, model: 'gpt-5-codex', approvalPolicy: 'untrusted' }

export const NEW_THREAD: Step[] = [...INITIALIZE, step.expect('thread/start'), step.reply(THREAD_RESULT)]

export const RESUME_THREAD: Step[] = [...INITIALIZE, step.expect('thread/resume', { threadId: THREAD }), step.reply(THREAD_RESULT)]

/** The refusal Codex gives when the login cannot be refreshed while it loads its configuration. */
export function reloginRefusal(detail: string): Step {
  return step.fail(-32600, `failed to load configuration: ${detail}`, {
    reason: 'cloudConfigBundle',
    errorCode: 'Auth',
    action: 'relogin',
    statusCode: 401,
    detail
  })
}

const turnError = (message: string, codexErrorInfo: Json): Json => ({ message, codexErrorInfo, additionalDetails: null, misalignment: null })

const IN_PROGRESS: Json = { id: TURN, items: [], status: 'inProgress', error: null }

/** `turn/start` is accepted, then the turn fails with `message` classified as `codexErrorInfo`. */
export function failedTurn(message: string, codexErrorInfo: Json): Step[] {
  const error = turnError(message, codexErrorInfo)
  return [
    step.expect('turn/start', { threadId: THREAD }),
    step.reply({ turn: IN_PROGRESS }),
    step.notify('turn/started', { threadId: THREAD, turn: IN_PROGRESS }),
    step.notify('error', { error, willRetry: false, threadId: THREAD, turnId: TURN }),
    step.notify('turn/completed', { threadId: THREAD, turn: { id: TURN, items: [], status: 'failed', error } })
  ]
}

/** A turn that gets as far as an assistant message before the login is refused. */
export function failedTurnAfterText(message: string): Step[] {
  const text = step.notify('item/completed', {
    threadId: THREAD,
    turnId: TURN,
    completedAtMs: 2,
    item: { type: 'agentMessage', id: 'm1', text: 'Looking at it.' }
  })
  const [start, accepted, started, ...rest] = failedTurn(message, 'unauthorized') as [Step, Step, Step, ...Step[]]
  return [start, accepted, started, text, ...rest]
}
