// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentView } from '../../../shared/desktop/api'
import { FakeDm } from '../__mocks__/fakeDm'
import { agentView, folderView } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ToastProvider } from '../app/toasts'
import { DefaultAgentCard } from './DefaultAgentCard'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

const folder = folderView({ path: '/a', name: 'alpha' })
const claude = agentView({ kind: 'claude' })
const codex = agentView({ kind: 'codex', executablePath: '/bin/codex', version: '0.9.1' })

async function renderCard(agents: readonly AgentView[] = [claude, codex]): Promise<void> {
  render(
    <ToastProvider scheduler={new ManualScheduler()}>
      <DefaultAgentCard folder={folder} agents={agents} />
    </ToastProvider>
  )
  await settle()
}

const select = (): HTMLSelectElement => screen.getByRole('combobox', { name: 'Default agent' }) as HTMLSelectElement
const optionLabels = (): string[] => Array.from(select().options).map((option) => option.text)
const writes = (): unknown[] =>
  dm.agentCalls.filter((call) => call.method === 'setFolderDefaultAgent').map((call) => call.args[0])

describe('DefaultAgentCard', () => {
  it('offers None and the connected agents, showing None when no default is stored', async () => {
    await renderCard()
    expect(optionLabels()).toEqual(['None', claude.displayName, codex.displayName])
    expect(select().value).toBe('')
  })

  it('shows the stored default', async () => {
    dm.folderDefaults['/a'] = 'codex'
    await renderCard()
    expect(select().value).toBe('codex')
  })

  it('writes the default, clears it, and shows the stored value after a reload', async () => {
    await renderCard()
    fireEvent.change(select(), { target: { value: 'codex' } })
    await settle()
    expect(writes()).toEqual([{ folder: '/a', agentId: 'codex' }])
    expect(select().value).toBe('codex')

    cleanup()
    await renderCard()
    expect(select().value).toBe('codex')

    fireEvent.change(select(), { target: { value: '' } })
    await settle()
    expect(writes()).toEqual([
      { folder: '/a', agentId: 'codex' },
      { folder: '/a', agentId: null }
    ])
    expect(dm.folderDefaults['/a']).toBeUndefined()

    cleanup()
    await renderCard()
    expect(select().value).toBe('')
  })

  it('keeps the stored value when the write is refused', async () => {
    dm.folderDefaults['/a'] = 'claude'
    dm.setFolderDefaultAgent = () => Promise.reject(new Error('not_found'))
    await renderCard()
    fireEvent.change(select(), { target: { value: 'codex' } })
    await settle()
    expect(select().value).toBe('claude')
  })

  it('lists a stored default that is no longer connected, so the select does not pretend it is None', async () => {
    dm.folderDefaults['/a'] = 'codex'
    await renderCard([claude])
    expect(select().value).toBe('codex')
    expect(optionLabels()).toEqual(['None', claude.displayName, 'codex (not connected)'])
  })
})
