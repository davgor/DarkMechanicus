import { chmodSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { changedLineIndices, type FileDiff } from '../../shared/git/diff'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { gitIn, put, scratchDir } from '../../test/gitScratch'
import { commitFiles, findInStatus, requireStatus } from './commit'
import { readWorkingDiff } from './diff'
import { GitError, GitInputError } from './errors'
import { createGitRunner } from './runner'

type TextDiff = Extract<FileDiff, { kind: 'text' }>

const runner = createGitRunner()
const cleanups: Array<() => void> = []
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function repo(): GitRepo {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  r.git('config', 'core.autocrlf', 'false')
  return r
}

/** Commits `content` as `path` outside the code under test. */
function base(r: GitRepo, path: string, content: string | Buffer): void {
  put(r.root, path, content)
  r.git('add', '--', path)
  r.git('commit', '-q', '-m', `base ${path}`)
}

async function workingDiff(root: string, path: string): Promise<TextDiff> {
  const status = await requireStatus(runner, root)
  const diff = await readWorkingDiff(runner, root, findInStatus(status, path))
  if (diff.kind !== 'text') {
    throw new Error(`expected a text diff, got ${diff.kind}`)
  }
  return diff
}

/** Commits the chosen lines of `path` and checks that the working file did not change. */
async function commitLines(root: string, path: string, pick: (diff: TextDiff) => number[]): Promise<TextDiff> {
  const diff = await workingDiff(root, path)
  const file = join(root, path)
  const before = readOrNull(file)
  const files = [{ path, oldPath: diff.oldPath, lines: pick(diff), diffHash: diff.hash }]
  await commitFiles(runner, root, { summary: 'Part', description: '', files })
  expect(readOrNull(file)).toEqual(before)
  return diff
}

function readOrNull(file: string): Buffer | null {
  try {
    return readFileSync(file)
  } catch {
    return null
  }
}

const show = (r: GitRepo, path: string): string => gitIn(r.root, 'show', `HEAD:${path}`)
const all = (diff: TextDiff): number[] => [...Array(changedLineIndices(diff).flat().filter((index) => index !== null).length).keys()]

describe('commitFiles with selected lines', () => {
  it('commits selected additions only, and selected deletions only', async () => {
    const r = repo()
    base(r, 'f.txt', 'a\nb\nc\nd\n')
    put(r.root, 'f.txt', 'a\nB\nc\nD\n')
    // Changes: -b 0, +B 1, -d 2, +D 3.
    await commitLines(r.root, 'f.txt', () => [1, 3])
    expect(show(r, 'f.txt')).toBe('a\nb\nB\nc\nd\nD\n')
    await commitLines(r.root, 'f.txt', () => [0])
    expect(show(r, 'f.txt')).toBe('a\nB\nc\nd\nD\n')
  })

  it('commits mixed lines of one hunk', async () => {
    const r = repo()
    base(r, 'f.txt', 'a\nb\nc\nd\n')
    put(r.root, 'f.txt', 'a\nB\nC\nd\n')
    // Changes: -b 0, -c 1, +B 2, +C 3.
    await commitLines(r.root, 'f.txt', () => [0, 3])
    expect(show(r, 'f.txt')).toBe('a\nc\nC\nd\n')
  })

  it('shifts later hunks by the selection in earlier ones', async () => {
    const r = repo()
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`)
    base(r, 'f.txt', `${lines.join('\n')}\n`)
    const edited = ['new 0', 'new 1', ...lines.slice(0, 14), 'mid', ...lines.slice(15, 28), 'end']
    put(r.root, 'f.txt', `${edited.join('\n')}\n`)
    const diff = await commitLines(r.root, 'f.txt', () => [1, 3, 6])
    expect(diff.hunks.length).toBeGreaterThan(1)
    const expected = ['new 1', ...lines.slice(0, 15), 'mid', ...lines.slice(15, 30), 'end']
    expect(show(r, 'f.txt')).toBe(`${expected.join('\n')}\n`)
  })
})

describe('commitFiles with selected lines and diff settings', () => {
  it('applies the patch when diff.context is 0', async () => {
    const r = repo()
    r.git('config', 'diff.context', '0')
    base(r, 'f.txt', '1\n2\n3\n4\n5\n6\n7\n8\n9\n')
    put(r.root, 'f.txt', '1\nTWO\n3\n4\n5\n6\n7\nEIGHT\n9\n')
    // Changes: -2 0, +TWO 1, -8 2, +EIGHT 3.
    await commitLines(r.root, 'f.txt', () => [1, 2])
    expect(show(r, 'f.txt')).toBe('1\n2\nTWO\n3\n4\n5\n6\n7\n9\n')
  })
})

describe('commitFiles with selected lines of new and deleted files', () => {
  it('creates a partly selected new file with only the selected lines, in an unborn repository too', async () => {
    const r = repo()
    put(r.root, 'n.txt', '1\n2\n3\n')
    await commitLines(r.root, 'n.txt', () => [0, 2])
    expect(show(r, 'n.txt')).toBe('1\n3\n')
    const dir = scratchDir()
    cleanups.push(dir.cleanup)
    gitIn(dir.path, 'init', '-q', '-b', 'main')
    gitIn(dir.path, 'config', 'user.name', 'Test')
    gitIn(dir.path, 'config', 'user.email', 'test@example.com')
    put(dir.path, 'u.txt', 'x\ny\n')
    await commitLines(dir.path, 'u.txt', () => [1])
    expect(gitIn(dir.path, 'show', 'HEAD:u.txt')).toBe('y\n')
  })

  it('keeps the unselected lines of a partly selected deleted file, and deletes a fully selected one', async () => {
    const r = repo()
    base(r, 'd.txt', '1\n2\n3\n')
    rmSync(join(r.root, 'd.txt'))
    await commitLines(r.root, 'd.txt', () => [1])
    expect(show(r, 'd.txt')).toBe('1\n3\n')
    await commitLines(r.root, 'd.txt', all)
    expect(r.git('ls-tree', 'HEAD', '--', 'd.txt')).toBe('')
  })

  it('handles a missing final newline on either side', async () => {
    const r = repo()
    base(r, 'f.txt', 'a\nb')
    put(r.root, 'f.txt', 'a\nb\nc')
    // Changes: -b 0, +b 1, +c 2.
    await commitLines(r.root, 'f.txt', () => [2])
    expect(show(r, 'f.txt')).toBe('a\nb\nc')
    put(r.root, 'f.txt', 'x\nb\nc\n')
    // Changes: -a 0, +x 1, -c 2, +c 3.
    await commitLines(r.root, 'f.txt', () => [0, 1])
    expect(show(r, 'f.txt')).toBe('x\nb\nc')
  })
})

describe('commitFiles with selected lines keeps bytes, paths and modes', () => {
  it('keeps CRLF lines byte-exact', async () => {
    const r = repo()
    base(r, 'w.txt', 'a\r\nb\r\nc\r\n')
    put(r.root, 'w.txt', 'a\r\nB\r\nc\r\nd\r\n')
    // Changes: -b 0, +B 1, +d 2.
    await commitLines(r.root, 'w.txt', () => [1, 2])
    expect(show(r, 'w.txt')).toBe('a\r\nb\r\nB\r\nc\r\nd\r\n')
  })

  it('commits a rename with part of its edit', async () => {
    const r = repo()
    base(r, 'old.txt', '1\n2\n3\n4\n5\n6\n')
    r.git('mv', 'old.txt', 'new name.txt')
    put(r.root, 'new name.txt', '1\nTWO\n3\n4\n5\n6\n7\n')
    // Changes: -2 0, +TWO 1, +7 2.
    const diff = await commitLines(r.root, 'new name.txt', () => [2])
    expect(diff.oldPath).toBe('old.txt')
    expect(show(r, 'new name.txt')).toBe('1\n2\n3\n4\n5\n6\n7\n')
    expect(r.git('ls-tree', 'HEAD', '--', 'old.txt')).toBe('')
  })

  it('keeps a mode change', async () => {
    const r = repo()
    base(r, 'run.sh', 'echo a\necho b\n')
    put(r.root, 'run.sh', 'echo A\necho b\necho c\n')
    chmodSync(join(r.root, 'run.sh'), 0o755)
    // Changes: -echo a 0, +echo A 1, +echo c 2.
    await commitLines(r.root, 'run.sh', () => [2])
    expect(show(r, 'run.sh')).toBe('echo a\necho b\necho c\n')
    expect(r.git('ls-tree', 'HEAD', '--', 'run.sh')).toMatch(/^100755 /)
    expect(statSync(join(r.root, 'run.sh')).mode & 0o777).toBe(0o755)
  })
})

describe('commitFiles with every line or no line selected', () => {
  it('commits the same tree as committing the whole file', async () => {
    const r = repo()
    base(r, 'f.txt', 'a\nb\nc')
    put(r.root, 'f.txt', 'A\nb\nc\nd\n')
    put(r.root, 'n.txt', 'new\n')
    await commitLines(r.root, 'f.txt', all)
    await commitLines(r.root, 'n.txt', all)
    const partial = r.git('rev-parse', 'HEAD^{tree}')
    r.git('reset', '-q', 'HEAD~2')
    const files = [{ path: 'f.txt', oldPath: null }, { path: 'n.txt', oldPath: null }]
    await commitFiles(runner, r.root, { summary: 'Whole', description: '', files })
    expect(r.git('rev-parse', 'HEAD^{tree}')).toBe(partial)
  })

  it('commits nothing for a file with no line selected', async () => {
    const r = repo()
    base(r, 'f.txt', 'a\n')
    put(r.root, 'f.txt', 'b\n')
    const head = r.rev('HEAD')
    const error = await rejection(commitLines(r.root, 'f.txt', () => []))
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).code).toBe('nothing_to_commit')
    expect(r.rev('HEAD')).toBe(head)
  })

  it('commits whole files and selected lines together', async () => {
    const r = repo()
    base(r, 'f.txt', 'a\nb\n')
    put(r.root, 'f.txt', 'A\nB\n')
    put(r.root, 'whole.txt', 'w\n')
    const diff = await workingDiff(r.root, 'f.txt')
    const files = [{ path: 'whole.txt', oldPath: null }, { path: 'f.txt', oldPath: null, lines: [0, 2], diffHash: diff.hash }]
    await commitFiles(runner, r.root, { summary: 'Both', description: '', files })
    // Changes: -a 0, -b 1, +A 2, +B 3; b stays and A follows it.
    expect(show(r, 'f.txt')).toBe('b\nA\n')
    expect(show(r, 'whole.txt')).toBe('w\n')
  })
})

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('commitFiles refuses a selection it cannot apply exactly', () => {
  it('returns stale_selection and commits nothing when the file changed after the diff was read', async () => {
    const r = repo()
    base(r, 'f.txt', 'a\nb\n')
    put(r.root, 'f.txt', 'A\nb\n')
    put(r.root, 'other.txt', 'o\n')
    const diff = await workingDiff(r.root, 'f.txt')
    put(r.root, 'f.txt', 'A\nB\n')
    r.git('add', '--', 'other.txt')
    const head = r.rev('HEAD')
    const files = [{ path: 'other.txt', oldPath: null }, { path: 'f.txt', oldPath: null, lines: [1], diffHash: diff.hash }]
    const error = await rejection(commitFiles(runner, r.root, { summary: 'Stale', description: '', files }))
    expect(error).toBeInstanceOf(GitError)
    expect((error as GitError).code).toBe('stale_selection')
    expect(r.rev('HEAD')).toBe(head)
    expect(r.git('diff', '--cached', '--name-only')).toBe('other.txt')
    expect(readFileSync(join(r.root, 'f.txt'), 'utf8')).toBe('A\nB\n')
  })

  it('refuses lines without a diff hash, out-of-range lines and lines of a file that is not UTF-8', async () => {
    const r = repo()
    base(r, 'f.txt', 'a\n')
    put(r.root, 'f.txt', 'b\n')
    base(r, 'latin.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
    put(r.root, 'latin.txt', Buffer.from([0x74, 0xe9, 0x0a]))
    const head = r.rev('HEAD')
    const hash = (await workingDiff(r.root, 'f.txt')).hash
    const latinHash = (await workingDiff(r.root, 'latin.txt')).hash
    const attempts = [
      { path: 'f.txt', oldPath: null, lines: [0] },
      { path: 'f.txt', oldPath: null, lines: [2], diffHash: hash },
      { path: 'f.txt', oldPath: null, lines: [-1], diffHash: hash },
      { path: 'latin.txt', oldPath: null, lines: [1], diffHash: latinHash }
    ]
    for (const entry of attempts) {
      const error = await rejection(commitFiles(runner, r.root, { summary: 'x', description: '', files: [entry] }))
      expect(error).toBeInstanceOf(GitInputError)
    }
    expect(r.rev('HEAD')).toBe(head)
  })
})

describe('commitFiles refuses lines it cannot read as text', () => {
  it('refuses lines of a binary file and of a file that is also chosen whole', async () => {
    const r = repo()
    base(r, 'bin.dat', Buffer.from([0, 1, 2]))
    put(r.root, 'bin.dat', Buffer.from([0, 1, 3]))
    put(r.root, 'f.txt', 'x\n')
    const status = await requireStatus(runner, r.root)
    const binHash = (await readWorkingDiff(runner, r.root, findInStatus(status, 'bin.dat'))).hash
    const textHash = (await workingDiff(r.root, 'f.txt')).hash
    const head = r.rev('HEAD')
    const attempts = [
      [{ path: 'bin.dat', oldPath: null, lines: [0], diffHash: binHash }],
      [{ path: 'f.txt', oldPath: null }, { path: 'f.txt', oldPath: null, lines: [0], diffHash: textHash }]
    ]
    for (const files of attempts) {
      expect(await rejection(commitFiles(runner, r.root, { summary: 'x', description: '', files }))).toBeInstanceOf(GitInputError)
    }
    expect(r.rev('HEAD')).toBe(head)
  })

  it('refuses lines of a submodule', async () => {
    const r = repo()
    const first = r.rev('HEAD')
    const second = r.commit('second')
    r.git('update-index', '--add', '--cacheinfo', `160000,${first},sub`)
    r.git('commit', '-q', '-m', 'add sub')
    r.git('update-index', '--cacheinfo', `160000,${second},sub`)
    const diff = await readWorkingDiff(runner, r.root, findInStatus(await requireStatus(runner, r.root), 'sub'))
    expect(diff.kind).toBe('text')
    const files = [{ path: 'sub', oldPath: null, lines: [1], diffHash: diff.hash }]
    expect(await rejection(commitFiles(runner, r.root, { summary: 'x', description: '', files }))).toBeInstanceOf(GitInputError)
  })

  // Skipped on Windows: creating a symlink there needs privileges.
  it.skipIf(process.platform === 'win32')('refuses lines of a file whose type changed', async () => {
    const r = repo()
    rmSync(join(r.root, 'file-1.txt'))
    symlinkSync('elsewhere', join(r.root, 'file-1.txt'))
    const files = [{ path: 'file-1.txt', oldPath: null, lines: [0], diffHash: 'x' }]
    expect(await rejection(commitFiles(runner, r.root, { summary: 'x', description: '', files }))).toBeInstanceOf(GitInputError)
  })
})
