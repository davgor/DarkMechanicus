// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FakeDm } from '../__mocks__/fakeDm'
import { settle } from '../__mocks__/settle'
import type { RecordHumanFeedbackInput } from '../../../shared/domain/spaceSignals'
import { PlannedReviewForm, RatingForm, RescueForm, type SavedRating } from './FeedbackControls'

let dm: FakeDm
let recorded: number

beforeEach(() => {
  dm = new FakeDm()
  dm.responses.recordHumanFeedback = { observationId: 'ob_1' }
  window.dm = dm
  recorded = 0
})

afterEach(cleanup)

const TICKET = { epicId: 'ep_1', ticketId: 'tk_1', runId: 'rn_1' }
const SPRINT = { epicId: 'ep_1', sprintId: 'sp_1', runId: 'rn_1' }

function sent(): RecordHumanFeedbackInput[] {
  return dm.callsOf('recordHumanFeedback').map((call) => call.input as RecordHumanFeedbackInput)
}

function rating(scope: 'sprint' | 'ticket', saved: SavedRating | null): JSX.Element {
  return <RatingForm folderPath="/repo" subject={scope === 'sprint' ? 'Sprint 2' : 'this ticket'} scope={scope} saved={saved} target={scope === 'sprint' ? SPRINT : TICKET} onRecorded={() => (recorded += 1)} />
}

function form(name: string): HTMLElement {
  return screen.getByRole('group', { name })
}

describe('DM-183 c1: a rating recorded once per sprint or per ticket, never filled in', () => {
  it('records nothing until the person chooses and records a rating', () => {
    render(rating('ticket', null))
    const radios = within(form('Rate this ticket')).getAllByRole('radio')
    expect(radios.map((radio) => (radio as HTMLInputElement).checked)).toEqual([false, false, false, false, false])
    expect(screen.getByRole('button', { name: 'Record rating' })).toHaveProperty('disabled', true)
    expect(dm.callsOf('recordHumanFeedback')).toHaveLength(0)
  })

  it('records a ticket’s own rating with no share choice', async () => {
    render(rating('ticket', null))
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('radio', { name: '4 · Satisfied' }))
    fireEvent.click(screen.getByRole('button', { name: 'Record rating' }))
    await settle()
    expect(sent()).toEqual([{ target: TICKET, feedback: { kind: 'rating', value: 4 }, idempotencyKey: sent()[0].idempotencyKey }])
    expect(screen.getByRole('status').textContent).toBe('Rating 4 of 5 recorded.')
    expect(recorded).toBe(1)
    expect(screen.getByRole('button', { name: 'Record rating' })).toHaveProperty('disabled', true)
  })

  it('a sprint rating carries the explicit choice to share it with the tickets', async () => {
    render(rating('sprint', null))
    const share = screen.getByRole('checkbox', { name: /Share with this sprint's tickets/ })
    expect(share).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('radio', { name: '2 · Somewhat unsatisfied' }))
    expect(share).toHaveProperty('disabled', false)
    expect(share).toHaveProperty('checked', false)
    fireEvent.click(share)
    fireEvent.click(screen.getByRole('button', { name: 'Record rating' }))
    await settle()
    expect(sent().map((input) => input.feedback)).toEqual([{ kind: 'rating', value: 2, sharedWithTickets: true }])
    expect(sent()[0].target).toEqual(SPRINT)
  })

  it('an unshared sprint rating is sent as not shared, never left out', async () => {
    render(rating('sprint', null))
    fireEvent.click(screen.getByRole('radio', { name: '5 · Very satisfied' }))
    fireEvent.click(screen.getByRole('button', { name: 'Record rating' }))
    await settle()
    expect(sent().map((input) => input.feedback)).toEqual([{ kind: 'rating', value: 5, sharedWithTickets: false }])
  })
})

describe('DM-183 c1: a rating kept through failures and ratings recorded meanwhile', () => {
  it('a failed record keeps the choice and its retry reuses the same key', async () => {
    dm.failures.recordHumanFeedback = { code: 'busy', message: 'Store busy.' }
    render(rating('ticket', null))
    fireEvent.click(screen.getByRole('radio', { name: '3 · Neutral' }))
    fireEvent.click(screen.getByRole('button', { name: 'Record rating' }))
    await settle()
    expect(screen.getByRole('alert').textContent).toBe('Not recorded: Store busy. Your entry is kept; try again.')
    expect(screen.getByRole('radio', { name: '3 · Neutral' })).toHaveProperty('checked', true)
    delete dm.failures.recordHumanFeedback
    fireEvent.click(screen.getByRole('button', { name: 'Record rating' }))
    await settle()
    const keys = sent().map((input) => input.idempotencyKey)
    expect(keys).toHaveLength(2)
    expect(keys[1]).toBe(keys[0])
    expect(recorded).toBe(1)
  })

  it('a rating recorded meanwhile is shown while the person’s choice is kept', () => {
    const view = render(rating('ticket', { value: 2, sharedWithTickets: null }))
    fireEvent.click(screen.getByRole('radio', { name: '4 · Satisfied' }))
    view.rerender(rating('ticket', { value: 3, sharedWithTickets: null }))
    expect(screen.getByRole('alert').textContent).toBe('Another rating was recorded meanwhile (3 of 5). Your choice is kept: record it to replace that one, or discard it.')
    expect(screen.getByRole('radio', { name: '4 · Satisfied' })).toHaveProperty('checked', true)
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(screen.getByRole('radio', { name: '3 · Neutral' })).toHaveProperty('checked', true)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

function rescue(count: number): JSX.Element {
  return <RescueForm folderPath="/repo" target={TICKET} recorded={count} onRecorded={() => (recorded += 1)} />
}

function review(count: number): JSX.Element {
  return <PlannedReviewForm folderPath="/repo" target={TICKET} recorded={count} onRecorded={() => (recorded += 1)} />
}

function minutesInput(name: string): HTMLInputElement {
  return within(form(name)).getByRole('textbox', { name: 'Actual minutes (optional)' }) as HTMLInputElement
}

describe('DM-183 c2: rescue needs a reason and takes optional minutes', () => {
  it('cannot be recorded without a reason', () => {
    render(rescue(0))
    expect(screen.getByRole('button', { name: 'Record rescue' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Choose a reason to record a rescue.')).toBeTruthy()
  })

  it('records how, why and the minutes, then clears the entry', async () => {
    render(rescue(0))
    fireEvent.change(screen.getByRole('combobox', { name: 'How' }), { target: { value: 'override' } })
    fireEvent.change(screen.getByRole('combobox', { name: 'Reason' }), { target: { value: 'tooling' } })
    fireEvent.change(minutesInput('Record a rescue'), { target: { value: '15' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record rescue' }))
    await settle()
    expect(sent().map((input) => [input.target, input.feedback])).toEqual([[TICKET, { kind: 'rescue', intervention: 'override', cause: 'tooling', minutes: 15 }]])
    expect(screen.getByRole('status').textContent).toBe('Rescue of 15 min recorded.')
    expect(minutesInput('Record a rescue').value).toBe('')
    expect((screen.getByRole('combobox', { name: 'Reason' }) as HTMLSelectElement).value).toBe('')
  })

  it('blank minutes are left out, never sent as 0', async () => {
    render(rescue(0))
    fireEvent.change(screen.getByRole('combobox', { name: 'Reason' }), { target: { value: 'context' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record rescue' }))
    await settle()
    expect(sent().map((input) => input.feedback)).toEqual([{ kind: 'rescue', intervention: 'rescue', cause: 'context' }])
    expect(screen.getByRole('status').textContent).toBe('Rescue recorded without minutes.')
  })

  it.each(['0.5', '1e', '-'])('minutes %j below the floor or not plain digits are refused', (text) => {
    render(rescue(0))
    fireEvent.change(screen.getByRole('combobox', { name: 'Reason' }), { target: { value: 'context' } })
    fireEvent.change(minutesInput('Record a rescue'), { target: { value: text } })
    expect(screen.getByText('Minutes are a number from 1 to 2,400 (a working week). Leave them blank when you do not know.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Record rescue' })).toHaveProperty('disabled', true)
  })

  it('announces rescue entries recorded meanwhile and keeps the typed entry', () => {
    const view = render(rescue(1))
    fireEvent.change(minutesInput('Record a rescue'), { target: { value: '20' } })
    expect(screen.queryByRole('alert')).toBeNull()
    view.rerender(rescue(2))
    expect(screen.getByRole('alert').textContent).toBe('Another rescue entry was recorded meanwhile (listed above). Your entry is kept below: record it as well, or clear it.')
    view.rerender(rescue(4))
    expect(screen.getByRole('alert').textContent).toBe('3 other rescue entries were recorded meanwhile (listed above). Your entry is kept below: record it as well, or clear it.')
    expect(minutesInput('Record a rescue').value).toBe('20')
  })

  it('an untouched form takes in new entries silently', () => {
    const view = render(rescue(1))
    view.rerender(rescue(3))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('DM-183 c2: planned review or playtesting is a separate input, never a rescue', () => {
  it('asks no rescue reason and records its activity and minutes', async () => {
    render(review(0))
    const group = form('Record planned review or playtesting')
    const options = within(within(group).getByRole('combobox', { name: 'Reason' })).getAllByRole('option')
    expect(options.map((option) => option.textContent)).toEqual(['Planned review', 'Playtesting'])
    fireEvent.change(within(group).getByRole('combobox', { name: 'Reason' }), { target: { value: 'playtest' } })
    fireEvent.change(minutesInput('Record planned review or playtesting'), { target: { value: '30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Record playtesting' }))
    await settle()
    expect(sent().map((input) => input.feedback)).toEqual([{ kind: 'planned_review', activity: 'playtest', minutes: 30 }])
    expect(screen.getByRole('status').textContent).toBe('Playtesting of 30 min recorded.')
    expect(minutesInput('Record planned review or playtesting').value).toBe('')
  })

  it('records without minutes when none are given', async () => {
    render(review(0))
    fireEvent.click(screen.getByRole('button', { name: 'Record planned review' }))
    await settle()
    expect(sent().map((input) => input.feedback)).toEqual([{ kind: 'planned_review', activity: 'review' }])
    expect(screen.getByRole('status').textContent).toBe('Planned review recorded without minutes.')
  })

  it('refuses minutes below the floor', () => {
    render(review(0))
    fireEvent.change(minutesInput('Record planned review or playtesting'), { target: { value: '0' } })
    expect(screen.getByRole('button', { name: 'Record planned review' })).toHaveProperty('disabled', true)
  })

  it('announces entries recorded meanwhile and keeps the typed entry', () => {
    const view = render(review(0))
    fireEvent.change(minutesInput('Record planned review or playtesting'), { target: { value: '45' } })
    view.rerender(review(1))
    expect(screen.getByRole('alert').textContent).toBe('Another planned review entry was recorded meanwhile (listed above). Your entry is kept below: record it as well, or clear it.')
    expect(minutesInput('Record planned review or playtesting').value).toBe('45')
  })
})

describe('ratings and reasons changed underneath an open choice', () => {
  it('flags a sprint rating whose share choice alone changed underneath, keeping the person\'s choice', () => {
    const view = render(rating('sprint', { value: 3, sharedWithTickets: false }))
    fireEvent.click(screen.getByRole('radio', { name: '4 · Satisfied' }))
    view.rerender(rating('sprint', { value: 3, sharedWithTickets: true }))
    expect(screen.getByRole('alert').textContent).toBe('Another rating was recorded meanwhile (3 of 5). Your choice is kept: record it to replace that one, or discard it.')
    expect(screen.getByRole('radio', { name: '4 · Satisfied' })).toHaveProperty('checked', true)
  })

  it('says no rating stands now when the recorded one is gone underneath', () => {
    const view = render(rating('ticket', { value: 2, sharedWithTickets: null }))
    fireEvent.click(screen.getByRole('radio', { name: '5 · Very satisfied' }))
    view.rerender(rating('ticket', null))
    expect(screen.getByRole('alert').textContent).toBe('Another rating was recorded meanwhile (none now). Your choice is kept: record it to replace that one, or discard it.')
  })

  it('choosing "Choose a reason…" again takes the rescue reason back, so it cannot be recorded', () => {
    render(rescue(0))
    const reason = screen.getByRole('combobox', { name: 'Reason' }) as HTMLSelectElement
    fireEvent.change(reason, { target: { value: 'tooling' } })
    expect(screen.getByRole('button', { name: 'Record rescue' })).toHaveProperty('disabled', false)
    fireEvent.change(reason, { target: { value: '' } })
    expect(reason.value).toBe('')
    expect(screen.getByRole('button', { name: 'Record rescue' })).toHaveProperty('disabled', true)
    expect(screen.getByText('Choose a reason to record a rescue.')).toBeTruthy()
  })
})
