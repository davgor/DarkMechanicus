// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CommandName } from '../../../shared/domain/api'
import { settle } from '../__mocks__/settle'
import { installDomShims } from './__mocks__/domShims'
import { epicWorldBackend } from './__mocks__/epicScorecardBackend'
import type { FakeBackend } from './__mocks__/fakeBackend'
import { renderWorkspace } from './__mocks__/renderWorkspace'
import { allowSlowRendering } from './__mocks__/testTiming'

allowSlowRendering()

beforeAll(() => {
  installDomShims()
})

afterEach(cleanup)

async function openScorecard(key: 'epicActive' | 'epicCompleted'): Promise<FakeBackend> {
  const h = renderWorkspace(epicWorldBackend(key))
  await settle()
  fireEvent.click(await screen.findByRole('button', { name: 'Scorecard' }))
  await settle()
  return h.backend
}

const named = (backend: FakeBackend, name: CommandName): number => backend.names().filter((entry) => entry === name).length
const facts = (label: string): string => screen.getByLabelText(label).textContent ?? ''

describe('DM-181 c1: active and completed epics expose the Scorecard with the proper assessment', () => {
  it('an active epic opens its live grade from the header, focused on the Scorecard heading', async () => {
    const backend = await openScorecard('epicActive')
    expect(screen.getByRole('button', { name: 'Scorecard' }).getAttribute('aria-pressed')).toBe('true')
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Epic scorecard' }))
    expect(screen.getByText('Live assessment')).toBeTruthy()
    expect(screen.getByText(/^Live: the epic graded now from every run/)).toBeTruthy()
    expect(named(backend, 'getEpicGrade')).toBe(1)
  })

  it('a completed epic shows the immutable grade frozen with its final report and reads nothing live', async () => {
    const backend = await openScorecard('epicCompleted')
    expect(screen.getByText('Immutable assessment')).toBeTruthy()
    expect(screen.getByText(/This completed epic is read-only and this grade never changes/)).toBeTruthy()
    expect(named(backend, 'getEpicGrade')).toBe(0)
    expect(named(backend, 'getRunEfficiency')).toBe(0)
    expect(named(backend, 'getRunTiming')).toBe(0)
  })
})

describe('DM-181 c2: per-sprint drill-down and the epic outcome beyond completed tickets', () => {
  it('says the epic failed although every feature ticket was accepted, and opens a sprint to its own grade', async () => {
    await openScorecard('epicActive')
    const scope = screen.getByRole('region', { name: 'Original scope and outcomes' })
    expect(scope.textContent).toContain('so completed tickets alone do not make the epic a success')
    const sprints = screen.getByRole('region', { name: 'Sprints' })
    const toggle = within(sprints).getByRole('button', { name: /^Sprint 1/ })
    expect(toggle.textContent).toContain('frozen with report revision 1')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(within(sprints).getByRole('region', { name: 'Sprint 1 of Run #1' }).textContent).toContain('yet the sprint failed')
  })
})

describe('DM-181 c3: total resources over every run', () => {
  it('counts the cancelled run’s abandoned work and never reads a completed run as still running', async () => {
    await openScorecard('epicCompleted')
    expect(facts('Epic totals')).toContain('55,000 tokens')
    expect(facts('Wall time')).toContain('49 min')
    expect(facts('Wall time')).not.toContain('final report')
    const run2 = facts('Run #2 timing')
    expect(run2).toContain('open at its last report')
    expect(run2).not.toContain('still running')
  })
})
