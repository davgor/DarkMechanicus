import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import { kickBackKanbanCard as coreKickBack, claimKanbanCard, playKanbanCard, submitKanbanCard } from '../../core/services/kanban/attempts'
import { createKanbanCard, getKanbanCard } from '../../core/services/kanban/cards'
import type { ChatRecord } from '../../shared/agents/chat'
import type { KanbanPacket } from '../../shared/domain/kanban'
import { createTestCtx, withRole, type TestCtx } from '../../test/testContext'
import { connectedAgents, fakeAdapters, memoryChatStore, REPO, trackedFolders, type FakeAdapters } from '../agents/__mocks__/fakeChatAdapter'
import type { ChatStore } from '../agents/chatStore'
import { kanbanKickoff } from '../agents/kanbanKickoff'
import { createSessionManager, type SessionManager } from '../agents/sessionManager'
import { kickBackKanbanCard, startKanbanCard, type KanbanCards } from './startKanbanCard'

interface Rig {
  desktop: TestCtx
  orchestrator: TestCtx
  store: ChatStore
  fakes: FakeAdapters
  manager: SessionManager
  cards: KanbanCards
  /** What the cards side was asked for, as "<call> <folder> <card id>". */
  calls: string[]
  errors: unknown[]
}

/** The real Kanban core over one test database, the real session manager over fake adapters. */
function rig(): Rig {
  const desktop = createTestCtx({ role: 'desktop', checkout: { branch: 'feature/cards', commit: null } })
  const store = memoryChatStore()
  const fakes = fakeAdapters()
  const errors: unknown[] = []
  const calls: string[] = []
  const manager = createSessionManager({
    store,
    adapters: fakes.definitions,
    agentFor: connectedAgents(),
    folders: trackedFolders(),
    issueChatCli: async (folder: string) => ({
      cli: { command: 'node', args: ['/app/out/main/cli.js', '--repo', folder], env: { DM_SESSION_TOKEN: 'dmg_test' } },
      grantId: 'gr_00000000000000000000000001'
    }),
    revokeChatGrant: async () => undefined,
    push: () => {}
  })
  const cards: KanbanCards = {
    play: async (folder, cardId) => (calls.push(`play ${folder} ${cardId}`), playKanbanCard(desktop, { cardId })),
    kickBack: async (folder, input) => (calls.push(`kickBack ${folder} ${input.cardId}`), coreKickBack(desktop, input)),
    branch: async (folder) => (calls.push(`branch ${folder}`), desktop.checkout().branch)
  }
  return { desktop, orchestrator: withRole(desktop, 'orchestrator'), store, fakes, manager, cards, calls, errors }
}

function newCard(state: Rig, title = 'Fix the flaky upload test'): { id: string; key: string } {
  return createKanbanCard(state.desktop, { title, acceptanceCriteria: ['It passes 50 runs in a row'] })
}

/** A card an agent played, claimed and submitted: it waits in Ready for review. */
function cardInReview(state: Rig): { id: string; key: string } {
  const card = newCard(state)
  playKanbanCard(state.desktop, { cardId: card.id })
  const packet: KanbanPacket = claimKanbanCard(state.orchestrator, { cardId: card.id })
  submitKanbanCard(withRole(state.desktop, 'worker'), { attemptId: packet.attemptId, claimToken: packet.claimToken ?? '', outputs: { summary: 'Fixed' } })
  return card
}

function firstMessage(state: Rig, chat: ChatRecord | null): string {
  const first = state.store.readTranscript({ folder: REPO, id: chat?.id ?? '' })?.items[0]
  return first?.kind === 'user_message' ? first.text : ''
}

describe('start a Kanban card from the desktop', () => {
  it('marks the play, then creates an orchestrator chat bound to the card and sends the kickoff first', async () => {
    const state = rig()
    const card = newCard(state)

    const result = await startKanbanCard({ cards: state.cards, sessions: state.manager }, { folder: REPO, cardId: card.id, agent: 'claude', model: 'big' })

    expect(state.calls).toEqual([`play ${REPO} ${card.id}`, `branch ${REPO}`])
    expect(result.problem).toBeNull()
    expect(result.card).toMatchObject({ id: card.id, playPending: true, lane: 'backlog' })
    expect(result.chat).toMatchObject({
      folder: REPO,
      agent: 'claude',
      model: 'big',
      role: 'orchestrator',
      allowSave: false,
      cardId: card.id,
      title: `Kanban · ${card.key} Fix the flaky upload test`
    })
    expect(result.chat).not.toHaveProperty('runId')
    expect(state.store.listChats(REPO).map((chat) => chat.id)).toEqual([result.chat?.id])

    const kickoff = kanbanKickoff({ cardId: card.id, key: card.key, title: 'Fix the flaky upload test', branch: 'feature/cards' })
    expect(firstMessage(state, result.chat)).toBe(kickoff)
    expect(state.fakes.of('claude')[0]?.sent).toEqual([kickoff])
    expect(state.fakes.of('claude')[0]?.started[0]).toMatchObject({ role: 'orchestrator', allowSave: false })
  })

  it('sends a kickoff that names the Kanban tools and holds no claim token', async () => {
    const state = rig()
    const card = newCard(state)

    const result = await startKanbanCard({ cards: state.cards, sessions: state.manager }, { folder: REPO, cardId: card.id, agent: 'claude' })

    const text = firstMessage(state, result.chat)
    for (const tool of ['claim_kanban_card', 'heartbeat_kanban_card', 'submit_kanban_card']) {
      expect(text).toContain(tool)
    }
    expect(text).not.toMatch(/\bka_[0-9a-hjkmnp-tv-z]{26}\.[A-Za-z0-9_-]+/)
    expect(result.chat?.model).toBeNull()
  })

  it('creates nothing when the card cannot be played', async () => {
    const state = rig()
    const card = cardInReview(state)

    await expect(startKanbanCard({ cards: state.cards, sessions: state.manager }, { folder: REPO, cardId: card.id, agent: 'claude' })).rejects.toMatchObject({
      code: 'invalid_state'
    })

    expect(state.store.listChats(REPO)).toEqual([])
    expect(state.fakes.created).toEqual([])
  })
})

describe('start a Kanban card: a branch that cannot be read', () => {
  it('still starts the agent when the branch cannot be read, saying so in the kickoff and reporting the failure', async () => {
    const state = rig()
    const card = newCard(state)
    const cards: KanbanCards = { ...state.cards, branch: () => Promise.reject(new Error('git is not installed')) }

    const result = await startKanbanCard({ cards, sessions: state.manager, onError: (error) => state.errors.push(error) }, { folder: REPO, cardId: card.id, agent: 'claude' })

    expect(result.problem).toBeNull()
    expect(firstMessage(state, result.chat)).toContain('Branch: the checked-out branch could not be read')
    expect(state.errors.map((error) => (error as Error).message)).toEqual(['git is not installed'])
  })
})

describe('start a Kanban card: an agent that cannot start', () => {
  it('deletes the chat, says why, and leaves the card ready to be played again', async () => {
    const state = rig()
    const card = newCard(state)
    state.fakes.prepare = (adapter) => {
      adapter.startError = new Error('claude exited with code 1')
    }

    const failed = await startKanbanCard({ cards: state.cards, sessions: state.manager }, { folder: REPO, cardId: card.id, agent: 'claude' })

    expect(failed.chat).toBeNull()
    expect(failed.problem).toContain('Claude Code could not be started')
    expect(failed.problem).toContain('claude exited with code 1')
    expect(state.store.listChats(REPO)).toEqual([])
    expect(state.fakes.of('claude')[0]?.disposals).toBe(1)
    expect(getKanbanCard(state.desktop, { cardId: card.id })).toMatchObject({ playPending: true, openAttempt: null })

    state.fakes.prepare = () => {}
    const again = await startKanbanCard({ cards: state.cards, sessions: state.manager }, { folder: REPO, cardId: card.id, agent: 'claude' })

    expect(again.problem).toBeNull()
    expect(state.store.listChats(REPO).map((chat) => [chat.id, chat.cardId])).toEqual([[again.chat?.id, card.id]])
  })

  it('keeps the chat, and says why, when it cannot be removed either', async () => {
    const state = rig()
    const card = newCard(state)
    state.fakes.prepare = (adapter) => {
      adapter.startError = new Error('claude exited with code 1')
    }
    const stuck: SessionManager = { ...state.manager, deleteChat: () => Promise.reject(new Error('disk is read-only')) }

    const result = await startKanbanCard(
      { cards: state.cards, sessions: stuck, onError: (error) => state.errors.push(error) },
      { folder: REPO, cardId: card.id, agent: 'claude' }
    )

    expect(result.chat).toMatchObject({ cardId: card.id })
    expect(result.problem).toContain('claude exited with code 1')
    expect(state.errors.map((error) => (error as Error).message)).toEqual(['claude exited with code 1', 'disk is read-only'])
  })
})

describe('start a Kanban card: a chat that cannot be created or sent to', () => {
  it('reports a refusal that is not an Error by its text, keeping the play pending', async () => {
    const state = rig()
    const card = newCard(state)
    const refusing: SessionManager = {
      ...state.manager,
      createChat: () => {
        throw 'the chat store is locked.'
      }
    }

    const result = await startKanbanCard(
      { cards: state.cards, sessions: refusing, onError: (error) => state.errors.push(error) },
      { folder: REPO, cardId: card.id, agent: 'claude' }
    )

    expect(result.chat).toBeNull()
    expect(result.problem).toBe(
      `${card.key} is played, but its chat could not be created: the chat store is locked. The card keeps its pending play: press Play again to start a new chat.`
    )
    expect(state.errors).toEqual(['the chat store is locked.'])
    expect(getKanbanCard(state.desktop, { cardId: card.id })).toMatchObject({ playPending: true, openAttempt: null })
  })

  it('says why when the send is refused with a DomainError, without reporting it as unexpected', async () => {
    const state = rig()
    const card = newCard(state)
    const refusing: SessionManager = { ...state.manager, send: () => Promise.reject(new DomainError('invalid_state', 'The chat is busy.')) }

    const result = await startKanbanCard(
      { cards: state.cards, sessions: refusing, onError: (error) => state.errors.push(error) },
      { folder: REPO, cardId: card.id, agent: 'claude' }
    )

    expect(result.chat).toBeNull()
    expect(result.problem).toBe(
      `${card.key} is played, but Claude Code could not be started: The chat is busy. The card keeps its pending play: press Play again to start a new chat.`
    )
    expect(state.errors).toEqual([])
    expect(state.store.listChats(REPO)).toEqual([])
  })
})

describe('kick back a Kanban card', () => {
  it("returns the card to In progress and sends the comment to the card's newest chat", async () => {
    const state = rig()
    const card = cardInReview(state)
    const other = newCard(state, 'Another card')
    const base = { folder: REPO, agent: 'claude', model: null, role: 'orchestrator', allowSave: false } as const
    const older = state.manager.createChat({ ...base, cardId: card.id, title: 'older' })
    const newer = state.manager.createChat({ ...base, cardId: card.id, title: 'newer' })
    state.manager.createChat({ ...base, cardId: other.id, title: 'other card' })
    state.manager.createChat({ ...base, title: 'no card' })
    // The older chat was active last; the comment still goes to the chat the latest Play started.
    state.manager.renameChat(older, 'older, renamed')
    expect(state.manager.listChats(REPO)[0]?.id).toBe(older.id)

    const result = await kickBackKanbanCard({ cards: state.cards, sessions: state.manager }, { folder: REPO, cardId: card.id, comment: 'The test still flakes on Windows.' })

    expect(result).toMatchObject({ chatId: newer.id, problem: null })
    expect(result.card).toMatchObject({ id: card.id, lane: 'in_progress', playPending: true, kickBackCount: 1 })
    const message = `${card.key} was kicked back by a person: The test still flakes on Windows. Claim it again with claim_kanban_card and address the comment.`
    expect(state.fakes.created.map((adapter) => adapter.sent)).toEqual([[message]])
    const stored = state.store.readTranscript({ folder: REPO, id: newer.id })?.items ?? []
    expect(stored.map((item) => (item.kind === 'user_message' ? item.text : item.kind))).toEqual([message])
  })

  it('returns chatId null when the card has no chat, and still records the kick-back', async () => {
    const state = rig()
    const card = cardInReview(state)
    const other = newCard(state, 'Another card')
    state.manager.createChat({ folder: REPO, agent: 'claude', model: null, role: 'orchestrator', allowSave: false, cardId: other.id })

    const result = await kickBackKanbanCard({ cards: state.cards, sessions: state.manager }, { folder: REPO, cardId: card.id, comment: 'Not yet.' })

    expect(result).toMatchObject({ chatId: null, problem: null })
    expect(result.card.lane).toBe('in_progress')
    expect(state.fakes.created).toEqual([])
  })

  it("keeps the comment's own punctuation, folding only one closing period into the sentence", async () => {
    const state = rig()
    const card = cardInReview(state)
    state.manager.createChat({ folder: REPO, agent: 'claude', model: null, role: 'orchestrator', allowSave: false, cardId: card.id })

    await kickBackKanbanCard({ cards: state.cards, sessions: state.manager }, { folder: REPO, cardId: card.id, comment: '  Check the logs, the docs...\n' })

    expect(state.fakes.created[0]?.sent).toEqual([`${card.key} was kicked back by a person: Check the logs, the docs... Claim it again with claim_kanban_card and address the comment.`])
  })
})

describe('kick back a Kanban card: the newest of several chats', () => {
  it('sends the comment to the newest chat of the card even when it is listed first', async () => {
    const state = rig()
    const card = cardInReview(state)
    const base = { folder: REPO, agent: 'claude', model: null, role: 'orchestrator', allowSave: false, cardId: card.id } as const
    const older = state.manager.createChat({ ...base, title: 'older' })
    const newer = state.manager.createChat({ ...base, title: 'newer' })
    state.manager.renameChat(newer, 'newer, renamed')
    expect(state.manager.listChats(REPO).map((chat) => chat.id)).toEqual([newer.id, older.id])

    const result = await kickBackKanbanCard({ cards: state.cards, sessions: state.manager }, { folder: REPO, cardId: card.id, comment: 'Not yet.' })

    expect(result).toMatchObject({ chatId: newer.id, problem: null })
    expect(state.store.readTranscript({ folder: REPO, id: older.id })?.items ?? []).toEqual([])
    expect(firstMessage(state, newer)).toBe(`${card.key} was kicked back by a person: Not yet. Claim it again with claim_kanban_card and address the comment.`)
  })
})

describe('kick back a Kanban card: failures and refusals', () => {
  it('records the kick-back and names the chat with the reason when the comment cannot reach its agent', async () => {
    const state = rig()
    const card = cardInReview(state)
    const chat = state.manager.createChat({ folder: REPO, agent: 'claude', model: null, role: 'orchestrator', allowSave: false, cardId: card.id })
    state.fakes.prepare = (adapter) => {
      adapter.startError = new Error('claude exited with code 1')
    }

    const result = await kickBackKanbanCard({ cards: state.cards, sessions: state.manager }, { folder: REPO, cardId: card.id, comment: 'Not yet.' })

    expect(result.chatId).toBe(chat.id)
    expect(result.problem).toContain('claude exited with code 1')
    expect(result.problem).toMatch(/Play/)
    expect(getKanbanCard(state.desktop, { cardId: card.id })).toMatchObject({ lane: 'in_progress', playPending: true })
  })

  it('sends nothing when the core refuses the kick-back', async () => {
    const state = rig()
    const card = newCard(state)
    state.manager.createChat({ folder: REPO, agent: 'claude', model: null, role: 'orchestrator', allowSave: false, cardId: card.id })

    await expect(kickBackKanbanCard({ cards: state.cards, sessions: state.manager }, { folder: REPO, cardId: card.id, comment: 'Not yet.' })).rejects.toMatchObject({
      code: 'invalid_state'
    })
    expect(state.fakes.created).toEqual([])
  })

  it('masks a claim token pasted into the comment before it reaches the chat', async () => {
    const state = rig()
    const card = cardInReview(state)
    state.manager.createChat({ folder: REPO, agent: 'claude', model: null, role: 'orchestrator', allowSave: false, cardId: card.id })
    const leaked = 'ka_01m6aspj4vxjq38vcbgxpg73jn.gUJvQxJEDk0emfDt1HQ9H3tYGOmsf4IX'

    await kickBackKanbanCard({ cards: state.cards, sessions: state.manager }, { folder: REPO, cardId: card.id, comment: `Use ${leaked} next time` })

    const sent = state.fakes.created[0]?.sent[0] ?? ''
    expect(sent).toContain('[claim token masked]')
    expect(sent).not.toContain('gUJvQxJEDk0emfDt1HQ9H3tYGOmsf4IX')
  })
})
