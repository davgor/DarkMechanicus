import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
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
    for (const head of ['garbage\n', 'ref: refs/remotes/origin/main\n', 'ref: refs/heads/../../../etc/passwd\n']) {
      expect(createGitAdapter(ROOT, { fs: gitDirRepo(head) }).head()).toEqual({ branch: null, commit: null, detached: true })
    }
  })

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
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' }
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
