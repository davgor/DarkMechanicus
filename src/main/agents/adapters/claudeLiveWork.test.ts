/**
 * What the Claude adapter reports as live work, so the session manager's idle stop never kills a process that
 * still runs something: a turn, a turn the CLI started on its own, a call still waiting for its answer, a
 * subagent thread that has not ended, or a background task (subagent or command) the CLI has not reported done.
 */
import { resolve } from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { FOLDER, NOW, SESSION, assistant, init, message, startRig, success, text, toolResult, toolUse, uuid, type Rig } from './__mocks__/fakeClaudeSdk'
import { TranscriptMapper } from './claudeTranscript'

const SPAWN = 'toolu_worker'
const AGENT = 'a0f00d0f00d0f00d1'
const BASH = 'toolu_bash'
const SHELL = 'b1x2y3z4'

const spawnInBackground = (): SDKMessage =>
  assistant('msg_spawn', [toolUse(SPAWN, 'Agent', { description: 'Worker DM-1', prompt: 'Do DM-1.', run_in_background: true })])

const launched = (): SDKMessage => toolResult(SPAWN, 'Async agent launched successfully.', false, { tool_use_result: { isAsync: true, status: 'async_launched', agentId: AGENT } })

const taskStarted = (taskId: string, toolUseId: string, extra: object = {}): SDKMessage =>
  message({ type: 'system', subtype: 'task_started', task_id: taskId, tool_use_id: toolUseId, description: 'work', is_backgrounded: true, session_id: SESSION, uuid: uuid(), ...extra })

const taskEnded = (taskId: string, toolUseId: string): SDKMessage =>
  message({ type: 'system', subtype: 'task_notification', task_id: taskId, tool_use_id: toolUseId, status: 'completed', output_file: '/tmp/out', summary: 'done', session_id: SESSION, uuid: uuid() })

/** The CLI's level signal: every live background task after a change. */
const backgroundTasks = (...tasks: { task_id: string; ambient?: boolean }[]): SDKMessage =>
  message({ type: 'system', subtype: 'background_tasks_changed', tasks: tasks.map((task) => ({ task_type: 'local_bash', description: 'work', ...task })), session_id: SESSION, uuid: uuid() })

const inside = (messageId: string, ...blocks: object[]): SDKMessage => assistant(messageId, blocks, { parent_tool_use_id: SPAWN })

/** A rig whose first turn plays `messages` and ends; what follows is sent by the test through `later`. */
async function afterTurn(...messages: SDKMessage[]): Promise<Rig & { later: (...more: SDKMessage[]) => void }> {
  const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init(), ...messages, success('ok')) }] })
  await rig.adapter.send('go')
  return { ...rig, later: (...more) => rig.sdk.launches[0]?.emit(...more) }
}

const latest = (items: readonly ChatItem[], id: string): ChatItem | undefined => items.filter((item) => item.id === id).at(-1)

describe('Claude adapter: live work (turns)', () => {
  it('has none before the first message and after a turn that finished, and has some while a turn runs', async () => {
    const rig = await startRig({ plans: [{ script: ({ emit }) => emit(init()) }] })
    expect(rig.adapter.hasLiveWork()).toBe(false)

    const turn = rig.adapter.send('go')
    await vi.waitFor(() => expect(rig.events.length).toBeGreaterThan(0))
    expect(rig.adapter.hasLiveWork()).toBe(true)

    rig.sdk.launches[0]?.emit(success('ok'))
    await turn
    expect(rig.adapter.hasLiveWork()).toBe(false)
  })

  it('counts a turn the CLI runs on its own (after a background subagent finished) until that turn\'s result', async () => {
    const rig = await afterTurn()

    rig.later(assistant('msg_self', [text('The worker finished; reviewing it now.')]))
    await vi.waitFor(() => expect(rig.items().some((item) => item.id === 'claude_msg_self_0')).toBe(true))
    expect(rig.adapter.hasLiveWork()).toBe(true)

    rig.later(success('reviewed'))
    await vi.waitFor(() => expect(rig.adapter.hasLiveWork()).toBe(false))
  })

  it('does not count a call of the main agent that its ended turn left without an answer', async () => {
    const rig = await afterTurn(assistant('msg_x', [toolUse('toolu_x', 'Bash', { command: 'ls' })]))

    expect(rig.adapter.hasLiveWork()).toBe(false)
  })
})

describe('Claude adapter: live work (background subagents)', () => {
  it('counts a background subagent until the CLI says it ended', async () => {
    const rig = await afterTurn(spawnInBackground(), taskStarted(AGENT, SPAWN), launched())
    expect(rig.adapter.hasLiveWork()).toBe(true)

    rig.later(taskEnded(AGENT, SPAWN))

    await vi.waitFor(() => expect(rig.adapter.hasLiveWork()).toBe(false))
  })

  it('counts a background subagent with a call in flight until the call is answered and the subagent ended', async () => {
    const rig = await afterTurn(spawnInBackground(), launched(), inside('msg_in', toolUse('toolu_test', 'Bash', { command: 'npm test' })))

    rig.later(toolResult('toolu_test', 'passed', false, { parent_tool_use_id: SPAWN }))
    await vi.waitFor(() => expect(latest(rig.items(), 'claude_tool_toolu_test')).toMatchObject({ status: 'completed' }))
    expect(rig.adapter.hasLiveWork()).toBe(true)

    rig.later(taskEnded(AGENT, SPAWN))
    await vi.waitFor(() => expect(rig.adapter.hasLiveWork()).toBe(false))
  })
})

describe('Claude transcript mapper: live work', () => {
  it('counts a call until its answer comes', () => {
    const mapper = new TranscriptMapper({ now: () => NOW, newId: () => 'id' })

    mapper.map(assistant('msg_c', [toolUse('toolu_c', 'Bash', { command: 'npm test' })]))
    expect(mapper.hasLiveWork()).toBe(true)
    mapper.map(toolResult('toolu_c', 'ok'))

    expect(mapper.hasLiveWork()).toBe(false)
  })
})

describe('Claude adapter: live work (background commands)', () => {
  it('counts a command started with run_in_background until its notification', async () => {
    const rig = await afterTurn(
      assistant('msg_b', [toolUse(BASH, 'Bash', { command: 'npm run fireguard', run_in_background: true })]),
      toolResult(BASH, `Command running in background with ID: ${SHELL}`),
      taskStarted(SHELL, BASH, { task_type: 'local_bash' })
    )
    expect(rig.adapter.hasLiveWork()).toBe(true)

    rig.later(taskEnded(SHELL, BASH))

    await vi.waitFor(() => expect(rig.adapter.hasLiveWork()).toBe(false))
  })

  it('takes the set of background tasks the CLI reports as the live ones, leaving out ambient tasks', async () => {
    const rig = await afterTurn(taskStarted(SHELL, BASH, { task_type: 'local_bash' }))

    rig.later(backgroundTasks({ task_id: 'watcher', ambient: true }))
    await vi.waitFor(() => expect(rig.adapter.hasLiveWork()).toBe(false))

    rig.later(backgroundTasks({ task_id: SHELL }))
    await vi.waitFor(() => expect(rig.adapter.hasLiveWork()).toBe(true))
  })

  it('does not count an ambient task the CLI starts', async () => {
    const rig = await afterTurn(taskStarted('watcher', 'toolu_watch', { ambient: true }))

    expect(rig.adapter.hasLiveWork()).toBe(false)
  })
})

describe('Claude adapter: live work (the end of the process)', () => {
  it('has none once the process is gone, and cancels the calls it left running as it fails their threads', async () => {
    const read = toolUse('toolu_read', 'Read', { file_path: resolve(FOLDER, 'a.txt') })
    const rig = await afterTurn(spawnInBackground(), taskStarted(AGENT, SPAWN), launched(), inside('msg_in', read))
    expect(rig.adapter.hasLiveWork()).toBe(true)

    rig.sdk.launches[0]?.finish(null)

    await vi.waitFor(() => expect(rig.adapter.hasLiveWork()).toBe(false))
    expect(latest(rig.items(), 'claude_tool_toolu_read')).toMatchObject({ status: 'cancelled', threadId: `claude_thread_${SPAWN}` })
    expect(latest(rig.items(), `claude_thread_${SPAWN}`)).toMatchObject({ state: 'failed' })
  })

  it('has none once disposed', async () => {
    const rig = await afterTurn(spawnInBackground(), taskStarted(AGENT, SPAWN), launched())

    await rig.adapter.dispose()

    expect(rig.adapter.hasLiveWork()).toBe(false)
  })
})
