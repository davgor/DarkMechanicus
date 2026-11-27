import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { formatWorkDuration, turnGroups, workLabel, type TurnEntry } from './turnGroups'

const T0 = Date.parse('2026-11-27T10:00:00.000Z')
const at = (seconds: number): string => new Date(T0 + seconds * 1_000).toISOString()

const user = (id: string, seconds = 0): ChatItem => ({ id, at: at(seconds), kind: 'user_message', text: `ask ${id}` })
const text = (id: string, seconds: number, threadId?: string): ChatItem =>
  ({ id, at: at(seconds), kind: 'assistant_text', text: `say ${id}`, ...(threadId === undefined ? {} : { threadId }) })
const tool = (id: string, seconds: number, threadId?: string): ChatItem => ({
  id, at: at(seconds), kind: 'tool_call', name: 'Bash', input: { command: id }, status: 'completed', resultSummary: 'ok',
  ...(threadId === undefined ? {} : { threadId })
})

/** The entries in a compact form: `m:<id>`, `i:<id>`, `w:[<ids>]`. */
const shape = (entries: TurnEntry[]): string[] =>
  entries.map((entry) => entry.kind === 'collapsed-work' ? `w:[${entry.items.map((item) => item.id).join(',')}]`
    : `${entry.kind === 'message' ? 'm' : 'i'}:${entry.item.id}`)

const work = (entries: TurnEntry[]): Extract<TurnEntry, { kind: 'collapsed-work' }> => {
  const found = entries.find((entry) => entry.kind === 'collapsed-work')
  if (found?.kind !== 'collapsed-work') throw new Error('no collapsed work')
  return found
}

/** A finished turn: 3 tool calls and an intermediate text before the final reply, 28m 51s after the message. */
const finished: ChatItem[] = [user('u'), tool('t1', 10), text('mid', 20), tool('t2', 30), tool('t3', 40), text('final', 1_731)]

describe('turnGroups: collapse bounds', () => {
  it('folds a finished turn’s tool calls and intermediate text into one entry, leaving the final reply after it', () => {
    const entries = turnGroups(finished, 'idle')

    expect(shape(entries)).toEqual(['m:u', 'w:[t1,mid,t2,t3]', 'i:final'])
    expect(work(entries)).toMatchObject({ id: 'u', startAt: at(0), endAt: at(1_731), stopped: false })
    expect(workLabel(work(entries))).toBe('Worked for 28m 51s')
  })

  it('folds each earlier turn even while the chat is busy, and ends a turn at the next message', () => {
    const items = [...finished, user('u2', 1_800), tool('t4', 1_810)]

    expect(shape(turnGroups(items, 'busy'))).toEqual(['m:u', 'w:[t1,mid,t2,t3]', 'i:final', 'm:u2', 'i:t4'])
  })

  it('leaves the busy last turn open', () => {
    expect(shape(turnGroups(finished, 'busy'))).toEqual(['m:u', 'i:t1', 'i:mid', 'i:t2', 'i:t3', 'i:final'])
  })

  it('ends the last turn only when the chat is idle', () => {
    for (const status of ['starting', 'exited', 'failed', 'signed_out', null] as const) {
      expect(turnGroups(finished, status).some((entry) => entry.kind === 'collapsed-work')).toBe(false)
    }
  })

  it('leaves items before the first message, and a turn with nothing to fold, as they are', () => {
    const before: ChatItem = { id: 'model', at: at(0), kind: 'model_change', from: null, to: 'opus' }

    expect(shape(turnGroups([before, user('u'), text('only', 5)], 'idle'))).toEqual(['i:model', 'm:u', 'i:only'])
  })

  it('folds a thread’s own items and texts with the work, keeping only the chat’s own last text as the reply', () => {
    const thread: ChatItem = { id: 'th', at: at(5), kind: 'thread', parentItemId: 't1', label: 'Explore', state: 'done' }
    const items = [user('u'), tool('t1', 1), thread, tool('inner', 6, 'th'), text('final', 9), text('late', 12, 'th')]

    expect(shape(turnGroups(items, 'idle'))).toEqual(['m:u', 'w:[t1,th,inner,late]', 'i:final'])
  })

  it('folds everything when the turn has no reply', () => {
    expect(shape(turnGroups([user('u'), tool('t1', 3)], 'idle'))).toEqual(['m:u', 'w:[t1]'])
  })

  it('folds a text that work came after with the rest, so nothing folded sits above the reply out of order', () => {
    const request: ChatItem = { id: 'q', at: at(5), kind: 'approval_request', requestId: 'r', category: 'command', tool: 'Bash', summary: 'Run it' }
    const decision: ChatItem = { id: 'd', at: at(6), kind: 'approval_decision', requestId: 'r', decision: 'deny', decidedBy: 'magos' }

    expect(shape(turnGroups([user('u'), text('said', 2), request, decision], 'idle'))).toEqual(['m:u', 'w:[said,q,d]'])
  })

  it('folds a stopped turn’s text and tools, keeping only the stop notice', () => {
    const stopped: ChatItem = { id: 'stop', at: at(30), kind: 'turn_stopped' }
    const entries = turnGroups([user('u'), text('check', 2), tool('Read', 5), tool('Bash', 9), stopped], 'idle')

    expect(shape(entries)).toEqual(['m:u', 'w:[check,Read,Bash]', 'i:stop'])
    expect(workLabel(work(entries))).toBe('Stopped after 30s')
  })

  it('keeps the reply final when only an error or a stop notice follows it', () => {
    const error: ChatItem = { id: 'err', at: at(12), kind: 'error', message: 'Lost the connection' }

    expect(shape(turnGroups([user('u'), tool('t1', 3), text('final', 10), error], 'idle'))).toEqual(['m:u', 'w:[t1]', 'i:final', 'i:err'])
  })
})

describe('turnGroups: never hidden', () => {
  it('keeps an error inside a turn outside the fold, in its place after it', () => {
    const error: ChatItem = { id: 'err', at: at(15), kind: 'error', code: 'tool_failed', message: 'Bash failed' }
    const items = [user('u'), tool('t1', 10), error, tool('t2', 20), text('final', 30)]

    expect(shape(turnGroups(items, 'idle'))).toEqual(['m:u', 'w:[t1,t2]', 'i:err', 'i:final'])
  })

  it('keeps the reply final and a model switch shown when the person switched models after the turn', () => {
    const switched: ChatItem = { id: 'model', at: at(40), kind: 'model_change', from: 'anthropic/claude-opus-5-5', to: 'openai-codex/gpt-6-astra' }

    expect(shape(turnGroups([user('u'), tool('t1', 3), text('final', 10), switched], 'idle'))).toEqual(['m:u', 'w:[t1]', 'i:final', 'i:model'])
    expect(shape(turnGroups([user('u'), text('final', 10), switched], 'idle'))).toEqual(['m:u', 'i:final', 'i:model'])
  })

  it('keeps a prompt nobody answered outside the fold, but folds an answered one with its decision', () => {
    const request = (id: string, requestId: string): ChatItem =>
      ({ id, at: at(5), kind: 'approval_request', requestId, category: 'command', tool: 'Bash', summary: 'Run it' })
    const answered: ChatItem = { id: 'd1', at: at(6), kind: 'approval_decision', requestId: 'r1', decision: 'allow_once' }
    const items = [user('u'), request('q1', 'r1'), answered, request('q2', 'r2'), text('final', 9)]

    expect(shape(turnGroups(items, 'idle'))).toEqual(['m:u', 'w:[q1,d1]', 'i:q2', 'i:final'])
  })

  it('leaves a turn open while a thread inside it waits on a prompt, since the fold would hide the thread', () => {
    const waiting: ChatItem = { id: 'q', at: at(5), kind: 'approval_request', threadId: 'th', requestId: 'r', category: 'command', tool: 'Bash', summary: 'Run it' }
    const thread: ChatItem = { id: 'th', at: at(4), kind: 'thread', parentItemId: 't1', label: 'Explore', state: 'running' }
    const items = [user('u'), tool('t1', 1), thread, waiting, text('final', 9)]

    expect(shape(turnGroups(items, 'idle'))).toEqual(['m:u', 'i:t1', 'i:th', 'i:q', 'i:final'])
  })

  it('labels a stopped turn “Stopped after” and keeps its stop notice visible', () => {
    const stopped: ChatItem = { id: 'stop', at: at(182), kind: 'turn_stopped' }
    const entries = turnGroups([user('u'), tool('t1', 60), stopped], 'idle')

    expect(shape(entries)).toEqual(['m:u', 'w:[t1]', 'i:stop'])
    expect(workLabel(work(entries))).toBe('Stopped after 3m 02s')
  })
})

describe('formatWorkDuration', () => {
  it.each([
    [51_000, '51s'],
    [(28 * 60 + 51) * 1_000, '28m 51s'],
    [(60 + 5) * 60_000, '1h 05m'],
    [0, '0s'],
    [-5_000, '0s'],
    [Number.NaN, '0s']
  ])('formats %d ms as %s', (ms, expected) => {
    expect(formatWorkDuration(ms)).toBe(expected)
  })
})
