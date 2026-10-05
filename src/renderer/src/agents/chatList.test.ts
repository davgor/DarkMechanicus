import { describe, expect, it } from 'vitest'
import { chatRecord, chatSummary } from '../__mocks__/fixtures'
import type { AgentStatuses } from './useAgents'
import { chatMeta, newestFirst, ROLE_LABELS, waitingCount, waitingOnSignIn, waitingReason } from './chatList'

describe('newestFirst', () => {
  it('orders by when the chat last changed, newest first, without changing the input', () => {
    const old = chatRecord({ id: 'a', updatedAt: '2026-03-01T10:00:00.000Z' })
    const recent = chatRecord({ id: 'b', updatedAt: '2026-03-03T10:00:00.000Z' })
    const middle = chatRecord({ id: 'c', updatedAt: '2026-03-02T10:00:00.000Z' })
    const input = [old, recent, middle]
    expect(newestFirst(input).map((chat) => chat.id)).toEqual(['b', 'c', 'a'])
    expect(input.map((chat) => chat.id)).toEqual(['a', 'b', 'c'])
  })

  it('breaks a tie by when the chat was created', () => {
    const first = chatRecord({ id: 'a', createdAt: '2026-03-01T10:00:00.000Z', updatedAt: '2026-03-05T10:00:00.000Z' })
    const second = chatRecord({ id: 'b', createdAt: '2026-03-02T10:00:00.000Z', updatedAt: '2026-03-05T10:00:00.000Z' })
    expect(newestFirst([first, second]).map((chat) => chat.id)).toEqual(['b', 'a'])
  })
})

const SIGNED_OUT: AgentStatuses = { claude: { state: 'signed_out', reason: 'Not signed in.' } }
const SIGNED_IN: AgentStatuses = { claude: { state: 'signed_in', reason: 'Signed in.' } }

describe('waitingOnSignIn', () => {
  const cut = chatRecord({ agent: 'claude', cutShortMessageId: 'u1' })

  it('is a chat whose turn a lost sign-in cut short, while its agent is still signed out', () => {
    expect(waitingOnSignIn(cut, SIGNED_OUT)).toBe(true)
  })

  it('stops once the agent is signed in, or when its state is not known to be signed out', () => {
    expect(waitingOnSignIn(cut, SIGNED_IN)).toBe(false)
    expect(waitingOnSignIn(cut, {})).toBe(false)
    expect(waitingOnSignIn(cut, { claude: { state: 'unknown', reason: '?' } })).toBe(false)
    expect(waitingOnSignIn(cut, { codex: SIGNED_OUT.claude })).toBe(false)
  })

  it('is not a chat with nothing cut short, whatever its agent says', () => {
    expect(waitingOnSignIn(chatRecord({ agent: 'claude' }), SIGNED_OUT)).toBe(false)
    expect(waitingOnSignIn(chatRecord({ agent: 'claude', cutShortMessageId: null }), SIGNED_OUT)).toBe(false)
  })
})

describe('waitingCount', () => {
  it('counts the chats that wait on an answer, not their requests', () => {
    expect(waitingCount([chatSummary({ pending: 0 }), chatSummary({ pending: 1 }), chatSummary({ pending: 4 })], {})).toBe(2)
    expect(waitingCount([], {})).toBe(0)
  })

  it('counts a chat waiting on a sign-in like one waiting on an approval, once', () => {
    const chats = [chatSummary({ id: 'a', cutShortMessageId: 'u1' }), chatSummary({ id: 'b', pending: 1 }), chatSummary({ id: 'c' })]
    expect(waitingCount(chats, SIGNED_OUT)).toBe(2)
    expect(waitingCount(chats, SIGNED_IN)).toBe(1)
  })
})

describe('waitingReason', () => {
  it('names what the waiting chats wait for', () => {
    const approval = chatSummary({ id: 'b', pending: 1 })
    const signIn = chatSummary({ id: 'a', cutShortMessageId: 'u1' })
    expect(waitingReason([approval], SIGNED_OUT)).toBe('approval')
    expect(waitingReason([signIn], SIGNED_OUT)).toBe('sign-in')
    expect(waitingReason([approval, signIn], SIGNED_OUT)).toBe('approval or sign-in')
  })
})

describe('chatMeta', () => {
  it('names the agent and the model', () => {
    expect(chatMeta(chatRecord({ agent: 'claude', model: 'opus' }))).toBe('Claude Code · opus')
    expect(chatMeta(chatRecord({ agent: 'codex', model: 'gpt-5' }))).toBe('Codex · gpt-5')
  })

  it('says so when the chat runs on the agent\'s own default model', () => {
    expect(chatMeta(chatRecord({ agent: 'cursor', model: null }))).toBe('Cursor · Default model')
  })
})

describe('ROLE_LABELS', () => {
  it('labels every role a chat can run as', () => {
    expect(ROLE_LABELS).toEqual({ planner: 'Planner', orchestrator: 'Orchestrator', worker: 'Worker', reviewer: 'Reviewer' })
  })
})
