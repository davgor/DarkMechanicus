import { describe, expect, it } from 'vitest'
import { checkDraft, chooseArchetype, moveSlot, newDraft, type FoundCultDraft } from './foundCultForm'

const ready = (patch: Partial<FoundCultDraft> = {}): FoundCultDraft => ({ ...newDraft('Magos Cawl', null), name: 'Shrine Builders', charter: 'Build it.', ...patch })

describe('moveSlot', () => {
  it('moves a slot within the roster, and returns an equal copy for a move off either end', () => {
    const slots = chooseArchetype(ready(), 'delivery').slots
    const ids = slots.map((slot) => slot.id)
    expect(moveSlot(slots, 0, 1).map((slot) => slot.id)).toEqual([ids[1], ids[0], ...ids.slice(2)])
    for (const [index, step] of [[0, -1], [slots.length - 1, 1]] as const) {
      const moved = moveSlot(slots, index, step)
      expect(moved).toEqual(slots)
      expect(moved).not.toBe(slots)
    }
  })
})

describe('checkDraft refusals', () => {
  it('asks for Unlimited when the time limit is typed as an unlimited word', () => {
    const check = checkDraft(ready({ timeLimit: 'no limit' }))
    expect(check.errors.timeLimit).toBe('Tick Unlimited for a run with no time limit.')
    expect(check.input).toBeNull()
    expect(checkDraft(ready({ timeLimit: 'no limit', unlimited: true })).input).toMatchObject({ defaultTimeLimitMs: null })
  })

  it('refuses a blank Magos name', () => {
    const check = checkDraft(ready({ magosName: '   ' }))
    expect(check.errors).toEqual({ magosName: 'Name the Magos.' })
    expect(check.input).toBeNull()
  })

  it('saves the parsed timings once nothing is refused', () => {
    expect(checkDraft(ready({ acolyteGrace: '45s', magosWindow: '10m' })).input).toMatchObject({ acolyteGraceMs: 45_000, magosWindowMs: 600_000 })
  })
})
