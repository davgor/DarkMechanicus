/**
 * The Codex adapter and the subagents Codex starts (DM-97). The exchanges are built from the Codex
 * source, not captured from a running Codex; `__mocks__/codexSubagents.ts` says which source and how.
 */
import { describe, expect, it } from 'vitest'
import type { ApprovalDecision, ChatAdapter, ChatAdapterEvent, ChatItem } from '../../../shared/agents/chat'
import { replayTransport, step, type Json, type ReplayTransport, type Step } from '../__mocks__/codexReplay'
import {
  activity,
  AGENT_PATH,
  askCommand,
  CHILD,
  CHILD_TURN,
  CHILD_V2,
  CHILD_V2_TURN,
  collab,
  command,
  completed,
  GRANDCHILD,
  GRANDCHILD_TURN,
  message,
  NEW_THREAD,
  parentTurn,
  PARENT,
  SPAWN_PROMPT,
  started,
  TURN,
  turnCompleted,
  turnStarted,
  V1_EXCHANGE,
  V2_EXCHANGE
} from '../__mocks__/codexSubagents'
import { AT, REPO } from '../__mocks__/fakeChatAdapter'
import { createCodexAdapter } from './codex'

interface Rig {
  adapter: ChatAdapter
  events: ChatAdapterEvent[]
  transport: ReplayTransport
}

/** Starts an adapter on `script`; approval requests are answered from `answers` a moment after they are raised. */
async function rig(script: Step[], answers: ApprovalDecision[] = ['allow_once']): Promise<Rig> {
  const transport = replayTransport(script)
  let count = 0
  const events: ChatAdapterEvent[] = []
  const adapter = createCodexAdapter('/bin/codex', {
    connect: () => transport,
    newId: () => `n${(count += 1)}`,
    now: () => AT,
    clientVersion: '9.9.9'
  })
  const pending = [...answers]
  await adapter.start(
    {
      chatId: 'chat_1',
      folder: REPO,
      model: null,
      role: 'planner',
      allowSave: true,
      sessionId: null,
      darkMechanicus: { command: 'node', args: ['mcp.js'] }
    },
    (event) => {
      events.push(event)
      if (event.type === 'approval_request') {
        const decision = pending.shift() ?? 'deny'
        void Promise.resolve().then(() => {
          event.respond(decision)
        })
      }
    }
  )
  return { adapter, events, transport }
}

type ThreadItem = Extract<ChatItem, { kind: 'thread' }>

function transcript(target: Rig): ChatItem[] {
  return target.events.flatMap((event) => {
    if (event.type === 'item') {
      return [event.item]
    }
    return event.type === 'approval_request' ? [event.request] : []
  })
}

function threads(target: Rig): ThreadItem[] {
  return transcript(target).filter((item): item is ThreadItem => item.kind === 'thread')
}

/** The states a thread went through, in order, as the transcript rewrote its item. */
function states(target: Rig, id: string): string[] {
  return threads(target)
    .filter((item) => item.id === id)
    .map((item) => item.state)
}

// ---- Expected transcript items ----

const SPAWN_ID = `${TURN}:s1`
const THREAD_ID = `codex_thread_${SPAWN_ID}`

function threadItem(state: ThreadItem['state']): ChatItem {
  return { id: THREAD_ID, at: AT, kind: 'thread', parentItemId: SPAWN_ID, label: SPAWN_PROMPT, state }
}

interface Outcome {
  status: 'running' | 'completed' | 'failed'
  resultSummary: string | null
  threadId?: string
}

const RUNNING: Outcome = { status: 'running', resultSummary: null }

function tool(id: string, name: string, input: Record<string, Json>, outcome: Outcome): ChatItem {
  return { id, at: AT, kind: 'tool_call', name, input, ...outcome }
}

const spawnCall = (outcome: Outcome): ChatItem => tool(SPAWN_ID, 'spawn_agent', { prompt: SPAWN_PROMPT }, outcome)

// ---- Scripts ----

const SPAWN_STARTED = started(PARENT, TURN, collab('s1', 'spawnAgent', { prompt: SPAWN_PROMPT }))

function spawnCompleted(fields: Parameters<typeof collab>[2] = {}): Step {
  return completed(
    PARENT,
    TURN,
    collab('s1', 'spawnAgent', { status: 'completed', prompt: SPAWN_PROMPT, receiverThreadIds: [CHILD], agentsStates: { [CHILD]: { status: 'running', message: null } }, ...fields })
  )
}

/** A parent turn that spawns the subagent, then plays `body`. */
function spawned(body: Step[], finish?: Step[]): Step[] {
  return [...NEW_THREAD, ...parentTurn([SPAWN_STARTED, spawnCompleted(), ...body], finish)]
}

function waited(status: string, message: string | null = null): Step {
  return completed(PARENT, TURN, collab('w1', 'wait', { status: 'completed', receiverThreadIds: [CHILD], agentsStates: { [CHILD]: { status, message } } }))
}

// ---- c1: a recorded exchange replays into threads ----

describe('a Codex subagent (multi-agent v1) replays into a thread (c1)', () => {
  it("opens a thread on the spawn call, files the subagent's work and approvals in it, and settles it when its turn ends", async () => {
    const target = await rig(V1_EXCHANGE)

    await target.adapter.send('Read the notes with a subagent')

    const inChild = (itemId: string, text: string, outcome: Outcome): ChatItem =>
      tool(`${CHILD_TURN}:${itemId}`, 'command', { command: text, cwd: REPO }, { ...outcome, threadId: THREAD_ID })
    expect(transcript(target)).toEqual([
      { id: `${TURN}:m1`, at: AT, kind: 'assistant_text', text: 'I will ask a subagent to read the notes.' },
      spawnCall(RUNNING),
      threadItem('running'),
      spawnCall({ status: 'completed', resultSummary: 'Completed' }),
      inChild('cc1', 'cat notes.txt', RUNNING),
      inChild('cc1', 'cat notes.txt', { status: 'completed', resultSummary: 'Exit code 0\nalpha' }),
      inChild('cc2', 'echo alpha > summary.txt', RUNNING),
      {
        id: 'approval_n1',
        at: AT,
        kind: 'approval_request',
        requestId: 'n1',
        category: 'command',
        tool: 'shell',
        summary: 'Run: echo alpha > summary.txt',
        input: { command: 'echo alpha > summary.txt', cwd: REPO },
        threadId: THREAD_ID,
        threadLabel: SPAWN_PROMPT
      },
      inChild('cc2', 'echo alpha > summary.txt', { status: 'completed', resultSummary: 'Exit code 0' }),
      { id: `${CHILD_TURN}:cm1`, at: AT, kind: 'assistant_text', text: 'The first line is alpha.', threadId: THREAD_ID },
      threadItem('done'),
      tool(`${TURN}:w1`, 'wait', {}, RUNNING),
      tool(`${TURN}:w1`, 'wait', {}, { status: 'completed', resultSummary: 'The first line is alpha.' }),
      { id: `${TURN}:m2`, at: AT, kind: 'assistant_text', text: 'The subagent found alpha.' }
    ])
    expect(target.events.filter((event) => event.type === 'assistant_delta')).toEqual([
      { type: 'assistant_delta', itemId: `${CHILD_TURN}:cm1`, delta: 'The first line is ', threadId: THREAD_ID },
      { type: 'assistant_delta', itemId: `${CHILD_TURN}:cm1`, delta: 'alpha.', threadId: THREAD_ID }
    ])
    expect(target.transport.remaining()).toEqual([])
  })
})

describe('a Codex subagent (multi-agent v2) replays into a thread (c1)', () => {
  it("opens the thread on the started activity, labels it with the agent path and settles it with the subagent's turn", async () => {
    const target = await rig(V2_EXCHANGE)

    await target.adapter.send('List the files with a subagent')

    const spawnId = `${TURN}:call_2`
    const threadId = `codex_thread_${spawnId}`
    const thread = (state: ThreadItem['state']): ChatItem => ({ id: threadId, at: AT, kind: 'thread', parentItemId: spawnId, label: 'read_notes', state })
    const ls = (outcome: Outcome): ChatItem => tool(`${CHILD_V2_TURN}:vc1`, 'command', { command: 'ls', cwd: REPO }, { ...outcome, threadId })
    expect(transcript(target)).toEqual([
      tool(spawnId, 'spawn_agent', { agent: AGENT_PATH }, { status: 'completed', resultSummary: null }),
      thread('running'),
      ls(RUNNING),
      ls({ status: 'completed', resultSummary: 'Exit code 0\nnotes.txt' }),
      { id: `${CHILD_V2_TURN}:vm1`, at: AT, kind: 'assistant_text', text: 'Only notes.txt is here.', threadId },
      thread('done'),
      { id: `${TURN}:m1`, at: AT, kind: 'assistant_text', text: 'Done.' }
    ])
    expect(target.transport.remaining()).toEqual([])
  })
})

// ---- How a thread ends ----

describe("how a thread ends: the subagent's own turns", () => {
  it('follows the subagent: failed or interrupted ends the thread, and a new turn runs it again', async () => {
    const target = await rig(
      spawned([
        turnCompleted(CHILD, CHILD_TURN, 'failed'),
        turnStarted(CHILD, 'turn_child_2'),
        turnCompleted(CHILD, 'turn_child_2', 'interrupted'),
        turnStarted(CHILD, 'turn_child_3'),
        turnCompleted(CHILD, 'turn_child_3', 'completed')
      ])
    )

    await target.adapter.send('go')

    expect(states(target, THREAD_ID)).toEqual(['running', 'failed', 'running', 'failed', 'running', 'done'])
  })

  it('ignores a turn change that says nothing about how the turn went', async () => {
    const target = await rig(spawned([step.notify('turn/completed', { threadId: CHILD, turn: { id: CHILD_TURN } })]))

    await target.adapter.send('go')

    expect(states(target, THREAD_ID)).toEqual(['running'])
  })
})

describe('how a thread ends: the spawn and the status Codex reports', () => {
  it('fails the thread of a spawn that did not start a subagent', async () => {
    const target = await rig([
      ...NEW_THREAD,
      ...parentTurn([SPAWN_STARTED, completed(PARENT, TURN, collab('s1', 'spawnAgent', { status: 'failed', prompt: SPAWN_PROMPT }))])
    ])

    await target.adapter.send('go')

    expect(transcript(target)).toEqual([
      spawnCall(RUNNING),
      threadItem('running'),
      spawnCall({ status: 'failed', resultSummary: 'Failed' }),
      threadItem('failed')
    ])
  })

  it('opens the thread from the finished spawn call when it never saw the call start', async () => {
    const target = await rig([...NEW_THREAD, ...parentTurn([spawnCompleted()])])

    await target.adapter.send('go')

    expect(transcript(target)).toEqual([spawnCall({ status: 'completed', resultSummary: 'Completed' }), threadItem('running')])
  })

  it('takes the end of a subagent from the status a wait or a close reports for it', async () => {
    const closed = completed(PARENT, TURN, collab('x1', 'closeAgent', { status: 'completed', receiverThreadIds: [CHILD], agentsStates: { [CHILD]: { status: 'shutdown', message: null } } }))
    const target = await rig(spawned([waited('errored', 'The model gave up.'), closed]))

    await target.adapter.send('go')

    expect(states(target, THREAD_ID)).toEqual(['running', 'failed'])
    expect(transcript(target)).toContainEqual(tool(`${TURN}:w1`, 'wait', {}, { status: 'completed', resultSummary: 'The model gave up.' }))
  })

  it('counts a subagent whose status is completed as done, and leaves one that is still working', async () => {
    const target = await rig(spawned([waited('running'), waited('pendingInit'), waited('completed')]))

    await target.adapter.send('go')

    expect(states(target, THREAD_ID)).toEqual(['running', 'done'])
  })

  it('ends a v2 thread when the subagent is interrupted, and ignores activity for a subagent it never saw start', async () => {
    const target = await rig([
      ...NEW_THREAD,
      ...parentTurn([
        completed(PARENT, TURN, activity('call_2', 'started', CHILD_V2)),
        completed(PARENT, TURN, activity('subagent-completed-x', 'completed', 'thr_stranger')),
        completed(PARENT, TURN, activity('call_3', 'interacted', CHILD_V2)),
        completed(PARENT, TURN, activity('call_4', 'interrupted', CHILD_V2))
      ])
    ])

    await target.adapter.send('go')

    expect(states(target, `codex_thread_${TURN}:call_2`)).toEqual(['running', 'failed'])
    expect(transcript(target).filter((item) => item.kind === 'tool_call').map((item) => item.id)).toEqual([`${TURN}:call_2`])
  })
})

describe('how a thread ends: the process', () => {
  it('fails the threads still running when the program dies', async () => {
    const target = await rig(spawned([], [step.exit('codex crashed')]))

    await expect(target.adapter.send('go')).rejects.toThrow('codex crashed')

    expect(states(target, THREAD_ID)).toEqual(['running', 'failed'])
  })

  it('fails the threads still running when a rejected login makes the adapter let the process go', async () => {
    const error = { message: 'Please sign in again.', codexErrorInfo: 'unauthorized', additionalDetails: null }
    const target = await rig(spawned([], [step.notify('turn/completed', { threadId: PARENT, turn: { id: TURN, items: [], status: 'failed', error } })]))

    await target.adapter.send('go')

    expect(states(target, THREAD_ID)).toEqual(['running', 'failed'])
    expect(transcript(target).some((item) => item.kind === 'auth_required')).toBe(true)
    expect(target.transport.kills).toBe(1)
  })
})

// ---- Nesting, strangers, names and the other collab tools ----

describe('subagents that start subagents', () => {
  it("opens the nested thread inside the subagent's own, with its approvals labelled", async () => {
    const target = await rig(
      spawned([
        started(CHILD, CHILD_TURN, collab('g1', 'spawnAgent', { senderThreadId: CHILD, prompt: 'Check line two' })),
        completed(CHILD, CHILD_TURN, collab('g1', 'spawnAgent', { status: 'completed', senderThreadId: CHILD, prompt: 'Check line two', receiverThreadIds: [GRANDCHILD] })),
        started(GRANDCHILD, GRANDCHILD_TURN, command('gc1', 'sed -n 2p notes.txt')),
        ...askCommand(300, { threadId: GRANDCHILD, turnId: GRANDCHILD_TURN, itemId: 'gc1' }, 'sed -n 2p notes.txt', 'accept'),
        turnCompleted(GRANDCHILD, GRANDCHILD_TURN, 'completed')
      ])
    )

    await target.adapter.send('go')

    const nested = `codex_thread_${CHILD_TURN}:g1`
    const items = transcript(target)
    const spawn = tool(`${CHILD_TURN}:g1`, 'spawn_agent', { prompt: 'Check line two' }, { ...RUNNING, threadId: THREAD_ID })
    const sed = tool(`${GRANDCHILD_TURN}:gc1`, 'command', { command: 'sed -n 2p notes.txt', cwd: REPO }, { ...RUNNING, threadId: nested })
    expect(items).toContainEqual(spawn)
    expect(items).toContainEqual({ id: nested, at: AT, kind: 'thread', parentItemId: `${CHILD_TURN}:g1`, label: 'Check line two', state: 'running', threadId: THREAD_ID })
    expect(items).toContainEqual(sed)
    expect(items).toContainEqual(expect.objectContaining({ kind: 'approval_request', threadId: nested, threadLabel: 'Check line two' }))
    expect(states(target, nested)).toEqual(['running', 'done'])
  })
})

describe('what is not a subagent of this chat', () => {
  it("drops the notifications of a thread nobody announced and raises its approval requests in the chat's own thread", async () => {
    const target = await rig([
      ...NEW_THREAD,
      ...parentTurn([
        completed('thr_stranger', 'turn_s', message('x', 'not mine')),
        turnStarted('thr_stranger', 'turn_s'),
        turnCompleted('thr_stranger', 'turn_s', 'failed'),
        ...askCommand(400, { threadId: 'thr_stranger', turnId: 'turn_s', itemId: 'sc1' }, 'ls', 'accept')
      ])
    ])

    await target.adapter.send('go')

    expect(transcript(target)).toEqual([
      { id: 'approval_n1', at: AT, kind: 'approval_request', requestId: 'n1', category: 'command', tool: 'shell', summary: 'Run: ls', input: { command: 'ls', cwd: REPO } }
    ])
  })
})

describe('items that say too little', () => {
  it('ignores a thread item that is not an item with an id, and a v2 activity that names no subagent', async () => {
    const target = await rig([
      ...NEW_THREAD,
      ...parentTurn([
        step.notify('item/completed', { threadId: PARENT, turnId: TURN, item: 'oops' }),
        completed(PARENT, TURN, { type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed' }),
        completed(PARENT, TURN, { type: 'subAgentActivity', id: 'a1', kind: 'started', agentPath: '/root/x' })
      ])
    ])

    await target.adapter.send('go')

    expect(threads(target)).toEqual([])
  })

  it('reads only the ids in a list of receivers, and none when it is not a list', async () => {
    const withReceivers = (receiverThreadIds: Json): Step =>
      completed(PARENT, TURN, { ...(collab('s1', 'spawnAgent', { status: 'completed', prompt: SPAWN_PROMPT }) as Record<string, Json>), receiverThreadIds })
    const listed = await rig([...NEW_THREAD, ...parentTurn([withReceivers(['', CHILD]), turnCompleted(CHILD, CHILD_TURN, 'completed')])])
    const unlisted = await rig([...NEW_THREAD, ...parentTurn([withReceivers('oops')])])

    await listed.adapter.send('go')
    await unlisted.adapter.send('go')

    expect(states(listed, THREAD_ID)).toEqual(['running', 'done'])
    expect(states(unlisted, THREAD_ID)).toEqual(['running', 'failed'])
  })
})

describe('a subagent the agent resumes', () => {
  const resumed = (child: string): Step =>
    completed(PARENT, TURN, collab('r1', 'resumeAgent', { status: 'completed', receiverThreadIds: [child], agentsStates: { [child]: { status: 'running', message: null } } }))

  it('opens a thread for a subagent this process never saw spawned, and files its work in it', async () => {
    const target = await rig([
      ...NEW_THREAD,
      ...parentTurn([resumed('thr_old'), completed('thr_old', 'turn_old', message('om1', 'Back again.')), turnCompleted('thr_old', 'turn_old', 'completed')])
    ])

    await target.adapter.send('go')

    const id = `codex_thread_${TURN}:r1`
    const thread = (state: ThreadItem['state']): ChatItem => ({ id, at: AT, kind: 'thread', parentItemId: `${TURN}:r1`, label: 'Subagent', state })
    expect(transcript(target)).toEqual([
      tool(`${TURN}:r1`, 'resume_agent', {}, { status: 'completed', resultSummary: 'Completed' }),
      thread('running'),
      { id: 'turn_old:om1', at: AT, kind: 'assistant_text', text: 'Back again.', threadId: id },
      thread('done')
    ])
  })

  it('opens no second thread for a subagent it already knows', async () => {
    const target = await rig(spawned([resumed(CHILD)]))

    await target.adapter.send('go')

    expect(threads(target).map((item) => item.id)).toEqual([THREAD_ID])
  })
})

describe('what a thread is called', () => {
  async function labelOf(prompt: string | null, agentPath?: string): Promise<string | undefined> {
    const spawn =
      agentPath === undefined
        ? [started(PARENT, TURN, collab('s1', 'spawnAgent', { prompt }))]
        : [completed(PARENT, TURN, activity('s1', 'started', CHILD, agentPath))]
    const target = await rig([...NEW_THREAD, ...parentTurn(spawn)])
    await target.adapter.send('go')
    return threads(target)[0]?.label
  }

  it("is the first line of the subagent's task, cut short", async () => {
    expect(await labelOf('  \n  Summarize the notes.\nThen stop.')).toBe('Summarize the notes.')
    expect(await labelOf('x'.repeat(130))).toBe(`${'x'.repeat(120)}…`)
  })

  it('is Subagent when the task says nothing, and the last part of the agent path for a v2 agent', async () => {
    expect(await labelOf(null)).toBe('Subagent')
    expect(await labelOf('   ')).toBe('Subagent')
    expect(await labelOf(null, '/root/explore_tests')).toBe('explore_tests')
    expect(await labelOf(null, '/')).toBe('Subagent')
  })
})

describe('the tools a Codex agent uses to work with its subagents', () => {
  it('shows each as a tool call in the thread of whoever used it, named like the tool', async () => {
    const target = await rig(
      spawned([
        completed(PARENT, TURN, collab('t1', 'sendInput', { status: 'completed', receiverThreadIds: [CHILD], prompt: 'Also check b.txt', model: 'gpt-5' })),
        completed(PARENT, TURN, collab('t2', 'followupTask', { status: 'interrupted', receiverThreadIds: [CHILD] })),
        completed(PARENT, TURN, collab('t3', 'listAgents', { status: 'failed' }))
      ])
    )

    await target.adapter.send('go')

    const calls = transcript(target).filter((item) => item.kind === 'tool_call' && item.id !== SPAWN_ID)
    const failed: Outcome = { status: 'failed', resultSummary: 'Failed' }
    expect(calls).toEqual([
      tool(`${TURN}:t1`, 'send_input', { prompt: 'Also check b.txt', model: 'gpt-5' }, { status: 'completed', resultSummary: 'Completed' }),
      tool(`${TURN}:t2`, 'followup_task', {}, failed),
      tool(`${TURN}:t3`, 'list_agents', {}, failed)
    ])
  })
})

describe('live work the idle stop must leave alone', () => {
  it('counts a subagent thread that is still running after the chat\'s own turn ended, until its turn ends', async () => {
    const target = await rig(spawned([]))
    expect(target.adapter.hasLiveWork()).toBe(false)

    await target.adapter.send('go')
    expect(target.adapter.hasLiveWork()).toBe(true)

    target.transport.say(turnCompleted(CHILD, CHILD_TURN, 'completed'))
    await Promise.resolve()

    expect(states(target, THREAD_ID)).toEqual(['running', 'done'])
    expect(target.adapter.hasLiveWork()).toBe(false)
  })

  it('has none once the process is gone or the chat is disposed', async () => {
    const crashed = await rig(spawned([], [step.exit('codex crashed')]))
    await expect(crashed.adapter.send('go')).rejects.toThrow('codex crashed')
    expect(crashed.adapter.hasLiveWork()).toBe(false)

    const disposed = await rig(spawned([]))
    await disposed.adapter.send('go')
    await disposed.adapter.dispose()
    expect(disposed.adapter.hasLiveWork()).toBe(false)
  })
})
