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

it.each([
  { state: 'extra commit', message: 'not an initial commit' },
  { state: 'working copy edit', message: 'changes outside the recorded scaffold' },
  { state: 'incomplete initial tree', message: 'commit is incomplete' }
])('refuses to publish an interrupted checkout with $state', async ({ state, message }) => {
  const scratch = scratchDir('forge-code-receipt-')
  const { path } = scratch
  try {
    gitIn(path, 'init', '--initial-branch=main')
    const starter = join(path, 'starter.txt')
    writeFileSync(starter, files[0]!.content)
    gitIn(path, 'add', 'starter.txt')
    gitIn(path, 'commit', '-m', 'Known initial scaffold')
    if (state === 'extra commit') gitIn(path, 'commit', '--allow-empty', '-m', 'Another commit')
    if (state === 'working copy edit') writeFileSync(starter, 'Personal edit')
    const planned = state === 'incomplete initial tree' ? [...files, { path: 'second.txt', content: 'Expected scaffold source' }] : files
    const before = gitIn(path, 'rev-parse', 'HEAD')
    const git = new ForgeGit({ getAccount: () => null, getToken: () => null })
    await expect(commitForgeScaffold(git, { root: path, files: planned, author: 'example', assertCurrent() {} })).rejects.toThrow(message)
    expect(gitIn(path, 'rev-parse', 'HEAD')).toBe(before)
  } finally { scratch.cleanup() }
})
