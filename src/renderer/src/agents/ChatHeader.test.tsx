// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { chatRecord } from '../__mocks__/fixtures'
import { ChatHeader } from './ChatHeader'

afterEach(() => cleanup())

const chat = chatRecord({ id: 'c', title: 'Fix the build', agent: 'claude' })
const header = (terminalTitle?: string): JSX.Element => <ChatHeader chat={chat} agentName="Claude Code" fact="Running" terminalTitle={terminalTitle} />

describe('ChatHeader terminal title', () => {
  it('renders the terminal title beside the chat title, not instead of it', () => {
    render(header('Skitarii · work'))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Fix the build')
    const line = screen.getByTestId('chat-terminal-title')
    expect(line.textContent).toBe('Skitarii · work')
    expect(line.closest('header')).toBe(screen.getByRole('banner'))
    expect(screen.getByRole('heading', { level: 1 }).contains(line)).toBe(false)
  })

  it.each([undefined, ''])('renders no title line for %j', (title) => {
    render(header(title))
    expect(screen.queryByTestId('chat-terminal-title')).toBeNull()
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Fix the build')
  })
})

describe('ChatHeader GUI switch', () => {
  const target = { folder: '/home/u/code/alpha', agentKind: 'claude' as const }
  const forgeSetup = { intentId: '00000000-0000-4000-8000-000000000001', mode: 'onboarding' as const, stepId: '00000000-0000-4000-8000-000000000002' }
  const gui = (): HTMLElement | null => screen.queryByRole('button', { name: 'GUI' })

  it.each([
    ['Forge setup', chatRecord({ id: 'f', title: 'Set up', forgeSetup })],
    ['tooling repair', chatRecord({ id: 'r', title: 'Repair', repairIncidentId: 'ti_1' })],
    ['Forge World merge resolver', chatRecord({ id: 'm', title: 'Resolve Forge World merge', forgeResolver: '/home/u/code/world' })]
  ])('renders no GUI switch for a %s chat', (_kind, terminalOnly) => {
    render(<ChatHeader chat={terminalOnly} agentName="Claude Code" fact="Running" surfaceTarget={target} />)
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy()
    expect(gui()).toBeNull()
  })

  it('keeps the GUI switch for a chat that can switch', () => {
    render(<ChatHeader chat={chat} agentName="Claude Code" fact="Running" surfaceTarget={target} />)
    expect(gui()).not.toBeNull()
  })
})
