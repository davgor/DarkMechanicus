import type { ChatRecord, ChatRole } from '../../../shared/agents/chat'
import type { AgentView } from '../../../shared/desktop/api'
import { agentName } from './agentText'
import type { AgentStatuses } from './useAgents'

export const ROLE_LABELS: Readonly<Record<ChatRole, string>> = {
  planner: 'Planner',
  orchestrator: 'Orchestrator',
  worker: 'Worker',
  reviewer: 'Reviewer'
}

/** A folder's chats, the one that changed last first. */
export function newestFirst<T extends ChatRecord>(chats: readonly T[]): T[] {
  return [...chats].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt))
}

/**
 * A chat a lost sign-in cut short before chats became terminals, while its agent is still signed out: it waits on
 * the person to sign in. (Once the agent is signed in it waits on nothing, which is no reason to flag it.)
 */
export const waitingOnSignIn = (chat: Pick<ChatRecord, 'agent' | 'cutShortMessageId'>, statuses: AgentStatuses): boolean =>
  chat.cutShortMessageId != null && statuses[chat.agent]?.state === 'signed_out'

/** How many of the chats are waiting on the person to sign in. */
export const waitingCount = (chats: readonly Pick<ChatRecord, 'agent' | 'cutShortMessageId'>[], statuses: AgentStatuses): number =>
  chats.filter((chat) => waitingOnSignIn(chat, statuses)).length

/** The model a chat runs on; a chat with none chosen uses the agent's own default. */
const modelText = (chat: Pick<ChatRecord, 'model'>): string => chat.model ?? 'Default model'

/** "Claude Code · opus": the second line of a chat row. */
export const chatMeta = (chat: Pick<ChatRecord, 'agent' | 'model'>, connected: readonly AgentView[]): string => `${agentName(chat.agent, connected)} · ${modelText(chat)}`
