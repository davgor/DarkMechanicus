import { describe, expect, it, vi } from 'vitest'
import type {
  ApprovalDecision,
  ApprovalRequestItem,
  ChatAdapter,
  ChatAdapterEvent,
  ChatAdapterStartOptions,
  ChatItem
} from '../../../shared/agents/chat'
import type { ProcessOutcome, ProcessRunner } from '../../desktop/agentProbe'
import {
  askToRun,
  cancelled,
  CLIENT_VERSION,
  DM_SERVER,
  failedLoad,
  FOLDER,
  ACP_DM_SERVER,
  handshake,
  loadSession,
  newSession,
  prompt,
  say,
  selected,
  turnEnd,
  update
} from '../__mocks__/cursorRecordings'
import { agent, client, ReplayAcpAgents, type Frame } from '../__mocks__/replayAcpAgent'
import { CHAT_ADAPTERS } from '../adapterRegistry'
import { createCursorAdapter, cursorAdapterDefinition, listCursorModels, type CursorDeps } from './cursor'

const AT = '2026-01-01T00:00:00.000Z'
const S = 'sess_1'
const PATH = '/opt/cursor/agent'

interface Timers {
  scheduled: { callback: () => void; ms: number; cleared: boolean }[]
}

function makeDeps(agents: ReplayAcpAgents, timers: Timers, overrides: Partial<CursorDeps> = {}): CursorDeps {
  let count = 0
  return {
    platform: 'linux',
    inspect: () => 'ok',
    transport: agents.factory,
    run: () => Promise.reject(new Error('no process runner in this test')),
    newId: () => `id_${++count}`,
    now: () => AT,
    timers: {
      set: (callback, ms) => {
        const entry = { callback, ms, cleared: false }
        timers.scheduled.push(entry)
        return entry
      },
      clear: (handle) => {
        ;(handle as { cleared: boolean }).cleared = true
      }
    },
    cancelGraceMs: 7_000,
    clientVersion: CLIENT_VERSION,
    ...overrides
  }
}

function startOptions(overrides: Partial<ChatAdapterStartOptions> = {}): ChatAdapterStartOptions {
  return {
    chatId: 'chat_1',
    folder: FOLDER,
    model: null,
    role: 'planner',
    allowSave: false,
    sessionId: null,
    darkMechanicus: DM_SERVER,
    ...overrides
  }
}

class Rig {
  readonly events: ChatAdapterEvent[] = []
  readonly timers: Timers = { scheduled: [] }
  readonly adapter: ChatAdapter

  constructor(
    readonly agents: ReplayAcpAgents,
    overrides: Partial<CursorDeps> = {}
  ) {
    this.adapter = createCursorAdapter(PATH, makeDeps(agents, this.timers, overrides))
  }

  start(overrides: Partial<ChatAdapterStartOptions> = {}): Promise<void> {
    return this.adapter.start(startOptions(overrides), (event) => this.events.push(event))
  }

  get items(): ChatItem[] {
    return this.events.flatMap((event) => (event.type === 'item' ? [event.item] : []))
  }

  get approvals(): { request: ApprovalRequestItem; respond: (decision: ApprovalDecision) => void }[] {
    return this.events.flatMap((event) => (event.type === 'approval_request' ? [event] : []))
  }

  async approval(index = 0): Promise<{ request: ApprovalRequestItem; respond: (decision: ApprovalDecision) => void }> {
    await vi.waitFor(() => expect(this.approvals.length).toBeGreaterThan(index), { interval: 1 })
    return this.approvals[index] as { request: ApprovalRequestItem; respond: (decision: ApprovalDecision) => void }
  }

  /** The recording was followed to the letter. */
  expectReplayed(): void {
    expect(this.agents.problems).toEqual([])
    expect(this.agents.finished()).toBe(true)
  }
}

/** Resolves once the client has written a prompt to the first process. */
async function promptWritten(agents: ReplayAcpAgents): Promise<void> {
  await vi.waitFor(() => expect(agents.processes[0]?.writes.some((line) => line.includes('"session/prompt"'))).toBe(true), { interval: 1 })
}

/** A recording that starts a new session and ends with `rest`. */
function newChat(...rest: Frame[]): Frame[] {
  return [...handshake(), ...newSession(3, S), ...rest]
}

/** A turn that stops to ask permission, the person answers, and the agent carries on. */
function approvalTurn(optionId: string, toolStatus: string): Frame[] {
  return newChat(
    prompt(4, S, 'clean up'),
    update(S, { sessionUpdate: 'tool_call', toolCallId: 'call_2', title: 'Run `rm -rf build`', kind: 'execute', status: 'pending' }),
    askToRun(S, 7, 'call_2', 'rm -rf build'),
    selected(7, optionId),
    update(S, { sessionUpdate: 'tool_call_update', toolCallId: 'call_2', status: toolStatus }),
    turnEnd(4)
  )
}

describe('starting a session', () => {
  it('runs `agent acp` in the folder, initializes, signs in with the stored login and opens a session with the Dark Mechanicus server', async () => {
    const rig = new Rig(new ReplayAcpAgents(newChat()))

    await rig.start()

    rig.expectReplayed()
    expect(rig.agents.launches).toEqual([{ launch: { file: PATH, args: ['acp'], verbatimArguments: false }, cwd: FOLDER }])
    expect(rig.events).toEqual([{ type: 'session', sessionId: S }])
  })

  it('starts with the chat\'s model when it has one', async () => {
    const rig = new Rig(new ReplayAcpAgents(newChat()))

    await rig.start({ model: 'gpt-5.3-codex' })

    expect(rig.agents.launches[0]?.launch.args).toEqual(['--model', 'gpt-5.3-codex', 'acp'])
  })

  it('refuses a model id that cannot be launched safely, without starting a process', async () => {
    const rig = new Rig(new ReplayAcpAgents())

    await expect(rig.start({ model: 'x" & calc & "' })).rejects.toThrow(/model/i)

    expect(rig.agents.launches).toEqual([])
  })

  it('reports why when the executable will not start', async () => {
    const rig = new Rig(new ReplayAcpAgents(), { inspect: () => 'not_a_file' })

    await expect(rig.start()).rejects.toThrow('That is not a file.')
  })

  // An agent that refuses the sign-in is not a failure to start: see cursorAuth.test.ts.
  it('stops the process and fails when the agent answers without a session', async () => {

    const noSession = new ReplayAcpAgents([
      ...handshake(),
      client({ id: 3, method: 'session/new', params: { cwd: FOLDER, mcpServers: [ACP_DM_SERVER] } }),
      agent({ id: 3, result: {} })
    ])
    const other = new Rig(noSession)
    await expect(other.start()).rejects.toThrow()
    expect(noSession.processes[0]?.killed).toBe(true)
  })

  it('carries on when a newer Cursor no longer has the authenticate method', async () => {
    const frames = [
      ...handshake().slice(0, 3),
      agent({ id: 2, error: { code: -32601, message: 'Method not found' } }),
      ...newSession(3, S)
    ]
    const rig = new Rig(new ReplayAcpAgents(frames))

    await rig.start()

    rig.expectReplayed()
    expect(rig.events).toEqual([{ type: 'session', sessionId: S }])
    expect(rig.agents.processes[0]?.writes.some((line) => line.includes('"authenticate"'))).toBe(true)
  })
})

describe('a turn', () => {
  it('replays a recorded exchange into the transcript items, streaming the text and following the tool call', async () => {
    const rig = new Rig(
      new ReplayAcpAgents(
        newChat(
          prompt(4, S, 'List the files'),
          update(S, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Let me look.' } }),
          say(S, "I'll check "),
          say(S, 'the folder.'),
          update(S, {
            sessionUpdate: 'tool_call',
            toolCallId: 'call_1',
            title: 'Run `ls`',
            kind: 'execute',
            status: 'pending',
            rawInput: { command: 'ls' }
          }),
          update(S, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'in_progress' }),
          update(S, {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call_1',
            status: 'completed',
            content: [{ type: 'content', content: { type: 'text', text: 'a.txt\nb.txt' } }]
          }),
          say(S, 'Found two files.'),
          turnEnd(4)
        )
      )
    )
    await rig.start()

    await rig.adapter.send('List the files')

    rig.expectReplayed()
    const tool = { id: `tool_${S}_call_1`, at: AT, kind: 'tool_call', name: 'Shell', input: { command: 'ls' } }
    expect(rig.events).toEqual([
      { type: 'session', sessionId: S },
      { type: 'assistant_delta', itemId: 'id_1', delta: "I'll check " },
      { type: 'assistant_delta', itemId: 'id_1', delta: 'the folder.' },
      { type: 'item', item: { id: 'id_1', at: AT, kind: 'assistant_text', text: "I'll check the folder." } },
      { type: 'item', item: { ...tool, status: 'running', resultSummary: null } },
      { type: 'item', item: { ...tool, status: 'completed', resultSummary: 'a.txt\nb.txt' } },
      { type: 'assistant_delta', itemId: 'id_2', delta: 'Found two files.' },
      { type: 'item', item: { id: 'id_2', at: AT, kind: 'assistant_text', text: 'Found two files.' } }
    ])
  })
})

describe('turns in sequence and turns that end badly', () => {
  it('runs one turn after another on the same session', async () => {
    const rig = new Rig(new ReplayAcpAgents(newChat(prompt(4, S, 'one'), say(S, 'first'), turnEnd(4), prompt(5, S, 'two'), say(S, 'second'), turnEnd(5))))
    await rig.start()

    await rig.adapter.send('one')
    await rig.adapter.send('two')

    rig.expectReplayed()
    expect(rig.items.map((item) => item.kind === 'assistant_text' && item.text)).toEqual(['first', 'second'])
  })

  it.each([
    ['max_tokens', /length limit/],
    ['max_turn_requests', /too many steps/],
    ['refusal', /declined/]
  ])('rejects the turn when the agent ends it with %s', async (stopReason, message) => {
    const rig = new Rig(new ReplayAcpAgents(newChat(prompt(4, S, 'x'), say(S, 'partial'), turnEnd(4, stopReason))))
    await rig.start()

    await expect(rig.adapter.send('x')).rejects.toThrow(message)

    expect(rig.items.map((item) => item.kind === 'assistant_text' && item.text)).toEqual(['partial'])
  })

  it('rejects the turn with the agent\'s own message when the prompt fails', async () => {
    const rig = new Rig(new ReplayAcpAgents(newChat(prompt(4, S, 'x'), agent({ id: 4, error: { code: -32603, message: 'Model not available' } }))))
    await rig.start()

    await expect(rig.adapter.send('x')).rejects.toThrow('Model not available')
  })

  it('refuses to send before the session has started', async () => {
    const rig = new Rig(new ReplayAcpAgents())

    await expect(rig.adapter.send('hello')).rejects.toThrow(/not started/i)
  })
})

describe('a turn the agent dies in', () => {
  it('rejects a turn the agent dies in, then restarts the process and resumes the session for the next one', async () => {
    const agents = new ReplayAcpAgents(
      newChat(prompt(4, S, 'one'), say(S, 'half an ans')),
      [...handshake(), ...loadSession(3, S), prompt(4, S, 'two'), say(S, 'back'), turnEnd(4)]
    )
    const rig = new Rig(agents)
    await rig.start()

    const failed = rig.adapter.send('one')
    await vi.waitFor(() => expect(rig.events.some((event) => event.type === 'assistant_delta')).toBe(true), { interval: 1 })
    agents.processes[0]?.exit('exit code 1: out of memory')
    await expect(failed).rejects.toThrow('out of memory')
    await rig.adapter.send('two')

    rig.expectReplayed()
    expect(agents.launches).toHaveLength(2)
    expect(rig.items.some((item) => item.kind === 'context_reset')).toBe(false)
  })
})

describe('approvals: the three decisions', () => {
  it.each([
    ['allow_once', 'allow-once', 'completed'],
    ['allow_chat', 'allow-always', 'completed'],
    ['deny', 'reject-once', 'failed']
  ] as const)('answers a permission request with %s as option %s, and the agent carries on', async (decision, optionId, toolStatus) => {
    const rig = new Rig(new ReplayAcpAgents(approvalTurn(optionId, toolStatus)))
    await rig.start()

    const turn = rig.adapter.send('clean up')
    const { request, respond } = await rig.approval()
    respond(decision)
    await turn

    rig.expectReplayed()
    expect(request).toMatchObject({
      kind: 'approval_request',
      category: 'command',
      tool: 'Shell',
      summary: 'Run `rm -rf build`',
      input: { command: 'rm -rf build' }
    })
    expect(request.requestId).not.toBe('')
  })
})

describe('approvals: refused and repeated answers', () => {
  it('shows a refused call as denied', async () => {
    const rig = new Rig(new ReplayAcpAgents(approvalTurn('reject-once', 'failed')))
    await rig.start()

    const turn = rig.adapter.send('clean up')
    ;(await rig.approval()).respond('deny')
    await turn

    const statuses = rig.items.flatMap((item) => (item.kind === 'tool_call' ? [item.status] : []))
    expect(statuses).toEqual(['running', 'denied'])
  })

  it('answers each request exactly once, however often the decision is given', async () => {
    const rig = new Rig(new ReplayAcpAgents(approvalTurn('allow-once', 'completed')))
    await rig.start()

    const turn = rig.adapter.send('clean up')
    const { respond } = await rig.approval()
    respond('allow_once')
    respond('deny')
    respond('allow_chat')
    await turn

    rig.expectReplayed()
    const answers = rig.agents.processes[0]?.writes.filter((line) => line.includes('"id":7')) ?? []
    expect(answers).toHaveLength(1)
    expect(JSON.parse(answers[0] ?? '{}').result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  })
})

describe('approvals: several requests and missing details', () => {
  it('files an edit under file edits and answers several waiting requests independently', async () => {
    const edit = agent({
      id: 8,
      method: 'session/request_permission',
      params: {
        sessionId: S,
        toolCall: { toolCallId: 'call_3', title: 'Edit src/a.ts', kind: 'edit', status: 'pending', rawInput: { path: 'src/a.ts' } },
        options: [
          { optionId: 'allow-once', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
        ]
      }
    })
    const rig = new Rig(
      new ReplayAcpAgents(newChat(prompt(4, S, 'go'), askToRun(S, 7, 'call_2', 'ls'), edit, selected(8, 'reject-once'), selected(7, 'allow-once'), turnEnd(4)))
    )
    await rig.start()

    const turn = rig.adapter.send('go')
    const second = await rig.approval(1)
    const first = await rig.approval(0)
    second.respond('deny')
    first.respond('allow_once')
    await turn

    rig.expectReplayed()
    expect(second.request).toMatchObject({ category: 'file_edit', tool: 'Edit' })
    expect(first.request.requestId).not.toBe(second.request.requestId)
  })

  it('never turns the answer into something the agent did not offer', async () => {
    const onlyAllow = agent({
      id: 7,
      method: 'session/request_permission',
      params: { sessionId: S, toolCall: { toolCallId: 'c', title: 'Run', kind: 'execute' }, options: [{ optionId: 'ok', name: 'OK', kind: 'allow_once' }] }
    })
    const rig = new Rig(new ReplayAcpAgents(newChat(prompt(4, S, 'go'), onlyAllow, cancelled(7), turnEnd(4))))
    await rig.start()

    const turn = rig.adapter.send('go')
    ;(await rig.approval()).respond('deny')
    await turn

    rig.expectReplayed()
    const answer = rig.agents.processes[0]?.writes.find((line) => line.includes('"id":7')) ?? '{}'
    expect(JSON.parse(answer).result).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})

describe('approvals: requests Cursor adds to ACP', () => {
  it('still asks, and answers, when the request names no tool call and no options', async () => {
    const bare = agent({ id: 7, method: 'session/request_permission', params: { sessionId: S } })
    const rig = new Rig(new ReplayAcpAgents(newChat(prompt(4, S, 'go'), bare, selected(7, 'allow-once'), turnEnd(4))))
    await rig.start()

    const turn = rig.adapter.send('go')
    const { request, respond } = await rig.approval()
    respond('allow_once')
    await turn

    rig.expectReplayed()
    expect(request).toMatchObject({ category: 'other', tool: 'tool', summary: 'Cursor asks to use a tool' })
  })

  it('answers the requests Cursor adds on top of ACP so that the turn is never left waiting', async () => {
    const rig = new Rig(
      new ReplayAcpAgents(
        newChat(
          prompt(4, S, 'plan it'),
          agent({ id: 11, method: 'cursor/ask_question', params: { toolCallId: 'q', title: 'Need input', questions: [{ id: 'q1', prompt: 'Which mode?', options: [] }] } }),
          client({ id: 11, result: { outcome: { outcome: 'cancelled' } } }),
          agent({ id: 12, method: 'cursor/create_plan', params: { toolCallId: 'p', name: 'Plan', plan: '1. Do it', todos: [] } }),
          client({ id: 12, result: { outcome: { outcome: 'cancelled' } } }),
          agent({ id: 13, method: 'cursor/update_todos', params: { toolCallId: 't', todos: [{ id: '1', content: 'x', status: 'pending' }], merge: true } }),
          client({ id: 13, result: { outcome: { outcome: 'accepted', todos: [{ id: '1', content: 'x', status: 'pending' }] } } }),
          agent({ id: 14, method: 'cursor/task', params: { toolCallId: 'k', description: 'Explore', prompt: 'find', subagentType: 'explore' } }),
          client({ id: 14, result: { outcome: { outcome: 'completed' } } }),
          agent({ id: 15, method: 'fs/read_text_file', params: { path: '/x' } }),
          client({ id: 15, error: { code: -32601, message: 'Method not supported: fs/read_text_file' } }),
          turnEnd(4)
        )
      )
    )
    await rig.start()

    await rig.adapter.send('plan it')

    rig.expectReplayed()
    const errors = rig.items.flatMap((item) => (item.kind === 'error' ? [item] : []))
    expect(errors.map((item) => item.code)).toEqual(['cursor_question', 'cursor_plan'])
    expect(errors[0]?.message).toContain('Which mode?')
  })
})

describe('stopping', () => {
  it('cancels the turn, answers a waiting request as cancelled and settles the turn when the agent says it was cancelled', async () => {
    const rig = new Rig(
      new ReplayAcpAgents(
        newChat(
          prompt(4, S, 'go'),
          askToRun(S, 7, 'call_2', 'sleep 100'),
          client({ method: 'session/cancel', params: { sessionId: S } }),
          cancelled(7),
          turnEnd(4, 'cancelled')
        )
      )
    )
    await rig.start()

    const turn = rig.adapter.send('go')
    const { respond } = await rig.approval()
    await rig.adapter.stop()
    respond('deny')
    await turn

    rig.expectReplayed()
    expect(rig.timers.scheduled.every((timer) => timer.cleared)).toBe(true)
  })

  it('does nothing when no turn is running', async () => {
    const rig = new Rig(new ReplayAcpAgents(newChat()))
    await rig.start()

    await rig.adapter.stop()

    rig.expectReplayed()
    expect(rig.events).toEqual([{ type: 'session', sessionId: S }])
    expect(rig.agents.processes[0]?.writes.some((line) => line.includes('session/cancel'))).toBe(false)
  })
})

describe('stopping: an agent that ignores the cancel', () => {
  it('ends an agent that ignores the cancel after a grace period, settles the turn and resumes the session for the next one', async () => {
    const agents = new ReplayAcpAgents(
      newChat(prompt(4, S, 'go'), client({ method: 'session/cancel', params: { sessionId: S } })),
      [...handshake(), ...loadSession(3, S), prompt(4, S, 'again'), turnEnd(4)]
    )
    const rig = new Rig(agents)
    await rig.start()

    const turn = rig.adapter.send('go')
    await promptWritten(agents)
    await rig.adapter.stop()
    expect(rig.timers.scheduled.map((timer) => timer.ms)).toEqual([7_000])
    rig.timers.scheduled[0]?.callback()
    await turn
    await rig.adapter.send('again')

    rig.expectReplayed()
    expect(agents.processes[0]?.killed).toBe(true)
  })
})

describe('resuming', () => {
  it('loads the stored session instead of creating one, and keeps the replayed history out of the transcript', async () => {
    const history = [
      update(S, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } }),
      say(S, 'earlier answer'),
      update(S, { sessionUpdate: 'tool_call', toolCallId: 'old', title: 'Run `ls`', kind: 'execute', status: 'completed' })
    ]
    const rig = new Rig(new ReplayAcpAgents([...handshake(), ...loadSession(3, 'sess_old', history), prompt(4, 'sess_old', 'next'), say('sess_old', 'new answer'), turnEnd(4)]))

    await rig.start({ sessionId: 'sess_old' })
    await rig.adapter.send('next')

    rig.expectReplayed()
    expect(rig.events.some((event) => event.type === 'session')).toBe(false)
    expect(rig.items.map((item) => item.kind === 'assistant_text' && item.text)).toEqual(['new answer'])
  })

  it('starts a new session and says so when the stored one cannot be loaded', async () => {
    const rig = new Rig(new ReplayAcpAgents([...handshake(), ...failedLoad(3, 'sess_old'), ...newSession(4, 'sess_new')]))

    await rig.start({ sessionId: 'sess_old' })

    rig.expectReplayed()
    expect(rig.events).toEqual([
      {
        type: 'item',
        item: {
          id: 'id_1',
          at: AT,
          kind: 'context_reset',
          reason: 'session_lost',
          message: 'Cursor could not resume the earlier session (Session not found), so this chat continues in a new one without its history.'
        }
      },
      { type: 'session', sessionId: 'sess_new' }
    ])
  })
})

describe('resuming: without a stored session to load', () => {
  it('does not even try to load when Cursor says it cannot load sessions', async () => {
    const rig = new Rig(new ReplayAcpAgents([...handshake(false), ...newSession(3, 'sess_new')]))

    await rig.start({ sessionId: 'sess_old' })

    rig.expectReplayed()
    expect(rig.items).toMatchObject([{ kind: 'context_reset', reason: 'session_lost' }])
    expect(rig.events.at(-1)).toEqual({ type: 'session', sessionId: 'sess_new' })
  })

  it('fails the start, rather than faking a reset, when the process itself dies while loading', async () => {
    const agents = new ReplayAcpAgents([
      ...handshake(),
      client({ id: 3, method: 'session/load', params: { sessionId: 'sess_old', cwd: FOLDER, mcpServers: [ACP_DM_SERVER] } })
    ])
    const rig = new Rig(agents)

    const started = rig.start({ sessionId: 'sess_old' })
    await vi.waitFor(() => expect(agents.finished()).toBe(true), { interval: 1 })
    agents.processes[0]?.exit('exit code 2')

    await expect(started).rejects.toThrow('exit code 2')
    expect(rig.items).toEqual([])
  })
})

describe('models', () => {
  it('applies a model change from the next turn by restarting `agent --model <id> acp` on the same session', async () => {
    const agents = new ReplayAcpAgents(
      newChat(prompt(4, S, 'one'), turnEnd(4)),
      [...handshake(), ...loadSession(3, S), prompt(4, S, 'two'), turnEnd(4)]
    )
    const rig = new Rig(agents)
    await rig.start()
    await rig.adapter.send('one')

    await rig.adapter.setModel('gpt-5.3-codex')
    expect(agents.launches).toHaveLength(1)
    expect(agents.processes[0]?.killed).toBe(false)
    await rig.adapter.send('two')

    rig.expectReplayed()
    expect(agents.processes[0]?.killed).toBe(true)
    expect(agents.launches[1]).toEqual({
      launch: { file: PATH, args: ['--model', 'gpt-5.3-codex', 'acp'], verbatimArguments: false },
      cwd: FOLDER
    })
    expect(rig.items.some((item) => item.kind === 'context_reset')).toBe(false)
  })

  it('starts a new session with a context reset when the session cannot be loaded under the new model', async () => {
    const agents = new ReplayAcpAgents(newChat(), [...handshake(), ...failedLoad(3, S), ...newSession(4, 'sess_2'), prompt(5, 'sess_2', 'hi'), turnEnd(5)])
    const rig = new Rig(agents)
    await rig.start()

    await rig.adapter.setModel('composer-2.5')
    await rig.adapter.send('hi')

    rig.expectReplayed()
    expect(rig.items).toMatchObject([{ kind: 'context_reset', reason: 'model_change' }])
    expect(rig.events.filter((event) => event.type === 'session')).toEqual([
      { type: 'session', sessionId: S },
      { type: 'session', sessionId: 'sess_2' }
    ])
  })
})

describe('models: changing the model and its id', () => {
  it('does not restart for the model it already runs, nor for the one chosen back before the next turn', async () => {
    const agents = new ReplayAcpAgents(newChat(prompt(4, S, 'one'), turnEnd(4)))
    const rig = new Rig(agents)
    await rig.start({ model: 'auto' })
    await rig.adapter.setModel('auto')
    await rig.adapter.setModel('gpt-5.3-codex')
    await rig.adapter.setModel('auto')
    await rig.adapter.send('one')

    rig.expectReplayed()
    expect(agents.launches).toHaveLength(1)
  })

  it.each(['x" & calc & "', 'a&b', '%PATH%', '--yolo', ''])('rejects the model id %j and keeps the running one', async (model) => {
    const agents = new ReplayAcpAgents(newChat(prompt(4, S, 'one'), turnEnd(4)))
    const rig = new Rig(agents)
    await rig.start()

    await expect(rig.adapter.setModel(model)).rejects.toThrow(/model/i)
    await rig.adapter.send('one')

    rig.expectReplayed()
    expect(agents.launches).toHaveLength(1)
  })

  it('lists the models from `agent models`', async () => {
    const calls: string[][] = []
    const run: ProcessRunner = (launch) => {
      calls.push([...launch.args])
      return Promise.resolve<ProcessOutcome>({
        kind: 'exited',
        exitCode: 0,
        output: 'Available models\n\nauto - Auto\ncomposer-2.5 - Composer 2.5 (current)\n'
      })
    }
    const deps = makeDeps(new ReplayAcpAgents(), { scheduled: [] }, { run })

    const models = await listCursorModels(PATH, deps)

    expect(calls).toEqual([['models']])
    expect(models).toEqual([
      { id: 'auto', label: 'Auto' },
      { id: 'composer-2.5', label: 'Composer 2.5' }
    ])
  })
})

describe('models: listing', () => {
  it('falls back to `agent --list-models` when `agent models` lists nothing', async () => {
    const calls: string[][] = []
    const run: ProcessRunner = (launch) => {
      calls.push([...launch.args])
      const output = launch.args[0] === 'models' ? 'Loading...\n' : 'o3 - O3\n'
      return Promise.resolve<ProcessOutcome>({ kind: 'exited', exitCode: 0, output })
    }

    const models = await listCursorModels(PATH, makeDeps(new ReplayAcpAgents(), { scheduled: [] }, { run }))

    expect(calls).toEqual([['models'], ['--list-models']])
    expect(models).toEqual([{ id: 'o3', label: 'O3' }])
  })

  it.each([
    [{ kind: 'exited', exitCode: 1, output: 'Not signed in. Run `agent login`.\nMore detail' } as const, /Not signed in/],
    [{ kind: 'timed_out' } as const, /did not answer/],
    [{ kind: 'spawn_failed', code: 'ENOENT', message: 'nope' } as const, /could not be started/]
  ])('says why the models could not be listed: %j', async (outcome, message) => {
    const run: ProcessRunner = () => Promise.resolve(outcome)

    await expect(listCursorModels(PATH, makeDeps(new ReplayAcpAgents(), { scheduled: [] }, { run }))).rejects.toThrow(message)
  })

  it('lists the models through the adapter as well', async () => {
    const run: ProcessRunner = () => Promise.resolve<ProcessOutcome>({ kind: 'exited', exitCode: 0, output: 'o3 - O3' })
    const rig = new Rig(new ReplayAcpAgents(), { run })

    await expect(rig.adapter.listModels()).resolves.toEqual([{ id: 'o3', label: 'O3' }])
  })

  it('reports an executable the launch rules refuse', async () => {
    const deps = makeDeps(new ReplayAcpAgents(), { scheduled: [] }, { inspect: () => 'not_executable' })

    await expect(listCursorModels(PATH, deps)).rejects.toThrow('That file is not executable.')
  })
})

describe('ending the session', () => {
  it('kills the process (tree) and reports nothing after that', async () => {
    const agents = new ReplayAcpAgents(newChat(prompt(4, S, 'go')))
    const rig = new Rig(agents)
    await rig.start()
    const turn = rig.adapter.send('go').catch((error: unknown) => error)

    await promptWritten(agents)
    const seen = rig.events.length
    await rig.adapter.dispose()

    expect(agents.processes[0]?.killed).toBe(true)
    expect(await turn).toBeInstanceOf(Error)
    expect(rig.events).toHaveLength(seen)
    await expect(rig.adapter.send('more')).rejects.toThrow(/ended/i)
    await rig.adapter.dispose()
    expect(agents.launches).toHaveLength(1)
  })

  it('resolves dispose only once the process tree is gone, so quitting waits for it', async () => {
    const agents = new ReplayAcpAgents(newChat(prompt(4, S, 'go')))
    agents.holdKills = true
    const rig = new Rig(agents)
    await rig.start()
    void rig.adapter.send('go').catch(() => {})
    await promptWritten(agents)
    let disposed = false

    const disposing = rig.adapter.dispose().then(() => {
      disposed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(agents.processes[0]?.killed).toBe(true)
    expect(disposed).toBe(false)
    agents.processes[0]?.releaseKill?.()
    await disposing

    expect(disposed).toBe(true)
  })

  it('is safe to dispose before it ever started', async () => {
    const rig = new Rig(new ReplayAcpAgents())

    await expect(rig.adapter.dispose()).resolves.toBeUndefined()
  })

  it('is disposed while still starting without leaving a process behind', async () => {
    const agents = new ReplayAcpAgents(handshake().slice(0, 1))
    const rig = new Rig(agents)

    const started = rig.start().catch((error: unknown) => error)
    await vi.waitFor(() => expect(agents.processes).toHaveLength(1), { interval: 1 })
    await rig.adapter.dispose()

    expect(await started).toBeInstanceOf(Error)
    expect(agents.processes[0]?.killed).toBe(true)
  })
})

describe('approvals that cannot reach the person', () => {
  it('still answers the agent when handing the request on fails', async () => {
    const agents = new ReplayAcpAgents(newChat(prompt(4, S, 'go'), askToRun(S, 7, 'call_2', 'ls'), cancelled(7), turnEnd(4)))
    const rig = new Rig(agents)
    await rig.adapter.start(startOptions(), (event) => {
      if (event.type === 'approval_request') {
        throw new Error('the store refused it')
      }
      rig.events.push(event)
    })

    await rig.adapter.send('go')

    rig.expectReplayed()
    expect(rig.events.some((event) => event.type === 'approval_request')).toBe(false)
    const answer = agents.processes[0]?.writes.find((line) => line.includes('"id":7')) ?? '{}'
    expect(JSON.parse(answer).result).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})

describe('the registry entry', () => {
  it('registers Cursor chats to start on the first message, with the adapter and the model list', () => {
    expect(CHAT_ADAPTERS.cursor).toBe(cursorAdapterDefinition)
    expect(cursorAdapterDefinition.startOnOpen).toBe(false)
    const adapter = cursorAdapterDefinition.create(PATH)
    expect(adapter.kind).toBe('cursor')
    expect(typeof cursorAdapterDefinition.listModels).toBe('function')
  })
})

// ---- Requests and answers with details missing ----

describe('Cursor extensions with details missing', () => {
  it('names a question it cannot read as a question, and still answers it as cancelled', async () => {
    const asked = (id: number, params: Record<string, unknown>): Frame[] => [
      agent({ id, method: 'cursor/ask_question', params }),
      client({ id, result: { outcome: { outcome: 'cancelled' } } })
    ]
    const rig = new Rig(
      new ReplayAcpAgents(
        newChat(
          prompt(4, S, 'go'),
          ...asked(11, { toolCallId: 'q' }),
          ...asked(12, { toolCallId: 'q', questions: [{ id: 'q1' }, 'junk', { id: 'q2', prompt: 7 }] }),
          ...asked(13, { toolCallId: 'q', questions: [{ prompt: 'One?' }, { prompt: 'Two?' }] }),
          turnEnd(4)
        )
      )
    )
    await rig.start()

    await rig.adapter.send('go')

    rig.expectReplayed()
    const messages = rig.items.flatMap((item) => (item.kind === 'error' ? [item.message] : []))
    expect(messages.map((message) => /^Cursor asked "([^"]*)"/.exec(message)?.[1])).toEqual(['a question', 'a question', 'One? / Two?'])
  })

  it('accepts a todo update without todos as an empty list, and reports a finished task with what it says about itself', async () => {
    const rig = new Rig(
      new ReplayAcpAgents(
        newChat(
          prompt(4, S, 'go'),
          agent({ id: 14, method: 'cursor/update_todos', params: { toolCallId: 't' } }),
          client({ id: 14, result: { outcome: { outcome: 'accepted', todos: [] } } }),
          agent({ id: 15, method: 'cursor/task', params: { toolCallId: 'k', agentId: 'agent-7', durationMs: 1200 } }),
          client({ id: 15, result: { outcome: { outcome: 'completed', agentId: 'agent-7', durationMs: 1200 } } }),
          agent({ id: 16, method: 'cursor/task', params: { toolCallId: 'k', agentId: '', durationMs: '1200' } }),
          client({ id: 16, result: { outcome: { outcome: 'completed', agentId: '' } } }),
          turnEnd(4)
        )
      )
    )
    await rig.start()

    await rig.adapter.send('go')

    rig.expectReplayed()
    const written = (rig.agents.processes[0]?.writes ?? []).map((line) => JSON.parse(line) as { id?: number; result?: { outcome: unknown } })
    expect([14, 15, 16].map((id) => written.find((message) => message.id === id)?.result?.outcome)).toEqual([
      { outcome: 'accepted', todos: [] },
      { outcome: 'completed', agentId: 'agent-7', durationMs: 1200 },
      { outcome: 'completed', agentId: '' }
    ])
  })
})

describe('turns and updates with details missing', () => {
  it('ends a turn whose answer names no stop reason as an ordinary end', async () => {
    const rig = new Rig(new ReplayAcpAgents(newChat(prompt(4, S, 'go'), agent({ id: 4, result: {} }))))
    await rig.start()

    await expect(rig.adapter.send('go')).resolves.toBeUndefined()

    rig.expectReplayed()
  })

  it('files an update that names no session under the chat session', async () => {
    const nameless = agent({ method: 'session/update', params: { update: { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Read', kind: 'read', status: 'completed' } } })
    const rig = new Rig(new ReplayAcpAgents(newChat(prompt(4, S, 'go'), nameless, turnEnd(4))))
    await rig.start()

    await rig.adapter.send('go')

    rig.expectReplayed()
    expect(rig.items).toMatchObject([{ id: `tool_${S}_c1`, kind: 'tool_call', name: 'Read', status: 'completed' }])
  })
})

describe('stopping and ending at awkward moments', () => {
  it('sends nothing for a turn that is stopped before it reaches the agent, and ends it quietly', async () => {
    const agents = new ReplayAcpAgents(newChat())
    const rig = new Rig(agents)
    await rig.start()

    const turn = rig.adapter.send('go')
    await rig.adapter.stop()
    await turn

    rig.expectReplayed()
    expect(agents.processes[0]?.writes.some((line) => line.includes('session/prompt'))).toBe(false)
    expect(rig.timers.scheduled).toEqual([])
  })

  it('answers the agent once when the request is handed on, answered and then fails', async () => {
    const agents = new ReplayAcpAgents(newChat(prompt(4, S, 'go'), askToRun(S, 7, 'call_2', 'ls'), selected(7, 'allow-once'), turnEnd(4)))
    const rig = new Rig(agents)
    await rig.adapter.start(startOptions(), (event) => {
      if (event.type === 'approval_request') {
        event.respond('allow_once')
        throw new Error('the store refused it after the answer')
      }
      rig.events.push(event)
    })

    await rig.adapter.send('go')

    rig.expectReplayed()
    const answers = agents.processes[0]?.writes.filter((line) => line.includes('"id":7')) ?? []
    expect(answers).toHaveLength(1)
    expect(JSON.parse(answers[0] ?? '{}').result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } })
  })

  it('drops the text it was still holding when the chat is disposed in the middle of a turn', async () => {
    const agents = new ReplayAcpAgents(newChat(prompt(4, S, 'go'), say(S, 'half an answer')))
    const rig = new Rig(agents)
    await rig.start()
    const turn = rig.adapter.send('go').catch((error: unknown) => error)
    await vi.waitFor(() => expect(rig.events.some((event) => event.type === 'assistant_delta')).toBe(true), { interval: 1 })
    const seen = rig.events.length

    await rig.adapter.dispose()

    expect(await turn).toBeInstanceOf(Error)
    expect(rig.events).toHaveLength(seen)
    expect(rig.items).toEqual([])
  })
})

describe('models: listing failures that say little', () => {
  it.each([
    [{ kind: 'spawn_failed', code: null, message: 'nope' } as const, 'Cursor could not be started to list its models.'],
    [{ kind: 'exited', exitCode: 3, output: '\n  \n' } as const, 'Cursor exited with code 3 when asked for its models.'],
    [{ kind: 'exited', exitCode: 0, output: 'Loading...' } as const, 'Cursor printed no models.']
  ])('reports %j in plain words', async (outcome, message) => {
    const run: ProcessRunner = () => Promise.resolve(outcome)

    await expect(listCursorModels(PATH, makeDeps(new ReplayAcpAgents(), { scheduled: [] }, { run }))).rejects.toThrow(message)
  })
})
