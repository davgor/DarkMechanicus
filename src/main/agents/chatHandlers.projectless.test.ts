/**
 * Every chat that is not deleted, across the tracked folders and the project-less ones, and the project-less chats
 * themselves through the `chats:*` handlers: summoned with no folder, renamed, read and deleted by a null folder, and
 * never reached through a folder.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../shared/agents/chat'
import type { ChatPushEvent } from '../../shared/agents/chatApi'
import type { CommandResult } from '../../shared/desktop/api'
import { linkDirectory } from '../../test/tempRepo'
import { createFolderRegistry, type FolderRegistry } from '../desktop/folderRegistry'
import { connectedAgents } from './__mocks__/chatFixtures'
import { createChatHandlers, type ChatHandlers } from './chatHandlers'
import { createChatRecords } from './chatRecords'
import { createChatStore } from './chatStore'

let root: string
let alpha: string
let beta: string

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-chat-handlers-all-')))
  alpha = join(root, 'alpha')
  beta = join(root, 'beta')
  mkdirSync(alpha)
  mkdirSync(beta)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

interface Rig {
  handlers: ChatHandlers
  registry: FolderRegistry
  pushed: ChatPushEvent[]
  scratchRemoved: string[]
}

function rig(): Rig {
  const registry = createFolderRegistry({ file: join(root, 'userData', 'folders.json'), homeDir: root, dmHome: join(root, 'dm-home') })
  registry.track(alpha)
  registry.track(beta)
  let tick = 0
  const store = createChatStore({ root: join(root, 'userData', 'agents', 'chats'), now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, (tick += 1))).toISOString() })
  const scratchRemoved: string[] = []
  const chats = createChatRecords({ store, agentFor: connectedAgents(), removeScratch: async (id) => void scratchRemoved.push(id) })
  const pushed: ChatPushEvent[] = []
  const refuse = (): Promise<never> => Promise.reject(new Error('Not used in these tests.'))
  const handlers = createChatHandlers({
    registry,
    agents: { get: connectedAgents() },
    chats,
    terminals: { start: refuse, paste: refuse },
    agentChats: { start: refuse, send: refuse, isLive: () => false },
    plannerAgents: { list: () => [], checkAuth: refuse },
    runs: { getEpic: refuse, queueRun: refuse },
    transfers: { getEpic: refuse, getTransfer: refuse },
    kanban: { play: refuse, kickBack: refuse, branch: refuse },
    push: (event) => pushed.push(event)
  })
  return { handlers, registry, pushed, scratchRemoved }
}

function data<T>(result: CommandResult<T>): T {
  if (!result.ok) {
    throw new Error(`${result.error.code}: ${result.error.message}`)
  }
  return result.data
}

function code(result: CommandResult<unknown>): string {
  return result.ok ? 'ok' : result.error.code
}

const summon = { folder: null, agent: 'claude', model: null, firstPrompt: 'Tidy every board' } as const

describe('chats:listAll', () => {
  it('lists every tracked folder’s chats and the project-less ones, newest first, each with its folder', async () => {
    const { handlers } = rig()
    const inAlpha = data(await handlers.create({ folder: alpha, agent: 'claude', role: 'planner', title: 'Alpha plan' }))
    const summoned = data(await handlers.create(summon))
    const inBeta = data(await handlers.create({ folder: beta, agent: 'codex', role: 'worker', title: 'Beta work' }))

    const all = data(await handlers.listAll())

    expect(all.map((chat) => [chat.id, chat.folder])).toEqual([
      [inBeta.id, beta],
      [summoned.id, null],
      [inAlpha.id, alpha]
    ])
  })

  it('leaves out deleted chats and the chats of a folder that is no longer tracked', async () => {
    const { handlers, registry } = rig()
    const gone = data(await handlers.create(summon))
    data(await handlers.create({ folder: beta, agent: 'claude', role: 'planner' }))
    const kept = data(await handlers.create({ folder: alpha, agent: 'claude', role: 'planner' }))
    data(await handlers.delete({ folder: null, chatId: gone.id }))
    registry.untrack(beta)

    expect(data(await handlers.listAll()).map((chat) => chat.id)).toEqual([kept.id])
  })

  it('leaves out a tracked folder swapped for a symlink to another directory, as listing it alone is refused, and lists the rest', async () => {
    const { handlers } = rig()
    data(await handlers.create({ folder: beta, agent: 'claude', role: 'planner' }))
    const kept = data(await handlers.create({ folder: alpha, agent: 'claude', role: 'planner' }))
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    rmSync(beta, { recursive: true })
    linkDirectory(elsewhere, beta)

    expect(code(await handlers.list(beta))).toBe('not_found')
    expect(data(await handlers.listAll()).map((chat) => chat.id)).toEqual([kept.id])
  })
})

describe('chats:create with no folder: summoning a project-less chat', () => {
  it('creates an orchestrator that may save, with no folder, named from its first prompt, and tells every window', async () => {
    const { handlers, pushed } = rig()

    const chat = data(await handlers.create(summon))

    expect(chat).toMatchObject({ folder: null, agent: 'claude', role: 'orchestrator', allowSave: true, firstPrompt: 'Tidy every board', titleStatus: 'pending' })
    expect(pushed).toEqual([{ type: 'chats_changed', folder: null, chatId: chat.id }])
  })

  it('refuses a role or Allow save from the renderer: main decides them', async () => {
    const { handlers } = rig()

    expect(code(await handlers.create({ ...summon, role: 'planner' }))).toBe('invalid_input')
    expect(code(await handlers.create({ ...summon, allowSave: false }))).toBe('invalid_input')
    expect(data(await handlers.listAll())).toEqual([])
  })

  it('refuses an agent that is not connected', async () => {
    const { handlers } = rig()

    expect(code(await handlers.create({ ...summon, agent: 'cu_01m65kwqqeyajbj5bnq81gngrb' }))).toBe('not_found')
  })
})

describe('a project-less chat by a null folder', () => {
  it('is read, renamed and deleted by a null folder, each change told to every window', async () => {
    const { handlers, pushed, scratchRemoved } = rig()
    const chat = data(await handlers.create(summon))
    const ref = { folder: null, chatId: chat.id }

    expect(data(await handlers.read(ref)).chat.id).toBe(chat.id)
    expect(data(await handlers.rename({ ...ref, title: 'Boards' })).title).toBe('Boards')
    data(await handlers.delete(ref))

    expect(scratchRemoved).toEqual([chat.id])
    expect(pushed.map((event) => event.folder)).toEqual([null, null, null])
    expect(code(await handlers.read(ref))).toBe('not_found')
  })

  it('is never reached through a folder, and a folder chat never through a null folder', async () => {
    const { handlers } = rig()
    const summoned = data(await handlers.create(summon))
    const inAlpha: ChatRecord = data(await handlers.create({ folder: alpha, agent: 'claude', role: 'planner' }))

    expect(code(await handlers.read({ folder: alpha, chatId: summoned.id }))).toBe('not_found')
    expect(code(await handlers.delete({ folder: null, chatId: inAlpha.id }))).toBe('not_found')
    expect(data(await handlers.listAll())).toHaveLength(2)
  })

  it('cannot be named where a request needs a tracked folder', async () => {
    const { handlers } = rig()

    expect(code(await handlers.list(null))).toBe('invalid_input')
    expect(code(await handlers.startOrchestrator({ folder: null, epicId: 'ep_01m418epbg8qkqa2e2krvdkqk5', agent: 'claude' }))).toBe('invalid_input')
    expect(code(await handlers.boundTerminal({ folder: null, runId: 'rn_01m418epbg8qkqa2e2krvdkqk6' }))).toBe('invalid_input')
  })
})
