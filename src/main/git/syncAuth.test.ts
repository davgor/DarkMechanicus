/** Credentials, prompts, auth and network failures, and cancel for fetch, pull and push. */
import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { gitIn, scratchDir } from '../../test/gitScratch'
import { GitError } from './errors'
import { type ChildLike, createGitRunner, type SpawnFn } from './runner'
import { createSync } from './sync'

const LOGIN = 'octo-cat'
const TOKEN = 'gho_FAKE_TOKEN_never_leak_123'
const BASIC = Buffer.from(`${LOGIN}:${TOKEN}`).toString('base64')
const signedIn = { getAccount: () => ({ login: LOGIN }), getToken: () => TOKEN }
const signedOut = { getAccount: () => null, getToken: () => null }
const NETWORK_COMMANDS = ['fetch', 'pull', 'push']

const cleanups: Array<() => void> = []
let home = ''
let globalConfig = ''

beforeEach(() => {
  const dir = scratchDir('dm-sync-auth-')
  cleanups.push(dir.cleanup)
  home = dir.path
  globalConfig = join(home, 'gitconfig')
  writeFileSync(globalConfig, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
})

afterEach(() => {
  vi.unstubAllEnvs()
  while (cleanups.length > 0) {
    cleanups.pop()?.()
  }
})

function repoWithOrigin(url: string): GitRepo {
  const r = createGitRepo()
  cleanups.push(r.cleanup)
  r.git('remote', 'add', 'origin', url)
  return r
}

/** An HTTP git server that answers every request with 401 and counts them. */
async function authServer(): Promise<{ url: string; requests: () => number }> {
  let count = 0
  const server: Server = createServer((_request, response) => {
    count += 1
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' })
    response.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  cleanups.push(() => server.close())
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/octo/hello.git`, requests: () => count }
}

/** A script that leaves a marker when it runs: an askpass program or credential helper that must (not) run. */
function markerScript(name: string, output: string): { path: string; ran: () => boolean } {
  const marker = join(home, `${name}-ran`)
  const path = join(home, `${name}.sh`)
  writeFileSync(path, `#!/bin/sh\necho ran > '${marker}'\n${output}`)
  chmodSync(path, 0o755)
  return { path, ran: () => existsSync(marker) }
}

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { on: (): void => undefined, end: (): void => undefined }
  kills: Array<NodeJS.Signals | number | undefined> = []
  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal)
    return true
  }
}

interface NetworkCall {
  args: readonly string[]
  env: Record<string, string | undefined>
  child: FakeChild
}

/** Real git for everything but the network command, which a fake child stands in for; `spawned` waits for it. */
function fakeNetwork(): { spawn: SpawnFn; calls: NetworkCall[]; spawned(): Promise<NetworkCall> } {
  const calls: NetworkCall[] = []
  const spawns = new EventEmitter()
  const spawn: SpawnFn = (command, args, options) => {
    if (!args.some((arg) => NETWORK_COMMANDS.includes(arg))) {
      return nodeSpawn(command, [...args], options) as unknown as ChildLike
    }
    const call = { args, env: options.env as Record<string, string | undefined>, child: new FakeChild() }
    calls.push(call)
    spawns.emit('call', call)
    return call.child as unknown as ChildLike
  }
  const spawned = async (): Promise<NetworkCall> => calls[0] ?? ((await once(spawns, 'call')) as [NetworkCall])[0]
  return { spawn, calls, spawned }
}

async function failureOf(run: Promise<unknown>): Promise<GitError> {
  const error = await run.then(
    () => null,
    (caught: unknown) => caught
  )
  if (!(error instanceof GitError)) {
    throw new Error(`expected a GitError, got ${String(error)}`)
  }
  return error
}

describe('no prompt ever waits (c3)', () => {
  it('signed out, an HTTPS remote that needs auth fails auth_required promptly, and no askpass program runs', async () => {
    const server = await authServer()
    const askpass = markerScript('askpass', 'sleep 30\necho guessed\n')
    vi.stubEnv('GIT_ASKPASS', askpass.path)
    vi.stubEnv('SSH_ASKPASS', askpass.path)
    gitIn(home, 'config', '--file', globalConfig, 'core.askPass', askpass.path)
    const r = repoWithOrigin(server.url)
    const sync = createSync({ runner: createGitRunner(), session: signedOut, onProgress: () => undefined, env: {} })
    const started = Date.now()
    const error = await failureOf(sync.run('fetch', r.root, 'op'))
    expect(error.code).toBe('auth_required')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(server.requests()).toBeGreaterThan(0)
    expect(askpass.ran()).toBe(false)
  })

  it("a non-GitHub remote uses the machine's own helper even when signed in, and its rejection is auth_failed", async () => {
    const server = await authServer()
    const helper = markerScript('helper', 'echo username=machine\necho password=wrong\n')
    gitIn(home, 'config', '--file', globalConfig, 'credential.helper', helper.path)
    const r = repoWithOrigin(server.url)
    const sync = createSync({ runner: createGitRunner(), session: signedIn, onProgress: () => undefined, env: {} })
    const error = await failureOf(sync.run('fetch', r.root, 'op'))
    expect(error.code).toBe('auth_failed')
    expect(helper.ran()).toBe(true)
  })
})

describe('ssh never prompts (c3)', () => {
  it('runs ssh in batch mode for an SSH remote and passes no GitHub credentials', async () => {
    const r = repoWithOrigin('git@github.com:octo/hello.git')
    const { spawn, spawned } = fakeNetwork()
    const sync = createSync({ runner: createGitRunner({ spawn }), session: signedIn, onProgress: () => undefined, env: {} })
    const run = sync.run('fetch', r.root, 'op')
    const call = await spawned()
    expect(call.env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes')
    expect(call.env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(call.env.DM_GITHUB_TOKEN).toBeUndefined()
    expect(call.args.join(' ')).not.toContain('credential')
    call.child.emit('close', 0, null)
    await run
  })

  // Skipped on Windows: the stand-in `ssh` is a shell script found through PATH.
  it.skipIf(process.platform === 'win32')('real git starts ssh in batch mode, which cannot prompt', async () => {
    const bin = join(home, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'ssh'), `#!/bin/sh\necho "$@" > '${join(home, 'ssh-args')}'\necho 'Permission denied (publickey).' >&2\nexit 255\n`)
    chmodSync(join(bin, 'ssh'), 0o755)
    vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
    const r = repoWithOrigin('git@github.com:octo/hello.git')
    const sync = createSync({ runner: createGitRunner(), session: signedIn, onProgress: () => undefined, env: {} })
    expect((await failureOf(sync.run('fetch', r.root, 'op'))).code).toBe('auth_failed')
    expect(readFileSync(join(home, 'ssh-args'), 'utf8')).toMatch(/^-o BatchMode=yes .*git@github\.com/)
  })
})

describe('GitHub credentials (c2)', () => {
  function githubRun(session: typeof signedIn | typeof signedOut, stderr: string): { run: Promise<unknown>; calls: NetworkCall[] } {
    const r = repoWithOrigin('https://github.com/octo/hello.git')
    const { spawn, calls, spawned } = fakeNetwork()
    const sync = createSync({ runner: createGitRunner({ spawn }), session, onProgress: () => undefined, env: {} })
    const run = sync.run('push', r.root, 'op')
    void spawned().then((call) => {
      call.child.stderr.emit('data', Buffer.from(stderr))
      call.child.emit('close', 128, null)
    })
    return { run, calls }
  }

  it('signed in: the token goes through the environment only, and a rejection is auth_failed with the token scrubbed', async () => {
    const stderr = `remote: Invalid username or password.\nfatal: Authentication failed for 'https://${LOGIN}:${TOKEN}@github.com/' (Basic ${BASIC})\n`
    const { run, calls } = githubRun(signedIn, stderr)
    const error = await failureOf(run)
    expect(error.code).toBe('auth_failed')
    expect(calls[0].args).toContain('credential.https://github.com.helper=')
    expect(calls[0].env.DM_GITHUB_TOKEN).toBe(TOKEN)
    expect(calls[0].env.DM_GITHUB_LOGIN).toBe(LOGIN)
    expect(JSON.stringify(calls[0].args)).not.toContain(TOKEN)
    expect(JSON.stringify(calls[0].args)).not.toContain(BASIC)
    for (const text of [error.detail, error.message]) {
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain(BASIC)
    }
    expect(error.detail).toContain('[redacted]')
  })

  it('signed out: no credentials are passed, and any auth failure is auth_required', async () => {
    const { run, calls } = githubRun(signedOut, "fatal: Authentication failed for 'https://github.com/octo/hello.git/'\n")
    const error = await failureOf(run)
    expect(error.code).toBe('auth_required')
    expect(calls[0].env.DM_GITHUB_TOKEN).toBeUndefined()
    expect(calls[0].args.join(' ')).not.toContain('credential')
  })

  it("signed in: another host's rejection (a submodule's) keeps git's own code and does not blame the account", async () => {
    const { run } = githubRun(signedIn, "fatal: Authentication failed for 'https://gitlab.example/sub.git/'\n")
    const error = await failureOf(run)
    expect(error.code).toBe('auth_failed')
    expect(error.message).not.toMatch(/GitHub/)
  })
})

describe('network failure (c4)', () => {
  it('returns network_unreachable when the server cannot be reached', async () => {
    const server = createServer()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as AddressInfo).port
    server.close()
    await once(server, 'close')
    const r = repoWithOrigin(`http://127.0.0.1:${port}/octo/hello.git`)
    const sync = createSync({ runner: createGitRunner(), session: signedOut, onProgress: () => undefined, env: {} })
    expect((await failureOf(sync.run('fetch', r.root, 'op'))).code).toBe('network_unreachable')
  })
})

describe('cancel (c4)', () => {
  it('cancel stops a running operation with cancelled; an unknown or finished id cancels nothing', async () => {
    const r = repoWithOrigin('https://example.com/octo/hello.git')
    const { spawn, calls, spawned } = fakeNetwork()
    const sync = createSync({ runner: createGitRunner({ spawn, platform: 'linux' }), session: signedOut, onProgress: () => undefined, env: {} })
    const run = sync.run('fetch', r.root, 'slow')
    await spawned()
    expect(sync.cancel(r.root, 'other')).toBe(false)
    expect(sync.cancel('/elsewhere', 'slow')).toBe(false)
    expect(sync.cancel(r.root, 'slow')).toBe(true)
    expect((await failureOf(run)).code).toBe('cancelled')
    expect(calls[0].child.kills).toEqual(['SIGTERM'])
    expect(sync.cancel(r.root, 'slow')).toBe(false)
  })

  it('cancel right after start, before git is spawned, still returns cancelled', async () => {
    const r = repoWithOrigin('https://example.com/octo/hello.git')
    const { spawn, calls } = fakeNetwork()
    const sync = createSync({ runner: createGitRunner({ spawn }), session: signedOut, onProgress: () => undefined, env: {} })
    const run = sync.run('fetch', r.root, 'quick')
    expect(sync.cancel(r.root, 'quick')).toBe(true)
    expect((await failureOf(run)).code).toBe('cancelled')
    expect(calls).toHaveLength(0)
  })
})

describe('operation ids (c4)', () => {
  it('refuses a second operation with the id of one still running', async () => {
    const r = repoWithOrigin('https://example.com/octo/hello.git')
    const { spawn, spawned } = fakeNetwork()
    const sync = createSync({ runner: createGitRunner({ spawn }), session: signedOut, onProgress: () => undefined, env: {} })
    const first = sync.run('fetch', r.root, 'same')
    await expect(sync.run('push', r.root, 'same')).rejects.toThrow(/already running/)
    const call = await spawned()
    call.child.emit('close', 0, null)
    await first
  })

  it('cancel after git has finished reports that nothing was cancelled', async () => {
    const r = repoWithOrigin('https://example.com/octo/hello.git')
    const { spawn, spawned } = fakeNetwork()
    const real = createGitRunner({ spawn })
    const refresh = new EventEmitter()
    let networkDone = false
    // Holds the state refresh that follows git until the test releases it, so the cancel lands between the two.
    const runner = {
      run: async (request: Parameters<typeof real.run>[0]) => {
        if (networkDone && request.args[0] === 'rev-parse') {
          networkDone = false
          refresh.emit('reached')
          await once(refresh, 'release')
        }
        return real.run(request)
      }
    }
    const sync = createSync({ runner, session: signedOut, onProgress: () => undefined, env: {} })
    const run = sync.run('fetch', r.root, 'late')
    const call = await spawned()
    const reached = once(refresh, 'reached')
    networkDone = true
    call.child.emit('close', 0, null)
    await reached
    expect(sync.cancel(r.root, 'late')).toBe(false)
    refresh.emit('release')
    expect((await run).kind).toBe('repository')
  })
})
