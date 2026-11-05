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
