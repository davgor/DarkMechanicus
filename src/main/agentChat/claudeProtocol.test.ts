import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import type { ChatItem } from '../../shared/agents/chat'
import { agentChatEventSchema, type AgentChatAnswer } from '../../shared/agents/agentChat'
import { claudeInitLines, createClaudeProtocolState, encodeClaudeCommand, translateClaudeLine, type ClaudeProtocolEvent, type ClaudeProtocolState } from './claudeProtocol'
import { webpBytes } from '../../test/images'
import type { ToolResultBlob } from './toolResultImages'
import type { ThreadClaimEvent } from './translatorEvents'

const at = '2026-11-24T00:00:00.000Z'
const directory = join(import.meta.dirname, '__fixtures__', 'claude')
const scenarios = ['init', 'text', 'tool', 'subagent', 'approval', 'approval_chat', 'question', 'question_multi', 'interrupt', 'error', 'queued', 'subagent_tree', 'todo', 'tasks', 'todo_fail', 'edit']
function fixture(name: string, direction = 'out'): string[] {
  const raw = readFileSync(join(directory, `${name}.${direction}.jsonl`), 'utf8')
  expect(raw).not.toContain('\r')
  return raw.trimEnd().split(/\r?\n/)
}
function initialized(): ClaudeProtocolState {
  let state = claudeInitLines(createClaudeProtocolState(), 'req_T1_initialize').state
  for (const line of fixture('init')) state = translateClaudeLine(line, state, at).state
  return state
}
function feed(lines: string[], initial = initialized()): { state: ClaudeProtocolState; events: ClaudeProtocolEvent[]; internalEvents: ThreadClaimEvent[]; items: ChatItem[]; blobs: ToolResultBlob[] } {
  let state = initial
  const events: ClaudeProtocolEvent[] = []
  const internalEvents: ThreadClaimEvent[] = []
  const blobs: ToolResultBlob[] = []
  for (const line of lines) {
    const next = translateClaudeLine(line, state, at)
    state = next.state
    events.push(...next.events)
    internalEvents.push(...next.internalEvents)
    blobs.push(...next.blobs)
  }
  const items = new Map<string, ChatItem>()
  for (const event of events) if (event.type === 'item') items.set(event.item.id, event.item)
  return { state, events, internalEvents, items: [...items.values()], blobs }
}
function text(id: string, value: string, threadId?: string): ChatItem {
  return { kind: 'assistant_text', id: `${id}:0`, at, ...(threadId ? { threadId } : {}), text: value }
}
function tool(...[id, name, input, resultSummary, threadId, status = 'completed']: [string, string, Record<string, unknown>, string | null, string?, string?]): ChatItem {
  return { kind: 'tool_call', id: `toolu_T1_${id}`, at, ...(threadId ? { threadId } : {}), name, input, resultSummary, status } as ChatItem
}
function thread(id: string, label: string, state: 'running' | 'done', parent?: string): ChatItem {
  return { kind: 'thread', id: `thread:toolu_T1_${id}`, at, ...(parent ? { threadId: parent } : {}), parentItemId: `toolu_T1_${id}`, label, state }
}
const file = 'C:\\fixture\\repo\\a.txt'
const worker = 'thread:toolu_T1_worker'
const worker1 = 'thread:toolu_T1_worker1'
const worker2 = 'thread:toolu_T1_worker2'
const todoWorker = 'thread:toolu_T1_todoworker'
const questions = [{ question: 'Which database?', header: 'Database', options: [
  { label: 'SQLite', description: 'Local database' }, { label: 'Postgres', description: 'Server database' }
], multiSelect: false }]
const multiQuestions = [{ question: 'Which letters?', header: 'Letters', options: ['A', 'B', 'C', 'D'].map(label => ({ label, description: `Letter ${label}` })), multiSelect: true },
  { ...questions[0] }]
const todos = [
  { content: 'Read file', activeForm: 'Reading file', status: 'in_progress' },
  { content: 'Edit file', activeForm: 'Editing file', status: 'pending' }
]
const nextTodos = [{ ...todos[0], status: 'completed' }, { ...todos[1], status: 'in_progress' }]
const approval: ChatItem = { kind: 'approval_request', id: 'approval:req_T1_approval', at,
  requestId: 'req_T1_approval', category: 'command', tool: 'Bash', summary: 'Bash', input: { command: 'echo hello' } }
const hello: ChatItem = { kind: 'assistant_text', id: 'msg_T1_text:1', at, text: 'Hello world' }
// Golden expectations are literal host outputs, not generated from the translator or fixture frames.
const expected: Record<string, ChatItem[]> = {
  init: [], text: [hello], queued: [hello],
  tool: [tool('read', 'Read', { file_path: file }, 'alpha'), text('msg_T1_22', 'alpha')],
  subagent: [tool('worker', 'Task', { description: 'Servitor:READ Read file', prompt: 'Read a.txt', subagent_type: 'general-purpose' }, 'alpha'),
    thread('worker', 'Servitor:READ Read file', 'done'), tool('nestedread', 'Read', { file_path: file }, 'alpha', worker), text('msg_T1_31', 'alpha', worker)],
  approval: [tool('approval', 'Bash', { command: 'echo hello' }, 'hello'), approval],
  approval_chat: [tool('approval', 'Bash', { command: 'echo hello' }, 'hello'), approval],
  question: [tool('question', 'AskUserQuestion', { questions }, 'SQLite'),
    { kind: 'approval_request', id: 'approval:req_T1_question', at, requestId: 'req_T1_question', category: 'other',
      tool: 'AskUserQuestion', summary: 'Which database?', input: { questions } }],
  question_multi: [tool('question_multi', 'AskUserQuestion', { questions: multiQuestions }, 'Answered'),
    { kind: 'approval_request', id: 'approval:req_T1_question_multi', at, requestId: 'req_T1_question_multi', category: 'other',
      tool: 'AskUserQuestion', summary: 'Which letters?', input: { questions: multiQuestions } },
    text('msg_T1_134', 'answers: {"Which letters?":"A, C","Which database?":"SQLite"}')],
  interrupt: [hello, { kind: 'turn_stopped', id: 'stopped:uuid_T1_51', at }],
  error: [{ kind: 'error', id: 'error:uuid_T1_53', at, message: 'Fixture provider failure' }],
  subagent_tree: [
    tool('worker1', 'Agent', { description: 'Acolyte:DM-1 Add retry banner', prompt: 'Assigned ticket. [claim token masked]', subagent_type: 'general-purpose' }, 'Launched'),
    thread('worker1', 'Acolyte:DM-1 Add retry banner', 'done'), tool('read1', 'Read', { file_path: file }, 'alpha', worker1), text('msg_T1_63', 'Working', worker1),
    tool('worker2', 'Agent', { description: 'Acolyte:DM-2 Fix lint', prompt: 'Assigned ticket. [claim token masked]', subagent_type: 'general-purpose' }, 'Launched'),
    thread('worker2', 'Acolyte:DM-2 Fix lint', 'running'), tool('read2', 'Read', { file_path: file }, 'alpha', worker2), text('msg_T1_71', 'Working', worker2),
    tool('review', 'Agent', { description: 'Inquisitor:DM-2 Review diff', prompt: 'Review the diff', subagent_type: 'general-purpose' }, null, worker2, 'running'),
    thread('review', 'Inquisitor:DM-2 Review diff', 'running', worker2)
  ],
  todo: [tool('todo1', 'TodoWrite', { todos }, 'Todos have been modified successfully.'),
    tool('todo2', 'TodoWrite', { todos: nextTodos }, 'Todos have been modified successfully.'),
    tool('todoworker', 'Agent', { description: 'Servitor:TODO Track review', prompt: 'Review', subagent_type: 'general-purpose' }, 'Reviewed'),
    thread('todoworker', 'Servitor:TODO Track review', 'done'), tool('todo3', 'TodoWrite', { todos }, 'Todos have been modified successfully.', todoWorker)],
  todo_fail: [tool('todofail', 'TodoWrite', { todos: [{ content: 'Invalid', status: 'invalid' }] }, 'Invalid status', undefined, 'failed')],
  tasks: [tool('create1', 'TaskCreate', { subject: 'Task 1', description: 'Do task 1', activeForm: 'Doing task 1' }, 'Task #1 created successfully: Task 1'),
    tool('create2', 'TaskCreate', { subject: 'Task 2', description: 'Do task 2', activeForm: 'Doing task 2' }, 'Task #2 created successfully: Task 2'),
    tool('update1', 'TaskUpdate', { taskId: '1', status: 'in_progress' }, 'Updated task #1 status'),
    tool('update2', 'TaskUpdate', { taskId: '1', status: 'completed' }, 'Updated task #1 status'),
    tool('update3', 'TaskUpdate', { taskId: '99', status: 'completed' }, 'Task not found: 99', undefined, 'failed')],
  edit: [tool('edit', 'Edit', { file_path: file, old_string: 'alpha', new_string: 'beta' }, 'Updated'),
    tool('write', 'Write', { file_path: 'C:\\fixture\\repo\\b.txt', content: 'beta' }, 'Written'),
    tool('notebook', 'NotebookEdit', { notebook_path: 'C:\\fixture\\repo\\book.ipynb', new_source: 'print(1)', edit_mode: 'insert', cell_type: 'code' }, 'Updated')]
}

  it('covers every pinned pair without CR characters', () => {
    const all = [...scenarios, 'worker_approval', 'image_in', 'image_result']
    expect(readdirSync(directory).filter(name => name.endsWith('.out.jsonl')).sort()).toEqual(all.map(name => `${name}.out.jsonl`).sort())
    for (const name of all) { fixture(name); fixture(name, 'in') }
  })
  it.each(scenarios)('%s produces the exact ordered items and commits text deltas once', name => {
    let initial = initialized()
    if (name === 'interrupt') initial = encodeClaudeCommand({ type: 'interrupt', requestId: 'req_T1_interrupt' }, initial, at).state
    if (name === 'init') initial = claudeInitLines(createClaudeProtocolState(), 'req_T1_initialize').state
    const result = feed(fixture(name), initial)
    expect(result.items).toEqual(expected[name])
    expect(result.state.skipped).toBe(0)
    expect(JSON.stringify(result.events)).not.toContain('fixtureSecret')
    const deltas = new Map<string, string>()
    for (const event of result.events) {
      expect(agentChatEventSchema.safeParse({ folder: null, chatId: 'fixture', ...event }).success).toBe(true)
      if (event.type === 'delta' && event.kind === 'text') deltas.set(event.itemId, (deltas.get(event.itemId) ?? '') + event.text)
    }
    for (const [id, value] of deltas) {
      const commits = result.events.filter(event => event.type === 'item' && event.item.id === id)
      expect(commits).toEqual([{ type: 'item', item: result.items.find(item => item.id === id) }])
      expect(result.items.find(item => item.id === id)).toMatchObject({ kind: 'assistant_text', text: value })
    }
    if (name !== 'init') expect(result.events.at(-1)).toEqual({ type: 'status', status: 'idle' })
  })
  it.each(scenarios)('%s encodes every exact input envelope', name => {
    let state = initialized()
    const output: string[] = []
    for (const line of fixture(name, 'in')) {
      const expectedLine = JSON.parse(line)
      if (expectedLine.type === 'control_request' && expectedLine.request.subtype === 'initialize') {
        output.push(...claudeInitLines(createClaudeProtocolState(), expectedLine.request_id).lines)
      } else if (expectedLine.type === 'user') {
        const result = encodeClaudeCommand({ type: 'send', text: expectedLine.message.content, uuid: expectedLine.uuid, sessionId: expectedLine.session_id }, state, at)
        state = result.state; output.push(...result.lines)
        expect(result.events[0]).toEqual({ type: 'item', item: { kind: 'user_message', id: expectedLine.uuid, at, text: expectedLine.message.content } })
      } else if (expectedLine.type === 'control_request') {
        const result = encodeClaudeCommand({ type: 'interrupt', requestId: expectedLine.request_id }, state, at)
        state = result.state; output.push(...result.lines)
      } else {
        state = feed(fixture(name).slice(0, 2), state).state
        const answers: AgentChatAnswer[] = name === 'question_multi'
          ? [{ promptId: 'req_T1_question_multi', optionIds: ['option_0', 'option_2'] }, { promptId: 'req_T1_question_multi:question:1', optionId: 'option_0' }]
          : [{ promptId: expectedLine.response.request_id, optionId: name === 'question' ? 'option_0' : name === 'approval_chat' ? 'allow_chat' : 'allow_once' }]
        for (const answer of answers) {
          const result = encodeClaudeCommand({ type: 'answer', ...answer }, state, at)
          state = result.state; output.push(...result.lines)
        }
      }
    }
    expect(output).toEqual(fixture(name, 'in'))
  })
  it('normalizes successful per-thread todos and preserves failed calls', () => {
    const events = feed(fixture('todo')).events.filter(event => event.type === 'todos')
    const phases = (tasks: typeof todos): unknown[] => [{ name: '', tasks: tasks.map(task => ({ id: null, ...task })) }]
    expect(events).toEqual([
      { type: 'todos', threadId: null, phases: phases(todos) },
      { type: 'todos', threadId: null, phases: phases(nextTodos) },
      { type: 'todos', threadId: todoWorker, phases: phases(todos) }
    ])
    expect(feed(fixture('todo_fail')).events.filter(event => event.type === 'todos')).toEqual([])
    const tasks = feed(fixture('tasks')).events.filter(event => event.type === 'todos')
    expect(tasks).toHaveLength(4)
    expect(tasks.at(-1)).toEqual({ type: 'todos', threadId: null, phases: [{ name: '', tasks: [
      { id: '1', content: 'Task 1', activeForm: 'Doing task 1', status: 'completed' },
      { id: '2', content: 'Task 2', activeForm: 'Doing task 2', status: 'pending' }
    ] }] })
  })

const json = JSON.stringify
function approvalRequest(id: string, toolUseId = 'unknown', extra = {}): string {
  return json({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: toolUseId, input: { command: 'echo hello' }, ...extra } })
}
function streamed(event: unknown): string { return json({ type: 'stream_event', event }) }

  it('skips invalid JSON and unknown shapes without throwing', () => {
    const lines = ['', '{', 'null', '[]', '123', '{}', '{"type":"future"}', '{"type":"stream_event"}', '{"type":"assistant"}', '{"type":"control_request","request":{"subtype":"future"}}']
    const result = feed(lines)
    expect(result.events).toEqual([])
    expect(result.state.skipped).toBe(lines.length)
  })
  it('requires correlated initialize success, never system/init or an unrelated receipt', () => {
    let state = createClaudeProtocolState()
    state = translateClaudeLine(fixture('init')[1], state, at).state
    expect(encodeClaudeCommand({ type: 'send', text: 'blocked', uuid: 'blocked' }, state, at).lines).toEqual([])
    const init = claudeInitLines(state, 'fresh')
    expect(claudeInitLines(init.state, 'another').lines).toEqual([])
    state = translateClaudeLine(fixture('init')[0], init.state, at).state
    expect(state.initialized).toBe(false)
    state = translateClaudeLine(json({ type: 'control_response', response: { subtype: 'error', request_id: 'fresh', error: 'refused' } }), state, at).state
    expect(state.initialized).toBe(false)
  })
  it('attributes child requests by tool or agent and leaves an ambiguous request unattributed', () => {
    let state = feed(fixture('subagent').slice(0, 2)).state
    const child = feed([approvalRequest('child', 'toolu_T1_nestedread')], state)
    expect(child.events.find(event => event.type === 'pending')).toMatchObject({ prompt: { threadId: worker, attributed: true, callsign: null, arbitration: { state: 'off', reason: null } } })
    expect(child.items[0]).toMatchObject({ threadId: worker })
    expect(feed([approvalRequest('unknown')], state).events.at(-1)).toMatchObject({ prompt: { threadId: null, attributed: false } })
    state = feed(fixture('subagent_tree').slice(0, 2)).state
    expect(feed([approvalRequest('agent', 'unknown', { agent_id: 'agent_T1_1' })], state).events.at(-1)).toMatchObject({ prompt: { threadId: worker1, attributed: true } })
    expect(feed([approvalRequest('main')]).events.at(-1)).toMatchObject({ prompt: { threadId: null, attributed: true } })
  })
  it('only matching foreground results and correlated notifications finish threads', () => {
    const start = fixture('subagent_tree').slice(0, 11)
    const state = feed(start).state
    const unrelated = feed([json({ type: 'system', subtype: 'task_notification', task_id: 'unknown', status: 'completed' })], state)
    expect(unrelated.events).toEqual([])
    const done = feed([json({ type: 'system', subtype: 'task_notification', task_id: 'agent_T1_2', status: 'failed' })], state)
    expect(done.items).toEqual([{ ...expected.subagent_tree[5], state: 'failed' }])
    expect(done.state.threads.get('toolu_T1_worker1')?.state).toBe('running')
    const foreground = fixture('subagent')[4].replace('"is_error":false', '"is_error":true')
    expect(feed([foreground], feed(fixture('subagent').slice(0, 2)).state).state.threads.get('toolu_T1_worker')?.state).toBe('failed')
    const asyncFrame = fixture('subagent_tree')[1].replace('"status":"async_launched"', '"isAsync":true')
    const asyncState = feed([fixture('subagent_tree')[0], asyncFrame, fixture('subagent_tree').at(-1)!]).state
    expect(asyncState.threads.get('toolu_T1_worker1')?.state).toBe('running')
    expect(asyncState.threads.get('toolu_T1_worker1')?.at).toBe(at)
  })
  it('keeps held original inputs, session-only suggestions and denies invalid answer choices', () => {
    const input = { command: 'echo dmg_' + '0123456789abcdef'.repeat(4) }
    const state = feed([approvalRequest('held', 'unknown', { input, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'userSettings' }] })]).state
    const answer = { type: 'answer' as const, promptId: 'held', optionId: 'allow_chat', updatedInput: { command: 'evil' } }
    const result = encodeClaudeCommand(answer, state, at)
    expect(JSON.parse(result.lines[0])).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'held', response: {
      behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }]
    } } })
    expect(result.state.pending.size).toBe(0)
    expect(encodeClaudeCommand(answer, result.state, at).lines).toEqual([])
    expect(encodeClaudeCommand({ type: 'answer', promptId: 'plain', optionId: 'allow_chat' }, feed([approvalRequest('plain')]).state, at).lines).toEqual([])
    expect(JSON.parse(encodeClaudeCommand({ type: 'answer', promptId: 'held', optionId: 'deny', text: 'No' }, state, at).lines[0]).response.response).toEqual({ behavior: 'deny', message: 'No' })
  })
  it('preserves question options and maps multiple answers into the held input', () => {
    const input = { questions: [...questions, { ...questions[0], question: 'Which backup?' }], other: 'held' }
    const result = feed([approvalRequest('question', 'unknown', { tool_name: 'AskUserQuestion', input })])
    expect(result.items).toEqual([expect.objectContaining({ kind: 'approval_request', requestId: 'question', tool: 'AskUserQuestion', category: 'other' })])
    expect(result.events.at(-1)).toMatchObject({ type: 'pending', prompt: { kind: 'question', multi: false, progress: { index: 1, total: 2 }, options: [
      { id: 'option_0', label: 'SQLite', description: 'Local database' }, { id: 'option_1', label: 'Postgres', description: 'Server database' }, { id: 'text', label: 'Other' }
    ] } })
    const answers = { 'Which database?': 'SQLite', 'Which backup?': 'Postgres' }
    const first = encodeClaudeCommand({ type: 'answer', promptId: 'question', optionId: 'option_0' }, result.state, at)
    expect(first.lines).toEqual([])
    expect(first.events).toMatchObject([
      { type: 'item', item: { kind: 'approval_decision', requestId: 'question', decision: 'allow_once' } },
      { type: 'item', item: { kind: 'user_message', text: 'SQLite' } },
      { type: 'pending', prompt: { id: 'question:question:1', title: 'Which backup?', progress: { index: 2, total: 2 } } },
      { type: 'item', item: { kind: 'approval_request', requestId: 'question:question:1', summary: 'Which backup?' } }
    ])
    const last = encodeClaudeCommand({ type: 'answer', promptId: 'question:question:1', optionId: 'option_1' }, first.state, at)
    expect(JSON.parse(last.lines[0])).toEqual({ type: 'control_response', response: { subtype: 'success', request_id: 'question', response: { behavior: 'allow', updatedInput: { ...input, answers } } } })
    expect(last.events.filter(event => event.type === 'item')).toMatchObject([
      { item: { kind: 'approval_decision', requestId: 'question:question:1', decision: 'allow_once' } },
      { item: { kind: 'user_message', text: 'Postgres' } }
    ])
  })
  it('answers a multiSelect question with the chosen labels in option order, as Claude Code encodes them', () => {
    const input = { questions: [multiQuestions[0], { ...multiQuestions[0], question: 'Which tags?', options: [{ label: 'x, y' }, { label: 'say "hi"' }, { label: 'plain' }] }, questions[0]] }
    const result = feed([approvalRequest('multi', 'unknown', { tool_name: 'AskUserQuestion', input })])
    expect(result.events.at(-1)).toMatchObject({ type: 'pending', prompt: { id: 'multi', multi: true, progress: { index: 1, total: 3 } } })
    for (const optionIds of [['option_0', 'option_7'], ['option_0', 'option_0'], ['option_0', 'text']]) {
      const refused = encodeClaudeCommand({ type: 'answer', promptId: 'multi', optionIds }, result.state, at)
      expect([refused.lines, refused.events, refused.state.pending.get('multi')?.prompt.id]).toEqual([[], [], 'multi'])
    }
    const first = encodeClaudeCommand({ type: 'answer', promptId: 'multi', optionIds: ['option_2', 'option_0'] }, result.state, at)
    expect(first.events).toMatchObject([{ item: { kind: 'approval_decision' } }, { item: { kind: 'user_message', text: 'A, C' } },
      { type: 'pending', prompt: { id: 'multi:question:1', multi: true, progress: { index: 2, total: 3 } } }, { item: { kind: 'approval_request' } }])
    // A label holding ", " or a quote is written as a JSON string, as Claude Code's own dialog writes it; the free text comes last.
    const second = encodeClaudeCommand({ type: 'answer', promptId: 'multi:question:1', optionIds: ['text', 'option_1', 'option_0'], text: 'mine' }, first.state, at)
    expect(second.events).toMatchObject([{}, { item: { text: '"x, y", "say \\"hi\\"", mine' } }, { prompt: { id: 'multi:question:2', multi: false, progress: { index: 3, total: 3 } } }, {}])
    expect(encodeClaudeCommand({ type: 'answer', promptId: 'multi:question:2', optionIds: ['option_0'] }, second.state, at).lines).toEqual([])
    const last = encodeClaudeCommand({ type: 'answer', promptId: 'multi:question:2', optionId: 'option_1' }, second.state, at)
    expect(JSON.parse(last.lines[0]).response.response).toEqual({ behavior: 'allow', updatedInput: { ...input,
      answers: { 'Which letters?': 'A, C', 'Which tags?': '"x, y", "say \\"hi\\"", mine', 'Which database?': 'Postgres' } } })
  })
  it('refuses optionIds on an approval', () => {
    const state = feed([approvalRequest('plain')]).state
    expect(encodeClaudeCommand({ type: 'answer', promptId: 'plain', optionIds: ['allow_once'] }, state, at).lines).toEqual([])
  })
  it('masks tokens before clipping and across streamed chunk boundaries', () => {
    const claim = 'at_01j0000000000000000000000a.fixtureSecretAAAAAAAAAAAAAAAAAAA'
    const grant = 'dmg_' + '0123456789abcdef'.repeat(4)
    const secret = `${claim} ${grant}`
    const toolLines = [fixture('tool')[3], json({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_T1_read', content: 'x'.repeat(3980) + secret }] } })]
    const events = feed(toolLines).events
    const streamedResult = feed([
      streamed({ type: 'message_start', message: { id: 'secret' } }),
      streamed({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ...[secret.slice(0, 2), secret.slice(2, 40), secret.slice(40)].map(text => streamed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
      json({ type: 'assistant', message: { id: 'secret', content: [{ type: 'text', text: secret }] } })
    ])
    const pending = feed([approvalRequest('masked', 'unknown', { title: secret, description: secret, input: { command: secret } })]).events
    const all = json([...events, ...streamedResult.events, ...pending])
    expect(all).not.toContain('fixtureSecret')
    expect(all).not.toContain('0123456789abcdef')
    expect(all).not.toContain(claim)
    expect(all).not.toContain(grant)
    expect(events.at(-1)).toMatchObject({ item: { resultSummary: 'x'.repeat(3980) + '[claim token masked]'.slice(0, 20) } })
  })
  it('handles blockwise final frames, forwarded user text, repeated frames and immutable prior state', () => {
    const initial = initialized()
    const lines = [streamed({ type: 'message_start', message: { id: 'blocks' } }),
      streamed({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'reason' } }),
      streamed({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'answer' } }),
      json({ type: 'assistant', message: { id: 'blocks', content: [{ type: 'thinking', thinking: 'reason' }] } }),
      json({ type: 'assistant', uuid: 'final', message: { id: 'blocks', content: [{ type: 'text', text: 'answer' }] } })]
    const result = feed([...lines, lines.at(-1)!], initial)
    expect(initial.messages.size).toBe(0)
    expect(result.items).toEqual([{ kind: 'assistant_text', id: 'blocks:1', at, text: 'answer' }])
    const forwarded = feed([json({ type: 'user', uuid: 'forwarded', parent_tool_use_id: 'toolu_T1_worker', message: { content: 'child text' } })], feed(fixture('subagent').slice(0, 1)).state)
    expect(forwarded.items).toEqual([text('forwarded', 'child text', worker)])
  })
  it('rejects malformed todo lists and unknown task updates without replacing prior lists', () => {
    const state = feed(fixture('todo')).state
    const invalid = fixture('todo_fail').slice(0, 2).map(line => line.replace('"is_error":true', '"is_error":false'))
    const result = feed(invalid, state)
    expect(result.state.skipped).toBe(state.skipped + 1)
    expect(result.state.todos).toEqual(state.todos)
    expect(result.events.filter(event => event.type === 'todos')).toEqual([])
    const taskState = feed(fixture('tasks').slice(0, 8)).state
    const unknown = feed(fixture('tasks').slice(8, 10).map(line => line.replace('"is_error":true', '"is_error":false')), taskState)
    expect(unknown.state.tasks).toEqual(taskState.tasks)
    expect(unknown.events.filter(event => event.type === 'todos')).toEqual([])
  })
  it('keeps full file paths, sanitized labels and first thread timestamps', () => {
    const path = 'C:\\' + 'p'.repeat(3000)
    const start = json({ type: 'assistant', message: { id: 'long', content: [
      { type: 'tool_use', id: 'long-agent', name: 'Agent', input: { description: '\u0000'.repeat(140) + 'Worker', prompt: 'Never the label' } },
      { type: 'tool_use', id: 'path-tool', name: 'AnyTool', input: { path, file_path: path, notebook_path: path } }
    ] } })
    const result = feed([start])
    expect(result.state.threads.get('long-agent')?.label).toBe('Worker')
    expect(result.items.at(-1)).toMatchObject({ input: { path, file_path: path, notebook_path: path } })
    const done = translateClaudeLine(json({ type: 'system', subtype: 'task_notification', tool_use_id: 'long-agent', status: 'completed' }), result.state, 'later')
    expect(done.events).toEqual([{ type: 'item', item: { kind: 'thread', id: 'thread:long-agent', parentItemId: 'long-agent', label: 'Worker', at, state: 'done' } }])
  })
  it('isolates incremental tasks by thread and discards failed create reservations', () => {
    const main = feed(fixture('tasks').slice(0, 4))
    let state = feed(fixture('subagent').slice(0, 1), main.state).state
    const child = fixture('tasks').slice(0, 2).map(line => {
      const frame = JSON.parse(line)
      frame.uuid += '_child'
      frame.parent_tool_use_id = 'toolu_T1_worker'
      if (frame.type === 'assistant') { frame.message.id += '_child'; frame.message.content[0].id += '_child' }
      else frame.message.content[0].tool_use_id += '_child'
      return json(frame)
    })
    state = feed(child, state).state
    expect(state.tasks.get(null)?.tasks).toHaveLength(2)
    expect(state.tasks.get(worker)?.tasks).toHaveLength(1)
    const failed = feed(child.map(line => line.replaceAll('_child', '_failed').replace('"is_error":false', '"is_error":true')), state)
    expect(failed.state.tasks.get(worker)?.tasks).toEqual(state.tasks.get(worker)?.tasks)
    expect(failed.state.tasks.get(worker)?.pendingCreates).toEqual({})
    expect(failed.events.filter(event => event.type === 'todos')).toEqual([])
  })
  it('does not cancel background prompts when the main turn fails', () => {
    const state = feed([...fixture('subagent').slice(0, 2), approvalRequest('child', 'toolu_T1_nestedread'), approvalRequest('main')]).state
    const failed = feed(fixture('error'), state)
    expect(failed.state.pending.has('child')).toBe(true)
    expect(failed.state.pending.has('main')).toBe(false)
    expect(failed.state.threads.get('toolu_T1_worker')?.state).toBe('running')
  })
  it('retains a tool block index before a later single-block text frame', () => {
    const result = feed([
      json({ type: 'assistant', message: { id: 'mixed', content: [{ type: 'tool_use', id: 'mixed-tool', name: 'Read', input: {} }] } }),
      json({ type: 'assistant', message: { id: 'mixed', content: [{ type: 'text', text: 'after tool' }] } })
    ])
    expect(result.items.at(-1)).toEqual({ kind: 'assistant_text', id: 'mixed:1', at, text: 'after tool' })
  })
  it('creates a separate resumed thread and uses observed task-started attribution', () => {
    let state = feed([json({ type: 'assistant', parent_tool_use_id: 'resumed-spawn', message: { id: 'resumed', content: [{ type: 'text', text: 'child' }] } })]).state
    expect(state.threads.get('resumed-spawn')).toEqual({ kind: 'thread', id: 'thread:resumed-spawn', at, parentItemId: 'resumed-spawn', label: 'Subagent', state: 'running' })
    state = feed([json({ type: 'system', subtype: 'task_started', tool_use_id: 'resumed-spawn', task_id: 'resumed-agent' })], state).state
    expect(feed([approvalRequest('resumed-request', 'unknown', { agent_id: 'resumed-agent' })], state).events.at(-1)).toMatchObject({ prompt: { threadId: 'thread:resumed-spawn', attributed: true } })
  })

it('distinguishes text and Other labels from the explicit custom-answer selector', () => {
  const input = { questions: [{ question: 'Choice?', options: [{ label: 'text' }, { label: 'Other' }] }] }
  const state = feed([approvalRequest('collision', 'unknown', { tool_name: 'AskUserQuestion', input })]).state
  const answer = (optionId: string, text?: string) =>
    encodeClaudeCommand({ type: 'answer', promptId: 'collision', optionId, text }, state, at)
  expect(state.pending.get('collision')?.prompt.options).toEqual([
    { id: 'option_0', label: 'text' }, { id: 'option_1', label: 'Other' }, { id: 'text', label: 'Other' }
  ])
  expect(JSON.parse(answer('option_0', 'ignored replacement').lines[0]).response.response.updatedInput.answers).toEqual({ 'Choice?': 'text' })
  expect(JSON.parse(answer('option_1').lines[0]).response.response.updatedInput.answers).toEqual({ 'Choice?': 'Other' })
  expect(JSON.parse(answer('text', 'custom').lines[0]).response.response.updatedInput.answers).toEqual({ 'Choice?': 'custom' })
  expect(answer('other', 'forbidden').lines).toEqual([])
  expect(answer('option_999', 'forbidden').lines).toEqual([])
  expect(answer('text').lines).toEqual([])
})

it('offers only Answer for a text-only question', () => {
  const result = feed([approvalRequest('free', 'unknown', { tool_name: 'AskUserQuestion', input: { questions: [{ question: 'Explain?' }] } })])
  expect(result.events).toMatchObject([
    { type: 'item', item: { kind: 'approval_request', requestId: 'free', category: 'other', tool: 'AskUserQuestion', summary: 'Explain?' } },
    { type: 'pending', prompt: { id: 'free', kind: 'question', options: [{ id: 'text', label: 'Answer' }] } }
  ])
  const response = encodeClaudeCommand({ type: 'answer', promptId: 'free', optionId: 'text', text: 'Because' }, result.state, at)
  expect(JSON.parse(response.lines[0]).response.response.updatedInput.answers).toEqual({ 'Explain?': 'Because' })
})

it('starts a new text block with its own delta offset after a committed block', () => {
  const result = feed(['first', 'second'].map(text =>
    json({ type: 'assistant', message: { id: 'blockwise', content: [{ type: 'text', text }] } })))
  expect(result.items).toEqual([
    { kind: 'assistant_text', id: 'blockwise:0', at, text: 'first' },
    { kind: 'assistant_text', id: 'blockwise:1', at, text: 'second' }
  ])
  expect(result.events.filter(event => event.type === 'delta')).toEqual([
    { type: 'delta', itemId: 'blockwise:0', kind: 'text', text: 'first' },
    { type: 'delta', itemId: 'blockwise:1', kind: 'text', text: 'second' }
  ])
})

it.each(['dmg_', 'DMG_'])('masks a %s grant split at every character boundary', prefix => {
  const grant = prefix + '0123456789abcdef'.repeat(4)
  const result = feed([
    streamed({ type: 'message_start', message: { id: 'grant-chunks' } }),
    streamed({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ...[...grant].map(text => streamed({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })),
    json({ type: 'assistant', message: { id: 'grant-chunks', content: [{ type: 'text', text: grant }] } })
  ])
  expect(result.events.filter(event => event.type === 'delta')).toEqual([
    { type: 'delta', itemId: 'grant-chunks:0', kind: 'text', text: '[grant token masked]' }
  ])
  expect(result.items).toEqual([{ kind: 'assistant_text', id: 'grant-chunks:0', at, text: '[grant token masked]' }])
})

it('keeps worker claim credentials on the private channel and attributes its answered approval', () => {
  const lines = fixture('worker_approval')
  const started = feed(lines.slice(0, 3))
  const threadId = 'thread:toolu_T1_claim_worker'
  const claim = { type: 'thread_claim', threadId, attemptId: 'at_01j0000000000000000000000a',
    token: 'at_01j0000000000000000000000a.fixtureSecretAAAAAAAAAAAAAAAAAAA' }
  expect(started.internalEvents).toEqual([claim])
  expect(started.events.find(event => event.type === 'pending')).toMatchObject({ prompt: { threadId, kind: 'approval' } })
  expect(agentChatEventSchema.safeParse({ ...claim, folder: null, chatId: 'fixture' }).success).toBe(false)
  const answered = encodeClaudeCommand({ type: 'answer', promptId: 'req_T1_worker_approval', optionId: 'allow_once' }, started.state, at)
  expect(answered.lines).toEqual(fixture('worker_approval', 'in').slice(1))
  const finished = feed(lines.slice(3), answered.state)
  expect(finished.internalEvents).toEqual([])
  expect(finished.items).toContainEqual(expect.objectContaining({ id: threadId, kind: 'thread', state: 'done' }))
  const events = [...started.events, ...answered.events, ...finished.events]
  expect(JSON.stringify(events)).not.toContain('fixtureSecret')
  for (const event of events) expect(agentChatEventSchema.safeParse({ ...event, folder: null, chatId: 'fixture' }).success).toBe(true)
})

it.each(['Agent', 'Task'])('extracts exactly one complete token from %s, never ambiguous claims', name => {
  const token = 'at_01j0000000000000000000000a.fixtureSecretAAAAAAAAAAAAAAAAAAA'
  const other = 'at_01j0000000000000000000000b.fixtureSecretBBBBBBBBBBBBBBBBBBB'
  for (const [prompt, count] of [['no claim', 0], [token, 1], [`${token} ${token}`, 1],
    [`${token} ${other}`, 0], [`${token} ${token.replace('fixtureSecret', 'differentSecret')}`, 0]] as const) {
    const frame = { type: 'assistant', message: { id: 'claim-message', content: [
      { type: 'tool_use', id: 'claim-spawn', name, input: { prompt, description: 'Worker' } }
    ] } }
    const result = feed([JSON.stringify(frame), JSON.stringify(frame)])
    expect(result.internalEvents).toHaveLength(count)
    expect(JSON.stringify(result.events)).not.toContain('Secret')
  }
})

const swatch = readFileSync(join(import.meta.dirname, '__fixtures__', 'images', 'swatch.png'))
const swatchBase64 = swatch.toString('base64')
const swatchImage = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: swatchBase64 } }

it('encodes image_in byte for byte with images before text, and keeps base64 out of events', () => {
  const [line] = fixture('image_in', 'in'), wire = JSON.parse(line)
  const images = [{ mime: 'image/png' as const, base64: swatchBase64 }]
  const result = encodeClaudeCommand({ type: 'send', text: 'what colour', uuid: wire.uuid, sessionId: wire.session_id, images }, initialized(), at)
  expect(result.lines).toEqual(fixture('image_in', 'in'))
  expect(result.events).toEqual([{ type: 'item', item: { kind: 'user_message', id: wire.uuid, at, text: 'what colour' } }, { type: 'status', status: 'busy' }])
  expect(JSON.stringify(result.events)).not.toContain(swatchBase64.slice(0, 32))
  const imageOnly = encodeClaudeCommand({ type: 'send', text: '', uuid: 'uuid_T1_image_only', images: [...images, { mime: 'image/jpeg', base64: 'AAAA' }] }, initialized(), at)
  expect(JSON.parse(imageOnly.lines[0]).message.content).toEqual([swatchImage,
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }])
  expect(feed(fixture('image_in')).blobs).toEqual([])
})

it('lifts image_result into exactly one blob equal to swatch.png and no event', () => {
  const result = feed(fixture('image_result'))
  expect(result.blobs).toEqual([{ itemId: 'toolu_T1_read_image', mime: 'image/png', base64: swatchBase64 }])
  expect(Buffer.from(result.blobs[0].base64, 'base64').equals(swatch)).toBe(true)
  expect(JSON.stringify(result.events)).not.toContain(swatchBase64.slice(0, 32))
  expect(result.items).toEqual([tool('read_image', 'Read', { file_path: 'C:\\fixture\\repo\\swatch.png' }, ''), text('msg_T1_image_answer', 'Red')])
  expect(result.state.skipped).toBe(0)
  for (const event of result.events) expect(agentChatEventSchema.safeParse({ folder: null, chatId: 'fixture', ...event }).success).toBe(true)
  expect(feed(fixture('image_result'), result.state).blobs).toEqual([])
})

it('notes unsupported, mismatched and URL images as not shown, and lifts WebP tool images', () => {
  const webp = webpBytes(64, 64).toString('base64'), gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1').toString('base64')
  const image = (media_type: string, data: string): unknown => ({ type: 'image', source: { type: 'base64', media_type, data } })
  const use = json({ type: 'assistant', message: { id: 'msg_T1_images', content: [{ type: 'tool_use', id: 'toolu_T1_images', name: 'Read', input: { file_path: 'x' } }] } })
  const content = [{ type: 'text', text: 'Read' }, image('image/gif', gif), image('image/webp', webp), image('image/jpeg', swatchBase64),
    { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }, image('image/png', `${swatchBase64}#`)]
  const result = feed([use, json({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_T1_images', content }] } })])
  expect(result.blobs).toEqual([{ itemId: 'toolu_T1_images', mime: 'image/webp', base64: webp }])
  expect(result.items.at(-1)).toMatchObject({ status: 'completed', resultSummary: ['Read', '1 image (image/gif, not shown)',
    '1 image (image/jpeg, not shown)', '1 image (unknown type, not shown)', '1 image (image/png, not shown)'].join('\n') })
  for (const prefix of [webp, gif, swatchBase64]) expect(JSON.stringify(result.events)).not.toContain(prefix.slice(0, 32))
})
