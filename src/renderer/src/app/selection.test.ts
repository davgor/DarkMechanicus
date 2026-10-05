import { describe, expect, it } from 'vitest'
import { agentView, chatRecord, folderView } from '../__mocks__/fixtures'
import { EMPTY_SELECTION, findFolder, isSelection, resolveSelection } from './selection'

const alpha = folderView({ path: '/a', name: 'a' })
const beta = folderView({ path: '/b', name: 'b' })

describe('isSelection', () => {
  it('accepts null or string members', () => {
    expect(isSelection({ folderPath: null, epicId: null })).toBe(true)
    expect(isSelection({ folderPath: '/a', epicId: 'ep_1' })).toBe(true)
  })

  it('rejects malformed values', () => {
    expect(isSelection(null)).toBe(false)
    expect(isSelection('x')).toBe(false)
    expect(isSelection({})).toBe(false)
    expect(isSelection({ folderPath: 1, epicId: null })).toBe(false)
    expect(isSelection({ folderPath: null, epicId: 2 })).toBe(false)
  })
})

describe('findFolder', () => {
  it('finds a tracked folder by path', () => {
    expect(findFolder([alpha, beta], '/b')).toBe(beta)
  })

  it('returns null for unknown or missing paths', () => {
    expect(findFolder([alpha], '/zzz')).toBeNull()
    expect(findFolder([alpha], null)).toBeNull()
  })
})

describe('resolveSelection', () => {
  it('leaves the stored selection alone until folders have loaded', () => {
    const stored = { folderPath: '/gone', epicId: 'ep_1' }
    expect(resolveSelection(stored, [], false)).toBe(stored)
  })

  it('keeps a stored selection whose folder is still tracked', () => {
    const stored = { folderPath: '/a', epicId: 'ep_1' }
    expect(resolveSelection(stored, [alpha, beta], true)).toEqual(stored)
  })

  it('falls back to the first folder when the stored one is gone', () => {
    const stored = { folderPath: '/gone', epicId: 'ep_1' }
    expect(resolveSelection(stored, [alpha, beta], true)).toEqual({ folderPath: '/a', epicId: null })
  })

  it('selects the first folder when nothing was stored', () => {
    expect(resolveSelection(EMPTY_SELECTION, [beta], true)).toEqual({ folderPath: '/b', epicId: null })
  })

  it('selects nothing without folders', () => {
    expect(resolveSelection({ folderPath: '/a', epicId: null }, [], true)).toEqual(EMPTY_SELECTION)
  })

  it('drops the epic when the folder cannot show epics', () => {
    const stored = { folderPath: '/a', epicId: 'ep_1' }
    const setup = folderView({ path: '/a', initialized: false })
    const missing = folderView({ path: '/a', available: false })
    expect(resolveSelection(stored, [setup], true)).toEqual({ folderPath: '/a', epicId: null })
    expect(resolveSelection(stored, [missing], true)).toEqual({ folderPath: '/a', epicId: null })
  })
})

describe('isSelection with an agents pane', () => {
  it('accepts the add-agent pane and a pane for each agent kind', () => {
    expect(isSelection({ folderPath: null, epicId: null, agentPane: { kind: 'add' } })).toBe(true)
    for (const agent of ['claude', 'codex', 'cursor']) {
      expect(isSelection({ folderPath: '/a', epicId: null, agentPane: { kind: 'agent', agent } })).toBe(true)
    }
  })

  it('still accepts a selection stored before agents existed', () => {
    expect(isSelection({ folderPath: '/a', epicId: null })).toBe(true)
  })

  it('rejects a pane that is not one of the agents screens', () => {
    const base = { folderPath: '/a', epicId: null }
    expect(isSelection({ ...base, agentPane: null })).toBe(false)
    expect(isSelection({ ...base, agentPane: 'add' })).toBe(false)
    expect(isSelection({ ...base, agentPane: { kind: 'settings' } })).toBe(false)
    expect(isSelection({ ...base, agentPane: { kind: 'agent' } })).toBe(false)
    expect(isSelection({ ...base, agentPane: { kind: 'agent', agent: 'gemini' } })).toBe(false)
  })
})

describe('resolveSelection with an agents pane', () => {
  const claudePane = { kind: 'agent', agent: 'claude' } as const
  const stored = { folderPath: '/a', epicId: null, agentPane: claudePane }

  it('keeps the add-agent pane, even with no folders', () => {
    const add = { folderPath: null, epicId: null, agentPane: { kind: 'add' } } as const
    expect(resolveSelection(add, [], true, { agents: [] })).toEqual(add)
  })

  it('keeps the pane of an agent that is still connected', () => {
    expect(resolveSelection(stored, [alpha], true, { agents: [agentView({ kind: 'claude' })] })).toEqual(stored)
  })

  it('keeps an agent pane until the agents have loaded', () => {
    expect(resolveSelection(stored, [alpha], true, { agents: null })).toEqual(stored)
  })

  it('falls back to the folder view when the stored agent is gone, without error', () => {
    const resolved = resolveSelection(stored, [alpha, beta], true, { agents: [agentView({ kind: 'codex' })] })
    expect(resolved).toEqual({ folderPath: '/a', epicId: null })
    expect(resolved).not.toHaveProperty('agentPane')
  })

  it('falls back to the first folder when the folder is gone as well', () => {
    const gone = { folderPath: '/gone', epicId: null, agentPane: claudePane }
    expect(resolveSelection(gone, [beta], true, { agents: [] })).toEqual({ folderPath: '/b', epicId: null })
  })

  it('falls back to nothing selected when no folder and no agent remain', () => {
    expect(resolveSelection(stored, [], true, { agents: [] })).toEqual(EMPTY_SELECTION)
  })

  it('carries the pane over to the first folder when the stored folder is gone', () => {
    const add = { folderPath: '/gone', epicId: null, agentPane: { kind: 'add' } } as const
    expect(resolveSelection(add, [beta], true, { agents: [] })).toEqual({
      folderPath: '/b',
      epicId: null,
      agentPane: { kind: 'add' }
    })
  })
})

describe('isSelection with a chat', () => {
  it('accepts a chat id beside the folder, and still accepts selections stored without one', () => {
    expect(isSelection({ folderPath: '/a', epicId: null, chatId: 'chat_1' })).toBe(true)
    expect(isSelection({ folderPath: '/a', epicId: null })).toBe(true)
  })

  it('rejects a chat id that is not a string', () => {
    expect(isSelection({ folderPath: '/a', epicId: null, chatId: 3 })).toBe(false)
    expect(isSelection({ folderPath: '/a', epicId: null, chatId: null })).toBe(false)
  })
})

describe('resolveSelection with a chat', () => {
  const stored = { folderPath: '/a', epicId: null, chatId: 'chat_1' }
  const chat = chatRecord({ id: 'chat_1', folder: '/a' })

  it('keeps the chat while it is still stored in its folder', () => {
    expect(resolveSelection(stored, [alpha], true, { agents: [], chats: [chat] })).toEqual(stored)
  })

  it('keeps the chat until the folder\'s chats have loaded', () => {
    expect(resolveSelection(stored, [alpha], true, { agents: [], chats: null })).toEqual(stored)
  })

  it('falls back to the folder home when the chat was deleted, without error', () => {
    const resolved = resolveSelection(stored, [alpha], true, { agents: [], chats: [chatRecord({ id: 'chat_2', folder: '/a' })] })
    expect(resolved).toEqual({ folderPath: '/a', epicId: null })
    expect(resolved).not.toHaveProperty('chatId')
  })

  it('falls back to the folder home when the folder has no chats at all', () => {
    expect(resolveSelection(stored, [alpha], true, { agents: [], chats: [] })).toEqual({ folderPath: '/a', epicId: null })
  })

  it('drops the chat when its folder is gone, and picks the first folder', () => {
    expect(resolveSelection(stored, [beta], true, { agents: [], chats: [chat] })).toEqual({ folderPath: '/b', epicId: null })
  })

  it('drops the chat when the folder cannot hold chats (not initialized, or missing)', () => {
    const setup = folderView({ path: '/a', initialized: false })
    const missing = folderView({ path: '/a', available: false })
    expect(resolveSelection(stored, [setup], true, { agents: [], chats: [chat] })).toEqual({ folderPath: '/a', epicId: null })
    expect(resolveSelection(stored, [missing], true, { agents: [], chats: [chat] })).toEqual({ folderPath: '/a', epicId: null })
  })

  it('leaves it to the folder lookup until folders have loaded', () => {
    expect(resolveSelection(stored, [], false, { agents: null, chats: null })).toBe(stored)
  })
})
