import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createChatRecords } from '../agents/chatRecords'
import { createChatStore } from '../agents/chatStore'
import { scratchDir } from '../../test/gitScratch'
import { forgeAgentSessions } from './forgeAgents'

it('reuses the resolver record, stops its terminal and retains its archived history', async () => {
  const fixture = scratchDir('forge-agents-')
  try {
    const root = join(fixture.path, 'forge')
    const member = join(root, 'alpha')
    mkdirSync(member, { recursive: true })
    const store = createChatStore({ root: join(fixture.path, 'chats') })
    const chats = createChatRecords({ store, agentFor: () => null })
    const live = new Set<string>()
    const connected = [{ id: 'codex' }]
    let refused = true
    const session = forgeAgentSessions({ store, chats,
      agents: { list: () => connected }, folderDefaults: { get: () => 'claude' },
      registry: { list: () => [{ path: member, forgeParent: root }] },
      terminals: {
        start: async (ref, { kickoff }) => {
          expect(kickoff).toContain(store.listChats(ref.folder).find(chat => chat.id === ref.id)!.forgeResolver)
          if (refused) return { state: 'failed', message: 'unavailable' }
          live.add(ref.id)
          return { state: 'running', pid: 7 }
        },
        deleteChat: async (ref, archive) => { live.delete(ref.id); await archive() }
      }
    })
    await expect(session.onConflict(root, member)).rejects.toThrow('unavailable')
    refused = false
    await session.onConflict(root, member)
    const [chat] = chats.listChats(member)
    expect(chat).toMatchObject({ agent: 'claude', role: 'worker', allowSave: false, forgeResolver: root })
    expect(live.has(chat.id)).toBe(true)
    await session.onConflict('other world', null)
    expect(chats.listChats(null)[0].agent).toBe('codex')
    await session.onSynced(root)
    expect(chats.listChats(member)).toEqual([])
    expect(store.listChats(member)).toHaveLength(1)
    expect(store.listChats(member)[0]).toMatchObject({ id: chat.id, archived: true, firstPrompt: chat.firstPrompt })
    expect(live.has(chat.id)).toBe(false)
    expect(chats.listChats(null)).toHaveLength(1)
    await session.onSynced('other world')
    expect(live.size).toBe(0)
    connected.pop()
    await expect(session.onConflict(root, null)).rejects.toThrow('Connect an agent')
  } finally { fixture.cleanup() }
})
