/**
 * An `auth_required` item says whether a turn was waiting to be sent again when it was stored (`cutShort`),
 * so a chat that shows it live offers Retry only when `retryTurn` has a message to send. The chat record's
 * `cutShortMessageId` is what `retryTurn` reads, and what the item reports.
 */
import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatRecord } from '../../shared/agents/chat'
import type { ChatPushEvent } from '../../shared/agents/chatApi'
import type { AgentAuthStatus } from '../../shared/desktop/api'
import { AT, fakeAdapters, memoryChatStore, REPO, type FakeAdapters } from './__mocks__/fakeChatAdapter'
import { createSessionManager, type SessionManager } from './sessionManager'

const SIGNED_IN: AgentAuthStatus = { state: 'signed_in', reason: 'Claude Code reports it is signed in.' }

interface World {
  manager: SessionManager
  fakes: FakeAdapters
  events: ChatPushEvent[]
  store: ReturnType<typeof memoryChatStore>
  chat: ChatRecord
}

function world(): World {
  const fakes = fakeAdapters()
  const events: ChatPushEvent[] = []
  const store = memoryChatStore()
  const manager = createSessionManager({
    store,
    adapters: fakes.definitions,
    executablePath: (kind) => `/bin/${kind}`,
    mcpConfig: (folder) => ({ command: 'node', args: ['mcp.js', '--repo', folder], env: {} }),
    push: (event) => events.push(event),
    now: () => AT
  })
  const chat = manager.createChat({ folder: REPO, agent: 'claude', role: 'planner', title: 'Plan' })
  return { manager, fakes, events, store, chat }
}

const signedOut = (id: string): ChatItem => ({ id, at: AT, kind: 'auth_required', agent: 'claude', message: 'Not logged in · Please run /login' })

/** The first turn is cut short by the CLI; later turns settle normally. */
function cutShortOnce(fakes: FakeAdapters): void {
  let turns = 0
  fakes.prepare = (adapter) => {
    adapter.turn = (self) => {
      turns += 1
      if (turns === 1) {
        self.emit({ type: 'item', item: signedOut('a1') })
      }
      return Promise.resolve()
    }
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

const authItems = (items: readonly ChatItem[]): ChatItem[] => items.filter((item) => item.kind === 'auth_required')
const pushedAuth = (events: readonly ChatPushEvent[]): ChatItem[] => authItems(events.flatMap((event) => (event.type === 'item' ? [event.item] : [])))

describe('session manager: whether a sign-in cut a turn short', () => {
  it('says so on the item stored and pushed for a turn the sign-in cut short', async () => {
    const { manager, fakes, store, events, chat } = world()
    cutShortOnce(fakes)

    await manager.send(chat, 'Run the sprint')
    await settle()

    expect(authItems(store.readTranscript(chat)?.items ?? [])).toEqual([expect.objectContaining({ cutShort: true })])
    expect(pushedAuth(events)).toEqual([expect.objectContaining({ cutShort: true })])
  })

  it('says it cut nothing short when the CLI reports the lost sign-in outside a turn, and there is nothing to retry', async () => {
    const { manager, fakes, store, events, chat } = world()
    await manager.send(chat, 'finished fine')
    await settle()

    fakes.created[0]?.emit({ type: 'item', item: signedOut('late') })

    expect(authItems(store.readTranscript(chat)?.items ?? [])).toEqual([expect.objectContaining({ cutShort: false })])
    expect(pushedAuth(events)).toEqual([expect.objectContaining({ cutShort: false })])
    expect(store.getChat(chat)?.cutShortMessageId ?? null).toBeNull()
    manager.reconcileAuthStatus('claude', SIGNED_IN)
    await expect(manager.retryTurn(chat)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('says a turn was cut short on the item of a turn that was refused because the agent is signed out', async () => {
    const { manager, fakes, store, events } = world()
    const second = manager.createChat({ folder: REPO, agent: 'claude', role: 'planner', title: 'Second' })
    const first = manager.createChat({ folder: REPO, agent: 'claude', role: 'planner', title: 'First' })
    cutShortOnce(fakes)
    await manager.send(first, 'go')
    await settle()

    await manager.send(second, 'Do the other thing')

    expect(authItems(store.readTranscript(second)?.items ?? [])).toEqual([expect.objectContaining({ cutShort: true })])
    expect(pushedAuth(events).map((item) => item.kind === 'auth_required' && item.cutShort)).toEqual([true, true])
    expect(store.getChat(second)?.cutShortMessageId).not.toBeNull()
  })
})
