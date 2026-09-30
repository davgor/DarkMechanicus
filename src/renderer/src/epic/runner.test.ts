import { describe, expect, it } from 'vitest'
import { CommandError } from '../api/dm'
import { failureOf, splitLead } from './runner'

describe('failureOf', () => {
  it('keeps the code of command errors and the message of anything else', () => {
    expect(failureOf(new CommandError({ code: 'conflict', message: 'The draft changed.' }))).toEqual({
      code: 'conflict',
      message: 'The draft changed.'
    })
    expect(failureOf(new Error('boom'))).toEqual({ code: null, message: 'boom' })
    expect(failureOf('plain')).toEqual({ code: null, message: 'plain' })
  })
})

describe('splitLead', () => {
  it('separates the first sentence from the rest', () => {
    expect(
      splitLead('Dependency not added. DM-203 is in Sprint 2 and can\'t require DM-301 in Sprint 3. A prerequisite must be earlier.')
    ).toEqual({
      lead: 'Dependency not added.',
      rest: "DM-203 is in Sprint 2 and can't require DM-301 in Sprint 3. A prerequisite must be earlier."
    })
    expect(splitLead('Single sentence.')).toEqual({ lead: '', rest: 'Single sentence.' })
    expect(splitLead('A. B')).toEqual({ lead: 'A.', rest: 'B' })
  })
})
