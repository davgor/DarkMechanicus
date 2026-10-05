// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView } from '../__mocks__/fixtures'
import { settle } from '../__mocks__/settle'
import type { AgentKind } from '../../../shared/desktop/api'
import { AddAgentPane } from './AddAgentPane'
import { useAgents } from './useAgents'

let dm: FakeDm
let errors: string[]

beforeEach(() => {
  errors = []
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

function Pane(): JSX.Element {
  const agents = useAgents((error) => errors.push((error as Error).message))
  return <AddAgentPane agents={agents} />
}

async function mount(): Promise<void> {
  render(<Pane />)
  await settle()
}

const card = (name: string): ReturnType<typeof within> => within(screen.getByRole('article', { name }))
const press = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }))
}

const claude = agentView({ kind: 'claude', version: '2.1.4' })

describe('AddAgentPane cards', () => {
  it('shows a titled pane with a card for Claude Code, Codex and Cursor', async () => {
    await mount()
    expect(screen.getByRole('heading', { level: 1, name: 'Add an agent' })).toBeTruthy()
    const names = screen.getAllByRole('article').map((article) => article.getAttribute('aria-label'))
    expect(names).toEqual(['Claude Code', 'Codex', 'Cursor'])
  })

  it('gives every card a one-line description and the Find and Download actions with their icons', async () => {
    await mount()
    for (const name of ['Claude Code', 'Codex', 'Cursor']) {
      const inCard = card(name)
      expect(inCard.getByText(/coding agent/)).toBeTruthy()
      const find = inCard.getByRole('button', { name: `Find ${name}` })
      const download = inCard.getByRole('button', { name: `Download ${name}` })
      expect(find.querySelector('[data-icon="search"]')).toBeTruthy()
      expect(download.querySelector('[data-icon="download"]')).toBeTruthy()
    }
  })

  it('does not say anything is connected when nothing is', async () => {
    await mount()
    expect(screen.queryByText(/Connected/)).toBeNull()
  })

  it('says a connected agent is connected and offers Update instead of Download', async () => {
    dm.agents = [claude]
    await mount()
    const inCard = card('Claude Code')
    expect(inCard.getByText('Connected · v2.1.4')).toBeTruthy()
    expect(inCard.getByRole('button', { name: 'Update Claude Code' })).toBeTruthy()
    expect(inCard.queryByRole('button', { name: 'Download Claude Code' })).toBeNull()
    expect(card('Codex').getByRole('button', { name: 'Download Codex' })).toBeTruthy()
  })
})

describe('AddAgentPane sign-in after connecting', () => {
  const signedOut = { state: 'signed_out', reason: 'Claude Code says you are not logged in.' } as const

  it('says a signed-out agent that Find just connected is signed out, and offers Sign in', async () => {
    dm.findOutcomes = [{ outcome: 'connected', agent: claude }]
    dm.agentStatuses.claude = signedOut
    await mount()
    expect(card('Claude Code').queryByRole('button', { name: 'Sign in' })).toBeNull()
    press('Find Claude Code')
    await settle()
    const inCard = card('Claude Code')
    expect(inCard.getByText('Connected Claude Code 2.1.4')).toBeTruthy()
    expect(inCard.getByText(/Signed out/).closest('.agent-card-state')?.className).toContain('tone-warn')
    fireEvent.click(inCard.getByRole('button', { name: 'Sign in' }))
    await settle()
    expect(dm.agentCallsOf('signInAgent')).toEqual([['claude']])
  })

  it('does the same after Download installs a signed-out agent', async () => {
    dm.downloadOutcomes = [{ outcome: 'installed', agent: claude, updated: false }]
    dm.agentStatuses.claude = signedOut
    await mount()
    press('Download Claude Code')
    await settle()
    const inCard = card('Claude Code')
    expect(inCard.getByText('Installed Claude Code 2.1.4')).toBeTruthy()
    expect(inCard.getByText(/Signed out/)).toBeTruthy()
    expect(inCard.getByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('offers no Sign in to an agent that is signed in, and says so', async () => {
    dm.agents = [claude]
    dm.agentStatuses.claude = { state: 'signed_in', reason: 'Signed in.' }
    await mount()
    expect(card('Claude Code').getByText('Signed in')).toBeTruthy()
    expect(card('Claude Code').queryByRole('button', { name: 'Sign in' })).toBeNull()
  })

  it('shows an unknown state with its reason and Check again, and says while it is still being asked', async () => {
    dm.agents = [claude]
    dm.agentStatuses.claude = { state: 'unknown', reason: 'The status command did not answer.' }
    const hold = dm.holdAgent('agentStatus')
    await mount()
    expect(card('Claude Code').getByText('Checking sign-in…')).toBeTruthy()
    hold.resolve()
    await settle()
    expect(card('Claude Code').getByText('The status command did not answer.')).toBeTruthy()
    expect(card('Claude Code').getByRole('button', { name: 'Check again' })).toBeTruthy()
  })

  it('shows nothing about sign-in for an agent that is not connected', async () => {
    await mount()
    expect(card('Codex').queryByText(/Signed|Checking sign-in/)).toBeNull()
  })
})

describe('AddAgentPane actions', () => {
  it.each<[AgentKind, string]>([
    ['claude', 'Claude Code'],
    ['codex', 'Codex'],
    ['cursor', 'Cursor']
  ])('calls findAgent with only the kind for %s', async (kind, name) => {
    await mount()
    press(`Find ${name}`)
    await settle()
    expect(dm.agentCallsOf('findAgent')).toEqual([[kind]])
    expect(dm.agentCallsOf('downloadAgent')).toEqual([])
  })

  it.each<[AgentKind, string]>([
    ['claude', 'Claude Code'],
    ['codex', 'Codex'],
    ['cursor', 'Cursor']
  ])('calls downloadAgent with only the kind for %s', async (kind, name) => {
    await mount()
    press(`Download ${name}`)
    await settle()
    expect(dm.agentCallsOf('downloadAgent')).toEqual([[kind]])
    expect(dm.agentCallsOf('findAgent')).toEqual([])
  })

  it('calls downloadAgent from Update on a connected agent', async () => {
    dm.agents = [claude]
    await mount()
    press('Update Claude Code')
    await settle()
    expect(dm.agentCallsOf('downloadAgent')).toEqual([['claude']])
  })

})

describe('AddAgentPane in-flight actions', () => {
  it('disables Find and Download for a kind while its file dialog is open, and only for that kind', async () => {
    const hold = dm.holdAgent('findAgent')
    await mount()
    press('Find Codex')
    await settle()
    const codex = card('Codex')
    expect((codex.getByRole('button', { name: 'Find Codex' }) as HTMLButtonElement).disabled).toBe(true)
    expect((codex.getByRole('button', { name: 'Download Codex' }) as HTMLButtonElement).disabled).toBe(true)
    expect((card('Claude Code').getByRole('button', { name: 'Find Claude Code' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(codex.getByRole('button', { name: 'Find Codex' }))
    hold.resolve()
    await settle()
    expect(dm.agentCallsOf('findAgent')).toEqual([['codex']])
    expect((screen.getByRole('button', { name: 'Find Codex' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('connects the agent a pick found and then offers Update', async () => {
    dm.findOutcomes = [{ outcome: 'connected', agent: claude }]
    await mount()
    press('Find Claude Code')
    await settle()
    const inCard = card('Claude Code')
    expect(inCard.getByText('Connected · v2.1.4')).toBeTruthy()
    expect(inCard.getByText('Connected Claude Code 2.1.4')).toBeTruthy()
    expect(inCard.getByRole('button', { name: 'Update Claude Code' })).toBeTruthy()
  })

  it('shows why a pick was refused', async () => {
    dm.findOutcomes = [{ outcome: 'refused', code: 'wrong_program', reason: 'That program is not Codex.' }]
    await mount()
    press('Find Codex')
    await settle()
    expect(card('Codex').getByText('Not connected')).toBeTruthy()
    expect(card('Codex').getByText('That program is not Codex.')).toBeTruthy()
    expect(card('Codex').queryByText(/^Connected/)).toBeNull()
  })

  it('says nothing after a closed file dialog', async () => {
    await mount()
    press('Find Codex')
    await settle()
    expect(card('Codex').queryByRole('status')).toBeNull()
  })
})

describe('AddAgentPane download', () => {
  it('shows the confirmation before any progress or result, while the call is still open', async () => {
    dm.holdAgent('downloadAgent')
    await mount()
    press('Download Claude Code')
    await settle()
    const inCard = card('Claude Code')
    expect(dm.agentCallsOf('downloadAgent')).toEqual([['claude']])
    expect(inCard.getByText('Waiting for your confirmation…')).toBeTruthy()
    expect(inCard.getByText(/source of the installer, the command that runs and where it installs/)).toBeTruthy()
    expect(inCard.queryByRole('progressbar')).toBeNull()
    expect(inCard.queryByText(/Downloading/)).toBeNull()
    expect(inCard.queryByText(/Installed|Download failed|Download cancelled/)).toBeNull()
  })

  it('then follows the progress the main process reports, then shows the success', async () => {
    const hold = dm.holdAgent('downloadAgent')
    dm.downloadOutcomes = [{ outcome: 'installed', agent: claude, updated: false }]
    await mount()
    press('Download Claude Code')
    await settle()
    const inCard = card('Claude Code')

    act(() => dm.emitProgress({ kind: 'claude', phase: 'downloading', percent: 40 }))
    expect(inCard.queryByText('Waiting for your confirmation…')).toBeNull()
    expect(inCard.getByText('Downloading the installer… 40%')).toBeTruthy()
    expect(inCard.getByRole('progressbar').getAttribute('value')).toBe('40')

    act(() => dm.emitProgress({ kind: 'claude', phase: 'installing', percent: null }))
    expect(inCard.getByText('Running the installer…')).toBeTruthy()
    expect(inCard.getByRole('progressbar').hasAttribute('value')).toBe(false)

    hold.resolve()
    await settle()
    expect(inCard.queryByRole('progressbar')).toBeNull()
    expect(inCard.getByText('Installed Claude Code 2.1.4')).toBeTruthy()
    expect(inCard.getByText('Connected · v2.1.4')).toBeTruthy()
    expect(inCard.getByRole('button', { name: 'Update Claude Code' })).toBeTruthy()
  })

})

describe('AddAgentPane download results', () => {
  it('keeps the other kinds untouched while one downloads', async () => {
    dm.holdAgent('downloadAgent')
    await mount()
    press('Download Claude Code')
    await settle()
    act(() => dm.emitProgress({ kind: 'claude', phase: 'downloading', percent: 10 }))
    expect(card('Codex').queryByRole('progressbar')).toBeNull()
    expect((card('Claude Code').getByRole('button', { name: 'Find Claude Code' }) as HTMLButtonElement).disabled).toBe(true)
    expect((card('Claude Code').getByRole('button', { name: 'Download Claude Code' }) as HTMLButtonElement).disabled).toBe(true)
    expect((card('Codex').getByRole('button', { name: 'Download Codex' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the failure reason and the installer’s last lines', async () => {
    dm.downloadOutcomes = [
      {
        outcome: 'failed',
        code: 'installer_failed',
        reason: 'The installer failed (exit code 1).',
        output: ['Fetching package', 'No space left on device']
      }
    ]
    await mount()
    press('Download Codex')
    await settle()
    const inCard = card('Codex')
    expect(inCard.getByText('Download failed')).toBeTruthy()
    expect(inCard.getByText('The installer failed (exit code 1).')).toBeTruthy()
    expect(inCard.getByText(/No space left on device/).textContent).toBe('Fetching package\nNo space left on device')
    expect((inCard.getByRole('button', { name: 'Download Codex' }) as HTMLButtonElement).disabled).toBe(false)
  })

})

describe('AddAgentPane download failures', () => {
  it('shows a failure that ran no installer without an empty output box', async () => {
    dm.downloadOutcomes = [{ outcome: 'failed', code: 'unsupported_platform', reason: 'No installer for this system.', output: [] }]
    await mount()
    press('Download Cursor')
    await settle()
    expect(card('Cursor').getByText('No installer for this system.')).toBeTruthy()
    expect(document.querySelector('pre')).toBeNull()
  })

  it('says a declined confirmation changed nothing', async () => {
    await mount()
    press('Download Cursor')
    await settle()
    expect(card('Cursor').getByText('Download cancelled')).toBeTruthy()
    expect(card('Cursor').getByText('Nothing was downloaded or changed.')).toBeTruthy()
  })

  it('reports a call that was rejected', async () => {
    dm.downloadAgent = () => Promise.reject(new Error('ipc closed'))
    await mount()
    press('Download Codex')
    await settle()
    expect(errors).toEqual(['ipc closed'])
    expect((screen.getByRole('button', { name: 'Download Codex' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
