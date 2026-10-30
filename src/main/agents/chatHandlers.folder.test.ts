/**
 * A chat's chats are stored under the canonical path of the tracked folder they were created in. When that
 * folder is replaced by a symlink to another directory, every `chats:*` request naming it is refused with a
 * message that names the folder and where it now leads, before anything is looked up: no chat is found
 * under the symlink's target, and no stored chat file is rewritten or moved.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EpicDetailView, RunView } from '../../shared/domain/views'
import type { CommandResult } from '../../shared/desktop/api'
import { createFolderRegistry, type FolderRegistry } from '../desktop/folderRegistry'
import { connectedAgents, fakeAdapters } from './__mocks__/fakeChatAdapter'
import { createChatHandlers, type ChatHandlers } from './chatHandlers'
import { createChatStore, type ChatStore } from './chatStore'
import { createSessionManager } from './sessionManager'

const AGAIN = 'Track the folder again to keep using this chat.'
const EPIC_ID = 'ep_01m418epbg8qkqa2e2krvdkqk5'
const RUN_ID = 'rn_01m418epbg8qkqa2e2krvdkqk6'

let root: string
let repo: string
let elsewhere: string
let chatsRoot: string

beforeEach(() => {
  // Canonical from the start: on macOS the temporary directory is reached through the /var symlink.
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-chat-handlers-folder-')))
  repo = join(root, 'repo')
  elsewhere = join(root, 'elsewhere')
  chatsRoot = join(root, 'userData', 'agents', 'chats')
  mkdirSync(repo)
  mkdirSync(elsewhere)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

/** The real handlers over the real folder registry, chat store and session manager, with fake adapters. */
function rig(): { handlers: ChatHandlers; registry: FolderRegistry; store: ChatStore } {
  const registry = createFolderRegistry({ file: join(root, 'userData', 'folders.json'), homeDir: root, dmHome: join(root, 'dm-home') })
  const store = createChatStore({ root: chatsRoot })
  const sessions = createSessionManager({
    store,
    adapters: fakeAdapters().definitions,
    agentFor: connectedAgents(),
    folders: { trackedFolder: (path) => registry.resolve(path) },
    issueChatCli: async (folder) => ({ cli: { command: 'node', args: ['/app/out/main/cli.js', '--repo', folder], env: {} }, grantId: 'gr_1' }),
    revokeChatGrant: async () => undefined,
    push: () => {}
  })
  const runs = {
    getEpic: () => Promise.resolve({ id: EPIC_ID, title: 'Agent chats', branch: null } as EpicDetailView),
    queueRun: () => Promise.resolve({ id: RUN_ID, number: 2, epicId: EPIC_ID, state: 'queued' } as RunView)
  }
  return { handlers: createChatHandlers({ registry, agents: { get: connectedAgents() }, sessions, runs }), registry, store }
}

/** Every file under the chats root, by relative path, with its bytes. */
function storedFiles(): Record<string, string> {
  const files: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(path)
      } else {
        files[relative(chatsRoot, path)] = readFileSync(path, 'utf8')
      }
    }
  }
  walk(chatsRoot)
  return files
}

/** Replaces the tracked folder with a symlink to another directory: the path still resolves, to somewhere else. */
function swapForSymlink(): void {
  rmSync(repo, { recursive: true })
  symlinkSync(elsewhere, repo)
}

function refusal(result: CommandResult<unknown>): { code: string; message: string } {
  expect(result.ok).toBe(false)
  return result.ok ? { code: '', message: '' } : result.error
}

/** Every `chats:*` request that names a folder, for the chat `chatId` in `folder`. */
async function everyFolderRequest(handlers: ChatHandlers, folder: string, chatId: string): Promise<CommandResult<unknown>[]> {
  const ref = { folder, chatId }
  return [
    await handlers.list(folder),
    await handlers.create({ folder, agent: 'claude', role: 'planner' }),
    await handlers.startOrchestrator({ folder, epicId: EPIC_ID, agent: 'codex' }),
    await handlers.open(ref),
    await handlers.read(ref),
    await handlers.send({ ...ref, text: 'hello' }),
    await handlers.stop(ref),
    await handlers.threadBindings(ref),
    await handlers.boundThreads({ folder, runId: RUN_ID }),
    await handlers.retryTurn(ref),
    await handlers.setModel({ ...ref, model: 'small' }),
    await handlers.rename({ ...ref, title: 'Renamed' }),
    await handlers.delete(ref),
    await handlers.answerApproval({ ...ref, requestId: 'q1', decision: 'allow_once' })
  ]
}

describe('chat handlers: a chat whose folder was replaced by a symlink', () => {
  it('refuses every chats:* request with not_found, naming the folder and where it now leads', async () => {
    const { handlers, registry } = rig()
    registry.track(repo)
    const created = await handlers.create({ folder: repo, agent: 'claude', role: 'planner', title: 'Fix the build' })
    expect(created.ok).toBe(true)
    const chatId = created.ok ? created.data.id : ''
    swapForSymlink()

    const results = await everyFolderRequest(handlers, repo, chatId)

    expect(results).toHaveLength(14)
    for (const result of results) {
      expect(refusal(result)).toEqual({ code: 'not_found', message: `The folder ${repo} now leads to ${elsewhere}, not to the folder this chat was created in. ${AGAIN}` })
    }
  })

  it('never rewrites or moves a stored chat file, and never finds a chat under the symlink target', async () => {
    const { handlers, registry, store } = rig()
    registry.track(repo)
    const created = await handlers.create({ folder: repo, agent: 'claude', role: 'planner', title: 'Fix the build' })
    const chatId = created.ok ? created.data.id : ''
    // A chat stored under the directory the symlink will lead to; a lookup there would find it.
    const theirs = store.createChat({ folder: elsewhere, agent: 'claude', model: null, role: 'planner', allowSave: false, title: 'Not yours' })
    const before = storedFiles()
    expect(Object.keys(before).filter((path) => path.endsWith('index.jsonl'))).toHaveLength(2)
    swapForSymlink()

    const results = [
      await handlers.list(repo),
      await handlers.read({ folder: repo, chatId: theirs.id }),
      await handlers.rename({ folder: repo, chatId: theirs.id, title: 'Taken' }),
      await handlers.delete({ folder: repo, chatId: theirs.id }),
      await handlers.rename({ folder: repo, chatId, title: 'Renamed' }),
      await handlers.delete({ folder: repo, chatId }),
      await handlers.send({ folder: repo, chatId, text: 'hello' }),
      await handlers.create({ folder: repo, agent: 'claude', role: 'planner' })
    ]

    for (const result of results) {
      expect(refusal(result).code).toBe('not_found')
    }
    expect(storedFiles()).toEqual(before)
  })
})

describe('chat handlers: folders that still lead to the tracked folder', () => {
  it('still serves a chat when the folder is reached through another spelling that resolves to it', async () => {
    const { handlers, registry } = rig()
    registry.track(repo)
    const created = await handlers.create({ folder: join(repo, '..', 'repo'), agent: 'claude', role: 'planner', title: 'Fix the build' })
    const chatId = created.ok ? created.data.id : ''

    const read = await handlers.read({ folder: `${repo}/`, chatId })

    expect(read.ok && read.data.chat.folder).toBe(repo)
  })

  it('still lists and reads the chats of a tracked folder that is gone: only a start is refused', async () => {
    const { handlers, registry } = rig()
    registry.track(repo)
    const created = await handlers.create({ folder: repo, agent: 'claude', role: 'planner', title: 'Fix the build' })
    const chatId = created.ok ? created.data.id : ''
    rmSync(repo, { recursive: true })

    const listed = await handlers.list(repo)
    const read = await handlers.read({ folder: repo, chatId })

    expect(listed.ok && listed.data.map((chat) => chat.id)).toEqual([chatId])
    expect(read.ok && read.data.chat.id).toBe(chatId)
  })
})
