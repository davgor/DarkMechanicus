import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  failureScreenshotName,
  fakeAgentPids,
  isAlive,
  isolatedEnv,
  runStep,
  verdict,
  waitFor,
  wrapperSource,
  writeShim
} from './e2e-agent-chat.mjs'

const FIXTURE = resolve('src', 'main', 'agentChat', '__fixtures__', 'fakeAgentCli.mjs')
/** The same expression as `SHIM_TARGET` in src/main/terminals/claudeExecutable.ts, which the chat launch follows. */
const SHIM_TARGET = /"%dp0%\\([^"]+\.(?:js|exe))"/gi
const temps = []
const temp = () => {
  const directory = mkdtempSync(join(tmpdir(), 'e2e-agent-chat-test-'))
  temps.push(directory)
  return directory
}

afterEach(() => {
  for (const directory of temps.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('runStep', () => {
  it('passes a step that meets its condition before the deadline', async () => {
    const step = await runStep('app ready', async (signal) => {
      let polls = 0
      await waitFor(() => ++polls === 3, signal, 5)
      return { polls }
    }, { deadlineMs: 1_000 })
    expect(step).toMatchObject({ name: 'app ready', ok: true, detail: { polls: 3 } })
    expect(step.ms).toBeLessThan(1_000)
  })

  it('fails a missed deadline with the step name, runs once and aborts the condition', async () => {
    let attempts = 0
    let aborted = false
    const failures = []
    const step = await runStep('app ready', async (signal) => {
      attempts += 1
      signal.addEventListener('abort', () => { aborted = true })
      await waitFor(() => false, signal, 5)
    }, { deadlineMs: 50, onFailure: async (name) => { failures.push(name); return { screenshot: 'x.png', stderrTail: ['boom'] } } })
    expect(step.ok).toBe(false)
    expect(step.detail).toEqual({ error: 'app ready: missed its 50 ms deadline', screenshot: 'x.png', stderrTail: ['boom'] })
    expect(attempts).toBe(1)
    expect(aborted).toBe(true)
    expect(failures).toEqual(['app ready'])
  })

  it('fails a step that ignores its signal and blocks past the deadline', async () => {
    const step = await runStep('stuck', () => new Promise(() => {}), { deadlineMs: 20 })
    expect(step).toMatchObject({ name: 'stuck', ok: false, detail: { error: 'stuck: missed its 20 ms deadline' } })
  })

  it('fails a throwing step with its message and keeps a failure capture error', async () => {
    const step = await runStep('setup', async () => { throw new Error('no build') }, {
      onFailure: async () => { throw new Error('no renderer') }
    })
    expect(step).toMatchObject({ ok: false, detail: { error: 'no build', failureCapture: 'no renderer' } })
  })

  it('names the failure screenshot after the step', () => {
    expect(failureScreenshotName('app ready')).toBe('e2e-app-ready-failed.png')
  })
})

describe('waitFor', () => {
  it('rejects once the signal aborts', async () => {
    const controller = new AbortController()
    const waiting = waitFor(() => false, controller.signal, 5)
    await delay(15)
    controller.abort()
    await expect(waiting).rejects.toThrow()
  })
})

describe('verdict', () => {
  it('is ok only when every step passed', () => {
    const passed = { name: 'app ready', ok: true, ms: 12, detail: null }
    const failed = { name: 'quit', ok: false, ms: 3, detail: { error: 'x' } }
    expect(verdict([passed])).toEqual({ steps: [passed], ok: true })
    expect(verdict([passed, failed])).toEqual({ steps: [passed, failed], ok: false })
    expect(verdict([]).ok).toBe(false)
    for (const step of verdict([passed, failed]).steps) expect(Object.keys(step)).toEqual(['name', 'ok', 'ms', 'detail'])
  })
})

describe('isolatedEnv', () => {
  it('strips app-redirecting variables and isolates every home under the root', () => {
    const base = {
      Path: 'C:\\node', ELECTRON_RUN_AS_NODE: '1', electron_enable_logging: '1', NODE_OPTIONS: '--inspect',
      DM_SESSION_TOKEN: 'secret', DM_DESKTOP_PIPE: 'pipe', UserProfile: 'C:\\Users\\real', AppData: 'C:\\real', KEEP: 'yes'
    }
    const env = isolatedEnv(base, 'C:\\tmp\\run', 'win32')
    expect(env).toEqual({
      Path: 'C:\\node', KEEP: 'yes',
      HOME: 'C:\\tmp\\run\\home', USERPROFILE: 'C:\\tmp\\run\\home',
      APPDATA: 'C:\\tmp\\run\\home\\AppData\\Roaming', LOCALAPPDATA: 'C:\\tmp\\run\\home\\AppData\\Local',
      CLAUDE_CONFIG_DIR: 'C:\\tmp\\run\\home\\.claude', DARKMECHANICUS_HOME: 'C:\\tmp\\run\\dm-home',
      DISABLE_AUTO_UPDATE: '1', FAKE_AGENT_LOG: 'C:\\tmp\\run\\fake-agent.jsonl'
    })
  })

  it('uses POSIX paths on macOS', () => {
    const env = isolatedEnv({ PATH: '/usr/bin', HOME: '/Users/real' }, '/tmp/run', 'darwin')
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/tmp/run/home', CLAUDE_CONFIG_DIR: '/tmp/run/home/.claude', FAKE_AGENT_LOG: '/tmp/run/fake-agent.jsonl' })
  })
})

describe('writeShim', () => {
  it('writes a CRLF npm-style .cmd whose SHIM_TARGET is the fake-claude.js beside it', () => {
    const directory = temp()
    const shim = writeShim(directory, FIXTURE, 'win32')
    expect(shim).toBe(join(directory, 'fake-claude.cmd'))
    const text = readFileSync(shim, 'utf8')
    expect(text).toBe('@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nnode "%dp0%\\fake-claude.js" %*\r\n')
    const target = [...text.matchAll(SHIM_TARGET)].at(-1)?.[1]
    expect(win32.join(win32.dirname(shim), target)).toBe(win32.join(directory, 'fake-claude.js'))
    expect(readFileSync(join(directory, 'fake-claude.js'), 'utf8'))
      .toBe(`import(require('node:url').pathToFileURL(${JSON.stringify(FIXTURE)}).href)\n`)
  })

  it('writes an executable sh shim on POSIX', () => {
    const directory = temp()
    const shim = writeShim(directory, "/repo/it's/fakeAgentCli.mjs", 'darwin')
    expect(shim).toBe(join(directory, 'fake-claude'))
    expect(readFileSync(shim, 'utf8')).toBe(`#!/bin/sh\nexec node '/repo/it'\\''s/fakeAgentCli.mjs' "$@"\n`)
    if (process.platform !== 'win32') expect(statSync(shim).mode & 0o111).toBe(0o111)
  })

  it.runIf(process.platform === 'win32')('runs through cmd.exe and reports signed in', () => {
    const shim = writeShim(temp(), FIXTURE, 'win32')
    const env = { ...process.env }
    delete env.FAKE_AGENT_SIGNED_OUT
    delete env.FAKE_AGENT_LOG
    // The shim runs `node` from Path: put this Node first in the existing key, whatever its case.
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'Path'
    env[pathKey] = [dirname(process.execPath), env[pathKey]].filter(Boolean).join(delimiter)
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', `"${shim}" auth status`], { env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('{"loggedIn":true}')
  })

  it.runIf(process.platform !== 'win32')('runs the sh shim and reports signed in', () => {
    const shim = writeShim(temp(), FIXTURE)
    const env = { ...process.env }
    delete env.FAKE_AGENT_SIGNED_OUT
    delete env.FAKE_AGENT_LOG
    const result = spawnSync(shim, ['auth', 'status'], { env, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe('{"loggedIn":true}')
  })
})

describe('wrapperSource', () => {
  it('points Electron home at the isolated home before loading the built app', () => {
    const source = wrapperSource({ repo: 'C:\\repo', main: 'C:\\repo\\out\\main\\index.js', home: 'C:\\tmp\\run\\home' })
    const lines = source.split('\n')
    const home = lines.indexOf(`app.setPath('home', ${JSON.stringify('C:\\tmp\\run\\home')})`)
    const main = lines.indexOf(`require(${JSON.stringify('C:\\repo\\out\\main\\index.js')})`)
    expect(home).toBeGreaterThan(0)
    expect(main).toBeGreaterThan(home)
    expect(source).toContain(`app.setAppPath(${JSON.stringify('C:\\repo')})`)
  })
})

describe('fakeAgentPids', () => {
  it('keeps protocol and TUI pids once, and drops short-lived version and auth invocations', () => {
    const log = [
      { mode: 'version', pid: 10, argv: ['--version'] },
      { mode: 'auth', pid: 11, argv: ['auth', 'status'] },
      { mode: 'claude', pid: 12, argv: ['-p'] },
      { mode: 'tui', pid: 13, argv: [] },
      { mode: 'omp', pid: 14, argv: ['--mode', 'rpc'] },
      { mode: 'claude', pid: 12, argv: ['-p'] }
    ].map((entry) => JSON.stringify(entry)).join('\r\n')
    expect(fakeAgentPids(`${log}\r\n`)).toEqual([12, 13, 14])
    expect(fakeAgentPids('')).toEqual([])
  })

  it('refuses a line without a pid', () => {
    expect(() => fakeAgentPids('{"mode":"claude"}\n')).toThrow('without a pid')
  })
})

describe('isAlive', () => {
  const failing = (code) => () => { throw Object.assign(new Error(code), { code }) }

  it('reads ESRCH as dead and EPERM as alive', () => {
    expect(isAlive(1, failing('ESRCH'))).toBe(false)
    expect(isAlive(1, failing('EPERM'))).toBe(true)
    expect(isAlive(1, () => true)).toBe(true)
    expect(() => isAlive(1, failing('EINVAL'))).toThrow('EINVAL')
  })

  it('sees this process alive and an exited child dead', () => {
    expect(isAlive(process.pid)).toBe(true)
    const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
    expect(isAlive(Number(child.stdout))).toBe(false)
  })
})
