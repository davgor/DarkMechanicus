import type { ChatRecord } from '../../shared/agents/chat'
import type { BoundTarget } from './boundThreads'
import type { ChatStore } from './chatStore'

export type ConversationTarget = { epicId: string; ticketId?: string } | { cardId: string }

export interface ConversationReads {
  /** A claimed or running, non-superseded attempt for the ticket. */
  openAttemptId(folder: string, ticketId: string): Promise<string | null>
  /** Any non-terminal run for the epic. */
  activeRunId(folder: string, epicId: string): Promise<string | null>
}

interface ConversationDeps {
  reads: ConversationReads
  store: Pick<ChatStore, 'listChats'>
  boundTerminal(folder: string, target: BoundTarget): Promise<string | null>
}

export interface ResolvedConversationChat {
  chatId: string
  via: 'attempt' | 'run' | 'card_play' | 'conversation'
}

function newest(chats: readonly ChatRecord[], matches: (chat: ChatRecord) => boolean): ChatRecord | null {
  return chats.reduce<ChatRecord | null>((found, chat) => {
    if (!matches(chat)) return found
    return found === null || chat.createdAt > found.createdAt ? chat : found
  }, null)
}

function listedChat(chats: readonly ChatRecord[], chatId: string | null): string | null {
  return chatId !== null && chats.some((chat) => chat.id === chatId) ? chatId : null
}

export async function resolveConversationChat(
  deps: ConversationDeps,
  folder: string,
  target: ConversationTarget
): Promise<ResolvedConversationChat | null> {
  const chats = deps.store.listChats(folder)
  if ('cardId' in target) {
    const play = newest(chats, (chat) => chat.cardId === target.cardId)
    if (play !== null) return { chatId: play.id, via: 'card_play' }
    const conversation = newest(
      chats,
      (chat) => chat.conversation !== undefined && 'cardId' in chat.conversation && chat.conversation.cardId === target.cardId
    )
    return conversation === null ? null : { chatId: conversation.id, via: 'conversation' }
  }

  if (target.ticketId !== undefined) {
    const attemptId = await deps.reads.openAttemptId(folder, target.ticketId)
    if (attemptId !== null) {
      const chatId = listedChat(chats, await deps.boundTerminal(folder, { attemptId }))
      if (chatId !== null) return { chatId, via: 'attempt' }
    }
  }

  const runId = await deps.reads.activeRunId(folder, target.epicId)
  if (runId !== null) {
    const chatId = listedChat(chats, await deps.boundTerminal(folder, { runId }))
    if (chatId !== null) return { chatId, via: 'run' }
  }
  const conversation = newest(
    chats,
    (chat) => chat.conversation !== undefined && 'epicId' in chat.conversation && chat.conversation.epicId === target.epicId
  )
  return conversation === null ? null : { chatId: conversation.id, via: 'conversation' }
}
