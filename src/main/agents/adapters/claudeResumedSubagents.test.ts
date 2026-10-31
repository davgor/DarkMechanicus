/**
 * A subagent the agent continues with SendMessage. On 2026-10-06 six resumed workers were marked failed at the
 * end of the orchestrator's next turn while they went on working, and later submitted work that was accepted.
 *
 * Built from what the real stream carries: the resumed subagent's messages name the call that first spawned it
 * as their parent (the stored transcript of that day has them on the first thread's id, reopened by a new
 * process), SendMessage's answer names the agent it resumed (`resumedAgentId`, also in that transcript), and the
 * SDK registers a resumed subagent in the background. Not seen: which call the resumed task's own `task_started`
 * and `task_notification` name; the SendMessage call, the first spawn and none are all tried.
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { SESSION, assistant, init, message, startRig, success, text, toolResult, toolUse, uuid, type Rig } from './__mocks__/fakeClaudeSdk'

const SPAWN = 'toolu_01WEpkLAV3Ywbn4eTdxnzFBE'
const AGENT = 'a03b01ef5551e82fb'
const SEND = 'toolu_01ByFEmoiGRT2EE4qNfHwH3t'
const THREAD = `claude_thread_${SPAWN}`

type ThreadItem = Extract<ChatItem, { kind: 'thread' }>

const spawn = (background: boolean): SDKMessage =>
  assistant('msg_spawn', [toolUse(SPAWN, 'Agent', { description: 'Worker DM-138 History tab', prompt: 'Do DM-138.', run_in_background: background })])

const taskStarted = (toolUseId: string | undefined, background: boolean): SDKMessage =>
  message({
    type: 'system',
    subtype: 'task_started',
    task_id: AGENT,
    ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
    description: 'Worker DM-138 History tab',
    is_backgrounded: background,
    session_id: SESSION,
    uuid: uuid()
  })

const taskEnded = (toolUseId: string | undefined, status = 'completed'): SDKMessage =>
  message({
    type: 'system',
    subtype: 'task_notification',
    task_id: AGENT,
    ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
    status,
    output_file: '/tmp/out',
    summary: 'DM-138 submitted.',
    session_id: SESSION,
    uuid: uuid()
  })

const launched = (): SDKMessage => toolResult(SPAWN, 'Async agent launched successfully.', false, { tool_use_result: { isAsync: true, status: 'async_launched', agentId: AGENT } })

const waitedFor = (): SDKMessage =>
  toolResult(SPAWN, 'Report.', false, { tool_use_result: { status: 'completed', agentId: AGENT, content: [{ type: 'text', text: 'Stopped before submitting.' }] } })

const sendMessage = (to = AGENT): SDKMessage =>
  assistant('msg_send', [toolUse(SEND, 'SendMessage', { to, summary: 'Resume DM-138 on new claim', message: 'Resume DM-138.' })])

/** SendMessage's answer, as the stored transcript of 2026-10-06 has it. */
const resumed = (): SDKMessage =>
  toolResult(SEND, JSON.stringify({ success: true, message: 'Resuming agent a03b01e', resumedAgentId: AGENT }), false, {
    tool_use_result: { success: true, message: 'Resuming agent a03b01e', resumedAgentId: AGENT }
  })

const worker = (messageId: string, words: string, extra: object = {}): SDKMessage => assistant(messageId, [text(words)], { parent_tool_use_id: SPAWN, ...extra })

/** The states the thread went through, in order. */
const states = (rig: Rig): string[] =>
  rig
    .items()
    .filter((item): item is ThreadItem => item.kind === 'thread' && item.id === THREAD)
    .map((item) => item.state)

/** A rig whose turns play `turns` in order; later messages are sent by the test through `later`. */
async function chat(...turns: SDKMessage[][]): Promise<Rig & { later: (...more: SDKMessage[]) => void }> {
  const rig = await startRig({ plans: [{ script: ({ index, emit }) => emit(...(index === 0 ? [init()] : []), ...(turns[index] ?? []), success(`turn ${index}`)) }] })
  return { ...rig, later: (...more) => rig.sdk.launches[0]?.emit(...more) }
}

describe('Claude adapter: a background subagent continued with SendMessage', () => {
  it.each([
    ['the SendMessage call', SEND],
    ['the call that first spawned it', SPAWN],
    ['no call', undefined]
  ])('runs its thread again, files its work there, keeps it past the turn, and ends it by a notification naming %s', async (_name, named) => {
    const rig = await chat([spawn(true), taskStarted(SPAWN, true), launched()], [sendMessage(), resumed(), taskStarted(named, true), worker('msg_w1', 'Picking DM-138 up.')])
    await rig.adapter.send('Dispatch DM-138')
    rig.later(taskEnded(SPAWN))
    await vi.waitFor(() => expect(states(rig)).toEqual(['running', 'done']))

    await rig.adapter.send('Resume DM-138')

    expect(states(rig)).toEqual(['running', 'done', 'running'])
    expect(rig.items().find((item) => item.id === 'claude_msg_w1_0')).toMatchObject({ threadId: THREAD })
    rig.later(taskEnded(named))
    await vi.waitFor(() => expect(states(rig)).toEqual(['running', 'done', 'running', 'done']))
  })
})

describe('Claude adapter: a subagent its call waited for, continued with SendMessage', () => {
  it('runs its thread again in the background: the next turn ends without failing it, and its notification ends it', async () => {
    const rig = await chat([spawn(false), taskStarted(SPAWN, false), waitedFor()], [sendMessage(), resumed()])
    await rig.adapter.send('Do DM-138 and wait for it')
    expect(states(rig)).toEqual(['running', 'done'])

    await rig.adapter.send('Resume DM-138')
    rig.later(worker('msg_w2', 'Submitting now.'))
    await vi.waitFor(() => expect(rig.items().some((item) => item.id === 'claude_msg_w2_0')).toBe(true))

    expect(states(rig)).toEqual(['running', 'done', 'running'])
    expect(rig.adapter.hasLiveWork()).toBe(true)
    rig.later(taskEnded(SEND))
    await vi.waitFor(() => expect(states(rig)).toEqual(['running', 'done', 'running', 'done']))
  })

  it('leaves the thread as it was when SendMessage fails', async () => {
    const failed = toolResult(SEND, 'No agent with that id is running.', true)
    const rig = await chat([spawn(false), waitedFor()], [sendMessage(), failed])
    await rig.adapter.send('Do DM-138 and wait for it')

    await rig.adapter.send('Resume DM-138')

    expect(states(rig)).toEqual(['running', 'done'])
  })
})

describe('Claude adapter: a subagent continued in a process that never saw it spawned', () => {
  it('keeps the thread it opens for it running past the end of the turn, and ends it by the agent SendMessage resumed', async () => {
    const rig = await chat([sendMessage(), resumed(), worker('msg_w3', 'Picking DM-138 up.', { task_description: 'Worker DM-138 History tab' })])

    await rig.adapter.send('Resume DM-138')

    expect(states(rig)).toEqual(['running'])
    expect(rig.items().find((item) => item.id === THREAD)).toMatchObject({ label: 'Worker DM-138 History tab', parentItemId: `claude_tool_${SPAWN}` })
    rig.later(taskEnded(SEND))
    await vi.waitFor(() => expect(states(rig)).toEqual(['running', 'done']))
  })

  it('keeps a thread opened for traffic of a subagent it never saw spawned running when no SendMessage names it', async () => {
    const rig = await chat([worker('msg_w4', 'Still at it.')])

    await rig.adapter.send('How is it going?')

    expect(states(rig)).toEqual(['running'])
  })
})
