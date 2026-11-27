import type { Ctx } from '../../core/context'
import {
  bindAgentMailEndpoint,
  deleteAgentMailEndpoint,
  provisionAgentMailEndpoint,
  renameAgentMailEndpoint,
  resumeAgentMailEndpoint
} from '../../core/services/agentMail'
import { AGENT_MAIL_LIMITS, findEndpointByChat, type MailEndpoint, type MailEndpointChatMeta } from '../../core/services/agentMailStore'
import type { ChatRecord } from '../../shared/agents/chat'

/**
 * What a mailbox is provisioned for: the chat's id, its stored agent id, its title as the display name, and the trusted
 * metadata main records from its own chat record (role and epic binding, including the bindings chats stored before
 * `epicId`). A tombstone or suspension made for a chat id alone carries none of the optional fields.
 */
export type MailboxChat = Pick<ChatRecord, 'id' | 'agent' | 'title'> &
  Partial<Pick<ChatRecord, 'role' | 'epicId' | 'runId' | 'transferEpicId' | 'conversation'>>

/** The chat record's fields a mailbox is provisioned from, as main hands them to the folder's workspace. */
export function mailboxChat(chat: ChatRecord): MailboxChat {
  const { id, agent, title, role, epicId, runId, transferEpicId, conversation } = chat
  return {
    id,
    agent,
    title,
    role,
    ...(epicId === undefined ? {} : { epicId }),
    ...(runId === undefined ? {} : { runId }),
    ...(transferEpicId === undefined ? {} : { transferEpicId }),
    ...(conversation === undefined ? {} : { conversation })
  }
}

/** The only agent whose chats have mailboxes: the bundled Skitarii extension runs in OMP. */
const MAILBOX_AGENT = 'omp'

/** Whether the chat has a mailbox: an OMP chat by its stored agent id, and by the connected agent's `kind` when given. */
export function hasMailbox(chat: Pick<ChatRecord, 'agent'>, kind?: string): boolean {
  return chat.agent === MAILBOX_AGENT && (kind === undefined || kind === MAILBOX_AGENT)
}

/** The endpoint's display name: the chat's title, trimmed to the store's limit; an empty title reads as "Chat". */
function mailboxName(title: string): string {
  const name = title.trim().slice(0, AGENT_MAIL_LIMITS.nameChars).trim()
  return name === '' ? 'Chat' : name
}

/**
 * The chat's trusted epic and role, from main's chat record and never from an agent. The epic is the explicit `epicId`
 * binding, else a legacy one: the transfer's epic, the board conversation's epic, or the epic of the run the chat
 * orchestrates, which only this folder's database can resolve. Null when the chat has none.
 */
function mailboxChatMeta(ctx: Ctx, chat: MailboxChat): MailEndpointChatMeta {
  const conversationEpic = chat.conversation !== undefined && 'epicId' in chat.conversation ? chat.conversation.epicId : undefined
  const runEpic = chat.runId === undefined
    ? undefined
    : ctx.db.get<{ epic_id: string }>('SELECT epic_id FROM runs WHERE id = ?', chat.runId)?.epic_id
  return { epicId: chat.epicId ?? chat.transferEpicId ?? conversationEpic ?? runEpic ?? null, chatRole: chat.role ?? null }
}

/**
 * The chat's open endpoint, created on first use, with its name and trusted metadata refreshed from the chat record;
 * one suspended by an untrack is resumed (only main, trusted, calls this). A deleting or deleted one throws
 * `invalid_state`: a tombstone is never reopened.
 */
function openChatMailbox(ctx: Ctx, chat: MailboxChat): MailEndpoint {
  return ctx.db.tx(() => {
    const endpoint = provisionAgentMailEndpoint(ctx, { chatId: chat.id, name: mailboxName(chat.title), ...mailboxChatMeta(ctx, chat) })
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

/** Renames the chat's endpoint to its title and refreshes its trusted epic and role from the chat record. */
export function renameChatMailbox(ctx: Ctx, endpointId: string, chat: MailboxChat): MailEndpoint {
  return renameAgentMailEndpoint(ctx, { endpointId, name: mailboxName(chat.title), ...mailboxChatMeta(ctx, chat) })
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
