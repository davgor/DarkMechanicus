import { resolve } from 'node:path'
import type { CanUseTool, ModelInfo, Options, PermissionResult, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApprovalDecision, ApprovalRequestItem, ChatAdapterEvent, ChatItem, ModelOption } from '../../../shared/agents/chat'
import { REPO, memoryChatStore } from '../__mocks__/fakeChatAdapter'
import {
  CURATED_CLAUDE_MODELS,
  claudeAdapterDefinition,
  createClaudeAdapter,
  createClaudeAdapterDefinition,
  type ClaudeQueryFactory
} from './claude'
import { AGENT_B, CLAUDE_SUBAGENTS, SPAWN_A, SPAWN_B, WRITE_CALL, type RecordedStep } from './__mocks__/claudeSubagents'
import {
  EXECUTABLE,
  FOLDER,
  FakeQuery,
  NOW,
  OTHER_SESSION,
  SESSION,
  START,
  type Plan,
  type Rig,
  assistant,
  failure,
  fakeProcesses,
  fakeSdk,
  init,
  message,
  messageStart,
  pendingApproval,
  replay,
  startRig,
  streamEvent,
  success,
  text,
  textDelta,
  toolResult,
  toolUse,
  uuid
} from './__mocks__/fakeClaudeSdk'

const sdkMock = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: sdkMock.query }))

const recorded: SDKMessage[] = [
  init(),
  messageStart('msg_1'),
  textDelta(0, 'Let me '),
  textDelta(0, 'look.'),
  assistant('msg_1', [text('Let me look.')]),
  assistant('msg_1', [toolUse('toolu_1', 'Read', { file_path: resolve(FOLDER, 'README.md') })]),
  toolResult('toolu_1', [{ type: 'text', text: '# Readme\nHello' }]),
  messageStart('msg_2'),
  textDelta(0, 'It says hello.'),
  assistant('msg_2', [text('It says hello.')]),
  success('It says hello.')
]

const INFOS: ModelInfo[] = [
  { value: 'default', displayName: 'Default (recommended)', description: 'Sonnet' },
  { value: 'opus', displayName: 'Opus', description: 'Most capable' },
  { value: 'haiku', displayName: 'Haiku', description: 'Fastest' }
]
const EXPECTED: ModelOption[] = [
  { id: 'default', label: 'Default (recommended)' },
  { id: 'opus', label: 'Opus' },
  { id: 'haiku', label: 'Haiku' }
]

const useSdkMock = (...messages: SDKMessage[]): void => {
  sdkMock.query.mockImplementation(
    ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => new FakeQuery(options, replay(...messages), prompt, [])
  )
}


afterEach(() => {
  vi.useRealTimers()
  sdkMock.query.mockReset()
})

// ---- c1: transcript replay ----

describe('Claude adapter: replaying a recorded session (1)', () => {
  it('turns assistant text, a tool call and its result into the expected items', async () => {
    const rig = await startRig({ plans: [replay(...recorded)] })

    await rig.adapter.send('What does the readme say?')

    expect(rig.events).toEqual([
      { type: 'session', sessionId: SESSION },
      { type: 'assistant_delta', itemId: 'claude_msg_1_0', delta: 'Let me ' },
      { type: 'assistant_delta', itemId: 'claude_msg_1_0', delta: 'look.' },
      { type: 'item', item: { id: 'claude_msg_1_0', at: NOW, kind: 'assistant_text', text: 'Let me look.' } },
      {
        type: 'item',
        item: {
          id: 'claude_tool_toolu_1',
          at: NOW,
          kind: 'tool_call',
          name: 'Read',
          input: { file_path: resolve(FOLDER, 'README.md') },
          status: 'running',
          resultSummary: null
        }
      },
      {
        type: 'item',
        item: {
          id: 'claude_tool_toolu_1',
          at: NOW,
          kind: 'tool_call',
          name: 'Read',
          input: { file_path: resolve(FOLDER, 'README.md') },
          status: 'completed',
          resultSummary: '# Readme\nHello'
        }
      },
      { type: 'assistant_delta', itemId: 'claude_msg_2_0', delta: 'It says hello.' },
      { type: 'item', item: { id: 'claude_msg_2_0', at: NOW, kind: 'assistant_text', text: 'It says hello.' } }
    ])
  })
})

describe('Claude adapter: replaying a recorded session (2)', () => {
  it('numbers the text blocks of one API message so a delta stream and its final text share an id', async () => {
    const rig = await startRig({
      plans: [
        replay(
          init(),
          messageStart('msg_9'),
          streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }),
          textDelta(1, 'Answer'),
          assistant('msg_9', [{ type: 'thinking', thinking: 'hmm', signature: 'x' }]),
          assistant('msg_9', [text('Answer')]),
          success('Answer')
        )
      ]
    })

    await rig.adapter.send('hi')

    expect(rig.events.filter((event) => event.type === 'assistant_delta')).toEqual([{ type: 'assistant_delta', itemId: 'claude_msg_9_1', delta: 'Answer' }])
    expect(rig.items()).toEqual([{ id: 'claude_msg_9_1', at: NOW, kind: 'assistant_text', text: 'Answer' }])
  })

  it('maps every block of an assistant message that carries several', async () => {
    const rig = await startRig({
      plans: [replay(init(), assistant('msg_3', [text('One'), toolUse('toolu_a', 'Bash', { command: 'ls' }), text('Two')]), success('Two'))]
    })

    await rig.adapter.send('go')

    expect(rig.items().map((item) => [item.id, item.kind])).toEqual([
      ['claude_msg_3_0', 'assistant_text'],
      ['claude_tool_toolu_a', 'tool_call'],
      ['claude_msg_3_2', 'assistant_text']
    ])
  })

  it('marks a failed tool result and keeps what the tool printed', async () => {
    const rig = await startRig({
      plans: [replay(init(), assistant('msg_4', [toolUse('toolu_b', 'Bash', { command: 'false' })]), toolResult('toolu_b', 'exit code 1', true), success('done'))]
    })

    await rig.adapter.send('run it')

    expect(rig.items().at(-1)).toMatchObject({ kind: 'tool_call', id: 'claude_tool_toolu_b', status: 'failed', resultSummary: 'exit code 1' })
  })
})

describe('Claude adapter: replaying a recorded session (3)', () => {
  it('shortens long tool input and results to what is worth showing', async () => {
    const long = 'x'.repeat(5000)
    const rig = await startRig({
      plans: [replay(init(), assistant('msg_5', [toolUse('toolu_c', 'Write', { file_path: 'a.txt', content: long })]), toolResult('toolu_c', long), success('ok'))]
    })

    await rig.adapter.send('write')

    const [running, completed] = rig.items() as Extract<ChatItem, { kind: 'tool_call' }>[]
    const written = running?.input.content as string
    expect(written.length).toBeLessThan(1100)
    expect(written).toMatch(/^x+…$/)
    expect(completed?.resultSummary?.length).toBeLessThan(600)
  })

  it('ignores thinking, empty text, results of unknown calls and unknown messages', async () => {
    const rig = await startRig({
      plans: [
        replay(
          init(),
          assistant('msg_6', [{ type: 'thinking', thinking: 'secret', signature: 's' }, text('')]),
          toolResult('toolu_unknown', 'no such call'),
          streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          message({ type: 'system', subtype: 'status', status: 'requesting', session_id: SESSION, uuid: uuid() }),
          message({ type: 'user', session_id: SESSION, parent_tool_use_id: null, message: { role: 'user', content: 'echo' } }),
          success('done')
        )
      ]
    })

    await rig.adapter.send('hi')

    expect(rig.events).toEqual([{ type: 'session', sessionId: SESSION }])
  })
})

describe('Claude adapter: replaying a recorded session (4)', () => {
  it('keeps what tool results say as text and says nothing for results without any', async () => {
    const rig = await startRig({
      plans: [
        replay(
          init(),
          assistant('msg_8', [toolUse('toolu_i', 'Read', { file_path: 'a.png' }), toolUse('toolu_j', 'Bash', { command: 'true' })]),
          toolResult('toolu_i', [{ type: 'image', source: {} }, { type: 'text', text: 'caption' }]),
          toolResult('toolu_j', undefined),
          success('ok')
        )
      ]
    })

    await rig.adapter.send('go')

    expect(rig.items().filter((item) => item.kind === 'tool_call' && item.status !== 'running')).toEqual([
      expect.objectContaining({ id: 'claude_tool_toolu_i', status: 'completed', resultSummary: 'caption' }),
      expect.objectContaining({ id: 'claude_tool_toolu_j', status: 'completed', resultSummary: null })
    ])
  })

  it('ignores message types the transcript has no place for, and results that belong to no turn', async () => {
    const rig = await startRig({
      plans: [replay(init(), message({ type: 'tool_progress', tool_use_id: 'toolu_p' }), success('one'), success('a result nobody waits for'))]
    })

    await rig.adapter.send('hi')
    await vi.waitFor(() => expect(rig.sdk.launches[0]?.received).toHaveLength(1))

    expect(rig.events).toEqual([{ type: 'session', sessionId: SESSION }])
  })
})

describe('Claude adapter: replaying a recorded session (5)', () => {
  it('reports compaction and clearing as context resets', async () => {
    const rig = await startRig({
      plans: [
        replay(
          init(),
          message({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 9000 }, session_id: SESSION, uuid: uuid() }),
          message({ type: 'conversation_reset', new_conversation_id: OTHER_SESSION, trigger: 'clear', session_id: OTHER_SESSION, uuid: uuid() }),
          success('ok', { session_id: OTHER_SESSION })
        )
      ]
    })

    await rig.adapter.send('go')

    expect(rig.items()).toEqual([
      { id: expect.any(String), at: NOW, kind: 'context_reset', reason: 'compact', message: 'The conversation was compacted to free up room.' },
      { id: expect.any(String), at: NOW, kind: 'context_reset', reason: 'clear', message: 'The conversation was cleared.' }
    ])
    expect(rig.events.filter((event) => event.type === 'session')).toEqual([
      { type: 'session', sessionId: SESSION },
      { type: 'session', sessionId: OTHER_SESSION }
    ])
  })

  it('gives every context reset its own id', async () => {
    const compact = (): SDKMessage =>
      message({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 1 }, session_id: SESSION, uuid: uuid() })
    const rig = await startRig({ plans: [replay(init(), compact(), compact(), success('ok'))] })

    await rig.adapter.send('go')

    const ids = rig.items().map((item) => item.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('announces a session id once however many messages carry it', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit, index }) => emit(init(), success(`turn ${index}`)) }] })

    await rig.adapter.send('one')
    await rig.adapter.send('two')

    expect(rig.events.filter((event) => event.type === 'session')).toHaveLength(1)
  })
})

describe('Claude adapter: how turns end (1)', () => {
  it('rejects a turn whose result is an error, with the error text', async () => {
    const rig = await startRig({
      plans: [replay(init(), message({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key · Please run /login', session_id: SESSION, uuid: uuid() }))]
    })

    await expect(rig.adapter.send('hi')).rejects.toThrow('Invalid API key · Please run /login')
  })

  it('reports an API failure once, through the failed turn, not also as assistant text', async () => {
    // A rejected sign-in is the exception: it has an item of its own (see claudeAuth.test.ts).
    const rig = await startRig({
      plans: [
        replay(
          init(),
          assistant('msg_e', [text('API Error: 529 Overloaded')], { error: 'overloaded' }),
          message({ type: 'result', subtype: 'success', is_error: true, result: 'API Error: 529 Overloaded', session_id: SESSION, uuid: uuid() })
        )
      ]
    })

    await expect(rig.adapter.send('hi')).rejects.toThrow('Overloaded')

    expect(rig.items()).toEqual([])
  })

  it('gives an error result with no text a reason of its own', async () => {
    const rig = await startRig({ plans: [replay(init(), message({ type: 'result', subtype: 'success', is_error: true, result: '', session_id: SESSION, uuid: uuid() }))] })

    await expect(rig.adapter.send('hi')).rejects.toThrow('The turn failed.')
  })

  it('rejects an execution error with its messages, or its subtype when it has none', async () => {
    const one = await startRig({ plans: [replay(init(), failure('error_during_execution', ['disk full', 'giving up']))] })
    await expect(one.adapter.send('hi')).rejects.toThrow('disk full; giving up')

    const two = await startRig({ plans: [replay(init(), failure('error_max_turns', []))] })
    await expect(two.adapter.send('hi')).rejects.toThrow('error_max_turns')
  })

  it('lets the next turn run after a failed one', async () => {
    const rig = await startRig({
      plans: [{ script: ({ emit, index }) => emit(init(), index === 0 ? failure('error_during_execution', ['boom']) : success('fine')) }]
    })

    await expect(rig.adapter.send('one')).rejects.toThrow('boom')
    await expect(rig.adapter.send('two')).resolves.toBeUndefined()
    expect(rig.sdk.launches).toHaveLength(1)
  })

  it('refuses a message while the previous turn is still running', async () => {
    const rig = await startRig({ plans: [{ script: () => new Promise(() => {}) }] })
    void rig.adapter.send('one')
    await vi.waitFor(() => expect(rig.sdk.launches[0]?.received).toHaveLength(1))

    await expect(rig.adapter.send('two')).rejects.toThrow('already answering')
  })
})

describe('Claude adapter: how turns end (2)', () => {
  it('interrupts the running turn on stop and settles it when the result arrives', async () => {
    const rig = await startRig({
      plans: [
        {
          script: ({ emit }) => {
            emit(init())
            return new Promise(() => {})
          }
        }
      ]
    })
    const turn = rig.adapter.send('long task')
    await vi.waitFor(() => expect(rig.events).toHaveLength(1))

    await rig.adapter.stop()
    expect(rig.sdk.launches[0]?.interrupts).toBe(1)
    rig.sdk.launches[0]?.emit(failure('error_during_execution', ['Request was aborted'], { terminal_reason: 'aborted_streaming' }))

    await expect(turn).resolves.toBeUndefined()
  })

  it('does not run a turn that was stopped before its process had started', async () => {
    const rig = await startRig({ plans: [replay(init(), success('ok'))] })

    const turn = rig.adapter.send('hi')
    await rig.adapter.stop()

    await expect(turn).resolves.toBeUndefined()
    expect(rig.sdk.launches[0]?.received ?? []).toEqual([])
  })

  it('adds what the process printed on stderr to the error that ended a turn', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init()) }], stderr: 'Error: socket hang up\n' })
    const turn = rig.adapter.send('hi')
    await vi.waitFor(() => expect(rig.events).toHaveLength(1))

    rig.sdk.launches[0]?.finish(new Error('Claude Code process exited with code 1'))

    await expect(turn).rejects.toThrow('exited with code 1\nError: socket hang up')
  })

  it('does nothing on stop between turns', async () => {
    const rig = await startRig({ plans: [replay(init(), success('ok'))] })
    await rig.adapter.send('hi')

    await rig.adapter.stop()

    expect(rig.sdk.launches[0]?.interrupts).toBe(0)
  })
})

describe('Claude adapter: how turns end (3)', () => {
  it('rejects the turn when the process dies without a result', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init()) }] })
    const turn = rig.adapter.send('hi')
    await vi.waitFor(() => expect(rig.events).toHaveLength(1))

    rig.sdk.launches[0]?.finish(null)

    await expect(turn).rejects.toThrow('stopped before the turn finished')
  })

  it('rejects the turn with the error that ended the stream', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init()) }] })
    const turn = rig.adapter.send('hi')
    await vi.waitFor(() => expect(rig.events).toHaveLength(1))

    rig.sdk.launches[0]?.finish(new Error('Claude Code process exited with code 1'))

    await expect(turn).rejects.toThrow('exited with code 1')
  })

  it('wraps a stream failure that is not an Error', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init()) }] })
    const turn = rig.adapter.send('hi')
    await vi.waitFor(() => expect(rig.events).toHaveLength(1))

    rig.sdk.launches[0]?.finish('weird' as unknown as Error)

    await expect(turn).rejects.toThrow('weird')
  })
})

describe('Claude adapter: one process carries several turns (1)', () => {
  it('reports a process that cannot be started and can try again with the next message', async () => {
    const sdk = fakeSdk([replay(init(), success('ok'))])
    let attempts = 0
    const flaky: ClaudeQueryFactory = (params) => {
      attempts += 1
      if (attempts === 1) {
        throw new Error('spawn EPERM')
      }
      return sdk.query(params)
    }
    const rig = await startRig({ deps: { query: flaky } })

    await expect(rig.adapter.send('one')).rejects.toThrow('spawn EPERM')
    await expect(rig.adapter.send('two')).resolves.toBeUndefined()
  })

  it('streams every message into one query with the folder as working directory', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit, index }) => emit(init(), success(`turn ${index}`)) }] })

    await rig.adapter.send('first')
    await rig.adapter.send('second')

    expect(rig.sdk.launches).toHaveLength(1)
    expect(rig.sdk.launches[0]?.received).toEqual([
      { type: 'user', message: { role: 'user', content: 'first' }, parent_tool_use_id: null },
      { type: 'user', message: { role: 'user', content: 'second' }, parent_tool_use_id: null }
    ])
    expect(rig.sdk.launches[0]?.options).toMatchObject({
      cwd: FOLDER,
      pathToClaudeCodeExecutable: EXECUTABLE,
      permissionMode: 'default',
      includePartialMessages: true,
      systemPrompt: { type: 'preset', preset: 'claude_code' }
    })
  })

  it('starts nothing until the first message', async () => {
    const rig = await startRig({ plans: [replay(init(), success('ok'))] })

    expect(rig.sdk.launches).toHaveLength(0)
    expect(rig.processes.killed).toBe(0)
  })
})

describe('Claude adapter: one process carries several turns (2)', () => {
  it('starts again after the process dies between turns, resuming the stored session', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init(), success('ok')) }] })
    await rig.adapter.send('one')

    rig.sdk.launches[0]?.finish(null)
    await vi.waitFor(() => expect(rig.sdk.launches[0]?.closed).toBe(true))
    await rig.adapter.send('two')

    expect(rig.sdk.launches).toHaveLength(2)
    expect(rig.sdk.launches[1]?.options.resume).toBe(SESSION)
  })

  it('runs the process through the tracker that can kill its whole tree', async () => {
    const rig = await startRig({ plans: [replay(init(), success('ok'))] })

    await rig.adapter.send('hi')

    expect(rig.sdk.launches[0]?.options.spawnClaudeCodeProcess).toBe(rig.processes.spawn)
  })

  it('runs a turn after the process died, without blaming a session it had not started to resume', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init(), success('ok')) }] })
    await rig.adapter.send('one')
    rig.sdk.launches[0]?.finish(new Error('killed'))
    await vi.waitFor(() => expect(rig.sdk.launches[0]?.closed).toBe(true))

    await rig.adapter.send('two')

    expect(rig.items()).toEqual([])
  })
})

// ---- Subagent threads ----

type ThreadItem = Extract<ChatItem, { kind: 'thread' }>

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** The transcript: each id once, where it first appeared, with its latest content (the rule of the chat store). */
const collapse = (items: readonly ChatItem[]): ChatItem[] => [...new Map(items.map((item) => [item.id, item])).values()]

const threadItems = (items: readonly ChatItem[]): ThreadItem[] => collapse(items).filter((item): item is ThreadItem => item.kind === 'thread')

/** One short line per item, to read an order at a glance. */
function brief(item: ChatItem): string {
  if (item.kind === 'tool_call') {
    return `${item.name} ${item.status}`
  }
  return item.kind === 'thread' ? `thread ${item.label} ${item.state}` : item.kind
}

/** The briefs of one thread's items (the chat's own thread when `threadId` is undefined), in transcript order. */
const inThread = (items: readonly ChatItem[], threadId: string | undefined): string[] =>
  collapse(items)
    .filter((item) => item.threadId === threadId)
    .map(brief)

const threadOf = (spawnId: string): string => `claude_thread_${spawnId}`

/** Plays a recorded session: its messages stream, and a recorded permission request waits for the person to answer. */
const playRecording = (steps: readonly RecordedStep[]): Plan => ({
  script: async ({ emit, ask }) => {
    for (const step of steps) {
      if (step.kind === 'message') {
        emit(step.message)
      } else {
        await settle()
        await ask(step.tool, step.input, step.options.toolUseID, { agentID: step.options.agentID })
      }
    }
  }
})

async function playRecorded(answer: ApprovalDecision = 'deny'): Promise<Rig> {
  const rig = await startRig({ plans: [playRecording(CLAUDE_SUBAGENTS)] })
  const turn = rig.adapter.send('Summarize a.txt and b.txt with two subagents')
  ;(await pendingApproval(rig)).respond(answer)
  await turn
  return rig
}

describe('Claude adapter: a recorded session with two parallel subagents', () => {
  it('replays into two threads under their spawning calls, in order, each with its own items', async () => {
    const rig = await playRecorded()

    expect(inThread(rig.items(), undefined)).toEqual([
      'Agent completed',
      'thread Summarize a.txt done',
      'Agent completed',
      'thread Summarize b.txt done',
      'assistant_text'
    ])
    expect(inThread(rig.items(), threadOf(SPAWN_A))).toEqual(['Read completed', 'assistant_text'])
    expect(inThread(rig.items(), threadOf(SPAWN_B))).toEqual(['Read completed', 'Write denied', 'assistant_text'])
    expect(threadItems(rig.items())).toEqual([
      { id: threadOf(SPAWN_A), at: NOW, kind: 'thread', parentItemId: `claude_tool_${SPAWN_A}`, label: 'Summarize a.txt', state: 'done' },
      { id: threadOf(SPAWN_B), at: NOW, kind: 'thread', parentItemId: `claude_tool_${SPAWN_B}`, label: 'Summarize b.txt', state: 'done' }
    ])
  })

  it('opens each thread right after its spawning call, before anything that happens inside it', async () => {
    const rig = await playRecorded()

    expect(rig.items().slice(0, 4).map(brief)).toEqual(['Agent running', 'thread Summarize a.txt running', 'Agent running', 'thread Summarize b.txt running'])
    expect(rig.items().slice(0, 4).map((item) => item.id)).toEqual([`claude_tool_${SPAWN_A}`, threadOf(SPAWN_A), `claude_tool_${SPAWN_B}`, threadOf(SPAWN_B)])
  })

  it('gives each spawning call the subagent\'s own report as its result, not the hand-back frame around it', async () => {
    const rig = await playRecorded()

    const calls = collapse(rig.items()).filter((item) => item.kind === 'tool_call' && item.name === 'Agent')
    expect(calls[0]).toMatchObject({ resultSummary: 'The alpha file lists three fruits: apple, banana, and cherry.' })
    expect(calls[1]).toMatchObject({ resultSummary: expect.stringContaining('beta notes listing three tools') })
  })

  it('stores and replays through the chat store with the rest of the chat', async () => {
    const rig = await playRecorded()
    const store = memoryChatStore()
    const chat = store.createChat({ folder: REPO, agent: 'claude', model: null, role: 'orchestrator', allowSave: true })

    for (const event of rig.events) {
      if (event.type === 'item' || event.type === 'approval_request') {
        store.appendItem(chat, event.type === 'item' ? event.item : event.request)
      }
    }

    const stored = store.readTranscript(chat)?.items ?? []
    expect(inThread(stored, undefined)).toContain('thread Summarize b.txt done')
    expect(inThread(stored, threadOf(SPAWN_B))).toEqual(['Read completed', 'Write denied', 'approval_request', 'assistant_text'])
    expect(threadItems(stored).map((item) => [item.label, item.state])).toEqual([
      ['Summarize a.txt', 'done'],
      ['Summarize b.txt', 'done']
    ])
  })
})

const SPAWN = 'toolu_spawn'

const spawnCall = (id = SPAWN, description: string | null = 'Summarize a.txt', name = 'Agent'): SDKMessage =>
  assistant(`msg_${id}`, [toolUse(id, name, { ...(description === null ? {} : { description }), subagent_type: 'file-reader', prompt: 'Read a.txt.' })])

const taskStarted = (spawnId: string, taskId: string, background = false): SDKMessage =>
  message({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: spawnId, description: 'Summarize a.txt', is_backgrounded: background, session_id: SESSION, uuid: uuid() })

const taskEnded = (status: string, spawnId = SPAWN, taskId = AGENT_B): SDKMessage =>
  message({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: spawnId, status, output_file: '/tmp/out', summary: 'done', session_id: SESSION, uuid: uuid() })

const inside = (spawnId: string, messageId: string, ...blocks: object[]): SDKMessage => assistant(messageId, blocks, { parent_tool_use_id: spawnId })

/** The result of an Agent call that started its subagent in the background: the call is answered at once, the outcome comes later. */
const launched = (spawnId = SPAWN): SDKMessage =>
  toolResult(spawnId, 'Async agent launched successfully.', false, { tool_use_result: { isAsync: true, status: 'async_launched', agentId: AGENT_B } })

const states = (rig: Rig): string[] => threadItems(rig.items()).map((item) => item.state)

/** A rig whose CLI streams `messages`, lets the adapter read them, and then asks permission to Write; resolves with the request raised. */
async function requestAfter(messages: SDKMessage[], toolUseID: string, agentID?: string): Promise<ApprovalRequestItem> {
  const extras = agentID === undefined ? {} : { agentID }
  const rig = await startRig({
    plans: [
      {
        script: async ({ emit, ask }) => {
          emit(init(), ...messages)
          await settle()
          await ask('Write', { file_path: resolve(FOLDER, 'a.txt'), content: 'x' }, toolUseID, extras)
        }
      }
    ]
  })
  void rig.adapter.send('go')
  return (await pendingApproval(rig)).request
}

describe('Claude adapter: approvals raised inside a subagent (1)', () => {
  it('carries the id and label of the subagent\'s thread (recorded Write request)', async () => {
    const rig = await startRig({ plans: [playRecording(CLAUDE_SUBAGENTS)] })
    const turn = rig.adapter.send('Summarize a.txt and b.txt with two subagents')

    const approval = await pendingApproval(rig)

    expect(approval.request).toEqual({
      id: `claude_approval_${WRITE_CALL}`,
      at: NOW,
      kind: 'approval_request',
      requestId: WRITE_CALL,
      category: 'file_edit',
      tool: 'Write',
      summary: 'Write /work/repo/summary-b.txt',
      input: { file_path: '/work/repo/summary-b.txt', content: 'The file contains beta notes listing three tools: hammer, wrench, and saw.' },
      threadId: threadOf(SPAWN_B),
      threadLabel: 'Summarize b.txt'
    })
    approval.respond('allow_once')
    await turn
  })

  it('labels the request from the subagent id alone, when the adapter has not yet read the tool call', async () => {
    const request = await requestAfter([spawnCall(), taskStarted(SPAWN, AGENT_B)], 'toolu_w', AGENT_B)

    expect(request).toMatchObject({ threadId: threadOf(SPAWN), threadLabel: 'Summarize a.txt' })
  })

  it('labels the request from the tool call alone, when the CLI names no subagent', async () => {
    const write = toolUse('toolu_w', 'Write', { file_path: resolve(FOLDER, 'a.txt'), content: 'x' })

    const request = await requestAfter([spawnCall(), inside(SPAWN, 'msg_in', write)], 'toolu_w')

    expect(request).toMatchObject({ threadId: threadOf(SPAWN), threadLabel: 'Summarize a.txt' })
  })
})

describe('Claude adapter: approvals raised inside a subagent (2)', () => {
  it('names the innermost thread when a subagent starts one of its own', async () => {
    const inner = inside(SPAWN, 'msg_s', toolUse('toolu_inner', 'Agent', { description: 'Check the cherries', prompt: 'p' }))

    const request = await requestAfter([spawnCall(), inner, taskStarted('toolu_inner', 'agent_inner')], 'toolu_b', 'agent_inner')

    expect(request).toMatchObject({ threadId: threadOf('toolu_inner'), threadLabel: 'Check the cherries' })
  })

  it('leaves the request in the chat\'s own thread when the subagent is not one it has seen', async () => {
    const request = await requestAfter([], 'toolu_x', 'nobody_we_know')

    expect(request).not.toHaveProperty('threadId')
    expect(request).not.toHaveProperty('threadLabel')
  })
})

describe('Claude adapter: how a thread ends (1)', () => {
  it('is done when the spawning call succeeds, and failed when it fails', async () => {
    const done = await startRig({ plans: [replay(init(), spawnCall(), taskStarted(SPAWN, AGENT_B), toolResult(SPAWN, 'All good.'), success('ok'))] })
    await done.adapter.send('go')
    expect(states(done)).toEqual(['done'])

    const failed = await startRig({ plans: [replay(init(), spawnCall(), taskStarted(SPAWN, AGENT_B), toolResult(SPAWN, 'The subagent gave up.', true), success('ok'))] })
    await failed.adapter.send('go')
    expect(states(failed)).toEqual(['failed'])
    expect(collapse(failed.items()).map(brief)).toEqual(['Agent failed', 'thread Summarize a.txt failed'])
  })

  it('follows the spawning call\'s result, not the notification, for a subagent the call waited for', async () => {
    const rig = await startRig({
      plans: [replay(init(), spawnCall(), taskStarted(SPAWN, AGENT_B), taskEnded('completed'), toolResult(SPAWN, 'The subagent failed after all.', true), success('ok'))]
    })

    await rig.adapter.send('go')

    expect(states(rig)).toEqual(['failed'])
  })

  it('stays running after the answer that only says a background subagent started, and follows its notification', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init(), spawnCall(), taskStarted(SPAWN, AGENT_B, true), launched(), success('started')) }] })

    await rig.adapter.send('go')
    expect(states(rig)).toEqual(['running'])
    expect(collapse(rig.items()).map(brief)).toEqual(['Agent completed', 'thread Summarize a.txt running'])

    rig.sdk.launches[0]?.emit(taskEnded('completed'))
    await vi.waitFor(() => expect(states(rig)).toEqual(['done']))
  })

  it.each([
    ['failed', 'failed'],
    ['stopped', 'failed']
  ])('ends a background thread as failed when its notification says %s', async (status, state) => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init(), spawnCall(), launched(), success('started')) }] })
    await rig.adapter.send('go')

    rig.sdk.launches[0]?.emit(taskEnded(status))

    await vi.waitFor(() => expect(states(rig)).toEqual([state]))
  })

  it('does not reopen or change a thread that already ended', async () => {
    const rig = await startRig({ plans: [replay(init(), spawnCall(), toolResult(SPAWN, 'ok'), taskEnded('failed'), toolResult(SPAWN, 'again', true), success('ok'))] })

    await rig.adapter.send('go')

    expect(rig.items().filter((item) => item.kind === 'thread').map(brief)).toEqual(['thread Summarize a.txt running', 'thread Summarize a.txt done'])
  })
})

describe('Claude adapter: how a thread ends (2)', () => {
  it('fails a thread whose call never got an answer when the turn ends', async () => {
    const rig = await startRig({ plans: [replay(init(), spawnCall(), taskStarted(SPAWN, AGENT_B), success('interrupted'))] })

    await rig.adapter.send('go')

    expect(states(rig)).toEqual(['failed'])
  })

  it('leaves a background thread running when the turn ends, since its subagent goes on', async () => {
    const rig = await startRig({ plans: [replay(init(), spawnCall(), taskStarted(SPAWN, AGENT_B, true), launched(), success('started'))] })

    await rig.adapter.send('go')

    expect(states(rig)).toEqual(['running'])
  })

  it('fails the threads still running when the process ends, since their subagents died with it', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init(), spawnCall(), launched(), success('started')) }] })
    await rig.adapter.send('go')

    rig.sdk.launches[0]?.finish(null)

    await vi.waitFor(() => expect(states(rig)).toEqual(['failed']))
  })

  it('sends nothing more once the adapter is disposed', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init(), spawnCall(), launched(), success('started')) }] })
    await rig.adapter.send('go')

    await rig.adapter.dispose()

    expect(states(rig)).toEqual(['running'])
  })
})

describe('Claude adapter: how a thread ends (3)', () => {
  it.each([
    ['isAsync', { isAsync: true }],
    ['status', { status: 'async_launched' }]
  ])('takes a call answered with only %s as the launch of a background subagent', async (_name, structured) => {
    const rig = await startRig({ plans: [replay(init(), spawnCall(), toolResult(SPAWN, 'Started.', false, { tool_use_result: structured }), success('ok'))] })

    await rig.adapter.send('go')

    expect(states(rig)).toEqual(['running'])
  })

  it('shows the answer\'s own text when the structured result holds no report', async () => {
    const answer = toolResult(SPAWN, 'The plain answer.', false, { tool_use_result: { status: 'completed', content: [] } })
    const rig = await startRig({ plans: [replay(init(), spawnCall(), answer, success('ok'))] })

    await rig.adapter.send('go')

    expect(collapse(rig.items())[0]).toMatchObject({ kind: 'tool_call', status: 'completed', resultSummary: 'The plain answer.' })
  })
})

describe('Claude adapter: what a thread holds (1)', () => {
  it('maps text and tool calls of a subagent into its thread, with results that finish the same calls', async () => {
    const rig = await startRig({
      plans: [
        replay(
          init(),
          spawnCall(),
          inside(SPAWN, 'msg_a', { type: 'thinking', thinking: 'hm', signature: 's' }, toolUse('toolu_r', 'Read', { file_path: 'a.txt' })),
          message({ type: 'user', session_id: SESSION, parent_tool_use_id: SPAWN, message: { role: 'user', content: [{ type: 'text', text: 'the prompt it was given' }] } }),
          toolResult('toolu_r', 'Alpha', false, { parent_tool_use_id: SPAWN }),
          inside(SPAWN, 'msg_b', text('Alpha lists fruit.')),
          toolResult(SPAWN, 'Alpha lists fruit.'),
          success('ok')
        )
      ]
    })

    await rig.adapter.send('go')

    expect(inThread(rig.items(), threadOf(SPAWN))).toEqual(['Read completed', 'assistant_text'])
    expect(collapse(rig.items()).filter((item) => item.threadId !== undefined)).toEqual([
      { id: 'claude_tool_toolu_r', at: NOW, kind: 'tool_call', name: 'Read', input: { file_path: 'a.txt' }, status: 'completed', resultSummary: 'Alpha', threadId: threadOf(SPAWN) },
      { id: 'claude_msg_b_0', at: NOW, kind: 'assistant_text', text: 'Alpha lists fruit.', threadId: threadOf(SPAWN) }
    ])
  })

  it('streams a subagent\'s text as deltas of its thread, apart from the main agent\'s own streaming', async () => {
    const rig = await startRig({
      plans: [
        replay(
          init(),
          spawnCall(),
          streamEvent({ type: 'message_start', message: { id: 'msg_sub', role: 'assistant', content: [] } }, SPAWN),
          messageStart('msg_main'),
          streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'inner' } }, SPAWN),
          textDelta(0, 'outer'),
          success('ok')
        )
      ]
    })

    await rig.adapter.send('go')

    expect(rig.events.filter((event) => event.type === 'assistant_delta')).toEqual([
      { type: 'assistant_delta', itemId: 'claude_msg_sub_0', delta: 'inner', threadId: threadOf(SPAWN) },
      { type: 'assistant_delta', itemId: 'claude_msg_main_0', delta: 'outer' }
    ])
  })

})

describe('Claude adapter: what a thread holds (2)', () => {
  it('opens a thread inside the thread of the subagent that started it', async () => {
    const rig = await startRig({
      plans: [
        replay(
          init(),
          spawnCall(),
          inside(SPAWN, 'msg_s', toolUse('toolu_inner', 'Agent', { description: 'Check the cherries', prompt: 'p' })),
          inside('toolu_inner', 'msg_t', text('Cherries are red.')),
          success('ok')
        )
      ]
    })

    await rig.adapter.send('go')

    expect(threadItems(rig.items()).map((item) => [item.id, item.threadId, item.parentItemId])).toEqual([
      [threadOf(SPAWN), undefined, `claude_tool_${SPAWN}`],
      [threadOf('toolu_inner'), threadOf(SPAWN), 'claude_tool_toolu_inner']
    ])
    expect(inThread(rig.items(), threadOf('toolu_inner'))).toEqual(['assistant_text'])
  })

  it('opens a thread for subagent traffic whose spawning call it never saw, labelled by what the CLI says', async () => {
    const rig = await startRig({
      plans: [
        replay(
          init(),
          assistant('msg_7', [text('inside a subagent')], { parent_tool_use_id: 'toolu_task', task_description: 'Check the cherries', subagent_type: 'file-reader' }),
          assistant('msg_8', [text('inside another')], { parent_tool_use_id: 'toolu_other', subagent_type: 'file-reader' }),
          assistant('msg_9', [text('and a third')], { parent_tool_use_id: 'toolu_third' }),
          success('ok')
        )
      ]
    })

    await rig.adapter.send('go')

    expect(threadItems(rig.items()).map((item) => [item.id, item.label, item.parentItemId])).toEqual([
      [threadOf('toolu_task'), 'Check the cherries', 'claude_tool_toolu_task'],
      [threadOf('toolu_other'), 'file-reader', 'claude_tool_toolu_other'],
      [threadOf('toolu_third'), 'Subagent', 'claude_tool_toolu_third']
    ])
    expect(inThread(rig.items(), threadOf('toolu_task'))).toEqual(['assistant_text'])
  })

  it('does not report a rejected sign-in raised inside a subagent as the chat\'s own', async () => {
    const rig = await startRig({
      plans: [replay(init(), spawnCall(), assistant('msg_auth', [text('Not logged in')], { parent_tool_use_id: SPAWN, error: 'authentication_failed' }), success('ok'))]
    })

    await rig.adapter.send('go')

    expect(rig.items().some((item) => item.kind === 'auth_required')).toBe(false)
    expect(inThread(rig.items(), threadOf(SPAWN))).toEqual([])
  })
})

describe('Claude adapter: naming a thread', () => {
  it.each([
    ['trims the description the call gave', '  Summarize a.txt  ', 'Summarize a.txt'],
    ['falls back to the subagent type', null, 'file-reader'],
    ['cuts a very long description short', 'x'.repeat(300), `${'x'.repeat(120)}…`]
  ])('%s', async (_name, description, label) => {
    const rig = await startRig({ plans: [replay(init(), spawnCall(SPAWN, description), success('ok'))] })

    await rig.adapter.send('go')

    expect(threadItems(rig.items()).map((item) => item.label)).toEqual([label])
  })

  it('opens a thread for the older name of the subagent tool, and for no other tool', async () => {
    const rig = await startRig({
      plans: [replay(init(), spawnCall('toolu_old', 'Old name', 'Task'), assistant('msg_r', [toolUse('toolu_read', 'Read', { file_path: 'a.txt' })]), success('ok'))]
    })

    await rig.adapter.send('go')

    expect(threadItems(rig.items()).map((item) => item.label)).toEqual(['Old name'])
  })

  it('has the CLI forward subagent text, so a thread holds more than the tool calls', async () => {
    const rig = await startRig({ plans: [replay(init(), success('ok'))] })

    await rig.adapter.send('hi')

    expect(rig.sdk.launches[0]?.options).toMatchObject({ forwardSubagentText: true })
  })
})

// ---- The Dark Mechanicus server and the executable ----

describe('Claude adapter: launch options (1)', () => {
  it('passes the Dark Mechanicus server through mcpServers', async () => {
    const rig = await startRig({ plans: [replay(init(), success('ok'))] })

    await rig.adapter.send('hi')

    expect(rig.sdk.launches[0]?.options.mcpServers).toEqual({
      darkmechanicus: {
        type: 'stdio',
        command: 'node',
        args: ['mcp.js', '--role', 'orchestrator', '--allow-save', '--label', 'Claude · Chat'],
        env: { DM_HOME: '/state' }
      }
    })
  })

  it('leaves the server environment out when it has none', async () => {
    const rig = await startRig({
      plans: [replay(init(), success('ok'))],
      start: { darkMechanicus: { command: 'dm', args: ['--role', 'planner'] } }
    })

    await rig.adapter.send('hi')

    expect(rig.sdk.launches[0]?.options.mcpServers).toEqual({ darkmechanicus: { type: 'stdio', command: 'dm', args: ['--role', 'planner'] } })
  })

  it('starts on the chat model, treating "default" as the CLI default', async () => {
    const named = await startRig({ plans: [replay(init(), success('ok'))], start: { model: 'claude-opus-4-8' } })
    await named.adapter.send('hi')
    expect(named.sdk.launches[0]?.options.model).toBe('claude-opus-4-8')

    const unset = await startRig({ plans: [replay(init(), success('ok'))], start: { model: 'default' } })
    await unset.adapter.send('hi')
    expect(unset.sdk.launches[0]?.options).not.toHaveProperty('model')

    const none = await startRig({ plans: [replay(init(), success('ok'))] })
    await none.adapter.send('hi')
    expect(none.sdk.launches[0]?.options).not.toHaveProperty('model')
  })
})

describe('Claude adapter: launch options (2)', () => {
  it('runs an npm shim through the program it points at', async () => {
    const sdk = fakeSdk([replay(init(), success('ok'))])
    const adapter = createClaudeAdapter('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', {
      query: sdk.query,
      createProcesses: () => fakeProcesses(sdk.log),
      platform: 'win32',
      readFile: () => '"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*'
    })
    await adapter.start(START, () => {})

    await adapter.send('hi')

    expect(sdk.launches[0]?.options.pathToClaudeCodeExecutable).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
    )
  })

  it('refuses to start when a shim cannot be resolved', async () => {
    const sdk = fakeSdk()
    const adapter = createClaudeAdapter('C:\\npm\\claude.cmd', {
      query: sdk.query,
      createProcesses: () => fakeProcesses(sdk.log),
      platform: 'win32',
      readFile: () => 'echo nothing useful'
    })

    await expect(adapter.start(START, () => {})).rejects.toThrow(/claude\.exe/)
  })
})

// ---- c2: approvals ----

describe('Claude adapter: tools the chat cannot run', () => {
  it('refuses a question with answer buttons, telling the agent to ask in plain text, without asking the person', async () => {
    const outcomes: PermissionResult[] = []
    const rig = await startRig({
      plans: [{ script: async ({ ask, emit }) => void (outcomes.push(await ask('AskUserQuestion', { questions: [] })), emit(success('ok'))) }]
    })

    await rig.adapter.send('go')

    expect(rig.approvals).toEqual([])
    expect(outcomes).toEqual([{ behavior: 'deny', message: expect.stringContaining('plain text'), toolUseID: expect.any(String) }])
  })
})

describe('Claude adapter: approvals (1)', () => {
  it('turns an Edit into a file_edit request and runs it only on Allow', async () => {
    const outcomes: PermissionResult[] = []
    const rig = await startRig({
      plans: [
        {
          script: async ({ emit, ask }) => {
            emit(init())
            outcomes.push(await ask('Edit', { file_path: resolve(FOLDER, 'a.ts'), old_string: 'a', new_string: 'b' }, 'toolu_edit'))
            emit(success('done'))
          }
        }
      ]
    })

    const turn = rig.adapter.send('edit it')
    const approval = await pendingApproval(rig)
    expect(outcomes).toEqual([])
    expect(approval.request).toEqual({
      id: 'claude_approval_toolu_edit',
      at: NOW,
      kind: 'approval_request',
      requestId: 'toolu_edit',
      category: 'file_edit',
      tool: 'Edit',
      summary: `Edit ${resolve(FOLDER, 'a.ts')}`,
      input: { file_path: resolve(FOLDER, 'a.ts'), old_string: 'a', new_string: 'b' }
    })

    approval.respond('allow_once')
    await turn

    expect(outcomes).toEqual([
      { behavior: 'allow', updatedInput: { file_path: resolve(FOLDER, 'a.ts'), old_string: 'a', new_string: 'b' }, toolUseID: 'toolu_edit' }
    ])
  })
})

describe('Claude adapter: approvals (2)', () => {
  it('turns Write and Bash into requests of their own categories', async () => {
    const rig = await startRig({
      plans: [
        {
          script: async ({ emit, ask }) => {
            emit(init())
            await ask('Write', { file_path: resolve(FOLDER, 'new.txt'), content: 'hi' }, 'toolu_w')
            await ask('Bash', { command: 'npm test' }, 'toolu_b')
            emit(success('done'))
          }
        }
      ]
    })

    const turn = rig.adapter.send('go')
    ;(await pendingApproval(rig, 1)).respond('allow_once')
    ;(await pendingApproval(rig, 2)).respond('allow_once')
    await turn

    expect(rig.approvals.map(({ request }) => [request.category, request.tool, request.summary])).toEqual([
      ['file_edit', 'Write', `Write ${resolve(FOLDER, 'new.txt')}`],
      ['command', 'Bash', 'Run npm test']
    ])
  })

  it('puts the multi-line, over-long command in the summary on one short line', async () => {
    const command = `echo start\n${'a'.repeat(400)}`
    const rig = await startRig({ plans: [{ script: ({ ask }) => void ask('Bash', { command }) }] })

    void rig.adapter.send('go')
    const { request } = await pendingApproval(rig)

    expect(request.summary).not.toContain('\n')
    expect(request.summary.length).toBeLessThan(220)
    expect(request.summary.startsWith('Run echo start')).toBe(true)
  })

  it.each([
    ['MultiEdit', 'file_edit'],
    ['NotebookEdit', 'file_edit'],
    ['PowerShell', 'command'],
    ['WebFetch', 'other'],
    ['mcp__darkmechanicus__save_plan', 'other']
  ])('asks about %s as a %s request', async (tool, category) => {
    const rig = await startRig({ plans: [{ script: ({ ask }) => void ask(tool, { url: 'https://example.com' }) }] })

    void rig.adapter.send('go')
    const { request } = await pendingApproval(rig)

    expect(request).toMatchObject({ tool, category, summary: `Use ${tool}` })
  })
})

describe('Claude adapter: approvals (3)', () => {
  it('answers Allow for this chat as an allow, without writing a permission rule anywhere', async () => {
    const outcomes: PermissionResult[] = []
    const rig = await startRig({
      plans: [
        {
          script: async ({ ask, emit }) => {
            outcomes.push(await ask('Bash', { command: 'ls' }))
            emit(success('ok'))
          }
        }
      ]
    })

    const turn = rig.adapter.send('go')
    ;(await pendingApproval(rig)).respond('allow_chat')
    await turn

    expect(outcomes[0]?.behavior).toBe('allow')
    expect(outcomes[0]).not.toHaveProperty('updatedPermissions')
  })

  it('denies on Deny, tells the agent so, and marks the tool call denied', async () => {
    const outcomes: PermissionResult[] = []
    const rig = await startRig({
      plans: [
        {
          script: async ({ ask, emit }) => {
            emit(init(), assistant('msg_d', [toolUse('toolu_d', 'Bash', { command: 'rm -rf .' })]))
            outcomes.push(await ask('Bash', { command: 'rm -rf .' }, 'toolu_d'))
            emit(toolResult('toolu_d', 'The person declined this request.', true), success('ok'))
          }
        }
      ]
    })

    const turn = rig.adapter.send('clean up')
    ;(await pendingApproval(rig)).respond('deny')
    await turn

    expect(outcomes[0]).toMatchObject({ behavior: 'deny', toolUseID: 'toolu_d', message: expect.stringContaining('declined') })
    expect(outcomes[0]).not.toHaveProperty('interrupt', true)
    expect(rig.items().at(-1)).toMatchObject({ kind: 'tool_call', id: 'claude_tool_toolu_d', status: 'denied' })
  })
})

describe('Claude adapter: approvals (4)', () => {
  it('holds the agent at the request until the person answers, however long that takes', async () => {
    vi.useFakeTimers()
    const outcomes: PermissionResult[] = []
    const rig = await startRig({ plans: [{ script: async ({ ask }) => void outcomes.push(await ask('Bash', { command: 'ls' })) }] })

    void rig.adapter.send('go')
    await vi.advanceTimersByTimeAsync(60 * 60_000)

    expect(outcomes).toEqual([])
  })

  it.each([
    ['Read', { file_path: resolve(FOLDER, 'src', 'a.ts') }],
    ['Read', { file_path: 'src/a.ts' }],
    ['Read', { file_path: FOLDER }],
    ['Glob', { pattern: 'src/**/*.ts' }],
    ['Glob', { pattern: '**/*.ts', path: resolve(FOLDER, 'src') }],
    ['Grep', { pattern: '../not a path', path: FOLDER }],
    ['Grep', { pattern: 'TODO' }],
    ['Grep', { pattern: 'TODO', glob: '../*.md' }],
    ['LS', { path: resolve(FOLDER, 'docs') }],
    ['NotebookRead', { notebook_path: resolve(FOLDER, 'a.ipynb') }],
    ['Read', { file_path: resolve(FOLDER, '..foo', 'bar.txt') }]
  ])('lets %s through inside the folder without asking (%j)', async (tool, input) => {
    const outcomes: PermissionResult[] = []
    const rig = await startRig({ plans: [{ script: async ({ ask, emit }) => void (outcomes.push(await ask(tool, input)), emit(success('ok'))) }] })

    await rig.adapter.send('read')

    expect(rig.approvals).toEqual([])
    expect(outcomes).toEqual([{ behavior: 'allow', updatedInput: input, toolUseID: expect.any(String) }])
  })

  it.each([
    ['Read', { file_path: resolve(FOLDER, '..', 'other', 'secret.txt') }],
    ['Read', { file_path: resolve('/etc/passwd') }],
    ['Read', { file_path: '../outside.txt' }],
    ['Glob', { pattern: '../**/*.ts' }],
    ['Glob', { pattern: '*.ts', path: resolve(FOLDER, '..') }],
    ['Glob', { pattern: resolve('/etc/*') }],
    ['Grep', { pattern: 'x', path: resolve(FOLDER, '..', 'sibling') }],
    ['LS', { path: resolve('/') }],
    ['NotebookRead', { notebook_path: resolve(FOLDER, '..', 'a.ipynb') }]
  ])('asks before %s reads outside the folder (%j)', async (tool, input) => {
    const rig = await startRig({ plans: [{ script: ({ ask }) => void ask(tool, input) }] })

    void rig.adapter.send('read')
    const { request } = await pendingApproval(rig)

    expect(request).toMatchObject({ kind: 'approval_request', category: 'other', tool })
    expect(request.summary).toMatch(/outside/i)
  })
})

describe('Claude adapter: approvals (5)', () => {
  it('treats a read of the folder and a sibling that shares its name prefix differently', async () => {
    const sibling = `${FOLDER}-backup`
    const rig = await startRig({ plans: [{ script: ({ ask }) => void ask('Read', { file_path: resolve(sibling, 'a.txt') }) }] })

    void rig.adapter.send('read')

    expect((await pendingApproval(rig)).request.category).toBe('other')
  })

  it('denies a request whose agent gave up on it, and the late answer changes nothing', async () => {
    const controller = new AbortController()
    const outcomes: PermissionResult[] = []
    const rig = await startRig({ plans: [{ script: () => new Promise(() => {}) }] })
    void rig.adapter.send('go')
    await vi.waitFor(() => expect(rig.sdk.launches).toHaveLength(1))
    const canUseTool = rig.sdk.launches[0]?.options.canUseTool as CanUseTool

    const pending = canUseTool('Bash', { command: 'ls' }, { signal: controller.signal, toolUseID: 'toolu_x' } as Parameters<CanUseTool>[2])
    void pending.then((result) => outcomes.push(result as PermissionResult))
    await pendingApproval(rig)
    controller.abort()
    await vi.waitFor(() => expect(outcomes).toHaveLength(1))
    rig.approvals[0]?.respond('allow_once')

    expect(outcomes).toEqual([{ behavior: 'deny', message: expect.stringContaining('cancelled'), toolUseID: 'toolu_x' }])
  })

  it('denies a request that arrives with its signal already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const rig = await startRig({ plans: [{ script: () => new Promise(() => {}) }] })
    void rig.adapter.send('go')
    await vi.waitFor(() => expect(rig.sdk.launches).toHaveLength(1))
    const canUseTool = rig.sdk.launches[0]?.options.canUseTool as CanUseTool

    const result = await canUseTool('Bash', { command: 'ls' }, { signal: controller.signal, toolUseID: 'toolu_y' } as Parameters<CanUseTool>[2])

    expect(result).toMatchObject({ behavior: 'deny' })
  })

  it('denies waiting requests when the turn is stopped', async () => {
    const outcomes: PermissionResult[] = []
    const rig = await startRig({ plans: [{ script: async ({ ask }) => void outcomes.push(await ask('Bash', { command: 'ls' })) }] })

    void rig.adapter.send('go')
    await pendingApproval(rig)
    await rig.adapter.stop()

    await vi.waitFor(() => expect(outcomes).toHaveLength(1))
    expect(outcomes[0]?.behavior).toBe('deny')
  })
})

describe('Claude adapter: approvals (6)', () => {
  it('uses the prompt the CLI composed for the summary when it sends one', async () => {
    const rig = await startRig({ plans: [{ script: () => new Promise(() => {}) }] })
    void rig.adapter.send('go')
    await vi.waitFor(() => expect(rig.sdk.launches).toHaveLength(1))
    const canUseTool = rig.sdk.launches[0]?.options.canUseTool as CanUseTool

    void canUseTool('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 'toolu_t', title: 'Claude wants to list files' } as Parameters<CanUseTool>[2])

    expect((await pendingApproval(rig)).request.summary).toBe('Claude wants to list files')
  })

  it('keeps tool input that is not plain data out of the stored request', async () => {
    const rig = await startRig({ plans: [{ script: ({ ask }) => void ask('Bash', { command: 'ls', big: 10n as unknown as number }) }] })

    void rig.adapter.send('go')
    const { request } = await pendingApproval(rig)

    expect(request.input).toEqual({})
  })
})

// ---- c3: context ----

describe('Claude adapter: a session the CLI cannot find', () => {
  const missing = (extra: object = {}): SDKMessage => failure('error_during_execution', [`No conversation found with session ID: ${SESSION}`], extra)
  const freshSession = replay(init(OTHER_SESSION), success('ok', { session_id: OTHER_SESSION }))

  it('continues in a new session when the CLI answers with nothing but an error result', async () => {
    const rig = await startRig({ plans: [replay(missing()), freshSession], start: { sessionId: SESSION } })

    await rig.adapter.send('hello again')

    expect(rig.sdk.launches).toHaveLength(2)
    expect(rig.sdk.launches[0]?.closed).toBe(true)
    expect(rig.sdk.launches[1]?.options).not.toHaveProperty('resume')
    expect(rig.sdk.launches[1]?.received).toEqual([{ type: 'user', message: { role: 'user', content: 'hello again' }, parent_tool_use_id: null }])
    expect(rig.events.map((event) => (event.type === 'item' ? event.item.kind : event.type))).toEqual(['context_reset', 'session'])
    expect(rig.items()[0]).toMatchObject({ reason: 'session_lost', message: expect.stringContaining('No conversation found') })
  })

  it('does not announce the session id the CLI failed to find', async () => {
    const rig = await startRig({ plans: [replay(missing()), freshSession], start: { sessionId: SESSION } })

    await rig.adapter.send('hello again')

    expect(rig.events).not.toContainEqual({ type: 'session', sessionId: SESSION })
  })

  it('does not call a startup failure the CLI names a lost session', async () => {
    const rig = await startRig({
      plans: [replay(missing({ startup_failure_reason: 'gateway_signin_required' }))],
      start: { sessionId: SESSION }
    })

    await expect(rig.adapter.send('hello')).rejects.toThrow('No conversation found')

    expect(rig.sdk.launches).toHaveLength(1)
    expect(rig.items()).toEqual([])
  })

  it('does not call an error after the CLI has started talking a lost session', async () => {
    const rig = await startRig({ plans: [replay(init(), missing())], start: { sessionId: SESSION } })

    await expect(rig.adapter.send('hello')).rejects.toThrow('No conversation found')

    expect(rig.sdk.launches).toHaveLength(1)
    expect(rig.items()).toEqual([])
  })

  it('does not retry a chat that had no session to resume', async () => {
    const rig = await startRig({ plans: [replay(missing())] })

    await expect(rig.adapter.send('hello')).rejects.toThrow('No conversation found')

    expect(rig.sdk.launches).toHaveLength(1)
  })
})

describe('Claude adapter: session and context (1)', () => {
  it('reports the session id as soon as the CLI names it', async () => {
    const rig = await startRig({ plans: [replay(init(), success('ok'))] })

    await rig.adapter.send('hi')

    expect(rig.events[0]).toEqual({ type: 'session', sessionId: SESSION })
  })

  it('resumes the stored session when a chat is reopened', async () => {
    const rig = await startRig({ plans: [replay(init(), success('ok'))], start: { sessionId: SESSION } })

    await rig.adapter.send('where were we?')

    expect(rig.sdk.launches[0]?.options.resume).toBe(SESSION)
    expect(rig.sdk.launches).toHaveLength(1)
    expect(rig.items()).toEqual([])
  })

  it('does not ask to resume when the chat has no session yet', async () => {
    const rig = await startRig({ plans: [replay(init(), success('ok'))] })

    await rig.adapter.send('hi')

    expect(rig.sdk.launches[0]?.options).not.toHaveProperty('resume')
  })

  it('records a context reset and continues in a new session when the old one cannot be resumed', async () => {
    const rig = await startRig({
      plans: [{ dieEarly: new Error('No conversation found with session ID: ' + SESSION) }, {
          script: ({ emit, text: body }) =>
            emit(init(OTHER_SESSION), assistant('msg_n', [text(`got ${body}`)], { session_id: OTHER_SESSION }), success('ok', { session_id: OTHER_SESSION }))
        }],
      start: { sessionId: SESSION }
    })

    await rig.adapter.send('continue please')

    expect(rig.sdk.launches).toHaveLength(2)
    expect(rig.sdk.launches[0]?.options.resume).toBe(SESSION)
    expect(rig.sdk.launches[1]?.options).not.toHaveProperty('resume')
    expect(rig.sdk.launches[1]?.received).toEqual([{ type: 'user', message: { role: 'user', content: 'continue please' }, parent_tool_use_id: null }])
    expect(rig.events.map((event) => (event.type === 'item' ? event.item.kind : event.type))).toEqual(['context_reset', 'session', 'assistant_text'])
    expect(rig.items()[0]).toMatchObject({
      kind: 'context_reset',
      reason: 'session_lost',
      message: expect.stringContaining('No conversation found')
    })
    expect(rig.events).toContainEqual({ type: 'session', sessionId: OTHER_SESSION })
  })
})

describe('Claude adapter: session and context (2)', () => {
  it('also treats a stream that ends without a word as a session that could not be resumed', async () => {
    const rig = await startRig({
      plans: [{ dieEarly: 'end' }, replay(init(OTHER_SESSION), success('ok'))],
      start: { sessionId: SESSION }
    })

    await rig.adapter.send('hello again')

    expect(rig.items()).toEqual([expect.objectContaining({ kind: 'context_reset', reason: 'session_lost' })])
    expect(rig.sdk.launches[1]?.options).not.toHaveProperty('resume')
  })

  it('fails the turn when the new session cannot be started either', async () => {
    const sdk = fakeSdk([{ dieEarly: new Error('gone') }])
    let attempts = 0
    const factory: ClaudeQueryFactory = (params) => {
      attempts += 1
      if (attempts === 2) {
        throw new Error('spawn EPERM')
      }
      return sdk.query(params)
    }
    const rig = await startRig({ deps: { query: factory }, start: { sessionId: SESSION } })

    await expect(rig.adapter.send('hello')).rejects.toThrow('spawn EPERM')

    await expect(rig.adapter.send('again')).rejects.toThrow()
  })

  it('does not retry forever: a second failure is the turn failing', async () => {
    const rig = await startRig({
      plans: [{ dieEarly: new Error('gone') }, { dieEarly: new Error('still gone') }],
      start: { sessionId: SESSION }
    })

    await expect(rig.adapter.send('hello')).rejects.toThrow('still gone')

    expect(rig.sdk.launches).toHaveLength(2)
    expect(rig.items().filter((item) => item.kind === 'context_reset')).toHaveLength(1)
  })

  it('does not call a failure to start the executable a lost session', async () => {
    const rig = await startRig({
      plans: [{ dieEarly: new Error('Claude Code native binary at /bin/claude exists but failed to launch.') }],
      start: { sessionId: SESSION }
    })

    await expect(rig.adapter.send('hello')).rejects.toThrow('failed to launch')

    expect(rig.sdk.launches).toHaveLength(1)
    expect(rig.items()).toEqual([])
  })
})

describe('Claude adapter: session and context (3)', () => {
  it('does not blame the session when a new one fails to start', async () => {
    const rig = await startRig({ plans: [{ dieEarly: new Error('boom') }] })

    await expect(rig.adapter.send('hello')).rejects.toThrow('boom')

    expect(rig.items()).toEqual([])
  })

  it('does not blame the session for a failure after the CLI has started talking', async () => {
    const rig = await startRig({
      plans: [{ script: ({ emit }) => emit(init()) }],
      start: { sessionId: SESSION }
    })
    const turn = rig.adapter.send('hi')
    await vi.waitFor(() => expect(rig.events).toHaveLength(1))

    rig.sdk.launches[0]?.finish(new Error('network down'))

    await expect(turn).rejects.toThrow('network down')
    expect(rig.sdk.launches).toHaveLength(1)
  })

  it('adds what the process printed to the reason it records for the lost session', async () => {
    const rig = await startRig({
      plans: [{ dieEarly: 'end' }, replay(init(OTHER_SESSION), success('ok'))],
      start: { sessionId: SESSION },
      stderr: 'No conversation found with session ID\n'
    })

    await rig.adapter.send('hello again')

    expect(rig.items()[0]).toMatchObject({ kind: 'context_reset', message: expect.stringContaining('No conversation found with session ID') })
  })
})

// ---- c4: models ----

describe('Claude adapter: models (1)', () => {
  it('lists the models the SDK reports and shuts down the helper process', async () => {
    const rig = await startRig({ plans: [{ models: INFOS }] })

    const models = await rig.adapter.listModels()

    expect(models).toEqual(EXPECTED)
    expect(rig.sdk.launches[0]?.closed).toBe(true)
    expect(rig.sdk.launches[0]?.options).toMatchObject({
      pathToClaudeCodeExecutable: EXECUTABLE,
      persistSession: false,
      settingSources: [],
      strictMcpConfig: true
    })
    expect(rig.sdk.launches[0]?.options.spawnClaudeCodeProcess).toBe(rig.created[1]?.spawn)
    expect(rig.created.map((processes) => processes.killed)).toEqual([0, 1])
    expect(rig.sdk.log).toEqual(['killAll', 'close'])
  })

  it('asks the running process when there is one, instead of starting another', async () => {
    const rig = await startRig({ plans: [{ models: INFOS, script: ({ emit }) => emit(init(), success('ok')) }] })
    await rig.adapter.send('hi')

    const models = await rig.adapter.listModels()

    expect(models).toEqual(EXPECTED)
    expect(rig.sdk.launches).toHaveLength(1)
    expect(rig.sdk.launches[0]?.closed).toBe(false)
  })

  it('falls back to the curated list when the running process cannot say, or says nothing', async () => {
    const failing = await startRig({ plans: [{ modelsError: new Error('no'), script: ({ emit }) => emit(init(), success('ok')) }] })
    await failing.adapter.send('hi')
    expect(await failing.adapter.listModels()).toEqual(CURATED_CLAUDE_MODELS)

    const empty = await startRig({ plans: [{ models: [], script: ({ emit }) => emit(init(), success('ok')) }] })
    await empty.adapter.send('hi')
    expect(await empty.adapter.listModels()).toEqual(CURATED_CLAUDE_MODELS)
  })

  it('labels a model by its id when the SDK gives it no name, and skips one with no id', async () => {
    const rig = await startRig({
      plans: [{ models: [{ value: 'opus', displayName: '', description: '' }, { value: '', displayName: 'Nameless', description: '' }] }]
    })

    expect(await rig.adapter.listModels()).toEqual([{ id: 'opus', label: 'opus' }])
  })

  it('falls back when the SDK fails with something that is not an Error', async () => {
    const rig = await startRig({ plans: [{ modelsError: 'nope' as unknown as Error }] })

    expect(await rig.adapter.listModels()).toEqual(CURATED_CLAUDE_MODELS)
  })
})

describe('Claude adapter: models (2)', () => {
  it('offers the definition the same list without a chat', async () => {
    const sdk = fakeSdk([{ models: INFOS }])
    const definition = createClaudeAdapterDefinition({ query: sdk.query, createProcesses: () => fakeProcesses(sdk.log), platform: 'linux' })

    expect(await definition.listModels(EXECUTABLE)).toEqual(EXPECTED)
    expect(sdk.launches[0]?.options.pathToClaudeCodeExecutable).toBe(EXECUTABLE)
  })

  it('remembers the list for a while so the picker does not start a process every time', async () => {
    let now = 0
    const sdk = fakeSdk([{ models: INFOS }])
    const definition = createClaudeAdapterDefinition({
      query: sdk.query,
      createProcesses: () => fakeProcesses(sdk.log),
      platform: 'linux',
      clock: () => now
    })

    await definition.listModels(EXECUTABLE)
    now += 60_000
    await definition.listModels(EXECUTABLE)
    expect(sdk.launches).toHaveLength(1)

    now += 60 * 60_000
    await definition.listModels(EXECUTABLE)
    expect(sdk.launches).toHaveLength(2)
  })

  it('does not remember a fallback list', async () => {
    const sdk = fakeSdk([{ modelsError: new Error('not signed in') }, { models: INFOS }])
    const definition = createClaudeAdapterDefinition({
      query: sdk.query,
      createProcesses: () => fakeProcesses(sdk.log),
      platform: 'linux',
      clock: () => 0
    })

    expect(await definition.listModels(EXECUTABLE)).toEqual(CURATED_CLAUDE_MODELS)
    expect(await definition.listModels(EXECUTABLE)).toEqual(EXPECTED)
  })
})

describe('Claude adapter: models (3)', () => {
  it('falls back to the curated list when the executable cannot be run at all', async () => {
    const sdk = fakeSdk([{ models: INFOS }])
    const definition = createClaudeAdapterDefinition({
      query: sdk.query,
      createProcesses: () => fakeProcesses(sdk.log),
      platform: 'win32',
      readFile: () => 'nothing'
    })

    expect(await definition.listModels('C:\\npm\\claude.cmd')).toEqual(CURATED_CLAUDE_MODELS)
    expect(sdk.launches).toHaveLength(0)
  })

  it('falls back to a curated list when the SDK reports nothing, fails, or cannot start', async () => {
    const empty = await startRig({ plans: [{ models: [] }] })
    expect(await empty.adapter.listModels()).toEqual(CURATED_CLAUDE_MODELS)

    const failing = await startRig({ plans: [{ modelsError: new Error('nope') }] })
    expect(await failing.adapter.listModels()).toEqual(CURATED_CLAUDE_MODELS)
    expect(failing.sdk.launches[0]?.closed).toBe(true)

    const broken = await startRig({ deps: { query: () => { throw new Error('spawn failed') } } })
    expect(await broken.adapter.listModels()).toEqual(CURATED_CLAUDE_MODELS)
  })

  it('falls back to the curated list when asking takes too long', async () => {
    vi.useFakeTimers()
    const hung: ClaudeQueryFactory = ({ prompt, options }) => {
      const query = new FakeQuery(options, {}, prompt, [])
      query.supportedModels = () => new Promise(() => {})
      return query
    }
    const rig = await startRig({ deps: { query: hung, modelTimeoutMs: 5000 } })

    const models = rig.adapter.listModels()
    await vi.advanceTimersByTimeAsync(5000)

    expect(await models).toEqual(CURATED_CLAUDE_MODELS)
  })

  it('curates models a person can pick with free entry still available', () => {
    expect(CURATED_CLAUDE_MODELS.map((model) => model.id)).toEqual(['default', 'opus', 'sonnet', 'haiku'])
  })
})

describe('Claude adapter: models (4)', () => {
  it('applies a model change from the next turn, not the one running', async () => {
    const rig = await startRig({
      plans: [
        {
          script: ({ emit, index }) => emit(init(), success(`turn ${index}`))
        }
      ]
    })
    await rig.adapter.send('first')

    await rig.adapter.setModel('claude-opus-4-8')
    expect(rig.sdk.launches[0]?.modelCalls).toEqual([])

    await rig.adapter.send('second')

    expect(rig.sdk.launches[0]?.modelCalls).toEqual(['claude-opus-4-8'])
    expect(rig.sdk.log.indexOf('setModel:claude-opus-4-8')).toBeLessThan(rig.sdk.log.indexOf('user:second'))
    expect(rig.sdk.log.indexOf('user:first')).toBeLessThan(rig.sdk.log.indexOf('setModel:claude-opus-4-8'))
  })

  it('does not change the model of a turn that is running', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init()) }] })
    void rig.adapter.send('first')
    await vi.waitFor(() => expect(rig.events).toHaveLength(1))

    await rig.adapter.setModel('haiku')

    expect(rig.sdk.launches[0]?.modelCalls).toEqual([])
  })

  it('asks for the model only once, however many turns follow', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init(), success('ok')) }] })
    await rig.adapter.send('one')
    await rig.adapter.setModel('haiku')

    await rig.adapter.send('two')
    await rig.adapter.send('three')

    expect(rig.sdk.launches[0]?.modelCalls).toEqual(['haiku'])
  })

  it('goes back to the CLI default when the default is picked', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init(), success('ok')) }], start: { model: 'opus' } })
    await rig.adapter.send('one')
    await rig.adapter.setModel('default')

    await rig.adapter.send('two')

    expect(rig.sdk.launches[0]?.modelCalls).toEqual([undefined])
  })
})

describe('Claude adapter: models (5)', () => {
  it('starts the next process on the model chosen before it exists', async () => {
    const rig = await startRig({ plans: [replay(init(), success('ok'))] })
    await rig.adapter.setModel('claude-opus-4-8')

    await rig.adapter.send('hi')

    expect(rig.sdk.launches[0]?.options.model).toBe('claude-opus-4-8')
    expect(rig.sdk.launches[0]?.modelCalls).toEqual([])
  })

  it('does not ask a process that has not started to switch', async () => {
    const rig = await startRig({ plans: [replay(init(), success('ok'))] })

    await rig.adapter.setModel('haiku')

    expect(rig.sdk.launches).toHaveLength(0)
  })
})

// ---- Lifecycle ----

describe('Claude adapter: dispose (1)', () => {
  it('kills the process tree before closing the query, and sends no more events', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init()) }] })
    const turn = rig.adapter.send('hi')
    await vi.waitFor(() => expect(rig.events).toHaveLength(1))

    await rig.adapter.dispose()
    rig.sdk.launches[0]?.emit(assistant('msg_late', [text('too late')]))
    await expect(turn).rejects.toThrow(/shut down/)

    expect(rig.sdk.log.filter((entry) => entry === 'killAll' || entry === 'close')).toEqual(['killAll', 'close'])
    expect(rig.events).toHaveLength(1)
  })

  it('drops messages that were already on their way when it was disposed', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init()) }] })
    const turn = rig.adapter.send('hi')
    await vi.waitFor(() => expect(rig.events).toHaveLength(1))

    rig.sdk.launches[0]?.emit(assistant('msg_a', [text('one')]), assistant('msg_b', [text('two')]))
    const disposed = rig.adapter.dispose()
    await expect(turn).rejects.toThrow(/shut down/)
    await disposed

    expect(rig.events).toHaveLength(1)
  })

  it('denies approvals that are still waiting', async () => {
    const outcomes: PermissionResult[] = []
    const rig = await startRig({ plans: [{ script: async ({ ask }) => void outcomes.push(await ask('Bash', { command: 'ls' })) }] })
    void rig.adapter.send('go').catch(() => {})
    await pendingApproval(rig)

    await rig.adapter.dispose()

    await vi.waitFor(() => expect(outcomes).toHaveLength(1))
    expect(outcomes[0]?.behavior).toBe('deny')
  })

  it('refuses messages afterwards, and can be disposed twice', async () => {
    const rig = await startRig({ plans: [replay(init(), success('ok'))] })

    await rig.adapter.dispose()
    await rig.adapter.dispose()

    await expect(rig.adapter.send('hi')).rejects.toThrow(/shut down/)
    expect(rig.processes.killed).toBe(1)
  })

  it('refuses messages before it has been started', async () => {
    const adapter = createClaudeAdapter(EXECUTABLE, { query: fakeSdk().query })

    await expect(adapter.send('hi')).rejects.toThrow(/not been started/)
  })
})

describe('Claude adapter: dispose (2)', () => {
  it('closes a query that finished starting after the adapter was disposed', async () => {
    const sdk = fakeSdk([replay(init(), success('ok'))])
    let release: () => void = () => {}
    const slow: ClaudeQueryFactory = async (params) => {
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return sdk.query(params)
    }
    const rig = await startRig({ deps: { query: slow } })

    const turn = rig.adapter.send('hi')
    await rig.adapter.dispose()
    release()

    await expect(turn).rejects.toThrow(/shut down/)
    await vi.waitFor(() => expect(sdk.launches[0]?.closed).toBe(true))
    expect(rig.processes.killed).toBe(2)
  })

  it('still kills what it started when no query was ever made', async () => {
    const rig = await startRig()

    await rig.adapter.dispose()

    expect(rig.processes.killed).toBe(1)
    expect(rig.sdk.launches).toHaveLength(0)
  })
})

// ---- The definition and the real SDK ----

describe('Claude adapter definition', () => {
  it('is a Claude adapter that starts on the first message', () => {
    const adapter = claudeAdapterDefinition.create(EXECUTABLE)

    expect(claudeAdapterDefinition.startOnOpen).toBe(false)
    expect(adapter.kind).toBe('claude')
  })

  it('loads the SDK only when a chat first needs it, and runs it on the connected executable', async () => {
    useSdkMock(init(), success('ok'))
    const adapter = createClaudeAdapter(EXECUTABLE, { createProcesses: () => fakeProcesses([]), platform: 'linux' })
    await adapter.start(START, () => {})
    expect(sdkMock.query).not.toHaveBeenCalled()

    await adapter.send('hi')

    expect(sdkMock.query).toHaveBeenCalledTimes(1)
    expect(sdkMock.query.mock.calls[0]?.[0].options).toMatchObject({ pathToClaudeCodeExecutable: EXECUTABLE, cwd: FOLDER })
  })

  it('stamps the items it makes itself with the real clock and a fresh id', async () => {
    useSdkMock(init(), assistant('msg_t', [text('hi')]), success('ok'))
    const events: ChatAdapterEvent[] = []
    const adapter = createClaudeAdapter(EXECUTABLE, { createProcesses: () => fakeProcesses([]), platform: 'linux' })
    await adapter.start({ ...START, sessionId: SESSION }, (event) => events.push(event))
    sdkMock.query.mockImplementationOnce(
      ({ prompt, options }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => new FakeQuery(options, { dieEarly: 'end' }, prompt, [])
    )

    await adapter.send('hi')

    const reset = events.find((event) => event.type === 'item' && event.item.kind === 'context_reset')
    expect(reset?.type === 'item' && Number.isNaN(Date.parse(reset.item.at))).toBe(false)
    expect(reset?.type === 'item' && reset.item.id).toMatch(/^claude_reset_/)
  })
})
