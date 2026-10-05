/**
 * The Codex adapter against recorded `codex app-server` exchanges. The recordings follow the
 * protocol's published schema (https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol,
 * `schema/typescript`: ClientRequest, ServerRequest, ServerNotification and the v2 types); they were
 * written from it, not captured from a running Codex.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  ApprovalDecision,
  ChatAdapter,
  ChatAdapterEvent,
  ChatAdapterStartOptions,
  ChatItem
} from '../../../shared/agents/chat'
import { replayTransport, step, type Json, type ReplayTransport, type Step } from '../__mocks__/codexReplay'
import { AT, REPO } from '../__mocks__/fakeChatAdapter'
import { CHAT_ADAPTERS } from '../adapterRegistry'
import { codexAdapterDefinition, createCodexAdapter, type CodexDeps } from './codex'

const THREAD = 'thr_1'
const TURN = 'turn_1'

function options(overrides: Partial<ChatAdapterStartOptions> = {}): ChatAdapterStartOptions {
  return {
    chatId: 'chat_1',
    folder: REPO,
    model: null,
    role: 'planner',
    allowSave: true,
    sessionId: null,
    darkMechanicus: {
      command: 'node',
      args: ['/app/out/main/mcp.js', '--role', 'planner', '--allow-save', '--label', 'Codex · Plan'],
      env: { DM_HOME: '/state' }
    },
    ...overrides
  }
}

// ---- Recorded building blocks ----

const INITIALIZE: Step[] = [
  step.expect('initialize', { clientInfo: { name: 'dark-mechanicus', title: 'Dark Mechanicus', version: '9.9.9' }, capabilities: null }),
  step.reply({ userAgent: 'codex/0.99.0', codexHome: '/home/me/.codex', platformFamily: 'unix', platformOs: 'linux' }),
  step.expect('initialized')
]

const THREAD_RESULT: Json = { thread: { id: THREAD, turns: [] }, model: 'gpt-5-codex', approvalPolicy: 'untrusted' }

const NEW_THREAD: Step[] = [...INITIALIZE, step.expect('thread/start'), step.reply(THREAD_RESULT)]

const TURN_OBJECT = (status: string, extra: Record<string, Json> = {}): Json => ({ id: TURN, items: [], status, error: null, ...extra })

/** One turn: the client's turn/start, the server's acknowledgement, then what happens until `finish`. */
function turn(body: Step[], finish: Step[] = [step.notify('turn/completed', { threadId: THREAD, turn: TURN_OBJECT('completed') })]): Step[] {
  return [
    step.expect('turn/start', { threadId: THREAD }),
    step.reply({ turn: TURN_OBJECT('inProgress') }),
    step.notify('turn/started', { threadId: THREAD, turn: TURN_OBJECT('inProgress') }),
    ...body,
    ...finish
  ]
}

const at = { threadId: THREAD, turnId: TURN }

function started(item: Json): Step {
  return step.notify('item/started', { ...at, startedAtMs: 1, item })
}

function completed(item: Json): Step {
  return step.notify('item/completed', { ...at, completedAtMs: 2, item })
}

function command(id: string, text: string, fields: Record<string, Json> = {}): Json {
  return { type: 'commandExecution', id, command: text, cwd: REPO, status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, ...fields }
}

function fileChange(id: string, status: string): Json {
  return { type: 'fileChange', id, status, changes: [{ path: 'src/a.ts', kind: { type: 'update', move_path: null }, diff: '@@' }] }
}

// ---- The rig ----

interface Rig {
  adapter: ChatAdapter
  events: ChatAdapterEvent[]
  transports: ReplayTransport[]
  connects: { executablePath: string; folder: string }[]
  /** The answers to give, in order, to the approval requests the adapter raises. */
  answers: ApprovalDecision[]
  /** When set, approval requests wait in `held` for the test to answer instead of being answered from `answers`. */
  hold: boolean
  held: ((decision: ApprovalDecision) => void)[]
  /** The transcript the session manager would store: items and approval requests, in order. */
  transcript(): ChatItem[]
}

interface RigOptions {
  deps?: Partial<CodexDeps>
}

function rig(scripts: Step[][], { deps = {} }: RigOptions = {}): Rig {
  const transports = scripts.map((script) => replayTransport(script))
  const connects: Rig['connects'] = []
  let count = 0
  const answers: ApprovalDecision[] = []
  const events: ChatAdapterEvent[] = []
  const adapter = createCodexAdapter('/bin/codex', {
    connect: (executablePath, folder) => {
      connects.push({ executablePath, folder })
      const next = transports[connects.length - 1]
      if (next === undefined) {
        throw new Error('The test recorded no more connections.')
      }
      return next
    },
    newId: () => `n${(count += 1)}`,
    now: () => AT,
    clientVersion: '9.9.9',
    ...deps
  })
  return {
    adapter,
    events,
    transports,
    connects,
    answers,
    hold: false,
    held: [],
    transcript: () =>
      events.flatMap((event) => {
        if (event.type === 'item') {
          return [event.item]
        }
        return event.type === 'approval_request' ? [event.request] : []
      })
  }
}

/** Starts the adapter, answering approval requests from `answers` a moment after they are raised. */
function start(target: Rig, startOptions: ChatAdapterStartOptions = options()): Promise<void> {
  return target.adapter.start(startOptions, (event) => {
    target.events.push(event)
    if (event.type !== 'approval_request') {
      return
    }
    if (target.hold) {
      target.held.push(event.respond)
      return
    }
    const decision = target.answers.shift() ?? 'deny'
    void Promise.resolve().then(() => {
      event.respond(decision)
    })
  })
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function transport(target: Rig, index = 0): ReplayTransport {
  const found = target.transports[index]
  if (found === undefined) {
    throw new Error(`No transport ${index}`)
  }
  return found
}

function written(target: Rig, index = 0): Record<string, unknown>[] {
  return transport(target, index).written
}

function methods(target: Rig, index = 0): unknown[] {
  return written(target, index).map((message) => message.method)
}

function assistantText(id: string, text: string): ChatItem {
  return { id, at: AT, kind: 'assistant_text', text }
}

const MAPPING: [ApprovalDecision, string][] = [
  ['allow_once', 'accept'],
  ['allow_chat', 'acceptForSession'],
  ['deny', 'decline']
]

const PAGE_ONE: Step[] = [
  step.expect('model/list'),
  step.reply({
    data: [
      { id: 'gpt-5-codex', model: 'gpt-5-codex', displayName: 'GPT-5 Codex', hidden: false, isDefault: true },
      { id: 'legacy', model: 'legacy', displayName: 'Legacy', hidden: true }
    ],
    nextCursor: 'page-2'
  })
]
const PAGE_TWO: Step[] = [
  step.expect('model/list', { cursor: 'page-2' }),
  step.reply({ data: [{ id: 'gpt-5', model: 'gpt-5', displayName: 'GPT-5', hidden: false }, { id: 'bare', model: 'bare', hidden: false }], nextCursor: null })
]

const INTERRUPTED = step.notify('turn/completed', { threadId: THREAD, turn: TURN_OBJECT('interrupted') })

// ---- c1: a recorded exchange replays into transcript items ----

const FULL_TURN: Step[] = turn([
  started({ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Run the tests', text_elements: [] }] }),
  started({ type: 'reasoning', id: 'r1', summary: [], content: [] }),
  step.notify('item/agentMessage/delta', { ...at, itemId: 'm1', delta: 'I will ' }),
  step.notify('item/agentMessage/delta', { ...at, itemId: 'm1', delta: 'run the tests.' }),
  completed({ type: 'agentMessage', id: 'm1', text: 'I will run the tests.' }),
  started(command('c1', 'npm test')),
  step.ask(100, 'item/commandExecution/requestApproval', { ...at, itemId: 'c1', command: 'npm test', cwd: REPO, reason: null, kind: 'command' }),
  step.expectResponse(100, { decision: 'accept' }),
  completed(command('c1', 'npm test', { status: 'completed', aggregatedOutput: '1 failed', exitCode: 1 })),
  started(fileChange('p1', 'inProgress')),
  step.ask(101, 'item/fileChange/requestApproval', { ...at, itemId: 'p1', reason: null, grantRoot: null }),
  step.expectResponse(101, { decision: 'acceptForSession' }),
  completed(fileChange('p1', 'completed')),
  started({ type: 'mcpToolCall', id: 'k1', server: 'darkmechanicus', tool: 'get_ticket', status: 'inProgress', arguments: { id: 'DM-54' }, result: null, error: null }),
  completed({
    type: 'mcpToolCall',
    id: 'k1',
    server: 'darkmechanicus',
    tool: 'get_ticket',
    status: 'completed',
    arguments: { id: 'DM-54' },
    result: { content: [{ type: 'text', text: 'DM-54 is running' }], structuredContent: null },
    error: null
  }),
  started(command('c2', 'rm -rf build')),
  step.ask(102, 'item/commandExecution/requestApproval', { ...at, itemId: 'c2', command: 'rm -rf build', cwd: REPO, reason: 'Delete the build', kind: 'command' }),
  step.expectResponse(102, { decision: 'decline' }),
  completed(command('c2', 'rm -rf build', { status: 'declined' })),
  step.notify('item/agentMessage/delta', { ...at, itemId: 'm2', delta: 'Done.' }),
  completed({ type: 'agentMessage', id: 'm2', text: 'Done.' })
])

const FULL_TURN_TRANSCRIPT: ChatItem[] = [
  assistantText(`${TURN}:m1`, 'I will run the tests.'),
  { id: `${TURN}:c1`, at: AT, kind: 'tool_call', name: 'command', input: { command: 'npm test', cwd: REPO }, status: 'running', resultSummary: null },
  {
    id: 'approval_n1',
    at: AT,
    kind: 'approval_request',
    requestId: 'n1',
    category: 'command',
    tool: 'shell',
    summary: 'Run: npm test',
    input: { command: 'npm test', cwd: REPO }
  },
  { id: `${TURN}:c1`, at: AT, kind: 'tool_call', name: 'command', input: { command: 'npm test', cwd: REPO }, status: 'completed', resultSummary: 'Exit code 1\n1 failed' },
  { id: `${TURN}:p1`, at: AT, kind: 'tool_call', name: 'file_change', input: { files: [{ path: 'src/a.ts', kind: 'update' }] }, status: 'running', resultSummary: null },
  {
    id: 'approval_n2',
    at: AT,
    kind: 'approval_request',
    requestId: 'n2',
    category: 'file_edit',
    tool: 'apply_patch',
    summary: 'Edit src/a.ts',
    input: { files: ['src/a.ts'] }
  },
  { id: `${TURN}:p1`, at: AT, kind: 'tool_call', name: 'file_change', input: { files: [{ path: 'src/a.ts', kind: 'update' }] }, status: 'completed', resultSummary: '1 file changed' },
  { id: `${TURN}:k1`, at: AT, kind: 'tool_call', name: 'darkmechanicus.get_ticket', input: { id: 'DM-54' }, status: 'running', resultSummary: null },
  { id: `${TURN}:k1`, at: AT, kind: 'tool_call', name: 'darkmechanicus.get_ticket', input: { id: 'DM-54' }, status: 'completed', resultSummary: 'DM-54 is running' },
  { id: `${TURN}:c2`, at: AT, kind: 'tool_call', name: 'command', input: { command: 'rm -rf build', cwd: REPO }, status: 'running', resultSummary: null },
  {
    id: 'approval_n3',
    at: AT,
    kind: 'approval_request',
    requestId: 'n3',
    category: 'command',
    tool: 'shell',
    summary: 'Run: rm -rf build',
    input: { command: 'rm -rf build', cwd: REPO, reason: 'Delete the build' }
  },
  { id: `${TURN}:c2`, at: AT, kind: 'tool_call', name: 'command', input: { command: 'rm -rf build', cwd: REPO }, status: 'denied', resultSummary: 'Declined' },
  assistantText(`${TURN}:m2`, 'Done.')
]

describe('a recorded turn', () => {
  it('replays into the expected transcript, deltas and approval answers (c1, c2)', async () => {
    const target = rig([[...NEW_THREAD, ...FULL_TURN]])
    target.answers.push('allow_once', 'allow_chat', 'deny')
    await start(target)

    await target.adapter.send('Run the tests')

    expect(target.transcript()).toEqual(FULL_TURN_TRANSCRIPT)
    expect(target.events.filter((event) => event.type === 'assistant_delta')).toEqual([
      { type: 'assistant_delta', itemId: `${TURN}:m1`, delta: 'I will ' },
      { type: 'assistant_delta', itemId: `${TURN}:m1`, delta: 'run the tests.' },
      { type: 'assistant_delta', itemId: `${TURN}:m2`, delta: 'Done.' }
    ])
    expect(transport(target).remaining()).toEqual([])
  })

  it('sends the user text, the chat model and the approval policy on turn/start', async () => {
    const target = rig([[...NEW_THREAD, ...turn([])]])
    await start(target, options({ model: 'gpt-5-codex' }))

    await target.adapter.send('hello there')

    expect(written(target).at(-1)).toEqual({
      id: expect.any(Number) as number,
      method: 'turn/start',
      params: {
        threadId: THREAD,
        input: [{ type: 'text', text: 'hello there', text_elements: [] }],
        model: 'gpt-5-codex',
        approvalPolicy: 'untrusted'
      }
    })
  })
})

describe('approval requests', () => {
  it('shows what a file change touches in its approval request and how many files', async () => {
    const changes = ['a.ts', 'b.ts', 'c.ts'].map((path) => ({ path, kind: { type: 'add' }, diff: '' }))
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          started({ type: 'fileChange', id: 'p9', status: 'inProgress', changes }),
          step.ask(107, 'item/fileChange/requestApproval', { ...at, itemId: 'p9', reason: 'Needs write access', grantRoot: '/repo' }),
          step.expectResponse(107, { decision: 'decline' })
        ])
      ]
    ])
    await start(target)

    await target.adapter.send('add files')

    expect(target.transcript().find((item) => item.kind === 'approval_request')).toMatchObject({
      category: 'file_edit',
      summary: 'Edit 3 files (a.ts, b.ts, c.ts)',
      input: { files: ['a.ts', 'b.ts', 'c.ts'], reason: 'Needs write access', grantRoot: '/repo' }
    })
  })

  it('describes a file change it saw no item for, and a command it has no text for', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          step.ask(108, 'item/fileChange/requestApproval', { ...at, itemId: 'unseen' }),
          step.expectResponse(108, { decision: 'decline' }),
          step.ask(109, 'item/commandExecution/requestApproval', { ...at, itemId: 'c9', kind: 'writeStdin' }),
          step.expectResponse(109, { decision: 'decline' })
        ])
      ]
    ])
    await start(target)

    await target.adapter.send('go')

    expect(target.transcript().filter((item) => item.kind === 'approval_request')).toMatchObject([
      { summary: 'Edit files', category: 'file_edit' },
      { summary: 'Run a command', category: 'command' }
    ])
  })
})

describe('tool calls in the transcript', () => {
  it('keeps long command text and output short', async () => {
    const long = 'x'.repeat(2_000)
    const target = rig([
      [...NEW_THREAD, ...turn([started(command('c1', long)), completed(command('c1', long, { status: 'completed', aggregatedOutput: long, exitCode: 0 }))])]
    ])
    await start(target)

    await target.adapter.send('go')

    const calls = target.transcript().filter((item) => item.kind === 'tool_call')
    expect(JSON.stringify(calls[0]).length).toBeLessThan(800)
    expect(calls[1]).toMatchObject({ status: 'completed' })
    expect(calls[1]?.kind === 'tool_call' && (calls[1].resultSummary ?? '').length).toBeLessThan(400)
  })

  it('maps failed tool calls, an MCP error, a compaction and ignores items it has no place for', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          completed(command('c1', 'false', { status: 'failed', aggregatedOutput: '', exitCode: 2 })),
          completed(fileChange('p1', 'failed')),
          completed(fileChange('p2', 'declined')),
          completed({ type: 'mcpToolCall', id: 'k1', server: 'darkmechanicus', tool: 'save_plan', status: 'failed', arguments: 'raw', result: null, error: { message: 'not allowed' } }),
          completed({ type: 'webSearch', id: 'w1', query: 'zod json' }),
          completed({ type: 'contextCompaction', id: 'cc1' }),
          completed({ type: 'plan', id: 'pl1', text: 'a plan' }),
          completed({ type: 'somethingNew', id: 'x1' }),
          step.notify('thread/tokenUsage/updated', { threadId: THREAD }),
          step.notify('item/completed', { ...at, item: 'not an item' }),
          step.notify('item/completed', { threadId: 'someone_else', turnId: 'other_turn', item: { type: 'agentMessage', id: 'm', text: 'from a subagent' } })
        ])
      ]
    ])
    await start(target)

    await target.adapter.send('go')

    expect(target.transcript()).toMatchObject([
      { name: 'command', status: 'failed', resultSummary: 'Exit code 2' },
      { name: 'file_change', status: 'failed', resultSummary: 'Failed' },
      { name: 'file_change', status: 'denied', resultSummary: 'Declined' },
      { name: 'darkmechanicus.save_plan', input: { value: 'raw' }, status: 'failed', resultSummary: 'not allowed' },
      { name: 'web_search', input: { query: 'zod json' }, status: 'completed' },
      { kind: 'context_reset', reason: 'compact' }
    ])
  })
})

describe('notices from the server', () => {
  it('reports the Dark Mechanicus server failing to start, and no other server', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          step.notify('mcpServer/startupStatus/updated', { threadId: THREAD, name: 'other', status: 'failed', error: 'x' }),
          step.notify('mcpServer/startupStatus/updated', { threadId: THREAD, name: 'darkmechanicus', status: 'ready', error: null }),
          step.notify('mcpServer/startupStatus/updated', { threadId: THREAD, name: 'darkmechanicus', status: 'failed', error: 'spawn node ENOENT' })
        ])
      ]
    ])
    await start(target)

    await target.adapter.send('go')

    expect(target.transcript()).toEqual([
      { id: 'mcp_n1', at: AT, kind: 'error', message: 'The Dark Mechanicus server could not start: spawn node ENOENT', code: 'mcp_startup_failed' }
    ])
  })
})

// ---- c2: approvals ----

describe('approval decisions', () => {
  it.each(MAPPING)('answers a command approval %s with %s', async (decision, expected) => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          step.ask(111, 'item/commandExecution/requestApproval', { ...at, itemId: 'c1', command: 'ls', cwd: REPO }),
          step.expectResponse(111, { decision: expected })
        ])
      ]
    ])
    target.answers.push(decision)
    await start(target)

    await target.adapter.send('go')

    expect(target.transcript()[0]).toMatchObject({ kind: 'approval_request', category: 'command', tool: 'shell' })
    expect(transport(target).remaining()).toEqual([])
  })

  it.each(MAPPING)('answers a file change approval %s with %s', async (decision, expected) => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          step.ask('req-12', 'item/fileChange/requestApproval', { ...at, itemId: 'p1' }),
          step.expectResponse('req-12', { decision: expected })
        ])
      ]
    ])
    target.answers.push(decision)
    await start(target)

    await target.adapter.send('go')

    expect(target.transcript()[0]).toMatchObject({ kind: 'approval_request', category: 'file_edit', tool: 'apply_patch' })
    expect(transport(target).remaining()).toEqual([])
  })
})

describe('a held approval', () => {
  it('holds the server until the person answers', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          step.ask(113, 'item/commandExecution/requestApproval', { ...at, itemId: 'c1', command: 'ls', cwd: REPO }),
          step.expectResponse(113, { decision: 'accept' })
        ])
      ]
    ])
    target.hold = true
    await start(target)
    const sending = target.adapter.send('go')
    await settle()

    expect(written(target).some((message) => message.id === 113)).toBe(false)
    target.held[0]?.('allow_once')
    await sending

    expect(written(target).at(-1)).toEqual({ id: 113, result: { decision: 'accept' } })
  })
})

describe('approvals beyond commands and edits', () => {
  it('asks the person about an MCP tool approval and an extra permission request as other requests', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          step.ask(114, 'mcpServer/elicitation/request', { threadId: THREAD, turnId: TURN, serverName: 'darkmechanicus', mode: 'form', message: 'Allow the darkmechanicus MCP server to run "add_comment"?', _meta: null, requestedSchema: { type: 'object', properties: {} } }),
          step.expectResponse(114, { action: 'accept', content: null, _meta: { persist: 'session' } }),
          step.ask(115, 'mcpServer/elicitation/request', { threadId: THREAD, turnId: TURN, serverName: 'darkmechanicus', mode: 'form', message: 'Allow?', _meta: null, requestedSchema: { type: 'object', properties: {} } }),
          step.expectResponse(115, { action: 'decline', content: null, _meta: null }),
          step.ask(116, 'item/permissions/requestApproval', { ...at, itemId: 'perm', environmentId: null, cwd: REPO, reason: 'Needs the network', permissions: { network: { enabled: true }, fileSystem: null } }),
          step.expectResponse(116, { permissions: { network: { enabled: true } }, scope: 'turn' }),
          step.ask(117, 'item/permissions/requestApproval', { ...at, itemId: 'perm2', environmentId: null, cwd: REPO, reason: null, permissions: { network: null, fileSystem: { read: ['/x'], write: null } } }),
          step.expectResponse(117, { permissions: {}, scope: 'turn' })
        ])
      ]
    ])
    target.answers.push('allow_chat', 'deny', 'allow_once', 'deny')
    await start(target)

    await target.adapter.send('go')

    expect(target.transcript()).toMatchObject([
      { kind: 'approval_request', category: 'other', tool: 'mcp:darkmechanicus', summary: 'Allow the darkmechanicus MCP server to run "add_comment"?' },
      { kind: 'approval_request', category: 'other', tool: 'mcp:darkmechanicus' },
      { kind: 'approval_request', category: 'other', tool: 'permissions', summary: 'Needs the network' },
      { kind: 'approval_request', category: 'other', tool: 'permissions', summary: 'Extra permissions' }
    ])
    expect(transport(target).remaining()).toEqual([])
  })

  it('grants a permission request for the session when the person allows it for the chat', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          step.ask(118, 'item/permissions/requestApproval', { ...at, itemId: 'perm', environmentId: null, cwd: REPO, reason: null, permissions: { network: { enabled: true }, fileSystem: null } }),
          step.expectResponse(118, { permissions: { network: { enabled: true } }, scope: 'session' })
        ])
      ]
    ])
    target.answers.push('allow_chat')
    await start(target)

    await target.adapter.send('go')

    expect(transport(target).remaining()).toEqual([])
  })
})

describe('requests Dark Mechanicus cannot show', () => {
  it('answers what it cannot show: a question for the person gets no answers, anything else is refused', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          step.ask(119, 'item/tool/requestUserInput', { ...at, itemId: 'q', questions: [], isBlocking: true, autoResolutionMs: null }),
          step.expectResponse(119, { answers: {} }),
          step.ask(120, 'item/tool/call', { ...at, callId: 'x', tool: 'thing', arguments: {} }),
          step.expectError(120, -32601, 'Dark Mechanicus does not handle the Codex request item/tool/call.')
        ])
      ]
    ])
    await start(target)

    await target.adapter.send('go')

    expect(transport(target).remaining()).toEqual([])
  })
})

// ---- Approval policy and sandbox, and how the Dark Mechanicus server is passed ----

describe('the thread Dark Mechanicus starts', () => {
  it('asks for every edit and command, sandboxes writes to the folder and passes the server for this thread only (c4)', async () => {
    const target = rig([NEW_THREAD])

    await start(target)

    expect(written(target)[1]).toEqual({ method: 'initialized' })
    expect(written(target)[2]).toEqual({
      id: expect.any(Number) as number,
      method: 'thread/start',
      params: {
        cwd: REPO,
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        config: {
          'mcp_servers.darkmechanicus': {
            command: 'node',
            args: ['/app/out/main/mcp.js', '--role', 'planner', '--allow-save', '--label', 'Codex · Plan'],
            env: { DM_HOME: '/state' }
          }
        }
      }
    })
    expect(target.connects).toEqual([{ executablePath: '/bin/codex', folder: REPO }])
  })

  it('leaves the model out until the chat has one, and omits an empty server environment', async () => {
    const target = rig([NEW_THREAD])

    await start(target, options({ darkMechanicus: { command: 'dm', args: [] } }))

    const params = written(target)[2]?.params as Record<string, unknown>
    expect(params).not.toHaveProperty('model')
    expect(params.config).toEqual({ 'mcp_servers.darkmechanicus': { command: 'dm', args: [] } })
  })

  it("reports a new thread's id as the vendor session once its first turn starts, not before", async () => {
    const target = rig([[...NEW_THREAD, ...turn([]), ...turn([])]])

    await start(target)
    expect(target.events).toEqual([])
    await target.adapter.send('first')
    await target.adapter.send('second')

    expect(target.events).toEqual([{ type: 'session', sessionId: THREAD }])
  })
})

describe('a chat that fails to start', () => {
  it('stops the process and fails when the handshake fails', async () => {
    const target = rig([[...INITIALIZE.slice(0, 1), step.fail(-32600, 'Not initialized')]])

    await expect(start(target)).rejects.toThrow('Not initialized')

    expect(transport(target).kills).toBe(1)
  })

  it('stops the process and fails when the thread cannot be started', async () => {
    const target = rig([[...INITIALIZE, step.expect('thread/start'), step.fail(-32603, 'Not signed in')]])

    await expect(start(target)).rejects.toThrow('Not signed in')

    expect(transport(target).kills).toBe(1)
  })

  it('fails when Codex answers a new thread without an id', async () => {
    const target = rig([[...INITIALIZE, step.expect('thread/start'), step.reply({ thread: {} })]])

    await expect(start(target)).rejects.toThrow('Codex did not return a thread id.')

    expect(transport(target).kills).toBe(1)
  })

  it('fails with the exit reason when the program dies while starting', async () => {
    const target = rig([[...INITIALIZE.slice(0, 1), step.exit('Codex exited with code 1: no auth')]])

    await expect(start(target)).rejects.toThrow('Codex exited with code 1: no auth')
  })

  it('fails when the program cannot be launched', async () => {
    const target = rig([], { deps: { connect: () => { throw new Error('That is not a file.') } } })

    await expect(start(target)).rejects.toThrow('That is not a file.')
  })
})

// ---- c3: resume and context reset ----

describe('resuming a chat', () => {
  it('resumes the stored thread id with the same approval policy, sandbox and server (c3)', async () => {
    const target = rig([[...INITIALIZE, step.expect('thread/resume'), step.reply({ thread: { id: 'thr_old' } })]])

    await start(target, options({ sessionId: 'thr_old', model: 'gpt-5' }))

    expect(methods(target)).toEqual(['initialize', 'initialized', 'thread/resume'])
    expect(written(target)[2]).toEqual({
      id: expect.any(Number) as number,
      method: 'thread/resume',
      params: {
        threadId: 'thr_old',
        cwd: REPO,
        model: 'gpt-5',
        approvalPolicy: 'untrusted',
        sandbox: 'workspace-write',
        config: { 'mcp_servers.darkmechanicus': expect.objectContaining({ command: 'node' }) as unknown }
      }
    })
    expect(target.transcript()).toEqual([])
    expect(target.events).toEqual([])
  })
})

describe('a thread that cannot be resumed', () => {
  it('records a context reset and starts a new thread when the stored one cannot be resumed (c3)', async () => {
    const target = rig([
      [
        ...INITIALIZE,
        step.expect('thread/resume', { threadId: 'thr_lost' }),
        step.fail(-32600, 'no rollout found for thread id thr_lost'),
        step.expect('thread/start'),
        step.reply(THREAD_RESULT),
        ...turn([])
      ]
    ])

    await start(target, options({ sessionId: 'thr_lost' }))
    await target.adapter.send('hello')

    expect(target.events).toEqual([
      {
        type: 'item',
        item: {
          id: 'reset_n1',
          at: AT,
          kind: 'context_reset',
          reason: 'session_lost',
          message: 'Codex could not resume the earlier conversation (no rollout found for thread id thr_lost), so this chat continues in a new one.'
        }
      },
      { type: 'session', sessionId: THREAD }
    ])
    expect(transport(target).remaining()).toEqual([])
  })

  it('does not hide a failure to start the replacement thread', async () => {
    const target = rig([
      [...INITIALIZE, step.expect('thread/resume'), step.fail(-32600, 'gone'), step.expect('thread/start'), step.fail(-32603, 'Not signed in')]
    ])

    await expect(start(target, options({ sessionId: 'thr_lost' }))).rejects.toThrow('Not signed in')
  })

  it('does not mistake the process dying for a lost thread', async () => {
    const target = rig([[...INITIALIZE, step.expect('thread/resume'), step.exit('Codex exited with code 1')]])

    await expect(start(target, options({ sessionId: 'thr_old' }))).rejects.toThrow('Codex exited with code 1')

    expect(target.transcript()).toEqual([])
  })
})

describe('a process that died between turns', () => {
  it('starts another process and resumes the thread when the first one died between turns', async () => {
    const target = rig([
      [...NEW_THREAD, step.expect('turn/start'), step.reply({ turn: TURN_OBJECT('inProgress') }), step.exit('Codex exited with code 1: crashed')],
      [...INITIALIZE, step.expect('thread/resume', { threadId: THREAD }), step.reply(THREAD_RESULT), ...turn([completed({ type: 'agentMessage', id: 'm1', text: 'back' })])]
    ])
    await start(target)

    await expect(target.adapter.send('first')).rejects.toThrow('Codex exited with code 1: crashed')
    await target.adapter.send('second')

    expect(target.connects).toHaveLength(2)
    expect(target.transcript()).toEqual([assistantText(`${TURN}:m1`, 'back')])
    expect(target.events.filter((event) => event.type === 'session')).toHaveLength(1)
  })
})

// ---- c4: models ----

describe('models', () => {
  it('feeds the model picker from model/list, page by page, without hidden models (c4)', async () => {
    const target = rig([[...NEW_THREAD, ...PAGE_ONE, ...PAGE_TWO]])
    await start(target)

    const models = await target.adapter.listModels()

    expect(models).toEqual([
      { id: 'gpt-5-codex', label: 'GPT-5 Codex' },
      { id: 'gpt-5', label: 'GPT-5' },
      { id: 'bare', label: 'bare' }
    ])
  })
})

describe('listing models without a chat', () => {
  it('lists models without a chat through a short-lived process that it stops (c4)', async () => {
    const target = rig([[...INITIALIZE, ...PAGE_ONE, ...PAGE_TWO]])
    const definition = codexAdapterDefinition({ connect: (executablePath, folder) => {
      target.connects.push({ executablePath, folder })
      return transport(target)
    }, newId: () => 'n', now: () => AT, clientVersion: '9.9.9' })

    const models = await definition.listModels('/bin/codex')

    expect(models.map((model) => model.id)).toEqual(['gpt-5-codex', 'gpt-5', 'bare'])
    expect(target.connects[0]?.executablePath).toBe('/bin/codex')
    expect(transport(target).kills).toBe(1)
  })

  it('lists models for an adapter that has not started, the same way', async () => {
    const target = rig([[...INITIALIZE, ...PAGE_ONE, ...PAGE_TWO]])

    const models = await target.adapter.listModels()

    expect(models).toHaveLength(3)
    expect(transport(target).kills).toBe(1)
  })

  it('stops the short-lived process when listing fails', async () => {
    const target = rig([[...INITIALIZE, step.expect('model/list'), step.fail(-32603, 'offline')]])

    await expect(target.adapter.listModels()).rejects.toThrow('offline')

    expect(transport(target).kills).toBe(1)
  })
})

describe('a model change', () => {
  it('applies a model change on the next turn/start and writes nothing for the change itself (c4)', async () => {
    const target = rig([[...NEW_THREAD, ...turn([]), ...turn([]), ...turn([])]])
    await start(target)

    await target.adapter.send('first')
    const before = written(target).length
    await target.adapter.setModel('gpt-5')
    expect(written(target)).toHaveLength(before)
    await target.adapter.send('second')
    await target.adapter.send('third')

    const starts = written(target).filter((message) => message.method === 'turn/start')
    expect(starts.map((message) => (message.params as Record<string, unknown>).model)).toEqual([undefined, 'gpt-5', 'gpt-5'])
    expect(transport(target).remaining()).toEqual([])
  })
})

describe("the user's Codex config", () => {
  let home = ''
  let previous: string | undefined

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.CODEX_HOME
    } else {
      process.env.CODEX_HOME = previous
    }
    rmSync(home, { recursive: true, force: true })
  })

  it('is never written, whatever the chat does (c4)', async () => {
    home = mkdtempSync(join(tmpdir(), 'dm-codex-home-'))
    const config = join(home, 'config.toml')
    writeFileSync(config, 'model = "gpt-5"\n[mcp_servers.mine]\ncommand = "mine"\n')
    const content = readFileSync(config, 'utf8')
    const modified = statSync(config).mtimeMs
    previous = process.env.CODEX_HOME
    process.env.CODEX_HOME = home
    const target = rig([[...NEW_THREAD, ...turn([completed({ type: 'agentMessage', id: 'm1', text: 'ok' })]), step.expect('turn/start'), step.reply({ turn: TURN_OBJECT('inProgress') })]])
    await start(target)

    await target.adapter.send('hello')
    await target.adapter.setModel('gpt-5')
    const interrupted = target.adapter.send('again')
    await settle()
    await target.adapter.dispose()
    await interrupted

    expect(readFileSync(config, 'utf8')).toBe(content)
    expect(statSync(config).mtimeMs).toBe(modified)
    expect(readdirSync(home)).toEqual(['config.toml'])
    const sent = methods(target).filter((method): method is string => typeof method === 'string')
    expect(sent.filter((method) => method.startsWith('config/'))).toEqual([])
    expect(process.env.CODEX_HOME).toBe(home)
  })

  it('is out of reach of the adapter code: no file system access and no mention of the config file', () => {
    for (const file of ['codex.ts', 'codexItems.ts', 'codexApprovals.ts', 'codexRpc.ts']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')

      expect(source, file).not.toMatch(/node:fs|from 'fs'|config\.toml|\.codex\b/)
    }
  })
})

// ---- Stop, failures and dispose ----

describe('stopping and ending', () => {
  it('interrupts the running turn so the pending send settles, and keeps the session usable', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([], [step.expect('turn/interrupt', { threadId: THREAD, turnId: TURN }), step.reply({}), INTERRUPTED]),
        ...turn([completed({ type: 'agentMessage', id: 'm1', text: 'still here' })])
      ]
    ])
    await start(target)

    const sending = target.adapter.send('a long task')
    await settle()
    await target.adapter.stop()
    await sending
    await target.adapter.send('next')

    expect(target.transcript()).toEqual([assistantText(`${TURN}:m1`, 'still here')])
    expect(transport(target).remaining()).toEqual([])
  })

  it('waits for the turn id before interrupting a turn that has only just been sent', async () => {
    const target = rig([[...NEW_THREAD, step.expect('turn/start'), step.expect('turn/interrupt', { threadId: THREAD, turnId: TURN }), step.reply({}), INTERRUPTED]])
    await start(target)

    const sending = target.adapter.send('quick')
    const stopping = target.adapter.stop()
    await settle()
    transport(target).say(step.reply({ turn: TURN_OBJECT('inProgress') }))
    await stopping
    await sending

    expect(methods(target).at(-1)).toBe('turn/interrupt')
  })
})

describe('stopping a turn that does not end', () => {
  it('does not wait forever for a turn that never reports it ended after the interrupt', async () => {
    const target = rig([[...NEW_THREAD, ...turn([], [step.expect('turn/interrupt'), step.reply({})])]], { deps: { interruptGraceMs: 20 } })
    await start(target)

    const sending = target.adapter.send('stuck')
    await settle()
    await target.adapter.stop()

    await expect(sending).resolves.toBeUndefined()
  })

  it('does nothing when there is no turn to stop', async () => {
    const target = rig([NEW_THREAD])
    await start(target)

    await target.adapter.stop()

    expect(methods(target)).toEqual(['initialize', 'initialized', 'thread/start'])
  })
})

describe('a turn that fails', () => {
  it('fails the send with what the turn reported when it failed', async () => {
    const failed = step.notify('turn/completed', {
      threadId: THREAD,
      turn: TURN_OBJECT('failed', { error: { message: 'You hit your usage limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } })
    })
    const target = rig([[...NEW_THREAD, ...turn([], [failed])]])
    await start(target)

    await expect(target.adapter.send('go')).rejects.toThrow('You hit your usage limit')
  })

  it('fails the send with a general message when a failed turn says nothing', async () => {
    const target = rig([[...NEW_THREAD, ...turn([], [step.notify('turn/completed', { threadId: THREAD, turn: TURN_OBJECT('failed') })])]])
    await start(target)

    await expect(target.adapter.send('go')).rejects.toThrow('The Codex turn failed.')
  })

  it('fails the send when turn/start is refused', async () => {
    const target = rig([[...NEW_THREAD, step.expect('turn/start'), step.fail(-32600, 'Invalid request: unknown model')]])
    await start(target)

    await expect(target.adapter.send('go')).rejects.toThrow('Invalid request: unknown model')
    await settle()
  })

  it('fails the send when the program dies during the turn, with why', async () => {
    const target = rig([[...NEW_THREAD, ...turn([], [step.exit('Codex exited with code 137')])]])
    await start(target)

    await expect(target.adapter.send('go')).rejects.toThrow('Codex exited with code 137')
  })

  it('refuses to send before it started', async () => {
    const target = rig([])

    await expect(target.adapter.send('go')).rejects.toThrow('The Codex chat has not started.')
  })
})

describe('what the server sends that is not for the turn', () => {
  it('ignores lines that are not JSON and notifications for other threads or turns', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          step.noise('codex: warming up'),
          step.notify('item/completed', { threadId: 'other', turnId: TURN, item: { type: 'agentMessage', id: 'x', text: 'not mine' } }),
          step.notify('turn/completed', { threadId: 'other', turn: TURN_OBJECT('completed') })
        ])
      ]
    ])
    await start(target)

    await target.adapter.send('go')

    expect(target.transcript()).toEqual([])
  })
})

describe('ending the chat', () => {
  it('kills the process tree on dispose, settles a running turn and emits nothing afterwards', async () => {
    const target = rig([[...NEW_THREAD, step.expect('turn/start'), step.reply({ turn: TURN_OBJECT('inProgress') })]])
    await start(target)
    const sending = target.adapter.send('long')
    await settle()
    const seen = target.events.length

    await target.adapter.dispose()
    await target.adapter.dispose()
    await sending
    transport(target).say(step.notify('item/completed', { ...at, item: { type: 'agentMessage', id: 'late', text: 'too late' } }))
    await settle()

    expect(transport(target).kills).toBe(1)
    expect(target.events).toHaveLength(seen)
  })

  it('refuses to send once it was disposed', async () => {
    const target = rig([NEW_THREAD])
    await start(target)
    await target.adapter.dispose()

    await expect(target.adapter.send('go')).rejects.toThrow('The Codex chat has ended.')
  })
})

describe('ending the chat with an approval waiting', () => {
  it('still answers a held approval with decline when the manager denies it just before disposing', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          step.ask(130, 'item/commandExecution/requestApproval', { ...at, itemId: 'c1', command: 'ls', cwd: REPO }),
          step.expectResponse(130, { decision: 'decline' })
        ])
      ]
    ])
    target.hold = true
    await start(target)
    const sending = target.adapter.send('go')
    await settle()

    target.held[0]?.('deny')
    await settle()
    await target.adapter.dispose()
    await sending

    expect(written(target).at(-1)).toEqual({ id: 130, result: { decision: 'decline' } })
  })
})

describe('tool call details', () => {
  it('fills in what Codex leaves out and clips what is long', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          completed(command('c1', 'sleep 1', { status: 'completed' })),
          completed(command('c2', 'boom', { status: 'failed' })),
          completed({ type: 'mcpToolCall', id: 'k1', server: 'darkmechanicus', tool: 'save_plan', status: 'completed', arguments: { plan: 'x'.repeat(500), n: 1 }, result: { content: [{ type: 'image' }] }, error: null }),
          completed({ type: 'mcpToolCall', id: 'k2', server: 'darkmechanicus', tool: 'noop', status: 'failed', arguments: 5, result: null, error: null }),
          completed({ type: 'dynamicToolCall', id: 'd1', tool: 'lookup', arguments: { q: 1 }, status: 'completed' })
        ])
      ]
    ])
    await start(target)

    await target.adapter.send('go')

    const calls = target.transcript()
    expect(calls).toMatchObject([
      { resultSummary: 'Finished' },
      { resultSummary: 'Failed' },
      { name: 'darkmechanicus.save_plan', input: { n: 1 }, resultSummary: 'Completed' },
      { name: 'darkmechanicus.noop', input: { value: '5' }, resultSummary: 'Failed' },
      { name: 'lookup', input: { q: 1 }, status: 'completed', resultSummary: 'Completed' }
    ])
    expect(JSON.stringify(calls[2])).not.toContain('x'.repeat(400))
  })
})

describe('answers Codex gets wrong', () => {
  it('fails the send when turn/start does not say which turn it started', async () => {
    const target = rig([[...NEW_THREAD, step.expect('turn/start'), step.reply({})]])
    await start(target)

    await expect(target.adapter.send('go')).rejects.toThrow('Codex did not say which turn it started.')
  })
})

describe('a refused interrupt', () => {
  it('fails the stop when the turn is still running', async () => {
    const target = rig([[...NEW_THREAD, ...turn([], [step.expect('turn/interrupt'), step.fail(-32600, 'no active turn')])]])
    await start(target)
    const sending = target.adapter.send('long')
    await settle()

    await expect(target.adapter.stop()).rejects.toThrow('no active turn')

    await target.adapter.dispose()
    await sending
  })

  it('is no failure when the turn had ended by then', async () => {
    const turnEnded = step.notify('turn/completed', { threadId: THREAD, turn: TURN_OBJECT('completed') })
    const target = rig([[...NEW_THREAD, ...turn([], [step.expect('turn/interrupt'), turnEnded, step.fail(-32600, 'no active turn')])]])
    await start(target)
    const sending = target.adapter.send('long')
    await settle()

    await expect(target.adapter.stop()).resolves.toBeUndefined()
    await sending
  })
})

describe('the adapter registry', () => {
  it('offers the Codex adapter, started when a chat opens, as a codex-kind adapter', () => {
    const definition = CHAT_ADAPTERS.codex

    expect(definition?.startOnOpen).toBe(true)
    expect(definition?.create('/bin/codex').kind).toBe('codex')
  })
})

// ---- What the server leaves out ----

const UNVERSIONED_START: Step[] = [
  step.expect('initialize', { clientInfo: { name: 'dark-mechanicus', title: 'Dark Mechanicus', version: 'unknown' }, capabilities: null }),
  step.reply({}),
  step.expect('initialized'),
  step.expect('thread/start'),
  step.reply(THREAD_RESULT)
]

describe('a handshake without a client version', () => {
  it('names the client version unknown', async () => {
    const target = rig([UNVERSIONED_START], { deps: { clientVersion: undefined } })

    await start(target)

    expect(written(target)[0]).toMatchObject({ method: 'initialize', params: { clientInfo: { version: 'unknown' } } })
    expect(transport(target).remaining()).toEqual([])
  })
})

describe('a model catalog with gaps', () => {
  it('names a model by its id when it has no model field, and skips entries that are not models', async () => {
    const entries: Json[] = [{ id: 'by-id' }, null, 'junk', { displayName: 'No id' }, { model: 'with-model', id: 'ignored', displayName: 'Named' }]
    const target = rig([[...NEW_THREAD, step.expect('model/list'), step.reply({ data: entries })]])
    await start(target)

    const models = await target.adapter.listModels()

    expect(models).toEqual([
      { id: 'by-id', label: 'by-id' },
      { id: 'with-model', label: 'Named' }
    ])
  })

  it('lists no models when the answer has no data list', async () => {
    const target = rig([[...NEW_THREAD, step.expect('model/list'), step.reply({})]])
    await start(target)

    await expect(target.adapter.listModels()).resolves.toEqual([])
  })
})

describe('sending and stopping at awkward moments', () => {
  it('refuses a second message while the first is still being answered', async () => {
    const target = rig([[...NEW_THREAD, step.expect('turn/start'), step.reply({ turn: TURN_OBJECT('inProgress') })]])
    await start(target)
    const first = target.adapter.send('one')
    await settle()

    await expect(target.adapter.send('two')).rejects.toThrow('The Codex chat is still answering.')

    await target.adapter.dispose()
    await first
    expect(methods(target).filter((method) => method === 'turn/start')).toHaveLength(1)
  })

  it('sends no interrupt for a turn that never started', async () => {
    const target = rig([[...NEW_THREAD, step.expect('turn/start'), step.fail(-32600, 'unknown model')]])
    await start(target)

    const sending = target.adapter.send('go')
    const refused = expect(sending).rejects.toThrow('unknown model')
    await target.adapter.stop()
    await refused

    expect(methods(target)).not.toContain('turn/interrupt')
  })

  it('ends the turn when Codex reports the end after an accepted interrupt, within the default wait', async () => {
    const interrupt = [step.expect('turn/interrupt', { threadId: THREAD, turnId: TURN }), step.reply({})]
    const target = rig([[...NEW_THREAD, ...turn([], interrupt)]])
    await start(target)
    const sending = target.adapter.send('long')
    await settle()

    await target.adapter.stop()
    transport(target).say(INTERRUPTED)

    await expect(sending).resolves.toBeUndefined()
    expect(transport(target).remaining()).toEqual([])
  })
})

describe('notifications with gaps', () => {
  it('ignores notifications whose params are not an object', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          step.notify('item/completed', 'oops'),
          step.notify('item/started', [1, 2]),
          step.notify('item/agentMessage/delta', null),
          completed({ type: 'agentMessage', id: 'm1', text: 'fine' })
        ])
      ]
    ])
    await start(target)

    await target.adapter.send('go')

    expect(target.transcript()).toEqual([assistantText(`${TURN}:m1`, 'fine')])
    expect(target.events.filter((event) => event.type === 'assistant_delta')).toEqual([])
  })

  it('files an item without a turn id under the running turn, and one outside any turn under turn', async () => {
    const target = rig([[...NEW_THREAD, step.expect('turn/start'), step.reply({ turn: TURN_OBJECT('inProgress') })]])
    await start(target)
    const sending = target.adapter.send('go')
    await settle()

    transport(target).say(
      step.notify('item/completed', { threadId: THREAD, item: { type: 'agentMessage', id: 'm1', text: 'during' } }),
      step.notify('item/agentMessage/delta', { threadId: THREAD, itemId: 'm1', delta: 'dur' }),
      step.notify('turn/completed', { threadId: THREAD, turn: TURN_OBJECT('completed') })
    )
    await sending
    transport(target).say(step.notify('item/completed', { threadId: THREAD, item: { type: 'agentMessage', id: 'm2', text: 'after' } }))
    await settle()

    expect(target.transcript()).toEqual([assistantText(`${TURN}:m1`, 'during'), assistantText('turn:m2', 'after')])
    expect(target.events).toContainEqual({ type: 'assistant_delta', itemId: `${TURN}:m1`, delta: 'dur' })
  })
})

describe('deltas and notices that are not complete', () => {
  it('passes on only the deltas of this thread that name an item and carry text', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          step.notify('item/agentMessage/delta', { threadId: 'other', turnId: TURN, itemId: 'm1', delta: 'x' }),
          step.notify('item/agentMessage/delta', { ...at, itemId: 'm1' }),
          step.notify('item/agentMessage/delta', { ...at, delta: 'orphan' }),
          step.notify('item/agentMessage/delta', { ...at, itemId: 'm1', delta: 'kept' })
        ])
      ]
    ])
    await start(target)

    await target.adapter.send('go')

    expect(target.events.filter((event) => event.type === 'assistant_delta')).toEqual([{ type: 'assistant_delta', itemId: `${TURN}:m1`, delta: 'kept' }])
  })

  it('says no reason was given when the Dark Mechanicus server fails to start without one', async () => {
    const failed = step.notify('mcpServer/startupStatus/updated', { threadId: THREAD, name: 'darkmechanicus', status: 'failed', error: null })
    const target = rig([[...NEW_THREAD, ...turn([failed])]])
    await start(target)

    await target.adapter.send('go')

    expect(target.transcript()).toEqual([
      { id: 'mcp_n1', at: AT, kind: 'error', message: 'The Dark Mechanicus server could not start: no reason given', code: 'mcp_startup_failed' }
    ])
  })
})

describe('approval requests with details missing', () => {
  it('asks about a file edit that names no item, a tool that names no server and a command that names no command', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          step.ask(140, 'item/fileChange/requestApproval', { ...at, reason: null, grantRoot: null }),
          step.expectResponse(140, { decision: 'accept' }),
          step.ask(141, 'mcpServer/elicitation/request', { threadId: THREAD, turnId: TURN, mode: 'form' }),
          step.expectResponse(141, { action: 'accept', content: null, _meta: null }),
          step.ask(142, 'item/commandExecution/requestApproval', null),
          step.expectResponse(142, { decision: 'decline' })
        ])
      ]
    ])
    target.answers.push('allow_once', 'allow_once', 'deny')
    await start(target)

    await target.adapter.send('go')

    expect(target.transcript()).toMatchObject([
      { kind: 'approval_request', category: 'file_edit', tool: 'apply_patch', summary: 'Edit files', input: {} },
      { kind: 'approval_request', category: 'other', tool: 'mcp:mcp', summary: 'Use a tool of the mcp server', input: { server: 'mcp' } },
      { kind: 'approval_request', category: 'command', tool: 'shell', summary: 'Run a command', input: {} }
    ])
    expect(transport(target).remaining()).toEqual([])
  })

  it('grants nothing for a permission request that lists no permissions', async () => {
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          step.ask(143, 'item/permissions/requestApproval', { ...at, itemId: 'perm', reason: null }),
          step.expectResponse(143, { permissions: {}, scope: 'turn' })
        ])
      ]
    ])
    target.answers.push('allow_once')
    await start(target)

    await target.adapter.send('go')

    expect(transport(target).remaining()).toEqual([])
  })
})

describe('a file edit that touches many files', () => {
  it('lists the first three files in its summary and all of them in its input', async () => {
    const changes = ['a.ts', 'b.ts', 'c.ts', 'd.ts'].map((path) => ({ path, kind: { type: 'update' }, diff: '' }))
    const target = rig([
      [
        ...NEW_THREAD,
        ...turn([
          started({ type: 'fileChange', id: 'p10', status: 'inProgress', changes }),
          step.ask(144, 'item/fileChange/requestApproval', { ...at, itemId: 'p10', reason: null, grantRoot: null }),
          step.expectResponse(144, { decision: 'decline' })
        ])
      ]
    ])
    await start(target)

    await target.adapter.send('edit four files')

    expect(target.transcript().find((item) => item.kind === 'approval_request')).toMatchObject({
      summary: 'Edit 4 files (a.ts, b.ts, c.ts, …)',
      input: { files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }
    })
  })
})
