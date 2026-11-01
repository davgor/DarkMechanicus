import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { linkDirectory } from '../../test/tempRepo'
import { detectChildRepos, isInsideGitRepository } from './childRepos'
import { nodeFs } from './nodeFs'

let base: string

beforeEach(() => {
  base = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-child-repos-')))
})

afterEach(() => {
  rmSync(base, { recursive: true, force: true })
})

describe('detectChildRepos', () => {
  it('returns only immediate, non-hidden, real child directories holding a .git directory or file', () => {
    mkdirSync(join(base, 'alpha', '.git'), { recursive: true })
    mkdirSync(join(base, 'beta'))
    writeFileSync(join(base, 'beta', '.git'), 'gitdir: ../elsewhere/.git/worktrees/beta\n')
    mkdirSync(join(base, 'plain'))
    writeFileSync(join(base, 'notes.txt'), 'not a repository')
    mkdirSync(join(base, '.hidden', '.git'), { recursive: true })
    linkDirectory(join(base, 'alpha'), join(base, 'linked'))
    mkdirSync(join(base, 'gamma', 'nested', '.git'), { recursive: true })

    expect(detectChildRepos(base, nodeFs)).toEqual(['alpha', 'beta'])
  })

  it('sorts exact names by code point, not by UTF-16 code unit or locale', () => {
    // U+FB00 sorts before U+1D49C by code point, after it by UTF-16 code unit (0xD835).
    for (const name of ['beta', 'zz-\u{1D49C}', 'Zeta', 'zz-\u{FB00}', 'alpha']) {
      mkdirSync(join(base, name, '.git'), { recursive: true })
    }

    expect(detectChildRepos(base, nodeFs)).toEqual(['Zeta', 'alpha', 'beta', 'zz-\u{FB00}', 'zz-\u{1D49C}'])
  })

  it('returns [] for an empty parent', () => {
    expect(detectChildRepos(base, nodeFs)).toEqual([])
  })
})

describe('isInsideGitRepository', () => {
  it('is true for a subfolder of a repository', () => {
    mkdirSync(join(base, 'repo', '.git'), { recursive: true })
    mkdirSync(join(base, 'repo', 'src', 'deep'), { recursive: true })

    expect(isInsideGitRepository(join(base, 'repo', 'src', 'deep'), nodeFs)).toBe(true)
    expect(isInsideGitRepository(join(base, 'repo'), nodeFs)).toBe(true)
  })

  it('is false for a plain temp folder', () => {
    mkdirSync(join(base, 'plain'))

    expect(isInsideGitRepository(join(base, 'plain'), nodeFs)).toBe(false)
  })
})
