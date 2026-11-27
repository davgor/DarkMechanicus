import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentChatEventSchema, type AgentChatAnswer } from '../../shared/agents/agentChat'
import type { ChatItem } from '../../shared/agents/chat'
import { createOmpState, encodeOmpCommand, initLines, translateOmpLine, type OmpCommand, type OmpEvent } from './ompProtocol'
import { maskAgentChatSecretsDeep } from './secretMask'
import { webpBytes } from '../../test/images'
import type { ToolResultBlob } from './toolResultImages'
import type { CommandResultEvent, ThreadClaimEvent } from './translatorEvents'

const at = '2026-11-24T00:00:00.000Z'
const root = join(import.meta.dirname, '__fixtures__', 'omp')
function lines(name: string, direction: 'in' | 'out'): string[] {
  const text = readFileSync(join(root, `${name}.${direction}.jsonl`), 'utf8')
  expect(text).not.toContain('\r')
  return text.trim().split(/\r?\n/)
}
function harness(idNamespace = '') {
  let state = createOmpState(idNamespace)
  const events: OmpEvent[] = []
  const internalEvents: (ThreadClaimEvent | CommandResultEvent)[] = []
  const blobs: ToolResultBlob[] = []
  return {
    get state() { return state },
    events,
    internalEvents,
    blobs,
    feed(frame: unknown) {
      const result = translateOmpLine(typeof frame === 'string' ? frame : JSON.stringify(frame), state, at)
      state = result.state; events.push(...result.events)
      internalEvents.push(...result.internalEvents)
      blobs.push(...result.blobs)
      return result.events
    },
    send(command: OmpCommand, framing?: { chunkId: string; chunkBytes?: number }) {
      const result = encodeOmpCommand(command, state, at, framing)
      state = result.state; events.push(...result.events)
      return result.lines
    },
    init(ready: unknown) {
      const ids = ['protocol', 'askdialog', 'subscription', 'filter', 'state']
      const result = initLines(ready, state, () => `req_T1_${ids.shift()}`)
      state = result.state
      return result.lines
    },
    items() {
      const items = new Map<string, ChatItem>()
      for (const event of events) if (event.type === 'item') items.set(event.item.id, event.item)
      return [...items.values()]
    }
  }
}
function initialized() {
  const h = harness()
  const startup = lines('init', 'out')
  h.feed(startup[0]); expect(h.init(JSON.parse(startup[0]))).toEqual(lines('init', 'in'))
  startup.slice(1).forEach(line => h.feed(line))
  h.events.length = 0
  return h
}
const textItem = (text: string, index = 0): ChatItem => ({ kind: 'assistant_text', id: `omp:main:message:1:${index}`, at, text })
const toolItem = (id: string, name: string, input: Extract<ChatItem, { kind: 'tool_call' }>['input'], resultSummary: string): Extract<ChatItem, { kind: 'tool_call' }> => ({ kind: 'tool_call', id, at, name, input, status: 'completed', resultSummary })
const threadItem = (id: string, label: string, state: 'running' | 'done'): ChatItem => ({ kind: 'thread', id, at, label, state, parentItemId: null })
const scenarios: Record<string, ChatItem[]> = {
  text: [textItem('Hello world', 1)],
  tool: [toolItem('call_T1_read', 'read', { path: 'a.txt' }, 'alpha'), textItem('alpha')],
  edit: [toolItem('call_T1_edit', 'edit', { path: 'C:/fixture/repo/a.txt', old_text: 'alpha', new_text: 'beta' }, 'Updated'), toolItem('call_T1_write', 'write', { path: 'C:/fixture/repo/b.txt', content: 'beta' }, 'Written'), textItem('Done')],
  chunked: [toolItem('call_T1_chunk', 'read', { path: 'a.txt' }, 'alpha\nbeta'), textItem('alpha\nbeta')],
  todo: [textItem('Done')], todo_clear: [textItem('Done')],
  todo_fail: [{ ...toolItem('call_T1_todofail', 'todo', { phases: [] }, 'Invalid phases'), status: 'failed' }, textItem('Done')],
  question: [
    { kind: 'approval_request', id: 'omp:approval:ui_T1_question', at, requestId: 'ui_T1_question', category: 'other', tool: 'ask', summary: 'Which database?' },
    { kind: 'approval_decision', id: 'omp:decision:ui_T1_question', at, requestId: 'ui_T1_question', decision: 'allow_once', decidedBy: 'person' },
    textItem('SQLite')
  ],
  question_multi: ['', ':1'].flatMap((suffix, index) => [
    { kind: 'approval_request', id: `omp:approval:ui_T1_question_multi${suffix}`, at, requestId: `ui_T1_question_multi${suffix}`, category: 'other', tool: 'ask', summary: ['Which databases?', 'Which region?'][index] } as ChatItem,
    { kind: 'approval_decision', id: `omp:decision:ui_T1_question_multi${suffix}`, at, requestId: `ui_T1_question_multi${suffix}`, decision: 'allow_once', decidedBy: 'person' } as ChatItem
  ]).concat(textItem('answers: [{"id":"q_T1_databases","selectedOptions":["SQLite","Postgres"]},{"id":"q_T1_region","selectedOptions":["EU"]}]')),
  error: [{ kind: 'error', id: 'omp:error:1', at, message: 'Fixture provider failure' }],
  interrupt: [textItem('Partial'), { kind: 'turn_stopped', id: 'omp:stopped:1', at }],
  queued: [textItem('Hello world')],
  subagent: [threadItem('agent_T1_worker', 'Servitor:READ Read file', 'done'), { ...toolItem('call_T1_nestedread', 'read', { path: 'a.txt' }, 'alpha'), threadId: 'agent_T1_worker' }, textItem('alpha')],
  subagent_tree: [threadItem('agent_T1_1', 'Acolyte:DM-1 Add retry banner', 'done'), { ...toolItem('call_T1_read1', 'read', { path: 'a.txt' }, 'alpha'), threadId: 'agent_T1_1' }, threadItem('agent_T1_2', 'Acolyte:DM-2 Fix lint', 'running'), { ...toolItem('call_T1_read2', 'read', { path: 'a.txt' }, 'alpha'), threadId: 'agent_T1_2' }, threadItem('agent_T1_review', 'Inquisitor:DM-2 Review diff', 'running'), textItem('Worker 1 done; worker 2 still running')]
}
for (const name of ['approval', 'approval_chat']) scenarios[name] = [
  { kind: 'approval_request', id: 'omp:approval:ui_T1_approval', requestId: 'ui_T1_approval', at, category: 'other', tool: 'OMP', summary: 'Run bash: echo hello?' },
  { kind: 'approval_decision', id: 'omp:decision:ui_T1_approval', requestId: 'ui_T1_approval', at, decision: name === 'approval' ? 'allow_once' : 'allow_chat', decidedBy: 'person' },
  toolItem('call_T1_bash', 'bash', { command: 'echo hello' }, 'hello'), textItem('hello')
]
const phases = [
  { name: 'Implement', tasks: [{ id: 'todo_T1_1', content: 'Add banner', status: 'in_progress' }, { id: 'todo_T1_2', content: 'Wait for API', status: 'blocked', blocker: 'API unavailable' }] },
  { name: 'Review', tasks: [{ id: 'todo_T1_3', content: 'Old approach', status: 'abandoned' }] }
]

function encodeFixtureResponse(h: { send(command: OmpCommand): string[] }, next?: Record<string, unknown>): string[] {
  if (next?.type === 'get_subagent_messages') return h.send({ type: 'get_subagent_messages', id: String(next.id), subagentId: String(next.subagentId), fromByte: Number(next.fromByte) })
  if (next?.type === 'abort') return h.send({ type: 'interrupt', id: String(next.id) })
  if (next?.type === 'follow_up') return h.send({ type: 'send', id: String(next.id), text: String(next.message) })
  return []
}
/** The person's answers to a golden's prompt: the multi golden answers two questions, the first with several options. */
function fixtureAnswers(name: string, promptId: string): AgentChatAnswer[] {
  if (name === 'question_multi') return [{ promptId, optionIds: ['option_0', 'option_1'] }, { promptId: `${promptId}:1`, optionId: 'option_0' }]
  return [{ promptId, optionId: name === 'approval' ? 'allow_once' : name === 'approval_chat' ? 'allow_chat' : 'option_0' }]
}
function replayGolden(name: string) {
  const h = initialized()
  const input = lines(name, 'in')
  const first = name === 'chunked' ? { id: 'req_T1_prompt', message: 'Read a.txt' } : JSON.parse(input[0]) as { id: string; message: string }
  const encoded = h.send({ type: 'send', id: first.id, text: first.message }, name === 'chunked' ? { chunkId: 'chunk_T1_host', chunkBytes: 31 } : undefined)
  const remaining = name === 'chunked' ? [] : input.slice(1).map(line => JSON.parse(line) as Record<string, unknown>)
  for (const line of lines(name, 'out')) {
    const frame = JSON.parse(line) as Record<string, unknown>
    if (frame.type === 'response') encoded.push(...encodeFixtureResponse(h, remaining.find(value => value.id === frame.id)))
    h.feed(line)
    if (frame.type === 'extension_ui_request') for (const answer of fixtureAnswers(name, h.state.pending[0].prompt.id)) encoded.push(...h.send({ type: 'answer', id: answer.promptId, ...answer }))
  }
  return { h, input, first, encoded }
}
function expectCommittedDeltas(events: OmpEvent[]): void {
  const deltas = new Map<string, string>()
  for (const event of events) if (event.type === 'delta' && event.kind === 'text') deltas.set(event.itemId, (deltas.get(event.itemId) ?? '') + event.text)
  for (const [id, text] of deltas) expect(events.filter(event => event.type === 'item' && event.item.id === id)).toEqual([{ type: 'item', item: { kind: 'assistant_text', id, at, text } }])
}

describe('OMP golden protocol', () => {
  it('enumerates every golden pair, including both startup variants', () => {
    expect(readdirSync(root).filter(name => name.endsWith('.out.jsonl')).map(name => name.replace('.out.jsonl', '')).sort()).toEqual([...Object.keys(scenarios), 'init', 'init_resume', 'worker_claim', 'image_in', 'image_result'].sort())
  })
  for (const name of ['init', 'init_resume']) it(`bootstraps ${name} once with exact commands and todos`, () => {
    const h = harness(); const output = lines(name, 'out')
    h.feed(output[0]); expect(h.init(JSON.parse(output[0]))).toEqual(lines(name, 'in'))
    expect(h.init(JSON.parse(output[0]))).toEqual([])
    output.slice(1).forEach(line => h.feed(line))
    expect(h.items()).toEqual([])
    expect(h.events).toEqual([{ type: 'status', status: 'idle' }, { type: 'todos', threadId: null, phases: name === 'init' ? [] : phases }])
    expect(h.state.sessionId).toBe('session_T1')
  })
  for (const [name, expected] of Object.entries(scenarios)) it(`translates and encodes exact ${name} fixtures`, () => {
    const { h, input, first, encoded } = replayGolden(name)
    expect(encoded).toEqual(input)
    expect(h.items().filter(item => item.kind !== 'user_message')).toEqual(expected)
    if (name === 'question' || name === 'question_multi') expect(h.items().filter(item => item.kind === 'user_message')).toEqual([
      { kind: 'user_message', id: first.id, at, text: first.message },
      ...(name === 'question' ? [{ kind: 'user_message', id: 'omp:answer:ui_T1_question', at, text: 'SQLite' }]
        : [{ kind: 'user_message', id: 'omp:answer:ui_T1_question_multi', at, text: 'SQLite, Postgres' }, { kind: 'user_message', id: 'omp:answer:ui_T1_question_multi:1', at, text: 'EU' }])
    ])
    else expect(h.items().filter(item => item.kind === 'user_message')).toEqual([{ kind: 'user_message', id: first.id, at, text: first.message }, ...(name === 'queued' ? [{ kind: 'user_message', id: 'req_T1_followup', at, text: 'Second turn' }] : [])])
    expect(h.state.skipped).toBe(0)
    expect(h.state.inFlight).toBe(false)
    expect(h.events.at(-1)).toEqual({ type: 'status', status: 'idle' })
    expect(JSON.stringify(h.events)).not.toContain('fixtureSecret')
    expectCommittedDeltas(h.events)
    if (name === 'text') expect(h.events.filter(event => event.type === 'delta' && event.kind === 'thinking')).toEqual([{ type: 'delta', itemId: 'omp:main:message:1:0', kind: 'thinking', text: 'Consider the reply.' }])
    const todoEvents = h.events.filter(event => event.type === 'todos')
    expect(todoEvents).toEqual(name === 'todo' ? [{ type: 'todos', threadId: null, phases }] : name === 'todo_clear' ? [{ type: 'todos', threadId: null, phases: [] }] : [])
  })
})

describe('OMP prompts and security', () => {
  for (const method of ['select', 'confirm', 'input', 'editor', 'ask', 'form', 'futureBlocking']) it(`holds and answers ${method}`, () => {
    const h = initialized()
    h.feed({ type: 'extension_ui_request', id: 'ui', method, title: 'Raw title', options: ['One', 'Two'] })
    expect(h.state.pending[0].prompt).toMatchObject({ id: 'ui', kind: 'question', callsign: null, arbitration: { state: 'off', reason: null }, attributed: true })
    const response = h.send({ type: 'answer', id: 'answer', promptId: 'ui', optionId: method === 'confirm' ? 'yes' : method === 'select' ? 'option_1' : 'text', text: method === 'form' ? '{"field":"value"}' : 'answer' })
    expect(response).toEqual([JSON.stringify({ type: 'extension_ui_response', id: 'ui', ...(method === 'confirm' ? { confirmed: true } : method === 'ask' ? { answers: [{ id: 'ui', selectedOptions: [], customInput: 'answer' }] } : method === 'form' ? { data: { field: 'value' } } : { value: method === 'select' ? 'Two' : 'answer' }) })])
    expect(h.state.pending).toEqual([])
  })
  for (const method of ['notify', 'setStatus', 'setWidget', 'setTitle', 'setWorkingMessage', 'set_editor_text', 'open_url']) it(`never answers or opens ${method}`, () => {
    const h = initialized(); expect(h.feed({ type: 'extension_ui_request', id: 'ui', method, url: 'https://untrusted.invalid' })).toEqual([])
    expect(h.send({ type: 'answer', id: 'answer', promptId: 'ui', optionId: 'yes' })).toEqual([])
    expect(h.state.pending).toEqual([])
  })
  it('queues blocking owners and cancels only the matching wire id', () => {
    const h = initialized()
    for (const id of ['first', 'second']) h.feed({ type: 'extension_ui_request', id, method: 'input', title: id })
    expect(h.feed({ type: 'extension_ui_request', id: 'cancel', method: 'cancel', targetId: 'missing' })).toEqual([])
    expect(h.feed({ type: 'extension_ui_request', id: 'cancel', method: 'cancel', targetId: 'first' })).toEqual([{ type: 'pending', prompt: h.state.pending[0].prompt }])
    expect(h.state.pending[0].wireId).toBe('second')
    expect(h.feed({ type: 'extension_ui_request', id: 'cancel', method: 'cancel', targetId: 'second' })).toEqual([{ type: 'pending', prompt: null }])
  })
  it('never invents approval tool inputs or Magos attribution during a running worker', () => {
    const h = initialized()
    h.feed({ type: 'subagent_lifecycle', payload: { id: 'worker', agent: 'task', status: 'running' } })
    h.feed({ type: 'extension_ui_request', id: 'ui', method: 'select', title: 'Approve?', options: ['Approve Once', 'Approve permanently', 'Approve bash for this session', 'Deny'], tool: { name: 'bash', input: {} }, parentId: 'worker' })
    expect(h.state.pending[0].prompt).toEqual({ id: 'ui', title: 'Approve?', detail: '', threadId: null, callsign: null, arbitration: { state: 'off', reason: null }, attributed: false, kind: 'approval', options: [{ id: 'allow_once', label: 'Approve Once' }, { id: 'allow_chat', label: 'Approve bash for this session' }, { id: 'deny', label: 'Deny' }] })
    expect(h.send({ type: 'answer', id: 'answer', promptId: 'ui', optionId: 'permanent' })).toEqual([])
  })
  it('answers multiple ask questions in their original order', () => {
    const h = initialized()
    h.feed({ type: 'extension_ui_request', id: 'ask', method: 'ask', questions: [{ id: 'one', question: 'One?', options: [{ label: 'A' }] }, { id: 'two', question: 'Two?', options: [] }] })
    expect(h.send({ type: 'answer', id: 'a', promptId: 'ask', optionId: 'option_0' })).toEqual([])
    expect(h.state.pending[0].prompt.id).toBe('ask:1')
    expect(h.send({ type: 'answer', id: 'b', promptId: 'ask:1', optionId: 'text', text: 'B' })).toEqual(['{"type":"extension_ui_response","id":"ask","answers":[{"id":"one","selectedOptions":["A"]},{"id":"two","selectedOptions":[],"customInput":"B"}]}'])
    expect(h.items().map(item => item.kind)).toEqual(['approval_request', 'approval_decision', 'user_message', 'approval_request', 'approval_decision', 'user_message'])
    expect(h.items().filter(item => item.kind === 'user_message').map(item => item.text)).toEqual(['A', 'B'])
  })
})

describe('OMP security boundary', () => {
  it('never retains or echoes secret input answers', () => {
    const h = initialized(); h.feed({ type: 'extension_ui_request', id: 'secret', method: 'input', secret: true, prefill: 'hidden-prefill' })
    expect(h.send({ type: 'answer', id: 'a', promptId: 'secret', optionId: 'text', text: 'sensitive-password' })).toEqual(['{"type":"extension_ui_response","id":"secret","value":"sensitive-password"}'])
    expect(JSON.stringify(h.state)).not.toContain('sensitive-password')
    expect(JSON.stringify(h.events)).not.toMatch(/sensitive-password|hidden-prefill/)
  })
  it('masks tokens before clipping paths, labels, results, prompts and fragmented deltas', () => {
    const h = initialized()
    const claim = 'at_01j0000000000000000000000a.fixtureSecretAAAAAAAAAAAAAAAAAAA'
    const grant = `dmg_${'a'.repeat(48)}`
    const tokens = `${claim} ${grant}`
    h.feed({ type: 'tool_execution_start', toolCallId: 'tool', toolName: 'edit', args: { path: 'a'.repeat(4080) + tokens, file_path: 'C:/whole path/file.ts', notebook_path: 'C:/notebook.ipynb' } })
    h.feed({ type: 'tool_execution_end', toolCallId: 'tool', toolName: 'edit', isError: false, result: { content: [{ type: 'text', text: tokens }] } })
    h.feed({ type: 'subagent_lifecycle', payload: { id: 'worker', description: 'x'.repeat(110) + tokens, task: tokens, status: 'running' } })
    h.feed({ type: 'extension_ui_request', id: 'ui', method: 'input', title: tokens, message: tokens })
    h.feed({ type: 'message_start', message: { role: 'assistant' } })
    for (const delta of [claim.slice(0, 2), claim.slice(2, 35), claim.slice(35), ' ', grant.slice(0, 3), grant.slice(3)]) h.feed({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta } })
    h.feed({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: tokens }] } })
    expect(JSON.stringify(h.events)).not.toContain('fixtureSecret')
    expect(JSON.stringify(h.events)).not.toContain(grant)
    expect(h.events.filter(event => event.type === 'delta').map(event => event.type === 'delta' ? event.text : '').join('')).toBe(maskAgentChatSecretsDeep(tokens))
    const tool = h.items().find(item => item.kind === 'tool_call')
    expect(tool).toMatchObject({ input: { path: maskAgentChatSecretsDeep('a'.repeat(4080) + tokens).slice(0, 4096), file_path: 'C:/whole path/file.ts', notebook_path: 'C:/notebook.ipynb' }, resultSummary: maskAgentChatSecretsDeep(tokens) })
  })
  it('skips garbage and unknown inputs without throwing', () => {
    const h = initialized()
    for (const value of ['garbage', '', 'null', '[]', '12', '{}', '{"type":"unknown"}', '{"type":"message_update"}']) expect(() => h.feed(value)).not.toThrow()
    expect(h.state.skipped).toBe(8)
    expect(h.events).toEqual([])
  })
  it('reports correlated command errors and does not complete on admission or agent_end', () => {
    const h = initialized(); h.send({ type: 'send', id: 'prompt', text: 'hello' })
    h.feed({ type: 'response', id: 'prompt', command: 'prompt', success: true }); h.feed({ type: 'agent_end' })
    expect(h.state.inFlight).toBe(true)
    h.feed({ type: 'response', id: 'bad', command: 'abort', success: false, error: 'Refused' })
    expect(h.items().at(-1)).toMatchObject({ kind: 'error', message: 'Refused' })
    expect(h.state.inFlight).toBe(true)
  })
})

describe('OMP framing and streaming invariants', () => {
  it('reassembles bounded UTF-8 chunks and splits explicitly framed outbound commands at advertised frame size', () => {
    const h = initialized()
    h.feed({ type: 'ready', maxFrameBytes: 200, maxReassembledFrameBytes: 10000 })
    const encoded = h.send({ type: 'send', id: 'prompt', text: '🙂'.repeat(100) }, { chunkId: 'chunk' })
    expect(encoded.length).toBeGreaterThan(1)
    expect(encoded.every(line => Buffer.byteLength(line) <= 200)).toBe(true)
    expect(JSON.parse(Buffer.concat(encoded.map(line => Buffer.from((JSON.parse(line) as { data: string }).data, 'base64'))).toString())).toEqual({ type: 'prompt', id: 'prompt', message: '🙂'.repeat(100) })
  })
  it.each(['base64', 'order', 'count', 'length', 'overflow', 'interleaving', 'utf8'])('rejects %s chunks once without a partial tool output', mode => {
    const h = initialized()
    const chunks = lines('chunked', 'out').map(line => JSON.parse(line) as Record<string, unknown>).filter(frame => frame.type === 'rpc_chunk')
    if (mode === 'base64') chunks[0].data = 'Zh=='
    if (mode === 'order') chunks[0].index = 1
    if (mode === 'count') chunks[1].count = 3
    if (mode === 'length') chunks.forEach(chunk => { chunk.byteLength = 166 })
    if (mode === 'overflow') chunks.forEach(chunk => { chunk.byteLength = 67_108_865 })
    if (mode === 'utf8') { chunks[0].data = '/w=='; chunks[1].data = '/w=='; chunks.forEach(chunk => { chunk.byteLength = 2 }) }
    h.feed(chunks[0])
    if (mode === 'interleaving') h.feed({ type: 'tool_execution_end', toolCallId: 'x', toolName: 'read', result: { content: 'must not escape' } })
    h.feed(chunks[1])
    expect(h.items().filter(item => item.kind === 'tool_call')).toEqual([])
    expect(h.items().filter(item => item.kind === 'error')).toHaveLength(1)
  })
  it('keeps interleaved partial tool arguments private and final execution correlated', () => {
    const h = initialized()
    const secret = 'at_01j0000000000000000000000a.fixtureSecretAAAAAAAAAAAAAAAAAAA'
    for (const [index, id] of [[0, 'a'], [1, 'b']] as const) h.feed({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_start', contentIndex: index, block: { type: 'toolCall', id, name: 'read', arguments: {} } } })
    for (const [index, delta] of [[0, '{"path":"'], [1, '{"path":"b.txt"}'], [0, secret.slice(0, 40)], [0, secret.slice(40) + '"}']] as const) h.feed({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', contentIndex: index, delta } })
    h.feed({ type: 'message_update', assistantMessageEvent: { type: 'toolcall_end', contentIndex: 0, toolCall: { type: 'toolCall', id: 'a', name: 'read', arguments: { path: secret } } } })
    h.feed({ type: 'tool_execution_end', toolCallId: 'a', toolName: 'read', result: { content: [{ type: 'text', text: 'done' }] }, isError: false })
    h.feed({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'a', name: 'read', arguments: { path: secret } }] } })
    expect(h.items()).toEqual([toolItem('a', 'read', { path: maskAgentChatSecretsDeep(secret) }, 'done'), { kind: 'tool_call', id: 'b', at, name: 'read', input: { path: 'b.txt' }, status: 'running', resultSummary: null }])
    expect(JSON.stringify(h.events)).not.toContain('fixtureSecret')
    expect(h.events.some(event => event.type === 'delta')).toBe(false)
  })
  it('keeps first thread timestamp, strips controls, ignores invented parents and never labels from task', () => {
    const initial = createOmpState()
    const first = translateOmpLine(JSON.stringify({ type: 'subagent_lifecycle', payload: { id: 'worker', agent: 'task', task: 'private', status: 'running' } }), initial, at)
    const second = translateOmpLine(JSON.stringify({ type: 'subagent_lifecycle', payload: { id: 'worker', description: 'A\nB\u0000', parentId: 'fake', status: 'completed' } }), first.state, 'later')
    expect(second.events).toEqual([{ type: 'item', item: threadItem('worker', 'AB', 'done') }])
    expect(first.state.threads.get('worker')?.state).toBe('running')
  })
  it('validates all emitted payloads against the strict shared schema', () => {
    const h = initialized()
    lines('tool', 'out').forEach(line => h.feed(line))
    for (const event of h.events) expect(agentChatEventSchema.safeParse({ ...event, chatId: 'test', folder: null }).success).toBe(true)
  })
})

describe('OMP amended edge contracts', () => {
  it('collects form fields, preserving numeric values and multi-choice values', () => {
    const h = initialized()
    h.feed({ type: 'extension_ui_request', id: 'form', method: 'form', form: { sections: [{ blocks: [
      { kind: 'text', name: 'count', question: 'Count?', type: 'number' },
      { kind: 'choice', name: 'letters', question: 'Letters?', multi: true, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C', disabled: true }] }
    ] }] } })
    expect(h.send({ type: 'answer', id: 'one', promptId: 'form', optionId: 'text', text: '3' })).toEqual([])
    expect(h.state.pending[0].prompt).toMatchObject({ options: [{ id: 'option_0', label: 'A' }, { id: 'option_1', label: 'B' }, { id: 'text', label: 'Other' }], multi: true, progress: { index: 2, total: 2 } })
    expect(h.send({ type: 'answer', id: 'two', promptId: 'form:1', optionIds: ['option_1', 'option_0', 'text'], text: 'z' })).toEqual(['{"type":"extension_ui_response","id":"form","data":{"count":3,"letters":["a","b","z"]}}'])
  })
  it('answers a multi ask with selectedOptions in option order and refuses unknown, repeated or text-less ids', () => {
    const h = initialized()
    h.feed({ type: 'extension_ui_request', id: 'ask', method: 'ask', questions: [
      { id: 'q', question: 'Choose', multi: true, options: ['A', 'B', 'C', 'D'].map(label => ({ label, description: `Letter ${label}` })) },
      { id: 'r', question: 'One', options: [{ label: 'X' }, { label: 'Y' }] }
    ] })
    expect(h.state.pending[0].prompt).toMatchObject({ multi: true, progress: { index: 1, total: 2 }, options: [{ id: 'option_0', label: 'A', description: 'Letter A' }, { id: 'option_1' }, { id: 'option_2' }, { id: 'option_3' }, { id: 'text' }] })
    for (const optionIds of [['option_0', 'option_9'], ['option_0', 'option_0'], ['option_0', 'text']]) {
      expect(h.send({ type: 'answer', id: 'bad', promptId: 'ask', optionIds })).toEqual([])
      expect(h.state.pending[0].prompt.id).toBe('ask')
    }
    // A JSON list typed as free text is free text now, never a hidden selection.
    const typed = encodeOmpCommand({ type: 'answer', id: 't', promptId: 'ask', optionId: 'text', text: '["A","B"]' }, h.state, at).state
    expect(typed.pending[0].answers).toEqual([{ id: 'q', selectedOptions: [], customInput: '["A","B"]' }])
    expect(h.send({ type: 'answer', id: 'a', promptId: 'ask', optionIds: ['option_2', 'option_0'] })).toEqual([])
    expect(h.items().filter(item => item.kind === 'user_message').at(-1)).toMatchObject({ text: 'A, C' })
    expect(h.state.pending[0].prompt).toMatchObject({ id: 'ask:1', multi: false, progress: { index: 2, total: 2 } })
    expect(h.send({ type: 'answer', id: 'b', promptId: 'ask:1', optionIds: ['option_0', 'option_1'] })).toEqual([])
    expect(h.state.pending[0].prompt.id).toBe('ask:1')
    expect(h.send({ type: 'answer', id: 'c', promptId: 'ask:1', optionId: 'option_1' })).toEqual(['{"type":"extension_ui_response","id":"ask","answers":[{"id":"q","selectedOptions":["A","C"]},{"id":"r","selectedOptions":["Y"]}]}'])
  })
  it('scopes successful todo execution through observed tail correlation and retains prior todos on invalid replacements', () => {
    const h = initialized()
    h.send({ type: 'get_subagent_messages', id: 'tail', subagentId: 'worker', fromByte: 0 })
    h.feed({ type: 'response', command: 'get_subagent_messages', id: 'tail', success: true, data: { messages: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'todo', name: 'todo', arguments: {} }] }], nextByte: 10 } })
    expect(h.feed({ type: 'tool_execution_end', toolCallId: 'todo', toolName: 'todo', isError: false, result: { details: { phases } } })).toEqual([{ type: 'todos', threadId: 'worker', phases }])
    expect(h.feed({ type: 'tool_execution_end', toolCallId: 'bad', toolName: 'todo', isError: false, result: { details: { phases: [{ name: 'bad', tasks: [{ content: 'bad', status: 'invented' }] }] } } })).toEqual([])
    expect(h.state.skipped).toBe(1)
    expect(h.state.tailOffsets.get('worker')).toBe(10)
  })
})

describe('OMP lifecycle edge contracts', () => {
  it('does not use uncorrelated tail data or get_state responses', () => {
    const h = initialized()
    expect(h.feed({ type: 'response', command: 'get_subagent_messages', id: 'unknown', success: true, data: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'wrong thread' }] }] } })).toEqual([])
    expect(h.feed({ type: 'response', command: 'get_state', id: 'unknown', success: true, data: { todoPhases: phases } })).toEqual([])
  })
  it('requires ready initialization, keeps v1 compatible, and sends an oversized v1 turn as one line', () => {
    const h = harness()
    expect(h.init({ type: 'other' })).toEqual([])
    expect(() => h.send({ type: 'send', id: 'prompt', text: 'early' })).toThrow('initialization')
    const ready = { type: 'ready', protocolVersion: 1, supportedProtocolVersions: [1], maxFrameBytes: 100 }
    h.feed(ready)
    expect(h.init(ready).map(line => JSON.parse(line).type)).toEqual(['set_ask_dialog', 'set_subagent_subscription', 'set_event_filter', 'get_state'])
    expect(h.send({ type: 'send', id: 'prompt', text: 'x'.repeat(300) })).toEqual([JSON.stringify({ type: 'prompt', id: 'prompt', message: 'x'.repeat(300) })])
    expect(() => h.send({ type: 'send', id: 'framed', text: 'x'.repeat(300) }, { chunkId: 'chunk' })).toThrow('protocol v2')
    expect(() => h.send({ type: 'interrupt', id: '' })).toThrow('requires an id')
  })
  it('settles main tools and pending prompts on abort without settling background workers', () => {
    const h = initialized()
    h.feed({ type: 'subagent_lifecycle', payload: { id: 'worker', status: 'running' } })
    h.feed({ type: 'tool_execution_start', toolCallId: 'main', toolName: 'bash', args: {} })
    h.feed({ type: 'extension_ui_request', id: 'input', method: 'input' })
    h.feed({ type: 'prompt_result', status: 'aborted' })
    expect(h.state.tools.get('main')?.status).toBe('cancelled')
    expect(h.state.threads.get('worker')?.state).toBe('running')
    expect(h.state.pending).toEqual([])
  })
  it('preserves text block indices across multiple messages and final-frame repetition', () => {
    const h = initialized()
    for (const text of ['One', 'Two']) {
      h.feed({ type: 'message_start', message: { role: 'assistant' } })
      h.feed({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Think.' } })
      h.feed({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta: text } })
      const message = { role: 'assistant', content: [{ type: 'thinking', thinking: 'Think.' }, { type: 'text', text }] }
      h.feed({ type: 'message_end', message }); h.feed({ type: 'turn_end', message })
    }
    expect(h.items()).toEqual([textItem('One', 1), { kind: 'assistant_text', id: 'omp:main:message:2:1', at, text: 'Two' }])
  })
})

describe('OMP reserved free-text affordance', () => {
  it('keeps literal text and Other labels distinct from the reserved text option', () => {
    const h = initialized()
    h.feed({ type: 'extension_ui_request', id: 'ask', method: 'ask', questions: [{ id: 'q', question: 'Pick', options: [{ label: 'text' }, { label: 'Other' }] }] })
    expect(h.state.pending[0].prompt.options).toEqual([{ id: 'option_0', label: 'text' }, { id: 'option_1', label: 'Other' }, { id: 'text', label: 'Other' }])
    expect(h.send({ type: 'answer', id: 'answer', promptId: 'ask', optionId: 'option_0' })).toEqual(['{"type":"extension_ui_response","id":"ask","answers":[{"id":"q","selectedOptions":["text"]}]}'])
  })
  it('accepts empty free text explicitly but never invents free text for select or confirm', () => {
    const h = initialized()
    h.feed({ type: 'extension_ui_request', id: 'input', method: 'input' })
    expect(h.state.pending[0].prompt.options).toEqual([{ id: 'text', label: 'Answer' }])
    expect(h.send({ type: 'answer', id: 'answer', promptId: 'input', optionId: 'text', text: '' })).toEqual(['{"type":"extension_ui_response","id":"input","value":""}'])
    h.feed({ type: 'extension_ui_request', id: 'select', method: 'select', options: ['text', 'Other'] })
    expect(h.state.pending[0].prompt.options).toEqual([{ id: 'option_0', label: 'text' }, { id: 'option_1', label: 'Other' }])
    expect(h.send({ type: 'answer', id: 'answer', promptId: 'select', optionId: 'text', text: '' })).toEqual([])
    h.feed({ type: 'extension_ui_request', id: 'cancel', method: 'cancel', targetId: 'select' })
    h.feed({ type: 'extension_ui_request', id: 'confirm', method: 'confirm' })
    expect(h.state.pending[0].prompt.options).toEqual([{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }])
    for (const event of h.events) expect(agentChatEventSchema.safeParse({ ...event, chatId: 'test', folder: null }).success).toBe(true)
  })
})

function assertMaskedStream(token: string, parts: string[], kind: 'text' | 'thinking'): void {
  const h = harness()
  const expected = maskAgentChatSecretsDeep(token)
  expect(expected).not.toBe(token)
  h.feed({ type: 'message_start', message: { role: 'assistant' } })
  let exposed = ''
  for (const delta of parts) {
    for (const event of h.feed({ type: 'message_update', assistantMessageEvent: { type: `${kind}_delta`, contentIndex: 0, delta } })) {
      if (event.type === 'delta') exposed += event.text
    }
    // Every pushed prefix must already agree with the fully masked result. Later frames cannot retract it.
    expect(expected.startsWith(exposed)).toBe(true)
  }
  const content = kind === 'text' ? [{ type: 'text', text: token }] : [{ type: 'thinking', thinking: token }, { type: 'text', text: 'Done' }]
  const message = { role: 'assistant', content, stopReason: 'stop' }
  h.feed({ type: 'message_end', message }); h.feed({ type: 'turn_end', message })
  expect(h.events.filter(event => event.type === 'delta').map(event => event.text).join('')).toBe(expected)
  expect(h.items()).toEqual([textItem(kind === 'text' ? expected : 'Done', kind === 'text' ? 0 : 1)])
  expect(JSON.stringify(h.events)).not.toContain(token)
}
const claimId = '01j0000000000000000000000a'
const claimFormats = ['at', 'ka'].flatMap(prefix => [0, 1, 15, 16, 32, 64].map(length => ({
  name: `${prefix} claim with ${length} secret characters`, token: `${prefix}_${claimId}.${'s'.repeat(length)}`, delimited: length >= 16
})))
const grantFormats = ['dmg', 'Dmg', 'dMg', 'dmG', 'DMg', 'DmG', 'dMG', 'DMG'].flatMap(prefix => [16, 64].map(length => ({
  name: `${prefix} grant with ${length} hex characters`, token: `${prefix}_${'aB09'.repeat(length / 4)}`, delimited: true
})))
const gluedFormats = ['at', 'ka'].flatMap(first => ['at', 'ka'].map(second => ({
  name: `${first}/${second} adjacent claims`, token: `${first}_${claimId}.short${second}_${claimId}.${'s'.repeat(32)}`, delimited: true
})))

describe('OMP corrective streaming secret coverage', () => {
  for (const kind of ['text', 'thinking'] as const) it.each([...claimFormats, ...grantFormats, ...gluedFormats])(`${kind}: every split of $name`, ({ token, delimited }) => {
    for (let split = 0; split <= token.length; split++) assertMaskedStream(token, [token.slice(0, split), token.slice(split)], kind)
    assertMaskedStream(token, [...token], kind)
    // Shared masking treats sub-16-character secrets as credentials only at a tail or before a glued token.
    if (delimited) assertMaskedStream(`${token} / after`, [...token, ' / after'], kind)
  })
})

describe('OMP corrective thread-scoped errors', () => {
  it('keeps identical worker and main failures separate and deduplicates each scope across repeated final frames', () => {
    const h = initialized()
    const message = { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Provider failure' }
    for (const threadId of ['worker-a', 'worker-b']) {
      h.send({ type: 'get_subagent_messages', id: threadId, subagentId: threadId, fromByte: 0 })
      h.feed({ type: 'response', command: 'get_subagent_messages', id: threadId, success: true, data: { messages: [message, message], nextByte: 10 } })
    }
    h.feed({ type: 'message_end', message }); h.feed({ type: 'turn_end', message })
    h.feed({ type: 'prompt_result', status: 'error', error: { message: 'Provider failure' } })
    expect(h.items()).toEqual([
      { kind: 'error', id: 'omp:error:1', at, message: 'Provider failure', threadId: 'worker-a' },
      { kind: 'error', id: 'omp:error:2', at, message: 'Provider failure', threadId: 'worker-b' },
      { kind: 'error', id: 'omp:error:3', at, message: 'Provider failure' }
    ])
    h.feed({ type: 'agent_start' })
    h.send({ type: 'get_subagent_messages', id: 'again', subagentId: 'worker-a', fromByte: 0 })
    expect(h.feed({ type: 'response', command: 'get_subagent_messages', id: 'again', success: true, data: { messages: [message], nextByte: 10 } })).toEqual([])
    h.feed({ type: 'message_start', message: { role: 'assistant' } })
    h.feed({ type: 'message_end', message }); h.feed({ type: 'turn_end', message })
    h.feed({ type: 'prompt_result', status: 'error', error: { message: 'Provider failure' } })
    expect(h.items().slice(3)).toEqual([{ kind: 'error', id: 'omp:error:4', at, message: 'Provider failure' }])
  })
})

function resultChunks(chunkId: string, count: number): Record<string, unknown>[] {
  const bytes = Buffer.from(JSON.stringify({ type: 'tool_execution_end', toolCallId: chunkId, toolName: 'read', isError: false, result: { content: [{ type: 'text', text: 'Complete' }] } }))
  const size = Math.ceil(bytes.length / count)
  return Array.from({ length: count }, (_, index) => ({
    type: 'rpc_chunk', chunkId, index, count, byteLength: bytes.length,
    data: bytes.subarray(index * size, (index + 1) * size).toString('base64')
  }))
}
function expectChunkQuarantine(h: { state: { rejectedChunks: string[] }; items(): ChatItem[] }): void {
  expect(h.items().filter(item => item.kind === 'error')).toHaveLength(1)
  expect(h.items().filter(item => item.kind === 'tool_call')).toEqual([])
  expect(h.state.rejectedChunks.length).toBeLessThanOrEqual(2)
  expect(h.state.rejectedChunks.every(id => id.length <= 128)).toBe(true)
}

describe('OMP malformed chunk IDs', () => {
  it.each([
    ['null toString object', { toString: null }],
    ['plain object', {}],
    ['array', []],
    ['string array', ['quarantined']],
    ['object array', [{ toString: null }]],
    ['null', null],
    ['number', 1],
    ['boolean', false]
  ])('rejects a %s chunk ID without coercion and recovers after bounded quarantine', (_label, chunkId) => {
    const h = initialized()
    const malformed = { ...resultChunks('invalid', 2)[1], chunkId }
    h.feed(malformed)
    expectChunkQuarantine(h)
    expect(h.state.chunk).toBeNull()
    expect(h.state.recoveringChunks).toBe(true)
    expect(h.state.rejectedChunks).toEqual([])
    for (let index = 0; index < 100; index++) h.feed(malformed)
    expectChunkQuarantine(h)
    const interrupted = resultChunks('interrupted', 2)
    h.feed(interrupted[0]); h.feed(malformed); h.feed(interrupted[1])
    expectChunkQuarantine(h)
    expect(h.state.rejectedChunks).toEqual(['interrupted'])
    resultChunks('clean', 2).forEach(frame => h.feed(frame))
    expect(h.items().filter(item => item.kind === 'tool_call')).toEqual([toolItem('clean', 'read', {}, 'Complete')])
    expect(h.state.chunk).toBeNull()
    expect(h.state.recoveringChunks).toBe(false)
    expect(h.items().filter(item => item.kind === 'error')).toHaveLength(1)
  })
})

describe('OMP corrective chunk quarantine', () => {
  it.each([2, 3, 5])('rejects two interleaved %i-chunk transfers once and recovers on a clean transfer', count => {
    const h = initialized()
    const a = resultChunks('a', count); const b = resultChunks('b', count)
    h.feed(a[0]); h.feed(b[0])
    expect(h.state.rejectedChunks).toEqual(['a', 'b'])
    for (let index = 1; index < count; index++) { h.feed(a[index]); h.feed(b[index]); expectChunkQuarantine(h) }
    resultChunks('clean', count).forEach(frame => h.feed(frame))
    expect(h.items().filter(item => item.kind === 'tool_call')).toEqual([toolItem('clean', 'read', {}, 'Complete')])
    expect(h.state.recoveringChunks).toBe(false)
    h.feed(a[1]); h.feed(b[1])
    expect(h.items().filter(item => item.kind === 'error')).toHaveLength(1)
    h.feed({ ...resultChunks('next-bad', 2)[0], data: 'Zh==' })
    expect(h.items().filter(item => item.kind === 'error')).toHaveLength(2)
  })
  it('quarantines many interleaved IDs with bounded state and discards interrupted recovery candidates', () => {
    const h = initialized()
    const transfers = Array.from({ length: 100 }, (_, index) => resultChunks(`transfer-${index}`, 3))
    for (const frames of transfers) h.feed(frames[0])
    for (const frames of transfers) { h.feed(frames[1]); h.feed(frames[2]); expectChunkQuarantine(h) }
    const candidate = resultChunks('candidate', 2)
    h.feed(candidate[0]); h.feed(transfers[0][1]); h.feed(candidate[1])
    expectChunkQuarantine(h)
    h.feed({ ...resultChunks('oversized-id', 2)[0], chunkId: 'x'.repeat(1000) })
    expectChunkQuarantine(h)
    resultChunks('clean', 3).forEach(frame => h.feed(frame))
    expect(h.items().filter(item => item.kind === 'tool_call')).toEqual([toolItem('clean', 'read', {}, 'Complete')])
    expect(h.state.chunk).toBeNull()
    expect(h.state.recoveringChunks).toBe(false)
  })
})


describe('OMP main-private worker claims', () => {
  it('extracts the raw fixture token once, never pushes it, and completes the thread', () => {
    const h = initialized()
    const first = JSON.parse(lines('worker_claim', 'in')[0])
    expect(h.send({ type: 'send', id: first.id, text: first.message })).toEqual(lines('worker_claim', 'in'))
    lines('worker_claim', 'out').forEach(line => h.feed(line))
    const claim = { type: 'thread_claim', threadId: 'agent_T1_claim_worker', attemptId: 'at_01j0000000000000000000000a',
      token: 'at_01j0000000000000000000000a.fixtureSecretAAAAAAAAAAAAAAAAAAA' }
    expect(h.internalEvents).toEqual([claim])
    expect(h.items()).toContainEqual(expect.objectContaining({ kind: 'thread', id: claim.threadId, state: 'done' }))
    expect(h.state.skipped).toBe(0)
    expect(JSON.stringify(h.events)).not.toContain('fixtureSecret')
    expect(agentChatEventSchema.safeParse({ ...claim, folder: null, chatId: 'fixture' }).success).toBe(false)
    for (const event of h.events) expect(agentChatEventSchema.safeParse({ ...event, folder: null, chatId: 'fixture' }).success).toBe(true)
  })
  it('rejects missing or ambiguous tokens, including different secrets for one attempt', () => {
    const token = 'at_01j0000000000000000000000a.fixtureSecretAAAAAAAAAAAAAAAAAAA'
    const other = 'at_01j0000000000000000000000b.fixtureSecretBBBBBBBBBBBBBBBBBBB'
    for (const [task, count] of [['no claim', 0], [token, 1], [`${token} ${token}`, 1],
      [`${token} ${other}`, 0], [`${token} ${token.replace('fixtureSecret', 'differentSecret')}`, 0]] as const) {
      const h = initialized()
      const frame = { type: 'subagent_lifecycle', payload: { id: 'claim-worker', task, status: 'running' } }
      h.feed(frame); h.feed(frame)
      expect(h.internalEvents).toHaveLength(count)
      expect(JSON.stringify(h.events)).not.toContain('Secret')
    }
  })
})

describe('OMP worker claims when lifecycle precedes the raw task', () => {
  it.each(['single', 'repeated', 'absent', 'different attempts', 'different secrets'])('inspects the first progress task once: %s', scenario => {
    const token = 'at_01j0000000000000000000000a.fixtureSecretAAAAAAAAAAAAAAAAAAA'
    const other = 'at_01j0000000000000000000000b.fixtureSecretBBBBBBBBBBBBBBBBBBB'
    const tasks: Record<string, string> = {
      single: token, repeated: `${token} ${token}`, absent: 'Run tests without a claim',
      'different attempts': `${token} ${other}`, 'different secrets': `${token} ${token.replace('fixtureSecret', 'differentSecret')}`
    }
    const h = initialized()
    const lifecycle = { type: 'subagent_lifecycle', payload: { id: 'late-task-worker', agent: 'task', status: 'running' } }
    h.feed(lifecycle)
    expect(h.state.threads.has('late-task-worker')).toBe(true)
    expect(h.state.claimTasksSeen.size).toBe(0)
    expect(h.internalEvents).toEqual([])
    const progress = { type: 'subagent_progress', payload: { agent: 'task', task: tasks[scenario],
      progress: { id: 'late-task-worker', status: 'running' } } }
    h.feed(progress)
    const expected = ['single', 'repeated'].includes(scenario)
      ? [{ type: 'thread_claim', threadId: 'late-task-worker', attemptId: 'at_01j0000000000000000000000a', token }]
      : []
    expect(h.internalEvents).toEqual(expected)
    expect([...h.state.claimTasksSeen]).toEqual(['late-task-worker'])
    h.feed(progress); h.feed(lifecycle)
    // Later text cannot replace a missing or ambiguous initial claim, or duplicate a valid one.
    h.feed({ ...progress, payload: { ...progress.payload, task: token } })
    h.feed({ ...lifecycle, payload: { ...lifecycle.payload, status: 'completed' } })
    expect(h.internalEvents).toEqual(expected)
    expect(JSON.stringify(h.events)).not.toContain('Secret')
    expect(JSON.stringify([...h.state.threads.values()])).not.toContain('Secret')
    for (const event of h.events) expect(agentChatEventSchema.safeParse({ ...event, folder: null, chatId: 'fixture' }).success).toBe(true)
  })
})

it('namespaces synthesized ids and their streams without changing provider tool or session ids', () => {
  const first = harness('generation-a:'), second = harness('generation-b:')
  for (const scenario of ['init', 'text', 'tool', 'error', 'interrupt']) {
    for (const line of lines(scenario, 'out')) { first.feed(line); second.feed(line) }
  }
  const synthesized = (events: OmpEvent[]) => events.flatMap(event => {
    if (event.type === 'delta' || event.type === 'stream_end') return [event.itemId]
    if (event.type === 'item' && ['assistant_text', 'error', 'turn_stopped'].includes(event.item.kind)) return [event.item.id]
    return []
  })
  const a = synthesized(first.events), b = synthesized(second.events)
  expect(a.length).toBeGreaterThan(0)
  expect(a.every(id => id.startsWith('omp:generation-a:'))).toBe(true)
  expect(b).toEqual(a.map(id => id.replace('generation-a:', 'generation-b:')))
  expect(first.events.some(event => event.type === 'stream_end')).toBe(true)
  expect(first.state.sessionId).toBe(second.state.sessionId)
  const toolIds = (events: OmpEvent[]) => events.flatMap(event => event.type === 'item' && event.item.kind === 'tool_call' ? [event.item.id] : [])
  expect(toolIds(first.events)).toEqual(toolIds(second.events))
  expect(toolIds(first.events)).toContain('call_T1_read')
})

describe('main-issued get_available_models', () => {
  it('writes the request and hands its reply only to main, never to the transcript', () => {
    const h = initialized()
    expect(h.send({ type: 'get_available_models', id: 'models_1' }).map(line => JSON.parse(line))).toEqual([{ type: 'get_available_models', id: 'models_1' }])
    const data = { models: [{ provider: 'anthropic', id: 'claude-opus-5-5' }] }
    expect(h.feed({ id: 'models_1', type: 'response', command: 'get_available_models', success: true, data })).toEqual([])
    expect(h.internalEvents).toEqual([{ type: 'command_result', id: 'models_1', ok: true, data }])
    expect(h.state.commands.has('models_1')).toBe(false)
  })

  it('reports a refused request to main without an error item', () => {
    const h = initialized()
    h.send({ type: 'get_available_models', id: 'models_2' })
    expect(h.feed({ id: 'models_2', type: 'response', command: 'get_available_models', success: false, error: 'nope' })).toEqual([])
    expect(h.internalEvents).toEqual([{ type: 'command_result', id: 'models_2', ok: false, data: undefined }])
  })

  it('ignores a reply to an id main never asked', () => {
    const h = initialized()
    h.feed({ id: 'models_3', type: 'response', command: 'get_available_models', success: true, data: { models: [] } })
    expect(h.internalEvents).toEqual([])
  })
})

describe('model switching', () => {
  it('writes set_model and set_thinking_level exactly as omp 18.20.2 takes them, and hands their replies only to main', () => {
    const h = initialized()
    expect(h.send({ type: 'set_model', id: 'model_1', provider: 'openai-codex', modelId: 'gpt-6-sol' }))
      .toEqual(['{"type":"set_model","id":"model_1","provider":"openai-codex","modelId":"gpt-6-sol"}'])
    expect(h.send({ type: 'set_thinking_level', id: 'thinking_1', level: 'medium' })).toEqual(['{"type":"set_thinking_level","id":"thinking_1","level":"medium"}'])
    expect(h.feed({ id: 'model_1', type: 'response', command: 'set_model', success: true })).toEqual([])
    expect(h.feed({ id: 'thinking_1', type: 'response', command: 'set_thinking_level', success: false, error: 'Invalid level' })).toEqual([])
    expect(h.internalEvents).toEqual([{ type: 'command_result', id: 'model_1', ok: true, data: undefined }, { type: 'command_result', id: 'thinking_1', ok: false, data: undefined }])
    expect(h.state.commands.size).toBe(0)
  })

  it("decodes get_state's model and thinking level, at start and on main's own get_state", () => {
    const h = initialized()
    expect([h.state.model, h.state.thinking]).toEqual([null, 'off'])
    expect(h.send({ type: 'get_state', id: 'state_1' })).toEqual(['{"type":"get_state","id":"state_1"}'])
    const data = { model: { provider: 'openai-codex', id: 'gpt-6-sol', name: 'GPT-6 Sol' }, thinkingLevel: 'medium', sessionId: 'session_T1', sessionFile: 'C:/fixture/repo/session_T1.jsonl' }
    expect(h.feed({ id: 'state_1', type: 'response', command: 'get_state', success: true, data })).toEqual([])
    expect(h.internalEvents).toEqual([{ type: 'command_result', id: 'state_1', ok: true, data }])
    expect([h.state.model, h.state.thinking, h.state.sessionId]).toEqual(['openai-codex/gpt-6-sol', 'medium', 'session_T1'])
    h.send({ type: 'get_state', id: 'state_2' })
    h.feed({ id: 'state_2', type: 'response', command: 'get_state', success: true, data: { model: { provider: 'anthropic' }, thinkingLevel: 'auto' } })
    expect([h.state.model, h.state.thinking]).toEqual([null, null])
  })
})

const swatch = readFileSync(join(import.meta.dirname, '__fixtures__', 'images', 'swatch.png'))
const swatchBase64 = swatch.toString('base64')

describe('OMP image turns', () => {
  it('encodes image_in byte for byte, and follow_up carries the same images', () => {
    const h = initialized()
    const images = [{ mime: 'image/png' as const, base64: swatchBase64 }]
    expect(h.send({ type: 'send', id: 'req_T1_image_in', text: 'what colour', images })).toEqual(lines('image_in', 'in'))
    expect(JSON.parse(h.send({ type: 'send', id: 'req_T1_image_follow', text: '', images })[0])).toEqual({ type: 'follow_up', id: 'req_T1_image_follow', message: '',
      images: [{ type: 'image', mimeType: 'image/png', data: swatchBase64 }] })
    expect(h.items()).toEqual([{ kind: 'user_message', id: 'req_T1_image_in', at, text: 'what colour' }, { kind: 'user_message', id: 'req_T1_image_follow', at, text: '' }])
    lines('image_in', 'out').forEach(line => h.feed(line))
    expect(h.blobs).toEqual([])
    expect(JSON.stringify(h.events)).not.toContain(swatchBase64.slice(0, 32))
  })
  it('writes an image over maxFrameBytes as one unsplit line and refuses one over maxReassembledFrameBytes', () => {
    const h = initialized()
    expect(h.state.protocolVersion).toBe(2)
    const big = [{ mime: 'image/png' as const, base64: 'A'.repeat(h.state.maxFrameBytes + 4) }]
    const sent = h.send({ type: 'send', id: 'req_T1_big', text: 'big', images: big })
    expect(sent).toHaveLength(1)
    expect(Buffer.byteLength(sent[0])).toBeGreaterThan(h.state.maxFrameBytes)
    expect(JSON.parse(sent[0])).toEqual({ type: 'prompt', id: 'req_T1_big', message: 'big', images: [{ type: 'image', mimeType: 'image/png', data: big[0].base64 }] })
    const limited = initialized()
    limited.feed({ type: 'ready', maxFrameBytes: 1_048_576, maxReassembledFrameBytes: 2_097_152 })
    let error: unknown
    try { limited.send({ type: 'send', id: 'req_T1_huge', text: '', images: [{ mime: 'image/png', base64: 'A'.repeat(2_097_152) }] }) } catch (caught) { error = caught }
    expect(error).toMatchObject({ code: 'image_too_large' })
    expect(limited.state.inFlight).toBe(false)
    expect(limited.items()).toEqual([])
  })
})

describe('OMP tool-result images', () => {
  it('lifts image_result into exactly one blob equal to swatch.png and no event', () => {
    const { h, input, encoded } = replayGolden('image_result')
    expect(encoded).toEqual(input)
    expect(h.blobs).toEqual([{ itemId: 'call_T1_read_image', mime: 'image/png', base64: swatchBase64 }])
    expect(Buffer.from(h.blobs[0].base64, 'base64').equals(swatch)).toBe(true)
    expect(JSON.stringify(h.events)).not.toContain(swatchBase64.slice(0, 32))
    expect(h.items().filter(item => item.kind !== 'user_message')).toEqual([toolItem('call_T1_read_image', 'read', { path: 'swatch.png' }, 'Read image file [image/png]'),
      { kind: 'assistant_text', id: 'omp:main:message:3:0', at, text: 'Red' }])
    expect(h.state.skipped).toBe(0)
    for (const event of h.events) expect(agentChatEventSchema.safeParse({ ...event, folder: null, chatId: 'fixture' }).success).toBe(true)
  })
  it('notes unsupported images as not shown, lifts WebP, and keeps one summary across duplicate copies', () => {
    const h = initialized(), webp = webpBytes(64, 64).toString('base64'), gif = Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;', 'latin1').toString('base64')
    const content = [{ type: 'text', text: 'Read' }, { type: 'image', mimeType: 'image/gif', data: gif }, { type: 'image', data: webp, mimeType: 'image/webp' },
      { type: 'image', mimeType: 'image/jpeg', data: swatchBase64 }]
    h.feed({ type: 'tool_execution_start', toolCallId: 'call_T1_images', toolName: 'read', args: { path: 'a' } })
    h.feed({ type: 'tool_execution_end', toolCallId: 'call_T1_images', toolName: 'read', result: { content }, isError: false })
    h.feed({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'call_T1_images', toolName: 'read', content, isError: false } })
    h.feed({ type: 'turn_end', message: { role: 'assistant', content: [] }, toolResults: [{ role: 'toolResult', toolCallId: 'call_T1_images', toolName: 'read', content, isError: false }] })
    expect(h.blobs).toEqual([{ itemId: 'call_T1_images', mime: 'image/webp', base64: webp }])
    const summaries = h.events.flatMap(event => event.type === 'item' && event.item.kind === 'tool_call' && event.item.status === 'completed' ? [event.item.resultSummary] : [])
    expect(summaries.length).toBeGreaterThan(1)
    for (const summary of summaries) expect(summary).toBe('Read\n1 image (image/gif, not shown)\n1 image (image/jpeg, not shown)')
    for (const prefix of [webp, gif, swatchBase64]) expect(JSON.stringify(h.events)).not.toContain(prefix.slice(0, 32))
  })
})
