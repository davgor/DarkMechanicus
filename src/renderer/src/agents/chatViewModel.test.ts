import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import type { ChatOpenView, ChatPushEvent } from '../../../shared/agents/chatApi'
import { chatRecord } from '../__mocks__/fixtures'
import {
  applyDelta,
  applyItem,
  callStatus,
  callSummary,
  decisionText,
  inputFields,
  modelChangeText,
  openSession,
  reduceSession,
  resetText,
  signInCardState,
  type ChatAuth,
  type SessionState,
  type TranscriptEntry
} from './chatViewModel'

const AT = '2026-03-01T10:00:00.000Z'
const user = (id: string, text = 'hi'): ChatItem => ({ id, at: AT, kind: 'user_message', text })
const reply = (id: string, text: string): ChatItem => ({ id, at: AT, kind: 'assistant_text', text })
const call = (id: string, status: 'running' | 'completed', resultSummary: string | null = null): ChatItem => ({
  id,
  at: AT,
  kind: 'tool_call',
  name: 'Bash',
  input: { command: 'ls' },
  status,
  resultSummary
})
const ids = (entries: TranscriptEntry[]): string[] => entries.map((entry) => entry.id)

describe('applyItem', () => {
  it('appends a new item', () => {
    expect(ids(applyItem([user('a')], reply('b', 'x')))).toEqual(['a', 'b'])
  })

  it('replaces an earlier item with the same id in its place, so a tool call updates where it was', () => {
    const entries = [user('a'), call('t', 'running'), reply('r', 'done')]
    const next = applyItem(entries, call('t', 'completed', 'ok'))
    expect(ids(next)).toEqual(['a', 't', 'r'])
    expect(next[1]).toMatchObject({ status: 'completed', resultSummary: 'ok' })
    expect(entries[1]).toMatchObject({ status: 'running' })
  })

  it('turns a streaming message into the stored one without moving it', () => {
    const streaming = applyDelta([user('a')], 'm', 'Hel')
    const next = applyItem([...streaming, call('t', 'running')], reply('m', 'Hello'))
    expect(ids(next)).toEqual(['a', 'm', 't'])
    expect(next[1]).toMatchObject({ kind: 'assistant_text', text: 'Hello' })
  })

  it('leaves the entries of other items untouched (same objects), so their rows need not render again', () => {
    const entries = [user('a'), reply('b', 'x')]
    const next = applyItem(entries, reply('c', 'y'))
    expect(next[0]).toBe(entries[0])
    expect(next[1]).toBe(entries[1])
  })
})

describe('applyDelta', () => {
  it('starts a streaming message at the first delta and grows it with the next ones', () => {
    const first = applyDelta([user('a')], 'm', 'Hel')
    const second = applyDelta(first, 'm', 'lo')
    expect(second).toEqual([user('a'), { kind: 'streaming_text', id: 'm', text: 'Hello' }])
  })

  it('keeps a streaming message where it started when other items arrive meanwhile', () => {
    const entries = applyItem(applyDelta([], 'm', 'Let me look'), call('t', 'running'))
    expect(ids(applyDelta(entries, 'm', ' at it'))).toEqual(['m', 't'])
  })

  it('ignores a delta for a text whose whole stored item is already here', () => {
    const entries = [reply('m', 'Hello')]
    expect(applyDelta(entries, 'm', 'late')).toBe(entries)
  })
})

function opened(items: ChatItem[], running = false): ChatOpenView {
  return { chat: chatRecord({ id: 'chat_1' }), items, pending: [], running }
}

const push = (event: ChatPushEvent) => ({ type: 'push', event }) as const

describe('reduceSession', () => {
  const start = (): SessionState => openSession('chat_1')

  it('starts loading and shows the stored transcript once opened', () => {
    expect(start().phase).toBe('loading')
    const state = reduceSession(start(), { type: 'opened', view: opened([user('a'), reply('b', 'x')], true) })
    expect(state).toMatchObject({ phase: 'ready', running: true })
    expect(ids(state.entries)).toEqual(['a', 'b'])
  })

  it('replays what was pushed while opening on top of the stored transcript, without duplicates', () => {
    let state = reduceSession(start(), push({ type: 'item', chatId: 'chat_1', item: reply('b', 'x') }))
    state = reduceSession(state, push({ type: 'turn', chatId: 'chat_1', running: true }))
    state = reduceSession(state, push({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'c', delta: 'par' }))
    state = reduceSession(state, { type: 'opened', view: opened([user('a'), reply('b', 'x')]) })
    expect(ids(state.entries)).toEqual(['a', 'b', 'c'])
    expect(state.running).toBe(true)
  })

  it('applies pushed items, deltas and turn changes of its own chat once ready', () => {
    let state = reduceSession(start(), { type: 'opened', view: opened([]) })
    state = reduceSession(state, push({ type: 'turn', chatId: 'chat_1', running: true }))
    state = reduceSession(state, push({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'm', delta: 'Hi' }))
    expect(state.running).toBe(true)
    expect(state.entries).toEqual([{ kind: 'streaming_text', id: 'm', text: 'Hi' }])
    state = reduceSession(state, push({ type: 'turn', chatId: 'chat_1', running: false }))
    expect(state.running).toBe(false)
  })

  it('ignores events of other chats', () => {
    let state = reduceSession(start(), { type: 'opened', view: opened([]) })
    state = reduceSession(state, push({ type: 'item', chatId: 'other', item: user('x') }))
    state = reduceSession(state, push({ type: 'assistant_delta', chatId: 'other', itemId: 'y', delta: 'sub', threadId: 'th' }))
    state = reduceSession(state, push({ type: 'turn', chatId: 'other', running: true }))
    expect(state.entries).toEqual([])
    expect(state.running).toBe(false)
  })

  it('records a sent message', () => {
    const ready = reduceSession(start(), { type: 'opened', view: opened([]) })
    expect(ids(reduceSession(ready, { type: 'sent', item: user('u') }).entries)).toEqual(['u'])
  })

  it('keeps a failed opening, ignores pushes meanwhile, and loads again on reopen', () => {
    const failed = reduceSession(start(), { type: 'failed', message: 'nope' })
    expect(failed).toMatchObject({ phase: 'failed', error: 'nope' })
    expect(reduceSession(failed, push({ type: 'turn', chatId: 'chat_1', running: true }))).toBe(failed)
    expect(reduceSession(failed, { type: 'reopen' })).toEqual(start())
  })
})

describe('reduceSession: nested threads', () => {
  const start = (): SessionState => openSession('chat_1')
  const ready = (items: ChatItem[] = []): SessionState => reduceSession(start(), { type: 'opened', view: opened(items) })
  const inThread = (item: ChatItem, threadId = 'th'): ChatItem => ({ ...item, threadId }) as ChatItem
  const thread = (state: 'running' | 'done' | 'failed' = 'running'): ChatItem => ({ id: 'th', at: AT, kind: 'thread', parentItemId: 't1', label: 'Summarize a.txt', state })

  it('keeps the items of a thread with the rest of the transcript, in the order they were stored, and the approvals among them', () => {
    const asked: ChatItem = { id: 'q', at: AT, kind: 'approval_request', requestId: 'req_1', category: 'file_edit', tool: 'Write', summary: 'Write a.txt', threadId: 'th', threadLabel: 'Summarize a.txt' }
    const stored = ready([user('a'), call('t1', 'running'), thread(), inThread(reply('n', 'sub')), asked])
    expect(ids(stored.entries)).toEqual(['a', 't1', 'th', 'n', 'q'])

    const pushed = reduceSession(ready([user('a')]), push({ type: 'item', chatId: 'chat_1', item: inThread(reply('n', 'sub')) }))
    expect(ids(pushed.entries)).toEqual(['a', 'n'])
    expect(pushed.entries[1]).toMatchObject({ threadId: 'th' })
  })

  it('rewrites a thread item in place when its state changes', () => {
    let state = ready([user('a'), call('t1', 'running'), thread(), inThread(reply('n', 'sub'))])
    state = reduceSession(state, push({ type: 'item', chatId: 'chat_1', item: thread('done') }))
    expect(ids(state.entries)).toEqual(['a', 't1', 'th', 'n'])
    expect(state.entries[2]).toMatchObject({ kind: 'thread', state: 'done' })
  })

  it('streams the deltas of a thread into an entry that carries the thread, and the stored text takes its place', () => {
    let state = ready([thread()])
    state = reduceSession(state, push({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'n', delta: 'Sub', threadId: 'th' }))
    state = reduceSession(state, push({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'n', delta: 'agent', threadId: 'th' }))
    expect(state.entries[1]).toEqual({ kind: 'streaming_text', id: 'n', text: 'Subagent', threadId: 'th' })

    state = reduceSession(state, push({ type: 'item', chatId: 'chat_1', item: inThread(reply('n', 'Subagent here.')) }))
    expect(state.entries[1]).toMatchObject({ kind: 'assistant_text', text: 'Subagent here.', threadId: 'th' })
    expect(state.entries).toHaveLength(2)
  })

  it('keeps the main thread streaming apart: a delta without a thread carries none', () => {
    const state = reduceSession(ready(), push({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'm', delta: 'Hi' }))
    expect(state.entries).toEqual([{ kind: 'streaming_text', id: 'm', text: 'Hi' }])
  })

  it('replays what was pushed while the transcript loaded, threads included', () => {
    let state = reduceSession(start(), push({ type: 'item', chatId: 'chat_1', item: thread() }))
    state = reduceSession(state, push({ type: 'assistant_delta', chatId: 'chat_1', itemId: 'n', delta: 'x', threadId: 'th' }))
    state = reduceSession(state, { type: 'opened', view: opened([user('a')]) })
    expect(ids(state.entries)).toEqual(['a', 'th', 'n'])
  })

  it('only the main thread can sign the chat out: a subagent that lost its sign-in does not', () => {
    const lost: ChatItem = { id: 'auth_t', at: AT, kind: 'auth_required', agent: 'claude', message: 'Please log in.', threadId: 'th' }
    expect(reduceSession(ready([thread()]), push({ type: 'item', chatId: 'chat_1', item: lost })).auth.agent).toBe('signed_in')
    expect(ready([thread(), lost]).auth).toEqual({ agent: 'signed_in', cutShort: false, retried: false })
  })
})

const AUTH: ChatItem = { id: 'auth_1', at: AT, kind: 'auth_required', agent: 'claude', message: 'Please log in.' }
const NOTHING_WAITING: ChatAuth = { agent: 'signed_in', cutShort: false, retried: false }

function readyChat(items: ChatItem[], chat: Parameters<typeof chatRecord>[0] = {}): SessionState {
  const view: ChatOpenView = { chat: chatRecord({ id: 'chat_1', ...chat }), items, pending: [], running: false }
  return reduceSession(openSession('chat_1'), { type: 'opened', view })
}

describe('sign-in state of a chat', () => {
  it('has nothing to say in a chat that never lost its sign-in', () => {
    expect(readyChat([user('u1'), reply('r1', 'x')]).auth).toEqual(NOTHING_WAITING)
  })

  it('asks whether the agent is still signed out when the stored transcript says it was, and keeps the turn that was cut short', () => {
    const state = readyChat([user('u1'), AUTH], { cutShortMessageId: 'u1' })
    expect(state.auth).toEqual({ agent: 'checking', cutShort: true, retried: false })
    expect(readyChat([user('u1'), AUTH, user('u2')]).auth.cutShort).toBe(false)
  })

  it('takes the answer of the check once, and not over what was pushed meanwhile', () => {
    const asking = readyChat([user('u1'), AUTH], { cutShortMessageId: 'u1' })
    expect(reduceSession(asking, { type: 'agent_checked', state: 'signed_out' }).auth.agent).toBe('signed_out')
    expect(reduceSession(asking, { type: 'agent_checked', state: 'signed_in' }).auth.agent).toBe('signed_in')
    expect(reduceSession(asking, { type: 'agent_checked', state: 'unknown' }).auth.agent).toBe('signed_in')
    const pushed = reduceSession(asking, push({ type: 'agent_auth', chatId: 'chat_1', agent: 'claude', state: 'signed_in' }))
    expect(reduceSession(pushed, { type: 'agent_checked', state: 'signed_out' }).auth.agent).toBe('signed_in')
  })

  it('finds the agent signed out, with a turn to retry, when an auth_required item arrives live', () => {
    const state = reduceSession(readyChat([user('u1')]), push({ type: 'item', chatId: 'chat_1', item: AUTH }))
    expect(state.auth).toEqual({ agent: 'signed_out', cutShort: true, retried: false })
    expect(ids(state.entries)).toEqual(['u1', 'auth_1'])
  })

  it('follows the sign-in the main process reports for the chat’s agent, and forgets an earlier retry when it is lost again', () => {
    let state = reduceSession(readyChat([user('u1'), AUTH], { cutShortMessageId: 'u1' }), { type: 'retried' })
    state = reduceSession(state, push({ type: 'agent_auth', chatId: 'chat_1', agent: 'claude', state: 'signed_out' }))
    expect(state.auth).toEqual({ agent: 'signed_out', cutShort: false, retried: false })
    state = reduceSession(state, push({ type: 'agent_auth', chatId: 'chat_1', agent: 'claude', state: 'signed_in' }))
    expect(state.auth.agent).toBe('signed_in')
    expect(reduceSession(state, push({ type: 'agent_auth', chatId: 'other', agent: 'claude', state: 'signed_out' }))).toBe(state)
  })

  it('has no turn waiting to be retried once a turn starts, and remembers that it was retried', () => {
    const waiting = readyChat([user('u1'), AUTH], { cutShortMessageId: 'u1' })
    const retried = reduceSession(waiting, { type: 'retried' })
    expect(retried.auth).toMatchObject({ cutShort: false, retried: true })
    const started = reduceSession(waiting, push({ type: 'turn', chatId: 'chat_1', running: true }))
    expect(started.auth).toMatchObject({ cutShort: false, retried: false })
    expect(reduceSession(started, push({ type: 'turn', chatId: 'chat_1', running: false })).auth).toEqual(started.auth)
  })

  it('waits for the transcript before applying anything pushed about sign-in', () => {
    let state = reduceSession(openSession('chat_1'), push({ type: 'item', chatId: 'chat_1', item: AUTH }))
    state = reduceSession(state, push({ type: 'agent_auth', chatId: 'chat_1', agent: 'claude', state: 'signed_out' }))
    state = reduceSession(state, { type: 'opened', view: { chat: chatRecord({ id: 'chat_1', cutShortMessageId: 'u1' }), items: [user('u1')], pending: [], running: false } })
    expect(state.auth).toEqual({ agent: 'signed_out', cutShort: true, retried: false })
    expect(ids(state.entries)).toEqual(['u1', 'auth_1'])
  })
})

describe('signInCardState', () => {
  it.each<[ChatAuth, string]>([
    [{ agent: 'signed_out', cutShort: true, retried: false }, 'signed_out'],
    [{ agent: 'signed_out', cutShort: false, retried: false }, 'signed_out'],
    [{ agent: 'checking', cutShort: true, retried: false }, 'checking'],
    [{ agent: 'signed_in', cutShort: true, retried: false }, 'retry'],
    [{ agent: 'signed_in', cutShort: false, retried: true }, 'retried'],
    [{ agent: 'signed_in', cutShort: false, retried: false }, 'past']
  ])('shows %j as %s', (auth, expected) => {
    expect(signInCardState(auth)).toBe(expected)
  })
})

describe('call views', () => {
  it('summarizes a call by the input worth showing', () => {
    expect(callSummary({ command: 'npm test\n--run', cwd: '/x' })).toBe('npm test --run')
    expect(callSummary({ file_path: '/src/a.ts', old_string: 'x' })).toBe('/src/a.ts')
    expect(callSummary({ files: ['a.ts', 'b.ts'] })).toBe('a.ts, b.ts')
    expect(callSummary({ other: 'first string', n: 3 })).toBe('first string')
    expect(callSummary({ n: 3, ok: true })).toBe('{"n":3,"ok":true}')
    expect(callSummary({})).toBe('')
  })

  it('clips a very long summary', () => {
    const text = callSummary({ command: 'x'.repeat(500) })
    expect(text.length).toBeLessThanOrEqual(160)
    expect(text.endsWith('…')).toBe(true)
  })

  it('lists the input as fields, strings as they are and anything else as JSON', () => {
    expect(inputFields({ command: 'ls -la', args: ['a'], n: 2 })).toEqual([
      { key: 'command', text: 'ls -la' },
      { key: 'args', text: '[\n  "a"\n]' },
      { key: 'n', text: '2' }
    ])
  })

  it('names each status and ties it to a state color', () => {
    expect(callStatus('running')).toEqual({ state: 'running', label: 'Running' })
    expect(callStatus('completed')).toEqual({ state: 'accepted', label: 'Done' })
    expect(callStatus('failed')).toEqual({ state: 'failed', label: 'Failed' })
    expect(callStatus('denied')).toEqual({ state: 'blocked', label: 'Denied' })
  })
})

describe('notice texts', () => {
  const labels = new Map([
    ['opus', 'Opus'],
    ['sonnet', 'Sonnet']
  ])

  it('says a model change takes effect from the next turn, with labels where known', () => {
    expect(modelChangeText('opus', 'sonnet', labels)).toBe('Model changed from Opus to Sonnet. It takes effect from the next turn.')
    expect(modelChangeText(null, 'unknown-x', labels)).toBe('Model set to unknown-x. It takes effect from the next turn.')
  })

  it('explains a context reset by its reason, preferring the agent’s own message', () => {
    expect(resetText('compact', undefined)).toBe('The earlier conversation was compacted.')
    expect(resetText('clear', undefined)).toBe('The context was cleared.')
    expect(resetText('model_change', undefined)).toBe('The context was reset for the new model.')
    expect(resetText('session_lost', undefined)).toBe('The earlier session could not be resumed, so the chat continues in a new one.')
    expect(resetText('session_lost', 'Could not resume (gone).')).toBe('Could not resume (gone).')
  })

  it('words approval decisions neutrally', () => {
    const base = { id: 'd', at: AT, kind: 'approval_decision', requestId: 'r' } as const
    expect(decisionText({ ...base, decision: 'allow_once' })).toBe('Approval answered: allowed once.')
    expect(decisionText({ ...base, decision: 'allow_chat' })).toBe('Approval answered: allowed for this chat.')
    expect(decisionText({ ...base, decision: 'allow_chat', automatic: true })).toBe('Approval answered automatically: allowed for this chat.')
    expect(decisionText({ ...base, decision: 'deny' })).toBe('Approval answered: denied.')
    expect(decisionText({ ...base, decision: 'cancelled' })).toBe('Approval cancelled: no answer reached the agent.')
  })
})
