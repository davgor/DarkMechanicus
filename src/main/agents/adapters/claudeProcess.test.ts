import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import type { ChildProcessByStdio } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { removeScratch } from '../../../test/removeScratch'
import { createClaudeProcesses, createInputQueue, resolveClaudeExecutable, type ProcessDeps } from './claudeProcess'

/**
 * The real-process tests start and kill real processes. They wait on what the process does (its first output, the
 * end of a tree kill), never on a timer, a poll or a retry, so a slow start or kill only makes a test slower. The
 * long limit is for a Windows start or kill that stalls under load; a hang still fails once it passes.
 */
vi.setConfig({ testTimeout: 60_000 })

// ---- Finding the program to run ----

describe('resolveClaudeExecutable', () => {
  const never = (): string => {
    throw new Error('should not read')
  }

  it('runs a path as it is anywhere but behind a Windows shim', () => {
    expect(resolveClaudeExecutable('/home/me/.local/bin/claude', 'linux', never)).toBe('/home/me/.local/bin/claude')
    expect(resolveClaudeExecutable('/Users/me/.local/bin/claude', 'darwin', never)).toBe('/Users/me/.local/bin/claude')
    expect(resolveClaudeExecutable('C:\\Users\\me\\.local\\bin\\claude.exe', 'win32', never)).toBe('C:\\Users\\me\\.local\\bin\\claude.exe')
    expect(resolveClaudeExecutable('/opt/claude.cmd', 'linux', never)).toBe('/opt/claude.cmd')
  })

  const NPM_SHIM = [
    '@ECHO off',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*'
  ].join('\r\n')

  it('follows an npm shim to the script it runs, not to the node it checks for first', () => {
    const path = 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd'

    expect(resolveClaudeExecutable(path, 'win32', () => NPM_SHIM)).toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js'
    )
  })

  it('follows a shim that points at a native program', () => {
    const shim = 'endLocal & "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*'

    expect(resolveClaudeExecutable('C:\\npm\\CLAUDE.CMD', 'win32', () => shim)).toBe('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')
    expect(resolveClaudeExecutable('C:\\npm\\claude.bat', 'win32', () => shim)).toBe('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe')
  })

  it('reads the shim from disk by default', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dm-shim-'))
    try {
      writeFileSync(join(dir, 'claude.cmd'), NPM_SHIM)

      expect(resolveClaudeExecutable(join(dir, 'claude.cmd'), 'win32')).toMatch(/node_modules\\@anthropic-ai\\claude-code\\cli\.js$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('says what to do when the shim cannot be followed or read', () => {
    expect(() => resolveClaudeExecutable('C:\\npm\\claude.cmd', 'win32', () => '@echo hello')).toThrow(/Connect claude\.exe/)
    expect(() =>
      resolveClaudeExecutable('C:\\npm\\claude.cmd', 'win32', () => {
        throw new Error('EACCES')
      })
    ).toThrow(/Connect claude\.exe/)
  })
})

// ---- The input stream ----

describe('createInputQueue', () => {
  it('hands messages to the reader in order, whether they were queued before or after it asked', async () => {
    const queue = createInputQueue<string>()
    const reader = queue.iterable[Symbol.asyncIterator]()
    queue.push('one')

    const waiting = reader.next()
    const first = await waiting
    const second = reader.next()
    queue.push('two')

    expect(first).toEqual({ value: 'one', done: false })
    expect(await second).toEqual({ value: 'two', done: false })
  })

  it('ends when closed, after delivering what was queued, and ignores later messages', async () => {
    const queue = createInputQueue<string>()
    const reader = queue.iterable[Symbol.asyncIterator]()
    queue.push('last')
    queue.close()
    queue.push('too late')

    expect(await reader.next()).toEqual({ value: 'last', done: false })
    expect(await reader.next()).toEqual({ value: undefined, done: true })
  })

  it('releases a reader that is waiting when closed', async () => {
    const queue = createInputQueue<string>()
    const waiting = queue.iterable[Symbol.asyncIterator]().next()

    queue.close()

    expect(await waiting).toEqual({ value: undefined, done: true })
  })

  it('stops delivering when the reader returns early', async () => {
    const queue = createInputQueue<string>()
    const reader = queue.iterable[Symbol.asyncIterator]()

    expect(await reader.return?.()).toEqual({ value: undefined, done: true })
    queue.push('ignored')

    expect(await reader.next()).toEqual({ value: undefined, done: true })
  })
})

// ---- Starting and killing processes ----

type Piped = ChildProcessByStdio<Writable, Readable, Readable>

interface FakeChild extends EventEmitter {
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  pid: number | undefined
}

function fakeChild(pid: number | undefined): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = pid
  return child
}

interface Harness {
  deps: ProcessDeps
  spawned: { command: string; args: string[]; options: Parameters<ProcessDeps['spawn']>[2] }[]
  children: FakeChild[]
  /** The children the shared tree killer was asked to end, in order. */
  treeKills: unknown[]
}

function harness(platform: string, overrides: Partial<ProcessDeps> = {}): Harness {
  const h: Harness = { deps: undefined as never, spawned: [], children: [], treeKills: [] }
  h.deps = {
    platform,
    spawn: (command, args, options) => {
      const child = fakeChild(1000 + h.children.length)
      h.spawned.push({ command, args, options })
      h.children.push(child)
      return child as unknown as Piped
    },
    killTree: (child) => {
      h.treeKills.push(child)
      return Promise.resolve(true)
    },
    ...overrides
  }
  return h
}

const spawnOptions = (extra: Partial<SpawnOptions> = {}): SpawnOptions => ({
  command: '/bin/claude',
  args: ['--output-format', 'stream-json'],
  cwd: '/work/repo',
  env: { PATH: '/bin', HOME: '/home/me' },
  signal: new AbortController().signal,
  ...extra
})

describe('createClaudeProcesses: starting programs', () => {
  it('starts the program the SDK asked for, with its arguments, folder and environment, and no shell', () => {
    const h = harness('linux')
    const signal = new AbortController().signal

    const child = createClaudeProcesses(h.deps).spawn(spawnOptions({ signal }))

    expect(child).toBe(h.children[0])
    expect(h.spawned).toEqual([
      {
        command: '/bin/claude',
        args: ['--output-format', 'stream-json'],
        options: { cwd: '/work/repo', env: { PATH: '/bin', HOME: '/home/me' }, signal, detached: true, windowsHide: true }
      }
    ])
  })

  it('does not detach on Windows, where the tree is found through its parent', () => {
    const h = harness('win32')

    createClaudeProcesses(h.deps).spawn(spawnOptions())

    expect(h.spawned[0]?.options).toMatchObject({ detached: false, windowsHide: true })
  })

  it('keeps the end of what the program prints on stderr, so the pipe never fills and errors can say why', () => {
    const h = harness('linux')
    const processes = createClaudeProcesses(h.deps)
    processes.spawn(spawnOptions())

    h.children[0]?.stderr.write('first line\n')
    h.children[0]?.stderr.write(`${'x'.repeat(5000)}last line\n`)

    const tail = processes.stderrTail()
    expect(tail.length).toBeLessThanOrEqual(2000)
    expect(tail.endsWith('last line\n')).toBe(true)
    expect(tail).not.toContain('first line')
  })

  it('has no stderr to show before anything ran', () => {
    expect(createClaudeProcesses(harness('linux').deps).stderrTail()).toBe('')
  })

  it('refuses a child without pipes', () => {
    const h = harness('linux', { spawn: () => ({ stdin: null, stdout: null, stderr: null }) as unknown as Piped })

    expect(() => createClaudeProcesses(h.deps).spawn(spawnOptions())).toThrow(/pipes/)
  })
})

describe('createClaudeProcesses: killing programs', () => {
  it('has the shared tree killer end every child that is still running, on any platform', () => {
    for (const platform of ['win32', 'darwin', 'linux']) {
      const h = harness(platform)
      const processes = createClaudeProcesses(h.deps)
      processes.spawn(spawnOptions())
      processes.spawn(spawnOptions())

      void processes.killAll()

      expect(h.treeKills).toEqual(h.children)
    }
  })

  it('sends every kill before it returns, so a caller that does not wait still stops the trees', () => {
    const h = harness('linux')
    const processes = createClaudeProcesses(h.deps)
    processes.spawn(spawnOptions())

    void processes.killAll()

    expect(h.treeKills).toHaveLength(1)
  })

  it('resolves only once every tree is gone', async () => {
    const finish: (() => void)[] = []
    const h = harness('linux', {
      killTree: () =>
        new Promise<boolean>((resolve) => {
          finish.push(() => {
            resolve(true)
          })
        })
    })
    const processes = createClaudeProcesses(h.deps)
    processes.spawn(spawnOptions())
    processes.spawn(spawnOptions())
    let done = false

    const killing = processes.killAll().then(() => {
      done = true
    })
    finish[0]?.()
    await new Promise((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    finish[1]?.()
    await killing

    expect(done).toBe(true)
  })

})

describe('createClaudeProcesses: what killing waits for', () => {
  it('has nothing to wait for when nothing is running', async () => {
    const h = harness('linux')

    await createClaudeProcesses(h.deps).killAll()

    expect(h.treeKills).toEqual([])
  })

  it('forgets a child once it has exited, and still ends the others', () => {
    const h = harness('linux')
    const processes = createClaudeProcesses(h.deps)
    processes.spawn(spawnOptions())
    processes.spawn(spawnOptions())
    h.children[0]?.emit('exit', 0, null)

    void processes.killAll()

    expect(h.treeKills).toEqual([h.children[1]])
  })
})

// ---- The real thing, against Node itself ----

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('createClaudeProcesses with real processes', () => {
  let scratch = ''

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'dm-claude-'))
  })

  afterAll(() => {
    removeScratch(scratch)
  })

  it('kills the program and the programs it started', async () => {
    const grandchild = "setInterval(() => {}, 1000)"
    const parent = `const { spawn } = require('node:child_process'); const c = spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000)`
    const processes = createClaudeProcesses()
    const child = processes.spawn({
      command: process.execPath,
      args: ['-e', parent],
      cwd: scratch,
      env: { ...process.env },
      signal: new AbortController().signal
    })
    const grandchildPid = await new Promise<number>((resolve) => {
      child.stdout.once('data', (chunk: Buffer) => {
        resolve(Number(String(chunk).trim()))
      })
    })
    expect(alive(grandchildPid)).toBe(true)

    await processes.killAll()

    // No waiting: killAll resolves only once the whole tree has exited.
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    expect(alive(grandchildPid)).toBe(false)
  })

  it('reports a program that does not exist through the child, as the SDK expects', async () => {
    const processes = createClaudeProcesses()
    const child = processes.spawn({ command: join(scratch, 'missing'), args: [], cwd: scratch, env: {}, signal: new AbortController().signal })

    const error = await new Promise<Error>((resolve) => {
      child.on('error', resolve)
    })

    expect(error).toMatchObject({ code: 'ENOENT' })
  })
})
