import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { createMemoryFs, type MemoryFs } from '../../test/memoryFs'
import { domainErrorOf, domainErrorOfAsync, idOf } from '../../test/repoFixtures'
import { createTempRepo, type TempRepo } from '../../test/tempRepo'
import { createGitAdapter } from './git'
import { IMPORTER_VERSION, trackedChanges, type TrackedChanges } from './gitChanges'
import type { GitDiffPaths, GitPathChange, GitPathsFailure, GitStatusPaths } from './types'

const ROOT = resolve('/repo')
const SHA_A = 'a'.repeat(40)
const SHA_B = 'b'.repeat(40)
const SHA_C = `${'c'.repeat(40)}`

function gitDirRepo(head: string): MemoryFs {
  const fs = createMemoryFs()
  fs.put(join(ROOT, '.git', 'HEAD'), head)
  return fs
}

describe('GitAdapter.head (reads files, never spawns git)', () => {
  it('reads the branch and its loose ref', () => {
    const fs = gitDirRepo('ref: refs/heads/feature/login\n')
    fs.put(join(ROOT, '.git', 'refs', 'heads', 'feature', 'login'), `${SHA_A}\n`)
    fs.put(join(ROOT, '.git', 'packed-refs'), `${SHA_B} refs/heads/feature/login\n`)
    expect(createGitAdapter(ROOT, { fs }).head()).toEqual({ branch: 'feature/login', commit: SHA_A, detached: false })
  })

  it('falls back to packed-refs, skipping comments and peeled lines', () => {
    const fs = gitDirRepo('ref: refs/heads/main\n')
    fs.put(
      join(ROOT, '.git', 'packed-refs'),
      `# pack-refs with: peeled fully-peeled sorted\n${SHA_C} refs/heads/other\n${SHA_B} refs/heads/main\n^${SHA_A}\n`
    )
    expect(createGitAdapter(ROOT, { fs }).head()).toEqual({ branch: 'main', commit: SHA_B, detached: false })
  })

  it('reports an unborn branch with a null commit', () => {
    const fs = gitDirRepo('ref: refs/heads/main\n')
    expect(createGitAdapter(ROOT, { fs }).head()).toEqual({ branch: 'main', commit: null, detached: false })
  })

  it('ignores a loose ref that is not a commit hash', () => {
    const fs = gitDirRepo('ref: refs/heads/main\n')
    fs.put(join(ROOT, '.git', 'refs', 'heads', 'main'), 'ref: refs/heads/other\n')
    expect(createGitAdapter(ROOT, { fs }).head()?.commit).toBeNull()
  })

  it('reports a detached HEAD', () => {
    const fs = gitDirRepo(`${SHA_A}\n`)
    expect(createGitAdapter(ROOT, { fs }).head()).toEqual({ branch: null, commit: SHA_A, detached: true })
  })

  it('treats unrecognized HEAD contents and hostile ref names as detached without a commit', () => {
    const heads = [
      'garbage\n',
      'ref: refs/remotes/origin/main\n',
      'ref: refs/heads/../../../etc/passwd\n',
      'ref: refs/heads/a//b\n',
      'ref: refs/heads/a\u0001b\n',
      'ref: refs/heads/a\u007fb\n',
      'ref: refs/heads/a~1\n'
    ]
    for (const head of heads) {
      expect(createGitAdapter(ROOT, { fs: gitDirRepo(head) }).head()).toEqual({ branch: null, commit: null, detached: true })
    }
  })

})

describe('GitAdapter.head for worktrees and missing metadata', () => {
  it('resolves a worktree through a relative gitdir file and its commondir', () => {
    const fs = createMemoryFs()
    const main = resolve('/main')
    const worktreeGitDir = join(main, '.git', 'worktrees', 'wt')
    fs.put(join(ROOT, '.git'), 'gitdir: ../main/.git/worktrees/wt\n')
    fs.put(join(worktreeGitDir, 'HEAD'), 'ref: refs/heads/wt-branch\n')
    fs.put(join(worktreeGitDir, 'commondir'), '../..\n')
    fs.put(join(main, '.git', 'refs', 'heads', 'wt-branch'), `${SHA_C}\n`)
    expect(createGitAdapter(ROOT, { fs }).head()).toEqual({ branch: 'wt-branch', commit: SHA_C, detached: false })
  })

  it('accepts an absolute gitdir path and packed refs in the common directory', () => {
    const fs = createMemoryFs()
    const gitDir = resolve('/elsewhere/wt-git')
    fs.put(join(ROOT, '.git'), `gitdir: ${gitDir}\n`)
    fs.put(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n')
    fs.put(join(gitDir, 'commondir'), `${resolve('/elsewhere/common')}\n`)
    fs.put(join(resolve('/elsewhere/common'), 'packed-refs'), `${SHA_B} refs/heads/main\n`)
    expect(createGitAdapter(ROOT, { fs }).head()).toEqual({ branch: 'main', commit: SHA_B, detached: false })
  })

  it('returns null outside a Git checkout or when metadata is unreadable', () => {
    expect(createGitAdapter(ROOT, { fs: createMemoryFs() }).head()).toBeNull()

    const noGitdirLine = createMemoryFs()
    noGitdirLine.put(join(ROOT, '.git'), 'not a gitdir pointer\n')
    expect(createGitAdapter(ROOT, { fs: noGitdirLine }).head()).toBeNull()

    const noHead = createMemoryFs()
    noHead.mkdirp(join(ROOT, '.git'))
    expect(createGitAdapter(ROOT, { fs: noHead }).head()).toBeNull()

    expect(createGitAdapter(ROOT, { fs: gitDirRepo('') }).head()).toBeNull()
  })
})

interface FakeRun {
  calls: string[][]
  runGit: (args: string[]) => Promise<{ code: number; stdout: string }>
}

function fakeRun(code: number, stdout: string): FakeRun {
  const calls: string[][] = []
  return {
    calls,
    runGit: async (args) => {
      calls.push(args)
      return { code, stdout }
    }
  }
}

describe('GitAdapter CLI methods', () => {
  it('counts uncommitted record files with porcelain status', async () => {
    const run = fakeRun(0, '?? .darkmechanicus/epics/x/current.json\n M .darkmechanicus/project.json\n')
    const git = createGitAdapter(ROOT, { fs: createMemoryFs(), runGit: run.runGit })
    expect(await git.countUncommitted('.darkmechanicus')).toBe(2)
    expect(run.calls).toEqual([['status', '--porcelain=v1', '-uall', '--', '.darkmechanicus']])
  })

  it('counts zero for a clean tree and null when git fails', async () => {
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(0, '').runGit }).countUncommitted('.darkmechanicus')).toBe(0)
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(128, '').runGit }).countUncommitted('.darkmechanicus')).toBeNull()
  })

  it('lists local branches and returns none when git fails', async () => {
    const run = fakeRun(0, 'main\r\nfeature/x\n')
    expect(await createGitAdapter(ROOT, { runGit: run.runGit }).listLocalBranches()).toEqual(['main', 'feature/x'])
    expect(run.calls).toEqual([['for-each-ref', '--format=%(refname:short)', 'refs/heads']])
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(1, 'main\n').runGit }).listLocalBranches()).toEqual([])
  })
})

describe('GitAdapter.listWorktrees', () => {
  it('lists worktree paths from the porcelain output, main checkout first, and none when git fails', async () => {
    const run = fakeRun(0, `worktree /repo\nHEAD ${SHA_A}\nbranch refs/heads/main\n\nworktree /repo/wt with space\nHEAD ${SHA_B}\ndetached\n`)
    expect(await createGitAdapter(ROOT, { runGit: run.runGit }).listWorktrees()).toEqual(['/repo', '/repo/wt with space'])
    expect(run.calls).toEqual([['worktree', 'list', '--porcelain']])
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(128, '').runGit }).listWorktrees()).toEqual([])
  })

  it('lists files at a ref without switching the checkout, and null when git fails', async () => {
    const run = fakeRun(0, '.darkmechanicus/epics/a/current.json\n.darkmechanicus/epics/a/state.json\n')
    const files = await createGitAdapter(ROOT, { runGit: run.runGit }).listFiles('feature/x', '.darkmechanicus/epics')
    expect(files).toEqual(['.darkmechanicus/epics/a/current.json', '.darkmechanicus/epics/a/state.json'])
    expect(run.calls).toEqual([['ls-tree', '-r', '--name-only', 'feature/x', '--', '.darkmechanicus/epics']])
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(128, 'x\n').runGit }).listFiles('gone', '.darkmechanicus')).toBeNull()
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(0, '').runGit }).listFiles('main', 'absent')).toEqual([])
  })

  it('shows a file at a ref relative to the repository root, or null when absent', async () => {
    const run = fakeRun(0, '{"a":1}\n')
    expect(await createGitAdapter(ROOT, { runGit: run.runGit }).showFile('main', '.darkmechanicus/project.json')).toBe('{"a":1}\n')
    expect(run.calls).toEqual([['show', 'main:./.darkmechanicus/project.json']])
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(128, 'fatal').runGit }).showFile('main', 'x')).toBeNull()
  })

  it('rejects option-like or NUL-containing refs and paths before running git', async () => {
    const run = fakeRun(0, '')
    const git = createGitAdapter(ROOT, { runGit: run.runGit })
    const attempts = [
      () => git.showFile('--output=/tmp/x', 'a'),
      () => git.showFile('main', '-p'),
      () => git.listFiles('main\u0000x', '.darkmechanicus'),
      () => git.listFiles('main', '--x'),
      () => git.countUncommitted('-uno')
    ]
    for (const attempt of attempts) {
      expect((await domainErrorOfAsync(attempt)).code).toBe('unsafe_path')
    }
    expect(run.calls).toEqual([])
  })
})

describe('GitAdapter with the real git binary', () => {
  let repo: TempRepo | undefined

  afterEach(() => {
    repo?.cleanup()
    repo = undefined
  })

  function git(root: string, args: string[]): string {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
    delete env['GIT_DIR']
    delete env['GIT_WORK_TREE']
    delete env['GIT_INDEX_FILE']
    const config = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false']
    return execFileSync('git', ['-C', root, ...config, ...args], { encoding: 'utf8', env })
  }

  it('reads HEAD, branches, files, contents, and uncommitted counts from a real repository', async () => {
    repo = createTempRepo()
    const root = repo.root
    git(root, ['init', '-q', '-b', 'main'])
    mkdirSync(join(root, '.darkmechanicus', 'epics'), { recursive: true })
    writeFileSync(join(root, '.darkmechanicus', 'project.json'), '{"name":"demo"}\n')
    git(root, ['add', '.'])
    git(root, ['commit', '-q', '-m', 'init'])
    git(root, ['branch', 'feature/x'])
    const commit = git(root, ['rev-parse', 'HEAD']).trim()

    const adapter = createGitAdapter(root)
    expect(adapter.head()).toEqual({ branch: 'main', commit, detached: false })
    expect((await adapter.listLocalBranches()).sort()).toEqual(['feature/x', 'main'])
    expect(await adapter.listFiles('feature/x', '.darkmechanicus')).toEqual(['.darkmechanicus/project.json'])
    expect(await adapter.showFile('feature/x', '.darkmechanicus/project.json')).toBe('{"name":"demo"}\n')
    expect(await adapter.showFile('feature/x', '.darkmechanicus/missing.json')).toBeNull()
    expect(await adapter.countUncommitted('.darkmechanicus')).toBe(0)

    writeFileSync(join(root, '.darkmechanicus', 'project.json'), '{"name":"renamed"}\n')
    writeFileSync(join(root, '.darkmechanicus', 'epics', 'new.json'), '{}\n')
    writeFileSync(join(root, 'outside.txt'), 'not counted\n')
    expect(await adapter.countUncommitted('.darkmechanicus')).toBe(2)
  })

  it('returns null counts outside a repository', async () => {
    repo = createTempRepo()
    const adapter = createGitAdapter(repo.outside)
    expect(adapter.head()).toBeNull()
    expect(await adapter.showFile('main', 'x')).toBeNull()
  })
})

interface Step {
  code: number
  stdout: string
}

/** Answers each git call with the next step and records the arguments. */
function scriptedRun(steps: Step[]): FakeRun {
  const calls: string[][] = []
  return {
    calls,
    runGit: async (args) => {
      calls.push(args)
      return steps[calls.length - 1] ?? { code: 128, stdout: '' }
    }
  }
}

describe('GitAdapter.isAncestor and commitParents (CLI answers)', () => {
  it('asks git merge-base --is-ancestor and reads its exit status: 0 yes, 1 no, anything else unknown', async () => {
    const yes = fakeRun(0, '')
    expect(await createGitAdapter(ROOT, { runGit: yes.runGit }).isAncestor(SHA_A, 'refs/heads/main')).toBe(true)
    expect(yes.calls).toEqual([['merge-base', '--is-ancestor', SHA_A, 'refs/heads/main']])
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(1, '').runGit }).isAncestor(SHA_A, SHA_B)).toBe(false)
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(128, '').runGit }).isAncestor(SHA_A, SHA_B)).toBeNull()
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(2, '').runGit }).isAncestor(SHA_A, SHA_B)).toBeNull()
  })

  it('resolves the ref to one commit, then reads its parents with rev-list, first parent first', async () => {
    const merge = scriptedRun([
      { code: 0, stdout: `${SHA_A}\n` },
      { code: 0, stdout: `${SHA_A} ${SHA_B} ${SHA_C}\n` }
    ])
    expect(await createGitAdapter(ROOT, { runGit: merge.runGit }).commitParents('abc1234')).toEqual({
      commit: SHA_A,
      parents: [SHA_B, SHA_C]
    })
    expect(merge.calls).toEqual([
      ['rev-parse', '--verify', '--quiet', 'abc1234^{commit}'],
      ['rev-list', '--parents', '-n', '1', SHA_A, '--']
    ])
    const root = scriptedRun([
      { code: 0, stdout: `${SHA_A}\r\n` },
      { code: 0, stdout: `${SHA_A}\r\n` }
    ])
    expect(await createGitAdapter(ROOT, { runGit: root.runGit }).commitParents('x')).toEqual({ commit: SHA_A, parents: [] })
  })

  it('answers null when the ref is not one commit or git prints something that is not a commit line', async () => {
    const notFound = scriptedRun([{ code: 1, stdout: '' }])
    expect(await createGitAdapter(ROOT, { runGit: notFound.runGit }).commitParents('a..b')).toBeNull()
    expect(notFound.calls).toHaveLength(1)
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(128, '').runGit }).commitParents('gone')).toBeNull()
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(0, 'not a sha\n').runGit }).commitParents('x')).toBeNull()
    const garbled = [`${SHA_A} not-a-sha\n`, `${SHA_A}\n${SHA_B}\n`, '']
    for (const stdout of garbled) {
      const run = scriptedRun([{ code: 0, stdout: `${SHA_A}\n` }, { code: 0, stdout }])
      expect(await createGitAdapter(ROOT, { runGit: run.runGit }).commitParents('x')).toBeNull()
    }
  })
})

describe('GitAdapter.mergeBase and changedPaths (CLI answers)', () => {
  it('asks git merge-base for the common ancestor and answers null for anything but one commit id', async () => {
    const found = fakeRun(0, `${SHA_C}\n`)
    expect(await createGitAdapter(ROOT, { runGit: found.runGit }).mergeBase(SHA_A, 'refs/heads/main')).toBe(SHA_C)
    expect(found.calls).toEqual([['merge-base', SHA_A, 'refs/heads/main']])
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(0, `${SHA_C}\r\n`).runGit }).mergeBase(SHA_A, SHA_B)).toBe(SHA_C)
    // Exit 1: the commits share no history. Exit 128: a name git does not know.
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(1, '').runGit }).mergeBase(SHA_A, SHA_B)).toBeNull()
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(128, '').runGit }).mergeBase(SHA_A, SHA_B)).toBeNull()
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(0, 'not a sha\n').runGit }).mergeBase(SHA_A, SHA_B)).toBeNull()
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(0, `${SHA_A}\n${SHA_B}\n`).runGit }).mergeBase(SHA_A, SHA_B)).toBeNull()
  })

  it('runs git diff --name-only --no-renames -z and splits the NUL-terminated paths verbatim', async () => {
    const run = fakeRun(0, 'docs/with space.md\u0000src/a.ts\u0000caf\u00e9 \u00fcber.txt\u0000')
    expect(await createGitAdapter(ROOT, { runGit: run.runGit }).changedPaths(SHA_A, 'refs/heads/main')).toEqual([
      'docs/with space.md',
      'src/a.ts',
      'caf\u00e9 \u00fcber.txt'
    ])
    expect(run.calls).toEqual([['diff', '--name-only', '--no-renames', '-z', SHA_A, 'refs/heads/main', '--']])
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(0, '').runGit }).changedPaths(SHA_A, SHA_B)).toEqual([])
  })

  it('answers null whenever git exits with anything but 0', async () => {
    for (const code of [1, 128, 129]) {
      const run = fakeRun(code, 'a.txt\u0000')
      expect(await createGitAdapter(ROOT, { runGit: run.runGit }).changedPaths(SHA_A, SHA_B)).toBeNull()
    }
  })
})

describe('GitAdapter ancestry queries refuse hostile refs', () => {
  it('rejects option-like or NUL-containing refs before running git', async () => {
    const run = fakeRun(0, '')
    const git = createGitAdapter(ROOT, { runGit: run.runGit })
    const attempts = [
      () => git.isAncestor('--output=/tmp/x', 'main'),
      () => git.isAncestor('main', '-p'),
      () => git.isAncestor(`${SHA_A}\u0000`, 'main'),
      () => git.commitParents('--all'),
      () => git.commitParents('main\u0000x'),
      () => git.mergeBase('--octopus', 'main'),
      () => git.mergeBase('main', `${SHA_A}\u0000`),
      () => git.changedPaths('--output=/tmp/x', 'main'),
      () => git.changedPaths('main', '-R'),
      () => git.changedPaths('main\u0000x', 'main')
    ]
    for (const attempt of attempts) {
      expect((await domainErrorOfAsync(attempt)).code).toBe('unsafe_path')
    }
    expect(run.calls).toEqual([])
  })
})

/** Every file under `.git` with its size and modification time, to prove a query left the repository alone. */
function gitDirSnapshot(root: string): string[] {
  const gitDir = join(root, '.git')
  return readdirSync(gitDir, { recursive: true, encoding: 'utf8' })
    .map((entry) => {
      const stat = statSync(join(gitDir, entry))
      return `${entry}:${stat.isDirectory() ? 'dir' : stat.size}:${stat.mtimeMs}`
    })
    .sort()
}

interface History {
  repo: GitRepo
  initial: string
  base: string
  w1: string
  w2: string
  squashed: string
  merged: string
  sideTip: string
}

/** main: initial -> base; `work` (base -> w1 -> w2) is squashed into main as `squashed`; `side` is merged as `merged`. */
function buildHistory(): History {
  const repo = createGitRepo()
  const initial = repo.rev('main')
  const base = repo.commit('base')
  repo.branch('work')
  const w1 = repo.commit('work one')
  const w2 = repo.commit('work two')
  repo.switchTo('main')
  const squashed = repo.squash('work', 'squash the work')
  repo.branch('side')
  const sideTip = repo.commit('side change')
  repo.switchTo('main')
  repo.commit('main moves on')
  const merged = repo.merge('side')
  return { repo, initial, base, w1, w2, squashed, merged, sideTip }
}

/**
 * One repository with that history, built on first use and shared by every test that asks for it. They only ask
 * read-only questions (the "ancestry queries are read-only" test pins that), so one build replaces one per test: about
 * 35 git processes each, which cost seconds on a Windows CI runner.
 */
let sharedHistory: History | undefined
afterAll(() => {
  sharedHistory?.repo.cleanup()
  sharedHistory = undefined
})
function useHistory(): () => History {
  return () => {
    sharedHistory ??= buildHistory()
    return sharedHistory
  }
}

describe('GitAdapter.isAncestor with the real git binary', () => {
  const history = useHistory()

  it('answers yes for commits on a branch and no for the commits a squash left behind', async () => {
    const { repo, initial, base, w1, w2, squashed, merged, sideTip } = history()
    const adapter = createGitAdapter(repo.root)
    const main = 'refs/heads/main'
    for (const commit of [initial, base, squashed, merged, sideTip]) {
      expect(await adapter.isAncestor(commit, main)).toBe(true)
    }
    expect(await adapter.isAncestor(squashed, squashed)).toBe(true)
    expect(await adapter.isAncestor(base, 'refs/heads/work')).toBe(true)
    expect(await adapter.isAncestor(w1, main)).toBe(false)
    expect(await adapter.isAncestor(w2, main)).toBe(false)
    expect(await adapter.isAncestor(main, w2)).toBe(false)
    expect(await adapter.isAncestor(squashed.slice(0, 9), main)).toBe(true)
  })

  it('answers null for a commit or branch the repository does not have', async () => {
    const { repo, base } = history()
    const adapter = createGitAdapter(repo.root)
    expect(await adapter.isAncestor('f'.repeat(40), 'refs/heads/main')).toBeNull()
    expect(await adapter.isAncestor(base, 'refs/heads/no-such-branch')).toBeNull()
  })
})

describe('GitAdapter.commitParents with the real git binary', () => {
  const history = useHistory()

  it('reads the parents of a squash commit, a merge commit and a root commit', async () => {
    const { repo, initial, base, w1, squashed, merged, sideTip } = history()
    const adapter = createGitAdapter(repo.root)
    expect(await adapter.commitParents(squashed)).toEqual({ commit: squashed, parents: [base] })
    expect(await adapter.commitParents(merged)).toEqual({ commit: merged, parents: [repo.rev(`${merged}^1`), sideTip] })
    expect(await adapter.commitParents(initial)).toEqual({ commit: initial, parents: [] })
    expect(await adapter.commitParents(squashed.slice(0, 10))).toEqual({ commit: squashed, parents: [base] })
    expect(await adapter.commitParents('refs/heads/work')).toMatchObject({ parents: [w1] })
  })

  it('answers null for a commit that does not exist, an unknown name and a range', async () => {
    const { repo, base } = history()
    const adapter = createGitAdapter(repo.root)
    expect(await adapter.commitParents('f'.repeat(40))).toBeNull()
    expect(await adapter.commitParents('no-such-ref')).toBeNull()
    expect(await adapter.commitParents(`${base}..refs/heads/main`)).toBeNull()
  })
})

describe('GitAdapter.mergeBase with the real git binary', () => {
  const history = useHistory()

  it('finds where a squashed branch, a merged branch and the target diverged', async () => {
    const { repo, base, w2, squashed, merged, sideTip } = history()
    const adapter = createGitAdapter(repo.root)
    expect(await adapter.mergeBase(w2, 'refs/heads/main')).toBe(base)
    expect(await adapter.mergeBase('refs/heads/work', squashed)).toBe(base)
    expect(await adapter.mergeBase(sideTip, merged)).toBe(sideTip)
    expect(await adapter.mergeBase(squashed.slice(0, 10), squashed)).toBe(squashed)
  })

  it('answers null for an unknown commit or name', async () => {
    const { repo, base } = history()
    const adapter = createGitAdapter(repo.root)
    expect(await adapter.mergeBase('f'.repeat(40), 'refs/heads/main')).toBeNull()
    expect(await adapter.mergeBase(base, 'refs/heads/no-such-branch')).toBeNull()
  })
})

describe('GitAdapter real repositories of its own', () => {
  let repo: GitRepo | undefined
  afterEach(() => {
    repo?.cleanup()
    repo = undefined
  })

  it('changedPaths lists both files a commit changed, a path with a space included, and both sides of a rename', async () => {
    repo = createGitRepo()
    const before = repo.rev('main')
    mkdirSync(join(repo.root, 'docs'))
    mkdirSync(join(repo.root, 'src'))
    writeFileSync(join(repo.root, 'docs', 'with space.md'), 'spaced\n')
    writeFileSync(join(repo.root, 'src', 'two.txt'), 'two\n')
    repo.git('add', '--', 'docs', 'src')
    repo.git('commit', '-q', '-m', 'two files')
    const after = repo.rev('main')
    const adapter = createGitAdapter(repo.root)
    expect(await adapter.changedPaths(before, after)).toEqual(['docs/with space.md', 'src/two.txt'])
    expect(await adapter.changedPaths(after, before)).toEqual(['docs/with space.md', 'src/two.txt'])
    expect(await adapter.changedPaths(after, 'refs/heads/main')).toEqual([])
    repo.git('mv', '--', 'docs/with space.md', 'docs/moved here.md')
    repo.git('commit', '-q', '-m', 'rename')
    expect(await adapter.changedPaths(after, 'refs/heads/main')).toEqual(['docs/moved here.md', 'docs/with space.md'])
  })

  it('changedPaths answers null for a commit the repository does not have', async () => {
    repo = createGitRepo()
    const adapter = createGitAdapter(repo.root)
    expect(await adapter.changedPaths('f'.repeat(40), 'refs/heads/main')).toBeNull()
    expect(await adapter.changedPaths('refs/heads/main', 'refs/heads/no-such-branch')).toBeNull()
  })

  it('mergeBase answers null for commits that share no history', async () => {
    repo = createGitRepo()
    const main = repo.commit('on main')
    repo.git('checkout', '-q', '--orphan', 'unrelated')
    const lone = repo.commit('unrelated root')
    expect(await createGitAdapter(repo.root).mergeBase(main, lone)).toBeNull()
  })
})

describe('GitAdapter ancestry queries are read-only', () => {
  const history = useHistory()

  it('leave every file under .git, the working tree status and the refs exactly as they were', async () => {
    const { repo, base, w1, squashed, merged } = history()
    // `git status` refreshes the index itself, so take the baseline after it has run once.
    const status = repo.git('status', '--porcelain')
    const refs = repo.git('for-each-ref')
    const before = gitDirSnapshot(repo.root)
    const adapter = createGitAdapter(repo.root)
    await adapter.isAncestor(w1, 'refs/heads/main')
    await adapter.isAncestor(base, 'refs/heads/main')
    await adapter.commitParents(squashed)
    await adapter.commitParents(merged)
    await adapter.commitParents('f'.repeat(40))
    const squashedPaths = await adapter.changedPaths(base, squashed)
    expect(squashedPaths).toHaveLength(2)
    expect(await adapter.changedPaths(base, 'refs/heads/work')).toEqual(squashedPaths)
    await adapter.mergeBase('refs/heads/work', 'refs/heads/main')
    await adapter.changedPaths('f'.repeat(40), 'refs/heads/main')
    expect(gitDirSnapshot(repo.root)).toEqual(before)
    expect(repo.git('status', '--porcelain')).toBe(status)
    expect(repo.git('for-each-ref')).toBe(refs)
  })
})

describe('GitAdapter.branchCommit', () => {
  let repo: GitRepo | undefined
  afterEach(() => {
    repo?.cleanup()
    repo = undefined
  })

  it('answers the commit an existing local branch points at, not HEAD', () => {
    repo = createGitRepo()
    const initial = repo.rev('HEAD')
    repo.branch('epic/x')
    const tip = repo.commit('on the epic branch')
    repo.switchTo('main')
    const adapter = createGitAdapter(repo.root)
    expect(adapter.branchCommit('epic/x')).toBe(tip)
    expect(adapter.branchCommit('main')).toBe(initial)
  })

  it('answers null for a branch the repository does not have, a tag or a commit id', () => {
    repo = createGitRepo()
    const initial = repo.rev('HEAD')
    repo.git('-c', 'tag.gpgSign=false', 'tag', '-a', '-m', 'v1', 'v1')
    const adapter = createGitAdapter(repo.root)
    expect(adapter.branchCommit('epic/missing')).toBeNull()
    expect(adapter.branchCommit('v1')).toBeNull()
    expect(adapter.branchCommit(initial)).toBeNull()
  })
})

describe('GitAdapter.branchCommit (CLI answers and hostile names)', () => {
  it('asks rev-parse for exactly refs/heads/<name> as one commit', () => {
    const calls: string[][] = []
    const runGitSync = (args: string[]): Step => {
      calls.push(args)
      return { code: 0, stdout: `${SHA_A}\n` }
    }
    expect(createGitAdapter(ROOT, { runGitSync }).branchCommit('epic/x')).toBe(SHA_A)
    expect(calls).toEqual([['rev-parse', '--verify', '--quiet', 'refs/heads/epic/x^{commit}']])
    expect(createGitAdapter(ROOT, { runGitSync: () => ({ code: 1, stdout: '' }) }).branchCommit('epic/x')).toBeNull()
    expect(createGitAdapter(ROOT, { runGitSync: () => ({ code: 0, stdout: 'garbage\n' }) }).branchCommit('epic/x')).toBeNull()
  })

  it('reads the branch ref from the files when git cannot run, never taking an existing branch for a missing one', () => {
    const fs = gitDirRepo('ref: refs/heads/main\n')
    fs.put(join(ROOT, '.git', 'packed-refs'), `${SHA_B} refs/heads/epic/x\n`)
    const broken = createGitAdapter(ROOT, { fs, runGitSync: () => ({ code: 128, stdout: '' }) })
    expect(broken.branchCommit('epic/x')).toBe(SHA_B)
    expect(broken.branchCommit('epic/missing')).toBeNull()
    expect(broken.branchCommit('a..b')).toBeNull()
    // Exit status 1 is git's clean "no such branch": the files are not consulted.
    expect(createGitAdapter(ROOT, { fs, runGitSync: () => ({ code: 1, stdout: '' }) }).branchCommit('epic/x')).toBeNull()
  })

  it('refuses a name with a leading dash or a NUL with unsafe_path before running git', () => {
    const calls: string[][] = []
    const runGitSync = (args: string[]): Step => {
      calls.push(args)
      return { code: 0, stdout: `${SHA_A}\n` }
    }
    const adapter = createGitAdapter(ROOT, { runGitSync })
    expect(domainErrorOf(() => adapter.branchCommit('--all')).code).toBe('unsafe_path')
    expect(domainErrorOf(() => adapter.branchCommit('-x')).code).toBe('unsafe_path')
    expect(domainErrorOf(() => adapter.branchCommit('main\u0000x')).code).toBe('unsafe_path')
    expect(calls).toEqual([])
  })
})

/** Answers `rev-parse` (in `.darkmechanicus/`) and `status`/`diff` with the given outputs, recording every call. */
function routedRun(answers: { revParse?: Step; status?: Step; diff?: Step }): { calls: string[][]; runGitSync: (args: string[]) => Step } {
  const calls: string[][] = []
  return {
    calls,
    runGitSync: (args) => {
      calls.push(args)
      const command = args[3] ?? ''
      const answer = command === 'rev-parse' ? answers.revParse : command === 'status' ? answers.status : command === 'diff' ? answers.diff : undefined
      return answer ?? { code: 128, stdout: '' }
    }
  }
}

const NUL = '\u0000'
const ORDINARY = '100644 100644 100644 1111111111111111111111111111111111111111 2222222222222222222222222222222222222222'
const IN_PROJECT = { code: 0, stdout: 'true\nM/.darkmechanicus/\n' }

/** A memory filesystem whose root holds `.git`, so a failed git command reads as `git_failed`. */
function repoFs(): MemoryFs {
  const fs = createMemoryFs()
  fs.mkdirp(join(ROOT, '.git'))
  return fs
}

describe('GitAdapter.diffPaths (CLI answers)', () => {
  it('runs diff in .darkmechanicus/ without renames or optional locks, relative to that folder', async () => {
    const run = routedRun({ diff: { code: 0, stdout: `M${NUL}epics/e/state.json${NUL}A${NUL}kanban/k/card.json${NUL}D${NUL}profiles/a b.json${NUL}` } })
    const adapter = createGitAdapter(ROOT, { fs: createMemoryFs(), runGitSync: run.runGitSync })
    expect(await adapter.diffPaths(SHA_A, SHA_B)).toEqual({
      ok: true,
      paths: [
        { status: 'M', path: 'epics/e/state.json' },
        { status: 'A', path: 'kanban/k/card.json' },
        { status: 'D', path: 'profiles/a b.json' }
      ]
    })
    expect(run.calls).toEqual([
      ['--no-optional-locks', '-C', '.darkmechanicus', 'diff', '--name-status', '-z', '--no-renames', '--no-color', '--relative', SHA_A, SHA_B, '--', '.']
    ])
    expect(await createGitAdapter(ROOT, { runGitSync: routedRun({ diff: { code: 0, stdout: '' } }).runGitSync }).diffPaths(SHA_A, SHA_A)).toEqual({ ok: true, paths: [] })
  })

  it('fails with git_failed, never throwing, for a failed command or output it cannot read', async () => {
    for (const diff of [{ code: 128, stdout: '' }, { code: 0, stdout: `M${NUL}` }, { code: 0, stdout: `R100${NUL}a${NUL}b${NUL}` }, { code: 0, stdout: `M${NUL}${NUL}` }, { code: 0, stdout: 'M\ta' }]) {
      expect(await createGitAdapter(ROOT, { fs: repoFs(), runGitSync: routedRun({ diff }).runGitSync }).diffPaths(SHA_A, SHA_B)).toEqual({ ok: false, reason: 'git_failed' })
    }
  })

  it('refuses option-like or NUL-containing refs with unsafe_path before running git', () => {
    const run = routedRun({ diff: { code: 0, stdout: '' } })
    const adapter = createGitAdapter(ROOT, { runGitSync: run.runGitSync })
    expect(domainErrorOf(() => adapter.diffPaths('--output=x', SHA_B)).code).toBe('unsafe_path')
    expect(domainErrorOf(() => adapter.diffPaths(SHA_A, `${SHA_B}\u0000`)).code).toBe('unsafe_path')
    expect(run.calls).toEqual([])
  })
})

describe('GitAdapter.statusPaths (CLI answers)', () => {
  it('parses porcelain v2 status: HEAD, branch, ordinary, renamed, unmerged, untracked and ignored entries, below the prefix', async () => {
    const status = [
      `# branch.oid ${SHA_C}`,
      '# branch.head main',
      '# branch.upstream origin/main',
      `1 .M N... ${ORDINARY} M/.darkmechanicus/epics/e/state.json`,
      `2 R. N... ${ORDINARY} R100 M/.darkmechanicus/profiles/new name.json`,
      'M/.darkmechanicus/profiles/old.json',
      `u UU N... 100644 100644 100644 100644 ${SHA_A} ${SHA_B} ${SHA_C} M/.darkmechanicus/kanban/k/card.json`,
      '? M/.darkmechanicus/history/r/run.json',
      '! M/.darkmechanicus/local/',
      ''
    ].join(NUL)
    const run = routedRun({ revParse: IN_PROJECT, status: { code: 0, stdout: status } })
    expect(await createGitAdapter(ROOT, { runGitSync: run.runGitSync }).statusPaths()).toEqual({
      ok: true,
      head: SHA_C,
      branch: 'main',
      paths: [
        { status: '.M', path: 'epics/e/state.json' },
        { status: 'R.', path: 'profiles/new name.json' },
        { status: 'R.', path: 'profiles/old.json' },
        { status: 'UU', path: 'kanban/k/card.json' },
        { status: '?', path: 'history/r/run.json' },
        { status: '!', path: 'local/' }
      ]
    })
    expect(run.calls).toEqual([
      ['--no-optional-locks', '-C', '.darkmechanicus', 'rev-parse', '--is-inside-work-tree', '--show-prefix'],
      ['--no-optional-locks', '-C', '.darkmechanicus', 'status', '--porcelain=v2', '-z', '--branch', '--no-renames', '-uall', '--ignored=matching', '--', '.']
    ])
  })

  it('reports an unborn HEAD as a null head and a detached HEAD as a null branch', async () => {
    const unborn = routedRun({ revParse: { code: 0, stdout: 'true\n\n' }, status: { code: 0, stdout: `# branch.oid (initial)${NUL}# branch.head main${NUL}? .darkmechanicus/x${NUL}` } })
    expect(await createGitAdapter(ROOT, { runGitSync: unborn.runGitSync }).statusPaths()).toEqual({ ok: true, head: null, branch: 'main', paths: [{ status: '?', path: '.darkmechanicus/x' }] })
    const detached = routedRun({ revParse: IN_PROJECT, status: { code: 0, stdout: `# branch.oid ${SHA_A}${NUL}# branch.head (detached)${NUL}` } })
    expect(await createGitAdapter(ROOT, { runGitSync: detached.runGitSync }).statusPaths()).toEqual({ ok: true, head: SHA_A, branch: null, paths: [] })
  })
})

describe('GitAdapter.statusPaths failures (CLI answers)', () => {
  it('fails with git_failed, never throwing, for a failed command or output it cannot read', async () => {
    const head = `# branch.oid ${SHA_A}${NUL}# branch.head main${NUL}`
    const badStatuses = [
      { code: 128, stdout: '' },
      { code: 0, stdout: `${head}1 .M N... short${NUL}` },
      { code: 0, stdout: `${head}X what${NUL}` },
      { code: 0, stdout: `${head}2 R. N... ${ORDINARY} R100 M/.darkmechanicus/a${NUL}` },
      { code: 0, stdout: `${head}1 .M N... ${ORDINARY} Other/project/file${NUL}` },
      { code: 0, stdout: `${head}? M/.darkmechanicus/${NUL}` },
      { code: 0, stdout: `# branch.oid nonsense${NUL}# branch.head main${NUL}` },
      { code: 0, stdout: `# branch.oid ${SHA_A}${NUL}# branch.head bad..name${NUL}` },
      { code: 0, stdout: `# branch.oid ${SHA_A}${NUL}` },
      { code: 0, stdout: `? M/.darkmechanicus/a${NUL}` },
      { code: 0, stdout: `${head}? M/.darkmechanicus/a` }
    ]
    for (const status of badStatuses) {
      expect(await createGitAdapter(ROOT, { fs: repoFs(), runGitSync: routedRun({ revParse: IN_PROJECT, status }).runGitSync }).statusPaths()).toEqual({ ok: false, reason: 'git_failed' })
    }
    expect(await createGitAdapter(ROOT, { fs: repoFs(), runGitSync: routedRun({ status: { code: 0, stdout: head } }).runGitSync }).statusPaths()).toEqual({ ok: false, reason: 'git_failed' })
  })

  it('fails with not_work_tree when git says so, or when no folder above holds a repository', async () => {
    const outside = routedRun({ revParse: { code: 0, stdout: 'false\n' }, status: { code: 0, stdout: '' } })
    expect(await createGitAdapter(ROOT, { runGitSync: outside.runGitSync }).statusPaths()).toEqual({ ok: false, reason: 'not_work_tree' })
    const noRepository = createMemoryFs()
    expect(await createGitAdapter(ROOT, { fs: noRepository, runGitSync: routedRun({}).runGitSync }).statusPaths()).toEqual({ ok: false, reason: 'not_work_tree' })
    expect(await createGitAdapter(ROOT, { fs: noRepository, runGitSync: routedRun({}).runGitSync }).diffPaths(SHA_A, SHA_B)).toEqual({ ok: false, reason: 'not_work_tree' })
  })
})

const EPIC = idOf('epic', 1)
const EPIC_2 = idOf('epic', 2)
const RUN = idOf('run', 1)
const CARD = idOf('kanbanCard', 1)
const NEW_CARD = idOf('kanbanCard', 2)
/** The member folder below the parent repository's root, like `Forge-World-davgor/DarkMechanicus`. */
const MEMBER = join('Forge Wörld', 'Member')

/** Temporary repositories the current test made; removed after it. */
const scratch: { cleanup(): void }[] = []
afterEach(() => {
  for (const made of scratch.splice(0)) made.cleanup()
})

interface NestedProject {
  repo: GitRepo
  /** The project folder, two levels below the repository root. */
  member: string
  /** Writes a file below `.darkmechanicus/`. */
  put(path: string, text: string): void
  remove(path: string): void
  /** `git mv` of a file below `.darkmechanicus/` (staged). */
  move(from: string, to: string): void
  /** Commits every change in the repository; returns the new commit. */
  commit(message: string): string
  /** The commit holding the initial records. */
  c1: string
}

/** A parent repository with a project nested two levels down, its records (one epic, run, card and profile) committed as `c1`. */
function nestedProject(): NestedProject {
  const repo = createGitRepo()
  scratch.push(repo)
  const member = join(repo.root, MEMBER)
  const dmPath = (path: string): string => join(member, '.darkmechanicus', path)
  const put = (path: string, text: string): void => {
    mkdirSync(dirname(dmPath(path)), { recursive: true })
    writeFileSync(dmPath(path), text)
  }
  const commit = (message: string): string => {
    repo.git('add', '-A')
    repo.git('commit', '-q', '-m', message)
    return repo.rev('HEAD')
  }
  const records: Record<string, string> = {
    '.gitignore': 'local/\n', 'project.json': '{}\n', [`epics/${EPIC}/state.json`]: '{"v":1}\n', [`epics/${EPIC_2}/state.json`]: '{"v":1}\n',
    [`history/${RUN}/run.json`]: '{}\n', [`kanban/${CARD}/card.json`]: '{}\n', 'profiles/old-name.json': '{}\n', 'local/state.sqlite': 'db'
  }
  for (const [path, text] of Object.entries(records)) put(path, text)
  return {
    repo, member, put, commit,
    remove: (path) => rmSync(dmPath(path)),
    move: (from, to) => repo.git('mv', '--', join(MEMBER, '.darkmechanicus', from), join(MEMBER, '.darkmechanicus', to)),
    c1: commit('records')
  }
}

/** `trackedChanges` for a marker at `base` with nothing dirty, last reconciled on `main`. */
function changesSince(base: string, status: GitStatusPaths, git: { isAncestor?: boolean | null; diff?: GitDiffPaths | null } = {}): TrackedChanges {
  const marker = { baseCommit: base, importerVersion: IMPORTER_VERSION, dirtyPaths: [] }
  return trackedChanges({ marker, status, recordedBranch: 'main', isAncestor: git.isAncestor ?? null, diff: git.diff ?? null })
}

function sortedPaths(result: GitDiffPaths | GitStatusPaths): GitPathChange[] | GitPathsFailure {
  return result.ok ? [...result.paths].sort((a, b) => a.path.localeCompare(b.path)) : result.reason
}

const UNTRACKED_CARD = [{ status: '?', path: `kanban/${NEW_CARD}/card.json` }, { status: '!', path: 'local/' }]

describe('GitAdapter.diffPaths with the real git binary', () => {
  it('reports committed modify, add, delete and rename relative to .darkmechanicus/, and trackedChanges targets them', async () => {
    const project = nestedProject()
    project.put(`epics/${EPIC}/state.json`, '{"v":2}\n')
    project.put(`kanban/${NEW_CARD}/card.json`, '{}\n')
    project.remove(`history/${RUN}/run.json`)
    project.move('profiles/old-name.json', 'profiles/new-name.json')
    const c2 = project.commit('changes')
    const adapter = createGitAdapter(project.member)
    const diff = await adapter.diffPaths(project.c1, c2)
    expect(sortedPaths(diff)).toEqual([
      { status: 'M', path: `epics/${EPIC}/state.json` },
      { status: 'D', path: `history/${RUN}/run.json` },
      { status: 'A', path: `kanban/${NEW_CARD}/card.json` },
      { status: 'A', path: 'profiles/new-name.json' },
      { status: 'D', path: 'profiles/old-name.json' }
    ])
    const status = await adapter.statusPaths()
    expect(status).toEqual({ ok: true, head: c2, branch: 'main', paths: [{ status: '!', path: 'local/' }] })
    expect(changesSince(project.c1, status, { isAncestor: await adapter.isAncestor(project.c1, c2), diff })).toEqual({
      kind: 'targeted', epics: new Set([EPIC]), runs: new Set([RUN]), kanbanCards: new Set([NEW_CARD]),
      profiles: new Set(['new-name', 'old-name']), projectObservations: false, recoveredAttachments: false
    })
  })

  it('targets exactly the one epic whose state.json changed in C2', async () => {
    const project = nestedProject()
    project.put(`epics/${EPIC_2}/state.json`, '{"v":2}\n')
    const c2 = project.commit('one epic')
    const diff = await createGitAdapter(project.member).diffPaths(project.c1, c2)
    expect(diff).toEqual({ ok: true, paths: [{ status: 'M', path: `epics/${EPIC_2}/state.json` }] })
    expect(changesSince(project.c1, { ok: true, head: c2, branch: 'main', paths: [] }, { isAncestor: true, diff })).toMatchObject({
      kind: 'targeted', epics: new Set([EPIC_2]), runs: new Set(), kanbanCards: new Set(), profiles: new Set()
    })
  })

  it('fails with git_failed for a commit the repository does not have', async () => {
    const project = nestedProject()
    expect(await createGitAdapter(project.member).diffPaths('f'.repeat(40), project.c1)).toEqual({ ok: false, reason: 'git_failed' })
  })
})

describe('GitAdapter.statusPaths with the real git binary', () => {
  it('reports working-tree modify, staged add, delete, staged rename and untracked files, never the parent repository’s files', async () => {
    const project = nestedProject()
    writeFileSync(join(project.repo.root, 'outside.txt'), 'not a record\n')
    project.put(`epics/${EPIC}/state.json`, '{"v":3}\n')
    project.put(`epics/${EPIC_2}/comments/${idOf('comment', 1)}.json`, '{}\n')
    project.repo.git('add', '--', join(MEMBER, '.darkmechanicus', 'epics', EPIC_2))
    project.remove(`history/${RUN}/run.json`)
    project.move('profiles/old-name.json', 'profiles/new-name.json')
    project.put(`kanban/${NEW_CARD}/card.json`, '{}\n')
    project.put(`kanban/${NEW_CARD}/events/${idOf('kanbanEvent', 1)}.json`, '{}\n')
    const status = await createGitAdapter(project.member).statusPaths()
    expect(status.ok && status.head).toBe(project.c1)
    expect(sortedPaths(status)).toEqual([
      { status: '.M', path: `epics/${EPIC}/state.json` },
      { status: 'A.', path: `epics/${EPIC_2}/comments/${idOf('comment', 1)}.json` },
      { status: '.D', path: `history/${RUN}/run.json` },
      { status: '?', path: `kanban/${NEW_CARD}/card.json` },
      { status: '?', path: `kanban/${NEW_CARD}/events/${idOf('kanbanEvent', 1)}.json` },
      { status: '!', path: 'local/' },
      { status: 'A.', path: 'profiles/new-name.json' },
      { status: 'D.', path: 'profiles/old-name.json' }
    ])
    expect(changesSince(project.c1, status)).toEqual({
      kind: 'targeted', epics: new Set([EPIC, EPIC_2]), runs: new Set([RUN]), kanbanCards: new Set([NEW_CARD]),
      profiles: new Set(['new-name', 'old-name']), projectObservations: false, recoveredAttachments: false
    })
  })

  it('targets an untracked new Kanban card in a project nested two levels inside its parent repository', async () => {
    const project = nestedProject()
    project.put(`kanban/${NEW_CARD}/card.json`, '{}\n')
    const status = await createGitAdapter(project.member).statusPaths()
    expect(status).toEqual({ ok: true, head: project.c1, branch: 'main', paths: UNTRACKED_CARD })
    expect(changesSince(project.c1, status)).toMatchObject({ kind: 'targeted', epics: new Set(), kanbanCards: new Set([NEW_CARD]) })
  })

  it.runIf(process.platform === 'win32')('reports the same relative paths when the project folder is opened with another letter case (Windows)', async () => {
    const project = nestedProject()
    project.put(`kanban/${NEW_CARD}/card.json`, '{}\n')
    const respelled = join(project.repo.root, 'FORGE WÖRLD', 'member')
    expect(await createGitAdapter(respelled).statusPaths()).toEqual({ ok: true, head: project.c1, branch: 'main', paths: UNTRACKED_CARD })
  })
})

describe('GitAdapter.diffPaths and statusPaths outside the nested layout', () => {
  it('work for a project at the repository root too', async () => {
    const repo = createGitRepo()
    scratch.push(repo)
    mkdirSync(join(repo.root, '.darkmechanicus', 'epics', EPIC), { recursive: true })
    writeFileSync(join(repo.root, '.darkmechanicus', 'epics', EPIC, 'state.json'), '{}\n')
    const c1 = repo.rev('HEAD')
    repo.git('add', '-A')
    repo.git('commit', '-q', '-m', 'record')
    const c2 = repo.rev('HEAD')
    const adapter = createGitAdapter(repo.root)
    expect(await adapter.diffPaths(c1, c2)).toEqual({ ok: true, paths: [{ status: 'A', path: `epics/${EPIC}/state.json` }] })
    writeFileSync(join(repo.root, '.darkmechanicus', 'project.json'), '{}\n')
    const status = await adapter.statusPaths()
    expect(status).toEqual({ ok: true, head: c2, branch: 'main', paths: [{ status: '?', path: 'project.json' }] })
    expect(changesSince(c2, status)).toEqual({ kind: 'full', reason: 'project_record' })
  })

  it('report an unborn HEAD as a null head', async () => {
    const unborn = createTempRepo()
    scratch.push(unborn)
    execFileSync('git', ['-C', unborn.root, 'init', '-q', '-b', 'main'], { stdio: 'ignore' })
    mkdirSync(join(unborn.root, '.darkmechanicus'))
    writeFileSync(join(unborn.root, '.darkmechanicus', 'project.json'), '{}\n')
    expect(await createGitAdapter(unborn.root).statusPaths()).toEqual({ ok: true, head: null, branch: 'main', paths: [{ status: '?', path: 'project.json' }] })
  })

  it('fail with not_work_tree outside any repository', async () => {
    const plain = createTempRepo()
    scratch.push(plain)
    mkdirSync(join(plain.root, '.darkmechanicus'))
    const adapter = createGitAdapter(plain.root)
    expect(await adapter.statusPaths()).toEqual({ ok: false, reason: 'not_work_tree' })
    expect(await adapter.diffPaths(SHA_A, SHA_B)).toEqual({ ok: false, reason: 'not_work_tree' })
  })
})

describe('trackedChanges after a history rewrite, with the real git binary', () => {
  it('returns full with not_ancestor when the stored commit was rewritten out of the history', async () => {
    const project = nestedProject()
    project.put(`epics/${EPIC}/state.json`, '{"v":2}\n')
    const stored = project.commit('imported, then force-pushed away')
    project.repo.git('reset', '-q', '--hard', project.c1)
    project.put(`epics/${EPIC_2}/state.json`, '{"v":9}\n')
    const rewritten = project.commit('rewritten history')
    const adapter = createGitAdapter(project.member)
    const status = await adapter.statusPaths()
    expect(status.ok && status.head).toBe(rewritten)
    const isAncestor = await adapter.isAncestor(stored, rewritten)
    expect(isAncestor).toBe(false)
    expect(changesSince(stored, status, { isAncestor, diff: await adapter.diffPaths(stored, rewritten) })).toEqual({ kind: 'full', reason: 'not_ancestor' })
  })
})

describe('GitAdapter.diffPaths and statusPaths are read-only', () => {
  it('never write the index: .git/index bytes are identical even when a plain git status would refresh it', async () => {
    const project = nestedProject()
    project.put(`epics/${EPIC}/state.json`, '{"v":2}\n')
    const c2 = project.commit('second')
    // Same content, new modification time: the index entry is stale, so a refreshing status would rewrite the index.
    const touched = join(project.member, '.darkmechanicus', 'kanban', CARD, 'card.json')
    const later = new Date(Date.now() + 60_000)
    utimesSync(touched, later, later)
    project.put(`kanban/${NEW_CARD}/card.json`, '{}\n')
    const indexFile = join(project.repo.root, '.git', 'index')
    const before = readFileSync(indexFile)
    const files = gitDirSnapshot(project.repo.root)
    const adapter = createGitAdapter(project.member)
    await adapter.statusPaths()
    await adapter.diffPaths(project.c1, c2)
    await adapter.statusPaths()
    expect(readFileSync(indexFile).equals(before)).toBe(true)
    expect(gitDirSnapshot(project.repo.root)).toEqual(files)
    // The check can see a write: an ordinary status refreshes the stale entry and rewrites the index.
    project.repo.git('status', '--porcelain')
    expect(readFileSync(indexFile).equals(before)).toBe(false)
  })
})
