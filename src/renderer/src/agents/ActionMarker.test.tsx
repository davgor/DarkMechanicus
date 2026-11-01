// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { MarkerModel } from './actionMarkers'
import { ActionMarker } from './ActionMarker'

afterEach(cleanup)

function marker(status: MarkerModel['status'], ticketKey: string | null = 'DM-12'): MarkerModel {
  return { tool: 'claim_ticket', status, target: { epicId: null, runId: null, ticketId: null, attemptId: null, ticketKey } }
}

function show(model: MarkerModel, detail: string | null = null): HTMLElement {
  render(
    <ul>
      <ActionMarker marker={model} detail={detail} />
    </ul>
  )
  return screen.getByRole('listitem')
}

function iconOf(row: HTMLElement): string | null {
  return row.querySelector('.chat-marker-icon [data-icon]')?.getAttribute('data-icon') ?? null
}

describe('ActionMarker', () => {
  it('shows a completed call as what was done, with a check, and the ticket it named', () => {
    const row = show(marker('completed'))

    expect(row.getAttribute('aria-label')).toBe('Action: claimed DM-12')
    expect(row.getAttribute('data-tool')).toBe('claim_ticket')
    expect(row.className).toBe('chat-marker chat-marker-completed')
    expect(iconOf(row)).toBe('check')
    expect(row.querySelector('.chat-hourglass')).toBe(null)
    expect(row.querySelector('.chat-marker-detail')).toBe(null)
  })

  it('shows a running call as under way, with the hourglass', () => {
    const row = show(marker('running'))

    expect(row.querySelector('.chat-marker-text')?.textContent).toBe('claiming DM-12')
    expect(row.querySelector('.chat-hourglass')).not.toBe(null)
    expect(iconOf(row)).toBe('hourglass')
  })

  it('shows a refused call with a cross, the server reason after it, and "a ticket" when it named none', () => {
    const row = show(marker('failed', null), 'stale claim')

    expect(row.querySelector('.chat-marker-text')?.textContent).toBe('could not claim a ticket')
    expect(iconOf(row)).toBe('close')
    expect(row.querySelector('.chat-marker-detail')?.textContent).toBe('stale claim')
  })
})
