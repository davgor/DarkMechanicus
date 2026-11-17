import { describe, expect, it, vi } from 'vitest'
import type { ChatRecord } from '../../shared/agents/chat'
import type { BoundTarget } from './boundThreads'
import { resolveConversationChat } from './conversationTarget'

const REPO = '/work/repo'

function chat(id: string, createdAt: string, binding: Partial<Pick<ChatRecord, 'cardId' | 'conversation'>> = {}): ChatRecord {
  return {
    id,
    folder: REPO,
    agent: 'claude',
    model: 'opus',
    role: 'orchestrator',
    allowSave: false,
    title: id,
    createdAt,
    updatedAt: createdAt,
    sessionId: null,
    ...binding
  }
}

function deps(
  options: {
    chats?: ChatRecord[]
    attemptId?: string | null
    runId?: string | null
    bindings?: Record<string, string | null>
  } = {}
) {
  const boundTerminal = vi.fn(async (_folder: string, target: BoundTarget) => {
    const id = 'attemptId' in target ? target.attemptId : target.runId
    return options.bindings?.[id] ?? null
  })
  return {
    reads: {
      openAttemptId: vi.fn(async () => options.attemptId ?? null),
      activeRunId: vi.fn(async () => options.runId ?? null)
    },
    store: { listChats: vi.fn(() => options.chats ?? []) },
    boundTerminal
  }
}

describe('resolveConversationChat for epic conversations', () => {
  it('uses an open ticket attempt before its epic run', async () => {
    const subject = deps({
      chats: [chat('attempt-chat', '2026-01-01'), chat('run-chat', '2026-01-02')],
      attemptId: 'at_1',
      runId: 'rn_1',
      bindings: { at_1: 'attempt-chat', rn_1: 'run-chat' }
    })

    await expect(resolveConversationChat(subject, REPO, { epicId: 'ep_1', ticketId: 'tk_1' })).resolves.toEqual({ chatId: 'attempt-chat', via: 'attempt' })
    expect(subject.boundTerminal).toHaveBeenCalledTimes(1)
    expect(subject.boundTerminal).toHaveBeenCalledWith(REPO, { attemptId: 'at_1' })
  })

  it('falls through from a ticket without an open attempt to the active epic run', async () => {
    const subject = deps({ chats: [chat('run-chat', '2026-01-01')], runId: 'rn_1', bindings: { rn_1: 'run-chat' } })

    await expect(resolveConversationChat(subject, REPO, { epicId: 'ep_1', ticketId: 'tk_1' })).resolves.toEqual({ chatId: 'run-chat', via: 'run' })
  })

  it('uses an active run chat before a newer epic conversation chat', async () => {
    const subject = deps({
      chats: [chat('conversation-chat', '2026-01-03', { conversation: { epicId: 'ep_1' } }), chat('run-chat', '2026-01-01')],
      runId: 'rn_1',
      bindings: { rn_1: 'run-chat' }
    })

    await expect(resolveConversationChat(subject, REPO, { epicId: 'ep_1' })).resolves.toEqual({ chatId: 'run-chat', via: 'run' })
  })

  it('uses the newest epic conversation chat when there is no bound active run', async () => {
    const subject = deps({
      chats: [
        chat('older', '2026-01-01', { conversation: { epicId: 'ep_1' } }),
        chat('other', '2026-01-04', { conversation: { epicId: 'ep_other' } }),
        chat('newer', '2026-01-03', { conversation: { epicId: 'ep_1' } })
      ]
    })

    await expect(resolveConversationChat(subject, REPO, { epicId: 'ep_1' })).resolves.toEqual({ chatId: 'newer', via: 'conversation' })
  })
})

describe('resolveConversationChat for cards and deleted chats', () => {

  it('uses the newest Play chat before a newer card conversation chat', async () => {
    const subject = deps({
      chats: [
        chat('older-play', '2026-01-01', { cardId: 'card_1' }),
        chat('conversation-chat', '2026-01-04', { conversation: { cardId: 'card_1' } }),
        chat('newer-play', '2026-01-03', { cardId: 'card_1' })
      ]
    })

    await expect(resolveConversationChat(subject, REPO, { cardId: 'card_1' })).resolves.toEqual({ chatId: 'newer-play', via: 'card_play' })
  })

  it('uses the newest card conversation when there is no Play chat', async () => {
    const subject = deps({
      chats: [
        chat('older', '2026-01-01', { conversation: { cardId: 'card_1' } }),
        chat('newer', '2026-01-03', { conversation: { cardId: 'card_1' } })
      ]
    })

    await expect(resolveConversationChat(subject, REPO, { cardId: 'card_1' })).resolves.toEqual({ chatId: 'newer', via: 'conversation' })
  })

  it('returns null when a bound chat was deleted and no listed fallback remains', async () => {
    const subject = deps({ attemptId: 'at_1', runId: 'rn_1', bindings: { at_1: 'deleted-attempt-chat', rn_1: 'deleted-run-chat' } })

    await expect(resolveConversationChat(subject, REPO, { epicId: 'ep_1', ticketId: 'tk_1' })).resolves.toBeNull()
    expect(subject.boundTerminal).toHaveBeenCalledTimes(2)
  })
})
