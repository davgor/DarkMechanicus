/**
 * The Cursor adapter and the subagents Cursor starts (DM-97). Cursor's ACP tells the client that a
 * subagent task exists (`cursor/task`) but not what the subagent does, so the adapter keeps everything
 * in the chat's own thread. The exchanges are built from Cursor's documentation, not captured from a
 * running Cursor; `__mocks__/cursorSubagents.ts` says which pages.
 */
import { describe, expect, it } from 'vitest'
import type { ChatAdapterEvent } from '../../../shared/agents/chat'
import { CLIENT_VERSION, DM_SERVER, FOLDER } from '../__mocks__/cursorRecordings'
import { SESSION, TASK_AS_NOTIFICATION, TASK_AS_REQUEST, TASK_CALL, TASK_RESULT } from '../__mocks__/cursorSubagents'
import { ReplayAcpAgents, type Frame } from '../__mocks__/replayAcpAgent'
import { createCursorAdapter, type CursorDeps } from './cursor'

const AT = '2026-01-01T00:00:00.000Z'

async function run(recording: Frame[]): Promise<{ events: ChatAdapterEvent[]; agents: ReplayAcpAgents }> {
  const agents = new ReplayAcpAgents(recording)
  let count = 0
  const deps: CursorDeps = {
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
  const adapter = createCursorAdapter('/opt/cursor/agent', deps)
  await adapter.start({ chatId: 'chat_1', folder: FOLDER, model: null, role: 'planner', allowSave: false, sessionId: null, darkMechanicus: DM_SERVER }, (event) => events.push(event))
  await adapter.send('Where is authentication handled?')
  return { events, agents }
}

const TASK_ITEM = { id: `tool_${SESSION}_${TASK_CALL}`, at: AT, kind: 'tool_call', name: 'Explore codebase' }

describe('a Cursor turn with a subagent task keeps one thread (c1)', () => {
  it('shows the task as the tool call it is, with no thread item, and answers a task request completed', async () => {
    const { events, agents } = await run(TASK_AS_REQUEST)

    expect(agents.problems).toEqual([])
    expect(agents.finished()).toBe(true)
    expect(events).toEqual([
      { type: 'session', sessionId: SESSION },
      { type: 'assistant_delta', itemId: 'id_1', delta: 'I will have a subagent look.' },
      { type: 'item', item: { id: 'id_1', at: AT, kind: 'assistant_text', text: 'I will have a subagent look.' } },
      {
        type: 'item',
        item: {
          ...TASK_ITEM,
          input: { description: 'Explore codebase', prompt: 'Find where authentication is handled and report the file paths.', subagentType: 'explore' },
          status: 'running',
          resultSummary: null
        }
      },
      {
        type: 'item',
        item: {
          ...TASK_ITEM,
          input: { description: 'Explore codebase', prompt: 'Find where authentication is handled and report the file paths.', subagentType: 'explore' },
          status: 'completed',
          resultSummary: TASK_RESULT
        }
      },
      { type: 'assistant_delta', itemId: 'id_2', delta: TASK_RESULT },
      { type: 'item', item: { id: 'id_2', at: AT, kind: 'assistant_text', text: TASK_RESULT } }
    ])
  })

  it('files every item in the chat\'s own thread: none carries a thread id, and no item or event opens a thread', async () => {
    for (const recording of [TASK_AS_REQUEST, TASK_AS_NOTIFICATION]) {
      const { events } = await run(recording)

      const items = events.flatMap((event) => (event.type === 'item' ? [event.item] : []))
      expect(items.length).toBeGreaterThan(0)
      expect(items.filter((item) => item.kind === 'thread')).toEqual([])
      expect(events.filter((event) => 'threadId' in event || (event.type === 'item' && 'threadId' in event.item))).toEqual([])
    }
  })

  it('says nothing back when Cursor sends the task as a notification, as its page documents', async () => {
    const { events, agents } = await run(TASK_AS_NOTIFICATION)

    expect(agents.problems).toEqual([])
    expect(agents.finished()).toBe(true)
    expect(events.filter((event) => event.type === 'item')).toHaveLength(4)
  })
})
