import { describe, expect, it } from 'vitest'
import { agentView, chatRecord, folderView } from '../__mocks__/fixtures'
import type { MainView } from './chooseView'
import { chooseView } from './chooseView'

const ready = folderView()
const setup = folderView({ initialized: false })
const missing = folderView({ available: false })

const CASES: [string, Parameters<typeof chooseView>[0], MainView][] = [
  ['folders are still loading', { loaded: false, folder: ready, epicId: null }, { kind: 'loading', what: 'folders' }],
  ['no folder is selected', { loaded: true, folder: null, epicId: null }, { kind: 'welcome' }],
  ['the folder is gone', { loaded: true, folder: missing, epicId: null }, { kind: 'unavailable', folder: missing }],
  ['the folder is not initialized', { loaded: true, folder: setup, epicId: null }, { kind: 'folder', folder: setup, tab: 'source' }],
  ['an epic is selected', { loaded: true, folder: ready, epicId: 'ep_1' }, { kind: 'epic', folder: ready, epicId: 'ep_1' }],
  ['no epic is selected', { loaded: true, folder: ready, epicId: null }, { kind: 'folder', folder: ready, tab: 'source' }],
  ['the folder was left on Epics', { loaded: true, folder: ready, epicId: null, folderTab: 'epics' }, { kind: 'folder', folder: ready, tab: 'epics' }],
  ['an uninitialized folder was left on Epics', { loaded: true, folder: setup, epicId: null, folderTab: 'epics' }, { kind: 'folder', folder: setup, tab: 'epics' }]
]

describe('chooseView', () => {
  it.each(CASES)('shows the right view when %s', (_name, input, expected) => {
    expect(chooseView(input)).toEqual(expected)
  })

  it('ignores a stale epic on an uninitialized folder', () => {
    expect(chooseView({ loaded: true, folder: setup, epicId: 'ep_1' }).kind).toBe('folder')
  })

  it('ignores a stale epic on an unavailable folder', () => {
    const both = folderView({ available: false, initialized: false })
    expect(chooseView({ loaded: true, folder: both, epicId: 'ep_1' }).kind).toBe('unavailable')
  })

  it('shows loading whatever the selection until folders arrive', () => {
    expect(chooseView({ loaded: false, folder: null, epicId: null }).kind).toBe('loading')
  })
})

describe('chooseView with an agents pane', () => {
  const claude = agentView({ kind: 'claude' })

  it('shows the add-agent pane over the folder view', () => {
    const view = chooseView({ loaded: true, folder: ready, epicId: null, agentPane: { kind: 'add' }, agents: [] })
    expect(view).toEqual({ kind: 'add-agent' })
  })

  it('shows the add-agent pane when no folder is tracked either', () => {
    expect(chooseView({ loaded: true, folder: null, epicId: null, agentPane: { kind: 'add' }, agents: [] }).kind).toBe(
      'add-agent'
    )
  })

  it('shows the page of a connected agent, carrying the agent', () => {
    const pane = { kind: 'agent', agent: 'claude' } as const
    expect(chooseView({ loaded: true, folder: ready, epicId: 'ep_1', agentPane: pane, agents: [claude] })).toEqual({
      kind: 'agent',
      agent: claude
    })
  })

  it('shows loading while the agents are still being listed', () => {
    const pane = { kind: 'agent', agent: 'claude' } as const
    expect(chooseView({ loaded: true, folder: ready, epicId: null, agentPane: pane, agents: null })).toEqual({ kind: 'loading', what: 'agents' })
  })

  it('falls back to the folder view when the agent is gone', () => {
    const pane = { kind: 'agent', agent: 'codex' } as const
    expect(chooseView({ loaded: true, folder: ready, epicId: null, agentPane: pane, agents: [claude] })).toEqual({
      kind: 'folder',
      folder: ready,
      tab: 'source'
    })
  })

  it('still shows loading until folders arrive', () => {
    const view = chooseView({ loaded: false, folder: null, epicId: null, agentPane: { kind: 'add' }, agents: [] })
    expect(view.kind).toBe('loading')
  })
})

describe('chooseView with a chat', () => {
  const chat = chatRecord({ id: 'chat_1', folder: ready.path })
  const open = { loaded: true, folder: ready, epicId: null, chatId: 'chat_1' }

  it('shows the chat, carrying the folder and the chat record', () => {
    expect(chooseView({ ...open, chats: [chat] })).toEqual({ kind: 'chat', folder: ready, chat })
  })

  it('shows loading while the folder\'s chats are still being listed', () => {
    expect(chooseView({ ...open, chats: null })).toEqual({ kind: 'loading', what: 'chat' })
  })

  it('falls back to the folder home when the chat is gone', () => {
    expect(chooseView({ ...open, chats: [chatRecord({ id: 'chat_2' })] })).toEqual({ kind: 'folder', folder: ready, tab: 'source' })
  })

  it('never shows a chat for a folder that cannot hold one', () => {
    expect(chooseView({ ...open, folder: setup, chats: [chat] }).kind).toBe('folder')
    expect(chooseView({ ...open, folder: missing, chats: [chat] }).kind).toBe('unavailable')
  })

  it('shows an agents screen over the chat', () => {
    const view = chooseView({ ...open, chats: [chat], agentPane: { kind: 'add' }, agents: [] })
    expect(view).toEqual({ kind: 'add-agent' })
  })
})
