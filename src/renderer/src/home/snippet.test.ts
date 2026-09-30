import { describe, expect, it } from 'vitest'
import { splitSnippet } from './snippet'

const plain = (text: string) => ({ text, match: false })
const hit = (text: string) => ({ text, match: true })

describe('splitSnippet', () => {
  it('returns nothing for an empty snippet', () => {
    expect(splitSnippet('')).toEqual([])
  })

  it('returns one plain part when nothing is highlighted', () => {
    expect(splitSnippet('no matches here')).toEqual([plain('no matches here')])
  })

  it('splits text around a highlighted match and drops the brackets', () => {
    expect(splitSnippet('Build the [telemetry] dashboard')).toEqual([
      plain('Build the '),
      hit('telemetry'),
      plain(' dashboard')
    ])
  })

  it('handles a match at the very start and at the very end', () => {
    expect(splitSnippet('[start] middle [end]')).toEqual([hit('start'), plain(' middle '), hit('end')])
  })

  it('handles adjacent matches without inventing empty parts', () => {
    expect(splitSnippet('[one][two]')).toEqual([hit('one'), hit('two')])
  })

  it('handles several matches in one snippet', () => {
    expect(splitSnippet('a [b] c [d] e')).toEqual([
      plain('a '),
      hit('b'),
      plain(' c '),
      hit('d'),
      plain(' e')
    ])
  })

  it('leaves unbalanced or empty brackets as plain text', () => {
    expect(splitSnippet('open [ bracket')).toEqual([plain('open [ bracket')])
    expect(splitSnippet('close ] bracket')).toEqual([plain('close ] bracket')])
    expect(splitSnippet('empty [] pair')).toEqual([plain('empty [] pair')])
  })
})
