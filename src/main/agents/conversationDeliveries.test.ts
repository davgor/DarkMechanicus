import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
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
    const first = createConversationDeliveries({ userData: USER_DATA, fs })
    first.record(delivery())
    first.record(delivery({ chatId: null, state: 'failed', problem: 'chat stopped', at: '2026-11-17T12:01:00.000Z' }))
    first.record(delivery({ folder: OTHER_FOLDER, chatId: 'chat_other', state: 'opened' }))

    const reloaded = createConversationDeliveries({ userData: USER_DATA, fs })

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

    const store = createConversationDeliveries({ userData: USER_DATA, fs })
    expect(store.forMessages(FOLDER, ['msg_1', 'torn'])).toEqual(new Map([['msg_1', intact]]))

    const next = delivery({ messageId: 'msg_2', state: 'opened' })
    store.record(next)

    const reloaded = createConversationDeliveries({ userData: USER_DATA, fs })
    expect(reloaded.forMessages(FOLDER, ['msg_1', 'msg_2'])).toEqual(
      new Map([
        ['msg_1', intact],
        ['msg_2', next]
      ])
    )
  })
})
