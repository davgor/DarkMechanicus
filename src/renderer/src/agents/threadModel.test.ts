import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { threadPath, threadStateView, transcriptTree, type ThreadNode, type TreeRow } from './threadModel'
import type { TranscriptEntry } from './chatViewModel'

const AT = '2026-03-01T10:00:00.000Z'

const user = (id: string): ChatItem => ({ id, at: AT, kind: 'user_message', text: id })
const call = (id: string, threadId?: string): ChatItem => ({
  id,
  at: AT,
  kind: 'tool_call',
  name: 'Agent',
  input: {},
  status: 'completed',
  resultSummary: null,
  ...(threadId === undefined ? {} : { threadId })
})
const text = (id: string, threadId?: string): ChatItem => ({ id, at: AT, kind: 'assistant_text', text: id, ...(threadId === undefined ? {} : { threadId }) })
const thread = (id: string, parentItemId: string, threadId?: string, state: 'running' | 'done' | 'failed' = 'running'): ChatItem => ({
  id,
  at: AT,
  kind: 'thread',
  parentItemId,
  label: `Label of ${id}`,
  state,
  ...(threadId === undefined ? {} : { threadId })
})
const asked = (requestId: string, threadId?: string): ChatItem => ({
  id: `item_${requestId}`,
  at: AT,
  kind: 'approval_request',
  requestId,
  category: 'command',
  tool: 'Bash',
  summary: 'Run it',
  ...(threadId === undefined ? {} : { threadId, threadLabel: 'Worker' })
})
const answered = (requestId: string): ChatItem => ({ id: `item_answer_${requestId}`, at: AT, kind: 'approval_decision', requestId, decision: 'allow_once' })

const ids = (rows: readonly TreeRow[]): string[] => rows.map((row) => row.entry.id)
const only = (row: TreeRow | undefined): ThreadNode => {
  const node = row?.threads[0]
  if (node === undefined) {
    throw new Error('The row has no thread.')
  }
  return node
}

describe('transcriptTree', () => {
  it('is the transcript rows, with no threads, when nothing is nested', () => {
    const rows = transcriptTree([user('a'), call('c'), text('b')])
    expect(ids(rows)).toEqual(['a', 'c', 'b'])
    expect(rows.every((row) => row.threads.length === 0)).toBe(true)
  })

  it('puts a thread under the call that spawned it, with its own items, and keeps it out of the main rows', () => {
    const rows = transcriptTree([user('a'), call('spawn'), thread('th', 'spawn'), text('n1', 'th'), call('inner', 'th'), text('after')])
    expect(ids(rows)).toEqual(['a', 'spawn', 'after'])
    const node = only(rows[1])
    expect(node.item.id).toBe('th')
    expect(ids(node.rows)).toEqual(['n1', 'inner'])
    expect(rows[0]?.threads).toEqual([])
  })

  it('puts parallel subagents under their own calls, in the order the threads were started', () => {
    const rows = transcriptTree([call('s1'), call('s2'), thread('t2', 's2'), thread('t1', 's1'), text('x', 't1'), text('y', 't2')])
    expect(ids(rows)).toEqual(['s1', 's2'])
    expect(ids(only(rows[0]).rows)).toEqual(['x'])
    expect(ids(only(rows[1]).rows)).toEqual(['y'])
  })

  it('nests a thread a subagent started under the subagent\'s own call', () => {
    const rows = transcriptTree([call('spawn'), thread('outer', 'spawn'), call('inner_spawn', 'outer'), thread('inner', 'inner_spawn', 'outer'), text('deep', 'inner')])
    const outer = only(rows[0])
    expect(ids(outer.rows)).toEqual(['inner_spawn'])
    const inner = only(outer.rows[0])
    expect(inner.item.id).toBe('inner')
    expect(ids(inner.rows)).toEqual(['deep'])
  })

  it('streams a thread\'s unfinished text inside the thread', () => {
    const streaming: TranscriptEntry = { kind: 'streaming_text', id: 'live', text: 'Partly', threadId: 'th' }
    const rows = transcriptTree([call('spawn'), thread('th', 'spawn'), streaming])
    expect(only(rows[0]).rows.map((row) => [row.entry.id, row.entry.kind])).toEqual([['live', 'streaming_text']])
  })

  it('shows a thread whose spawning call is not in the transcript where the thread was stored', () => {
    const rows = transcriptTree([user('a'), thread('th', 'gone'), text('n', 'th'), user('b')])
    expect(ids(rows)).toEqual(['a', 'th', 'b'])
    expect(rows[1]?.entry.kind).toBe('thread')
    expect(ids(only(rows[1]).rows)).toEqual(['n'])
  })

})

describe('transcriptTree: threads that are not as stored, and requests', () => {
  it('shows the items of a thread that has no thread item as a thread of their own, so a request in it can still be answered', () => {
    const rows = transcriptTree([user('a'), asked('q', 'lost'), text('n', 'lost')])
    expect(ids(rows)).toEqual(['a', 'lost'])
    const node = only(rows[1])
    expect(node).toMatchObject({ pending: 1, item: { id: 'lost', label: 'Worker', state: 'running' } })
    expect(ids(node.rows)).toEqual(['item_q', 'n'])
  })

  it('does not loop over a thread that names itself as its own thread', () => {
    const rows = transcriptTree([thread('th', 'c', 'th')])
    expect(rows.length).toBeLessThanOrEqual(1)
  })

  it('counts the requests waiting for an answer, in the thread and in the threads below it', () => {
    const rows = transcriptTree([call('spawn'), thread('outer', 'spawn'), asked('q1', 'outer'), call('inner_spawn', 'outer'), thread('inner', 'inner_spawn', 'outer'), asked('q2', 'inner'), asked('q3', 'inner'), answered('q3')])
    const outer = only(rows[0])
    expect(outer.pending).toBe(2)
    expect(only(outer.rows[1]).pending).toBe(1)
  })

  it('gives a request in a thread the decision stored for it, and keeps that decision out of the rows', () => {
    const rows = transcriptTree([call('spawn'), thread('th', 'spawn'), asked('q', 'th'), answered('q')])
    expect(ids(rows)).toEqual(['spawn'])
    const request = only(rows[0]).rows[0]
    expect(request?.answer).toMatchObject({ requestId: 'q', decision: 'allow_once' })
    expect(only(rows[0]).pending).toBe(0)
  })
})

describe('threadPath', () => {
  const entries = [call('spawn'), thread('outer', 'spawn'), call('inner_spawn', 'outer'), thread('inner', 'inner_spawn', 'outer'), text('deep', 'inner')]

  it('names a thread and every thread above it, so a view can open them all', () => {
    expect([...threadPath(entries, 'inner')].sort()).toEqual(['inner', 'outer'])
    expect([...threadPath(entries, 'outer')]).toEqual(['outer'])
  })

  it('is empty for a thread that is not in the transcript, and stops at a thread that names itself', () => {
    expect([...threadPath(entries, 'nowhere')]).toEqual([])
    expect([...threadPath([thread('loop', 'x', 'loop')], 'loop')]).toEqual(['loop'])
  })
})

describe('threadStateView', () => {
  it('words each state, with the pill color it shares with the rest of the app', () => {
    expect(threadStateView('running')).toEqual({ label: 'Running', pill: 'running' })
    expect(threadStateView('done')).toEqual({ label: 'Done', pill: 'accepted' })
    expect(threadStateView('failed')).toEqual({ label: 'Failed', pill: 'failed' })
  })
})
