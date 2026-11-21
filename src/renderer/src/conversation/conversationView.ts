import type { ConversationStateResult } from '../../../shared/agents/chatApi'
import type { KanbanMessageView } from '../../../shared/domain/kanban'
import type { AttachmentRef, CommentView, SessionRole } from '../../../shared/domain/views'

/** The command layer's limit on one conversation message's Markdown (characters). */
export const MAX_COMMENT_LENGTH = 20_000

export type ConversationMessage = CommentView | KanbanMessageView

interface ConversationItem {
  id: string
  author: string
  mine: boolean
  body: string
  at: string
  delivery?: string
  attachments?: AttachmentRef[]
}

const ROLE_AUTHORS: Partial<Record<SessionRole, string>> = {
  desktop: 'You',
  planner: 'Planner',
  orchestrator: 'Orchestrator',
  worker: 'Worker',
  reviewer: 'Reviewer'
}

function messageAuthor(message: ConversationMessage): { role: SessionRole; label: string } {
  return 'author' in message ? message.author : { role: message.authorRole, label: message.authorLabel }
}

function deliveryLabel(messageId: string, state: ConversationStateResult): string {
  const delivery = state.deliveries[messageId]
  if (delivery === undefined) return 'Delivery unknown'
  if (delivery.state === 'failed') return delivery.problem === null ? 'Delivery unknown' : `Not delivered: ${delivery.problem}`
  if (delivery.chatId !== null && !delivery.chatExists) return 'Chat deleted'
  if (delivery.state === 'pending') return delivery.problem === null ? 'Pending automatic delivery' : `Pending delivery: ${delivery.problem}`
  if (delivery.state === 'opened') return 'Opened a new chat'
  if (state.chat !== null && state.chat.id === delivery.chatId) return `Delivered to ${state.chat.title}`
  return 'Delivery unknown'
}

/** Maps durable board messages to the oldest-first presentation used by every conversation surface. */
export function conversationItems(messages: readonly ConversationMessage[], state: ConversationStateResult): ConversationItem[] {
  return [...messages]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((message) => {
      const author = messageAuthor(message)
      const mine = author.role === 'desktop'
      return {
        id: message.id,
        author: ROLE_AUTHORS[author.role] ?? author.label,
        mine,
        body: message.body,
        at: message.createdAt,
        ...(mine ? { delivery: deliveryLabel(message.id, state) } : {}),
        ...(message.attachments === undefined ? {} : { attachments: message.attachments })
      }
    })
}

/** Describes the agent chat currently receiving messages for a board conversation. */
export function agentLine(state: Pick<ConversationStateResult, 'chat'>): string {
  const chat = state.chat
  if (chat === null) return 'No agent is active: sending opens a new orchestrator chat'
  const destination = {
    attempt: "holds this ticket's claim",
    run: 'runs this epic',
    card_play: "the card's Play chat",
    conversation: 'conversation chat'
  }[chat.via]
  return `Talking to ${chat.title} (${destination})`
}

/** Send needs non-blank text within the command limit and no work in flight. */
export function canSubmitComment(draft: string, busy: boolean): boolean {
  return !busy && draft.trim() !== '' && draft.length <= MAX_COMMENT_LENGTH
}
