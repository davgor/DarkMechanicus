import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createGhCli, findGh, isExecutableFile, runGhProcess, type GhRunRequest, type GhRunResult } from './ghCli'
import { GithubError } from './errors'

const TOKEN = 'gho_FAKE_TOKEN_never_leak_123'

interface CliRig {
  requests: GhRunRequest[]
  readGhToken(signal?: AbortSignal): Promise<string>
}

interface CliOptions {
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  executables?: readonly string[]
  answer?: GhRunResult | ((request: GhRunRequest) => Promise<GhRunResult>)
}

function cli(options: CliOptions = {}): CliRig {
  const requests: GhRunRequest[] = []
  const answer = options.answer ?? { kind: 'exited', exitCode: 0, stdout: `${TOKEN}\n`, stderr: '' }
  const gh = createGhCli({
    env: options.env ?? { PATH: '/usr/bin:/opt/homebrew/bin', HOME: '/Users/mona' },
    platform: options.platform ?? 'darwin',
    exists: (path) => (options.executables ?? ['/opt/homebrew/bin/gh']).includes(path),
    run: async (request) => {
      requests.push(request)
      return typeof answer === 'function' ? answer(request) : answer
    }
  })
  return { requests, readGhToken: (signal) => gh.readGhToken(signal) }
}

async function failureOf(promise: Promise<unknown>): Promise<GithubError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  )
  expect(error).toBeInstanceOf(GithubError)
  return error as GithubError
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('findGh', () => {
  const lookup = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, executables: readonly string[]): string | null =>
    findGh({ env, platform, exists: (path) => executables.includes(path) })

  it('takes the first PATH entry that holds an executable gh', () => {
    expect(lookup('darwin', { PATH: '/a:/b:/c' }, ['/b/gh', '/c/gh'])).toBe('/b/gh')
  })

  it('falls back to the install folders a GUI app PATH misses, per platform', () => {
    expect(lookup('darwin', { PATH: '/usr/bin:/bin' }, ['/opt/homebrew/bin/gh'])).toBe('/opt/homebrew/bin/gh')
    expect(lookup('darwin', {}, ['/usr/local/bin/gh'])).toBe('/usr/local/bin/gh')
    expect(lookup('linux', { PATH: '' }, ['/snap/bin/gh'])).toBe('/snap/bin/gh')
    expect(lookup('linux', {}, ['/usr/bin/gh'])).toBe('/usr/bin/gh')
  })

  it('on Windows finds only gh.exe, reads Path case-insensitively, unquotes entries and knows both install folders', () => {
    const env = { Path: '"C:\\Tools";C:\\Other', ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\mona\\AppData\\Local' }
    expect(lookup('win32', env, ['C:\\Tools\\gh.exe'])).toBe('C:\\Tools\\gh.exe')
    expect(lookup('win32', env, ['C:\\Tools\\gh.cmd', 'C:\\Tools\\gh'])).toBeNull()
    expect(lookup('win32', env, ['C:\\Program Files\\GitHub CLI\\gh.exe'])).toBe('C:\\Program Files\\GitHub CLI\\gh.exe')
    expect(lookup('win32', env, ['C:\\Users\\mona\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe'])).toBe(
      'C:\\Users\\mona\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe'
    )
  })

  it('skips relative and empty PATH entries, so a gh in the working folder is never run', () => {
    expect(lookup('darwin', { PATH: ':.:bin:./tools' }, ['gh', './gh', 'bin/gh', 'tools/gh', './tools/gh'])).toBeNull()
    expect(lookup('win32', { PATH: '.;tools' }, ['.\\gh.exe', 'tools\\gh.exe'])).toBeNull()
  })

  it('is null when gh is nowhere', () => {
    expect(lookup('darwin', { PATH: '/usr/bin' }, [])).toBeNull()
  })
})

describe('readGhToken', () => {
  it('runs gh auth token for github.com from the full path, without prompts or update checks, and returns the trimmed token', async () => {
    const rig = cli({ env: { PATH: '/usr/bin', HOME: '/Users/mona', GH_FORCE_TTY: '1' } })
    expect(await rig.readGhToken()).toBe(TOKEN)
    expect(rig.requests).toHaveLength(1)
    const [request] = rig.requests
    expect(request.file).toBe('/opt/homebrew/bin/gh')
    expect(request.args).toEqual(['auth', 'token', '--hostname', 'github.com'])
    expect(request.env).toMatchObject({ PATH: '/usr/bin', HOME: '/Users/mona', GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' })
    expect(request.env.GH_FORCE_TTY).toBeUndefined()
    expect(request.timeoutMs).toBeGreaterThan(0)
  })

  it('imports only the stored gh login: token and debug env is dropped, whatever its case', async () => {
    const env = { PATH: '/usr/bin', GH_TOKEN: 'env1', GITHUB_TOKEN: 'env2', GH_ENTERPRISE_TOKEN: 'env3', GITHUB_ENTERPRISE_TOKEN: 'env4', Gh_Debug: 'api' }
    const rig = cli({ env })
    await rig.readGhToken()
    expect(Object.keys(rig.requests[0].env).filter((key) => /TOKEN|DEBUG/i.test(key))).toEqual([])
  })
})

describe('readGhToken failures', () => {
  it('fails with gh_not_installed and runs nothing when gh is not found', async () => {
    const rig = cli({ executables: [] })
    expect(await failureOf(rig.readGhToken())).toMatchObject({ code: 'gh_not_installed' })
    expect(rig.requests).toEqual([])
  })

  it('fails with gh_not_installed when gh cannot be started', async () => {
    const rig = cli({ answer: { kind: 'spawn_failed' } })
    expect(await failureOf(rig.readGhToken())).toMatchObject({ code: 'gh_not_installed' })
  })

  it.each([
    ['gh exits non-zero', { kind: 'exited', exitCode: 1, stdout: '', stderr: 'no oauth token found for github.com\n' }],
    ['gh prints nothing', { kind: 'exited', exitCode: 0, stdout: ' \n', stderr: '' }],
    ['gh prints more than one token', { kind: 'exited', exitCode: 0, stdout: `${TOKEN}\nsecond line\n`, stderr: '' }]
  ] as const)('fails with gh_not_signed_in when %s', async (_case, answer) => {
    const error = await failureOf(cli({ answer }).readGhToken())
    expect(error).toMatchObject({ code: 'gh_not_signed_in', message: expect.stringContaining('gh auth login') })
  })
})

describe('readGhToken error details and cancellation', () => {
  it('keeps a short tail of gh stderr as the detail, with anything token-like scrubbed', async () => {
    const stderr = `${'x'.repeat(2000)}\nfailed for ${TOKEN} and ghp_ANOTHERfake1234 and github_pat_11ABC_def\n`
    const error = await failureOf(cli({ answer: { kind: 'exited', exitCode: 1, stdout: TOKEN, stderr } }).readGhToken())
    expect(error.detail).toContain('failed for')
    expect(error.detail?.length).toBeLessThanOrEqual(500)
    expect(`${error.message}${error.detail ?? ''}${error.stack ?? ''}`).not.toMatch(/gho_|ghp_|github_pat_/)
  })

  it('scrubs every word gh printed on stdout from the detail, even without a GitHub prefix', async () => {
    const stdout = 'warning\nPLAINsecret0123456789\n'
    const answer = { kind: 'exited', exitCode: 0, stdout, stderr: 'got PLAINsecret0123456789 back' } as const
    const error = await failureOf(cli({ answer }).readGhToken())
    expect(error).toMatchObject({ code: 'gh_not_signed_in', detail: 'got [redacted] back' })
  })

  it('scrubs the longest stdout words first, so a word that starts the token cannot leave its end behind', async () => {
    const stdout = `${TOKEN.slice(0, 10)} ${TOKEN}\n`
    const answer = { kind: 'exited', exitCode: 0, stdout, stderr: `failed ${TOKEN}` } as const
    const error = await failureOf(cli({ answer }).readGhToken())
    expect(error.detail).toBe('failed [redacted]')
  })

  it('redacts a GitHub token stuck to other text', async () => {
    const answer = { kind: 'exited', exitCode: 1, stdout: '', stderr: 'Authorization: Bearergho_OTHERfake123' } as const
    expect((await failureOf(cli({ answer }).readGhToken())).detail).toBe('Authorization: Bearer[redacted]')
  })

  it.each([['timeout'], ['aborted']] as const)('fails with cancelled when the run ends by %s', async (kind) => {
    expect(await failureOf(cli({ answer: { kind } }).readGhToken())).toMatchObject({ code: 'cancelled' })
  })

  it('passes the abort signal to the run', async () => {
    const controller = new AbortController()
    const rig = cli()
    await rig.readGhToken(controller.signal)
    expect(rig.requests[0].signal).toBe(controller.signal)
  })
})

describe('isExecutableFile', () => {
  it.skipIf(process.platform === 'win32')('accepts only an executable file: not a directory, a plain file or a missing path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-gh-exec-'))
    try {
      mkdirSync(join(dir, 'folder'))
      writeFileSync(join(dir, 'plain'), '')
      writeFileSync(join(dir, 'tool'), '#!/bin/sh\n')
      chmodSync(join(dir, 'tool'), 0o755)
      expect(isExecutableFile(join(dir, 'tool'))).toBe(true)
      expect(isExecutableFile(join(dir, 'folder'))).toBe(false)
      expect(isExecutableFile(join(dir, 'plain'))).toBe(false)
      expect(isExecutableFile(join(dir, 'missing'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('runGhProcess', () => {
  const node = process.execPath
  const script = (code: string): GhRunRequest => ({ file: node, args: ['-e', code], env: { ...process.env }, timeoutMs: 5000 })

  it('returns the exit code, stdout and stderr of a process started without a shell or a TTY', async () => {
    const result = await runGhProcess(script("process.stdout.write([process.stdin, process.stdout, process.stderr].map((s) => Boolean(s.isTTY)).join(' ')); process.stderr.write('e'); process.exit(3)"))
    expect(result).toEqual({ kind: 'exited', exitCode: 3, stdout: 'false false false', stderr: 'e' })
  })

  it('does not expand shell syntax in arguments', async () => {
    const result = await runGhProcess({ ...script('process.stdout.write(process.argv[1])'), args: ['-e', 'process.stdout.write(process.argv[1])', '$(echo hi);`id`'] })
    expect(result).toMatchObject({ kind: 'exited', stdout: '$(echo hi);`id`' })
  })

  // A real child and Node's own timer: killing a process at its timeout is the platform behavior under test.
  it('kills a process that runs past the timeout', async () => {
    const started = Date.now()
    const result = await runGhProcess({ ...script('setTimeout(() => {}, 60000)'), timeoutMs: 200 })
    expect(result).toEqual({ kind: 'timeout' })
    expect(Date.now() - started).toBeLessThan(5000)
  })

  it('kills the process on abort, and does not start one for an aborted signal', async () => {
    const controller = new AbortController()
    const pending = runGhProcess({ ...script('setTimeout(() => {}, 60000)'), signal: controller.signal })
    controller.abort()
    expect(await pending).toEqual({ kind: 'aborted' })
    expect(await runGhProcess({ ...script(''), signal: controller.signal })).toEqual({ kind: 'aborted' })
  })

  it.skipIf(process.platform === 'win32')('an abort kills the whole process group, so a helper gh started goes too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-gh-group-'))
    const pidFile = join(dir, 'helper.pid')
    const startsHelper =
      "const h = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });" +
      "require('node:fs').writeFileSync(process.env.PID_FILE, String(h.pid)); setTimeout(() => {}, 60000)"
    const controller = new AbortController()
    try {
      const pending = runGhProcess({ ...script(startsHelper), env: { ...process.env, PID_FILE: pidFile }, signal: controller.signal })
      await vi.waitFor(() => expect(existsSync(pidFile) && readFileSync(pidFile, 'utf8') !== '').toBe(true), { timeout: 5000 })
      const helper = Number(readFileSync(pidFile, 'utf8'))
      controller.abort()
      expect(await pending).toEqual({ kind: 'aborted' })
      await vi.waitFor(() => expect(isAlive(helper)).toBe(false), { timeout: 5000 })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports a missing or non-executable file as spawn_failed', async () => {
    expect(await runGhProcess({ ...script(''), file: '/nonexistent/dm-test/gh' })).toEqual({ kind: 'spawn_failed' })
  })
})
