import { describe, expect, it } from 'vitest'
import { groupByOwner, matchesFilter, repositoryName, targetPath } from './cloneTarget'
import { repository } from '../__mocks__/githubRepository'

describe('repositoryName', () => {
  it.each([
    ['https://github.com/octocat/Hello-World', 'Hello-World'],
    ['https://github.com/octocat/Hello-World.git', 'Hello-World'],
    ['https://github.com/octocat/Hello-World/', 'Hello-World'],
    ['git@github.com:octocat/Spoon-Knife.git', 'Spoon-Knife'],
    ['ssh://git@example.com/team/tool.git', 'tool'],
    ['octocat/linguist', 'linguist'],
    ['  octocat/linguist  ', 'linguist'],
    ['', ''],
    ['https://github.com/', '']
  ])('%s gives %s', (source, name) => {
    expect(repositoryName(source)).toBe(name)
  })
})

describe('targetPath', () => {
  it('joins the parent and the name with the parent’s separator', () => {
    expect(targetPath('/Users/me/GitHub', 'tool')).toBe('/Users/me/GitHub/tool')
    expect(targetPath('/Users/me/GitHub/', 'tool')).toBe('/Users/me/GitHub/tool')
    expect(targetPath('C:\\Users\\me\\GitHub', 'tool')).toBe('C:\\Users\\me\\GitHub\\tool')
  })
})

describe('repository filtering and grouping', () => {
  const repos = [
    repository({ owner: 'octocat', name: 'Hello-World' }),
    repository({ owner: 'acme', name: 'rockets' }),
    repository({ owner: 'octocat', name: 'Spoon-Knife' })
  ]

  it('matches the full name without regard to case', () => {
    expect(repos.filter((repo) => matchesFilter(repo, 'HELLO')).map((repo) => repo.name)).toEqual(['Hello-World'])
    expect(repos.filter((repo) => matchesFilter(repo, 'acme/')).map((repo) => repo.name)).toEqual(['rockets'])
    expect(repos.filter((repo) => matchesFilter(repo, '  '))).toHaveLength(3)
  })

  it('groups by owner in first-seen order, keeping the order inside each owner', () => {
    expect(groupByOwner(repos).map((group) => [group.owner, group.repositories.map((repo) => repo.name)])).toEqual([
      ['octocat', ['Hello-World', 'Spoon-Knife']],
      ['acme', ['rockets']]
    ])
  })
})
