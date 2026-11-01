import { describe, expect, it } from 'vitest'
import { parseProgressLine } from './progress'

describe('parseProgressLine', () => {
  it.each([
    ['Counting objects:  45% (9/20)', { phase: 'Counting objects', percent: 45 }],
    ['Compressing objects: 100% (12/12), done.', { phase: 'Compressing objects', percent: 100 }],
    ['Receiving objects:  45% (450/1000)', { phase: 'Receiving objects', percent: 45 }],
    ['Receiving objects:  45% (450/1000), 1.20 MiB | 2.40 MiB/s', { phase: 'Receiving objects', percent: 45 }],
    ['Resolving deltas:   7% (1/14)', { phase: 'Resolving deltas', percent: 7 }],
    ['Writing objects:   0% (0/3)', { phase: 'Writing objects', percent: 0 }],
    ['remote: Counting objects:  50% (1/2)', { phase: 'Counting objects', percent: 50 }],
    ['remote: Compressing objects: 100% (2/2), done.        ', { phase: 'Compressing objects', percent: 100 }],
    ['remote: Enumerating objects: 5, done.', { phase: 'Enumerating objects', percent: null }],
    ['Enumerating objects: 12, done.', { phase: 'Enumerating objects', percent: null }],
    ['remote: Total 3 (delta 0), reused 0 (delta 0), pack-reused 0', null],
    ["remote: Create a pull request for 'topic' on GitHub by visiting:", null],
    ['remote:      https://github.com/octo/hello/pull/new/topic', null],
    ['To /tmp/remote.git', null],
    [' * branch            main       -> FETCH_HEAD', null],
    ['fatal: Authentication failed for https://github.com/', null],
    ['', null]
  ])('parses %j', (line, expected) => {
    expect(parseProgressLine(line)).toEqual(expected)
  })

  it('never reports more than 100 percent', () => {
    expect(parseProgressLine('Receiving objects: 250% (5/2)')).toEqual({ phase: 'Receiving objects', percent: 100 })
  })
})
