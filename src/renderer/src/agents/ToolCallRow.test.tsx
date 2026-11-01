// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatItem } from '../../../shared/agents/chat'
import { ToolCallRow } from './ToolCallRow'

afterEach(cleanup)

type ToolCallItem = Extract<ChatItem, { kind: 'tool_call' }>

function call(fields: Partial<ToolCallItem>): ToolCallItem {
  return { id: 't', at: '2026-03-01T10:00:00.000Z', kind: 'tool_call', name: 'Bash', input: { command: 'npm test' }, status: 'completed', resultSummary: 'ok', ...fields }
}

function show(item: ToolCallItem): HTMLElement {
  render(
    <ul>
      <ToolCallRow call={item} />
    </ul>
  )
  return screen.getByRole('listitem')
}

function open(row: HTMLElement): HTMLElement {
  fireEvent.click(within(row).getByRole('button'))
  return row
}

describe('ToolCallRow: a plain call', () => {
  it('opens to its input, field by field, and its result as plain text, and folds again', () => {
    const row = show(call({ input: { command: 'npm test', timeout: 60 }, resultSummary: '<b>12 passed</b>' }))
    expect(row.querySelector('.chat-tool-summary')?.textContent).toBe('npm test')
    expect(row.querySelector('.chat-tool-body')).toBe(null)

    open(row)

    expect(within(row).getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect([...row.querySelectorAll('.chat-tool-fields dt')].map((term) => term.textContent)).toEqual(['command', 'timeout'])
    expect([...row.querySelectorAll('.chat-tool-fields dd')].map((value) => value.textContent)).toEqual(['npm test', '60'])
    expect(row.querySelector('.chat-tool-result')?.textContent).toBe('<b>12 passed</b>')
    expect(row.querySelector('b')).toBe(null)

    fireEvent.click(within(row).getByRole('button'))
    expect(row.querySelector('.chat-tool-body')).toBe(null)
  })

  it('says a running call is still waiting for its result, and a finished one that reported none has none', () => {
    const running = open(show(call({ status: 'running', resultSummary: null })))
    expect(running.querySelector('.chat-tool-result')?.textContent).toBe('Waiting for the result…')
    expect(within(running).getByText('Running')).toBeTruthy()
    cleanup()

    const silent = open(show(call({ status: 'completed', resultSummary: '' })))
    expect(silent.querySelector('.chat-tool-result')?.textContent).toBe('No result was reported.')
  })
})

describe('ToolCallRow: a Dark Mechanicus call', () => {
  it('is an action marker with the server reason it was refused, and nothing to open', () => {
    const row = show(
      call({
        name: 'mcp__darkmechanicus__claim_ticket',
        input: {},
        status: 'failed',
        resultSummary: '{"ok":false,"error":{"code":"stale_claim","message":"The claim is stale."}}'
      })
    )

    expect(row.getAttribute('aria-label')).toBe('Action: could not claim a ticket')
    expect(row.querySelector('.chat-marker-detail')?.textContent).toBe('The claim is stale.')
    expect(within(row).queryByRole('button')).toBe(null)
  })
})
