/**
 * The idle stop, on the app's own clock (10 minutes) and timers: it measures how long the agent has really done
 * nothing, and never stops an agent that still reports work going on. On 2026-10-06 an orchestrator chat that
 * had handed tickets to background subagents was stopped 10 minutes after its own last turn, every time, and its
 * workers with it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, ChatRecord } from '../../shared/agents/chat'
import { AT, fakeAdapters, memoryChatFs, memoryChatStore, REPO, type FakeAdapters, type FakeChatAdapter } from './__mocks__/fakeChatAdapter'
import { createSessionManager, type SessionManager } from './sessionManager'

const MINUTE = 60_000

interface Rig {
  manager: SessionManager
  fakes: FakeAdapters
}

/** A manager on the default idle time and the real timer functions, which the tests fake. */
function rig(): Rig {
  const fakes = fakeAdapters()
  let itemCount = 0
  const manager = createSessionManager({
    store: memoryChatStore(memoryChatFs()),
    adapters: fakes.definitions,
    executablePath: (kind) => `/bin/${kind}`,
    mcpConfig: (folder) => ({ command: 'node', args: ['/app/out/main/mcp.js', '--repo', folder], env: {} }),
    push: () => {},
    newId: () => `item_i${(itemCount += 1)}`,
    now: () => AT
  })
  return { manager, fakes }
}

/** Lets every queued promise callback run (setImmediate is left real). */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function newChat(manager: SessionManager): ChatRecord {
  return manager.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator', title: 'Run the epic' })
}

/** A chat whose turn handed work to a background subagent and has ended: the idle clock runs from here. */
async function afterTurn(state: Rig): Promise<{ chat: ChatRecord; adapter: FakeChatAdapter }> {
  const chat = newChat(state.manager)
  await state.manager.send(chat, 'Dispatch the workers')
  await settle()
  return { chat, adapter: state.fakes.created[0] as FakeChatAdapter }
}

/** A call a background subagent makes, long after the turn that started it ended. */
const backgroundCall = (id: string): ChatItem => ({
  id,
  at: AT,
  kind: 'tool_call',
  name: 'Bash',
  input: { command: 'npm test' },
  status: 'running',
  resultSummary: null,
  threadId: 'claude_thread_toolu_worker'
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('session manager: the idle stop measures real inactivity', () => {
  it('stops an agent with nothing going on 10 minutes after its turn ended, not before', async () => {
    const state = rig()
    const { adapter } = await afterTurn(state)

    vi.advanceTimersByTime(10 * MINUTE - 1)
    expect(adapter.disposals).toBe(0)
    vi.advanceTimersByTime(1)
    await settle()

    expect(adapter.disposals).toBe(1)
    expect(state.manager.liveCount()).toBe(0)
  })

  it('pushes the stop back when a background item arrives 9 minutes after the turn ended', async () => {
    const state = rig()
    const { adapter } = await afterTurn(state)

    vi.advanceTimersByTime(9 * MINUTE)
    adapter.emit({ type: 'item', item: backgroundCall('c1') })
    vi.advanceTimersByTime(9 * MINUTE)
    await settle()
    expect(adapter.disposals).toBe(0)
    expect(state.manager.liveCount()).toBe(1)

    vi.advanceTimersByTime(MINUTE)
    await settle()
    expect(adapter.disposals).toBe(1)
  })

  it('pushes the stop back on streamed text and on a request an earlier Allow for this chat answers', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    state.fakes.prepare = (fake) => {
      fake.turn = async (self) => {
        await self.ask('q1')
      }
    }
    await state.manager.send(chat, 'Dispatch the workers')
    await settle()
    state.manager.answerApproval(chat, { requestId: 'q1', decision: 'allow_chat' })
    await settle()
    const adapter = state.fakes.created[0] as FakeChatAdapter

    vi.advanceTimersByTime(9 * MINUTE)
    adapter.emit({ type: 'assistant_delta', itemId: 'msg_w', delta: 'Still testing', threadId: 'claude_thread_toolu_worker' })
    vi.advanceTimersByTime(9 * MINUTE)
    const answered = adapter.ask('q2')
    vi.advanceTimersByTime(9 * MINUTE)
    await settle()

    expect(adapter.disposals).toBe(0)
    expect(await answered).toBe('allow_chat')
    vi.advanceTimersByTime(MINUTE)
    await settle()
    expect(adapter.disposals).toBe(1)
  })
})

describe('session manager: the idle stop leaves live work alone', () => {
  it('keeps an agent that reports a running call or background subagent past 10 idle minutes, and stops it once that ends', async () => {
    const state = rig()
    state.fakes.prepare = (fake) => {
      fake.liveWork = true
    }
    const { adapter } = await afterTurn(state)

    vi.advanceTimersByTime(60 * MINUTE)
    await settle()
    expect(adapter.disposals).toBe(0)
    expect(state.manager.liveCount()).toBe(1)

    adapter.liveWork = false
    vi.advanceTimersByTime(10 * MINUTE)
    await settle()
    expect(adapter.disposals).toBe(1)
  })
})
