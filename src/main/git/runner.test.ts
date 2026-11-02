import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGitRepo, type GitRepo } from '../../test/gitRepo'
import { GitError } from './errors'
import { type ChildLike, createGitRunner, type GitRunRequest, type SpawnFn } from './runner'

class FakeStream extends EventEmitter {
  destroyed = false
  destroy(): void {
    this.destroyed = true
  }
}

class FakeChild extends EventEmitter {
  pid = 4242
  stdout = new FakeStream()
  stderr = new FakeStream()
  stdinText: string | null = null
  stdin = {
    on: (): void => undefined,
    end: (text?: string): void => {
      this.stdinText = text ?? ''
    }
  }
  kills: Array<NodeJS.Signals | number | undefined> = []
  kill(signal?: NodeJS.Signals | number): boolean {
    this.kills.push(signal)
    return true
  }
  out(text: string): void {
    this.stdout.emit('data', Buffer.from(text))
  }
  err(text: string): void {
    this.stderr.emit('data', Buffer.from(text))
  }
  close(code: number): void {
    this.emit('close', code, null)
  }
}

interface SpawnCall {
  command: string
  args: readonly string[]
  options: Record<string, unknown>
  child: FakeChild
}

function fakeSpawn(): { spawn: SpawnFn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = []
  const spawn: SpawnFn = (command, args, options) => {
    const child = new FakeChild()
    calls.push({ command, args, options: options as Record<string, unknown>, child })
    return child as unknown as ChildLike
  }
  return { spawn, calls }
}

const req = (over: Partial<GitRunRequest> = {}): GitRunRequest => ({ cwd: '/fake/repo', args: ['status'], kind: 'read', ...over })
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('spawning and environment (fake spawn)', () => {
  it('uses an argument array, no shell, hidden window and the fixed -c options', async () => {
    const { spawn, calls } = fakeSpawn()
    const run = createGitRunner({ spawn, gitPath: 'mygit' }).run(req({ args: ['log', '-1'] }))
    const call = calls[0]
    expect(call.command).toBe('mygit')
    expect(call.args).toEqual(['-c', 'core.quotepath=false', '-c', 'color.ui=never', '-c', 'core.fsmonitor=false', 'log', '-1'])
    expect(call.options.shell).toBeFalsy()
    expect(call.options.windowsHide).toBe(true)
    expect(call.options.cwd).toBe('/fake/repo')
    call.child.out('ok')
    call.child.close(0)
    expect(await run).toEqual({ code: 0, stdout: 'ok', stderr: '' })
  })

  it('strips redirecting variables, disables prompts, forces English, and merges request.env last', async () => {
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) {
      vi.stubEnv(key, '/elsewhere')
    }
    vi.stubEnv('GIT_TERMINAL_PROMPT', '1')
    const { spawn, calls } = fakeSpawn()
    const runner = createGitRunner({ spawn })
    void runner.run(req({ kind: 'write', env: { GIT_ASKPASS: 'x', LANGUAGE: 'override' } })).catch(() => undefined)
    const env = calls[0].options.env as Record<string, string | undefined>
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) {
      expect(env[key], key).toBeUndefined()
    }
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.LC_ALL).toBe('C')
    expect(env.GIT_ASKPASS).toBe('x')
    expect(env.LANGUAGE).toBe('override')
    expect(env.GIT_OPTIONAL_LOCKS).toBeUndefined()
    calls[0].child.close(0)
  })

  it('turns off every askpass program (GIT_ASKPASS, core.askPass, SSH_ASKPASS) and GCM windows, which ignore GIT_TERMINAL_PROMPT', async () => {
    vi.stubEnv('GIT_ASKPASS', '/usr/local/bin/some-askpass')
    vi.stubEnv('GCM_INTERACTIVE', 'always')
    const { spawn, calls } = fakeSpawn()
    void createGitRunner({ spawn }).run(req({ kind: 'network' })).catch(() => undefined)
    expect(calls[0].options.env).toMatchObject({ GIT_ASKPASS: '', GCM_INTERACTIVE: 'never' })
    calls[0].child.close(0)
  })
})

describe('read locks, stdin and progress (fake spawn)', () => {
  it('adds GIT_OPTIONAL_LOCKS=0 for reads only', async () => {
    const { spawn, calls } = fakeSpawn()
    const runner = createGitRunner({ spawn })
    const a = runner.run(req({ kind: 'read' }))
    const b = runner.run(req({ kind: 'network', cwd: '/fake/other' }))
    expect((calls[0].options.env as Record<string, string>).GIT_OPTIONAL_LOCKS).toBe('0')
    expect((calls[1].options.env as Record<string, string | undefined>).GIT_OPTIONAL_LOCKS).toBeUndefined()
    calls.forEach((call) => call.child.close(0))
    await Promise.all([a, b])
  })

  it('writes stdin', async () => {
    const { spawn, calls } = fakeSpawn()
    const run = createGitRunner({ spawn }).run(req({ stdin: 'hello' }))
    expect(calls[0].child.stdinText).toBe('hello')
    calls[0].child.close(0)
    await run
  })

  it('splits stderr progress on \\r and \\n, across chunks', async () => {
    const { spawn, calls } = fakeSpawn()
    const lines: string[] = []
    const run = createGitRunner({ spawn }).run(req({ onProgress: (line) => lines.push(line) }))
    const child = calls[0].child
    child.err('Receiving objects:  10%\rReceiving objects:  5')
    child.err('0%\rResolving deltas: 100%\nlast')
    child.close(0)
    const result = await run
    expect(lines).toEqual(['Receiving objects:  10%', 'Receiving objects:  50%', 'Resolving deltas: 100%', 'last'])
    expect(result.stderr).toContain('Resolving deltas')
  })
})

describe('redaction (fake spawn)', () => {
  it('replaces each `redact` secret in progress lines, output and error details', async () => {
    const { spawn, calls } = fakeSpawn()
    const lines: string[] = []
    const runner = createGitRunner({ spawn })
    const ok = runner.run(req({ redact: ['s3cret', ''], onProgress: (line) => lines.push(line) }))
    calls[0].child.err('remote: s3cr')
    calls[0].child.err('et here\n')
    calls[0].child.out('out s3cret')
    calls[0].child.close(0)
    expect(await ok).toEqual({ code: 0, stdout: 'out [redacted]', stderr: 'remote: [redacted] here\n' })
    expect(lines).toEqual(['remote: [redacted] here'])
    const bad = runner.run(req({ args: ['push'], redact: ['s3cret'] }))
    // The detail keeps the last 2000 characters; this cut falls inside the secret, so scrubbing must come first.
    const head = "fatal: Authentication failed for 'https://u:"
    calls[1].child.err(`${head}s3cret@github.com/'\n${'y'.repeat(1983)}`)
    calls[1].child.close(128)
    const error = (await bad.catch((caught: unknown) => caught)) as GitError
    expect(error).toMatchObject({ code: 'auth_failed' })
    expect(`${error.detail} ${error.message}`).not.toMatch(/cret|ret@github/)
  })
})

describe('failures (fake spawn)', () => {
  it('rejects a non-zero exit with a classified GitError, unless the code is accepted', async () => {
    const { spawn, calls } = fakeSpawn()
    const runner = createGitRunner({ spawn })
    const bad = runner.run(req())
    calls[0].child.err('fatal: not a git repository (or any of the parent directories): .git\n')
    calls[0].child.close(128)
    await expect(bad).rejects.toMatchObject({ code: 'not_repository' })

    const ok = runner.run(req({ acceptExitCodes: [0, 1] }))
    calls[1].child.close(1)
    expect(await ok).toEqual({ code: 1, stdout: '', stderr: '' })
  })

  it('rejects output_too_large and kills the child', async () => {
    const { spawn, calls } = fakeSpawn()
    const run = createGitRunner({ spawn, platform: 'linux' }).run(req({ maxOutputBytes: 10 }))
    calls[0].child.out('0123456')
    calls[0].child.err('89abc')
    await expect(run).rejects.toMatchObject({ code: 'output_too_large' })
    expect(calls[0].child.kills).toContain('SIGTERM')
  })

  it('spawn ENOENT is git_not_found', async () => {
    const { spawn, calls } = fakeSpawn()
    const run = createGitRunner({ spawn }).run(req())
    calls[0].child.emit('error', Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))
    await expect(run).rejects.toMatchObject({ code: 'git_not_found' })
  })
})

describe('timeout and abort (fake spawn)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('times out reads at 30 s: SIGTERM, then SIGKILL after 2 s', async () => {
    const { spawn, calls } = fakeSpawn()
    const run = createGitRunner({ spawn, platform: 'linux' }).run(req({ kind: 'read' }))
    const settled = expect(run).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(29_999)
    expect(calls[0].child.kills).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    await settled
    expect(calls[0].child.kills).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls[0].child.kills).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('times out writes at 120 s and honors timeoutMs', async () => {
    const { spawn, calls } = fakeSpawn()
    const runner = createGitRunner({ spawn, platform: 'linux' })
    const write = runner.run(req({ kind: 'write' }))
    const short = runner.run(req({ kind: 'read', timeoutMs: 50 }))
    const shortSettled = expect(short).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(50)
    await shortSettled
    const writeSettled = expect(write).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(119_950)
    await writeSettled
    expect(calls[0].child.kills).toContain('SIGTERM')
  })
})

describe('abort (fake spawn)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('abort kills the child and rejects cancelled', async () => {
    const { spawn, calls } = fakeSpawn()
    const controller = new AbortController()
    const run = createGitRunner({ spawn, platform: 'linux' }).run(req({ kind: 'network', signal: controller.signal }))
    const settled = expect(run).rejects.toMatchObject({ code: 'cancelled' })
    controller.abort()
    await settled
    expect(calls[0].child.kills).toEqual(['SIGTERM'])
  })

  it('an already-aborted signal never spawns', async () => {
    const { spawn, calls } = fakeSpawn()
    const controller = new AbortController()
    controller.abort()
    await expect(createGitRunner({ spawn }).run(req({ signal: controller.signal }))).rejects.toMatchObject({ code: 'cancelled' })
    expect(calls).toHaveLength(0)
  })

  it('on Windows the process tree is killed with taskkill /T /F', async () => {
    const { spawn, calls } = fakeSpawn()
    const controller = new AbortController()
    const run = createGitRunner({ spawn, platform: 'win32' }).run(req({ kind: 'network', signal: controller.signal }))
    const settled = expect(run).rejects.toMatchObject({ code: 'cancelled' })
    controller.abort()
    await settled
    expect(calls).toHaveLength(2)
    expect(calls[1].command).toBe('taskkill')
    expect(calls[1].args).toEqual(['/pid', '4242', '/T', '/F'])
  })
})

describe('the output pipes of a git that has exited (fake spawn)', () => {
  /** A child git left running (an sh and its sleep, an ssh) holds them open, which taskkill does not always end on Windows. */
  const pipesOf = (child: FakeChild): boolean[] => [child.stdout.destroyed, child.stderr.destroyed]

  it('are closed once a git killed on Windows has exited, so the run counts as gone without waiting on its children', async () => {
    const { spawn, calls } = fakeSpawn()
    const controller = new AbortController()
    const exits: string[] = []
    const run = createGitRunner({ spawn, platform: 'win32' }).run(req({ kind: 'network', signal: controller.signal, onExit: () => exits.push('exit') }))
    controller.abort()
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    const git = calls[0].child
    expect(pipesOf(git)).toEqual([false, false])
    git.emit('exit', 1, null)
    expect(pipesOf(git)).toEqual([true, true])
    git.close(1)
    expect(exits).toEqual(['exit'])
  })

  it('are left to close by themselves for a git that exits on its own, and for one killed elsewhere', async () => {
    const { spawn, calls } = fakeSpawn()
    const done = createGitRunner({ spawn, platform: 'win32' }).run(req())
    calls[0].child.emit('exit', 0, null)
    expect(pipesOf(calls[0].child)).toEqual([false, false])
    calls[0].child.close(0)
    await done
    const controller = new AbortController()
    const killed = createGitRunner({ spawn, platform: 'linux', killGroup: null }).run(req({ kind: 'network', signal: controller.signal }))
    controller.abort()
    await expect(killed).rejects.toMatchObject({ code: 'cancelled' })
    calls[1].child.emit('exit', null, 'SIGTERM')
    expect(pipesOf(calls[1].child)).toEqual([false, false])
  })
})

describe('queue (fake spawn)', () => {
  it('runs writes and network operations for one repository one at a time, in order; reads are not held', async () => {
    const { spawn, calls } = fakeSpawn()
    const runner = createGitRunner({ spawn })
    const order: string[] = []
    const track = (name: string, request: GitRunRequest): Promise<void> =>
      runner.run(request).then(() => {
        order.push(name)
      })
    const all = [
      track('w1', req({ kind: 'write', args: ['w1'] })),
      track('n2', req({ kind: 'network', args: ['n2'] })),
      track('w3', req({ kind: 'write', args: ['w3'] })),
      track('r', req({ kind: 'read', args: ['r'] })),
      track('other', req({ kind: 'write', cwd: '/fake/other', args: ['other'] }))
    ]
    await tick()
    const started = (): string[] => calls.map((call) => String(call.args.at(-1)))
    expect(started()).toEqual(['w1', 'r', 'other'])
    calls[0].child.close(0)
    await tick()
    expect(started()).toEqual(['w1', 'r', 'other', 'n2'])
    calls[3].child.close(0)
    await tick()
    expect(started()).toEqual(['w1', 'r', 'other', 'n2', 'w3'])
    calls.forEach((call) => call.child.close(0))
    await Promise.all(all)
    expect(order.indexOf('w1')).toBeLessThan(order.indexOf('n2'))
    expect(order.indexOf('n2')).toBeLessThan(order.indexOf('w3'))
  })

  it('a failed write does not block the next one', async () => {
    const { spawn, calls } = fakeSpawn()
    const runner = createGitRunner({ spawn })
    const first = runner.run(req({ kind: 'write' })).catch((error: unknown) => error)
    const second = runner.run(req({ kind: 'write' }))
    await tick()
    calls[0].child.close(1)
    expect(await first).toBeInstanceOf(GitError)
    await tick()
    expect(calls).toHaveLength(2)
    calls[1].child.close(0)
    await second
  })
})

describe('process groups (fake spawn)', () => {
  it('starts each git in its own process group and signals the whole group on cancel', async () => {
    const { spawn, calls } = fakeSpawn()
    const groups: Array<[number, string]> = []
    const controller = new AbortController()
    const runner = createGitRunner({ spawn, platform: 'linux', killGroup: (pgid, signal) => groups.push([pgid, signal]) })
    const run = runner.run(req({ kind: 'network', signal: controller.signal }))
    expect(calls[0].options.detached).toBe(true)
    controller.abort()
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    expect(groups).toEqual([[4242, 'SIGTERM']])
    expect(calls[0].child.kills).toEqual([])
  })

  it('signals git itself when its group is already gone, and never starts groups without a group kill', async () => {
    const { spawn, calls } = fakeSpawn()
    const controller = new AbortController()
    const gone = (): void => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
    }
    const run = createGitRunner({ spawn, platform: 'linux', killGroup: gone }).run(req({ kind: 'network', signal: controller.signal }))
    controller.abort()
    await expect(run).rejects.toMatchObject({ code: 'cancelled' })
    expect(calls[0].child.kills).toEqual(['SIGTERM'])
    void createGitRunner({ spawn, platform: 'linux' }).run(req({ kind: 'read' })).catch(() => undefined)
    expect(calls[1].options.detached).toBe(false)
    calls[1].child.close(0)
  })

  it('holds the next write until a cancelled git has exited, not just until it was cancelled', async () => {
    const { spawn, calls } = fakeSpawn()
    const controller = new AbortController()
    const runner = createGitRunner({ spawn, platform: 'linux' })
    const first = runner.run(req({ kind: 'network', signal: controller.signal }))
    const second = runner.run(req({ kind: 'write' }))
    controller.abort()
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
    await tick()
    expect(calls).toHaveLength(1)
    calls[0].child.close(143)
    await tick()
    expect(calls).toHaveLength(2)
    calls[1].child.close(0)
    await second
  })
})

// Skipped on Windows: process groups and the shell alias are POSIX.
describe.skipIf(process.platform === 'win32')('cancel against real git', () => {
  it("ends what git started too (a process git itself would not stop), then lets the next write start", async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-cancel-')))
    try {
      const marker = join(dir, 'grandchild-got-term')
      // git runs the alias in a shell, which starts a grandchild in the background and waits; only a group kill reaches it.
      const grandchild = `trap 'echo term > ${marker}; exit 0' TERM; echo started >&2; i=0; while [ \\$i -lt 20 ]; do sleep 1; i=\\$((i+1)); done`
      const alias = `alias.hang=!f() { sh -c "${grandchild}" & wait; }; f`
      const controller = new AbortController()
      const runner = createGitRunner()
      const run = runner.run({
        cwd: dir,
        args: ['-c', alias, 'hang'],
        kind: 'network',
        signal: controller.signal,
        onProgress: (line) => {
          if (line === 'started') {
            controller.abort()
          }
        }
      })
      await expect(run).rejects.toMatchObject({ code: 'cancelled' })
      await runner.run({ cwd: dir, args: ['--version'], kind: 'write' })
      expect(existsSync(marker)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('against real git', () => {
  let repo: GitRepo | null = null
  afterEach(() => {
    repo?.cleanup()
    repo = null
  })

  it('does not leak an inherited GIT_DIR', async () => {
    repo = createGitRepo()
    const decoy = mkdtempSync(join(tmpdir(), 'dm-decoy-'))
    try {
      vi.stubEnv('GIT_DIR', join(decoy, 'nope'))
      vi.stubEnv('GIT_WORK_TREE', decoy)
      const result = await createGitRunner().run({ cwd: repo.root, args: ['rev-parse', '--show-toplevel'], kind: 'read' })
      expect(realpathSync.native(result.stdout.trim())).toBe(realpathSync.native(repo.root))
    } finally {
      rmSync(decoy, { recursive: true, force: true })
    }
  })

  it('round-trips a non-ASCII file name', async () => {
    repo = createGitRepo()
    const name = 'café-日本語.txt'
    writeFileSync(join(repo.root, name), 'x\n')
    const runner = createGitRunner()
    await runner.run({ cwd: repo.root, args: ['add', '--', name], kind: 'write' })
    const listed = await runner.run({ cwd: repo.root, args: ['ls-files'], kind: 'read' })
    expect(listed.stdout.split('\n')).toContain(name)
    const status = await runner.run({ cwd: repo.root, args: ['status', '--porcelain'], kind: 'read' })
    expect(status.stdout).toContain(name)
  })

})

describe('against real git (failures)', () => {
  let repo: GitRepo | null = null
  afterEach(() => {
    repo?.cleanup()
    repo = null
  })

  it('a bogus gitPath is git_not_found', async () => {
    repo = createGitRepo()
    const runner = createGitRunner({ gitPath: join(repo.root, 'no-such-git-binary') })
    await expect(runner.run({ cwd: repo.root, args: ['status'], kind: 'read' })).rejects.toMatchObject({ code: 'git_not_found' })
  })

  it('too much real output is output_too_large', async () => {
    repo = createGitRepo()
    await expect(
      createGitRunner().run({ cwd: repo.root, args: ['log', '--format=%H%n%B'], kind: 'read', maxOutputBytes: 10 })
    ).rejects.toMatchObject({ code: 'output_too_large' })
  })

  it('classifies a real failure', async () => {
    repo = createGitRepo()
    await expect(createGitRunner().run({ cwd: repo.root, args: ['checkout', 'nope'], kind: 'write' })).rejects.toMatchObject({
      code: 'git_failed'
    })
  })
})
