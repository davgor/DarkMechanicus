import { expect, it } from 'vitest'
import { agentChatState, reduceAgentChat } from '../renderer/src/agentChat/agentChatModel'
import { createClaudeProtocolState, encodeClaudeCommand, translateClaudeLine, type ClaudeProtocolEvent, type ClaudeProtocolState } from '../main/agentChat/claudeProtocol'

const at = '2026-11-24T00:00:00.000Z'
const ref = { folder: null, chatId: 'regression' }
const stream = (event: unknown, parent_tool_use_id: string | null = null) => ({ type: 'stream_event', parent_tool_use_id, event })
function feed(frames: unknown[], state = createClaudeProtocolState()) {
  const events: ClaudeProtocolEvent[] = []
  for (const frame of frames) {
    const next = translateClaudeLine(JSON.stringify(frame), state, at)
    state = next.state
    events.push(...next.events)
  }
  return { state, events }
}
function start(id: string, parent: string | null = null) {
  return [stream({ type: 'message_start', message: { id } }, parent),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'Considering ' } }, parent)]
}
const result = { type: 'result', is_error: false }
const answer = { type: 'assistant', uuid: 'answer-frame', message: { id: 'main', content: [
  { type: 'thinking', thinking: 'Considering ' }, { type: 'text', text: 'The final answer.' }
] } }
const thinkingEnd = { type: 'stream_end', itemId: 'main:0' }
const question = (input: unknown) => ({ type: 'control_request', request_id: 'question', request: {
  subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input
} })

it.each(['success', 'failure', 'cancel'] as const)('retires main thinking on %s with a real reducer, retaining the answer and live worker', terminal => {
  let state = feed([...start('main'), ...start('worker-message', 'worker-spawn')]).state
  if (terminal === 'cancel') state = encodeClaudeCommand({ type: 'interrupt', requestId: 'stop' }, state, at).state
  const finish = terminal === 'success' ? result : { ...result, is_error: true,
    ...(terminal === 'cancel' ? { terminal_reason: 'aborted_streaming' } : { errors: ['Failed'] }) }
  const all = feed([...start('main'), ...start('worker-message', 'worker-spawn')]).events
  const completed = feed([answer, finish], state)
  const rendered = [...all, ...completed.events].reduce((model, event) => reduceAgentChat(model, { ...ref, ...event }, 42), agentChatState())
  expect(rendered.items.filter(item => item.kind === 'assistant_text')).toEqual([
    { kind: 'assistant_text', id: 'main:1', at, text: 'The final answer.' }
  ])
  expect([...rendered.streaming.keys()]).toEqual(['worker-message:0'])
  expect(rendered.streaming.get('worker-message:0')?.thinking).toBe('Considering ')
  expect(rendered.lastEventAt).toBe(42)
  expect(completed.events.filter(event => event.type === 'stream_end')).toEqual([thinkingEnd])
  expect(rendered.status).toBe('idle')
})

it.each(['success', 'failure', 'cancel'] as const)('retires unfinished thinking on %s without inventing any assistant answer', terminal => {
  let initial = feed(start('main')).state
  if (terminal === 'cancel') initial = encodeClaudeCommand({ type: 'interrupt', requestId: 'stop' }, initial, at).state
  const finished = feed([{ ...result, is_error: terminal !== 'success',
    ...(terminal === 'cancel' ? { terminal_reason: 'aborted_streaming' } : {}) }], initial)
  expect(finished.events.filter(event => event.type === 'stream_end')).toEqual([thinkingEnd])
  expect(finished.events.filter(event => event.type === 'item' && event.item.kind === 'assistant_text')).toEqual([])
})

it.each(['completed', 'failed', 'stopped'])('retires only the worker whose notification is %s', status => {
  const initial = feed([...start('main'), ...start('worker-message', 'worker-spawn'), ...start('other', 'other-spawn')])
  const completed = feed([{ type: 'system', subtype: 'task_notification', tool_use_id: 'worker-spawn', status }], initial.state)
  expect(completed.events.filter(event => event.type === 'stream_end')).toEqual([{ type: 'stream_end', itemId: 'worker-message:0' }])
  const rendered = [...initial.events, ...completed.events].reduce((model, event) => reduceAgentChat(model, { ...ref, ...event }), agentChatState())
  expect([...rendered.streaming.keys()]).toEqual(['main:0', 'other:0'])
})

it('retires a stopped thinking block exactly once across block stop, final frame, message stop and result', () => {
  const translated = feed([...start('main'), stream({ type: 'content_block_stop', index: 0 }), answer,
    stream({ type: 'message_stop' }), result])
  expect(translated.events.filter(event => event.type === 'stream_end')).toEqual([thinkingEnd])
  expect(translated.events.filter(event => event.type === 'item' && event.item.kind === 'assistant_text')).toHaveLength(1)
})

const toolStart = [stream({ type: 'message_start', message: { id: 'tools' } }),
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'actual-tool', name: 'Bash', input: {} } })]
const runningTool = { kind: 'tool_call', id: 'actual-tool', at, name: 'Bash', input: {}, status: 'running', resultSummary: null }
const argsDelta = (partial_json: string) => stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json } })

it('publishes real tool starts and masked stable-id argument updates before any final frame', () => {
  const secret = 'dMg_' + '0123456789abcdef'.repeat(4)
  const started = feed(toolStart)
  expect(started.events).toEqual([{ type: 'item', item: runningTool }])
  const partial = feed([argsDelta('{"command":"echo ' + secret.slice(0, 15))], started.state)
  expect(partial.events).toEqual([])
  const updated = feed([argsDelta(secret.slice(15) + '"}')], partial.state)
  const heldInput = { command: 'echo ' + secret }
  const safeTool = { ...runningTool, input: { command: 'echo [grant token masked]' } }
  expect(updated.events).toEqual([{ type: 'item', item: safeTool }])
  expect(updated.state.tools.get('actual-tool')?.input).toEqual(heldInput)
  const final = feed([{ type: 'assistant', message: { id: 'tools', content: [
    { type: 'tool_use', id: 'actual-tool', name: 'Bash', input: heldInput }
  ] } }, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'actual-tool', content: 'done' }] } }], updated.state)
  expect(final.events).toEqual([{ type: 'item', item: { ...safeTool, status: 'completed', resultSummary: 'done' } }])
  expect([...started.events, ...partial.events, ...updated.events, ...final.events]).toEqual([
    { type: 'item', item: runningTool }, { type: 'item', item: safeTool },
    { type: 'item', item: { ...safeTool, status: 'completed', resultSummary: 'done' } }
  ])
})

it('exposes a cancelled tool even when interrupted before arguments or final assistant frame arrive', () => {
  const started = feed([...toolStart, argsDelta('{"command":"unfinished')])
  const interrupted = encodeClaudeCommand({ type: 'interrupt', requestId: 'stop-tools' }, started.state, at)
  const ended = feed([{ ...result, is_error: true, terminal_reason: 'aborted_tools', uuid: 'aborted' }], interrupted.state)
  expect([...started.events, ...ended.events]).toEqual([
    { type: 'item', item: runningTool },
    { type: 'item', item: { kind: 'turn_stopped', id: 'stopped:aborted', at } },
    { type: 'item', item: { ...runningTool, status: 'cancelled' } }, { type: 'status', status: 'idle' }
  ])
})

const spawnStart = (name: string) => [stream({ type: 'message_start', message: { id: 'spawning' } }),
  stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'spawn', name, input: {} } })]
const mainApproval = { type: 'control_request', request_id: 'main-approval', request: {
  subtype: 'can_use_tool', tool_name: 'Bash', input: {}
} }
function terminateSpawn(state: ClaudeProtocolState, terminal: string) {
  if (terminal === 'cancel') state = encodeClaudeCommand({ type: 'interrupt', requestId: 'stop-spawn' }, state, at).state
  return feed([{ ...result, is_error: true, uuid: 'spawn-end',
    ...(terminal === 'cancel' ? { terminal_reason: 'aborted_tools' } : { errors: ['Failed'] }) }], state)
}

it.each(['Agent', 'Task'].flatMap(name => ['cancel', 'failure'].map(terminal => ({ name, terminal }))))(
  'settles the pre-final $name thread on $terminal and restores main-only attribution', ({ name, terminal }) => {
    const initial = feed([...spawnStart(name), argsDelta('{"description":"unfinished')])
    expect(initial.state.spawnLifecycle.get('spawn')).toBe('provisional')
    const running = { kind: 'thread', id: 'thread:spawn', at, parentItemId: 'spawn', label: 'Subagent', state: 'running' }
    expect(initial.events).toEqual([
      { type: 'item', item: { ...runningTool, id: 'spawn', name } }, { type: 'item', item: running }
    ])
    const ended = terminateSpawn(initial.state, terminal)
    expect(ended.events).toEqual([
      { type: 'item', item: terminal === 'cancel'
        ? { kind: 'turn_stopped', id: 'stopped:spawn-end', at }
        : { kind: 'error', id: 'error:spawn-end', at, message: 'Failed' } },
      { type: 'item', item: { ...runningTool, id: 'spawn', name, status: 'cancelled' } },
      { type: 'item', item: { ...running, state: 'failed' } },
      { type: 'status', status: 'idle' }
    ])
    const rendered = [...initial.events, ...ended.events].reduce((model, event) =>
      reduceAgentChat(model, { ...ref, ...event }), agentChatState())
    expect(rendered.items.filter(item => item.kind === 'thread')).toEqual([{ ...running, state: 'failed' }])
    expect(ended.state.threads.get('spawn')).toEqual({ ...running, state: 'failed' })
    expect(initial.state.threads.get('spawn')).toEqual(running)
    expect(feed([mainApproval], ended.state).events.at(-1)).toMatchObject({
      type: 'pending', prompt: { threadId: null, attributed: true }
    })
  })

const launchSignals = [
  { name: 'task_started', frames: [{ type: 'system', subtype: 'task_started', tool_use_id: 'spawn', task_id: 'worker' }] },
  { name: 'child stream', frames: start('child', 'spawn') },
  { name: 'child assistant', frames: [{ type: 'assistant', parent_tool_use_id: 'spawn',
    message: { id: 'child', content: [{ type: 'text', text: 'Working' }] } }] },
  { name: 'child user', frames: [{ type: 'user', uuid: 'child-user', parent_tool_use_id: 'spawn', message: { content: 'Working' } }] },
  ...[{ status: 'async_launched', agentId: 'worker' }, { isAsync: true, agentId: 'worker' }].map(tool_use_result => ({
    name: JSON.stringify(tool_use_result), frames: [{ type: 'user', tool_use_result,
      message: { content: [{ type: 'tool_result', tool_use_id: 'spawn', content: 'Launched' }] } }]
  }))
]
it.each(launchSignals.flatMap(signal => ['cancel', 'failure'].map(terminal => ({ ...signal, terminal }))))(
  'preserves observed $name launch through main $terminal until its own completion', ({ frames, terminal }) => {
    const initial = feed([...spawnStart('Agent'), ...frames])
    expect(initial.state.spawnLifecycle.get('spawn')).toBe('launched')
    const ended = terminateSpawn(initial.state, terminal)
    expect(ended.state.threads.get('spawn')?.state).toBe('running')
    expect(ended.events.filter(event => event.type === 'item' && event.item.kind === 'thread')).toEqual([])
    expect(feed([mainApproval], ended.state).events.at(-1)).toMatchObject({
      type: 'pending', prompt: { threadId: null, attributed: false }
    })
    const completed = feed([{ type: 'system', subtype: 'task_notification', tool_use_id: 'spawn', status: 'completed' }], ended.state)
    expect(completed.state.threads.get('spawn')).toEqual({ ...initial.state.threads.get('spawn'), state: 'done' })
    expect(completed.events).toContainEqual({ type: 'item', item: completed.state.threads.get('spawn') })
    expect(feed([mainApproval], completed.state).events.at(-1)).toMatchObject({
      type: 'pending', prompt: { threadId: null, attributed: true }
    })
  })

it('does not mistake a submitted spawn with unobserved execution for a definitively unlaunched child', () => {
  const initial = feed([...spawnStart('Task'), { type: 'assistant', message: { id: 'spawning', content: [
    { type: 'tool_use', id: 'spawn', name: 'Task', input: { description: 'Background-looking label is not launch evidence' } }
  ] } }])
  expect(initial.state.spawnLifecycle.get('spawn')).toBe('submitted')
  const ended = terminateSpawn(initial.state, 'cancel')
  expect(ended.state.threads.get('spawn')?.state).toBe('running')
  expect(feed([mainApproval], ended.state).events.at(-1)).toMatchObject({
    type: 'pending', prompt: { threadId: null, attributed: false }
  })
})

it('keeps identical text from distinct frame UUIDs, deduplicates repeated frames and correlates the full frame by index', () => {
  const one = { type: 'text', text: 'Identical.' }
  const frame = (uuid: string, content = [one]) => ({ type: 'assistant', uuid, message: { id: 'same-message', content } })
  const translated = feed([frame('first'), frame('first'), frame('second'), frame('full', [one, one]), frame('full'), result])
  expect(translated.events).toEqual([
    { type: 'delta', itemId: 'same-message:0', kind: 'text', text: 'Identical.' },
    { type: 'item', item: { kind: 'assistant_text', id: 'same-message:0', at, text: 'Identical.' } },
    { type: 'delta', itemId: 'same-message:1', kind: 'text', text: 'Identical.' },
    { type: 'item', item: { kind: 'assistant_text', id: 'same-message:1', at, text: 'Identical.' } },
    { type: 'status', status: 'idle' }
  ])
})

it('correlates final text after message_stop without producing a second answer', () => {
  const translated = feed([stream({ type: 'message_start', message: { id: 'text' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Answer' } }),
    stream({ type: 'message_stop' }), { type: 'assistant', uuid: 'final', message: { id: 'text', content: [{ type: 'text', text: 'Answer' }] } }])
  expect(translated.events.filter(event => event.type === 'item')).toEqual([
    { type: 'item', item: { kind: 'assistant_text', id: 'text:0', at, text: 'Answer' } }
  ])
})

it.each([
  { type: 'assistant' }, { type: 'assistant', message: { id: 'bad', content: [null] } },
  { type: 'assistant', message: { id: 'bad', content: [{ type: 'text' }] } },
  { type: 'assistant', message: { id: 'bad', content: [{ type: 'tool_use', id: 'bad', name: 'Agent' }] } },
  { type: 'user' }, { type: 'user', message: { content: [{ type: 'garbage', text: 'wrong' }] } },
  { type: 'stream_event' }, { type: 'stream_event', event: { type: 'message_start', message: {} } },
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'wrong' } }),
  stream({ type: 'unknown' })
])('rejects malformed forwarded envelope without a ghost child or changed attribution: %j', malformed => {
  const previous = feed(start('main')).state
  const translated = feed([{ ...malformed, uuid: 'garbage', parent_tool_use_id: 'ghost' }], previous)
  expect(translated.events).toEqual([])
  expect(translated.state.threads.size).toBe(0)
  expect(translated.state.activeMessages).toEqual(previous.activeMessages)
  expect(translated.state.messages).toEqual(previous.messages)
  expect(translated.state.skipped).toBe(previous.skipped + 1)
  const approval = feed([{ type: 'control_request', request_id: 'permission', request: {
    subtype: 'can_use_tool', tool_name: 'Bash', input: {}
  } }], translated.state)
  expect(approval.events.at(-1)).toMatchObject({ type: 'pending', prompt: { threadId: null, attributed: true } })
})

it.each([{}, { questions: [] }, { questions: null }, { questions: [null] }, { questions: [{}] },
  { questions: [{ question: '' }] }, { questions: [{ question: '   ' }] },
  { questions: [{ question: 'Valid?' }, { question: 42 }] }
])('diagnoses malformed questions without an unanswerable card or automatic denial: %j', input => {
  const translated = feed([question(input)])
  expect(translated.state.skipped).toBe(1)
  expect(translated.state.pending.size).toBe(0)
  expect(translated.events).toEqual([{ type: 'item', item: { kind: 'error', id: 'question:question', at,
    message: 'Malformed AskUserQuestion request: expected nonempty questions with question text.' } }])
  expect(encodeClaudeCommand({ type: 'answer', promptId: 'question', optionId: 'text', text: 'answer' }, translated.state, at).lines).toEqual([])
})

it.each(['ka_01j0000000000000000000000a.fixtureSecretAAAAAAAAAAAAAAAAAAA', 'dMg_' + '0123456789abcdef'.repeat(4)])('buffers split secret %s through thinking retirement', secret => {
  const translated = feed([stream({ type: 'message_start', message: { id: 'secret' } }),
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
    ...[...secret].map(thinking => stream({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } })), result])
  expect(translated.events).toEqual([
    { type: 'delta', itemId: 'secret:0', kind: 'thinking', text: secret.startsWith('ka_') ? '[claim token masked]' : '[grant token masked]' },
    { type: 'stream_end', itemId: 'secret:0' }, { type: 'status', status: 'idle' }
  ])
  expect(JSON.stringify(translated.events)).not.toContain('fixtureSecret')
  expect(JSON.stringify(translated.events)).not.toContain('0123456789abcdef')
})
