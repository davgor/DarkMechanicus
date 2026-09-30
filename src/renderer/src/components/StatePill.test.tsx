// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { PillState } from './StatePill'
import { StatePill, pillLabel } from './StatePill'

afterEach(cleanup)

const LABELS: [PillState, string][] = [
  ['accepted', 'Accepted'],
  ['submitted', 'In review'],
  ['running', 'Running'],
  ['ready', 'Ready'],
  ['waiting', 'Waiting'],
  ['blocked', 'Blocked'],
  ['failed', 'Failed'],
  ['needs_reconciliation', 'Needs reconciliation'],
  ['later_sprint', 'Later sprint'],
  ['backlog', 'Backlog'],
  ['in_progress', 'In progress'],
  ['completed', 'Completed'],
  ['queued', 'Queued'],
  ['awaiting_checkpoint', 'Awaiting checkpoint'],
  ['paused', 'Paused'],
  ['canceled', 'Canceled']
]

describe('pillLabel', () => {
  it.each(LABELS)('labels %s as "%s"', (state, label) => {
    expect(pillLabel(state)).toBe(label)
  })
})

describe('StatePill', () => {
  it('pairs the state color class with a text label', () => {
    render(<StatePill state="submitted" />)
    const pill = screen.getByText('In review').closest('.pill')
    expect(pill?.className).toBe('pill pill-submitted')
    expect(pill?.getAttribute('data-state')).toBe('submitted')
  })

  it('draws a decorative dot', () => {
    render(<StatePill state="running" />)
    const dot = document.querySelector('.pill-dot')
    expect(dot?.getAttribute('aria-hidden')).toBe('true')
  })

  it('accepts a custom label', () => {
    render(<StatePill state="running" label="Run #2" />)
    expect(screen.getByText('Run #2')).toBeTruthy()
    expect(screen.queryByText('Running')).toBeNull()
  })
})
