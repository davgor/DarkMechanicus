/**
 * The generic ACP adapter with the least a flavor can declare: no `authenticate`, no extension methods,
 * no model switching and no sign-in sentence. It runs against the same replayed agent as the Cursor
 * tests, so each recording pins every message the client writes.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalDecision, ApprovalRequestItem, ChatAdapter, ChatAdapterEvent, ChatAdapterStartOptions, ChatItem } from '../../../../shared/agents/chat'
import { cliCommandLine, cliInstructions } from '../../cliInstructions'
import {
  askToRun,
  CLIENT_VERSION,
  DM_INSTRUCTIONS,
  DM_SERVER,
  firstPrompt,
  FOLDER,
  instructionsBlock,
  loadSession,
  newSession,
  prompt,
  say,
  selected,
  turnEnd,
  update
} from '../../__mocks__/cursorRecordings'
import { agent, client, ReplayAcpAgents, type Frame } from '../../__mocks__/replayAcpAgent'
import { createAcpAdapter, type AcpDeps, type AcpFlavor } from './acpAdapter'

const AT = '2026-01-01T00:00:00.000Z'
const S = 'sess_min'
const PATH = '/opt/minimal/agent'

const MINIMAL: AcpFlavor = {
  kind: 'cursor',
  displayName: 'Minimal',
  authMethodId: null,
  extensions: {},
  launchArgs: () => ['serve-acp'],
  listModels: () => Promise.resolve([]),
  switchModel: 'none'
}

/** initialize alone: a flavor without an auth method never sends `authenticate`. `extra` is what the flavor adds to the client capabilities. */
function initialize(extra: Record<string, unknown> = {}): Frame[] {
  return [
    client({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...extra },
        clientInfo: { name: 'dark-mechanicus', version: CLIENT_VERSION }
      }
    }),
    agent({ id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } })
  ]
}

function newChat(...rest: Frame[]): Frame[] {
  return [...initialize(), ...newSession(2, S), ...rest]
}

function startOptions(overrides: Partial<ChatAdapterStartOptions> = {}): ChatAdapterStartOptions {
  return {
    chatId: 'chat_1',
    folder: FOLDER,
    checkFolder: () => {},
    model: null,
    role: 'planner',
    allowSave: false,
    sessionId: null,
    darkMechanicus: DM_SERVER,
    instructions: DM_INSTRUCTIONS,
    ...overrides
  }
}

interface Rig {
  adapter: ChatAdapter
  agents: ReplayAcpAgents
  events: ChatAdapterEvent[]
  items(): ChatItem[]
  approval(): Promise<{ request: ApprovalRequestItem; respond: (decision: ApprovalDecision) => void }>
  expectReplayed(): void
}

interface StartedExtra {
  /** Recordings for the processes started after the first. */
  later?: Frame[][]
  options?: Partial<ChatAdapterStartOptions>
}

async function started(recording: Frame[], flavor: AcpFlavor = MINIMAL, extra: StartedExtra = {}): Promise<Rig> {
  const agents = new ReplayAcpAgents(recording, ...(extra.later ?? []))
  let count = 0
  const deps: AcpDeps = {
    platform: 'linux',
    inspect: () => 'ok',
    transport: agents.factory,
    run: () => Promise.reject(new Error('no process runner in this test')),
    newId: () => `id_${(count += 1)}`,
    now: () => AT,
    timers: { set: () => 0, clear: () => {} },
    cancelGraceMs: 7_000,
    clientVersion: CLIENT_VERSION
  }
  const events: ChatAdapterEvent[] = []
  const adapter = createAcpAdapter(flavor, PATH, deps)
  await adapter.start(startOptions(extra.options), (event) => events.push(event))
  const approvals = () => events.flatMap((event) => (event.type === 'approval_request' ? [event] : []))
  return {
    adapter,
    agents,
    events,
    items: () => events.flatMap((event) => (event.type === 'item' ? [event.item] : [])),
    approval: async () => {
      await vi.waitFor(() => expect(approvals().length).toBeGreaterThan(0), { interval: 1 })
      const [first] = approvals()
      if (first === undefined) {
        throw new Error('no approval request')
      }
      return first
    },
    expectReplayed: () => {
      expect(agents.problems).toEqual([])
      expect(agents.finished()).toBe(true)
    }
  }
}

describe('a minimal ACP flavor: turns and approvals', () => {
  it('starts the flavor’s command without signing in, and streams a text turn', async () => {
    const rig = await started(newChat(firstPrompt(3, S, 'hi'), say(S, 'Hel', 'm1'), say(S, 'lo', 'm1'), turnEnd(3)))

    await rig.adapter.send('hi')

    rig.expectReplayed()
    expect(rig.agents.launches[0]?.launch.args).toEqual(['serve-acp'])
    expect(rig.agents.launches[0]?.cwd).toBe(FOLDER)
    expect(rig.adapter.kind).toBe('cursor')
    expect(rig.events).toEqual([
      { type: 'session', sessionId: S },
      { type: 'assistant_delta', itemId: 'id_1', delta: 'Hel' },
      { type: 'assistant_delta', itemId: 'id_1', delta: 'lo' },
      { type: 'item', item: { id: 'id_1', at: AT, kind: 'assistant_text', text: 'Hello' } }
    ])
  })

  it('puts a permission request to the person and answers it with the option they chose', async () => {
    const rig = await started(
      newChat(
        firstPrompt(3, S, 'list'),
        update(S, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Run `ls`', kind: 'execute', status: 'pending' }),
        askToRun(S, 7, 'call_1', 'ls'),
        selected(7, 'allow-once'),
        update(S, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed' }),
        turnEnd(3)
      )
    )

    const turn = rig.adapter.send('list')
    const { request, respond } = await rig.approval()
    respond('allow_once')
    await turn

    rig.expectReplayed()
    expect(request).toMatchObject({ kind: 'approval_request', category: 'command', tool: 'Shell', summary: 'Run `ls`', input: { command: 'ls' } })
    expect(rig.items().map((item) => (item.kind === 'tool_call' ? item.status : item.kind))).toEqual(['running', 'completed'])
  })
})

describe('a minimal ACP flavor: what it does not declare', () => {
  it('names itself, not another vendor, in a permission request that says nothing about its tool', async () => {
    const rig = await started(
      newChat(
        firstPrompt(3, S, 'go'),
        agent({ id: 8, method: 'session/request_permission', params: { sessionId: S } }),
        selected(8, 'reject-once'),
        turnEnd(3)
      )
    )

    const turn = rig.adapter.send('go')
    const { request, respond } = await rig.approval()
    respond('deny')
    await turn

    rig.expectReplayed()
    expect(request.summary).toBe('Minimal asks to use a tool')
  })

  it('answers every request method it did not declare with method-not-found, Cursor’s extensions included', async () => {
    const methods = ['cursor/ask_question', 'cursor/task', 'vendor/anything', 'toString', '__proto__']
    const rig = await started(
      newChat(
        firstPrompt(3, S, 'go'),
        ...methods.flatMap((method, index) => [
          agent({ id: 20 + index, method, params: {} }),
          client({ id: 20 + index, error: { code: -32601, message: `Method not supported: ${method}` } })
        ]),
        say(S, 'done'),
        turnEnd(3)
      )
    )

    await rig.adapter.send('go')

    rig.expectReplayed()
    expect(rig.items()).toEqual([{ id: 'id_1', at: AT, kind: 'assistant_text', text: 'done' }])
  })
})

describe('a minimal ACP flavor: no sign-in sentence, no model switching', () => {
  it('keeps a turn whose whole answer is a sign-in sentence as the answer, having no sign-in check of its own', async () => {
    const rig = await started(newChat(firstPrompt(3, S, 'hi'), say(S, 'Please sign in to continue.'), turnEnd(3)))

    await rig.adapter.send('hi')

    rig.expectReplayed()
    expect(rig.items().map((item) => item.kind)).toEqual(['assistant_text'])
  })

  it('refuses to switch models when the flavor cannot', async () => {
    const rig = await started(newChat())

    await expect(rig.adapter.setModel('other')).rejects.toThrow('Minimal cannot switch models in a running chat.')
    rig.expectReplayed()
  })
})

describe('a flavor’s extension methods', () => {
  it('answers a declared extension with what its handler returns, after the items it put in the chat', async () => {
    const flavor: AcpFlavor = {
      ...MINIMAL,
      extensions: {
        'vendor/ping': (params, chat) => {
          chat.emit({ type: 'item', item: { id: chat.newId(), at: chat.now(), kind: 'error', message: 'pinged', code: 'ping' } })
          return { pong: params }
        }
      }
    }
    const rig = await started(
      newChat(
        firstPrompt(3, S, 'go'),
        agent({ id: 9, method: 'vendor/ping', params: { n: 1 } }),
        client({ id: 9, result: { pong: { n: 1 } } }),
        turnEnd(3)
      ),
      flavor
    )

    await rig.adapter.send('go')

    rig.expectReplayed()
    expect(rig.items()).toEqual([{ id: 'id_1', at: AT, kind: 'error', message: 'pinged', code: 'ping' }])
  })
})

describe('a flavor’s requests that wait', () => {
  it('answers an extension once the promise its handler returned settles', async () => {
    let release: (answer: unknown) => void = () => {}
    const flavor: AcpFlavor = {
      ...MINIMAL,
      extensions: { 'vendor/ask': () => new Promise((resolve) => (release = resolve)) }
    }
    const rig = await started(
      newChat(firstPrompt(3, S, 'go'), agent({ id: 9, method: 'vendor/ask', params: {} }), client({ id: 9, result: { action: 'accept' } }), turnEnd(3)),
      flavor
    )

    const turn = rig.adapter.send('go')
    await vi.waitFor(() => expect(rig.agents.processes[0]?.writes).toHaveLength(3), { interval: 1 })
    release({ action: 'accept' })
    await turn

    rig.expectReplayed()
  })

  it('tells a waiting extension that the turn was stopped, after asking the agent to cancel', async () => {
    let asked = false
    const flavor: AcpFlavor = {
      ...MINIMAL,
      extensions: {
        'vendor/ask': (_params, chat) => {
          asked = true
          return new Promise((resolve) => chat.signal.addEventListener('abort', () => resolve({ action: 'decline' })))
        }
      }
    }
    const rig = await started(
      newChat(
        firstPrompt(3, S, 'go'),
        agent({ id: 9, method: 'vendor/ask', params: {} }),
        client({ method: 'session/cancel', params: { sessionId: S } }),
        client({ id: 9, result: { action: 'decline' } }),
        turnEnd(3, 'cancelled')
      ),
      flavor
    )

    const turn = rig.adapter.send('go')
    await vi.waitFor(() => expect(asked).toBe(true), { interval: 1 })
    await rig.adapter.stop()
    await turn

    rig.expectReplayed()
  })
})

describe('a flavor’s failing requests and its client capabilities', () => {
  it('answers a handler whose promise rejects with an internal error', async () => {
    const flavor: AcpFlavor = { ...MINIMAL, extensions: { 'vendor/ask': () => Promise.reject(new Error('no way')) } }
    const rig = await started(
      newChat(firstPrompt(3, S, 'go'), agent({ id: 9, method: 'vendor/ask' }), client({ id: 9, error: { code: -32603, message: 'no way' } }), turnEnd(3)),
      flavor
    )

    await rig.adapter.send('go')

    rig.expectReplayed()
  })

  it('adds the flavor’s client capabilities to the ones every session declares', async () => {
    const flavor: AcpFlavor = { ...MINIMAL, clientCapabilities: { elicitation: { form: {} } } }
    const rig = await started([...initialize({ elicitation: { form: {} } }), ...newSession(2, S)], flavor)

    rig.expectReplayed()
  })
})

describe('what an ACP chat is told about dm', () => {
  it('leads the first prompt of each process with the instructions, once, and a resumed process again (c2)', async () => {
    const rig = await started(newChat(firstPrompt(3, S, 'one'), turnEnd(3), prompt(4, S, 'two'), say(S, 'half')), MINIMAL, {
      later: [[...initialize(), ...loadSession(2, S), firstPrompt(3, S, 'three'), turnEnd(3), prompt(4, S, 'four'), turnEnd(4)]]
    })

    await rig.adapter.send('one')
    const failed = rig.adapter.send('two')
    await vi.waitFor(() => expect(rig.events.some((event) => event.type === 'assistant_delta')).toBe(true), { interval: 1 })
    rig.agents.processes[0]?.exit('exit code 1: crashed')
    await expect(failed).rejects.toThrow('crashed')
    await rig.adapter.send('three')
    await rig.adapter.send('four')

    rig.expectReplayed()
    const prompts = rig.agents.processes.flatMap((process) => process.writes.filter((line) => line.includes('"session/prompt"')))
    expect(prompts.map((line) => line.split(DM_INSTRUCTIONS).length - 1)).toEqual([1, 0, 1, 0])
  })

  it('never shows the instructions as the person’s words: not from the echo of a turn, nor from a replayed history (c2)', async () => {
    const echo = (text: string) => update(S, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
    const history = [
      update(S, { sessionUpdate: 'user_message_chunk', content: instructionsBlock() }),
      echo('earlier'),
      say(S, 'earlier answer')
    ]
    const rig = await started([...initialize(), ...loadSession(2, S, history), firstPrompt(3, S, 'hi'), update(S, { sessionUpdate: 'user_message_chunk', content: instructionsBlock() }), echo('hi'), say(S, 'answer'), turnEnd(3)], MINIMAL, {
      options: { sessionId: S }
    })

    await rig.adapter.send('hi')

    rig.expectReplayed()
    expect(rig.items()).toEqual([{ id: 'id_1', at: AT, kind: 'assistant_text', text: 'answer' }])
    expect(JSON.stringify(rig.events)).not.toContain(DM_INSTRUCTIONS)
  })

  it('sends the real dm instructions with --repo <folder>, and the session token in no request and no item (c2, c3)', async () => {
    const token = 'dmg_FAKE_TOKEN_DM278'
    const cli = { ...DM_SERVER, env: { DM_SESSION_TOKEN: token } }
    const instructions = cliInstructions({ cli, role: 'planner', allowSave: false })
    const rig = await started(newChat(firstPrompt(3, S, 'hi', instructions), say(S, 'ok'), turnEnd(3)), MINIMAL, {
      options: { darkMechanicus: cli, instructions }
    })

    await rig.adapter.send('hi')

    rig.expectReplayed()
    expect(instructions).toContain(`${cliCommandLine(cli)} --list`)
    expect(cliCommandLine(cli)).toContain(`--repo ${FOLDER}`)
    expect(rig.agents.processes[0]?.writes.join('\n')).not.toContain(token)
    expect(JSON.stringify(rig.events)).not.toContain(token)
  })
})

describe('instructions a prompt did not get through with', () => {
  it('leads the next prompt with them again when the agent refused the one that carried them', async () => {
    const rig = await started(
      newChat(
        firstPrompt(3, S, 'one'),
        agent({ id: 3, error: { code: -32603, message: 'Model not available' } }),
        firstPrompt(4, S, 'two'),
        turnEnd(4),
        prompt(5, S, 'three'),
        turnEnd(5)
      )
    )

    await expect(rig.adapter.send('one')).rejects.toThrow('Model not available')
    await rig.adapter.send('two')
    await rig.adapter.send('three')

    rig.expectReplayed()
    expect(rig.agents.launches).toHaveLength(1)
  })
})
