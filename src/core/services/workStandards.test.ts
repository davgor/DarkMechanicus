import { expect, it } from 'vitest'
import { appliedStandards, encodeStandards, readStandards, type AppliedStandard } from './workStandards'

it('stores one copy of a large approved prompt and restores every pinned decision exactly', () => {
  const prompt = 'Review deployment verification.'.padEnd(65_536, '.')
  const decisions: AppliedStandard[] = Array.from({ length: 200 }, (_, index) => ({
    id: 'ticket-' + index, kind: 'ticket', revision: 18, disposition: 'updated', reason: 'Review completed.',
    prompt, requirements: 'Use this ticket-specific verification step ' + index
  }))
  const record = encodeStandards(decisions)
  expect(record.prompts).toEqual([prompt])
  expect(JSON.stringify(record).length).toBeLessThan(150_000)
  expect(readStandards(JSON.stringify(record))).toEqual(decisions)
  expect(() => encodeStandards([{ ...decisions[0]!, prompt: prompt + '.' }])).toThrow()
  const invalid = { ...record, rules: [{ ...record.rules[0], promptIndex: 1 }] }
  expect(appliedStandards.safeParse(invalid).success).toBe(false)
})
