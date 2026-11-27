/** The Browser panel's renderer IPC. Main owns the view, the origin policy and every prompt; the renderer only asks. */
import { z } from 'zod'
import type { CommandResult } from '../desktop/api'
import { chatIdSchema, type ChatImageRef } from '../agents/chat'
import { browserOwnerSchema, browserTabSchema } from './browserControl'

export const BROWSER_CHANNELS = {
  state: 'browser:state', setView: 'browser:setView', navigate: 'browser:navigate',
  back: 'browser:back', forward: 'browser:forward', reload: 'browser:reload',
  stopAgent: 'browser:stopAgent', takeControl: 'browser:takeControl', handBack: 'browser:handBack',
  decideOrigin: 'browser:decideOrigin', openSignIn: 'browser:openSignIn', closeSignIn: 'browser:closeSignIn',
  capture: 'browser:capture', sites: 'browser:sites', removeSite: 'browser:removeSite', setEnabled: 'browser:setEnabled',
  event: 'browser:event'
} as const

const folder = z.string().nullable()
const chatRef = { folder, chatId: chatIdSchema }
const urlSchema = z.string().min(1).max(2048)
/** A scheme and host (with port), as the site list keys it: no path, query or fragment. */
const originSchema = z.string().max(2048).regex(/^https?:\/\/[^\s/?#]+$/)
/** The placeholder's rect in renderer CSS px; null hides the view (a dialog, menu or toast may overlap it). */
const boundsSchema = z.strictObject({
  x: z.number().finite(), y: z.number().finite(), width: z.number().finite().min(0).max(16_384), height: z.number().finite().min(0).max(16_384)
})

export const browserChatSchema = z.strictObject(chatRef)
export const browserSetViewSchema = z.strictObject({ ...chatRef, bounds: boundsSchema.nullable() })
export const browserNavigateSchema = z.strictObject({ ...chatRef, url: urlSchema })
export const browserDecideOriginSchema = z.strictObject({
  ...chatRef, promptId: z.string().min(1).max(128), decision: z.enum(['once', 'always', 'deny'])
})
export const browserOpenSignInSchema = z.strictObject({ ...chatRef, url: urlSchema })
export const browserSitesSchema = z.strictObject({ folder })
export const browserRemoveSiteSchema = z.strictObject({ folder, origin: originSchema })
export const browserSetEnabledSchema = z.strictObject({ enabled: z.boolean() })

/**
 * Who asked to open an origin. A `page` ask (script navigation, meta refresh, redirect) never supersedes an agent or
 * person prompt, and its card reads "This page wants to open <origin>" (red-team Fix 50).
 */
const browserOriginRequesterSchema = z.enum(['agent', 'person', 'page'])
/** The whole state of one chat's browser, pushed on `browser:event` after every change. */
export const browserStateSchema = z.strictObject({
  ...chatRef, enabled: z.boolean(), owner: browserOwnerSchema, ownerLabel: z.string().max(40).nullable(),
  tab: browserTabSchema.nullable(),
  signIn: z.strictObject({ url: z.string().max(2048), title: z.string().max(512) }).nullable(),
  pendingOrigin: z.strictObject({ id: z.string().min(1).max(128), origin: originSchema, requestedBy: browserOriginRequesterSchema }).nullable()
})
export type BrowserState = z.infer<typeof browserStateSchema>

type ChatRequest = z.infer<typeof browserChatSchema>
/** The preload contract: one invoke per request; `onEvent` validates pushes before the renderer sees them. */
export interface BrowserApi {
  state(request: ChatRequest): Promise<CommandResult<BrowserState>>
  setView(request: z.infer<typeof browserSetViewSchema>): Promise<CommandResult<null>>
  navigate(request: z.infer<typeof browserNavigateSchema>): Promise<CommandResult<null>>
  back(request: ChatRequest): Promise<CommandResult<null>>
  forward(request: ChatRequest): Promise<CommandResult<null>>
  reload(request: ChatRequest): Promise<CommandResult<null>>
  stopAgent(request: ChatRequest): Promise<CommandResult<null>>
  takeControl(request: ChatRequest): Promise<CommandResult<null>>
  handBack(request: ChatRequest): Promise<CommandResult<null>>
  decideOrigin(request: z.infer<typeof browserDecideOriginSchema>): Promise<CommandResult<null>>
  openSignIn(request: z.infer<typeof browserOpenSignInSchema>): Promise<CommandResult<null>>
  closeSignIn(request: ChatRequest): Promise<CommandResult<null>>
  /** Captures the shown view as a chat image the person can send. */
  capture(request: ChatRequest): Promise<CommandResult<{ image: ChatImageRef }>>
  /** The folder's always-allowed origins. */
  sites(request: z.infer<typeof browserSitesSchema>): Promise<CommandResult<string[]>>
  removeSite(request: z.infer<typeof browserRemoveSiteSchema>): Promise<CommandResult<null>>
  setEnabled(request: z.infer<typeof browserSetEnabledSchema>): Promise<CommandResult<null>>
  onEvent(listener: (state: BrowserState) => void): () => void
}
