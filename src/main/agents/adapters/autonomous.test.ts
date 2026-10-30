/**
 * The Autonomous flavor against the recording of the installed a8s (`__mocks__/autonomousRecordings.ts`,
 * DM-253 and DM-281). Each replay pins every message the client writes. The recordings' prompts
 * carried no Dark Mechanicus instructions, so the first prompt of each process is led by them here
 * (`instructed`); DM-253's two processes were recorded with Cursor's capabilities, so their
 * `initialize` is replaced by run 5's, which adds `elicitation.form` as this flavor does.
 */
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { ApprovalDecision, ApprovalRequestItem, ChatAdapter, ChatAdapterEvent, ChatAdapterStartOptions, ChatItem } from '../../../shared/agents/chat'
import { DM_INSTRUCTIONS, DM_SERVER, instructionsBlock } from '../__mocks__/cursorRecordings'
import { agent, client, ReplayAcpAgents, type Frame } from '../__mocks__/replayAcpAgent'
import { BUILT_IN_LAUNCH_ARGS, launchSpecFor } from '../launchSpec'
import { createAcpAdapter, type AcpDeps } from './acp/acpAdapter'
import { autonomousFlavor } from './autonomous'
import { AUTONOMOUS_RECORDINGS as R } from './__mocks__/autonomousRecordings'

const AT = '2026-01-01T00:00:00.000Z'
const PATH = '/Users/me/.local/bin/a8s'
const HAIKU = 'anthropic/claude-haiku-5-5'

/** The same prompt, led by the chat's instructions as the first prompt of a process is. */
function instructed(frame: Frame): Frame {
  const params = frame.message.params as { sessionId: string; prompt: unknown[] }
  return client({ id: frame.message.id as number, method: 'session/prompt', params: { ...params, prompt: [instructionsBlock(), ...params.prompt] } })
}

function isPrompt(frame: Frame): boolean {
  return frame.from === 'client' && frame.message.method === 'session/prompt'
}

/** Leads the first `session/prompt` of a process's frames with the instructions. */
function withInstructions(frames: readonly Frame[]): Frame[] {
  const first = frames.findIndex(isPrompt)
  return frames.map((frame, index) => (index === first ? instructed(frame) : frame))
}

/** DM-253's handshake with this flavor's `initialize` (the agent's answer and `authenticate` are unchanged). */
const HANDSHAKE: Frame[] = [...R.writeHandshake]
const FIRST_PROCESS = withInstructions([...HANDSHAKE, ...R.newSession, ...R.promptTurn, ...R.cancelTurn])
const SECOND_PROCESS = withInstructions([...HANDSHAKE, ...R.loadSession])
const WRITE_PROCESS = withInstructions(R.writeProcess)

/** Run 5 up to and including the `elicitation/create` for the write. */
function untilElicitation(): Frame[] {
  const at = WRITE_PROCESS.findIndex((frame) => frame.message.method === 'elicitation/create')
  return WRITE_PROCESS.slice(0, at + 1)
}

/** What a8s sent after a declined elicitation (DM-281 run 6). */
const WRITE_DENIED = agent({
  method: 'session/update',
  params: {
    sessionId: R.writeSessionId,
    update: {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'toolu_write',
      status: 'failed',
      rawOutput: { content: [{ type: 'text', text: 'Tool call denied by user: write' }], details: {} },
      content: [{ type: 'content', content: { type: 'text', text: 'Tool call denied by user: write' } }]
    }
  }
})

function startOptions(overrides: Partial<ChatAdapterStartOptions> = {}): ChatAdapterStartOptions {
  return {
    chatId: 'chat_1',
    folder: R.folder,
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

interface Approval {
  request: ApprovalRequestItem
  respond: (decision: ApprovalDecision) => void
}

interface Rig {
  adapter: ChatAdapter
  agents: ReplayAcpAgents
  events: ChatAdapterEvent[]
  items(): ChatItem[]
  /** The `index`th approval request of the chat, once it has arrived. */
  approval(index: number): Promise<Approval>
  expectReplayed(): void
}

function testDeps(agents: ReplayAcpAgents): AcpDeps {
  let count = 0
  return {
    platform: 'darwin',
    inspect: () => 'ok',
    transport: agents.factory,
    run: () => Promise.reject(new Error('no process runner in this test')),
    newId: () => `id_${(count += 1)}`,
    now: () => AT,
    timers: { set: () => 0, clear: () => {} },
    cancelGraceMs: 7_000,
    clientVersion: R.clientVersion
  }
}

function rigFor(adapter: ChatAdapter, agents: ReplayAcpAgents, events: ChatAdapterEvent[]): Rig {
  const approvals = (): Approval[] => events.flatMap((event) => (event.type === 'approval_request' ? [event] : []))
  return {
    adapter,
    agents,
    events,
    items: () => events.flatMap((event) => (event.type === 'item' ? [event.item] : [])),
    approval: async (index) => {
      await vi.waitFor(() => expect(approvals().length).toBeGreaterThan(index), { interval: 1 })
      const found = approvals()[index]
      if (found === undefined) {
        throw new Error(`no approval request ${index}`)
      }
      return found
    },
    expectReplayed: () => {
      expect(agents.problems).toEqual([])
      expect(agents.finished()).toBe(true)
    }
  }
}

async function started(recordings: Frame[][], options: Partial<ChatAdapterStartOptions> = {}): Promise<Rig> {
  const agents = new ReplayAcpAgents(...recordings)
  const events: ChatAdapterEvent[] = []
  const adapter = createAcpAdapter(autonomousFlavor, PATH, testDeps(agents), BUILT_IN_LAUNCH_ARGS.autonomous)
  await adapter.start(startOptions(options), (event) => events.push(event))
  return rigFor(adapter, agents, events)
}

/** The states a tool call went through, each once in order (a running call is restated as its output grows). */
function toolStatuses(items: ChatItem[], toolCallId: string): string[] {
  const statuses = items.flatMap((item) => (item.kind === 'tool_call' && item.id.endsWith(`_${toolCallId}`) ? [item.status] : []))
  return statuses.filter((status, index) => status !== statuses[index - 1])
}

describe('Autonomous: launch', () => {
  it('starts `a8s start <chat folder> --mode acp --approval-mode always-ask` in the chat folder, from the built-in preset', async () => {
    const rig = await started([WRITE_PROCESS])

    expect(launchSpecFor({ ...autonomousRow(), args: ['--approval-mode', 'yolo'] }).args).toEqual(['start', '{folder}', '--mode', 'acp', '--approval-mode', 'always-ask'])
    expect(rig.agents.launches).toEqual([{ launch: { file: PATH, args: R.launchArgv, verbatimArguments: false }, cwd: R.folder }])
    expect(rig.adapter.kind).toBe('autonomous')
  })

  it('puts the folder it is given in the argv, never a fixed one, and opens the session there', async () => {
    const folder = '/private/var/chat folder'
    const rig = await started(
      [[...HANDSHAKE, client({ id: 3, method: 'session/new', params: { cwd: folder, mcpServers: [] } }), agent({ id: 3, result: { sessionId: R.sessionId } })]],
      { folder }
    )

    rig.expectReplayed()
    expect(rig.agents.launches[0]?.launch.args).toEqual(['start', folder, '--mode', 'acp', '--approval-mode', 'always-ask'])
    expect(rig.agents.launches[0]?.cwd).toBe(folder)
  })

  it('adds `--model <id>` after the report’s argv when the chat has a model, as run 5 was started', async () => {
    // Run 5's session/new reports Haiku, the model it was started on, so no switch follows.
    const rig = await started([WRITE_PROCESS], { model: HAIKU })

    expect(rig.agents.launches[0]?.launch.args).toEqual([...R.launchArgv, '--model', HAIKU])
    expect(R.writeLaunchArgv.slice(0, R.launchArgv.length + 2)).toEqual([...R.launchArgv, '--model', HAIKU])
    expect(rig.agents.problems).toEqual([])
  })

  it('refuses to start on a model id that fails isSafeModelId, and refuses to switch to one', async () => {
    for (const model of ['-rf', 'a b', 'x"&calc', 'id;rm']) {
      const agents = new ReplayAcpAgents()
      const adapter = createAcpAdapter(autonomousFlavor, PATH, testDeps(agents), BUILT_IN_LAUNCH_ARGS.autonomous)
      await expect(adapter.start(startOptions({ model }), () => {})).rejects.toThrow('not a model id')
      await expect(adapter.setModel(model)).rejects.toThrow('not a model id')
      expect(agents.launches).toEqual([])
    }
  })

  it('never asks for writes to run unasked: no write or yolo approval mode, and file-system access stays with a8s', () => {
    expect(BUILT_IN_LAUNCH_ARGS.autonomous.join(' ')).not.toMatch(/\b(?:write|yolo)\b/)
    expect(autonomousFlavor.clientCapabilities).toEqual({ elicitation: { form: {} } })
  })

  it('signs in with the auth method initialize lists, and sends no authenticate when it lists none', async () => {
    const answer = R.writeHandshake[1] as Frame
    const result = answer.message.result as Record<string, unknown>
    const listsNone = agent({ id: 1, result: { ...result, authMethods: [] } })
    const rig = await started([
      [R.writeHandshake[0] as Frame, listsNone, client({ id: 2, method: 'session/new', params: { cwd: R.folder, mcpServers: [] } }), agent({ id: 2, result: { sessionId: R.sessionId } })]
    ])

    rig.expectReplayed()
    expect(R.writeHandshake[2]?.message).toMatchObject({ method: 'authenticate', params: { methodId: 'agent' } })
  })
})

function autonomousRow(): Parameters<typeof launchSpecFor>[0] {
  return {
    id: 'autonomous',
    kind: 'autonomous',
    protocol: 'acp',
    displayName: 'Autonomous',
    executablePath: PATH,
    args: [],
    version: '0.79.0',
    connectedVia: 'found',
    connectedAt: AT,
    lastProbed: AT
  }
}

describe('Autonomous: a streamed turn with both kinds of approval (run 5)', () => {
  it('streams the answer, runs `pwd` once allowed, and runs the write once allowed through elicitation/create', async () => {
    const rig = await started([WRITE_PROCESS])

    const turn = rig.adapter.send(promptText())
    const shell = await rig.approval(0)
    shell.respond('allow_once')
    const write = await rig.approval(1)
    write.respond('allow_once')
    await turn

    rig.expectReplayed()
    expect(shell.request).toMatchObject({ category: 'command', tool: 'Shell', summary: 'pwd' })
    expect(write.request).toMatchObject({
      kind: 'approval_request',
      category: 'file_edit',
      tool: 'write',
      summary: 'Allow tool: write\nPath: hello.txt\nContent:\nhi',
      input: { path: 'hello.txt' }
    })
    expect(toolStatuses(rig.items(), 'toolu_write')).toEqual(['running', 'completed'])
    expect(rig.events.filter((event) => event.type === 'assistant_delta').length).toBeGreaterThan(0)
    expect(rig.items().filter((item) => item.kind === 'assistant_text').map((item) => (item.kind === 'assistant_text' ? item.text : ''))).toEqual([
      "I'll start by running `pwd`.",
      'Now creating the file.',
      `Done.\n\n- \`pwd\`: \`${R.realFolder}\`\n- Created \`hello.txt\` in that folder containing \`hi\` (2 bytes).`
    ])
  })

  it('answers Allow for this chat with Approve, under one scope for every write of the chat', async () => {
    const rig = await started([[...untilElicitation(), client({ id: 1, result: { action: 'accept', content: { value: 'Approve' } } })]])

    void rig.adapter.send(promptText())
    ;(await rig.approval(0)).respond('allow_once')
    const write = await rig.approval(1)
    write.respond('allow_chat')
    write.respond('deny')

    await vi.waitFor(() => expect(rig.agents.finished()).toBe(true), { interval: 1 })
    expect(rig.agents.problems).toEqual([])
    expect([write.request.category, write.request.tool]).toEqual(['file_edit', 'write'])
  })
})

function promptText(): string {
  const params = R.writeTurn.find(isPrompt)?.message.params as { prompt: { text: string }[] }
  return params.prompt[0]?.text ?? ''
}

describe('Autonomous: a write that is denied or stopped', () => {
  it('answers Deny with decline and shows the write as denied (run 6)', async () => {
    const rig = await started([
      [...untilElicitation(), client({ id: 1, result: { action: 'decline' } }), WRITE_DENIED, agent({ id: 4, result: { stopReason: 'end_turn' } })]
    ])

    const turn = rig.adapter.send(promptText())
    ;(await rig.approval(0)).respond('allow_once')
    ;(await rig.approval(1)).respond('deny')
    await turn

    rig.expectReplayed()
    expect(toolStatuses(rig.items(), 'toolu_write')).toEqual(['running', 'denied'])
  })

  it('answers decline when the turn is stopped while the write is asked about, and allows nothing afterwards', async () => {
    const rig = await started([
      [
        ...untilElicitation(),
        client({ method: 'session/cancel', params: { sessionId: R.writeSessionId } }),
        client({ id: 1, result: { action: 'decline' } }),
        WRITE_DENIED,
        agent({ id: 4, result: { stopReason: 'cancelled' } })
      ]
    ])

    const turn = rig.adapter.send(promptText())
    ;(await rig.approval(0)).respond('allow_once')
    const write = await rig.approval(1)
    await rig.adapter.stop()
    await turn
    write.respond('allow_once')

    rig.expectReplayed()
    expect(toolStatuses(rig.items(), 'toolu_write')).toEqual(['running', 'failed'])
  })

  it('declines an elicitation that is not an Approve/Deny form, and says so in the chat', async () => {
    const form = { mode: 'form', sessionId: R.writeSessionId, message: 'Pick a colour', requestedSchema: { type: 'object', properties: { colour: { type: 'string' } } } }
    const rig = await started([
      [
        ...withInstructions([...HANDSHAKE, ...R.writeTurn.slice(0, 4)]),
        agent({ id: 7, method: 'elicitation/create', params: form }),
        client({ id: 7, result: { action: 'decline' } }),
        agent({ id: 4, result: { stopReason: 'end_turn' } })
      ]
    ])

    await rig.adapter.send(promptText())

    rig.expectReplayed()
    expect(rig.events.filter((event) => event.type === 'approval_request')).toEqual([])
    expect(rig.items()).toEqual([expect.objectContaining({ kind: 'error', code: 'autonomous_question' })])
  })
})

describe('Autonomous: cancel, resume and the model (DM-253)', () => {
  it('stops a turn at its permission prompt with session/cancel and a cancelled answer', async () => {
    const rig = await started([FIRST_PROCESS])

    const first = rig.adapter.send('Run the shell command `pwd`. Then create a file named hello.txt containing "hi" in the current folder. Use one tool call for each step. Be brief.')
    ;(await rig.approval(0)).respond('allow_once')
    await first
    const second = rig.adapter.send('Run the shell command `sleep 60` and then say done.')
    await rig.approval(1)
    await rig.adapter.stop()
    await second

    rig.expectReplayed()
    expect(rig.events).toContainEqual({ type: 'session', sessionId: R.sessionId })
    expect(toolStatuses(rig.items(), 'toolu_pwd')).toEqual(['running', 'completed'])
  })

  it('resumes with session/load, switches to the chat’s model with session/set_config_option, and reports a Deny back', async () => {
    const rig = await started([SECOND_PROCESS], { sessionId: R.sessionId, model: HAIKU })

    const turn = rig.adapter.send('Run the shell command `pwd` once. Be brief.')
    ;(await rig.approval(0)).respond('deny')
    await turn

    rig.expectReplayed()
    expect(rig.events.some((event) => event.type === 'session')).toBe(false)
    expect(rig.items().some((item) => item.kind === 'context_reset')).toBe(false)
    expect(toolStatuses(rig.items(), 'toolu_pwd_again')).toEqual(['running', 'denied'])
  })

  it('switches a running chat’s model in the same process with session/set_config_option', async () => {
    const switchAt = R.loadSession.findIndex((frame) => frame.message.method === 'session/set_config_option')
    const rig = await started([withInstructions([...HANDSHAKE, ...R.newSession, ...R.loadSession.slice(switchAt)])])

    await rig.adapter.setModel(HAIKU)
    const turn = rig.adapter.send('Run the shell command `pwd` once. Be brief.')
    ;(await rig.approval(0)).respond('deny')
    await turn

    rig.expectReplayed()
    expect(rig.agents.launches).toHaveLength(1)
  })
})

describe('Autonomous: signed out', () => {
  it('reports an authentication-required answer as auth_required (shape from the ACP schema; a8s’s own was not observed)', async () => {
    const rig = await started([
      [
        ...HANDSHAKE,
        ...R.newSession,
        client({ id: 4, method: 'session/prompt', params: { sessionId: R.sessionId, prompt: [instructionsBlock(), { type: 'text', text: promptText() }] } }),
        agent({ id: 4, error: { code: -32000, message: 'Authentication required' } })
      ]
    ])

    await rig.adapter.send(promptText())

    rig.expectReplayed()
    expect(rig.items()).toEqual([{ id: expect.any(String), at: AT, kind: 'auth_required', agent: 'autonomous', message: 'Authentication required' }])
  })
})

describe('Autonomous: the models it offers, without a chat', () => {
  const folder = realpathSync(tmpdir())
  /** Run 5's session/new, in the temp folder, then session/close. */
  const listing: Frame[] = [
    ...HANDSHAKE,
    client({ id: 3, method: 'session/new', params: { cwd: folder, mcpServers: [] } }),
    R.writeTurn[1] as Frame,
    R.writeTurn[2] as Frame,
    client({ id: 4, method: 'session/close', params: { sessionId: R.writeSessionId } }),
    agent({ id: 4, result: {} })
  ]

  it('lists the model config option of a session opened only to ask, once per executable, with no prompt', async () => {
    const agents = new ReplayAcpAgents(listing)
    const path = '/opt/list-once/a8s'

    const models = await autonomousFlavor.listModels(path, testDeps(agents))
    const again = await autonomousFlavor.listModels(path, testDeps(agents))

    expect(agents.problems).toEqual([])
    expect(agents.finished()).toBe(true)
    expect(models).toEqual([
      { id: 'anthropic/claude-fable-5-1', label: 'Claude Fable 5.1' },
      { id: 'anthropic/claude-haiku-5-5', label: 'Claude Haiku 5.5' },
      { id: 'anthropic/claude-opus-5-5', label: 'Claude Opus 5.5' },
      { id: 'anthropic/claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }
    ])
    expect(again).toBe(models)
    expect(agents.launches).toEqual([{ launch: { file: path, args: ['start', folder, '--mode', 'acp', '--approval-mode', 'always-ask'], verbatimArguments: false }, cwd: folder }])
    expect(agents.processes[0]?.killed).toBe(true)
  })

  it('asks again after a listing that failed', async () => {
    const refused = [...HANDSHAKE.slice(0, 3), agent({ id: 2, error: { code: -32000, message: 'Authentication required' } })]
    const agents = new ReplayAcpAgents(refused, listing)
    const path = '/opt/list-twice/a8s'

    await expect(autonomousFlavor.listModels(path, testDeps(agents))).rejects.toThrow('Authentication required')
    expect(await autonomousFlavor.listModels(path, testDeps(agents))).toHaveLength(4)

    expect(agents.problems).toEqual([])
    expect(agents.launches).toHaveLength(2)
  })
})
