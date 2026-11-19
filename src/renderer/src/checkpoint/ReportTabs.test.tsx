// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { ReportTabs } from './ReportTabs'

afterEach(cleanup)

const tabNames = (): string[] => screen.getAllByRole('tab').map((tab) => tab.textContent ?? '')
const selected = (): string => screen.getAllByRole('tab').find((tab) => tab.getAttribute('aria-selected') === 'true')?.textContent ?? ''

describe('DM-182 c1: every sprint report, current or historical, exposes the same Scorecard tab', () => {
  it('opens on the report and shows only the open tab’s panel; the Scorecard is read when opened', () => {
    render(<ReportTabs label="Sprint 1 report" report={<p>Report body</p>} scorecard={<p>Scorecard body</p>} />)
    expect(tabNames()).toEqual(['Report', 'Scorecard'])
    expect(screen.getByRole('tablist', { name: 'Sprint 1 report sections' })).toBeTruthy()
    expect(screen.queryByText('Scorecard body')).toBeNull()
    fireEvent.click(screen.getByRole('tab', { name: 'Scorecard' }))
    expect(selected()).toBe('Scorecard')
    expect(screen.getByRole('tabpanel').textContent).toBe('Scorecard body')
  })

  it('adds the Improvement tab only for a report with one, and moves between tabs with the arrow keys, Home and End', () => {
    render(<ReportTabs label="Sprint 2 report" report={<p>Report body</p>} scorecard={<p>Scorecard body</p>} improvement={<p>Improvement body</p>} />)
    expect(tabNames()).toEqual(['Report', 'Scorecard', 'Improvement'])
    const strip = screen.getByRole('tablist')
    fireEvent.keyDown(strip, { key: 'ArrowRight' })
    expect(selected()).toBe('Scorecard')
    expect(document.activeElement?.textContent).toBe('Scorecard')
    fireEvent.keyDown(strip, { key: 'End' })
    expect(selected()).toBe('Improvement')
    fireEvent.keyDown(strip, { key: 'ArrowRight' })
    expect(selected()).toBe('Report')
    fireEvent.keyDown(strip, { key: 'ArrowLeft' })
    expect(selected()).toBe('Improvement')
    fireEvent.keyDown(strip, { key: 'Home' })
    expect(selected()).toBe('Report')
    fireEvent.keyDown(strip, { key: 'a' })
    expect(selected()).toBe('Report')
    expect(screen.getByRole('tab', { name: 'Report' }).getAttribute('tabindex')).toBe('0')
    expect(screen.getByRole('tab', { name: 'Scorecard' }).getAttribute('tabindex')).toBe('-1')
  })
})
