/**
 * Who drives each chat's agent browser: nobody yet (`none`), an agent, the person, or nobody because the person
 * stopped it. Pure: the browser service applies the returned effects (detach the debugger, stop loading) itself.
 *
 * - `none` → `agent` on the first agent op; `none`, `agent` and `stopped` → `person` through takeControl;
 *   `person` → `agent` and `stopped` → `none` through handBack; any state → `stopped` through stop.
 * - Agent ops never wait for the person: in `person` or `stopped` they are refused at once.
 * - stop and takeControl abort every in-flight op's signal synchronously, so no agent input lands after the person
 *   took over; takeControl detaches the debugger so the person's typing, passwords included, is never observable.
 */
import type { z } from 'zod'
import { cleanLabel, formatCallsign, parseCallsignLabel, rootCallsignOf } from '../../shared/agents/callsign'
import type { ChatRole } from '../../shared/agents/chat'
import type { browserOwnerSchema } from '../../shared/browser/browserControl'
import { maskAgentChatSecretsDeep } from '../agentChat/secretMask'

type BrowserOwner = z.infer<typeof browserOwnerSchema>
type BrowserOwnershipEffect = 'detach_debugger' | 'stop_loading'

/** An admitted agent op: its signal aborts on stop or takeControl; `end` releases it once the op settles. */
interface AgentOpLease {
  ok: true
  signal: AbortSignal
  end(): void
}
type AgentOpRefusal = { ok: false; code: 'paused_by_person' | 'stopped' }

/** Per-chat ownership; every transition returns the effects the browser service must apply. */
export interface BrowserOwnership {
  owner(chatId: string): BrowserOwner
  beginAgentOp(chatId: string): AgentOpLease | AgentOpRefusal
  stop(chatId: string): readonly BrowserOwnershipEffect[]
  takeControl(chatId: string): readonly BrowserOwnershipEffect[]
  handBack(chatId: string): readonly BrowserOwnershipEffect[]
  forget(chatId: string): void
}

interface ChatBrowser {
  owner: BrowserOwner
  inFlight: Set<AbortController>
}

const LABEL_LIMIT = 40

function entryOf(chats: Map<string, ChatBrowser>, chatId: string): ChatBrowser {
  let chat = chats.get(chatId)
  if (chat === undefined) {
    chat = { owner: 'none', inFlight: new Set() }
    chats.set(chatId, chat)
  }
  return chat
}

function abortAll(chat: ChatBrowser, reason: 'paused_by_person' | 'stopped'): void {
  const controllers = [...chat.inFlight]
  chat.inFlight.clear()
  for (const controller of controllers) controller.abort(reason)
}

export function createBrowserOwnership(): BrowserOwnership {
  const chats = new Map<string, ChatBrowser>()
  return {
    owner(chatId: string): BrowserOwner {
      return chats.get(chatId)?.owner ?? 'none'
    },

    beginAgentOp(chatId: string): AgentOpLease | AgentOpRefusal {
      const chat = entryOf(chats, chatId)
      if (chat.owner === 'person') return { ok: false, code: 'paused_by_person' }
      if (chat.owner === 'stopped') return { ok: false, code: 'stopped' }
      chat.owner = 'agent'
      const controller = new AbortController()
      chat.inFlight.add(controller)
      return { ok: true, signal: controller.signal, end: () => { chat.inFlight.delete(controller) } }
    },

    stop(chatId: string): readonly BrowserOwnershipEffect[] {
      const chat = entryOf(chats, chatId)
      chat.owner = 'stopped'
      abortAll(chat, 'stopped')
      return ['detach_debugger', 'stop_loading']
    },

    takeControl(chatId: string): readonly BrowserOwnershipEffect[] {
      const chat = entryOf(chats, chatId)
      if (chat.owner === 'person') return []
      chat.owner = 'person'
      abortAll(chat, 'paused_by_person')
      return ['detach_debugger']
    },

    /** The next agent op re-attaches the debugger, so handing back has no effect of its own. */
    handBack(chatId: string): readonly BrowserOwnershipEffect[] {
      const chat = chats.get(chatId)
      if (chat?.owner === 'person') chat.owner = 'agent'
      else if (chat?.owner === 'stopped') chat.owner = 'none'
      return []
    },

    /** The chat was closed or deleted: abort what is still running and drop its state. */
    forget(chatId: string): void {
      const chat = chats.get(chatId)
      if (chat === undefined) return
      chats.delete(chatId)
      abortAll(chat, 'stopped')
    }
  }
}

/** The chat record fields the badge reads. */
export interface OwnerLabelChat {
  role: ChatRole
  runId?: string
  title: string
}

/**
 * The ownership badge: `You` while the person drives, the driving agent while an agent does, null otherwise. An agent's
 * `as` label is model-supplied, so it names an Acolyte or Inquisitor only for a ticket bound to the chat's threads and
 * never grants a root role; anything else shows the chat's own name, where `Magos` comes from the chat record alone.
 */
export function ownerLabel({ owner, chat, as, boundTicketKeys }: {
  owner: BrowserOwner
  chat: OwnerLabelChat
  as: string | undefined
  boundTicketKeys: ReadonlySet<string>
}): string | null {
  if (owner === 'person') return 'You'
  if (owner !== 'agent') return null
  const parsed = as === undefined ? null : parseCallsignLabel(as)
  const verified = parsed !== null && parsed.role !== 'Servitor' && parsed.ticketKey !== null && boundTicketKeys.has(parsed.ticketKey)
  return plainLabel(verified ? `${parsed.role}:${parsed.ticketKey}` : chatName(chat))
}

function chatName(chat: OwnerLabelChat): string {
  const root = rootCallsignOf(chat)
  if (root?.role === 'Magos') return formatCallsign(root)
  const title = chat.title.trim()
  if (title) return title
  return root === null ? 'An agent chat' : formatCallsign(root)
}

/** Plain text, secrets masked before clipping so a cut never leaves part of a token unmasked. */
function plainLabel(text: string): string {
  const masked = maskAgentChatSecretsDeep(cleanLabel(text.replace(/\p{Cf}/gu, '')))
  const clipped = masked.slice(0, LABEL_LIMIT)
  return /[\uD800-\uDBFF]$/.test(clipped) ? clipped.slice(0, -1) : clipped
}
