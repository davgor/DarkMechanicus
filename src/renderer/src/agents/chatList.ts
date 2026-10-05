import type { ChatRecord, ChatRole } from '../../../shared/agents/chat'
import type { ChatSummary } from '../../../shared/agents/chatApi'
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
 * A chat a lost sign-in cut short, while its agent is still signed out: it waits on the person to sign in.
 * (Once the agent is signed in it waits on a Retry, which is no reason to flag it.)
 */
export const waitingOnSignIn = (chat: Pick<ChatRecord, 'agent' | 'cutShortMessageId'>, statuses: AgentStatuses): boolean =>
  chat.cutShortMessageId != null && statuses[chat.agent]?.state === 'signed_out'

type Waiting = Pick<ChatSummary, 'agent' | 'cutShortMessageId' | 'pending'>

/** How many of the chats are waiting on the person: an answer to an approval request, or a sign-in. */
export const waitingCount = (chats: readonly Waiting[], statuses: AgentStatuses): number =>
  chats.filter((chat) => chat.pending > 0 || waitingOnSignIn(chat, statuses)).length

/** What the waiting chats wait for, for the words around a waiting badge. */
export function waitingReason(chats: readonly Waiting[], statuses: AgentStatuses): 'approval' | 'sign-in' | 'approval or sign-in' {
  const approval = chats.some((chat) => chat.pending > 0)
  const signIn = chats.some((chat) => waitingOnSignIn(chat, statuses))
  if (approval && signIn) {
    return 'approval or sign-in'
  }
  return signIn ? 'sign-in' : 'approval'
}

/** The model a chat runs on; a chat with none chosen uses the agent's own default. */
export const modelText = (chat: Pick<ChatRecord, 'model'>): string => chat.model ?? 'Default model'

/** "Claude Code · opus": the second line of a chat row. */
export const chatMeta = (chat: Pick<ChatRecord, 'agent' | 'model'>): string => `${agentName(chat.agent)} · ${modelText(chat)}`
