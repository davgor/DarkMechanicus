import { describe, expect, it } from 'vitest'
import { descriptionOf, repoPrefix, withRepoPrefix } from './repoTitles'

describe('repoPrefix and withRepoPrefix', () => {
  it('prefixes the description with the repository name and a spaced dash', () => {
    expect(repoPrefix('alpha')).toBe('alpha - ')
    expect(withRepoPrefix('alpha', 'Add refund endpoint')).toBe('alpha - Add refund endpoint')
  })

  it('does not double a prefix when the title already carries it, once its description is taken first', () => {
    const title = withRepoPrefix('alpha', 'Add refund endpoint')
    expect(withRepoPrefix('alpha', descriptionOf('alpha', title))).toBe('alpha - Add refund endpoint')
  })
})

describe('descriptionOf', () => {
  it('strips exactly the repository prefix', () => {
    expect(descriptionOf('alpha', 'alpha - Add refund endpoint')).toBe('Add refund endpoint')
  })

  it('strips the prefix only once', () => {
    expect(descriptionOf('alpha', 'alpha - alpha - Twice')).toBe('alpha - Twice')
  })

  it('leaves a title without the prefix whole, including one with no repository', () => {
    expect(descriptionOf('alpha', 'Add refund endpoint')).toBe('Add refund endpoint')
    expect(descriptionOf(undefined, 'alpha - Add refund endpoint')).toBe('alpha - Add refund endpoint')
  })

  it("leaves a title that starts with another repository's prefix whole", () => {
    expect(descriptionOf('alpha', 'beta - Add refund endpoint')).toBe('beta - Add refund endpoint')
    expect(descriptionOf('alp', 'alpha - Add refund endpoint')).toBe('alpha - Add refund endpoint')
    expect(descriptionOf('alpha', 'alphabet - Add refund endpoint')).toBe('alphabet - Add refund endpoint')
  })

  it('handles a repository whose own name contains the separator', () => {
    expect(withRepoPrefix('foo - bar', 'Fix it')).toBe('foo - bar - Fix it')
    expect(descriptionOf('foo - bar', 'foo - bar - Fix it')).toBe('Fix it')
    expect(descriptionOf('foo', 'foo - bar - Fix it')).toBe('bar - Fix it')
    expect(descriptionOf('foo - bar', 'foo - Fix it')).toBe('foo - Fix it')
  })

  it('does not strip a prefix missing its trailing space or differing in case', () => {
    expect(descriptionOf('alpha', 'alpha -Add')).toBe('alpha -Add')
    expect(descriptionOf('alpha', 'Alpha - Add')).toBe('Alpha - Add')
  })
})
