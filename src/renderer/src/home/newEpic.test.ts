import { describe, expect, it } from 'vitest'
import { MAX_CRITERIA, MAX_CRITERION, MAX_TITLE, buildNewEpic, parseCriteria } from './newEpic'

const draft = (patch: Partial<Parameters<typeof buildNewEpic>[0]> = {}) => ({
  title: 'Ship it',
  intent: '',
  criteria: '',
  ...patch
})

describe('parseCriteria', () => {
  it('splits on lines and trims each one', () => {
    expect(parseCriteria('  first  \nsecond\r\nthird')).toEqual(['first', 'second', 'third'])
  })

  it('drops blank lines', () => {
    expect(parseCriteria('a\n\n   \nb\n')).toEqual(['a', 'b'])
  })

  it('strips list markers people paste in', () => {
    expect(parseCriteria('- one\n* two\n• three\n4. four\n5) five')).toEqual([
      'one',
      'two',
      'three',
      'four',
      'five'
    ])
  })

  it('keeps numbers that are part of the sentence', () => {
    expect(parseCriteria('2024 targets are met\n-not a bullet')).toEqual([
      '2024 targets are met',
      '-not a bullet'
    ])
  })

  it('returns nothing for empty text', () => {
    expect(parseCriteria('')).toEqual([])
  })
})

describe('buildNewEpic', () => {
  it('requires a title', () => {
    expect(buildNewEpic(draft({ title: '   ' }))).toEqual({ ok: false, message: 'Give the epic a title.' })
  })

  it('builds a minimal input from the title alone', () => {
    expect(buildNewEpic(draft({ title: '  Ship it  ' }))).toEqual({ ok: true, input: { title: 'Ship it' } })
  })

  it('includes trimmed intent and criteria when given', () => {
    const result = buildNewEpic(draft({ intent: '  Why  ', criteria: '- a\n- b' }))
    expect(result).toEqual({
      ok: true,
      input: { title: 'Ship it', intent: 'Why', successCriteria: ['a', 'b'] }
    })
  })
})

describe('buildNewEpic limits', () => {
  it('accepts a title at the limit and rejects one over it', () => {
    expect(buildNewEpic(draft({ title: 'x'.repeat(MAX_TITLE) })).ok).toBe(true)
    const over = buildNewEpic(draft({ title: 'x'.repeat(MAX_TITLE + 1) }))
    expect(over).toEqual({ ok: false, message: `Titles are limited to ${MAX_TITLE} characters.` })
  })

  it('accepts the maximum number of criteria and rejects one more', () => {
    const lines = (count: number): string => Array.from({ length: count }, (_, i) => `c${i}`).join('\n')
    expect(buildNewEpic(draft({ criteria: lines(MAX_CRITERIA) })).ok).toBe(true)
    const over = buildNewEpic(draft({ criteria: lines(MAX_CRITERIA + 1) }))
    expect(over).toEqual({ ok: false, message: `Use at most ${MAX_CRITERIA} success criteria.` })
  })

  it('accepts a criterion at the limit and rejects a longer one', () => {
    expect(buildNewEpic(draft({ criteria: 'y'.repeat(MAX_CRITERION) })).ok).toBe(true)
    const over = buildNewEpic(draft({ criteria: 'y'.repeat(MAX_CRITERION + 1) }))
    expect(over).toEqual({
      ok: false,
      message: `Each success criterion is limited to ${MAX_CRITERION} characters.`
    })
  })
})
