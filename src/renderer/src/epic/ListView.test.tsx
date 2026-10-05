// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { GraphInput } from '../graph/graphModel'
import { attempt, draftPlan, runView, savedPlan } from './__mocks__/fixtures'
import { ListView } from './ListView'
import { listSections } from './listSections'

afterEach(cleanup)

function input(patch: Partial<GraphInput> = {}): GraphInput {
  return { plan: savedPlan(), mode: 'saved', run: runView(), statuses: new Map(), outcome: null, rejected: null, draftNumber: 5, ...patch }
}

function renderList(patch: Partial<GraphInput> = {}): { opened: string[] } {
  const opened: string[] = []
  render(
    <ListView
      sections={listSections(input(patch))}
      selectedTicketId={null}
      onSelect={() => undefined}
      onOpenActivity={(ticketId, attemptId) => opened.push(`${ticketId}:${attemptId}`)}
    />
  )
  return { opened }
}

describe('ListView hourglass', () => {
  it('shows an hourglass beside the state of the ticket whose latest attempt is open, and no other', () => {
    renderList()
    const names = screen.getAllByRole('button', { name: /is being worked on/ }).map((item) => item.getAttribute('aria-label'))
    expect(names).toEqual(['DM-202 is being worked on'])
    const row = screen.getByRole('button', { name: 'DM-202' }).closest('tr')
    expect(within(row as HTMLElement).getByText('RUNNING · ATTEMPT 2').closest('td')?.querySelector('.ew-hourglass')).not.toBe(null)
  })

  it('shows one for a claimed attempt as well', () => {
    renderList({ run: runView({ attempts: [attempt('DM-204', 1, 'claimed'), attempt('DM-201', 1, 'submitted')] }) })
    expect(screen.getAllByRole('button', { name: /is being worked on/ }).map((item) => item.getAttribute('aria-label'))).toEqual([
      'DM-204 is being worked on'
    ])
  })

  it('opens the live attempt from the hourglass and does not select the row', () => {
    const selected: string[] = []
    const opened: string[] = []
    render(
      <ListView
        sections={listSections(input())}
        selectedTicketId={null}
        onSelect={(id) => selected.push(id)}
        onOpenActivity={(ticketId, attemptId) => opened.push(`${ticketId}:${attemptId}`)}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'DM-202 is being worked on' }))
    expect([opened, selected]).toEqual([['tk_202:at_202_2'], []])
  })

  it('shows none in the Draft view or once the attempt has closed', () => {
    renderList({ mode: 'draft', plan: draftPlan() })
    expect(screen.queryAllByRole('button', { name: /is being worked on/ })).toEqual([])
    cleanup()
    renderList({ run: runView({ attempts: [attempt('DM-202', 1, 'running'), attempt('DM-202', 2, 'accepted')] }) })
    expect(screen.queryAllByRole('button', { name: /is being worked on/ })).toEqual([])
  })
})
