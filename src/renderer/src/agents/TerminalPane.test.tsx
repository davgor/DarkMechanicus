// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within, type BoundFunctions, type queries, type RenderResult } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChatRecord } from '../../../shared/agents/chat'
import { TERMINAL_INPUT_MAX_BYTES } from '../../../shared/agents/terminalApi'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeTerminalKit } from '../__mocks__/fakeTerminalKit'
import { FakeTerminals } from '../__mocks__/fakeTerminals'
import { chatRecord } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { installRootTokens, tokenSource } from '../__mocks__/rootTokens'
import { settle } from '../__mocks__/settle'
import { createLiveTerminals, LiveTerminalsContext, type LiveTerminals } from './liveTerminals'
import { TerminalPane } from './TerminalPane'
import { rootTokens, terminalTheme } from './terminalTheme'

const CHAT_A = chatRecord({ id: 'chat_a', folder: '/a', title: 'Fix the build', agent: 'claude', role: 'worker' })
const CHAT_B = chatRecord({ id: 'chat_b', folder: '/a', title: 'Other chat', agent: 'claude' })
const EXITED = { exitCode: 0, signal: null, message: null, resumed: false }

let terminals: FakeTerminals
let kit: FakeTerminalKit
let scheduler: ManualScheduler
let live: LiveTerminals | null

beforeEach(() => {
  const dm = new FakeDm()
  terminals = new FakeTerminals()
  dm.terminals = terminals
  window.dm = dm
  kit = new FakeTerminalKit()
  scheduler = new ManualScheduler()
  live = createLiveTerminals()
})

afterEach(() => {
  cleanup()
  document.head.innerHTML = ''
})

function pane(chat: ChatRecord): JSX.Element {
  const shown = <TerminalPane folder="/a" chat={chat} agentName="Claude Code" kit={kit} scheduler={scheduler} />
  return live === null ? shown : <LiveTerminalsContext.Provider value={live}>{shown}</LiveTerminalsContext.Provider>
}

async function show(chat: ChatRecord = CHAT_A): Promise<RenderResult> {
  const mounted = render(pane(chat))
  await settle()
  return mounted
}

const details = (): BoundFunctions<typeof queries> => within(screen.getByRole('list', { name: 'Chat details' }))
const host = (): HTMLElement => screen.getByTestId('terminal-host')
const notice = (): string | null => screen.queryByRole('status')?.textContent ?? null

describe('TerminalPane attaching', () => {
  it('attaches to the chat once it is shown, says checking while the attach waits, then shows its terminal focused', async () => {
    terminals.hold()
    render(pane(CHAT_A))
    await settle()
    expect(terminals.calls).toEqual([['/a', 'chat_a']])
    expect(screen.getByRole('heading', { level: 1, name: 'Fix the build' })).toBeTruthy()
    expect(details().getByText('Checking')).toBeTruthy()
    expect(details().getByText('Claude Code')).toBeTruthy()
    expect(kit.views).toHaveLength(0)

    terminals.release()
    await settle()
    expect(details().getByText('Running')).toBeTruthy()
    expect(kit.views).toHaveLength(1)
    expect(kit.latest().host).toBe(host())
    expect(kit.latest().focused).toBe(1)
    expect(terminals.calls).toHaveLength(1)
  })

  it('focuses the terminal when the pane is clicked', async () => {
    await show()
    fireEvent.click(host())
    expect(kit.latest().focused).toBe(2)
  })
})

describe('TerminalPane: a chat that does not start', () => {
  it('shows the sign-in card instead of a terminal when the chat’s agent is signed out, and starts no sign-in by itself', async () => {
    terminals.outcomes.chat_a = { state: 'signed_out', message: 'Claude Code is signed out.' }
    await show()
    expect(details().getByText('Signed out')).toBeTruthy()
    expect(notice()).toBe('Claude Code is signed out.')
    expect(within(screen.getByRole('group', { name: 'Sign in to Claude Code' })).getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(kit.views).toHaveLength(0)
    expect(terminals.signIns).toEqual([])
  })

  it('shows why a refused attach started nothing', async () => {
    terminals.outcomes.chat_a = { state: 'refused', message: 'The folder /a moved.' }
    await show()
    expect(details().getByText('Refused')).toBeTruthy()
    expect(notice()).toBe('The folder /a moved.')
    expect(kit.views).toHaveLength(0)
  })

  it('shows a failed start, and an attach main refused, as failed with the reason', async () => {
    terminals.outcomes.chat_a = { state: 'failed', message: 'posix_spawnp failed.' }
    await show()
    expect(details().getByText('Failed')).toBeTruthy()
    expect(notice()).toBe('posix_spawnp failed.')
    cleanup()

    terminals.outcomes.chat_a = { error: 'No chat chat_a in /a.' }
    await show()
    expect(details().getByText('Failed')).toBeTruthy()
    expect(notice()).toBe('No chat chat_a in /a.')
  })
})

describe('TerminalPane screen', () => {
  it('sizes the PTY to the pane, then paints main’s snapshot, then what the CLI prints after it', async () => {
    terminals.screens.chat_a = '\u001b[1mclaude\u001b[0m> '
    await show()
    const view = kit.latest()
    expect(terminals.latest().resizes).toEqual([[100, 30]])
    expect(view.written).toEqual(['\u001b[1mclaude\u001b[0m> '])
    terminals.latest().emitOutput('hello')
    expect(view.written).toEqual(['\u001b[1mclaude\u001b[0m> ', 'hello'])
  })

  it('writes nothing for an empty snapshot', async () => {
    await show()
    expect(kit.latest().written).toEqual([])
  })

  it('does not send a size while the pane has none', async () => {
    kit.size = null
    await show()
    expect(terminals.latest().resizes).toEqual([])
  })

  it('takes its colors from the :root tokens and the app’s monospace face', async () => {
    installRootTokens()
    await show()
    const { options } = kit.latest()
    expect(options.theme).toEqual(terminalTheme(rootTokens(document)))
    expect(options.theme.background).toBe(tokenSource('--code-bg'))
    expect(options.fontFamily).toBe(rootTokens(document)('--font-mono'))
    expect(options.fontFamily).toContain('IBM Plex Mono')
  })
})

describe('TerminalPane input', () => {
  it('sends what is typed to the CLI', async () => {
    await show()
    kit.latest().type('ls\r')
    kit.latest().type('\u0003')
    expect(terminals.latest().writes).toEqual(['ls\r', '\u0003'])
  })

  it('sends a paste over 64 KiB as messages main accepts', async () => {
    await show()
    kit.latest().type('x'.repeat(TERMINAL_INPUT_MAX_BYTES + 10))
    expect(terminals.latest().writes.map((chunk) => chunk.length)).toEqual([TERMINAL_INPUT_MAX_BYTES, 10])
  })
})

describe('TerminalPane resize', () => {
  it('follows the pane’s size once it settles, and sends only a size that changed', async () => {
    await show()
    const terminal = terminals.latest()
    expect(kit.watched()).toEqual([host()])

    kit.resizeTo({ cols: 120, rows: 40 })
    kit.resizeTo({ cols: 130, rows: 45 })
    expect(terminal.resizes).toEqual([[100, 30]])
    expect(scheduler.timeouts()).toEqual([80])

    scheduler.fireTimeouts()
    expect(terminal.resizes).toEqual([
      [100, 30],
      [130, 45]
    ])

    kit.resizeTo({ cols: 130, rows: 45 })
    scheduler.fireTimeouts()
    kit.resizeTo(null)
    scheduler.fireTimeouts()
    expect(terminal.resizes).toHaveLength(2)
  })
})

describe('TerminalPane exit', () => {
  it('says the CLI exited, keeps its last screen, and sends nothing more', async () => {
    await show()
    terminals.latest().emitExit(EXITED)
    await settle()
    expect(details().getByText('Exited')).toBeTruthy()
    expect(notice()).toBe('The CLI exited with code 0.')
    expect(kit.latest().disposed).toBe(false)
    kit.latest().type('more')
    expect(terminals.latest().writes).toEqual([])
  })

  it('says the terminal was stopped, and why, when main ended it', async () => {
    await show()
    terminals.latest().emitExit({ exitCode: 0, signal: 9, message: 'The chat’s agent was removed, so its terminal was stopped.', resumed: false })
    await settle()
    expect(details().getByText('Stopped')).toBeTruthy()
    expect(notice()).toBe('The chat’s agent was removed, so its terminal was stopped.')
  })

  it('names the signal a CLI was ended by', async () => {
    await show()
    terminals.latest().emitExit({ exitCode: 0, signal: 15, message: null, resumed: false })
    await settle()
    expect(notice()).toBe('The CLI exited on signal 15.')
  })
})

const button = (name: string): HTMLElement | null => screen.queryByRole('button', { name })

describe('TerminalPane starting again', () => {
  it('offers neither while the CLI runs, and Start again alone after the exit of a new session', async () => {
    await show()
    expect([button('Start again'), button('New session')]).toEqual([null, null])

    terminals.latest().emitExit(EXITED)
    await settle()

    expect(button('Start again')).toBeTruthy()
    expect(button('New session')).toBeNull()
  })

  it('attaches again on Start again, resuming, and shows the new terminal in place of the old screen', async () => {
    terminals.screens.chat_a = 'resumed screen'
    await show()
    const first = kit.latest()
    terminals.latest().emitExit(EXITED)
    await settle()

    fireEvent.click(screen.getByRole('button', { name: 'Start again' }))
    await settle()

    expect(terminals.calls).toEqual([
      ['/a', 'chat_a'],
      ['/a', 'chat_a']
    ])
    expect(terminals.options.map((options) => options?.newSession ?? false)).toEqual([false, false])
    expect(first.disposed).toBe(true)
    expect(kit.latest()).not.toBe(first)
    expect(kit.latest().written).toEqual(['resumed screen'])
    expect(details().getByText('Running')).toBeTruthy()
    expect([notice(), button('Start again')]).toEqual([null, null])
    kit.latest().type('hi')
    expect(terminals.latest().writes).toEqual(['hi'])
  })
})

describe('TerminalPane new session and idle stop', () => {
  it('offers New session after the exit of a resumed session, which attaches asking for a new session', async () => {
    await show()
    terminals.latest().emitOutput('No conversation found with session ID: 7c9e6679\r\n')
    terminals.latest().emitExit({ exitCode: 1, signal: 0, message: null, resumed: true })
    await settle()
    expect(notice()).toBe('The CLI exited with code 1 and may not have been able to continue this chat’s earlier session. New session starts a new one.')
    expect(kit.latest().written).toEqual(['No conversation found with session ID: 7c9e6679\r\n'])
    expect(kit.latest().disposed).toBe(false)

    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    await settle()

    expect(terminals.options.map((options) => options?.newSession ?? false)).toEqual([false, true])
    expect(details().getByText('Running')).toBeTruthy()
  })

  it('says a terminal stopped for being idle was stopped, and starts it again on Start again', async () => {
    await show()
    terminals.latest().emitExit({ exitCode: 0, signal: 9, message: 'Stopped after 10 minutes idle.', resumed: false })
    await settle()
    expect(details().getByText('Stopped')).toBeTruthy()
    expect(notice()).toBe('Stopped after 10 minutes idle.')

    fireEvent.click(screen.getByRole('button', { name: 'Start again' }))
    await settle()

    expect(terminals.calls).toHaveLength(2)
    expect(details().getByText('Running')).toBeTruthy()
  })

  it('asks for a new session once, in the chat it was chosen in: not for the next chat shown, nor when that chat is shown again', async () => {
    const mounted = await show(CHAT_A)
    terminals.latest().emitExit({ exitCode: 1, signal: 0, message: null, resumed: true })
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'New session' }))
    await settle()

    mounted.rerender(pane(CHAT_B))
    await settle()
    mounted.rerender(pane(CHAT_A))
    await settle()

    expect(terminals.calls.slice(2)).toEqual([
      ['/a', 'chat_b'],
      ['/a', 'chat_a']
    ])
    expect(terminals.options.map((options) => options?.newSession ?? false)).toEqual([false, true, false, false])
  })
})

describe('TerminalPane switching chats', () => {
  it('disposes the shown terminal and attaches the other chat, from its own snapshot, while the first PTY runs on', async () => {
    terminals.screens = { chat_a: 'screen of a', chat_b: 'screen of b' }
    const mounted = await show(CHAT_A)
    const first = terminals.latest()
    const firstView = kit.latest()

    mounted.rerender(pane(CHAT_B))
    await settle()
    expect(firstView.disposed).toBe(true)
    expect(first.listenerCounts().output).toBe(0)
    expect(first.closed).toBe(false)
    expect(kit.views).toHaveLength(2)
    expect(kit.latest().written).toEqual(['screen of b'])
    expect(terminals.calls).toEqual([
      ['/a', 'chat_a'],
      ['/a', 'chat_b']
    ])
    expect(live?.isLive('chat_a')).toBe(true)
    expect(live?.isLive('chat_b')).toBe(true)

    mounted.rerender(pane(CHAT_A))
    await settle()
    expect(first.closed).toBe(true)
    expect(kit.latest().written).toEqual(['screen of a'])
    expect(kit.views.filter((view) => !view.disposed)).toHaveLength(1)
  })
})

describe('TerminalPane going away', () => {
  it('stops watching the pane’s size and cancels a pending fit when it goes', async () => {
    const mounted = await show()
    kit.resizeTo({ cols: 120, rows: 40 })
    mounted.unmount()
    expect(kit.latest().disposed).toBe(true)
    expect(kit.watched()).toEqual([])
    expect(scheduler.timeouts()).toEqual([])
  })

  it('keeps the terminal of an attach that answers after the pane went, without showing it', async () => {
    terminals.hold()
    const mounted = render(pane(CHAT_A))
    await settle()
    mounted.unmount()
    terminals.release()
    await settle()
    expect(kit.views).toHaveLength(0)
    expect(live?.isLive('chat_a')).toBe(true)
    expect(terminals.latest().closed).toBe(false)
  })

  it('closes its own terminal when it goes, outside a shell that keeps them', async () => {
    live = null
    const mounted = await show()
    mounted.unmount()
    expect(terminals.latest().closed).toBe(true)
  })

  it('closes the terminal of an attach that answers after the pane went, outside a shell that keeps them', async () => {
    live = null
    terminals.hold()
    const mounted = render(pane(CHAT_A))
    await settle()
    mounted.unmount()
    terminals.release()
    await settle()
    expect(terminals.latest().closed).toBe(true)
  })
})

describe('TerminalPane layout', () => {
  it('renders no app window of its own: the terminal is in the pane', async () => {
    const opened: unknown[] = []
    window.open = (...args: unknown[]) => {
      opened.push(args)
      return null
    }
    const wrapper = ({ children }: { children: ReactNode }): JSX.Element => <main aria-label="Workspace">{children}</main>
    render(pane(CHAT_A), { wrapper })
    await settle()
    expect(within(screen.getByRole('main', { name: 'Workspace' })).getByTestId('terminal-host')).toBe(kit.latest().host)
    expect(opened).toEqual([])
  })
})

describe('TerminalPane sign-in card', () => {
  const SIGNED_IN = { state: 'signed_in', reason: 'Claude Code reports it is signed in.' } as const
  const SIGNED_OUT = { state: 'signed_out', reason: 'Claude Code reports it is not signed in.' } as const
  let statuses: unknown[]

  /** A signed-out chat's pane, Sign in pressed: the CLI's login runs in the pane. */
  async function signingIn(): Promise<void> {
    statuses = []
    terminals.outcomes.chat_a = { state: 'signed_out', message: 'Claude Code is signed out.' }
    render(<TerminalPane folder="/a" chat={CHAT_A} agentName="Claude Code" kit={kit} scheduler={scheduler} onAgentStatus={(status) => statuses.push(status)} />)
    await settle()
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))
    await settle()
  }

  it("runs the CLI's login in a terminal in the pane, naming only the agent", async () => {
    await signingIn()

    expect(terminals.signIns).toEqual(['claude'])
    expect(kit.views).toHaveLength(1)
    expect(kit.latest().host).toBe(screen.getByTestId('sign-in-terminal-host'))
    kit.latest().type('y\r')
    expect(terminals.latestSignIn().writes).toEqual(['y\r'])
    expect(terminals.calls).toHaveLength(1)
  })

  it('checks the status once the login ends, and starts the chat when it says signed in', async () => {
    await signingIn()
    window.dm.agentStatus = () => Promise.resolve(SIGNED_IN)
    delete terminals.outcomes.chat_a

    terminals.latestSignIn().emitExit({ exitCode: 0, signal: null, message: null, resumed: false })
    await settle()

    expect(statuses).toEqual([SIGNED_IN])
    expect(terminals.calls).toEqual([
      ['/a', 'chat_a'],
      ['/a', 'chat_a']
    ])
    expect(terminals.options[1]).toEqual(undefined)
    expect(details().getByText('Running')).toBeTruthy()
    expect(kit.latest().host).toBe(host())
    expect(terminals.latestSignIn().closed).toBe(true)
  })

  it('starts nothing while the status still says signed out, and offers Sign in again', async () => {
    await signingIn()
    window.dm.agentStatus = () => Promise.resolve(SIGNED_OUT)

    terminals.latestSignIn().emitExit({ exitCode: 1, signal: null, message: null, resumed: false })
    await settle()

    expect(statuses).toEqual([SIGNED_OUT])
    expect(terminals.calls).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy()
  })
})
