import type { Ctx } from '../../core/context'
import {
  bindAgentMailEndpoint,
  deleteAgentMailEndpoint,
  provisionAgentMailEndpoint,
  resumeAgentMailEndpoint
} from '../../core/services/agentMail'
import { AGENT_MAIL_LIMITS, findEndpointByChat, type MailEndpoint } from '../../core/services/agentMailStore'
import type { ChatRecord } from '../../shared/agents/chat'

/** What a mailbox is provisioned for: the chat's id, its stored agent id, and its title as the display name. */
export type MailboxChat = Pick<ChatRecord, 'id' | 'agent' | 'title'>

/** The only agent whose chats have mailboxes: the bundled Skitarii extension runs in OMP. */
const MAILBOX_AGENT = 'omp'

/** Whether the chat has a mailbox: an OMP chat by its stored agent id, and by the connected agent's `kind` when given. */
export function hasMailbox(chat: Pick<ChatRecord, 'agent'>, kind?: string): boolean {
  return chat.agent === MAILBOX_AGENT && (kind === undefined || kind === MAILBOX_AGENT)
}

/** The endpoint's display name: the chat's title, trimmed to the store's limit; an empty title reads as "Chat". */
export function mailboxName(title: string): string {
  const name = title.trim().slice(0, AGENT_MAIL_LIMITS.nameChars).trim()
  return name === '' ? 'Chat' : name
}

/**
 * The chat's open endpoint, created on first use; one suspended by an untrack is resumed (only main, trusted, calls
 * this). A deleting or deleted one throws `invalid_state`: a tombstone is never reopened.
 */
function openChatMailbox(ctx: Ctx, chat: MailboxChat): MailEndpoint {
  return ctx.db.tx(() => {
    const endpoint = provisionAgentMailEndpoint(ctx, { chatId: chat.id, name: mailboxName(chat.title) })
    return endpoint.state === 'suspended' ? resumeAgentMailEndpoint(ctx, { endpointId: endpoint.id }) : endpoint
  })
}

/** Binds a fresh grant to the chat's open mailbox in one transaction; returns the endpoint's id. */
export function bindChatMailbox(ctx: Ctx, chat: MailboxChat, grantId: string): string {
  return ctx.db.tx(() => {
    const endpoint = openChatMailbox(ctx, chat)
    bindAgentMailEndpoint(ctx, { endpointId: endpoint.id, grantId })
    return endpoint.id
  })
}

/** Records the deletion durably (a tombstone even for a chat that never had a mailbox), then purges batch by batch until done. */
export function deleteChatMailbox(ctx: Ctx, chat: MailboxChat): void {
  const endpoint =
    findEndpointByChat(ctx, { machineId: ctx.machineId, chatId: chat.id }) ??
    provisionAgentMailEndpoint(ctx, { chatId: chat.id, name: mailboxName(chat.title) })
  while (!deleteAgentMailEndpoint(ctx, { endpointId: endpoint.id }).done) {
    // One bounded purge batch per call; each commits on its own.
  }
}

/** Provisions (and resumes) every chat's mailbox in one transaction, setting aside chats whose mailbox is deleting or deleted. */
export function provisionAll(ctx: Ctx, chats: readonly MailboxChat[]): { endpoints: Map<string, string>; deleting: Set<string> } {
  const endpoints = new Map<string, string>()
  const deleting = new Set<string>()
  ctx.db.tx(() => {
    for (const chat of chats) {
      const state = findEndpointByChat(ctx, { machineId: ctx.machineId, chatId: chat.id })?.state
      if (state === 'deleting' || state === 'deleted') {
        deleting.add(chat.id)
      } else {
        endpoints.set(chat.id, openChatMailbox(ctx, chat).id)
      }
    }
  })
  return { endpoints, deleting }
}
