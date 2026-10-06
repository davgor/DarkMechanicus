import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { classifyGitFailure, GitError } from './errors'

const ENV: Record<string, string | undefined> = {
  ...process.env,
  LC_ALL: 'C',
  LANGUAGE: 'en',
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1'
}
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) {
  delete ENV[key]
}

/** Runs real git and classifies whatever it printed. */
function realFailure(cwd: string, args: string[]): GitError {
  const out = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@e.x', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: ENV as NodeJS.ProcessEnv,
    encoding: 'utf8'
  })
  expect(out.status, `git ${args.join(' ')} should fail`).not.toBe(0)
  return classifyGitFailure({ code: out.status ?? 1, stdout: out.stdout, stderr: out.stderr }, args)
}

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

describe('classifyGitFailure against real git output', () => {
  it('not_repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-norepo-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const error = realFailure(dir, ['status'])
    expect(error.code).toBe('not_repository')
    expect(error.detail).toContain('not a git repository')
  })

  it('nothing_to_commit', () => {
    const r = repo()
    expect(realFailure(r.root, ['commit', '-m', 'x']).code).toBe('nothing_to_commit')
  })

  it('branch_exists', () => {
    const r = repo()
    expect(realFailure(r.root, ['branch', 'main']).code).toBe('branch_exists')
  })

  it('branch_not_fully_merged', () => {
    const r = repo()
    r.branch('topic')
    r.commit('topic work')
    r.switchTo('main')
    expect(realFailure(r.root, ['branch', '-d', 'topic']).code).toBe('branch_not_fully_merged')
  })

})

describe('classifyGitFailure against real git output (working tree)', () => {
  it('local_changes_would_be_overwritten', () => {
    const r = repo()
    r.branch('other')
    writeFileSync(join(r.root, 'file-1.txt'), 'other\n')
    r.git('add', 'file-1.txt')
    r.git('commit', '-q', '-m', 'other change')
    r.switchTo('main')
    writeFileSync(join(r.root, 'file-1.txt'), 'dirty\n')
    expect(realFailure(r.root, ['checkout', 'other']).code).toBe('local_changes_would_be_overwritten')
  })

  it('merge_conflicts and operation_in_progress', () => {
    const r = repo()
    r.branch('left')
    writeFileSync(join(r.root, 'c.txt'), 'left\n')
    r.git('add', 'c.txt')
    r.git('commit', '-q', '-m', 'left')
    r.switchTo('main')
    writeFileSync(join(r.root, 'c.txt'), 'main\n')
    r.git('add', 'c.txt')
    r.git('commit', '-q', '-m', 'main')
    expect(realFailure(r.root, ['merge', 'left']).code).toBe('merge_conflicts')
    expect(realFailure(r.root, ['merge', 'left']).code).toBe('operation_in_progress')
  })

  it('index_locked', () => {
    const r = repo()
    writeFileSync(join(r.root, '.git', 'index.lock'), '')
    writeFileSync(join(r.root, 'n.txt'), 'n\n')
    expect(realFailure(r.root, ['add', 'n.txt']).code).toBe('index_locked')
  })

})

describe('classifyGitFailure against real git output (remotes)', () => {
  it('remote_not_found', () => {
    const r = repo()
    expect(realFailure(r.root, ['fetch', 'nowhere']).code).toBe('remote_not_found')
    expect(realFailure(r.root, ['remote', 'show', 'nowhere']).code).toBe('remote_not_found')
  })

  it('network_unreachable (connection refused on a local port)', () => {
    const r = repo()
    expect(realFailure(r.root, ['fetch', 'http://127.0.0.1:1/none.git']).code).toBe('network_unreachable')
  })

  it('rejected_non_fast_forward (push to a local bare repository)', () => {
    const r = repo()
    const bare = mkdtempSync(join(tmpdir(), 'dm-bare-'))
    cleanups.push(() => rmSync(bare, { recursive: true, force: true }))
    const remote = join(bare, 'x.git')
    mkdirSync(remote)
    spawnSync('git', ['init', '-q', '--bare', remote], { env: ENV as NodeJS.ProcessEnv })
    r.git('remote', 'add', 'origin', remote)
    const base = r.rev('HEAD')
    r.commit('second')
    r.git('push', '-q', 'origin', 'main')
    r.git('reset', '-q', '--hard', base)
    r.commit('diverged')
    expect(realFailure(r.root, ['push', 'origin', 'main']).code).toBe('rejected_non_fast_forward')
  })
})

describe('classifyGitFailure from text (cannot be produced offline)', () => {
  const fake = (stderr: string, stdout = ''): GitError => classifyGitFailure({ code: 128, stdout, stderr }, ['push'])

  it('auth_required', () => {
    expect(fake("fatal: could not read Username for 'https://example.com': terminal prompts disabled").code).toBe('auth_required')
  })

  it('auth_failed', () => {
    expect(fake("remote: Invalid username or password.\nfatal: Authentication failed for 'https://example.com/a.git/'").code).toBe('auth_failed')
    expect(fake('git@example.com: Permission denied (publickey).').code).toBe('auth_failed')
  })

  it('anything unknown is git_failed, with the stderr tail as detail', () => {
    const error = fake(`${'x'.repeat(5000)}END`)
    expect(error).toBeInstanceOf(GitError)
    expect(error.code).toBe('git_failed')
    expect(error.detail).toHaveLength(2000)
    expect(error.detail.endsWith('END')).toBe(true)
  })
})
