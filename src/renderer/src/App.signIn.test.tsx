// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppHarness } from './__mocks__/appHarness'
import { FakeTerminals } from './__mocks__/fakeTerminals'
import { agentView, folderView } from './__mocks__/fixtures'
import { settle } from './__mocks__/settle'

let h: AppHarness
let terminals: FakeTerminals

beforeEach(() => {
  window.localStorage.clear()
  h = new AppHarness()
  terminals = new FakeTerminals()
  h.dm.terminals = terminals
  h.dm.folders = [folderView({ path: '/a', name: 'alpha', displayPath: '~/code/alpha' })]
  h.dm.agents = [agentView({ kind: 'claude', version: '2.1.4' })]
  h.dm.agentStatuses.claude = { state: 'signed_out', reason: 'Claude Code reports it is not signed in.' }
})

afterEach(cleanup)

const sidebar = (): ReturnType<typeof within> => within(screen.getByRole('complementary', { name: 'Tracked folders' }))
const workspace = (): ReturnType<typeof within> => within(screen.getByRole('main', { name: 'Workspace' }))
const signInView = (): HTMLElement | null => screen.queryByRole('region', { name: 'Sign in to Claude Code' })
const agentPageShown = (): boolean => screen.queryByRole('heading', { level: 1, name: 'Claude Code' }) !== null

/** The app on Claude Code's agent page, with its Sign in pressed. */
async function signInFromAgentPage(): Promise<void> {
  h.mount()
  await settle()
  fireEvent.click(sidebar().getByRole('button', { name: /Claude Code/ }))
  await settle()
  fireEvent.click(workspace().getByRole('button', { name: 'Sign in' }))
  await settle()
}

describe('App sign-in view', () => {
  it("opens from the agent page in app-main, in this window, running the agent's login, with the page hidden behind it", async () => {
    const opened: unknown[] = []
    window.open = (...args: unknown[]) => {
      opened.push(args)
      return null
    }

    await signInFromAgentPage()

    const view = signInView()
    expect(view).not.toBeNull()
    expect(workspace().getByRole('region', { name: 'Sign in to Claude Code' })).toBe(view)
    expect(terminals.signIns).toEqual(['claude'])
    expect(h.terminalKit.latest().host).toBe(within(view as HTMLElement).getByTestId('sign-in-terminal-host'))
    expect(agentPageShown()).toBe(false)
    expect(opened).toEqual([])
  })

  it('goes Back to the agent page as it was, and closes the login terminal', async () => {
    await signInFromAgentPage()

    fireEvent.click(within(signInView() as HTMLElement).getByRole('button', { name: 'Back' }))
    await settle()

    expect(signInView()).toBeNull()
    expect(agentPageShown()).toBe(true)
    expect(terminals.latestSignIn().closed).toBe(true)
    expect(h.dm.agentCallsOf('agentStatus')).toEqual([['claude']])
  })

  it('closes when the person goes to another screen, and does not come back with that screen', async () => {
    await signInFromAgentPage()

    fireEvent.click(sidebar().getByRole('button', { name: 'alpha ~/code/alpha' }))
    await settle()
    expect(signInView()).toBeNull()
    expect(terminals.latestSignIn().closed).toBe(true)

    fireEvent.click(sidebar().getByRole('button', { name: /Claude Code/ }))
    await settle()
    expect(signInView()).toBeNull()
    expect(agentPageShown()).toBe(true)
  })

  it('shows the agent signed in everywhere once the login ends and the status says so', async () => {
    await signInFromAgentPage()
    h.dm.agentStatuses.claude = { state: 'signed_in', reason: 'Claude Code reports it is signed in.' }

    act(() => terminals.latestSignIn().emitExit({ exitCode: 0, signal: null, message: null, resumed: false }))
    await settle()

    expect(within(signInView() as HTMLElement).getByText('Signed in to Claude Code.')).toBeTruthy()
    expect(within(sidebar().getByRole('button', { name: /Claude Code/ })).getByText('Signed in')).toBeTruthy()
  })
})
