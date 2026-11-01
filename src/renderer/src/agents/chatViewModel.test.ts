import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { applyItem, callStatus, callSummary, decisionText, inputFields, resetText, type TranscriptEntry } from './chatViewModel'

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

  it('leaves the entries of other items untouched (same objects), so their rows need not render again', () => {
    const entries = [user('a'), reply('b', 'x')]
    const next = applyItem(entries, reply('c', 'y'))
    expect(next[0]).toBe(entries[0])
    expect(next[1]).toBe(entries[1])
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

  it('summarizes a number or a yes/no by its text, and skips a list that is not of plain values', () => {
    expect(callSummary({ command: 42 })).toBe('42')
    expect(callSummary({ path: false })).toBe('false')
    expect(callSummary({ files: [{ name: 'a.ts' }], note: 'read the file' })).toBe('read the file')
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
    expect(callStatus('cancelled')).toEqual({ state: 'canceled', label: 'Cancelled' })
  })
})

describe('notice texts', () => {
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
