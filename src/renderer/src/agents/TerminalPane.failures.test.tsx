// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { FakeTerminalKit } from '../__mocks__/fakeTerminalKit'
import { FakeTerminals } from '../__mocks__/fakeTerminals'
import { chatRecord } from '../__mocks__/fixtures'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { TerminalPane } from './TerminalPane'

const CHAT = chatRecord({ id: 'chat_a', folder: '/a', title: 'Fix the build', agent: 'claude', role: 'worker' })

let terminals: FakeTerminals
let kit: FakeTerminalKit

beforeEach(() => {
  const dm = new FakeDm()
  terminals = new FakeTerminals()
  dm.terminals = terminals
  window.dm = dm
  kit = new FakeTerminalKit()
})

afterEach(() => {
  cleanup()
})

async function show(): Promise<void> {
  render(<TerminalPane folder="/a" chat={CHAT} agentName="Claude Code" kit={kit} scheduler={new ManualScheduler()} />)
  await settle()
}

const state = (): string | null => within(screen.getByRole('list', { name: 'Chat details' })).queryByText('Failed')?.textContent ?? null
const notice = (): string | null => screen.queryByRole('status')?.textContent ?? null

describe('TerminalPane: an attach that does not answer as it should', () => {
  it('says the terminal could not be shown when main answers running with no terminal', async () => {
    terminals.outcomes.chat_a = { state: 'running', snapshot: 'stale screen' }
    await show()

    expect(state()).toBe('Failed')
    expect(notice()).toBe('The terminal could not be shown.')
    expect(kit.views).toEqual([])
  })

  it('shows an attach that failed outright as failed, in the words of its error', async () => {
    terminals.attach = async () => {
      throw new Error('The window lost its connection to main.')
    }
    await show()

    expect(state()).toBe('Failed')
    expect(notice()).toBe('The window lost its connection to main.')
    expect(kit.views).toEqual([])
  })

  it('shows a failure that is not an error as its text', async () => {
    terminals.attach = () => Promise.reject('IPC closed')
    await show()

    expect(notice()).toBe('IPC closed')
  })
})
