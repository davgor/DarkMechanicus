// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeChatMail, mailState } from '../__mocks__/fakeChatMail'
import { FakeDm } from '../__mocks__/fakeDm'
import { settle } from '../__mocks__/settle'
import { createAgentMailStore, useAgentMail, type AgentMailStore } from './useAgentMail'

let mail: FakeChatMail
let store: AgentMailStore

beforeEach(() => {
  mail = new FakeChatMail()
  store = createAgentMailStore(mail)
  mail.onEvent(store.push)
})

afterEach(cleanup)

const unseen = (folder: string, chatId: string): number | null => store.view(folder, chatId).state?.unseenCount ?? null

describe('createAgentMailStore', () => {
  it('catches a folder up with one snapshot when it becomes active, and only once while it stays active', async () => {
    mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 2 })
    store.track(['/a'])
    expect(store.view('/a', 'chat_a').status).toBe('loading')
    await settle()
    expect(store.view('/a', 'chat_a')).toMatchObject({ status: 'ready', state: { unseenCount: 2 } })
    store.track(['/a'])
    expect(mail.calls.filter((call) => call.method === 'snapshot')).toHaveLength(1)
    expect(store.view('/b', 'chat_a').status).toBe('inactive')
  })

  it('keeps the newest view of a chat: an older push or snapshot never replaces it', async () => {
    const old = mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 1 })
    store.track(['/a'])
    await settle()
    mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 3 }, true)
    store.apply(old)
    mail.emit({ type: 'mail_state', state: old })
    expect(unseen('/a', 'chat_a')).toBe(3)
  })

  it('keeps a newer push that arrived while a snapshot was out, even when the older snapshot misses or predates it', async () => {
    mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 1 })
    mail.hold('snapshot')
    store.track(['/a'])
    await settle()
    mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 4 }, true)
    mail.emit({ type: 'mail_state', state: mailState({ folder: '/a', chatId: 'chat_new', unseenCount: 1, version: 99 }) })
    await act(async () => mail.release('snapshot', true))
    await settle()
    expect(unseen('/a', 'chat_a')).toBe(4)
    expect(unseen('/a', 'chat_new')).toBe(1)
  })
})

describe('createAgentMailStore: folders and removal', () => {
  it('drops a folder that stops being active with its late snapshot and pushes, and catches it up again later', async () => {
    mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 2 })
    mail.hold('snapshot')
    store.track(['/a'])
    store.track([])
    await act(async () => mail.release('snapshot', true))
    await settle()
    mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 5 }, true)
    expect(store.view('/a', 'chat_a')).toEqual({ status: 'inactive', state: null })
    store.track(['/a'])
    await settle()
    expect(unseen('/a', 'chat_a')).toBe(5)
  })

  it('keeps the same chat id in two folders apart', async () => {
    mail.put({ folder: '/a', chatId: 'chat_x', unseenCount: 1 })
    mail.put({ folder: '/b', chatId: 'chat_x', unseenCount: 7 })
    store.track(['/a', '/b'])
    await settle()
    mail.put({ folder: '/b', chatId: 'chat_x', unseenCount: 8 }, true)
    expect(unseen('/a', 'chat_x')).toBe(1)
    expect(unseen('/b', 'chat_x')).toBe(8)
  })

  it('forgets a removed mailbox and ignores a late view of it', async () => {
    const before = mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 2 })
    store.track(['/a'])
    await settle()
    mail.remove('/a', 'chat_a')
    mail.emit({ type: 'mail_state', state: before })
    expect(store.view('/a', 'chat_a').state).toBeNull()
  })

  it('recovers the stored counts with a new snapshot after a missed push, and keeps the last counts when it fails', async () => {
    mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 1 })
    store.track(['/a'])
    await settle()
    mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 6 })
    await store.refresh('/a')
    expect(unseen('/a', 'chat_a')).toBe(6)
    mail.failures.snapshot = { code: 'unauthorized', message: 'Not tracked.' }
    await store.refresh('/a')
    expect(store.view('/a', 'chat_a')).toMatchObject({ status: 'error', state: { unseenCount: 6 } })
  })
})

describe('createAgentMailStore: missed and late changes', () => {
  it('drops a chat a new snapshot no longer lists when its removal push was missed', async () => {
    const deaf = createAgentMailStore(mail)
    mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 2 })
    mail.put({ folder: '/a', chatId: 'chat_b', unseenCount: 1 })
    deaf.track(['/a'])
    await settle()
    mail.remove('/a', 'chat_b')
    await deaf.refresh('/a')
    expect(deaf.view('/a', 'chat_b').state).toBeNull()
    expect(deaf.view('/a', 'chat_a').state?.unseenCount).toBe(2)
  })

  it('asks nothing to refresh a folder that is not active', async () => {
    await store.refresh('/z')
    expect(mail.calls).toEqual([])
    expect(store.view('/z', 'chat_a').status).toBe('inactive')
  })

  it('ignores a removal older than the chat’s known view', async () => {
    mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 1 })
    store.track(['/a'])
    await settle()
    const late = mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 3 }, true)
    mail.emit({ type: 'mail_removed', folder: '/a', chatId: 'chat_a', version: late.version - 1 })
    expect(unseen('/a', 'chat_a')).toBe(3)
  })

  it('keeps a removal that came while the snapshot was out, so the older snapshot does not bring the chat back', async () => {
    const listed = mail.put({ folder: '/a', chatId: 'chat_a', unseenCount: 2 })
    mail.hold('snapshot')
    store.track(['/a'])
    await settle()
    mail.emit({ type: 'mail_removed', folder: '/a', chatId: 'chat_a', version: listed.version + 1 })
    await act(async () => mail.release('snapshot', true))
    await settle()
    expect(store.view('/a', 'chat_a')).toEqual({ status: 'ready', state: null })
  })

  it('ignores a removal for a folder that is not active, which is caught up from scratch later', async () => {
    mail.put({ folder: '/b', chatId: 'chat_x', unseenCount: 4 })
    mail.emit({ type: 'mail_removed', folder: '/b', chatId: 'chat_x', version: 99 })
    store.track(['/b'])
    await settle()
    expect(unseen('/b', 'chat_x')).toBe(4)
  })
})

function Host({ paths }: { paths: string[] }): null {
  useAgentMail(paths)
  return null
}

describe('useAgentMail', () => {
  it('subscribes once, catches up again when a chat of an active folder changes, and lets go on unmount', async () => {
    const dm = new FakeDm()
    const fake = new FakeChatMail()
    dm.chats.mail = fake
    window.dm = dm
    const mounted = render(<Host paths={['/a']} />)
    await settle()
    expect(fake.listenerCount()).toBe(1)
    expect(fake.calls.map((call) => call.args)).toEqual([['/a']])
    await act(async () => {
      await dm.chats.create({ folder: '/a', agent: 'omp', model: null, role: 'orchestrator', allowSave: true })
    })
    await settle()
    expect(fake.calls.map((call) => call.args)).toEqual([['/a'], ['/a']])
    fake.hold('snapshot')
    mounted.rerender(<Host paths={['/a', '/b']} />)
    mounted.unmount()
    await act(async () => fake.release('snapshot', true))
    expect(fake.listenerCount()).toBe(0)
  })

  it('tracks no folder, not an empty-named one, when none is active', async () => {
    const dm = new FakeDm()
    const fake = new FakeChatMail()
    dm.chats.mail = fake
    window.dm = dm
    render(<Host paths={[]} />)
    await settle()
    expect(fake.calls).toEqual([])
  })
})
