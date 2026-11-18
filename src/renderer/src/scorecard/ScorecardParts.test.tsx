// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { component, spaceGrade } from '../__mocks__/ticketScorecardFixtures'
import { ComponentBreakdown, type EvidenceOpener, Freshness, ScoreError, ScoreReadNotice } from './ScorecardParts'
import { localTime } from './scorecardFormat'

afterEach(cleanup)

const NOTHING_OPENS: EvidenceOpener = { target: () => null, open: () => undefined }

describe('a failed read and what the person can do about it', () => {
  it('offers Try again for a read that changed underneath, and none for one this session may not make', () => {
    let retried = 0
    render(<ScoreError error={{ code: 'conflict', message: 'The grade changed.', action: 'reload' }} onRetry={() => (retried += 1)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(retried).toBe(1)
    expect(screen.getByRole('alert').textContent).toBe('The grade changed. The records changed underneath; reload to read them again.Try again')
    cleanup()
    render(<ScoreError error={{ code: 'unauthorized', message: 'Not allowed.', action: 'not_permitted' }} onRetry={() => (retried += 1)} />)
    expect(screen.getByRole('alert').textContent).toBe('Not allowed. This session may not read it.')
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('says nothing is selected before a read, and shows nothing once the data is ready', () => {
    const { container } = render(<ScoreReadNotice state={{ status: 'idle' }} what="the grade" onRetry={() => undefined} />)
    expect(container.textContent).toBe('Nothing selected.')
    cleanup()
    const ready = render(<ScoreReadNotice state={{ status: 'ready', key: 'grade', data: 1, loadedAt: 0, refreshError: null }} what="the grade" onRetry={() => undefined} />)
    expect(ready.container.textContent).toBe('')
  })

  it('keeps the data read before a failed refresh and says which read it shows', () => {
    const loadedAt = Date.parse('2026-03-04T10:00:00.000Z')
    render(<Freshness loadedAt={loadedAt} cutoff="2026-03-04T09:00:00.000Z" refreshError={{ code: 'unexpected', message: 'the app was busy', action: 'retry' }} onRefresh={() => undefined} />)
    expect(screen.getByRole('alert').textContent).toBe(`The last refresh failed (the app was busy); showing the data read ${localTime(loadedAt)}.`)
    expect(within(screen.getByLabelText('Data freshness')).getByText(/refreshes on its own$/)).toBeTruthy()
  })
})

describe('a component without a score or inherited from the sprint', () => {
  it('names an unscored component by its state when the core gave no reason, and marks an inherited one', () => {
    const grade = spaceGrade({ components: [component('S', { score: null, state: 'missing', missingReason: null, inherited: true })] })
    render(<ComponentBreakdown grade={grade} opener={NOTHING_OPENS} />)
    const row = screen.getByRole('listitem', { name: 'Satisfaction' })
    expect(row.textContent).toContain('No score: missing. Carries no weight (never read as 0).')
    expect(within(row).getByText('inherited')).toBeTruthy()
  })
})
