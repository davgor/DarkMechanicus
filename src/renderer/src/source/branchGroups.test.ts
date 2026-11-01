import { describe, expect, it } from 'vitest'
import type { BranchInfo, BranchList } from '../../../shared/git/branches'
import { groupBranches } from './branchGroups'

function branch(name: string, remote: string | null, day = 1): BranchInfo {
  const lastCommitAt = `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`
  return { name, kind: remote === null ? 'local' : 'remote', remote, upstream: null, ahead: 0, behind: 0, lastCommitAt, isCurrent: false }
}

const shape = (list: BranchList, filter = ''): [string, string[]][] =>
  groupBranches(list, filter, false).map((group) => [group.title, group.entries.map((entry) => entry.target)])

describe('groupBranches edges', () => {
  it('sorts each remote group by name and keeps remotes apart', () => {
    const list: BranchList = {
      current: null,
      defaultBranch: null,
      branches: [branch('origin/zeta', 'origin', 9), branch('upstream/beta', 'upstream'), branch('origin/alpha', 'origin', 2)]
    }
    expect(shape(list)).toEqual([
      ['origin', ['origin/alpha', 'origin/zeta']],
      ['upstream', ['upstream/beta']]
    ])
  })

  it('shows one remote-only default branch and lists no other remote copy of it', () => {
    const list: BranchList = {
      current: null,
      defaultBranch: 'main',
      branches: [branch('upstream/main', 'upstream'), branch('origin/main', 'origin'), branch('origin/dev', 'origin')]
    }
    expect(shape(list)).toEqual([
      ['Default branch', ['upstream/main']],
      ['origin', ['origin/dev']]
    ])
  })

  it('groups a remote branch that names no remote under an untitled group', () => {
    const orphan: BranchInfo = { ...branch('stray', null), kind: 'remote' }
    expect(shape({ current: null, defaultBranch: null, branches: [orphan] })).toEqual([['', ['stray']]])
  })

  it('ignores surrounding spaces in the filter and drops the default branch when it does not match', () => {
    const list: BranchList = { current: 'main', defaultBranch: 'main', branches: [branch('main', null, 3), branch('topic', null, 2)] }
    expect(shape(list, '  TOP ')).toEqual([['Recent branches', ['topic']]])
  })
})
