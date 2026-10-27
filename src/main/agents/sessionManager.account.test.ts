/**
 * A problem with the person's account (the error item's `problem`) is not a lost sign-in: the session manager
 * stores it masked like any item, does not flag the agent signed out, does not pause the orchestrator's run,
 * and does not refuse the chat's next turn.
 */
import { describe, expect, it } from 'vitest'
import { createIdGenerator } from '../../core/ids'
import { ERROR_PROBLEMS, type ChatItem, type ErrorProblem } from '../../shared/agents/chat'
import type { ChatPushEvent } from '../../shared/agents/chatApi'
import type { AgentAuthStatus } from '../../shared/desktop/api'
import { AT, fakeAdapters, memoryChatStore, REPO, type FakeAdapters } from './__mocks__/fakeChatAdapter'
import { CLAIM_TOKEN_MASK } from './claimTokenMask'
import { createSessionManager, type SessionManager } from './sessionManager'

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Claude Code reports it is signed in.' }

interface World {
  manager: SessionManager
  fakes: FakeAdapters
  events: ChatPushEvent[]
  /** What the session manager asked of the run, in order. */
  runCalls: string[]
  store: ReturnType<typeof memoryChatStore>
}

function world(): World {
  const fakes = fakeAdapters()
  const events: ChatPushEvent[] = []
  const runCalls: string[] = []
  const store = memoryChatStore()
  const manager = createSessionManager({
    store,
    adapters: fakes.definitions,
    executablePath: (kind) => `/bin/${kind}`,
    mcpConfig: (folder) => ({ command: 'node', args: ['mcp.js', '--repo', folder], env: {} }),
    push: (event) => events.push(event),
    now: () => AT,
    runs: {
      getRun: (_folder, runId) => (runCalls.push(`getRun ${runId}`), Promise.resolve({ state: 'running' })),
      pauseRun: (_folder, input) => (runCalls.push(`pauseRun ${input.runId} ${input.reason}`), Promise.resolve())
    }
  })
  return { manager, fakes, events, runCalls, store }
}

/** The first turn is the CLI saying the account has `problem`, in `words`; later turns settle normally. */
function accountProblemOnce(fakes: FakeAdapters, problem: ErrorProblem, words: string): void {
  let turns = 0
  fakes.prepare = (adapter) => {
    adapter.turn = (self) => {
      turns += 1
      if (turns === 1) {
        self.emit({ type: 'item', item: { id: 'e1', at: AT, kind: 'error', message: words, problem } })
      }
      return Promise.resolve()
    }
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))
const kinds = (items: readonly ChatItem[]): string[] => items.map((item) => item.kind)

describe.each(ERROR_PROBLEMS)('session manager: an account problem (%s)', (problem) => {
  it('stores the CLI’s words with claim tokens masked and pushes the masked item, naming the problem', async () => {
    const ids = createIdGenerator(() => 1_700_000_000_000, (size) => Buffer.alloc(size, 9))
    const secret = ids.secret()
    const { manager, fakes, store, events } = world()
    accountProblemOnce(fakes, problem, `Account note for ${ids.next('attempt')}.${secret}: see your administrator.`)
    const chat = manager.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator', title: 'Fix the build' })

    await manager.send(chat, 'go')
    await settle()

    const expected = expect.objectContaining({ kind: 'error', problem, message: `Account note for ${CLAIM_TOKEN_MASK}: see your administrator.` })
    const stored = store.readTranscript(chat)?.items ?? []
    expect(stored.filter((item) => item.kind === 'error')).toEqual([expected])
    expect(events.flatMap((event) => (event.type === 'item' && event.item.kind === 'error' ? [event.item] : []))).toEqual([expected])
    expect(JSON.stringify([stored, events])).not.toContain(secret.slice(0, 8))
  })

  it('does not flag the agent signed out, tell any chat, or ask for a sign-in', async () => {
    const { manager, fakes, store, events } = world()
    accountProblemOnce(fakes, problem, 'Something is wrong with the account.')
    const chat = manager.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator', title: 'Fix the build' })
    await manager.openChat(chat)

    await manager.send(chat, 'go')
    await settle()

    expect(kinds(store.readTranscript(chat)?.items ?? [])).toEqual(['user_message', 'error'])
    expect(events.some((event) => event.type === 'agent_auth')).toBe(false)
    expect(manager.reconcileAuthStatus('claude', SIGNED_IN)).toEqual(SIGNED_IN)
    expect(store.getChat(chat)?.cutShortMessageId ?? null).toBeNull()
    await expect(manager.retryTurn(chat)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('does not pause the run of the orchestrator chat, and lets the next turn start', async () => {
    const { manager, fakes, store, runCalls } = world()
    accountProblemOnce(fakes, problem, 'Something is wrong with the account.')
    const chat = manager.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator', title: 'Run', runId: 'rn_1' })

    await manager.send(chat, 'go')
    await settle()
    await manager.send(chat, 'again')
    await settle()

    expect(runCalls).toEqual([])
    expect(kinds(store.readTranscript(chat)?.items ?? [])).toEqual(['user_message', 'error', 'user_message'])
    expect(fakes.created[0]?.sent).toEqual(['go', 'again'])
  })
})
