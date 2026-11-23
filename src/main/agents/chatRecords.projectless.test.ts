import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectedAgents, memoryChatFs, memoryChatStore, REPO, type MemoryChatFs } from './__mocks__/chatFixtures'
import { createActivityBindings } from './activityBindings'
import { createChatRecords, type LocalChatRecords } from './chatRecords'

const RUN_ID = 'rn_01m418epbg8qkqa2e2krvdkqk6'
const BINDINGS_FILE = resolve('/state/agents/activity-bindings.jsonl')

describe('chat records: deleting next to the bindings old chats stored', () => {
  it('forgets a deleted folder chat’s bindings, and deleting a project-less chat forgets none', async () => {
    const fs = memoryChatFs()
    const store = memoryChatStore(fs)
    const activity = createActivityBindings({ file: BINDINGS_FILE, fs })
    const records = createChatRecords({ store, agentFor: connectedAgents(), activity })
    const old = records.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator' })
    const kept = records.createChat({ folder: REPO, agent: 'claude', role: 'orchestrator' })
    const summoned = records.createChat({ folder: null, agent: 'claude', role: 'orchestrator' })
    const line = (chatId: string): string => `${JSON.stringify({ kind: 'run', runId: RUN_ID, chatId, threadId: null, folder: REPO, role: 'orchestrator' })}\n`
    fs.files.set(BINDINGS_FILE, line(old.id) + line(kept.id))

    await records.deleteChat(summoned)
    expect(activity.byRun(RUN_ID).map((binding) => binding.chatId)).toEqual([old.id, kept.id])
    await records.deleteChat(old)
    expect(activity.byRun(RUN_ID).map((binding) => binding.chatId)).toEqual([kept.id])
  })
})

function rig(): { records: LocalChatRecords; removed: string[]; fs: MemoryChatFs } {
  const fs = memoryChatFs()
  const removed: string[] = []
  const records = createChatRecords({
    store: memoryChatStore(fs),
    agentFor: connectedAgents(),
    removeScratch: async (chatId) => {
      removed.push(chatId)
    }
  })
  return { records, removed, fs }
}

describe('chat records: project-less chats', () => {
  it('creates one with no folder, named from its first prompt like a folder chat', () => {
    const { records } = rig()

    const chat = records.createChat({ folder: null, agent: 'claude', role: 'orchestrator', allowSave: true, firstPrompt: 'Tidy every board' })

    expect(chat).toMatchObject({ folder: null, role: 'orchestrator', allowSave: true, title: 'Naming chat…', titleStatus: 'pending', firstPromptDelivery: 'pending' })
    expect(records.listChats(null)).toEqual([chat])
    expect(records.listChats(REPO)).toEqual([])
  })

  it('deleting one removes its scratch folder, its record and its transcript', async () => {
    const { records, removed, fs } = rig()
    const chat = records.createChat({ folder: null, agent: 'claude', role: 'orchestrator' })

    await records.deleteChat({ folder: null, id: chat.id })

    expect(removed).toEqual([chat.id])
    expect(records.listChats(null)).toEqual([])
    expect([...fs.files.values()].join('\n')).not.toContain(chat.id)
  })

  it('deleting a folder chat removes no scratch folder', async () => {
    const { records, removed } = rig()
    const chat = records.createChat({ folder: REPO, agent: 'claude', role: 'planner' })

    await records.deleteChat(chat)

    expect(removed).toEqual([])
  })

  it('keeps the chat when its scratch folder cannot be removed, so deleting can be tried again', async () => {
    const store = memoryChatStore()
    const records = createChatRecords({
      store,
      agentFor: connectedAgents(),
      removeScratch: async () => {
        throw new Error('EBUSY')
      }
    })
    const chat = records.createChat({ folder: null, agent: 'claude', role: 'orchestrator' })

    await expect(records.deleteChat(chat)).rejects.toThrow('EBUSY')
    expect(records.listChats(null)).toEqual([chat])
  })
})
