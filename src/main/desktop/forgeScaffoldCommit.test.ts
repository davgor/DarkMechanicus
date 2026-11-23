import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { ForgeGit } from './forgeGit'
import { commitForgeScaffold } from './forgeScaffoldCommit'

const files = [{ path: 'starter.txt', content: 'pinned source\n' }]

it.each(['untracked', 'staged', 'committed'] as const)('preserves unknown %s files without committing or replacing them', async state => {
  const scratch = scratchDir('forge-code-closure-')
  const { path } = scratch
  try {
    gitIn(path, 'init', '--initial-branch=main')
    writeFileSync(join(path, 'starter.txt'), files[0]!.content)
    writeFileSync(join(path, 'personal.txt'), 'unapproved contents')
    if (state !== 'untracked') gitIn(path, 'add', 'personal.txt')
    if (state === 'committed') gitIn(path, 'commit', '-m', 'Unrelated work')
    if (state !== 'untracked') unlinkSync(join(path, 'personal.txt'))
    const git = new ForgeGit({ getAccount: () => null, getToken: () => null })
    const staged = gitIn(path, 'ls-files', '--stage')
    const error = state === 'untracked' ? 'unexpected file' : 'unexpected content'
    await expect(commitForgeScaffold(git, { root: path, files, author: 'example', assertCurrent() {} })).rejects.toThrow(error)
    expect(gitIn(path, 'ls-files', '--stage')).toBe(staged)
    expect(existsSync(join(path, 'personal.txt'))).toBe(state === 'untracked')
    if (state === 'committed') expect(gitIn(path, 'log', '-1', '--format=%s').trim()).toBe('Unrelated work')
  } finally { scratch.cleanup() }
})
