/**
 * Every start of a chat's agent runs in the chat's canonical, tracked folder, checked on disk at that moment:
 * the first message, a new process after an idle stop or a model change, a process the adapter starts again
 * after a crash, and the orchestrator chat Start run opens. A folder that is gone is refused before a grant
 * is issued or an adapter created. Every turn of a live agent checks it too: one whose folder went away is
 * stopped as an idle stop stops it, and its turn ends with the error, before anything is sent.
 */
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
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
  /** The grants revoked, in order. */
  revoked: string[]
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
  const revoked: string[] = []
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
    revokeChatGrant: async (grantId: string) => {
      revoked.push(grantId)
    },
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
  return { manager, store, fakes, issued, revoked, tracked, fireIdle }
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

/** The ways a live agent's folder goes away between two turns, and what the error says for each. */
const CHANGES = [
  ['moved', () => renameSync(repo, `${repo}-renamed`), 'moved or deleted'],
  ['deleted', () => rmSync(repo, { recursive: true }), 'moved or deleted'],
  ['untracked', null, 'no longer tracked']
] as const

function change(state: Rig, how: (() => void) | null): void {
  if (how === null) {
    state.tracked.delete(repo)
  } else {
    how()
  }
}

describe('session manager: every message to a live agent checks the folder', () => {
  it.each(CHANGES)('stops a live agent whose folder was %s before the next message, sending it nothing', async (_how, how, reason) => {
    const state = rig()
    const chat = newChat(state.manager)
    await state.manager.send(chat, 'hello')
    await settle()
    const adapter = state.fakes.created[0]
    change(state, how)

    await state.manager.send(chat, 'again')
    await settle()

    expect(adapter?.sent).toEqual(['hello'])
    expect(state.fakes.created).toHaveLength(1)
    expect(state.issued).toEqual([repo])
    const items = state.store.readTranscript(chat)?.items ?? []
    const [message] = errorsIn(items)
    expect(message).toContain(repo)
    expect(message).toContain(reason)
    expect(message).toContain(AGAIN)
    expect(items.at(-1)?.kind).toBe('error')
    // Stopped as an idle stop stops it: process tree disposed, grant revoked, nothing live.
    expect(adapter?.disposals).toBe(1)
    expect(state.revoked).toEqual(['gr_1'])
    expect(state.manager.liveCount()).toBe(0)
  })
})

describe('session manager: every retry on a live agent checks the folder', () => {
  it.each(CHANGES)('stops a live agent whose folder was %s before a retry, sending it nothing', async (_how, how, reason) => {
    const state = rig()
    const chat = newChat(state.manager)
    const sent = await state.manager.send(chat, 'hello')
    await settle()
    state.store.updateChat(chat, { cutShortMessageId: sent.id })
    const adapter = state.fakes.created[0]
    change(state, how)

    await state.manager.retryTurn(chat)
    await settle()

    expect(adapter?.sent).toEqual(['hello'])
    expect(state.fakes.created).toHaveLength(1)
    const [message] = errorsIn(state.store.readTranscript(chat)?.items ?? [])
    expect(message).toContain(repo)
    expect(message).toContain(reason)
    expect(adapter?.disposals).toBe(1)
    expect(state.revoked).toEqual(['gr_1'])
    expect(state.manager.liveCount()).toBe(0)
  })

  it('sends the next turn to the same agent while its folder is unchanged', async () => {
    const state = rig()
    const chat = newChat(state.manager)
    await state.manager.send(chat, 'hello')
    await settle()

    await state.manager.send(chat, 'again')
    await settle()

    expect(state.fakes.created[0]?.sent).toEqual(['hello', 'again'])
    expect([state.revoked, errorsIn(state.store.readTranscript(chat)?.items ?? [])]).toEqual([[], []])
  })
})
