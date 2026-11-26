import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveClaudeExecutable } from '../src/main/terminals/claudeExecutable'
import {
  assertHandoffOrder,
  assertToggleLaunches,
  chatLaunches,
  failureScreenshotName,
  fakeAgentLog,
  fakeAgentPids,
  isAlive,
  isolatedEnv,
  parseArgs,
  pngSize,
  replyAfter,
  runStep,
  turnEnded,
  verdict,
  waitFor,
  withNodeFirst,
  wrapperSource,
  writeShim
} from './e2e-agent-chat.mjs'

const FIXTURE = resolve('src', 'main', 'agentChat', '__fixtures__', 'fakeAgentCli.mjs')
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
      CLAUDE_CONFIG_DIR: 'C:\\tmp\\run\\home\\.claude', PI_CODING_AGENT_DIR: 'C:\\tmp\\run\\home\\.omp\\agent',
      CODEX_HOME: 'C:\\tmp\\run\\home\\.codex', DARKMECHANICUS_HOME: 'C:\\tmp\\run\\dm-home',
      DISABLE_AUTO_UPDATE: '1', FAKE_AGENT_LOG: 'C:\\tmp\\run\\fake-agent.jsonl', FAKE_AGENT_SESSION_FILES: '1', FAKE_AGENT_CONTINUE_TURNS: '1'
    })
  })

  it('replaces inherited OMP and Codex folders in any letter case', () => {
    const env = isolatedEnv({ pi_coding_agent_dir: 'C:\\Users\\real\\.omp\\agent', Codex_Home: 'C:\\Users\\real\\.codex' }, 'C:\\tmp\\run', 'win32')
    expect(Object.keys(env).filter((key) => /^(pi_coding_agent_dir|codex_home)$/i.test(key))).toEqual(['PI_CODING_AGENT_DIR', 'CODEX_HOME'])
    expect(JSON.stringify(env)).not.toContain('real')
  })

  it('uses POSIX paths on macOS', () => {
    const env = isolatedEnv({ PATH: '/usr/bin', HOME: '/Users/real' }, '/tmp/run', 'darwin')
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/tmp/run/home', CLAUDE_CONFIG_DIR: '/tmp/run/home/.claude', CODEX_HOME: '/tmp/run/home/.codex', FAKE_AGENT_LOG: '/tmp/run/fake-agent.jsonl' })
  })
})

describe('withNodeFirst', () => {
  it('puts the Node folder first on the one PATH key, whatever its case', () => {
    expect(withNodeFirst({ Path: 'C:\\Windows' }, 'C:\\node\\node.exe', 'win32')).toEqual({ Path: 'C:\\node;C:\\Windows' })
    expect(withNodeFirst({}, '/opt/node/bin/node', 'darwin')).toEqual({ PATH: '/opt/node/bin' })
  })
})

describe('writeShim', () => {
  it('writes a CRLF npm-style .cmd that the app\'s own shim resolution follows to the fake-claude.js beside it', () => {
    const directory = temp()
    const shim = writeShim(directory, FIXTURE, 'win32')
    expect(shim).toBe(join(directory, 'fake-claude.cmd'))
    const text = readFileSync(shim, 'utf8')
    expect(text).toBe('@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nnode "%dp0%\\fake-claude.js" %*\r\n')
    expect(resolveClaudeExecutable(shim, 'win32', (path) => readFileSync(path, 'utf8'))).toBe(join(directory, 'fake-claude.js'))
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

  it('quits and resizes the app window on the harness\'s messages, and quits when the harness goes away', () => {
    const listeners = {}
    const window = { maximized: true, size: null, isMaximized() { return this.maximized }, unmaximize() { this.maximized = false }, setContentSize(width, height) { this.size = [width, height] } }
    const app = { quits: 0, setAppPath() {}, setPath() {}, quit() { this.quits += 1 } }
    const fakeRequire = (name) => (name === 'electron' ? { app, BrowserWindow: { getAllWindows: () => [window] } } : {})
    const fakeProcess = { on: (event, listener) => { listeners[event] = listener } }
    new Function('require', 'process', wrapperSource({ repo: 'r', main: 'm', home: 'h' }))(fakeRequire, fakeProcess)
    listeners.message({ type: 'resize', width: 1024, height: 768 })
    expect(window).toMatchObject({ maximized: false, size: [1024, 768] })
    listeners.message('quit')
    expect(app.quits).toBe(1)
    listeners.disconnect()
    expect(app.quits).toBe(2)
  })
})

describe('turnEnded', () => {
  const snapshot = (items, status = 'idle') => ({ items, status, pending: null, queued: 0 })
  const user = (text) => ({ kind: 'user_message', text })

  it('matches the turn\'s own message exactly, never an earlier one it prefixes', () => {
    const busy = snapshot([user('hello first'), { kind: 'assistant_text', text: 'Hello world' }], 'idle')
    expect(turnEnded(busy, 'hello').ok).toBe(false)
    expect(turnEnded(snapshot([user('hello first'), user('hello')]), 'hello')).toMatchObject({ ok: true, sent: 1 })
    expect(turnEnded(snapshot([user('hello'), user('hello')], 'busy'), 'hello')).toMatchObject({ ok: false, sent: 1 })
  })

  it('matches a kickoff by its prefix only when asked, and waits for pending or queued input', () => {
    const kickoff = [user('Plan this Dark Mechanicus epic with the person…')]
    expect(turnEnded(snapshot(kickoff), 'Plan this Dark Mechanicus epic').ok).toBe(false)
    expect(turnEnded(snapshot(kickoff), 'Plan this Dark Mechanicus epic', true).ok).toBe(true)
    expect(turnEnded({ ...snapshot(kickoff), pending: { kind: 'approval' } }, 'Plan', true)).toMatchObject({ ok: false, pending: 'approval' })
    expect(turnEnded({ ...snapshot(kickoff), queued: 1 }, 'Plan', true).ok).toBe(false)
  })
})

describe('replyAfter', () => {
  const you = (text) => ({ who: 'You', text })
  const assistant = (text) => ({ who: 'Assistant', text })

  it('takes only the bubble directly after the exact user bubble', () => {
    const messages = [you('hello first'), assistant('Hello world'), you('hello'), assistant('Hello world'), you('[tool]'), assistant('alpha')]
    expect(replyAfter(messages, 'hello', 'Hello world')).toEqual({ index: 3, who: 'Assistant', text: 'Hello world' })
    expect(replyAfter(messages, 'hello first', 'Hello world')).toEqual({ index: 1, who: 'Assistant', text: 'Hello world' })
  })

  it('never lets an earlier prefixed turn or a later reply stand in', () => {
    // Step 2's own reply is missing: step 1's reply (prefix) and step 3's reply (later) must not satisfy it.
    const missing = [you('hello first'), assistant('Hello world'), you('hello'), you('[tool]'), assistant('Hello world')]
    expect(replyAfter(missing, 'hello', 'Hello world')).toBeNull()
    expect(replyAfter([you('hello first'), assistant('Hello world')], 'hello', 'Hello world')).toBeNull()
    expect(replyAfter([you('hello'), assistant('Hello world, again')], 'hello', 'Hello world')).toBeNull()
    expect(replyAfter([you('hello')], 'hello', 'Hello world')).toBeNull()
  })
})

const line = (entry) => JSON.stringify(entry)
const U = '11111111-2222-4333-8444-555555555555'

describe('fakeAgentPids', () => {
  it('keeps protocol and TUI pids once, and drops short-lived version, auth and arbiter invocations', () => {
    const log = [
      { mode: 'version', pid: 10, argv: ['--version'] },
      { mode: 'auth', pid: 11, argv: ['auth', 'status'] },
      { mode: 'claude', pid: 12, argv: ['-p'] },
      { mode: 'tui', pid: 13, argv: [] },
      { mode: 'omp', pid: 14, argv: ['--mode', 'rpc'] },
      { mode: 'arbiter', pid: 15, argv: ['-p', '--output-format', 'json'] },
      { mode: 'claude', pid: 12, argv: ['-p'] }
    ].map(line).join('\r\n')
    expect(fakeAgentPids(`${log}\r\n`)).toEqual([12, 13, 14])
    expect(fakeAgentPids('')).toEqual([])
  })

  it('refuses a line without a pid', () => {
    expect(() => fakeAgentPids('{"mode":"claude"}\n')).toThrow('without a pid')
    expect(() => fakeAgentLog('{"mode":"tui","pid":"7"}\n')).toThrow('without a pid')
  })
})

describe('chatLaunches and assertToggleLaunches', () => {
  const log = [
    { mode: 'auth', pid: 1, at: 1, argv: ['auth', 'status'] },
    { mode: 'claude', pid: 2, at: 10, argv: ['-p', '--output-format', 'stream-json', '--session-id', U], grantHash: 'g1' },
    { mode: 'claude', pid: 3, at: 11, argv: ['-p', '--output-format', 'stream-json', '--session-id', 'other'], grantHash: 'g9' },
    { mode: 'tui', pid: 4, at: 20, argv: ['--append-system-prompt-file', 'i.md', '--resume', U], grantHash: 'g2' },
    { mode: 'arbiter', pid: 5, at: 25, argv: ['-p', '--output-format', 'json', U] },
    { mode: 'claude', pid: 6, at: 30, argv: ['-p', '--output-format', 'stream-json', '--resume', U], grantHash: 'g3' }
  ].map(line).join('\n')

  it('lists one session\'s GUI and terminal launches in order, with the flag naming it', () => {
    expect(chatLaunches(log, U)).toEqual([
      { surface: 'gui', flag: '--session-id', pid: 2, at: 10, grantHash: 'g1' },
      { surface: 'terminal', flag: '--resume', pid: 4, at: 20, grantHash: 'g2' },
      { surface: 'gui', flag: '--resume', pid: 6, at: 30, grantHash: 'g3' }
    ])
    expect(assertToggleLaunches(chatLaunches(log, U))).toMatchObject({ gui: { pid: 2 }, terminal: { pid: 4 }, resumed: { pid: 6 } })
  })

  it('refuses a missing, extra or new-session launch', () => {
    const launches = chatLaunches(log, U)
    expect(() => assertToggleLaunches(launches.slice(0, 2))).toThrow('the log has gui --session-id, terminal --resume.')
    expect(() => assertToggleLaunches([...launches, launches[2]])).toThrow('Expected the launches')
    expect(() => assertToggleLaunches([launches[0], { ...launches[1], flag: '--session-id' }, launches[2]])).toThrow('terminal --session-id')
    expect(() => assertToggleLaunches([])).toThrow('the log has none.')
  })
})

describe('assertHandoffOrder', () => {
  const order = { confirmedAt: 100, terminalExitedAt: 120, grantRevokedAt: 110, resumedAt: 200 }

  it('accepts confirmation, then terminal exit and grant revocation, then the GUI resume', () => {
    expect(assertHandoffOrder(order)).toEqual(order)
  })

  it('refuses any inversion or a missing time', () => {
    expect(() => assertHandoffOrder({ ...order, terminalExitedAt: 90 })).toThrow('terminal exit (90) came before the confirmation')
    expect(() => assertHandoffOrder({ ...order, resumedAt: 115 })).toThrow('GUI resume (115) came before the terminal exit')
    expect(() => assertHandoffOrder({ ...order, grantRevokedAt: 300 })).toThrow('GUI resume (200) came before the grant revocation')
    expect(() => assertHandoffOrder({ ...order, grantRevokedAt: Number.NaN })).toThrow('no grantRevokedAt')
  })
})

describe('pngSize', () => {
  it('reads the IHDR size and refuses anything else', () => {
    const png = Buffer.alloc(24)
    png.writeUInt32BE(0x89504e47, 0)
    png.write('IHDR', 12, 'latin1')
    png.writeUInt32BE(1536, 16)
    png.writeUInt32BE(1152, 20)
    expect(pngSize(png)).toEqual({ width: 1536, height: 1152 })
    expect(() => pngSize(Buffer.from('not a png at all, really'))).toThrow('Not a PNG.')
  })
})

describe('parseArgs', () => {
  it('runs every step in scenario order without --steps, and refuses unknown steps', () => {
    expect(parseArgs(['--out', 'x']).keys).toEqual(['ready', 'new-chat', 'stream', 'tool', 'approval', 'todo', 'toggle', 'epic-agent', 'quit'])
    expect(parseArgs(['--out', 'x', '--steps', 'ready,quit']).keys).toEqual(['ready', 'quit'])
    expect(() => parseArgs(['--out', 'x', '--steps', 'ready,nope'])).toThrow('Unknown step(s) nope')
    expect(() => parseArgs([])).toThrow('Usage')
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
