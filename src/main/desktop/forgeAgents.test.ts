import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createChatRecords } from '../agents/chatRecords'
import { createChatStore } from '../agents/chatStore'
import { scratchDir } from '../../test/gitScratch'
import { forgeAgentSessions } from './forgeAgents'
import { seedForgeFixture } from '../../test/forgeFixture'
import { createHarness } from '../../test/workspaceHarness'

function resolverChats() {
  const fixture = scratchDir('forge-agents-')
  const root = join(fixture.path, 'forge')
  const member = join(root, 'alpha')
  const otherWorld = join(fixture.path, 'other-world')
  mkdirSync(member, { recursive: true })
  const store = createChatStore({ root: join(fixture.path, 'chats') })
  const chats = createChatRecords({ store, agentFor: () => null })
  const live = new Set<string>()
  const continuations: string[] = []
  const connected = [{ id: 'codex' }, { id: 'claude' }]
  let refused = true
  const session = forgeAgentSessions({ store, chats,
    agents: { list: () => connected }, folderDefaults: { get: folder => folder === root ? 'claude' : null },
    registry: { list: () => [{ path: member, forgeParent: root }] },
    terminals: {
      isRunning: id => live.has(id),
      paste: async (ref, text) => { continuations.push(text); await Promise.resolve(); live.add(ref.id); return { state: 'running', pid: 8 } },
      start: async (ref, { kickoff }) => {
        expect(kickoff).toContain(store.listChats(ref.folder).find(chat => chat.id === ref.id)!.forgeResolver)
        if (refused) return { state: 'failed', message: 'unavailable' }
        live.add(ref.id)
        return { state: 'running', pid: 7 }
      },
      deleteChat: async (ref, archive) => { live.delete(ref.id); await archive() }
    }
  })
  return { root, otherWorld, store, chats, live, continuations, connected, session, allow: () => { refused = false }, cleanup: fixture.cleanup }
}

it('reuses the resolver record, stops its terminal and retains its archived history', async () => {
  const { root, otherWorld, store, chats, live, continuations, connected, session, allow, cleanup } = resolverChats()
  try {
    await expect(session.onConflict(root)).rejects.toThrow('unavailable')
    allow()
    await session.onConflict(root)
    const [chat] = chats.listChats(root)
    expect(chat).toMatchObject({ agent: 'claude', role: 'worker', allowSave: false, forgeResolver: root })
    expect(live.has(chat.id)).toBe(true)
    store.updateChat(chat, { kickoffSent: true, firstPromptDelivery: 'submitted' })
    await session.onConflict(root)
    expect(continuations).toEqual([])
    live.delete(chat.id)
    await Promise.all([session.onConflict(root), session.onConflict(root)])
    expect(continuations).toEqual([chat.firstPrompt])
    expect(chats.listChats(root).map(c => c.id)).toEqual([chat.id])
    live.delete(chat.id)
    store.updateChat(chat, { firstPromptDelivery: 'uncertain' })
    await expect(session.onConflict(root)).rejects.toThrow('delivery is uncertain')
    expect(continuations).toHaveLength(1)
    await session.onConflict(otherWorld)
    expect(chats.listChats(otherWorld)[0].agent).toBe('codex')
    await session.onSynced(root)
    expect(chats.listChats(root)).toEqual([])
    expect(store.listChats(root)).toHaveLength(1)
    expect(store.listChats(root)[0]).toMatchObject({ id: chat.id, archived: true, firstPrompt: chat.firstPrompt })
    expect(live.has(chat.id)).toBe(false)
    expect(chats.listChats(otherWorld)).toHaveLength(1)
    await session.onSynced(otherWorld)
    expect(live.size).toBe(0)
    connected.length = 0
    await expect(session.onConflict(root)).rejects.toThrow('Connect an agent')
  } finally { cleanup() }
})

it('labels ticket launches with the repository owner and name even when its ticket folder is an alias', () => {
  const fixture = scratchDir('forge-agent-target-')
  const root = fixture.path
  const member = join(root, 'Alias')
  try {
    seedForgeFixture(root, 'example', [{ folder: 'Alias', repository: 'example/actual-code' }])
    mkdirSync(member)
    const store = createChatStore({ root: join(root, 'chats') })
    const agent = { folder: member, agent: 'claude', model: null, role: 'orchestrator' as const, allowSave: false }
    expect(store.createChat({ ...agent, runId: 'rn_2' }).targetRepository).toBe('example/actual-code')
    expect(store.createChat({ ...agent, cardId: 'kc_1' }).targetRepository).toBe('example/actual-code')
    expect(store.createChat(agent).targetRepository).toBeUndefined()
  } finally { fixture.cleanup() }
})

it('runs resolver cleanup after stopping it and keeps unrelated callers active', async () => {
  const h = createHarness()
  const workspace = h.open('desktop')
  try {
    await workspace.initializeRepository({ name: 'Forge resolver cleanup' })
    const root = join(h.homeDir, 'World')
    const store = createChatStore({ root: join(h.homeDir, 'chats') })
    const chats = createChatRecords({ store, agentFor: () => null })
    const resolver = chats.createChat({ folder: h.root, agent: 'omp', role: 'orchestrator' })
    const caller = chats.createChat({ folder: h.root, agent: 'omp', role: 'planner' })
    store.updateChat(resolver, { forgeResolver: root })
    const live = new Set([resolver.id, caller.id])
    let available = false
    const sessions = forgeAgentSessions({ store, chats,
      agents: { list: () => [] }, folderDefaults: { get: () => null },
      registry: { list: () => [{ path: h.root, forgeParent: root }] },
      terminals: {
        isRunning: () => false,
        paste: async () => ({ state: 'running', pid: 7 }),
        start: async () => ({ state: 'running', pid: 7 }),
        deleteChat: async (ref, archive) => { live.delete(ref.id); await archive() }
      },
      beforeArchive: chat => {
        expect(live.has(chat.id)).toBe(false)
        expect(store.getChat(chat)?.archived).not.toBe(true)
        if (!available) throw new Error('Cleanup unavailable')
      }
    })
    await expect(sessions.onSynced(root)).rejects.toThrow('Cleanup unavailable')
    expect(store.getChat(resolver)?.archived).not.toBe(true)
    available = true
    await sessions.onSynced(root)
    expect(store.getChat(resolver)).toMatchObject({ archived: true })
    expect(chats.listChats(h.root).map(chat => chat.id)).toEqual([caller.id])
    expect(live.has(caller.id)).toBe(true)
  } finally { h.cleanup() }
})
