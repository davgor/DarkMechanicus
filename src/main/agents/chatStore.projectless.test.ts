import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { memoryChatFs, memoryChatStore, REPO } from './__mocks__/chatFixtures'
import type { NewChat } from './chatStore'

const ROOT = resolve('/state/agents/chats')
const PROJECTLESS: NewChat = { folder: null, agent: 'claude', model: null, role: 'orchestrator', allowSave: true, title: 'Summoned' }
const IN_REPO: NewChat = { ...PROJECTLESS, folder: REPO, title: 'In the repo' }

describe('project-less chats in the chat store', () => {
  it('keeps them in their own index, apart from every folder, and lists them newest first', () => {
    const fs = memoryChatFs()
    const store = memoryChatStore(fs)
    const first = store.createChat(PROJECTLESS)
    const inRepo = store.createChat(IN_REPO)
    const second = store.createChat({ ...PROJECTLESS, title: 'Second' })

    expect(first.folder).toBeNull()
    expect(store.listChats(null).map((chat) => chat.id)).toEqual([second.id, first.id])
    expect(store.listChats(REPO).map((chat) => chat.id)).toEqual([inRepo.id])
    expect(fs.files.has(join(ROOT, 'projectless', 'index.jsonl'))).toBe(true)
  })

  it('reads them again after a restart, and updates, reads and deletes them by a null folder', () => {
    const fs = memoryChatFs()
    const chat = memoryChatStore(fs).createChat(PROJECTLESS)
    const reopened = memoryChatStore(fs)

    expect(reopened.getChat({ folder: null, id: chat.id })).toEqual(chat)
    expect(reopened.updateChat(chat, { title: 'Renamed' }).title).toBe('Renamed')
    expect(reopened.readTranscript(chat)?.chat.title).toBe('Renamed')
    reopened.deleteChat(chat)
    expect(memoryChatStore(fs).listChats(null)).toEqual([])
  })

  it('never finds a project-less chat under a folder, nor a folder chat among the project-less ones', () => {
    const store = memoryChatStore()
    const chat = store.createChat(PROJECTLESS)
    const inRepo = store.createChat(IN_REPO)

    expect(store.getChat({ folder: REPO, id: chat.id })).toBeNull()
    expect(store.getChat({ folder: null, id: inRepo.id })).toBeNull()
  })

  it('loads a folder record stored before project-less chats unchanged', () => {
    const fs = memoryChatFs()
    const before = memoryChatStore(fs).createChat(IN_REPO)
    const line = [...fs.files.values()].find((text) => text.includes(before.id)) ?? ''

    expect(JSON.parse(line.trim())).toMatchObject({ folder: REPO })
    expect(memoryChatStore(fs).listChats(REPO)).toEqual([before])
  })
})
