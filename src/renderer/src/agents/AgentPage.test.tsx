// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView, localNoonIso } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import type { AgentView } from '../../../shared/desktop/api'
import { AgentPage } from './AgentPage'
import { SIGN_IN_POLL_MS } from './SignInPrompt'
import { useAgents } from './useAgents'

let dm: FakeDm
let errors: string[]

beforeEach(() => {
  errors = []
  dm = new FakeDm()
  window.dm = dm
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function Page({ agent }: { agent: AgentView }): JSX.Element {
  const agents = useAgents((error) => errors.push((error as Error).message))
  return <AgentPage agent={agent} agents={agents} />
}

const claude = agentView({
  kind: 'claude',
  executablePath: 'C:\\Users\\dev\\.local\\bin\\claude.exe',
  version: '2.1.4',
  connectedVia: 'found',
  connectedAt: localNoonIso(2026, 2, 3)
})

async function mount(agent: AgentView = claude): Promise<void> {
  dm.agents = [agent]
  render(<Page agent={agent} />)
  await settle()
}

const press = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }))
}
const isDisabled = (name: string): boolean => (screen.getByRole('button', { name }) as HTMLButtonElement).disabled

describe('AgentPage details', () => {
  it('names the agent and shows its executable path and version', async () => {
    await mount()
    expect(screen.getByRole('heading', { level: 1, name: 'Claude Code' })).toBeTruthy()
    expect(screen.getByText('C:\\Users\\dev\\.local\\bin\\claude.exe')).toBeTruthy()
    const version = screen.getByText('Version').nextElementSibling
    expect(version?.textContent).toBe('2.1.4')
  })

  it('says how it was connected', async () => {
    await mount()
    expect(screen.getByText('Connected').nextElementSibling?.textContent).toBe('Found on this computer · Feb 3, 2026')
    cleanup()
    await mount(agentView({ kind: 'claude', connectedVia: 'downloaded', connectedAt: localNoonIso(2026, 3, 9) }))
    expect(screen.getByText('Connected').nextElementSibling?.textContent).toBe(
      'Downloaded by Dark Mechanicus · Mar 9, 2026'
    )
  })

  it('shows a version that could not be read as unknown', async () => {
    await mount(agentView({ kind: 'claude', version: null }))
    expect(screen.getByText('Version').nextElementSibling?.textContent).toBe('Unknown')
  })

  it('shows the sign-in state in words with the reason the CLI gave', async () => {
    dm.agentStatuses.claude = { state: 'signed_out', reason: 'Claude Code says you are not logged in.' }
    await mount()
    const row = screen.getByText('Sign-in').parentElement as HTMLElement
    expect(within(row).getByText('Signed out')).toBeTruthy()
    expect(within(row).getByText('Claude Code says you are not logged in.')).toBeTruthy()
  })

  it('says the sign-in state is being checked until it arrives', async () => {
    dm.holdAgent('agentStatus')
    await mount()
    expect(screen.getByText('Checking sign-in…')).toBeTruthy()
  })

  it('offers Sign in, Find again, Update and Remove', async () => {
    await mount()
    for (const name of ['Sign in', 'Find again', 'Update', 'Remove']) {
      expect(screen.getByRole('button', { name })).toBeTruthy()
    }
  })
})

describe('AgentPage sign-in', () => {
  it('shows a signed-out agent as a warning, with Sign in as the main action', async () => {
    dm.agentStatuses.claude = { state: 'signed_out', reason: 'Claude Code says you are not logged in.' }
    await mount()
    const row = screen.getByText('Sign-in').parentElement as HTMLElement
    expect(within(row).getByText('Signed out').closest('.agent-state')?.className).toContain('tone-warn')
    expect(within(row).getByRole('button', { name: 'Sign in' }).className).toContain('btn-primary')
  })

  it('shows an unknown state with its reason and a Check again that asks once more', async () => {
    dm.agentStatuses.claude = { state: 'unknown', reason: 'The status command did not answer.' }
    await mount()
    expect(screen.getByText('The status command did not answer.')).toBeTruthy()
    dm.agentStatuses.claude = { state: 'signed_in', reason: 'Signed in.' }
    press('Check again')
    await settle()
    expect(dm.agentCallsOf('agentStatus')).toEqual([['claude'], ['claude']])
    expect(screen.getByText('Signed in', { selector: '.agent-state' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull()
  })

  it('watches the status after Sign in and shows signed in once the CLI says so', async () => {
    dm.agentStatuses.claude = { state: 'signed_out', reason: 'Not signed in.' }
    await mount()
    vi.useFakeTimers()
    press('Sign in')
    await settle()
    dm.agentStatuses.claude = { state: 'signed_in', reason: 'Signed in.' }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SIGN_IN_POLL_MS)
    })
    expect(screen.getByText('Signed in', { selector: '.agent-state' })).toBeTruthy()
    expect(screen.queryByText('Sign-in started')).toBeNull()
  })
})

describe('AgentPage actions', () => {
  it('starts the CLI’s own sign-in naming only the kind, and says where to finish it', async () => {
    await mount()
    press('Sign in')
    await settle()
    expect(dm.agentCallsOf('signInAgent')).toEqual([['claude']])
    expect(screen.getByText('Sign-in started')).toBeTruthy()
    expect(screen.getByText(/terminal window/)).toBeTruthy()
  })

  it('shows why a sign-in could not start', async () => {
    dm.signInOutcomes = [{ outcome: 'failed', reason: 'No terminal could be opened.' }]
    await mount()
    press('Sign in')
    await settle()
    expect(screen.getByText('Could not start sign-in')).toBeTruthy()
    expect(screen.getByText('No terminal could be opened.')).toBeTruthy()
  })

  it('finds again with only the kind', async () => {
    await mount()
    press('Find again')
    await settle()
    expect(dm.agentCallsOf('findAgent')).toEqual([['claude']])
  })

  it('updates with only the kind, showing the confirmation then the result', async () => {
    const hold = dm.holdAgent('downloadAgent')
    dm.downloadOutcomes = [{ outcome: 'installed', agent: agentView({ kind: 'claude', version: '2.2.0' }), updated: true }]
    await mount()
    press('Update')
    await settle()
    expect(dm.agentCallsOf('downloadAgent')).toEqual([['claude']])
    expect(screen.getByText('Waiting for your confirmation…')).toBeTruthy()
    act(() => dm.emitProgress({ kind: 'claude', phase: 'downloading', percent: 70 }))
    expect(screen.getByText('Downloading the installer… 70%')).toBeTruthy()
    hold.resolve()
    await settle()
    expect(screen.getByText('Updated Claude Code 2.2.0')).toBeTruthy()
  })

})

describe('AgentPage busy actions', () => {
  it('disables the actions that would collide while a download runs', async () => {
    dm.holdAgent('downloadAgent')
    await mount()
    press('Update')
    await settle()
    expect(isDisabled('Find again')).toBe(true)
    expect(isDisabled('Update')).toBe(true)
    expect(isDisabled('Remove')).toBe(true)
    expect(isDisabled('Sign in')).toBe(true)
  })

  it('disables Find again and Update while the file dialog is open', async () => {
    dm.holdAgent('findAgent')
    await mount()
    press('Find again')
    await settle()
    expect(isDisabled('Find again')).toBe(true)
    expect(isDisabled('Update')).toBe(true)
  })

  it('reports a rejected call and frees the buttons', async () => {
    dm.findAgent = () => Promise.reject(new Error('ipc closed'))
    await mount()
    press('Find again')
    await settle()
    expect(errors).toEqual(['ipc closed'])
    expect(isDisabled('Find again')).toBe(false)
  })
})

describe('AgentPage remove', () => {
  it('asks first, and says the CLI stays installed', async () => {
    await mount()
    press('Remove')
    const dialog = screen.getByRole('dialog', { name: 'Remove Claude Code?' })
    expect(within(dialog).getByText(/stays installed/)).toBeTruthy()
    expect(within(dialog).getByText(/only removes it from Dark Mechanicus/)).toBeTruthy()
    expect(dm.agentCallsOf('removeAgent')).toEqual([])
  })

  it('keeps the agent when the question is cancelled', async () => {
    await mount()
    press('Remove')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(dm.agentCallsOf('removeAgent')).toEqual([])
  })

  it('removes the connection, naming only the kind, once confirmed', async () => {
    await mount()
    press('Remove')
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' }))
    await settle()
    expect(dm.agentCallsOf('removeAgent')).toEqual([['claude']])
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
