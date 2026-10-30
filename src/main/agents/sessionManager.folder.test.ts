/**
 * Every start of a chat's agent runs in the chat's canonical, tracked folder, checked on disk at that moment:
 * the first message, a new process after an idle stop or a model change, a process the adapter starts again
 * after a crash, and the orchestrator chat Start run opens. A folder that is gone is refused before a grant
 * is issued or an adapter created.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatItem, ChatRecord } from '../../shared/agents/chat'
import type { EpicDetailView, RunView } from '../../shared/domain/views'
import { buildCliConfig } from '../desktop/cliConfig'
import { AT, connectedAgents, fakeAdapters, memoryChatFs, memoryChatStore, type FakeAdapters } from './__mocks__/fakeChatAdapter'
import type { ChatStore } from './chatStore'
import { startOrchestratorRun } from './orchestratorStart'
import { createSessionManager, type SessionManager } from './sessionManager'

const AGAIN = 'Track the folder again to keep using this chat.'

interface Rig {
  manager: SessionManager
  store: ChatStore
  fakes: FakeAdapters
  /** The folders the chat grants were issued for, in order. */
  issued: string[]
  /** The folders the app tracks; a test untracks one by deleting it. */
  tracked: Set<string>
  fireIdle: () => void
}

let root: string
let repo: string

beforeEach(() => {
  // Canonical from the start: on macOS the temporary directory is reached through the /var symlink.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dm-chat-folder-')))
  repo = join(root, 'repo')
  mkdirSync(repo)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** A manager on the real disk for the folder check, with the store in memory so a refused folder still has its chat. */
function rig(): Rig {
  const store = memoryChatStore(memoryChatFs([repo]))
  const fakes = fakeAdapters()
  const issued: string[] = []
  const tracked = new Set([repo])
  const idle: (() => void)[] = []
  let itemCount = 0
  const manager = createSessionManager({
    store,
    adapters: fakes.definitions,
    agentFor: connectedAgents(),
    folders: { trackedFolder: (path) => (tracked.has(path) ? path : null) },
    issueChatCli: async (folder: string) => {
      issued.push(folder)
      const launch = buildCliConfig({ packaged: false, execPath: '/bin/electron', appPath: '/app', repoPath: folder })
      return { cli: { ...launch, env: { DM_SESSION_TOKEN: 'dmg_test' } }, grantId: `gr_${issued.length}` }
    },
    revokeChatGrant: async () => undefined,
    push: () => {},
    newId: () => `item_f${(itemCount += 1)}`,
    now: () => AT,
    timers: {
      set: (callback) => idle.push(callback),
      clear: () => {}
    }
  })
  const fireIdle = (): void => {
    for (const callback of idle.splice(0)) {
      callback()
    }
  }
  return { manager, store, fakes, issued, tracked, fireIdle }
}

function newChat(manager: SessionManager, agent = 'claude'): ChatRecord {
  return manager.createChat({ folder: repo, agent, role: 'orchestrator', title: 'Fix the build' })
}

function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function errorsIn(items: readonly ChatItem[]): string[] {
  return items.flatMap((item) => (item.kind === 'error' ? [item.message] : []))
}

/** Replaces the folder with a symlink to another directory: the path still resolves, to somewhere else. */
function swapForSymlink(): string {
  const elsewhere = join(root, 'elsewhere')
  mkdirSync(elsewhere)
  rmSync(repo, { recursive: true })
  symlinkSync(elsewhere, repo)
  return elsewhere
}

describe('session manager: the folder a chat starts in', () => {
  it('starts the agent in the canonical folder, with the grant and the dm command for that same folder', async () => {
    const { manager, fakes, issued } = rig()

    await manager.send(newChat(manager), 'hello')

    const started = fakes.created[0]?.started[0]
    expect(started?.folder).toBe(repo)
    expect(issued).toEqual([repo])
    const args = started?.darkMechanicus.args ?? []
    expect(args[args.indexOf('--repo') + 1]).toBe(repo)
  })
})

describe('session manager: folders that are refused', () => {
  it.each([
    ['deleted', () => rmSync(repo, { recursive: true }), 'moved or deleted'],
    ['replaced by a symlink to another directory', swapForSymlink, 'elsewhere'],
    ['no longer tracked', null, 'no longer tracked']
  ] as const)('refuses a chat whose folder was %s: no grant, no adapter, and the error names the folder', async (_how, change, reason) => {
    const state = rig()
    const chat = newChat(state.manager)
    if (change === null) {
      state.tracked.delete(repo)
    } else {
      change()
    }

    const sent = state.manager.send(chat, 'hello')

    await expect(sent).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining(repo) })
    await expect(sent).rejects.toThrow(reason)
    await expect(sent).rejects.toThrow(AGAIN)
    expect(state.fakes.created).toEqual([])
    expect(state.issued).toEqual([])
    expect(state.manager.liveCount()).toBe(0)
  })

  it('opens a start-on-open chat whose folder is gone without starting anything', async () => {
    const { manager, fakes, issued } = rig()
    const chat = newChat(manager, 'codex')
    rmSync(repo, { recursive: true })

    await manager.openChat(chat)

    expect([fakes.created.length, issued.length]).toEqual([0, 0])
  })
})

describe('session manager: every start checks the folder', () => {
  it('checks it again when the next message starts a new process after an idle stop and a model change', async () => {
    const { manager, fakes, issued, fireIdle } = rig()
    const chat = newChat(manager)
    await manager.send(chat, 'hello')
    await settle()
    fireIdle()
    await settle()
    expect(manager.liveCount()).toBe(0)
    await manager.setModel(chat, 'small')
    rmSync(repo, { recursive: true })

    await expect(manager.send(chat, 'again')).rejects.toThrow(repo)

    expect([fakes.created.length, issued.length]).toEqual([1, 1])
  })

  it('hands the adapter the same check for a process it starts again itself, and ends the turn with an error naming the folder', async () => {
    const { manager, store, fakes } = rig()
    const chat = newChat(manager)
    fakes.prepare = (adapter) => {
      // A process that died is started again inside the adapter, which checks the folder first.
      adapter.turn = async (self) => {
        self.started[0]?.checkFolder()
      }
    }
    await manager.send(chat, 'hello')
    await settle()
    expect(errorsIn(store.readTranscript(chat)?.items ?? [])).toEqual([])
    swapForSymlink()

    await manager.send(chat, 'again')
    await settle()

    const [message] = errorsIn(store.readTranscript(chat)?.items ?? [])
    expect(message).toContain(repo)
    expect(message).toContain(AGAIN)
    expect(fakes.created).toHaveLength(1)
  })

  it("checks it for the orchestrator chat Start run opens, which is removed when its folder is gone", async () => {
    const { manager, store, fakes, issued, tracked } = rig()
    const run = { id: 'rn_2', number: 2, epicId: 'ep_1', state: 'queued' } as RunView
    const runs = {
      getEpic: () => Promise.resolve({ id: 'ep_1', title: 'Agent chats', branch: null } as unknown as EpicDetailView),
      queueRun: () => Promise.resolve(run)
    }
    tracked.delete(repo)

    const result = await startOrchestratorRun({ runs, sessions: manager }, { folder: repo, epicId: 'ep_1', agent: 'claude' })

    expect(result.chat).toBeNull()
    expect(result.problem).toContain(repo)
    expect(store.listChats(repo)).toEqual([])
    expect([fakes.created.length, issued.length]).toEqual([0, 0])
  })
})
