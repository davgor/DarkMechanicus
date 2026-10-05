// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { approvalDecision, approvalRequest } from '../__mocks__/chatViewKit'
import { chatRecord } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import { chatsFor, useChats } from './useChats'

let dm: FakeDm
let errors: string[]

beforeEach(() => {
  errors = []
  dm = new FakeDm()
  window.dm = dm
  dm.chats.chats = [
    chatRecord({ id: 'chat_a1', folder: '/a', title: 'Older', updatedAt: '2026-03-01T10:00:00.000Z' }),
    chatRecord({ id: 'chat_a2', folder: '/a', title: 'Newer', updatedAt: '2026-03-02T10:00:00.000Z' }),
    chatRecord({ id: 'chat_b1', folder: '/b', title: 'Beta chat' })
  ]
})

afterEach(cleanup)

type Props = { paths: string[] }

async function mount(paths: string[] = ['/a']): Promise<ReturnType<typeof renderHook<ReturnType<typeof useChats>, Props>>> {
  const view = renderHook(({ paths: active }: Props) => useChats({ paths: active, onError: (error) => errors.push((error as Error).message) }), {
    initialProps: { paths }
  })
  await settle()
  return view
}

type View = Awaited<ReturnType<typeof mount>>
const titles = (view: View, path: string): string[] => chatsFor(view.result.current.lists, path).chats.map((chat) => chat.title)

describe('useChats loading', () => {
  it('loads the chats of each active folder, and nothing for the others', async () => {
    const view = await mount(['/a'])
    expect(titles(view, '/a')).toEqual(['Newer', 'Older'])
    expect(chatsFor(view.result.current.lists, '/a').status).toBe('ready')
    expect(chatsFor(view.result.current.lists, '/b').status).toBe('loading')
    expect(dm.chats.callsOf('list')).toEqual([['/a']])
  })

  it('loads a folder when it becomes active, and again when it comes back after being left', async () => {
    const view = await mount(['/a'])
    view.rerender({ paths: ['/a', '/b'] })
    await settle()
    expect(titles(view, '/b')).toEqual(['Beta chat'])
    view.rerender({ paths: ['/a'] })
    await settle()
    view.rerender({ paths: ['/a', '/b'] })
    await settle()
    expect(dm.chats.callsOf('list')).toEqual([['/a'], ['/b'], ['/b']])
  })

  it('reports a failed listing and keeps what it had', async () => {
    const view = await mount(['/a'])
    dm.chats.list = () => Promise.resolve({ ok: false, error: { code: 'internal', message: 'store unreadable' } })
    await act(async () => view.result.current.reload('/a'))
    expect(errors).toEqual(['store unreadable'])
    expect(chatsFor(view.result.current.lists, '/a')).toMatchObject({ status: 'error' })
    expect(titles(view, '/a')).toEqual(['Newer', 'Older'])
  })
})

describe('useChats creating', () => {
  it('creates a chat, reloads the folder so it is listed, and returns it', async () => {
    const view = await mount(['/a'])
    const request = { folder: '/a', agent: 'claude', role: 'planner', model: 'opus', allowSave: true } as const
    let created: unknown = null
    await act(async () => {
      created = await view.result.current.create(request)
    })
    expect(created).toMatchObject({ folder: '/a', agent: 'claude', role: 'planner', model: 'opus' })
    expect(dm.chats.callsOf('create')).toEqual([[request]])
    expect(titles(view, '/a')[0]).toBe('New chat')
  })

  it('reports a chat that could not be created and returns null', async () => {
    const view = await mount(['/a'])
    dm.chats.create = () => Promise.resolve({ ok: false, error: { code: 'unauthorized', message: 'Not tracked.' } })
    let created: unknown = 'unset'
    await act(async () => {
      created = await view.result.current.create({ folder: '/a', agent: 'claude', role: 'planner' })
    })
    expect(created).toBeNull()
    expect(errors).toEqual(['Not tracked.'])
  })

})

describe('useChats renaming and deleting', () => {
  it('renames a chat and shows the new title', async () => {
    const view = await mount(['/a'])
    const chat = chatsFor(view.result.current.lists, '/a').chats[1]
    let done = false
    await act(async () => {
      done = await view.result.current.rename(chatRecord({ ...chat }), 'Fresh name')
    })
    expect(done).toBe(true)
    expect(dm.chats.callsOf('rename')).toEqual([[{ folder: '/a', chatId: 'chat_a1', title: 'Fresh name' }]])
    expect(titles(view, '/a')).toEqual(['Fresh name', 'Newer'])
  })

  it('deletes a chat and drops it from the list', async () => {
    const view = await mount(['/a'])
    let done = false
    await act(async () => {
      done = await view.result.current.remove(chatRecord({ id: 'chat_a2', folder: '/a' }))
    })
    expect(done).toBe(true)
    expect(dm.chats.callsOf('delete')).toEqual([[{ folder: '/a', chatId: 'chat_a2' }]])
    expect(titles(view, '/a')).toEqual(['Older'])
  })

  it('reports a failed delete and returns false, refreshing the list so a chat that is already gone disappears', async () => {
    const view = await mount(['/a'])
    dm.chats.chats = dm.chats.chats.filter((chat) => chat.id !== 'chat_a2')
    let done = true
    await act(async () => {
      done = await view.result.current.remove(chatRecord({ id: 'chat_a2', folder: '/a' }))
    })
    expect(done).toBe(false)
    expect(errors).toEqual(['Chat not found.'])
    expect(titles(view, '/a')).toEqual(['Older'])
  })
})

describe('useChats pushed events', () => {
  it('reloads the folder of a chat whose turn started or ended, so its order and time are current', async () => {
    const view = await mount(['/a'])
    dm.chats.chats[0] = chatRecord({ ...dm.chats.chats[0], updatedAt: '2026-03-09T10:00:00.000Z' })
    act(() => dm.chats.emit({ type: 'turn', chatId: 'chat_a1', running: false }))
    await settle()
    expect(titles(view, '/a')).toEqual(['Older', 'Newer'])
  })

  it('reloads the folder when a chat’s model was switched, so its row names the new model', async () => {
    const view = await mount(['/a'])
    dm.chats.chats[0] = chatRecord({ ...dm.chats.chats[0], model: 'sonnet' })
    act(() => dm.chats.emit({ type: 'item', chatId: 'chat_a1', item: { id: 'm1', at: '2026-03-01T10:00:00.000Z', kind: 'model_change', from: 'opus', to: 'sonnet' } }))
    await settle()
    expect(chatsFor(view.result.current.lists, '/a').chats.find((chat) => chat.id === 'chat_a1')?.model).toBe('sonnet')
    const before = dm.chats.callsOf('list').length
    act(() => dm.chats.emit({ type: 'item', chatId: 'chat_a1', item: { id: 'u1', at: '2026-03-01T10:00:00.000Z', kind: 'user_message', text: 'hi' } }))
    await settle()
    expect(dm.chats.callsOf('list')).toHaveLength(before)
  })

  it('reloads the folder when an approval request or its decision is pushed, so the waiting count follows', async () => {
    const view = await mount(['/a'])
    const waiting = (): (number | undefined)[] => chatsFor(view.result.current.lists, '/a').chats.map((chat) => chat.pending)
    expect(waiting()).toEqual([0, 0])
    act(() => dm.chats.emitItem('chat_a1', approvalRequest('q1')))
    await settle()
    expect(chatsFor(view.result.current.lists, '/a').chats.find((chat) => chat.id === 'chat_a1')?.pending).toBe(1)
    expect(chatsFor(view.result.current.lists, '/a').chats.find((chat) => chat.id === 'chat_a2')?.pending).toBe(0)
    act(() => dm.chats.emitItem('chat_a1', approvalDecision('q1', 'deny')))
    await settle()
    expect(waiting()).toEqual([0, 0])
  })

})

describe('useChats sign-in and ignored events', () => {
  it('reloads the folder when a sign-in cut a chat’s turn short, so its record says a turn waits to be retried', async () => {
    const view = await mount(['/a'])
    const cutShort = (): (string | null | undefined)[] => chatsFor(view.result.current.lists, '/a').chats.map((chat) => chat.cutShortMessageId)
    expect(cutShort()).toEqual([undefined, undefined])
    dm.chats.chats[0] = chatRecord({ ...dm.chats.chats[0], cutShortMessageId: 'u1' })
    act(() => dm.chats.emitItem('chat_a1', { id: 'auth_1', at: '2026-03-01T10:00:00.000Z', kind: 'auth_required', agent: 'claude', message: 'Please log in.' }))
    await settle()
    expect(chatsFor(view.result.current.lists, '/a').chats.find((chat) => chat.id === 'chat_a1')?.cutShortMessageId).toBe('u1')
  })

  it('ignores deltas and events of chats it does not list, and stops listening when unmounted', async () => {
    const view = await mount(['/a'])
    const before = dm.chats.callsOf('list').length
    act(() => dm.chats.emit({ type: 'assistant_delta', chatId: 'chat_a1', itemId: 'i', delta: 'x' }))
    act(() => dm.chats.emit({ type: 'turn', chatId: 'chat_elsewhere', running: true }))
    await settle()
    expect(dm.chats.callsOf('list')).toHaveLength(before)
    view.unmount()
    act(() => dm.chats.emit({ type: 'turn', chatId: 'chat_a1', running: true }))
    await settle()
    expect(dm.chats.callsOf('list')).toHaveLength(before)
  })
})

describe('useChats with two windows', () => {
  it('shows a chat renamed in one window in the other, without a reload', async () => {
    const first = await mount(['/a'])
    const second = await mount(['/a'])
    const chat = chatsFor(first.result.current.lists, '/a').chats[1]
    await act(async () => {
      await first.result.current.rename(chatRecord({ ...chat }), 'Fresh name')
    })
    await settle()
    expect(titles(second, '/a')).toEqual(['Fresh name', 'Newer'])
  })

  it('drops a chat deleted in one window from the other', async () => {
    const first = await mount(['/a'])
    const second = await mount(['/a'])
    await act(async () => {
      await first.result.current.remove(chatRecord({ id: 'chat_a2', folder: '/a' }))
    })
    await settle()
    expect(titles(second, '/a')).toEqual(['Older'])
  })

  it('lists a chat created in one window in the other', async () => {
    const first = await mount(['/a'])
    const second = await mount(['/a'])
    await act(async () => {
      await first.result.current.create({ folder: '/a', agent: 'claude', role: 'planner' })
    })
    await settle()
    expect(titles(second, '/a')[0]).toBe('New chat')
  })

  it('ignores a change in a folder it is not showing, and stops listening when unmounted', async () => {
    const view = await mount(['/a'])
    const before = dm.chats.callsOf('list').length
    act(() => dm.chats.emit({ type: 'chats_changed', folder: '/b', chatId: 'chat_b1' }))
    await settle()
    expect(dm.chats.callsOf('list')).toHaveLength(before)
    view.unmount()
    act(() => dm.chats.emit({ type: 'chats_changed', folder: '/a', chatId: 'chat_a1' }))
    await settle()
    expect(dm.chats.callsOf('list')).toHaveLength(before)
  })
})
