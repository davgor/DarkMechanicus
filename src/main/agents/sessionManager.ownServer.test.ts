import { describe, expect, it } from 'vitest'
import type { ApprovalDecision, ChatItem, ChatRecord } from '../../shared/agents/chat'
import type { BuiltInAgentKind } from '../../shared/desktop/api'
import { AT, connectedAgents, fakeAdapters, memoryChatStore, REPO, trackedFolders, type FakeAdapters } from './__mocks__/fakeChatAdapter'
import type { ChatStore } from './chatStore'
import { createSessionManager, type SessionManager } from './sessionManager'

/** The vendors whose tool names are recorded here; Autonomous's way of naming another server's tool was not recorded. */
const AGENTS = ['claude', 'codex', 'cursor'] as const

/** How each vendor names a tool of the chat's own server, a tool of another server, and a tool that only looks like ours. */
const NAMES = {
  claude: { own: ['mcp__darkmechanicus__claim_ticket', 'mcp__darkmechanicus__get_ticket'], other: 'mcp__other__claim_ticket', lookalike: 'mcp__darkmechanicus_evil__claim_ticket' },
  codex: { own: ['mcp:darkmechanicus', 'mcp:darkmechanicus'], other: 'mcp:other', lookalike: 'mcp:darkmechanicus_evil' },
  cursor: { own: ['darkmechanicus:claim_ticket', 'darkmechanicus:get_ticket'], other: 'other:claim_ticket', lookalike: 'darkmechanicus_evil:claim_ticket' }
} as const satisfies Record<(typeof AGENTS)[number], { own: readonly string[]; other: string; lookalike: string }>

interface Rig {
  manager: SessionManager
  store: ChatStore
  fakes: FakeAdapters
}

function rig(): Rig {
  const store = memoryChatStore()
  const fakes = fakeAdapters()
  let itemCount = 0
  const manager = createSessionManager({
    store,
    adapters: fakes.definitions,
    agentFor: connectedAgents(),
    folders: trackedFolders(),
    issueChatCli: async (folder: string) => ({
      cli: {
        command: 'node',
        args: ['/app/out/main/cli.js', '--repo', folder],
        env: { DM_SESSION_TOKEN: 'dmg_test' }
      },
      grantId: 'gr_00000000000000000000000001'
    }),
    revokeChatGrant: async () => undefined,
    push: () => {},
    newId: () => `item_o${(itemCount += 1)}`,
    now: () => AT,
    idleMs: 600_000,
    timers: { set: () => 0, clear: () => {} },
    onError: (error) => {
      throw error
    }
  })
  return { manager, store, fakes }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function newChat(manager: SessionManager, agent: BuiltInAgentKind, title = 'Run the epic'): ChatRecord {
  return manager.createChat({ folder: REPO, agent, role: 'orchestrator', title })
}

function storedItems(store: ChatStore, chat: ChatRecord): ChatItem[] {
  return store.readTranscript(chat)?.items ?? []
}

/** One request each turn step asks for: its id, its tool, and its category (`other` unless said). */
interface Ask {
  id: string
  tool: string
  category?: 'other' | 'command' | 'file_edit'
}

/** A chat whose turn raises every request at once, as an agent that calls several tools in parallel does; answers by request id. */
async function askingChat(state: Rig, agent: BuiltInAgentKind, asks: Ask[], title?: string): Promise<{ chat: ChatRecord; answers: Record<string, ApprovalDecision> }> {
  const answers: Record<string, ApprovalDecision> = {}
  state.fakes.prepare = (adapter) => {
    adapter.turn = (self) => {
      const asked = asks.map(async (ask) => {
        answers[ask.id] = await self.ask(ask.id, ask.category ?? 'other', ask.tool)
      })
      return Promise.all(asked).then(() => undefined)
    }
  }
  const chat = newChat(state.manager, agent, title)
  await state.manager.send(chat, 'go')
  await settle()
  return { chat, answers }
}

/** A chat whose turn asks one request, waits for the answer, and then raises the rest at once. */
async function followUpChat(state: Rig, agent: BuiltInAgentKind, first: Ask, rest: Ask[]): Promise<{ chat: ChatRecord; answers: Record<string, ApprovalDecision> }> {
  const answers: Record<string, ApprovalDecision> = {}
  state.fakes.prepare = (adapter) => {
    adapter.turn = async (self) => {
      answers[first.id] = await self.ask(first.id, first.category ?? 'other', first.tool)
      const asked = rest.map(async (ask) => {
        answers[ask.id] = await self.ask(ask.id, ask.category ?? 'other', ask.tool)
      })
      await Promise.all(asked)
    }
  }
  const chat = newChat(state.manager, agent)
  await state.manager.send(chat, 'go')
  await settle()
  return { chat, answers }
}

function pendingIds(state: Rig, chat: ChatRecord): Promise<string[]> {
  return state.manager.openChat(chat).then((opened) => opened.pending.map((request) => request.requestId))
}

function autoDecisionIds(state: Rig, chat: ChatRecord): string[] {
  return storedItems(state.store, chat).flatMap((item) => (item.kind === 'approval_decision' && item.automatic === true ? [item.requestId] : []))
}

describe.each(AGENTS)('Allow for this chat on a tool of the chat’s own server (%s)', (agent) => {
  const { own, other, lookalike } = NAMES[agent]
  const [first, second] = own

  it('asks about the first call, which nothing has allowed yet', async () => {
    const state = rig()
    const { chat, answers } = await askingChat(state, agent, [{ id: 'q1', tool: first }])

    expect(answers).toEqual({})
    expect(await pendingIds(state, chat)).toEqual(['q1'])
    expect(autoDecisionIds(state, chat)).toEqual([])
  })

  it('runs the server’s other tools without a card afterwards, and still asks about another server', async () => {
    const state = rig()
    const { chat, answers } = await followUpChat(
      state,
      agent,
      { id: 'q1', tool: first },
      [
        { id: 'q2', tool: second },
        { id: 'q3', tool: other },
        { id: 'q4', tool: lookalike }
      ]
    )

    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'allow_chat' })
    await settle()

    expect(answers).toMatchObject({ q1: 'allow_chat', q2: 'allow_chat' })
    expect(answers.q3).toBeUndefined()
    expect(answers.q4).toBeUndefined()
    expect(autoDecisionIds(state, chat)).toEqual(['q2'])
    expect(await pendingIds(state, chat)).toEqual(['q3', 'q4'])
  })

  it('answers the calls already waiting for other tools of the server, and leaves the rest waiting', async () => {
    const state = rig()
    const { chat, answers } = await askingChat(state, agent, [
      { id: 'q1', tool: first },
      { id: 'q2', tool: second },
      { id: 'q3', tool: other },
      { id: 'q4', tool: 'Bash', category: 'command' }
    ])

    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'allow_chat' })
    await settle()

    expect(answers).toEqual({ q1: 'allow_chat', q2: 'allow_chat' })
    expect(autoDecisionIds(state, chat)).toEqual(['q2'])
    expect(await pendingIds(state, chat)).toEqual(['q3', 'q4'])
  })
})

describe.each(AGENTS)('Allow for this chat on a tool of the chat’s own server keeps the old rules where they apply (%s)', (agent) => {
  const { own, other, lookalike } = NAMES[agent]
  const [first, second] = own

  it('does not cover anything without the person’s click: Allow once and Deny leave the next call asking', async () => {
    const state = rig()
    const { chat, answers } = await followUpChat(state, agent, { id: 'q1', tool: first }, [{ id: 'q2', tool: second }])

    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'allow_once' })
    await settle()

    expect(answers).toEqual({ q1: 'allow_once' })
    expect(await pendingIds(state, chat)).toEqual(['q2'])
    state.manager.answerApproval(chat, { requestId: 'q2', decision: 'deny' })
    await settle()
    expect(answers).toEqual({ q1: 'allow_once', q2: 'deny' })
  })

  it('keeps the old rule for another server: its allowance covers that tool and no other, and no Dark Mechanicus tool', async () => {
    const state = rig()
    const { chat, answers } = await followUpChat(
      state,
      agent,
      { id: 'q1', tool: other },
      [
        { id: 'q2', tool: other },
        { id: 'q3', tool: first },
        { id: 'q4', tool: lookalike }
      ]
    )

    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'allow_chat' })
    await settle()

    expect(answers).toEqual({ q1: 'allow_chat', q2: 'allow_chat' })
    expect(await pendingIds(state, chat)).toEqual(['q3', 'q4'])
  })

  it('keeps the old rule for a command and a file edit, even one that carries a Dark Mechanicus name', async () => {
    const state = rig()
    const { chat, answers } = await followUpChat(
      state,
      agent,
      { id: 'q1', tool: first },
      [
        { id: 'q2', tool: first, category: 'command' },
        { id: 'q3', tool: first, category: 'file_edit' }
      ]
    )

    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'allow_chat' })
    await settle()

    expect(answers).toEqual({ q1: 'allow_chat' })
    expect(await pendingIds(state, chat)).toEqual(['q2', 'q3'])
  })
})

describe.each(AGENTS)('A request for a tool of the chat’s own server, and a new chat (%s)', (agent) => {
  const { own, other, lookalike } = NAMES[agent]
  const [first, second] = own

  it('marks a request for a tool of the chat’s own server, and no other, so its card can say what Allow for this chat covers', async () => {
    const state = rig()
    const { chat } = await askingChat(state, agent, [
      { id: 'q1', tool: first },
      { id: 'q2', tool: other },
      { id: 'q3', tool: lookalike },
      { id: 'q4', tool: first, category: 'command' }
    ])

    const requests = storedItems(state.store, chat).flatMap((item) => (item.kind === 'approval_request' ? [item] : []))
    expect(requests.map((request) => [request.requestId, request.ownServer])).toEqual([
      ['q1', true],
      ['q2', undefined],
      ['q3', undefined],
      ['q4', undefined]
    ])
  })

  it('starts a new chat with nothing allowed, whatever another chat was allowed', async () => {
    const state = rig()
    const earlier = await followUpChat(state, agent, { id: 'q1', tool: first }, [{ id: 'q2', tool: second }])
    state.manager.answerApproval(earlier.chat, { requestId: 'q1', decision: 'allow_chat' })
    await settle()
    expect(earlier.answers).toEqual({ q1: 'allow_chat', q2: 'allow_chat' })

    const later = await askingChat(state, agent, [{ id: 'q1', tool: first }], 'A new chat')

    expect(later.answers).toEqual({})
    expect(await pendingIds(state, later.chat)).toEqual(['q1'])
    expect(autoDecisionIds(state, later.chat)).toEqual([])
  })
})

describe('Allow for this chat on a tool of the chat’s own server, across vendors', () => {
  it('does not take another vendor’s spelling of the server name', async () => {
    const state = rig()
    const { chat, answers } = await followUpChat(
      state,
      'claude',
      { id: 'q1', tool: NAMES.claude.own[0] },
      [
        { id: 'q2', tool: NAMES.codex.own[0] },
        { id: 'q3', tool: NAMES.cursor.own[0] }
      ]
    )

    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'allow_chat' })
    await settle()

    expect(answers).toEqual({ q1: 'allow_chat' })
    expect(await pendingIds(state, chat)).toEqual(['q2', 'q3'])
  })
})
