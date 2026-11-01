/** How a clone authenticates and which transports git may use, with a stand-in for the network command. */
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cloneRig, type CloneRig, type CloneRigOptions } from '../../test/cloneRig'
import { isolateGitConfig } from '../../test/gitRemotes'
import { GitError, GitInputError } from './errors'
import { createGitRunner, type GitRunner, type GitRunRequest } from './runner'

const LOGIN = 'octo-cat'
const TOKEN = 'gho_FAKE_TOKEN_never_leak_123'
const signedIn = { getAccount: () => ({ login: LOGIN }), getToken: () => TOKEN }

const cleanups: Array<() => void> = []
beforeEach(() => isolateGitConfig(cleanups))
afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

const rig = (options: CloneRigOptions = {}): CloneRig => cloneRig(cleanups, options)

/** Real git, except that `git clone` is recorded and then ends as `outcome` says (git is gone either way). */
function standIn(outcome: (request: GitRunRequest) => Promise<void> = async () => undefined): { runner: GitRunner; clones: GitRunRequest[] } {
  const real = createGitRunner()
  const clones: GitRunRequest[] = []
  const runner: GitRunner = {
    run: async (request) => {
      if (request.kind !== 'network') {
        return real.run(request)
      }
      clones.push(request)
      try {
        await outcome(request)
        return { code: 0, stdout: '', stderr: '' }
      } finally {
        request.onExit?.()
      }
    }
  }
  return { runner, clones }
}

describe('clone credentials', () => {
  it('signed in, an HTTPS GitHub URL (owner/repo too) uses the account, with git limited to https and ssh', async () => {
    const { runner, clones } = standIn()
    const r = rig({ runner, session: signedIn, allowFile: false })
    await r.cloner.chooseParent()
    await r.cloner.clone({ operationId: 'a', url: 'octocat/Hello-World', name: 'one' })
    await r.cloner.clone({ operationId: 'b', url: 'https://github.com/octocat/Hello-World.git', name: 'two' })
    for (const [request, name] of [[clones[0], 'one'], [clones[1], 'two']] as const) {
      expect(request).toMatchObject({ cwd: r.parent, kind: 'network', redact: expect.arrayContaining([TOKEN]) })
      expect(request.args).toEqual([
        '-c',
        'credential.https://github.com.helper=',
        '-c',
        expect.stringMatching(/^credential\.https:\/\/github\.com\.helper=!f\(\)/),
        'clone',
        '--progress',
        '--',
        'https://github.com/octocat/Hello-World.git',
        join(r.parent, name)
      ])
      expect(request.env).toMatchObject({ DM_GITHUB_LOGIN: LOGIN, DM_GITHUB_TOKEN: TOKEN, GIT_ALLOW_PROTOCOL: 'https:ssh' })
      expect(request.args.join(' ')).not.toContain(TOKEN)
    }
    expect(r.tracked).toEqual([join(r.parent, 'one'), join(r.parent, 'two')])
  })
})

describe('clone without the account', () => {
  it('uses no account for ssh, scp-like or other hosts, or while signed out', async () => {
    const { runner, clones } = standIn()
    const r = rig({ runner, session: signedIn, allowFile: false })
    const out = rig({ runner, allowFile: false })
    await r.cloner.chooseParent()
    await out.cloner.chooseParent()
    await r.cloner.clone({ operationId: 'a', url: 'git@github.com:octocat/Hello-World.git', name: 'a' })
    await r.cloner.clone({ operationId: 'b', url: 'ssh://git@github.com/octocat/Hello-World.git', name: 'b' })
    await r.cloner.clone({ operationId: 'c', url: 'https://gitlab.example.com/group/repo.git', name: 'c' })
    await out.cloner.clone({ operationId: 'd', url: 'octocat/Hello-World', name: 'd' })
    for (const request of clones) {
      expect(request.args[0]).toBe('clone')
      expect(request.env).not.toHaveProperty('DM_GITHUB_TOKEN')
      expect(request.env).toMatchObject({ GIT_ALLOW_PROTOCOL: 'https:ssh', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' })
    }
  })

  it('reports a GitHub rejection as auth_required signed out and auth_failed signed in', async () => {
    const rejection = new GitError('auth_required', "fatal: could not read Username for 'https://github.com': terminal prompts disabled")
    const { runner } = standIn(() => Promise.reject(rejection))
    const out = rig({ runner })
    const signed = rig({ runner, session: signedIn })
    await out.cloner.chooseParent()
    await signed.cloner.chooseParent()
    await expect(out.cloner.clone({ operationId: 'a', url: 'octocat/private', name: 'p' })).rejects.toMatchObject({ code: 'auth_required', message: 'Sign in to GitHub to use this remote.' })
    await expect(signed.cloner.clone({ operationId: 'a', url: 'octocat/private', name: 'p' })).rejects.toMatchObject({ code: 'auth_failed' })
  })
})

/** A stand-in `git clone` whose first run lasts until the test calls `finish` (`started` settles once it runs); later runs end at once. */
function heldClone(): { runner: GitRunner; clones: GitRunRequest[]; started: Promise<void>; finish(): void } {
  let finish: () => void = () => undefined
  let markStarted: () => void = () => undefined
  const started = new Promise<void>((resolve) => (markStarted = resolve))
  const { runner, clones } = standIn(async () => {
    if (clones.length === 1) {
      markStarted()
      await new Promise<void>((resolve) => (finish = resolve))
    }
  })
  return { runner, clones, started, finish: () => finish() }
}

describe('one clone at a time into a parent folder', () => {
  it('refuses another clone into the same parent while one runs, so none waits unseen behind it', async () => {
    const held = heldClone()
    const r = rig({ runner: held.runner })
    await r.cloner.chooseParent()
    const first = r.cloner.clone({ operationId: 'op', url: 'octocat/Hello-World', name: 'Hello-World' })
    await held.started
    await expect(r.cloner.clone({ operationId: 'op', url: 'octocat/Spoon-Knife', name: 'Spoon-Knife' })).rejects.toThrow(GitInputError)
    await expect(r.cloner.clone({ operationId: 'other', url: 'octocat/Spoon-Knife', name: 'Spoon-Knife' })).rejects.toThrow('already running')
    await expect(r.cloner.clone({ operationId: 'other', url: 'octocat/Spoon-Knife', name: 'hello-world' })).rejects.toThrow('already running')
    expect(held.clones).toHaveLength(1)
    held.finish()
    await first
    await r.cloner.clone({ operationId: 'next', url: 'octocat/Spoon-Knife', name: 'Spoon-Knife' })
    expect(r.tracked).toEqual([join(r.parent, 'Hello-World'), join(r.parent, 'Spoon-Knife')])
  })
})

describe('a cancel once git is done', () => {
  it('finds nothing to stop while the clone cleans up, and the clone fails with its own error', async () => {
    let exited: () => void = () => undefined
    const real = createGitRunner()
    const runner: GitRunner = {
      run: (request) => {
        if (request.kind !== 'network') {
          return real.run(request)
        }
        exited = () => request.onExit?.()
        return Promise.reject(new GitError('remote_not_found', "fatal: repository 'https://github.com/octocat/gone/' not found"))
      }
    }
    const r = rig({ runner })
    await r.cloner.chooseParent()
    const run = r.cloner.clone({ operationId: 'op', url: 'octocat/gone', name: 'gone' }).catch((caught: unknown) => caught)
    await vi.waitFor(() => expect(r.cloner.cancel(r.parent, 'op')).toBe(false))
    exited()
    expect(await run).toMatchObject({ code: 'remote_not_found' })
  })
})
