// @vitest-environment jsdom
/**
 * A chat stored before chats became terminals: it opens as a terminal like any other, and its stored transcript is
 * readable read-only from Earlier conversation (`docs/design/chat-shells.md`, "Existing chats and their transcripts").
 * A resume its CLI could not continue says so, and offers a new session.
 */
import { cleanup, fireEvent, render, screen, within, type RenderResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatItem, ChatRecord } from '../../../shared/agents/chat'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeTerminalKit } from '../__mocks__/fakeTerminalKit'
import { FakeTerminals } from '../__mocks__/fakeTerminals'
import { chatRecord } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { TerminalPane } from './TerminalPane'

/** A Claude chat as the app stored it before terminals: an SDK session id, and no grants, kickoff or started flag. */
const OLD_CHAT = chatRecord({ id: 'chat_old', folder: '/a', title: 'Old SDK chat', agent: 'claude', role: 'planner', sessionId: '42eb1ddb-3b32-4ca9-9352-918f157b9ad7' })
const NEW_CHAT = chatRecord({ id: 'chat_new', folder: '/a', title: 'New chat', agent: 'claude', role: 'planner' })

const AT = '2026-10-31T16:45:14.188Z'
const OLD_ITEMS: ChatItem[] = [
  { id: 'item_1', at: AT, kind: 'user_message', text: 'Remember the code word OSPREY. Reply with exactly: OK, noted.' },
  { id: 'msg_1', at: AT, kind: 'assistant_text', text: 'OK, noted.' },
  {
    id: 'item_req',
    at: AT,
    kind: 'approval_request',
    requestId: 'req_1',
    category: 'command',
    tool: 'Bash',
    summary: 'Run npm install',
    input: { command: 'npm install' }
  }
]

let dm: FakeDm
let terminals: FakeTerminals
let kit: FakeTerminalKit

beforeEach(() => {
  dm = new FakeDm()
  terminals = new FakeTerminals()
  dm.terminals = terminals
  dm.chats.chats = [OLD_CHAT, NEW_CHAT]
  dm.chats.transcripts.chat_old = OLD_ITEMS
  window.dm = dm
  kit = new FakeTerminalKit()
})

afterEach(() => {
  cleanup()
})

async function show(chat: ChatRecord): Promise<RenderResult> {
  const mounted = render(<TerminalPane folder="/a" chat={chat} agentName="Claude Code" kit={kit} scheduler={new ManualScheduler()} />)
  await settle()
  return mounted
}

const earlier = (): HTMLElement | null => screen.queryByRole('button', { name: 'Earlier conversation' })
const toggle = (): void => {
  fireEvent.click(screen.getByRole('button', { name: 'Earlier conversation' }))
}

describe('TerminalPane: a chat stored before terminals', () => {
  it('opens as a terminal, with Earlier conversation above it', async () => {
    await show(OLD_CHAT)

    expect(terminals.calls).toEqual([['/a', 'chat_old']])
    expect(kit.views).toHaveLength(1)
    const control = earlier()
    expect(control?.getAttribute('aria-expanded')).toBe('false')
    expect(control?.compareDocumentPosition(screen.getByTestId('terminal-host')) ?? 0).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('opens the stored transcript read-only: no composer, no approval to answer, and nothing is sent or stored', async () => {
    await show(OLD_CHAT)

    toggle()

    const panel = screen.getByRole('region', { name: 'Earlier conversation' })
    const transcript = within(panel).getByRole('log', { name: 'Transcript' })
    expect(within(transcript).getByText('Remember the code word OSPREY. Reply with exactly: OK, noted.')).toBeTruthy()
    expect(within(transcript).getByText('OK, noted.')).toBeTruthy()
    expect(within(panel).getByRole('article', { name: 'Approval request: Run a command' })).toBeTruthy()
    expect(within(panel).queryByRole('group', { name: 'Answer' })).toBe(null)
    expect(within(panel).queryByRole('button', { name: 'Allow once' })).toBe(null)
    expect(screen.queryByRole('textbox')).toBe(null)
    expect(screen.queryByRole('button', { name: 'Send' })).toBe(null)
    expect(dm.chats.callsOf('read')).toEqual([[{ folder: '/a', chatId: 'chat_old' }]])
    expect(dm.chats.calls.map((call) => call.method)).toEqual(['read'])
    expect(dm.chats.transcripts.chat_old).toEqual(OLD_ITEMS)
  })

  it('hides the transcript again, the terminal staying where it was', async () => {
    await show(OLD_CHAT)
    toggle()

    toggle()

    expect(screen.queryByRole('region', { name: 'Earlier conversation' })).toBe(null)
    expect(earlier()?.getAttribute('aria-expanded')).toBe('false')
    expect(kit.views).toHaveLength(1)
    expect(kit.latest().disposed).toBe(false)
  })
})

describe('TerminalPane: Earlier conversation of the chat shown', () => {
  it('shows no Earlier conversation for a chat with no stored transcript, or one that cannot be read', async () => {
    await show(NEW_CHAT)
    expect(earlier()).toBe(null)
    expect(dm.chats.callsOf('read')).toEqual([[{ folder: '/a', chatId: 'chat_new' }]])
    cleanup()

    dm.chats.failures.read = { code: 'not_found', message: 'Chat not found.' }
    await show(OLD_CHAT)
    expect(earlier()).toBe(null)
    expect(kit.views).toHaveLength(2)
  })

  it('shows no Earlier conversation when the read fails outright, and the terminal still opens', async () => {
    dm.chats.read = async () => {
      throw new Error('The window lost its connection to main.')
    }

    await show(OLD_CHAT)

    expect(earlier()).toBe(null)
    expect(kit.views).toHaveLength(1)
  })

  it('reads the transcript of the chat shown, and closes the one of a chat no longer shown', async () => {
    const mounted = await show(OLD_CHAT)
    toggle()

    mounted.rerender(<TerminalPane folder="/a" chat={NEW_CHAT} agentName="Claude Code" kit={kit} scheduler={new ManualScheduler()} />)
    await settle()

    expect(earlier()).toBe(null)
    expect(screen.queryByText('OK, noted.')).toBe(null)
    expect(dm.chats.callsOf('read')).toEqual([[{ folder: '/a', chatId: 'chat_old' }], [{ folder: '/a', chatId: 'chat_new' }]])
  })
})

describe('TerminalPane: a resume the CLI could not continue', () => {
  it('says the earlier session may not have been continued, and starts a new one on New session', async () => {
    await show(OLD_CHAT)
    terminals.latest().emitOutput('No conversation found with session ID: 42eb1ddb-3b32-4ca9-9352-918f157b9ad7\r\n')
    terminals.latest().emitExit({ exitCode: 1, signal: 0, message: null, resumed: true })
    await settle()

    expect(screen.getByRole('status').textContent).toBe(
      'The CLI exited with code 1 and may not have been able to continue this chat’s earlier session. New session starts a new one.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    await settle()

    expect(terminals.options.map((options) => options?.newSession ?? false)).toEqual([false, true])
  })

  it('says only the exit when a resumed session ended well', async () => {
    await show(OLD_CHAT)
    terminals.latest().emitExit({ exitCode: 0, signal: 0, message: null, resumed: true })
    await settle()

    expect(screen.getByRole('status').textContent).toBe('The CLI exited with code 0.')
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy()
  })
})
