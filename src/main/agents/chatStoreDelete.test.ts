import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DomainError } from '../../core/errors'
import type { ChatItem } from '../../shared/agents/chat'
import { memoryChatFs, memoryChatStore, REPO, type MemoryChatFs } from './__mocks__/fakeChatAdapter'
import { createChatStore, type NewChat } from './chatStore'

const NEW_CHAT: NewChat = { folder: REPO, agent: 'claude', model: 'opus', role: 'planner', allowSave: true }
const AT = '2026-02-01T00:00:00.000Z'

function message(id: string, text: string): ChatItem {
  return { id, at: AT, kind: 'user_message', text }
}

function everythingStored(fs: MemoryChatFs): string {
  return [...fs.files.values()].join('\n')
}

function indexFile(fs: MemoryChatFs): string {
  const path = [...fs.files.keys()].find((key) => key.endsWith('index.jsonl'))
  return fs.files.get(path ?? '') ?? ''
}

function errorCode(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    return error instanceof DomainError ? error.code : `unexpected: ${String(error)}`
  }
  return 'no error'
}

function seeded(): { fs: MemoryChatFs; doomed: { folder: string; id: string }; kept: { folder: string; id: string } } {
  const fs = memoryChatFs()
  const store = memoryChatStore(fs)
  const doomed = store.createChat({ ...NEW_CHAT, title: 'Secret plan' })
  const kept = store.createChat({ ...NEW_CHAT, title: 'Keep me' })
  store.appendItem(doomed, message('m1', 'the doomed text'))
  store.updateChat(doomed, { title: 'Secret plan, renamed' })
  store.appendItem(kept, message('m2', 'the kept text'))
  return { fs, doomed, kept }
}

describe('chat store: deleting a chat', () => {
  it('removes the chat from the folder list, the lookup and the transcript read, and keeps its sibling', () => {
    const { fs, doomed, kept } = seeded()
    const store = memoryChatStore(fs)

    store.deleteChat(doomed)

    expect(store.getChat(doomed)).toBeNull()
    expect(store.readTranscript(doomed)).toBeNull()
    expect(store.listChats(REPO).map((chat) => chat.id)).toEqual([kept.id])
    expect(store.readTranscript(kept)?.items).toHaveLength(1)
  })

  it('leaves nothing of the chat on disk: not its transcript, not any version of its index record', () => {
    const { fs, doomed } = seeded()

    memoryChatStore(fs).deleteChat(doomed)

    expect([...fs.files.keys()].some((path) => path.endsWith(`${doomed.id}.jsonl`))).toBe(false)
    expect(everythingStored(fs)).not.toContain('the doomed text')
    expect(everythingStored(fs)).not.toContain('Secret plan')
    expect(indexFile(fs)).toContain('Keep me')
    expect(indexFile(fs).endsWith('\n')).toBe(true)
  })

  it('stays deleted for a store opened later over the same files, and new chats still append cleanly', () => {
    const { fs, doomed, kept } = seeded()
    memoryChatStore(fs).deleteChat(doomed)

    const reopened = memoryChatStore(fs)
    expect(reopened.listChats(REPO).map((chat) => chat.id)).toEqual([kept.id])
    const fresh = reopened.createChat({ ...NEW_CHAT, title: 'After' })
    expect(memoryChatStore(fs).listChats(REPO).map((chat) => chat.id).sort()).toEqual([kept.id, fresh.id].sort())
  })

});

describe('chat store: after a delete', () => {
  it('refuses to append to or update a deleted chat, and to delete it twice', () => {
    const { fs, doomed } = seeded()
    const store = memoryChatStore(fs)
    store.deleteChat(doomed)

    expect(errorCode(() => store.appendItem(doomed, message('m3', 'late')))).toBe('not_found')
    expect(errorCode(() => store.updateChat(doomed, { title: 'late' }))).toBe('not_found')
    expect(errorCode(() => store.deleteChat(doomed))).toBe('not_found')
    expect(errorCode(() => store.deleteChat({ folder: REPO, id: 'chat_nope' }))).toBe('not_found')
  })

  it('does not touch another folder that happens to hold a chat with the same id', () => {
    const fs = memoryChatFs([REPO, join(REPO, '..', 'other')])
    const store = memoryChatStore(fs)
    const mine = store.createChat(NEW_CHAT)

    expect(errorCode(() => store.deleteChat({ folder: join(REPO, '..', 'other'), id: mine.id }))).toBe('not_found')
    expect(store.getChat(mine)).toEqual(mine)
  })

  it('keeps a truncated index tail from gluing onto the next record', () => {
    const { fs, doomed, kept } = seeded()
    const path = [...fs.files.keys()].find((key) => key.endsWith('index.jsonl')) ?? ''
    fs.files.set(path, `${fs.files.get(path) ?? ''}{"id":"chat_cut","folder":"/x","ag`)
    const store = memoryChatStore(fs)

    store.deleteChat(doomed)
    const fresh = store.createChat({ ...NEW_CHAT, title: 'After' })

    expect(memoryChatStore(fs).listChats(REPO).map((chat) => chat.id).sort()).toEqual([kept.id, fresh.id].sort())
  })
})

describe('chat store: deleting on the real filesystem', () => {
  it('removes the transcript file and rewrites the index without the chat', () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-chats-delete-')))
    const root = join(base, 'agents', 'chats')
    try {
      const folder = join(base, 'repo')
      mkdirSync(folder)
      const store = createChatStore({ root })
      const doomed = store.createChat({ ...NEW_CHAT, folder, title: 'Doomed' })
      const kept = store.createChat({ ...NEW_CHAT, folder, title: 'Kept' })
      store.appendItem(doomed, message('m1', 'gone soon'))
      const [key = ''] = readdirSync(root)

      store.deleteChat(doomed)

      expect(readdirSync(join(root, key)).sort()).toEqual(['index.jsonl'])
      expect(readFileSync(join(root, key, 'index.jsonl'), 'utf8')).not.toContain('Doomed')
      expect(createChatStore({ root }).listChats(folder).map((chat) => chat.id)).toEqual([kept.id])
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
