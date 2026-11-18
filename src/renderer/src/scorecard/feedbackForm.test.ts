import { describe, expect, it } from 'vitest'
import type { SatisfactionSignal } from '../../../shared/domain/spaceSignals'
import type { SpaceGrade } from '../../../shared/domain/space'
import { minutesText, parseMinutes, RATING_VALUES, satisfactionLabel, sprintSatisfactionText, ticketSatisfactionText } from './feedbackForm'

function signal(ticket: number | null, sprint: { value: number; shared: boolean } | null): SatisfactionSignal {
  return {
    input: {
      ticketRating: ticket === null ? null : { observationId: 'ob_t', source: 'human', value: ticket },
      sprintRating: sprint === null ? null : { observationId: 'ob_s', source: 'human', value: sprint.value, sharedWithTickets: sprint.shared }
    },
    sprintRatingUse: 'none',
    ratings: [],
    rescue: [],
    rescueMinutes: 0,
    plannedReview: [],
    plannedReviewMinutes: 0,
    entriesWithoutMinutes: 0
  }
}

function gradeWithS(S: { score: number | null; inherited: boolean } | null): Pick<SpaceGrade, 'components'> {
  const components = S === null ? [{ component: 'A', score: 80, inherited: false }] : [{ component: 'S', ...S }]
  return { components } as unknown as Pick<SpaceGrade, 'components'>
}

describe('DM-183 c1: ticket view labels inheritance and missing feedback', () => {
  it('own rating overrides only a shared sprint rating', () => {
    expect(ticketSatisfactionText(signal(4, { value: 2, shared: true }))).toBe("Own rating: 4 of 5. It overrides the sprint's shared rating (2 of 5) for this ticket.")
  })

  it('own rating beside an unshared sprint rating claims no override', () => {
    expect(ticketSatisfactionText(signal(4, { value: 2, shared: false }))).toBe('Own rating: 4 of 5.')
    expect(ticketSatisfactionText(signal(1, null))).toBe('Own rating: 1 of 5.')
  })

  it('no own rating inherits a shared sprint rating, marked inherited', () => {
    expect(ticketSatisfactionText(signal(null, { value: 5, shared: true }))).toBe(
      "No rating of its own: S inherits the sprint's rating, 5 of 5, which was shared with the sprint's tickets (marked inherited)."
    )
  })

  it('an unshared sprint rating is not inherited', () => {
    expect(ticketSatisfactionText(signal(null, { value: 3, shared: false }))).toBe(
      'No rating of its own. The sprint was rated 3 of 5 but not shared with its tickets, so S is left out here.'
    )
  })

  it('no rating anywhere is said to be missing, never assumed', () => {
    expect(ticketSatisfactionText(signal(null, null))).toBe('No rating recorded for this ticket or its sprint: S is left out of the grade and nothing is assumed.')
  })
})

describe('DM-183 c1: sprint view says whether its one rating is shared', () => {
  it('missing, shared and unshared sprint ratings', () => {
    expect(sprintSatisfactionText(signal(null, null))).toBe('No rating recorded for this sprint: S is left out of the grade and nothing is assumed.')
    expect(sprintSatisfactionText(signal(null, { value: 4, shared: true }))).toBe(
      "Rated 4 of 5, shared with the sprint's tickets: a ticket without its own rating inherits it, marked inherited."
    )
    expect(sprintSatisfactionText(signal(null, { value: 2, shared: false }))).toBe(
      "Rated 2 of 5, not shared: the sprint's tickets have no rating unless one is given to them one by one."
    )
  })
})

describe('DM-183 c1: a grade’s S label is own, inherited or none', () => {
  it('labels each case from the grade itself', () => {
    expect(satisfactionLabel(gradeWithS({ score: 75, inherited: false }))).toBe('S: own rating')
    expect(satisfactionLabel(gradeWithS({ score: 75, inherited: true }))).toBe('S: inherited sprint rating')
    expect(satisfactionLabel(gradeWithS({ score: null, inherited: false }))).toBe('S: no rating')
    expect(satisfactionLabel(gradeWithS(null))).toBe('S: no rating')
  })

  it('offers the ratings 1 to 5 only', () => {
    expect(RATING_VALUES).toEqual([1, 2, 3, 4, 5])
  })
})

describe('DM-183 c2: optional actual minutes with a floor of 1', () => {
  const refused = 'Minutes are a number from 1 to 2,400 (a working week). Leave them blank when you do not know.'

  it('blank leaves the minutes out, never 0', () => {
    expect(parseMinutes('   ')).toEqual({ ok: true, minutes: undefined })
    expect(minutesText(null)).toBe('minutes not given')
  })

  it('accepts the bounds 1 and 2400 and decimals', () => {
    expect(parseMinutes('1')).toEqual({ ok: true, minutes: 1 })
    expect(parseMinutes(' 2400 ')).toEqual({ ok: true, minutes: 2400 })
    expect(parseMinutes('12.5')).toEqual({ ok: true, minutes: 12.5 })
  })

  it.each(['0.99', '0', '2400.01', '1e', '-', '1e-9', '1e2', '-5', 'ten'])('refuses %j, never read as blank', (text) => {
    expect(parseMinutes(text)).toEqual({ ok: false, message: refused })
  })

  it('shows given minutes in minutes', () => {
    expect(minutesText(1250)).toBe('1,250 min')
    expect(minutesText(0)).toBe('0 min')
  })
})
