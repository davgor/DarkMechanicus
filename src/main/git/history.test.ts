import { afterEach, describe, expect, it } from 'vitest'
import type { FileDiff } from '../../shared/git/diff'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { gitIn, put, scratchDir } from '../../test/gitScratch'
import { GitInputError } from './errors'
import { getCommitDiff, getCommitFiles, getHistory } from './history'
import { createGitRunner } from './runner'

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
  return r
}

function commitAll(r: GitRepo, message: string): string {
  r.git('add', '-A')
  r.git('commit', '-q', '-m', message)
  return r.rev('HEAD')
}

function textOf(diff: FileDiff): Extract<FileDiff, { kind: 'text' }> {
  if (diff.kind !== 'text') {
    throw new Error(`expected text, got ${diff.kind}`)
  }
  return diff
}

const BIG = `${Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n')}\n`

function mergeCommit(r: GitRepo): string {
  r.branch('feature')
  put(r.root, 'feature.txt', 'f\n')
  commitAll(r, 'feature work')
  r.switchTo('main')
  put(r.root, 'main.txt', 'm\n')
  commitAll(r, 'main work')
  return r.merge('feature')
}

function renameCommit(r: GitRepo): string {
  put(r.root, 'big.txt', BIG)
  commitAll(r, 'add big')
  r.git('mv', 'big.txt', 'moved.txt')
  put(r.root, 'moved.txt', `${BIG}extra\n`)
  return commitAll(r, 'rename')
}

describe('getHistory', () => {
  it('lists commits newest first with their fields', async () => {
    const r = repo()
    put(r.root, 'a.txt', 'one\n')
    r.git('add', '-A')
    r.git('commit', '-q', '-m', 'second subject', '-m', 'the body\nline two')
    const page = await getHistory(runner, r.root, { skip: 0, limit: 10 })
    expect(page.hasMore).toBe(false)
    expect(page.commits.map((c) => c.summary)).toEqual(['second subject', 'initial commit'])
    const [head, root] = page.commits
    expect(head?.oid).toBe(r.rev('HEAD'))
    expect(head?.shortOid).toBe(r.rev('HEAD').slice(0, 7))
    expect(head?.parents).toEqual([r.rev('HEAD~1')])
    expect(head?.body).toBe('the body\nline two')
    expect(head?.authorName).toBe('Test')
    expect(head?.authorEmail).toBe('test@example.com')
    expect(new Date(head?.authoredAt ?? '').toString()).not.toBe('Invalid Date')
    expect(root?.parents).toEqual([])
  })

  it('pages past 100 commits', async () => {
    const r = repo()
    for (let i = 0; i < 120; i += 1) {
      r.git('commit', '-q', '--allow-empty', '-m', `c${i}`)
    }
    const first = await getHistory(runner, r.root, { skip: 0, limit: 100 })
    expect(first.commits).toHaveLength(100)
    expect(first.hasMore).toBe(true)
    expect(first.commits[0]?.summary).toBe('c119')
    const second = await getHistory(runner, r.root, { skip: 100, limit: 100 })
    expect(second.commits).toHaveLength(21)
    expect(second.hasMore).toBe(false)
    expect(second.commits[0]?.summary).toBe('c19')
    expect(second.commits.at(-1)?.summary).toBe('initial commit')
  })

})

describe('getHistory states', () => {
  it('returns no commits on an unborn branch', async () => {
    const dir = scratchDir()
    cleanups.push(dir.cleanup)
    gitIn(dir.path, 'init', '-q', '-b', 'main')
    expect(await getHistory(runner, dir.path, { skip: 0, limit: 100 })).toEqual({ commits: [], hasMore: false })
  })

  it('marks commits no remote has as unpushed', async () => {
    const r = repo()
    const bare = scratchDir()
    cleanups.push(bare.cleanup)
    gitIn(bare.path, 'init', '-q', '--bare', '-b', 'main')
    r.git('remote', 'add', 'origin', bare.path)
    r.git('push', '-q', 'origin', 'main')
    r.commit('local only')
    const page = await getHistory(runner, r.root, { skip: 0, limit: 10 })
    expect(page.commits.map((c) => [c.summary, c.unpushed])).toEqual([
      ['local only', true],
      ['initial commit', false]
    ])
  })

})

describe('getHistory requests', () => {
  it('refuses a limit above 200, a limit below 1 or a negative skip', async () => {
    const r = repo()
    await expect(getHistory(runner, r.root, { skip: 0, limit: 201 })).rejects.toBeInstanceOf(GitInputError)
    await expect(getHistory(runner, r.root, { skip: -1, limit: 10 })).rejects.toBeInstanceOf(GitInputError)
    await expect(getHistory(runner, r.root, { skip: 0, limit: 0 })).rejects.toBeInstanceOf(GitInputError)
  })
})

describe('getCommitFiles', () => {
  it('lists the files of the root commit', async () => {
    const r = repo()
    const files = await getCommitFiles(runner, r.root, r.rev('HEAD'))
    expect(files).toEqual([{ path: 'file-1.txt', oldPath: null, kind: 'added' }])
  })

  it('lists a merge commit against its first parent', async () => {
    const r = repo()
    const merge = mergeCommit(r)
    const files = await getCommitFiles(runner, r.root, merge)
    expect(files).toEqual([{ path: 'feature.txt', oldPath: null, kind: 'added' }])
  })

  it('reports a rename with its old path, and a deletion', async () => {
    const r = repo()
    put(r.root, 'big.txt', BIG)
    commitAll(r, 'add big')
    r.git('mv', 'big.txt', 'moved.txt')
    r.git('rm', '-q', 'file-1.txt')
    const oid = commitAll(r, 'rename')
    const files = await getCommitFiles(runner, r.root, oid)
    expect(files).toContainEqual({ path: 'moved.txt', oldPath: 'big.txt', kind: 'renamed' })
    expect(files).toContainEqual({ path: 'file-1.txt', oldPath: null, kind: 'deleted' })
  })

  it('refuses an invalid oid', async () => {
    const r = repo()
    for (const bad of ['', 'abc', '--help', 'HEAD', 'zzzzzzz', 'a'.repeat(65), `${r.rev('HEAD')};ls`]) {
      await expect(getCommitFiles(runner, r.root, bad)).rejects.toBeInstanceOf(GitInputError)
    }
  })
})

describe('getCommitDiff', () => {
  it('shows a root commit file through git show', async () => {
    const r = repo()
    const diff = textOf(await getCommitDiff(runner, r.root, { oid: r.rev('HEAD'), path: 'file-1.txt', oldPath: null }))
    expect(diff.path).toBe('file-1.txt')
    expect(diff.hunks[0]?.lines.every((l) => l.kind === 'add')).toBe(true)
  })

  it('shows a modification against the parent', async () => {
    const r = repo()
    put(r.root, 'file-1.txt', 'changed\n')
    const oid = commitAll(r, 'edit')
    const diff = textOf(await getCommitDiff(runner, r.root, { oid, path: 'file-1.txt', oldPath: null }))
    const lines = diff.hunks.flatMap((h) => h.lines.map((l) => `${l.kind}:${l.text}`))
    expect(lines).toContain('add:changed')
    expect(lines).toContain('delete:initial commit')
  })

  it('shows a renamed file with its edits', async () => {
    const r = repo()
    const oid = renameCommit(r)
    const diff = textOf(await getCommitDiff(runner, r.root, { oid, path: 'moved.txt', oldPath: 'big.txt' }))
    expect(diff.oldPath).toBe('big.txt')
    const changed = diff.hunks.flatMap((h) => h.lines).filter((l) => l.kind !== 'context')
    expect(changed.map((l) => `${l.kind}:${l.text}`)).toEqual(['add:extra'])
  })

  it('shows a merge commit file against the first parent', async () => {
    const r = repo()
    const merge = mergeCommit(r)
    const diff = textOf(await getCommitDiff(runner, r.root, { oid: merge, path: 'feature.txt', oldPath: null }))
    expect(diff.hunks[0]?.lines[0]?.text).toBe('f')
  })

  it('answers too_large past the limit, and shows it when forced', async () => {
    const r = repo()
    put(r.root, 'huge.txt', `${'y'.repeat(99)}\n`.repeat(25_000))
    const oid = commitAll(r, 'huge')
    const small = await getCommitDiff(runner, r.root, { oid, path: 'huge.txt', oldPath: null })
    expect(small.kind).toBe('too_large')
    const forced = await getCommitDiff(runner, r.root, { oid, path: 'huge.txt', oldPath: null, force: true })
    expect(forced.kind).toBe('text')
  })

  it('refuses an invalid oid and escaping paths', async () => {
    const r = repo()
    await expect(getCommitDiff(runner, r.root, { oid: '-p', path: 'a', oldPath: null })).rejects.toBeInstanceOf(GitInputError)
    await expect(getCommitDiff(runner, r.root, { oid: r.rev('HEAD'), path: '../x', oldPath: null })).rejects.toThrow()
  })
})
