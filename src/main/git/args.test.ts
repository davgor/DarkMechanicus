import { afterEach, describe, expect, it } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { checkBranchName, pathArgs, refArg } from './args'
import { createGitRunner } from './runner'

describe('pathArgs', () => {
  it('puts paths after --', () => {
    expect(pathArgs(['a.txt', 'dir/b.txt', './c', 'dir/../d', '-dash'])).toEqual(['--', 'a.txt', 'dir/b.txt', './c', 'dir/../d', '-dash'])
  })

  it.each([
    ['NUL', 'a\u0000b'],
    ['empty string', ''],
    ['posix absolute', '/etc/passwd'],
    ['windows drive', 'C:\\x'],
    ['windows drive, forward slash', 'c:/x'],
    ['UNC', '\\\\host\\share'],
    ['leading ..', '../x'],
    ['nested escape', 'a/../../x'],
    ['backslash escape', '..\\x'],
    ['bare ..', '..']
  ])('refuses %s', (_name, value) => {
    expect(() => pathArgs(['ok', value])).toThrow(/Refusing/)
  })
})

describe('refArg', () => {
  it('returns a plain ref', () => {
    expect(refArg('feature/x')).toBe('feature/x')
  })

  it.each([
    ['leading dash', '-D'],
    ['NUL', 'a\u0000'],
    ['space', 'a b'],
    ['tab', 'a\tb'],
    ['newline', 'a\nb'],
    ['empty', '']
  ])('refuses %s', (_name, value) => {
    expect(() => refArg(value)).toThrow(/Refusing/)
  })
})

describe('checkBranchName', () => {
  let repo: GitRepo | null = null
  afterEach(() => {
    repo?.cleanup()
    repo = null
  })

  it("reports git's verdict", async () => {
    repo = createGitRepo()
    const runner = createGitRunner()
    expect(await checkBranchName(runner, repo.root, 'feature/ok')).toEqual({ valid: true, normalized: 'feature/ok' })
    expect(await checkBranchName(runner, repo.root, 'bad..name')).toEqual({ valid: false, normalized: null })
    expect(await checkBranchName(runner, repo.root, 'has space')).toEqual({ valid: false, normalized: null })
    expect(await checkBranchName(runner, repo.root, '-x')).toEqual({ valid: false, normalized: null })
    expect(await checkBranchName(runner, repo.root, 'a\u0000b')).toEqual({ valid: false, normalized: null })
  })
})
