import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { memoryChatFs } from './__mocks__/chatFixtures'
import { createConversationDeliveries, type ConversationDelivery } from './conversationDeliveries'

const USER_DATA = resolve('/state')
const FILE = join(USER_DATA, 'agents', 'conversation-deliveries.jsonl')
const FOLDER = resolve('/work/repo')
const OTHER_FOLDER = resolve('/work/other')

function delivery(overrides: Partial<ConversationDelivery> = {}): ConversationDelivery {
  return {
    messageId: 'msg_1',
    folder: FOLDER,
    chatId: 'chat_1',
    state: 'delivered',
    problem: null,
    at: '2026-11-17T12:00:00.000Z',
    ...overrides
  }
}

describe('conversation delivery ledger', () => {
  it('uses the last entry per message after a reload and returns only the requested folder', () => {
    const fs = memoryChatFs()
    const first = createConversationDeliveries({ userData: USER_DATA, fs, onChanged: vi.fn() })
    first.record(delivery())
    first.record(delivery({ chatId: null, state: 'failed', problem: 'chat stopped', at: '2026-11-17T12:01:00.000Z' }))
    first.record(delivery({ folder: OTHER_FOLDER, chatId: 'chat_other', state: 'opened' }))

    const reloaded = createConversationDeliveries({ userData: USER_DATA, fs, onChanged: vi.fn() })

    expect(reloaded.forMessages(FOLDER, ['msg_1'])).toEqual(
      new Map([['msg_1', delivery({ chatId: null, state: 'failed', problem: 'chat stopped', at: '2026-11-17T12:01:00.000Z' })]])
    )
    expect(reloaded.forMessages(OTHER_FOLDER, ['msg_1'])).toEqual(
      new Map([['msg_1', delivery({ folder: OTHER_FOLDER, chatId: 'chat_other', state: 'opened' })]])
    )
    expect(reloaded.forMessages(resolve('/work/unrelated'), ['msg_1'])).toEqual(new Map())
  })

  it('ignores a torn tail and puts the next record on a fresh line', () => {
    const fs = memoryChatFs()
    const intact = delivery()
    fs.files.set(FILE, `${JSON.stringify(intact)}\n{"messageId":"torn"`)

    const store = createConversationDeliveries({ userData: USER_DATA, fs, onChanged: vi.fn() })
    expect(store.forMessages(FOLDER, ['msg_1', 'torn'])).toEqual(new Map([['msg_1', intact]]))

    const next = delivery({ messageId: 'msg_2', state: 'opened' })
    store.record(next)

    const reloaded = createConversationDeliveries({ userData: USER_DATA, fs, onChanged: vi.fn() })
    expect(reloaded.forMessages(FOLDER, ['msg_1', 'msg_2'])).toEqual(
      new Map([
        ['msg_1', intact],
        ['msg_2', next]
      ])
    )
  })
})

describe('pending board bodies and observed peer proof', () => {
  it('retains complete ordered board bodies across reload before any scheduling or receipt', () => {
    const fs = memoryChatFs()
    const first = createConversationDeliveries({ userData: USER_DATA, fs, onChanged: vi.fn() })
    const pending = {
      ...delivery(), source: 'board' as const, state: 'pending' as const,
      text: '[Board message from the person]\nComplete body\nincluding its final line.'
    }
    first.record(pending)
    first.record({ ...pending, messageId: 'msg_2', text: 'Independent next person body.' })
    const restarted = createConversationDeliveries({ userData: USER_DATA, fs, onChanged: vi.fn() })
    expect(restarted.pending()).toEqual([pending, { ...pending, messageId: 'msg_2', text: 'Independent next person body.' }])
  })

  it('keeps observed peer proof distinct from board identity, recipient and folder without storing peer bodies', () => {
    const fs = memoryChatFs()
    const first = createConversationDeliveries({ userData: USER_DATA, fs, onChanged: vi.fn() })
    first.record({ ...delivery(), source: 'peer', bodyHash: 'proof-hash', entryId: 'host-entry' })
    const restarted = createConversationDeliveries({ userData: USER_DATA, fs, onChanged: vi.fn() })
    expect(restarted.proof(FOLDER, 'chat_1', 'peer', 'msg_1')).toMatchObject({ bodyHash: 'proof-hash', entryId: 'host-entry' })
    expect(restarted.proof(FOLDER, 'chat_other', 'peer', 'msg_1')).toBeUndefined()
    expect(restarted.proof(OTHER_FOLDER, 'chat_1', 'peer', 'msg_1')).toBeUndefined()
    expect(restarted.proof(FOLDER, 'chat_1', 'board', 'msg_1')).toBeUndefined()
    expect(restarted.forMessages(FOLDER, ['msg_1'])).toEqual(new Map())
    expect(restarted.pending()).toEqual([])
  })
})

it('surfaces ledger I/O failure without caching an empty inbox or appending over an unreadable tail', () => {
  const fs = memoryChatFs()
  const pending = { ...delivery(), source: 'board' as const, state: 'pending' as const, text: 'Retained full person body.' }
  fs.files.set(FILE, JSON.stringify(pending) + '\n')
  let blocked = true
  const store = createConversationDeliveries({ userData: USER_DATA, onChanged: vi.fn(), fs: {
    ...fs,
    readFile(path) {
      if (blocked) throw Object.assign(new Error('Ledger cannot be read'), { code: 'EACCES' })
      return fs.readFile(path)
    }
  } })
  expect(() => store.pending()).toThrow('Ledger cannot be read')
  expect(() => store.record(delivery({ messageId: 'never-appended' }))).toThrow('Ledger cannot be read')
  blocked = false
  expect(store.pending()).toEqual([pending])
  expect(fs.files.get(FILE)).not.toContain('never-appended')
})
