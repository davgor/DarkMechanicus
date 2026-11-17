import { describe, expect, it } from 'vitest'
import type { ConversationStateResult } from '../../../shared/agents/chatApi'
import type { CommentView, SessionRole } from '../../../shared/domain/views'
import { agentLine, conversationItems } from './conversationView'

function message(id: string, role: SessionRole, createdAt: string, label = `${role}-agent`): CommentView {
  return { id, epicId: 'ep_1', ticketId: 'tk_1', body: `Body ${id}`, author: { role, label }, createdAt }
}

function state(patch: Partial<ConversationStateResult> = {}): ConversationStateResult {
  return {
    chat: { id: 'chat_1', title: 'DM-696 worker', via: 'attempt' },
    deliveries: {},
    ...patch
  }
}

describe('conversationItems authors', () => {
  it('sorts oldest first and maps desktop to You and agent roles to their authors', () => {
    const items = conversationItems(
      [
        message('review', 'reviewer', '2026-01-05T00:00:00.000Z'),
        message('desktop', 'desktop', '2026-01-01T00:00:00.000Z', 'Desktop'),
        message('planner', 'planner', '2026-01-02T00:00:00.000Z'),
        message('orchestrator', 'orchestrator', '2026-01-03T00:00:00.000Z'),
        message('worker', 'worker', '2026-01-04T00:00:00.000Z'),
        message('reader', 'reader', '2026-01-06T00:00:00.000Z', 'Audit bot')
      ],
      state()
    )
    expect(items.map(({ id, author, mine }) => ({ id, author, mine }))).toEqual([
      { id: 'desktop', author: 'You', mine: true },
      { id: 'planner', author: 'Planner', mine: false },
      { id: 'orchestrator', author: 'Orchestrator', mine: false },
      { id: 'worker', author: 'Worker', mine: false },
      { id: 'review', author: 'Reviewer', mine: false },
      { id: 'reader', author: 'Audit bot', mine: false }
    ])
  })
})

describe('conversationItems delivery labels', () => {
  const mine = message('mine', 'desktop', '2026-01-01T00:00:00.000Z')

  it.each([
    ['delivered', state({ deliveries: { mine: { chatId: 'chat_1', state: 'delivered', problem: null, chatExists: true } } }), 'Delivered to DM-696 worker'],
    ['failed', state({ deliveries: { mine: { chatId: 'chat_1', state: 'failed', problem: 'Terminal stopped.', chatExists: true } } }), 'Not delivered: Terminal stopped.'],
    ['opened', state({ deliveries: { mine: { chatId: 'chat_1', state: 'opened', problem: null, chatExists: true } } }), 'Opened a new chat'],
    ['deleted', state({ deliveries: { mine: { chatId: 'chat_1', state: 'delivered', problem: null, chatExists: false } } }), 'Chat deleted'],
    ['unknown', state(), 'Delivery unknown']
  ])('labels a %s delivery', (_case, deliveryState, expected) => {
    expect(conversationItems([mine], deliveryState)[0]?.delivery).toBe(expected)
  })

  it('does not show delivery state on an agent message', () => {
    expect(conversationItems([message('agent', 'worker', mine.createdAt)], state())[0]?.delivery).toBeUndefined()
  })
})

describe('agentLine', () => {
  it.each([
    ['attempt', "Talking to Agent (holds this ticket's claim)"],
    ['run', 'Talking to Agent (runs this epic)'],
    ['card_play', "Talking to Agent (the card's Play chat)"],
    ['conversation', 'Talking to Agent (conversation chat)']
  ] as const)('explains the %s destination', (via, expected) => {
    expect(agentLine({ chat: { id: 'chat_1', title: 'Agent', via } })).toBe(expected)
  })

  it('explains that sending without an agent opens an orchestrator', () => {
    expect(agentLine({ chat: null })).toBe('No agent is active: sending opens a new orchestrator chat')
  })
})
