// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { describeActivity, IDLE_ACTIVITY } from './agentActivity'
import type { ActivityState } from './agentActivity'
import { ActivityNote } from './ActivityNote'

afterEach(cleanup)

function renderNote(change: Partial<ActivityState>): void {
  render(<ActivityNote name="Codex" activity={describeActivity({ ...IDLE_ACTIVITY, ...change })} />)
}

describe('ActivityNote', () => {
  it('shows nothing while nothing is happening and nothing has finished', () => {
    renderNote({})
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('asks the person to use the file dialog while Find is open', () => {
    renderNote({ finding: true })
    expect(screen.getByRole('status').textContent).toBe('Choose the program in the file dialog…')
  })

  it('explains the native confirmation and shows no bar before it is answered', () => {
    renderNote({ download: { phase: 'confirming', percent: null } })
    expect(screen.getByText('Waiting for your confirmation…')).toBeTruthy()
    expect(screen.getByText(/Nothing is downloaded until you confirm/)).toBeTruthy()
    expect(screen.queryByRole('progressbar')).toBeNull()
  })

  it('names the agent on its progress bar and fills it from the percentage', () => {
    renderNote({ download: { phase: 'downloading', percent: 65 } })
    const bar = screen.getByRole('progressbar', { name: 'Codex download progress' })
    expect(bar.getAttribute('value')).toBe('65')
    expect(bar.getAttribute('max')).toBe('100')
  })

  it('leaves the bar unfilled while the percentage is unknown', () => {
    renderNote({ download: { phase: 'downloading', percent: null } })
    expect(screen.getByRole('progressbar').hasAttribute('value')).toBe(false)
  })

  it('shows a running download in place of an older result', () => {
    renderNote({
      download: { phase: 'verifying', percent: null },
      outcome: { tone: 'error', title: 'Download failed', detail: null, output: [] }
    })
    expect(screen.getByText('Verifying the download…')).toBeTruthy()
    expect(screen.queryByText('Download failed')).toBeNull()
  })

  it('shows a result with its tone, its detail and its output', () => {
    renderNote({ outcome: { tone: 'error', title: 'Download failed', detail: 'It broke.', output: ['a', 'b'] } })
    expect(screen.getByText('Download failed').className).toContain('tone-error')
    expect(screen.getByText('It broke.')).toBeTruthy()
    expect(document.querySelector('pre')?.textContent).toBe('a\nb')
  })

  it('leaves out the detail and the output box when there are none', () => {
    renderNote({ outcome: { tone: 'ok', title: 'Installed Codex', detail: null, output: [] } })
    expect(screen.getByText('Installed Codex').className).toContain('tone-ok')
    expect(document.querySelector('pre')).toBeNull()
    expect(screen.getByRole('status').querySelectorAll('p')).toHaveLength(1)
  })
})
