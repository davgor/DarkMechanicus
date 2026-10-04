import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { createMemoryFs, type MemoryFs } from '../../test/memoryFs'
import { domainErrorOfAsync } from '../../test/repoFixtures'
import { createTempRepo, type TempRepo } from '../../test/tempRepo'
import { createGitAdapter } from './git'

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

  it('lists files at a ref without switching the checkout', async () => {
    const run = fakeRun(0, '.darkmechanicus/epics/a/current.json\n.darkmechanicus/epics/a/state.json\n')
    const files = await createGitAdapter(ROOT, { runGit: run.runGit }).listFiles('feature/x', '.darkmechanicus/epics')
    expect(files).toEqual(['.darkmechanicus/epics/a/current.json', '.darkmechanicus/epics/a/state.json'])
    expect(run.calls).toEqual([['ls-tree', '-r', '--name-only', 'feature/x', '--', '.darkmechanicus/epics']])
    expect(await createGitAdapter(ROOT, { runGit: fakeRun(128, 'x\n').runGit }).listFiles('gone', '.darkmechanicus')).toEqual([])
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

describe('GitAdapter ancestry queries refuse hostile refs', () => {
  it('rejects option-like or NUL-containing refs before running git', async () => {
    const run = fakeRun(0, '')
    const git = createGitAdapter(ROOT, { runGit: run.runGit })
    const attempts = [
      () => git.isAncestor('--output=/tmp/x', 'main'),
      () => git.isAncestor('main', '-p'),
      () => git.isAncestor(`${SHA_A}\u0000`, 'main'),
      () => git.commitParents('--all'),
      () => git.commitParents('main\u0000x')
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

/** A fresh repository with that history for every test of the surrounding describe. */
function useHistory(): () => History {
  let current: History | undefined
  afterEach(() => {
    current?.repo.cleanup()
    current = undefined
  })
  return () => {
    current ??= buildHistory()
    return current
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
    expect(gitDirSnapshot(repo.root)).toEqual(before)
    expect(repo.git('status', '--porcelain')).toBe(status)
    expect(repo.git('for-each-ref')).toBe(refs)
  })
})
