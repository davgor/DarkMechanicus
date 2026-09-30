// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deferred } from '../__mocks__/deferred'
import { FakeDm, MCP_JSON } from '../__mocks__/fakeDm'
import { folderView, storageStatus } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import type { StorageStatusView } from '../../../shared/domain/views'
import { ToastProvider } from '../app/toasts'
import { McpCard } from './McpCard'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

function renderCard(status: StorageStatusView | null = null): void {
  render(
    <ToastProvider scheduler={new ManualScheduler()}>
      <McpCard folder={folderView({ path: '/a' })} status={status} />
    </ToastProvider>
  )
}

const install = (): HTMLButtonElement => screen.getByRole('button', { name: 'Install agent skills' }) as HTMLButtonElement

describe('McpCard connection', () => {
  it('shows the config snippet and the headless note', async () => {
    renderCard()
    await settle()
    expect(screen.getByRole('heading', { name: 'MCP connection' })).toBeTruthy()
    expect(screen.getByLabelText('MCP server configuration').textContent).toBe(MCP_JSON)
    expect(screen.getByText('The MCP server runs headless, so agents can plan with this window closed.')).toBeTruthy()
  })

  it('says it is waiting for an agent', async () => {
    renderCard(storageStatus())
    await settle()
    expect(screen.getByText('Waiting for an agent')).toBeTruthy()
  })

  it('counts connected agents', async () => {
    renderCard(storageStatus({ sessions: { active: 2, byRole: { desktop: 1, planner: 2 } } }))
    await settle()
    expect(screen.getByText('2 agent sessions · stdio')).toBeTruthy()
  })
})

describe('McpCard skills', () => {
  it('installs the agent skills into the folder and lists what was written', async () => {
    dm.skillsWritten = ['.claude/skills/darkmechanicus-planner/SKILL.md', '.claude/skills/darkmechanicus-worker/SKILL.md']
    renderCard()
    await settle()
    fireEvent.click(install())
    await settle()
    expect(dm.skillInstalls).toEqual(['/a'])
    expect(screen.getByRole('status').textContent).toContain('Installed 2 skill files.')
    expect(screen.getByText('.claude/skills/darkmechanicus-worker/SKILL.md')).toBeTruthy()
  })

  it('uses the singular for one file', async () => {
    renderCard()
    await settle()
    fireEvent.click(install())
    await settle()
    expect(screen.getByRole('status').textContent).toContain('Installed 1 skill file.')
  })

  it('is busy while installing', async () => {
    const gate = deferred()
    const original = dm.installSkills.bind(dm)
    dm.installSkills = async (folder) => {
      await gate.promise
      return original(folder)
    }
    renderCard()
    await settle()
    fireEvent.click(install())
    await settle()
    expect(install().disabled).toBe(true)
    gate.resolve()
    await settle()
    expect(install().disabled).toBe(false)
  })

  it('reports a failed install and can be retried', async () => {
    dm.rejects.installSkills = 'read-only folder'
    renderCard()
    await settle()
    fireEvent.click(install())
    await settle()
    expect(screen.getByRole('alert').textContent).toContain('read-only folder')
    expect(install().disabled).toBe(false)
    expect(screen.queryByText('.claude/skills/darkmechanicus-planner/SKILL.md')).toBeNull()
  })
})
