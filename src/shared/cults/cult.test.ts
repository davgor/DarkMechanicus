import { describe, expect, it } from 'vitest'
import { memberInputSchema } from './cult'

const issuesOf = (input: Record<string, unknown>): { path: PropertyKey[]; message: string }[] => {
  const parsed = memberInputSchema.safeParse(input)
  return parsed.success ? [] : parsed.error.issues.map(({ path, message }) => ({ path, message }))
}

describe('memberInputSchema', () => {
  it('accepts a Magos with no slot and an acolyte holding one slot', () => {
    expect(issuesOf({ chatId: 'chat_magos', role: 'magos' })).toEqual([])
    expect(issuesOf({ chatId: 'chat_a', role: 'acolyte', slotId: 'ui_ux' })).toEqual([])
  })

  it('refuses a Magos holding a slot or a run worker type', () => {
    const refusal = [{ path: ['role'], message: 'The Magos holds no slot or worker type.' }]
    expect(issuesOf({ chatId: 'chat_magos', role: 'magos', slotId: 'ui_ux' })).toEqual(refusal)
    expect(issuesOf({ chatId: 'chat_magos', role: 'magos', runWorkerTypeId: 'dyn_1' })).toEqual(refusal)
  })

  it('refuses an acolyte holding both a slot and a run worker type', () => {
    expect(issuesOf({ chatId: 'chat_a', role: 'acolyte', slotId: 'ui_ux', runWorkerTypeId: 'dyn_1' })).toEqual([
      { path: ['runWorkerTypeId'], message: 'A member holds a slot or a run worker type, not both.' }
    ])
  })
})
