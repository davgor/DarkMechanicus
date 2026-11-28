/**
 * The agent side of the in-app browser: the ops a chat holding `browser.drive` sends over its own control pipe
 * (`DM_BROWSER_PIPE`), never the naming pipe. Shapes follow `chatNaming.ts`; the limits are the browser server's own
 * (docs/reports/agent-browser.md, "Agent interface"), never borrowed from `NAMING_CONTROL`.
 */
import { z } from 'zod'
import { chatImageRefSchema } from '../agents/chat'
import { namingErrorCodeSchema } from '../agents/chatNaming'
import { CULT_ERROR_CODES } from '../cults/cultControl'
import { serializedCredentialWithinBound } from '../../../resources/skitarii/extension/controlLimits'

/** Generation-bound browser control: 64 KiB replies carry `browser_read`/`browser_status`; screenshots are image refs. */
export const BROWSER_CONTROL = {
  version: 1, requestBytes: 8192, responseBytes: 65_536,
  connections: 16, queuedPerChat: 4, frameMs: 2_000, serverMs: 30_000, clientMs: 35_000
} as const

const plain = (max: number) => z.string().min(1).max(max).refine((value) => !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(value))
/** The caller's callsign (`Acolyte:DM-442`): a label main parses later and never trusts for Magos. */
const callerLabel = { as: plain(40).optional() }
const urlSchema = plain(2048)
/** A node ref from the last `browser_read`; a ref the page no longer has fails with `stale_ref`. */
const refSchema = z.string().regex(/^e\d{1,6}$/)
export const BROWSER_KEYS = [
  'Enter', 'Tab', 'Escape', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End'
] as const

const statusOperation = z.strictObject({ op: z.literal('browser_status'), args: z.strictObject({ ...callerLabel }) })
const navigateOperation = z.strictObject({ op: z.literal('browser_navigate'), args: z.strictObject({ ...callerLabel, url: urlSchema }) })
const clickOperation = z.strictObject({ op: z.literal('browser_click'), args: z.strictObject({ ...callerLabel, ref: refSchema }) })
const typeOperation = z.strictObject({ op: z.literal('browser_type'), args: z.strictObject({
  ...callerLabel, ref: refSchema, text: z.string().max(2000), submit: z.boolean().optional()
}) })
const pressOperation = z.strictObject({ op: z.literal('browser_press'), args: z.strictObject({ ...callerLabel, key: z.enum(BROWSER_KEYS) }) })
/** `maxChars` caps `content`; the reply never carries a password or protected field's value or its length. */
const readOperation = z.strictObject({ op: z.literal('browser_read'), args: z.strictObject({
  ...callerLabel, mode: z.enum(['text', 'tree']), maxChars: z.number().int().min(1000).max(48_000).optional()
}) })
/** Captures only a shown, on-window view; a hidden or off-window view is refused with `view_hidden`. */
const screenshotOperation = z.strictObject({ op: z.literal('browser_screenshot'), args: z.strictObject({ ...callerLabel, label: plain(80).optional() }) })
const operations = [statusOperation, navigateOperation, clickOperation, typeOperation, pressOperation, readOperation, screenshotOperation] as const
/** Each op's arguments: the input schemas of the `browser_*` commands that send them. */
export const BROWSER_ARGS = {
  browser_status: statusOperation.shape.args, browser_navigate: navigateOperation.shape.args, browser_click: clickOperation.shape.args,
  browser_type: typeOperation.shape.args, browser_press: pressOperation.shape.args, browser_read: readOperation.shape.args,
  browser_screenshot: screenshotOperation.shape.args
} as const
export const browserOperationSchema = z.discriminatedUnion('op', [...operations])
export type BrowserOperation = z.infer<typeof browserOperationSchema>

const authority = {
  version: z.literal(1), requestId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/),
  token: z.string().min(1).max(1024).refine(serializedCredentialWithinBound)
}
export const browserRequestSchema = z.discriminatedUnion('op', [
  statusOperation.extend(authority), navigateOperation.extend(authority), clickOperation.extend(authority),
  typeOperation.extend(authority), pressOperation.extend(authority), readOperation.extend(authority), screenshotOperation.extend(authority)
])
export type BrowserRequest = z.infer<typeof browserRequestSchema>

/** Who drives the chat's browser now; `stopped` until the person hands it back. */
export const browserOwnerSchema = z.enum(['none', 'agent', 'person', 'stopped'])
/** The chat's agent tab; sign-in tabs never appear here. */
export const browserTabSchema = z.strictObject({ url: z.string().max(2048), title: z.string().max(512), loading: z.boolean() })
const browserStatusResultSchema = z.strictObject({
  enabled: z.boolean(), owner: browserOwnerSchema, tab: browserTabSchema.nullable(), pendingOrigin: z.string().max(2048).nullable()
})
/** Page text or the trimmed AX projection: page-authored, so always marked untrusted. */
const browserReadResultSchema = z.strictObject({
  url: z.string().max(2048), title: z.string().max(512), untrusted: z.literal(true), content: z.string().max(48_000), truncated: z.boolean()
})
/** A drive-letter or POSIX absolute path; UNC, relative and device paths are refused. */
const absolutePath = plain(1024).refine((value) => /^(?:[A-Za-z]:[\\/]|\/(?!\/))/.test(value))
/**
 * Main stores the PNG as a chat image (`image`, for the transcript) and writes one copy for the calling chat to stage
 * as evidence: `path`, a 0600 file in a fresh 0700 `dm-browser-shot-*` directory under the system temp folder, which
 * main sweeps when it is not collected. Never bytes. The CLI checks the path, stages the copy and deletes the
 * directory; the agent's answer is the attachment, never the path.
 */
const browserScreenshotResultSchema = z.strictObject({ image: chatImageRefSchema, url: z.string().max(2048), path: absolutePath })
/** navigate, click, type and press answer with the tab they left behind. */
const browserActionResultSchema = z.strictObject({ tab: browserTabSchema })

export const browserErrorCodeSchema = z.enum([
  // The control transport's and naming's own codes; the cult members' codes are never a browser answer.
  ...namingErrorCodeSchema.exclude(CULT_ERROR_CODES).options,
  'browser_disabled', 'origin_blocked', 'paused_by_person', 'stopped', 'no_tab', 'stale_ref', 'invalid_url',
  'secret_refused', 'password_field', 'navigation_failed', 'stale_prompt', 'view_hidden'
])
export type BrowserErrorCode = z.infer<typeof browserErrorCodeSchema>
export const browserReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ version: z.literal(1), requestId: z.string().max(128), ok: z.literal(true), data: z.union([
    browserStatusResultSchema, browserReadResultSchema, browserScreenshotResultSchema, browserActionResultSchema
  ]) }),
  z.strictObject({ version: z.literal(1), requestId: z.string().max(128), ok: z.literal(false), error: z.strictObject({ code: browserErrorCodeSchema, message: z.string().max(256) }) })
])
export type BrowserReply = z.infer<typeof browserReplySchema>
export type BrowserArgs<Op extends keyof typeof BROWSER_ARGS> = z.infer<(typeof BROWSER_ARGS)[Op]>
export type BrowserStatusResult = z.infer<typeof browserStatusResultSchema>
export type BrowserReadResult = z.infer<typeof browserReadResultSchema>
export type BrowserActionResult = z.infer<typeof browserActionResultSchema>
const MESSAGES: Record<BrowserErrorCode, string> = {
  desktop_unavailable: 'The desktop browser transport is unavailable.',
  unauthorized: 'The browser authority is not usable.',
  timeout: 'The browser deadline expired.', cancelled: 'The browser operation was cancelled.',
  invalid_request: 'The browser request is invalid.', busy: 'The browser transport is busy.',
  response_too_large: 'The browser response exceeds its size limit.',
  operation_unavailable: 'The browser is not available in this desktop.',
  internal_error: 'The browser operation failed.', not_found: 'The bound chat was not found.',
  invalid_input: 'The browser input is invalid.',
  browser_disabled: 'The in-app browser is turned off.',
  origin_blocked: 'The person has not allowed this site.',
  paused_by_person: 'The person has taken control of the browser.',
  stopped: 'The person stopped the agent browser.',
  no_tab: 'No browser tab is open.',
  stale_ref: 'The element ref is no longer on the page; read the page again.',
  invalid_url: 'The URL is not an allowed http or https address.',
  secret_refused: 'The text looks like a secret and was not typed.',
  password_field: 'Password fields are filled by the person only.',
  navigation_failed: 'The page failed to load.',
  stale_prompt: 'The site prompt is no longer pending.',
  view_hidden: 'The screenshot was refused: browser view not visible.'
}
/** Only fixed messages cross the wire; exceptions can contain page text, grants or transcripts. */
export function browserFailure(requestId: string, code: BrowserErrorCode): Extract<BrowserReply, { ok: false }> {
  return { version: 1, requestId, ok: false, error: { code, message: MESSAGES[code] } }
}
export class BrowserControlError extends Error {
  constructor(readonly code: BrowserErrorCode) { super(MESSAGES[code]); this.name = 'BrowserControlError' }
}
