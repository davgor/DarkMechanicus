import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { copyGitRepo, type GitRepo } from './gitRepo'
import { isolateGitConfig, teammatePushes, useRemoteRepos } from './gitRemotes'
import { gitIn } from './gitScratch'
import { useTemplate } from './gitTemplate'

const cleanups: Array<() => void> = []
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

const remotes = useRemoteRepos()
const remoteTemplate = useTemplate((templateCleanups) => remotes(templateCleanups))

function refsOf(folder: string): string {
  return gitIn(folder, 'for-each-ref', '--format=%(refname) %(objectname)').trim()
}

describe('useRemoteRepos', () => {
  it("gives each call its own origin: a copy's pushes, and its teammate's, never reach the template or another copy", () => {
    const template = remoteTemplate()
    const before = { bare: refsOf(template.bare), local: refsOf(template.local.root) }
    const first = remotes(cleanups)
    const second = remotes(cleanups)
    first.local.branch('topic')
    const pushed = first.local.commit('pushed from the first copy')
    first.local.git('push', '-q', '-u', 'origin', 'topic')
    teammatePushes(second.other, 'team.txt')

    expect(gitIn(first.bare, 'rev-parse', 'refs/heads/topic').trim()).toBe(pushed)
    expect(gitIn(second.bare, 'for-each-ref', 'refs/heads/topic').trim()).toBe('')
    expect(gitIn(second.bare, 'rev-parse', 'refs/heads/main').trim()).not.toBe(gitIn(first.bare, 'rev-parse', 'refs/heads/main').trim())
    expect({ bare: refsOf(template.bare), local: refsOf(template.local.root) }).toEqual(before)
    expect(first.local.git('config', 'remote.origin.url')).toBe(first.bare)
    expect(first.local.git('rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main')
  })
})

describe('copyGitRepo', () => {
  const repoTemplate = useTemplate((templateCleanups): GitRepo => {
    const { local } = remotes(templateCleanups)
    local.branch('work')
    local.commit('second')
    return local
  })

  it('copies history, branches and the working tree, and its commits carry on from the template', () => {
    const template = repoTemplate()
    const copy = copyGitRepo(template)
    cleanups.push(copy.cleanup)
    expect(copy.root).not.toBe(template.root)
    expect(copy.rev('HEAD')).toBe(template.rev('HEAD'))
    expect(copy.git('branch', '--show-current')).toBe('work')
    const next = copy.commit('third')
    expect(existsSync(join(copy.root, 'file-3.txt'))).toBe(true)
    expect(copy.rev('HEAD')).toBe(next)
    expect(template.rev('HEAD')).not.toBe(next)
    expect(existsSync(join(template.root, 'file-3.txt'))).toBe(false)
  })
})
