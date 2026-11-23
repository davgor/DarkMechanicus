import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, sep } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { readLocalGitOrigin } from './git'
import { gitOriginContext, LocalGitOriginConfigCache } from './gitOriginConfig'

const queries = vi.hoisted(() => [] as string[])
const nextDiscovery = vi.hoisted(() => ({ complete: undefined as (() => void) | undefined }))
const nextConfig = vi.hoisted(() => ({ complete: undefined as (() => void) | undefined }))
vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync(command: string, args: string[], options: unknown) {
    if (args[2] === 'config' || args[2] === 'rev-parse') queries.push(args[2])
    const result = Reflect.apply(actual.execFileSync, undefined, [command, args, options])
    if (args[2] === 'rev-parse' && args[3] === '--path-format=absolute') {
      const complete = nextDiscovery.complete
      nextDiscovery.complete = undefined
      complete?.()
    }
    if (args[2] === 'config') {
      const complete = nextConfig.complete
      nextConfig.complete = undefined
      complete?.()
    }
    return result
  } }
})

const origin = 'https://github.com/example/ordinary.git'
const replacement = 'https://github.com/example/replaced.git'
const cleanups: Array<() => void> = []
afterEach(() => {
  vi.unstubAllEnvs()
  nextDiscovery.complete = undefined
  nextConfig.complete = undefined
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function checkout() {
  if (process.platform !== 'win32') {
    const path = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    const dir = dirname(realpathSync.native(path))
    vi.stubEnv('PATH', `${dir}${delimiter}${process.env.PATH ?? ''}`)
  }
  const scratch = scratchDir('git-origin-config-proof-')
  cleanups.push(scratch.cleanup)
  gitIn(scratch.path, 'init', '--initial-branch=main')
  gitIn(scratch.path, 'remote', 'add', 'origin', origin)
  queries.length = 0
  return scratch.path
}

it('keeps live Git discovery on each check while parsing unchanged local origin config once', () => {
  const root = checkout()
  const cache = new LocalGitOriginConfigCache(value => value)
  expect(readLocalGitOrigin(root, cache)).toBe(origin)
  expect(readLocalGitOrigin(root, cache)).toBe(origin)
  expect(queries).toEqual(['rev-parse', 'config', 'rev-parse'])
})

it('re-reads the local origin when its config or executable search context changes', () => {
  const root = checkout()
  const file = join(root, '.git', 'config')
  const modified = new Date('2026-01-01T00:00:00Z')
  utimesSync(file, modified, modified)
  const size = statSync(file).size
  const cache = new LocalGitOriginConfigCache(value => value)
  expect(readLocalGitOrigin(root, cache)).toBe(origin)
  gitIn(root, 'remote', 'set-url', 'origin', replacement)
  utimesSync(file, modified, modified)
  expect(statSync(file)).toMatchObject({ size, mtimeMs: modified.getTime() })
  expect(readLocalGitOrigin(root, cache)).toBe(replacement)
  expect(readLocalGitOrigin(root, cache)).toBe(replacement)
  expect(queries).toEqual(['rev-parse', 'config', 'rev-parse', 'config', 'rev-parse'])

  vi.stubEnv('PATH', `${root}${delimiter}${process.env.PATH ?? ''}`)
  queries.length = 0
  expect(readLocalGitOrigin(root, cache)).toBe(replacement)
  expect(queries).toEqual(['rev-parse', 'config'])
})

it('keeps explicit alternate configuration on the legacy Git read path', () => {
  const root = checkout()
  const cache = new LocalGitOriginConfigCache(value => value)
  expect(readLocalGitOrigin(root, cache)).toBe(origin)
  const alternate = join(root, 'alternate-config')
  writeFileSync(alternate, `[remote "origin"]\nurl = ${replacement}\n`)
  vi.stubEnv('GIT_CONFIG', alternate)
  queries.length = 0
  expect(readLocalGitOrigin(root, cache)).toBeNull()
  expect(queries).toEqual(['rev-parse', 'config'])
})

it('re-reads a linked worktree origin through its shared Git config', () => {
  const root = checkout()
  const linked = scratchDir('git-origin-linked-')
  cleanups.push(linked.cleanup)
  gitIn(root, 'commit', '--allow-empty', '-m', 'Seed the main checkout')
  gitIn(root, 'worktree', 'add', '-b', 'linked', linked.path)
  const cache = new LocalGitOriginConfigCache(value => value)
  expect(readLocalGitOrigin(linked.path, cache)).toBe(origin)
  gitIn(root, 'remote', 'set-url', 'origin', replacement)
  expect(readLocalGitOrigin(linked.path, cache)).toBe(replacement)
  expect(queries).toEqual(['rev-parse', 'config', 'rev-parse', 'config'])
})

it('refuses a live Git ownership check after trust is removed with identical local config bytes', () => {
  const root = checkout()
  const global = join(root, 'global-config')
  const local = join(root, '.git', 'config')
  const bytes = readFileSync(local)
  vi.stubEnv('GIT_CONFIG_GLOBAL', global)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_TEST_ASSUME_DIFFERENT_OWNER', '1')
  writeFileSync(global, `[safe]\ndirectory = "${root.replaceAll('\\', '/')}"\n`)
  const cache = new LocalGitOriginConfigCache(value => value)
  expect(readLocalGitOrigin(root, cache)).toBe(origin)

  writeFileSync(global, '[core]\npager = cat\n')
  queries.length = 0
  expect(readFileSync(local)).toEqual(bytes)
  expect(readLocalGitOrigin(root, cache)).toBeNull()
  expect(queries).toContain('rev-parse')
  expect(queries).not.toContain('config')
})

it('falls back to a live Git config read when metadata changes during repository discovery', () => {
  const root = checkout()
  const cache = new LocalGitOriginConfigCache(value => value)
  expect(readLocalGitOrigin(root, cache)).toBe(origin)
  nextDiscovery.complete = () => { gitIn(root, 'remote', 'set-url', 'origin', replacement) }
  queries.length = 0
  expect(readLocalGitOrigin(root, cache)).toBe(replacement)
  expect(queries).toEqual(['rev-parse', 'rev-parse', 'config'])
})

it('discards a parsed local origin when its file changes during the Git config command', () => {
  const root = checkout()
  const cache = new LocalGitOriginConfigCache(value => value)
  nextConfig.complete = () => { gitIn(root, 'remote', 'set-url', 'origin', replacement) }
  expect(readLocalGitOrigin(root, cache)).toBe(replacement)
  expect(queries).toEqual(['rev-parse', 'config', 'rev-parse', 'config'])
})

it('uses live Git config when the executable search context changes during discovery', () => {
  const root = checkout()
  const cache = new LocalGitOriginConfigCache(value => value)
  expect(readLocalGitOrigin(root, cache)).toBe(origin)
  nextDiscovery.complete = () => { vi.stubEnv('PATH', `${root}${delimiter}${process.env.PATH ?? ''}`) }
  queries.length = 0
  expect(readLocalGitOrigin(root, cache)).toBe(origin)
  expect(queries).toEqual(['rev-parse', 'rev-parse', 'config'])
})

it('leaves multiple local origins unproved and reads the repaired config', () => {
  const root = checkout()
  const cache = new LocalGitOriginConfigCache(value => value)
  gitIn(root, 'config', '--local', '--add', 'remote.origin.url', replacement)
  expect(readLocalGitOrigin(root, cache)).toBeNull()
  gitIn(root, 'config', '--local', '--unset-all', 'remote.origin.url')
  gitIn(root, 'config', '--local', '--add', 'remote.origin.url', replacement)
  expect(readLocalGitOrigin(root, cache)).toBe(replacement)
  expect(readLocalGitOrigin(root, cache)).toBe(replacement)
  expect(queries).toEqual(['rev-parse', 'config', 'rev-parse', 'config', 'rev-parse'])
})

it('excludes included origin values when proving and reusing local configuration', () => {
  const root = checkout()
  const included = join(root, 'included-config')
  writeFileSync(included, `[remote "origin"]\nurl = ${replacement}\n`)
  gitIn(root, 'config', '--local', '--add', 'include.path', included.replaceAll('\\', '/'))
  gitIn(root, 'config', '--local', '--unset-all', 'remote.origin.url')
  const cache = new LocalGitOriginConfigCache(value => value)
  expect(readLocalGitOrigin(root, cache)).toBeNull()

  gitIn(root, 'config', '--local', '--add', 'remote.origin.url', origin)
  expect(readLocalGitOrigin(root, cache)).toBe(origin)
  writeFileSync(included, '[remote "origin"]\nurl = https://github.com/example/changed-include.git\n')
  expect(readLocalGitOrigin(root, cache)).toBe(origin)
  expect(queries).toEqual(['rev-parse', 'config', 'rev-parse', 'config', 'rev-parse'])
})

it('reads live Git when a previously proved config becomes too large or disappears', () => {
  const root = checkout()
  const cache = new LocalGitOriginConfigCache(value => value)
  expect(readLocalGitOrigin(root, cache)).toBe(origin)
  const config = join(root, '.git', 'config')
  writeFileSync(config, readFileSync(config, 'utf8') + '# Outside the receipt size bound\n'.repeat(40_000))
  queries.length = 0
  expect(readLocalGitOrigin(root, cache)).toBe(origin)
  expect(readLocalGitOrigin(root, cache)).toBe(origin)
  expect(queries).toEqual(['rev-parse', 'config', 'rev-parse', 'config'])

  unlinkSync(config)
  expect(readLocalGitOrigin(root, cache)).toBeNull()
})

it('keeps a Git executable reached through a lexical dot segment on the live path', () => {
  const root = checkout()
  const [native, ...remaining] = process.env.PATH!.split(delimiter)
  const ambiguous = `${native}${sep}.`
  vi.stubEnv('PATH', [ambiguous, ...remaining].join(delimiter))
  const cache = new LocalGitOriginConfigCache(value => value)
  expect(readLocalGitOrigin(root, cache)).toBe(origin)
  expect(readLocalGitOrigin(root, cache)).toBe(origin)
  expect(queries).toEqual(['rev-parse', 'config', 'rev-parse', 'config'])
})

it('declines an unrecognized launcher and an earlier Windows executable candidate', () => {
  const scratch = scratchDir('git-origin-executable-')
  cleanups.push(scratch.cleanup)
  const custom = join(scratch.path, 'custom-bin')
  mkdirSync(custom)
  const executable = process.platform === 'win32' ? 'git.exe' : 'git'
  writeFileSync(join(custom, executable), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  expect(gitOriginContext({ PATH: custom }).executable).toBeNull()

  if (process.platform === 'win32') {
    const native = gitOriginContext({ PATH: process.env.PATH }).executable
    expect(native).not.toBeNull()
    const directory = join(scratch.path, 'ucrt64', 'bin')
    mkdirSync(directory, { recursive: true })
    const copy = join(directory, 'git.exe')
    copyFileSync(native!, copy)
    expect(gitOriginContext({ PATH: directory }).executable).toBe(copy)

    writeFileSync(join(directory, 'git.com'), '')
    expect(gitOriginContext({ PATH: directory }).executable).toBeNull()
  }
})
