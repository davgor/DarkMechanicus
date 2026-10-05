import { describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import type { TranscriptEntry } from './chatViewModel'
import { chooseBoundThread, clipRows, mergeByTime, streamRows, type StreamRow } from './threadStream'

const AT = '2026-03-01T10:00:00.000Z'

function at(minute: number): string {
  return `2026-03-01T10:${String(minute).padStart(2, '0')}:00.000Z`
}

const scope = (threadId?: string): { threadId?: string } => (threadId === undefined ? {} : { threadId })
const user = (id: string, text = id, threadId?: string): ChatItem => ({ id, at: AT, kind: 'user_message', text, ...scope(threadId) })
const said = (id: string, text = id, threadId?: string): ChatItem => ({ id, at: AT, kind: 'assistant_text', text, ...scope(threadId) })
const call = (id: string, patch: Partial<Extract<ChatItem, { kind: 'tool_call' }>> = {}, threadId?: string): ChatItem => ({
  id,
  at: AT,
  kind: 'tool_call',
  name: 'Bash',
  input: { command: 'npm test' },
  status: 'completed',
  resultSummary: 'ok',
  ...scope(threadId),
  ...patch
})
const thread = (id: string, threadId?: string, state: 'running' | 'done' | 'failed' = 'running'): ChatItem => ({
  id,
  at: AT,
  kind: 'thread',
  parentItemId: `spawn_${id}`,
  label: `Label of ${id}`,
  state,
  ...scope(threadId)
})
const asked = (requestId: string, threadId?: string): ChatItem => ({
  id: `item_${requestId}`,
  at: AT,
  kind: 'approval_request',
  requestId,
  category: 'command',
  tool: 'Bash',
  summary: 'Run it',
  ...scope(threadId)
})
const decided = (requestId: string, threadId?: string): ChatItem => ({
  id: `item_answer_${requestId}`,
  at: AT,
  kind: 'approval_decision',
  requestId,
  decision: 'allow_once',
  ...scope(threadId)
})
const streaming = (id: string, text: string, threadId?: string): TranscriptEntry => ({ kind: 'streaming_text', id, text, ...scope(threadId) })

const ids = (rows: readonly StreamRow[]): string[] => rows.map((row) => row.id)

describe('streamRows of the chat main thread: what is said and run', () => {
  it('shows the messages, tool calls, approvals, threads and errors of the thread, in the order stored', () => {
    const entries: TranscriptEntry[] = [
      user('u'),
      said('a'),
      call('c'),
      asked('r1'),
      thread('th'),
      { id: 'e', at: AT, kind: 'error', message: 'It broke' }
    ]

    expect(streamRows(entries, null).map((row) => row.kind)).toEqual(['message', 'message', 'tool', 'approval', 'thread', 'error'])
    expect(ids(streamRows(entries, null))).toEqual(['u', 'a', 'c', 'item_r1', 'th', 'e'])
  })

  it('says who wrote a message, and marks a text that is still being written', () => {
    const rows = streamRows([user('u', 'Run the epic'), said('a', 'On it'), streaming('s', 'Reading the')], null)

    expect(rows).toEqual([
      expect.objectContaining({ kind: 'message', who: 'You', text: 'Run the epic', streaming: false, at: AT }),
      expect.objectContaining({ kind: 'message', who: 'Assistant', text: 'On it', streaming: false }),
      expect.objectContaining({ kind: 'message', who: 'Assistant', text: 'Reading the', streaming: true, at: null })
    ])
  })

  it('leaves out what is not part of the conversation: model changes, resets, sign-in cards and answered approvals on their own', () => {
    const entries: TranscriptEntry[] = [
      { id: 'm', at: AT, kind: 'model_change', from: null, to: 'opus' },
      { id: 'x', at: AT, kind: 'context_reset', reason: 'clear' },
      { id: 'auth', at: AT, kind: 'auth_required', agent: 'claude', message: 'Sign in' },
      decided('lost'),
      said('a')
    ]

    expect(ids(streamRows(entries, null))).toEqual(['a'])
  })

  it('folds a stored decision into its request, so an answered request is shown once, with its answer', () => {
    const rows = streamRows([asked('r1'), asked('r2'), decided('r1')], null)

    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ kind: 'approval', tone: 'neutral', answer: { decision: 'allow_once' } })
    expect(rows[1]).toMatchObject({ kind: 'approval', tone: 'attention', answer: null })
  })

  it('names a problem with the account in front of the CLI’s words, and leaves a plain error as it was', () => {
    const entries: TranscriptEntry[] = [
      { id: 'p', at: AT, kind: 'error', message: 'Your account is on hold.', problem: 'account_on_hold' },
      { id: 'e', at: AT, kind: 'error', message: 'It broke' }
    ]

    expect(streamRows(entries, null)).toEqual([
      { id: 'p', at: AT, tone: 'failed', kind: 'error', message: 'Account on hold: Your account is on hold.' },
      { id: 'e', at: AT, tone: 'failed', kind: 'error', message: 'It broke' }
    ])
  })
})

describe('streamRows of the chat main thread: tool calls', () => {
  it('names a Dark Mechanicus call by what it did, never by its input', () => {
    const claim = call('claim', {
      name: 'mcp__darkmechanicus__claim_ticket',
      input: { ticketId: 'tk_01k8zq2m3n4p5q6r7s8t9v0w1x', runId: 'rn_01k8zq3v7c2m5n9p4r6t8w0xyb' },
      resultSummary: '{"key":"DM-12"}'
    })

    const [row] = streamRows([claim], null)

    expect(row).toMatchObject({ kind: 'tool', title: 'claimed DM-12', summary: '' })
  })

  it('names any other call by its tool and the input that says what it does, with its status', () => {
    const rows = streamRows([call('ok'), call('run', { status: 'running', resultSummary: null }), call('no', { status: 'failed' }), call('den', { status: 'denied' }), call('gone', { status: 'cancelled' })], null)

    expect(rows.map((row) => (row.kind === 'tool' ? [row.title, row.summary, row.status.label, row.tone] : null))).toEqual([
      ['Bash', 'npm test', 'Done', 'neutral'],
      ['Bash', 'npm test', 'Running', 'running'],
      ['Bash', 'npm test', 'Failed', 'failed'],
      ['Bash', 'npm test', 'Denied', 'blocked'],
      ['Bash', 'npm test', 'Cancelled', 'neutral']
    ])
  })

})

describe('streamRows of the chat main thread: threads and approvals', () => {
  it('shows a subagent thread as one row with its label and state, not the items inside it', () => {
    const entries: TranscriptEntry[] = [thread('th'), said('inside', 'inner', 'th'), call('inner-call', {}, 'th'), thread('done', undefined, 'done')]

    const rows = streamRows(entries, null)

    expect(ids(rows)).toEqual(['th', 'done'])
    expect(rows[0]).toMatchObject({ kind: 'thread', label: 'Label of th', state: { label: 'Running' }, tone: 'running' })
    expect(rows[1]).toMatchObject({ state: { label: 'Done' }, tone: 'accepted' })
  })

  it('still shows an approval that waits inside a subagent thread, and drops it once answered', () => {
    const waiting: TranscriptEntry[] = [thread('th'), asked('deep', 'th'), said('inside', 'inner', 'th')]

    expect(ids(streamRows(waiting, null))).toEqual(['th', 'item_deep'])
    expect(ids(streamRows([...waiting, decided('deep', 'th')], null))).toEqual(['th'])
  })

  it('reaches an approval that waits in a thread started by a subagent', () => {
    const entries: TranscriptEntry[] = [thread('outer'), thread('inner', 'outer'), asked('deep', 'inner')]

    expect(ids(streamRows(entries, null))).toEqual(['outer', 'item_deep'])
  })
})

describe('streamRows of a transcript whose threads loop', () => {
  it('ends instead of following threads that name each other as their parent, and shows nothing of them', () => {
    const entries: TranscriptEntry[] = [thread('a', 'b'), thread('b', 'a'), asked('x', 'a')]

    expect(streamRows(entries, null)).toEqual([])
  })
})

describe('streamRows of a subagent thread', () => {
  const entries: TranscriptEntry[] = [
    user('u'),
    thread('th'),
    said('mine', 'working', 'th'),
    call('mine-call', {}, 'th'),
    asked('mine-ask', 'th'),
    thread('sub', 'th'),
    said('theirs', 'deeper', 'sub'),
    asked('deep', 'sub'),
    said('other', 'elsewhere', 'other-thread'),
    thread('sibling'),
    asked('sibling-ask', 'sibling')
  ]

  it('shows only the items of that thread, the threads it started, and what waits below it', () => {
    expect(ids(streamRows(entries, 'th'))).toEqual(['mine', 'mine-call', 'item_mine-ask', 'sub', 'item_deep'])
  })

  it('shows nothing of the chat around it: not the main thread, not a sibling thread', () => {
    const rows = streamRows(entries, 'th')

    expect(ids(rows)).not.toContain('u')
    expect(ids(rows)).not.toContain('item_sibling-ask')
    expect(ids(rows)).not.toContain('other')
  })

  it('streams a text being written in the thread, and not one written in another', () => {
    const live: TranscriptEntry[] = [...entries, streaming('now', 'Reading', 'th'), streaming('else', 'Writing', 'sibling')]

    const rows = streamRows(live, 'th')

    expect(rows[rows.length - 1]).toMatchObject({ id: 'now', streaming: true, text: 'Reading' })
    expect(ids(rows)).not.toContain('else')
  })

  it('is empty for a thread the transcript does not have (yet)', () => {
    expect(streamRows(entries, 'unknown')).toEqual([])
  })
})

describe('mergeByTime', () => {
  const record = (id: string, minute: number): { id: string; at: string } => ({ id, at: at(minute) })
  const chat = (id: string, minute: number | null): { id: string; at: string | null } => ({ id, at: minute === null ? null : at(minute) })
  const names = (merged: ReturnType<typeof mergeByTime<{ id: string; at: string }, { id: string; at: string | null }>>): string[] =>
    merged.map((entry) => (entry.source === 'record' ? entry.item.id : entry.row.id))

  it('puts the chat rows among the records in time order, oldest first', () => {
    const merged = mergeByTime([record('claim', 1), record('note', 5)], (item) => item.at, [chat('said', 3), chat('ran', 4), chat('late', 9)], 'oldest_first')

    expect(names(merged)).toEqual(['claim', 'said', 'ran', 'note', 'late'])
  })

  it('puts a row that is still being written after everything, since it is the newest', () => {
    const merged = mergeByTime([record('note', 5)], (item) => item.at, [chat('said', 3), chat('typing', null)], 'oldest_first')

    expect(names(merged)).toEqual(['said', 'note', 'typing'])
  })

  it('lists newest first when asked, with what is still being written on top', () => {
    const merged = mergeByTime([record('note', 5), record('claim', 1)], (item) => item.at, [chat('typing', null), chat('said', 3)], 'newest_first')

    expect(names(merged)).toEqual(['typing', 'note', 'said', 'claim'])
  })

  it('keeps the order of each list as it was given, even where times are not in order', () => {
    const merged = mergeByTime([record('r1', 5), record('r2', 2)], (item) => item.at, [chat('c1', 9), chat('c2', 1)], 'oldest_first')

    expect(names(merged)).toEqual(['r1', 'r2', 'c1', 'c2'])
  })

  it('keeps the record first when both happened at the same time, and the order within each list', () => {
    const merged = mergeByTime([record('r1', 2), record('r2', 2)], (item) => item.at, [chat('c1', 2), chat('c2', 2)], 'oldest_first')

    expect(names(merged)).toEqual(['r1', 'r2', 'c1', 'c2'])
  })

  it('is the records alone when there are no chat rows', () => {
    const merged = mergeByTime([record('a', 1), record('b', 2)], (item) => item.at, [], 'oldest_first')

    expect(merged.map((entry) => entry.source)).toEqual(['record', 'record'])
    expect(names(merged)).toEqual(['a', 'b'])
  })
})

describe('clipRows to the window of an attempt', () => {
  const timed = (id: string, minute: number): ChatItem => ({ ...said(id), at: at(minute) })
  const entries: TranscriptEntry[] = [timed('early', 1), timed('start', 2), timed('middle', 4), timed('end', 6), timed('late', 8), streaming('typing', 'Writing')]
  const rows = streamRows(entries, null)
  const window = (from: number | null, to: number | null): { from: string | null; to: string | null } => ({
    from: from === null ? null : at(from),
    to: to === null ? null : at(to)
  })

  it('keeps what happened from the start to the end, both included, and drops what came before or after', () => {
    expect(ids(clipRows(rows, window(2, 6)))).toEqual(['start', 'middle', 'end'])
  })

  it('goes on to now while the end is open, including the text still being written', () => {
    expect(ids(clipRows(rows, window(4, null)))).toEqual(['middle', 'end', 'late', 'typing'])
  })

  it('drops the text still being written once the window has ended, since it is newer than the end', () => {
    expect(ids(clipRows(rows, window(null, 8)))).toEqual(['early', 'start', 'middle', 'end', 'late'])
  })

  it('treats a time it cannot read as being written now', () => {
    const odd = streamRows([{ ...said('odd'), at: 'sometime' }, timed('middle', 4)], null)

    expect(ids(clipRows(odd, window(2, null)))).toEqual(['odd', 'middle'])
    expect(ids(clipRows(odd, window(2, 6)))).toEqual(['middle'])
  })

  it('is every row for a window with no bounds, and ignores a bound it cannot read', () => {
    expect(ids(clipRows(rows, { from: null, to: null }))).toEqual(ids(rows))
    expect(ids(clipRows(rows, { from: 'whenever', to: 'never' }))).toEqual(ids(rows))
  })

  it('clips requests and subagent threads the same way, answered or not', () => {
    const stored: TranscriptEntry[] = [
      { ...asked('old'), at: at(1) },
      { ...asked('now'), at: at(5) },
      { ...thread('old_thread'), at: at(1) },
      { ...thread('new_thread'), at: at(5) }
    ]

    expect(ids(clipRows(streamRows(stored, null), window(3, null)))).toEqual(['item_now', 'new_thread'])
  })
})

describe('chooseBoundThread', () => {
  const found = (role: 'orchestrator' | 'worker', chatId: string, threadId: string | null): { folder: string; chatId: string; threadId: string | null; role: 'orchestrator' | 'worker' } => ({
    folder: '/repo',
    chatId,
    threadId,
    role
  })

  it('picks the worker thread of an attempt, ignoring the orchestrator that claimed it', () => {
    const threads = [found('orchestrator', 'chat_o', null), found('worker', 'chat_o', 'th_1')]

    expect(chooseBoundThread(threads, 'worker')).toEqual(found('worker', 'chat_o', 'th_1'))
  })

  it('picks the latest bound when several threads are the worker, since it is the one the attempt moved to', () => {
    const threads = [found('worker', 'chat_o', 'th_1'), found('worker', 'chat_o', 'th_2')]

    expect(chooseBoundThread(threads, 'worker')?.threadId).toBe('th_2')
  })

  it('picks the latest chat that orchestrates a run, by its main thread', () => {
    const threads = [found('orchestrator', 'chat_a', null), found('orchestrator', 'chat_b', null), found('orchestrator', 'chat_b', 'th_x')]

    expect(chooseBoundThread(threads, 'orchestrator')).toEqual(found('orchestrator', 'chat_b', null))
  })

  it('is null when no thread has the role: an attempt worked outside a chat looks unbound', () => {
    expect(chooseBoundThread([], 'worker')).toBeNull()
    expect(chooseBoundThread([found('orchestrator', 'chat_o', null)], 'worker')).toBeNull()
    expect(chooseBoundThread([found('worker', 'chat_o', 'th_1')], 'orchestrator')).toBeNull()
  })
})
