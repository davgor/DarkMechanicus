// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm, MCP_JSON } from '../__mocks__/fakeDm'
import { ManualScheduler } from '../__mocks__/manualScheduler'
import { settle } from '../__mocks__/settle'
import { ToastProvider } from '../app/toasts'
import { McpSnippet } from './McpSnippet'

let dm: FakeDm

beforeEach(() => {
  dm = new FakeDm()
  window.dm = dm
})

afterEach(cleanup)

function renderSnippet(path = '/a'): void {
  render(
    <ToastProvider scheduler={new ManualScheduler()}>
      <McpSnippet folderPath={path} heading="NEXT · CONNECT AN AGENT OVER MCP" />
    </ToastProvider>
  )
}

const copyButton = (): HTMLButtonElement => screen.getByRole('button', { name: 'Copy' }) as HTMLButtonElement

describe('McpSnippet', () => {
  it('shows the heading and waits for the config before allowing a copy', () => {
    renderSnippet()
    expect(screen.getByText('NEXT · CONNECT AN AGENT OVER MCP')).toBeTruthy()
    expect(copyButton().disabled).toBe(true)
  })

  it('shows the ready-to-paste JSON in a code block', async () => {
    renderSnippet()
    await settle()
    expect(screen.getByLabelText('MCP server configuration').textContent).toBe(MCP_JSON)
    expect(copyButton().disabled).toBe(false)
  })

  it('shows where the command comes from', async () => {
    renderSnippet()
    await settle()
    expect(screen.getByText('development build')).toBeTruthy()
  })

  it('copies the JSON and confirms', async () => {
    renderSnippet()
    await settle()
    fireEvent.click(copyButton())
    await settle()
    expect(dm.copied).toEqual([MCP_JSON])
    expect(screen.getByRole('status').textContent).toContain('MCP configuration copied.')
  })

  it('explains a load failure and cannot copy', async () => {
    dm.rejects.getMcpConfig = 'bridge missing'
    renderSnippet()
    await settle()
    expect(screen.getByText('Could not load the MCP configuration.')).toBeTruthy()
    expect(copyButton().disabled).toBe(true)
    expect(screen.getByRole('alert').textContent).toContain('bridge missing')
  })
})
