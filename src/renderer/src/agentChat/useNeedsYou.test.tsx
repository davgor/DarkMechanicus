// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttentionItem } from '../../../shared/agents/agentChat'
import { deferred } from '../__mocks__/deferred'
import { FakeAgentChat } from '../__mocks__/fakeAgentChat'
import { settle } from '../__mocks__/settle'
import { useNeedsYou } from './useNeedsYou'

const FOLDER = 'C:\\project'

function item(chatId: string, promptId: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return { chatId, promptId, kind: 'approval', threadId: null, callsign: null, arbitration: 'off', title: 'Run tests?', shown: true, ...overrides }
}

function mount(api = new FakeAgentChat(), folder = FOLDER) {
  const view = renderHook((props: { folder: string }) => useNeedsYou(props.folder, api), { initialProps: { folder } })
  return { ...view, api }
}

const plain = (attention: ReadonlyMap<string, readonly AttentionItem[]>): Record<string, string[]> =>
  Object.fromEntries([...attention].map(([chatId, items]) => [chatId, items.map((entry) => entry.promptId)]))

afterEach(cleanup)

describe('useNeedsYou', () => {
  it('reads the folder once, groups the list by chat and applies pushes, dropping a chat on its empty exit list', async () => {
    const api = new FakeAgentChat()
    api.attentionResult = { ok: true, data: [item('chat_a', 'p1'), item('chat_b', 'p2'), item('chat_a', 'p3', { threadId: 'th_1' })] }
    const view = mount(api)
    await settle()
    expect(api.callsOf('attention')).toEqual([[{ folder: FOLDER }]])
    expect(plain(view.result.current)).toEqual({ chat_a: ['p1', 'p3'], chat_b: ['p2'] })

    act(() => api.emit({ folder: FOLDER, chatId: 'chat_b', type: 'attention', items: [item('chat_b', 'p2'), item('chat_b', 'p4')] }))
    expect(plain(view.result.current)).toEqual({ chat_a: ['p1', 'p3'], chat_b: ['p2', 'p4'] })

    act(() => api.emit({ folder: FOLDER, chatId: 'chat_a', type: 'attention', items: [] }))
    expect(plain(view.result.current)).toEqual({ chat_b: ['p2', 'p4'] })
    expect(api.callsOf('attention')).toHaveLength(1)
  })

  it('ignores other folders and other events', async () => {
    const view = mount()
    await settle()
    act(() => {
      view.api.emit({ folder: 'D:\\other', chatId: 'chat_x', type: 'attention', items: [item('chat_x', 'px')] })
      view.api.emit({ folder: FOLDER, chatId: 'chat_x', type: 'queued', count: 2 })
    })
    expect(plain(view.result.current)).toEqual({})
  })

  it('lets pushes that land during the read win over it, including an empty exit list', async () => {
    const api = new FakeAgentChat()
    api.attentionResult = { ok: true, data: [item('chat_a', 'old'), item('chat_b', 'gone')] }
    const held = api.hold('attention')
    const view = mount(api)
    act(() => {
      api.emit({ folder: FOLDER, chatId: 'chat_a', type: 'attention', items: [item('chat_a', 'new')] })
      api.emit({ folder: FOLDER, chatId: 'chat_b', type: 'attention', items: [] })
    })
    held.resolve()
    await settle()
    expect(plain(view.result.current)).toEqual({ chat_a: ['new'] })
  })
})

describe('useNeedsYou lifecycle', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('shows nothing when the read is refused and logs it, then still follows pushes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const api = new FakeAgentChat()
    api.failures.attention = { code: 'internal', message: 'main process busy' }
    const view = mount(api)
    await settle()
    expect(plain(view.result.current)).toEqual({})
    expect(warn).toHaveBeenCalledWith(`Needs-you read for ${FOLDER} was refused: main process busy`)
    act(() => api.emit({ folder: FOLDER, chatId: 'chat_a', type: 'attention', items: [item('chat_a', 'p1')] }))
    expect(plain(view.result.current)).toEqual({ chat_a: ['p1'] })
  })

  it('shows no badge and logs a rejected read without an unhandled rejection, then still follows pushes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const api = new FakeAgentChat()
      vi.spyOn(api, 'attention').mockRejectedValue(new Error('IPC channel closed'))
      const view = mount(api)
      await settle()
      // Node reports an unhandled rejection after the microtask queue drains, so wait one macrotask.
      const tick = deferred()
      setTimeout(tick.resolve, 0)
      await tick.promise
      expect(plain(view.result.current)).toEqual({})
      expect(warn).toHaveBeenCalledWith(`Needs-you read for ${FOLDER} failed: IPC channel closed`)
      expect(unhandled).toEqual([])
      act(() => api.emit({ folder: FOLDER, chatId: 'chat_a', type: 'attention', items: [item('chat_a', 'p1')] }))
      expect(plain(view.result.current)).toEqual({ chat_a: ['p1'] })
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('useNeedsYou unmount and folder changes', () => {
  it('unsubscribes on unmount and ignores a read that resolves afterwards', async () => {
    const api = new FakeAgentChat()
    const held = api.hold('attention')
    const view = mount(api)
    expect(api.subscribers()).toBe(1)
    view.unmount()
    expect(api.subscribers()).toBe(0)
    held.resolve()
    await settle()
  })

  it('resubscribes and rereads for a new folder', async () => {
    const view = mount()
    await settle()
    view.rerender({ folder: 'D:\\next' })
    await settle()
    expect(view.api.callsOf('attention')).toEqual([[{ folder: FOLDER }], [{ folder: 'D:\\next' }]])
    expect(view.api.subscribers()).toBe(1)
  })
})
