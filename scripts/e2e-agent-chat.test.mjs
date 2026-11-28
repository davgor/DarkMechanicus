import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { folderStoreId } from '../src/main/agentChat/folderStoreId'
import { resolveAgentExecutable } from '../src/main/terminals/agentExecutable'
import {
  assertHandoffOrder,
  assertToggleLaunches,
  browserToolCalls,
  chatLaunches,
  claudeSessionPath,
  consoleText,
  coordLaunches,
  coordMailBody,
  evidenceComment,
  failureScreenshotName,
  fakeAgentLog,
  fakeAgentPids,
  fakeControls,
  imageEchoLine,
  isAlive,
  isolatedEnv,
  launchModelFlags,
  newChatLaunch,
  newerVersion,
  parseArgs,
  pngSize,
  refusedImages,
  removeStaleRoots,
  replyAfter,
  restartChat,
  restartMarker,
  restartResumeText,
  restartTurn,
  runStep,
  seededAgents,
  sha12,
  siteFile,
  staleRoots,
  stepPhases,
  switchControls,
  transcriptImageRefs,
  turnEnded,
  verdict,
  viewTarget,
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
      DM_SESSION_TOKEN: 'secret', DM_DESKTOP_PIPE: 'pipe', DM_BROWSER_PIPE: 'browser-pipe', UserProfile: 'C:\\Users\\real', AppData: 'C:\\real', KEEP: 'yes'
    }
    const env = isolatedEnv(base, 'C:\\tmp\\run', 'win32')
    expect(env).toEqual({
      Path: 'C:\\node', KEEP: 'yes',
      HOME: 'C:\\tmp\\run\\home', USERPROFILE: 'C:\\tmp\\run\\home',
      APPDATA: 'C:\\tmp\\run\\home\\AppData\\Roaming', LOCALAPPDATA: 'C:\\tmp\\run\\home\\AppData\\Local',
      CLAUDE_CONFIG_DIR: 'C:\\tmp\\run\\home\\.claude', PI_CODING_AGENT_DIR: 'C:\\tmp\\run\\home\\.omp\\agent',
      CODEX_HOME: 'C:\\tmp\\run\\home\\.codex', DARKMECHANICUS_HOME: 'C:\\tmp\\run\\dm-home',
      DISABLE_AUTO_UPDATE: '1', FAKE_AGENT_LOG: 'C:\\tmp\\run\\fake-agent.jsonl', FAKE_AGENT_SESSION_FILES: '1', FAKE_AGENT_CONTINUE_TURNS: '1',
      FAKE_AGENT_NAME_CHATS: '1'
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
    expect(resolveAgentExecutable(shim, 'win32', (path) => readFileSync(path, 'utf8'))).toBe(join(directory, 'fake-claude.js'))
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

describe('writeShim: fake-omp', () => {
  it('writes a fake-omp .cmd and .js beside fake-claude; the .js names the OMP persona before loading the fake', () => {
    const directory = temp()
    const claude = writeShim(directory, FIXTURE, 'win32')
    const omp = writeShim(directory, FIXTURE, 'win32', 'omp')
    expect(omp).toBe(join(directory, 'fake-omp.cmd'))
    expect(readFileSync(omp, 'utf8')).toBe('@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nnode "%dp0%\\fake-omp.js" %*\r\n')
    expect(resolveAgentExecutable(omp, 'win32', (path) => readFileSync(path, 'utf8'))).toBe(join(directory, 'fake-omp.js'))
    expect(readFileSync(join(directory, 'fake-omp.js'), 'utf8'))
      .toBe(`process.env.FAKE_AGENT_PERSONA = 'omp'\nimport(require('node:url').pathToFileURL(${JSON.stringify(FIXTURE)}).href)\n`)
    expect(resolveAgentExecutable(claude, 'win32', (path) => readFileSync(path, 'utf8'))).toBe(join(directory, 'fake-claude.js'))
  })

  it('writes an executable fake-omp sh shim that exports the OMP persona on POSIX', () => {
    const directory = temp()
    const shim = writeShim(directory, '/repo/fakeAgentCli.mjs', 'darwin', 'omp')
    expect(shim).toBe(join(directory, 'fake-omp'))
    expect(readFileSync(shim, 'utf8')).toBe(`#!/bin/sh\nexport FAKE_AGENT_PERSONA=omp\nexec node '/repo/fakeAgentCli.mjs' "$@"\n`)
  })

  /** Runs a seeded shim as the app's probes do: through cmd.exe on Windows, directly on POSIX. */
  const runShim = (shim, args) => {
    const env = { ...process.env }
    delete env.FAKE_AGENT_SIGNED_OUT
    delete env.FAKE_AGENT_LOG
    delete env.FAKE_AGENT_PERSONA
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
    env[pathKey] = [dirname(process.execPath), env[pathKey]].filter(Boolean).join(delimiter)
    return process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', `"${shim}" ${args.join(' ')}`], { env, encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true })
      : spawnSync(shim, args, { env, encoding: 'utf8' })
  }

  it('seeds both shims in one folder, each answering version and sign-in as its own CLI', () => {
    const directory = temp()
    const claude = writeShim(directory, FIXTURE, process.platform)
    const omp = writeShim(directory, FIXTURE, process.platform, 'omp')
    const results = [[claude, ['--version']], [claude, ['auth', 'status']], [omp, ['--version']], [omp, ['usage', '--json']]].map(([shim, args]) => runShim(shim, args))
    for (const result of results) expect(result.status, result.stderr).toBe(0)
    expect(results.map((result) => result.stdout.trim())).toEqual([
      '2.1.329 (Claude Code)',
      '{"loggedIn":true}',
      'omp/18.16.0',
      '{"reports":[{"provider":"fixture","accounts":1}],"accountsWithoutUsage":[],"disabledCredentials":[]}'
    ])
  })
})

describe('seededAgents', () => {
  const shims = { claude: 'C:\\run\\shim\\fake-claude.cmd', omp: 'C:\\run\\shim\\fake-omp.cmd' }

  it('connects the claude fake alone by default, and the omp fake beside it for --agent omp or when asked to', () => {
    expect(seededAgents(shims, 'claude')).toEqual([{ kind: 'claude', executablePath: shims.claude, version: '2.1.329' }])
    const both = [
      { kind: 'claude', executablePath: shims.claude, version: '2.1.329' },
      { kind: 'omp', executablePath: shims.omp, version: '18.16.0' }
    ]
    expect(seededAgents(shims, 'omp')).toEqual(both)
    expect(seededAgents(shims, 'claude', true)).toEqual(both)
  })
})

describe('newChatLaunch', () => {
  const entry = (mode, persona, pid) => JSON.stringify({ mode, persona, pid, at: pid, argv: [`--${mode}`], cwd: 'C:\\repo' })

  it('finds the one GUI launch whose mode and persona are the selected kind', () => {
    const log = [entry('version', 'omp', 1), entry('auth', 'omp', 2), entry('claude', 'claude', 3), entry('omp', 'omp', 4)].join('\n')
    expect(newChatLaunch(log, 'omp')).toEqual({ mode: 'omp', persona: 'omp', pid: 4, cwd: 'C:\\repo', argv: ['--omp'] })
    expect(newChatLaunch(log, 'claude')).toMatchObject({ mode: 'claude', persona: 'claude', pid: 3 })
  })

  it('refuses none or more than one', () => {
    expect(() => newChatLaunch(entry('claude', 'claude', 3), 'omp')).toThrow('Expected one omp GUI launch; the log has 0.')
    expect(() => newChatLaunch([entry('omp', 'omp', 4), entry('omp', 'omp', 5)].join('\n'), 'omp')).toThrow('the log has 2')
  })
})

describe('wrapperSource', () => {
  it('points Electron home at the isolated home and sets the package version before loading the built app', () => {
    const source = wrapperSource({ repo: 'C:\\repo', main: 'C:\\repo\\out\\main\\index.js', home: 'C:\\tmp\\run\\home', version: '0.83.0' })
    const lines = source.split('\n')
    const home = lines.indexOf(`app.setPath('home', ${JSON.stringify('C:\\tmp\\run\\home')})`)
    const version = lines.indexOf(`app.setVersion("0.83.0")`)
    const main = lines.indexOf(`require(${JSON.stringify('C:\\repo\\out\\main\\index.js')})`)
    expect(home).toBeGreaterThan(0)
    expect(version).toBeGreaterThan(0)
    expect(main).toBeGreaterThan(Math.max(home, version))
    expect(source).toContain(`app.setAppPath(${JSON.stringify('C:\\repo')})`)
  })

  it('turns off Windows native occlusion before the app loads, so a covered window still lays out its resizes', () => {
    const lines = wrapperSource({ repo: 'r', main: 'm', home: 'h', version: '1.0.0' }).split('\n')
    const occlusion = lines.indexOf(`app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')`)
    expect(occlusion).toBeGreaterThan(0)
    expect(occlusion).toBeLessThan(lines.indexOf('require("m")'))
  })

  it('quits and resizes the app window on the harness\'s messages, and quits when the harness goes away', () => {
    const listeners = {}
    const window = { maximized: true, size: null, isMaximized() { return this.maximized }, unmaximize() { this.maximized = false }, setContentSize(width, height) { this.size = [width, height] } }
    const app = { quits: 0, commandLine: { appendSwitch() {} }, setAppPath() {}, setPath() {}, setVersion() {}, quit() { this.quits += 1 } }
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
    expect(parseArgs(['--out', 'x']).keys).toEqual(['ready', 'new-chat', 'stream', 'tool', 'approval', 'todo', 'toggle', 'epic-agent', 'quit', 'restart-resume'])
    expect(parseArgs(['--out', 'x', '--steps', 'restart-resume']).keys).toEqual(['restart-resume'])
    expect(parseArgs(['--out', 'x', '--steps', 'ready,quit']).keys).toEqual(['ready', 'quit'])
    expect(() => parseArgs(['--out', 'x', '--steps', 'ready,nope'])).toThrow('Unknown step(s) nope')
    expect(() => parseArgs([])).toThrow('Usage')
  })

  it('takes a packaged exe, resolved, and refuses --exe without a path', () => {
    expect(parseArgs(['--out', 'x']).exe).toBeNull()
    expect(parseArgs(['--out', 'x', '--exe', 'app/DarkMechanicus.exe'])).toMatchObject({ exe: resolve('app/DarkMechanicus.exe'), out: resolve('x') })
    expect(() => parseArgs(['--out', 'x', '--exe'])).toThrow('--exe needs the path')
  })

  it('selects the fixture chats\' agent kind: claude by default, omp only for the steps the omp fake runs', () => {
    expect(parseArgs(['--out', 'x']).agent).toBe('claude')
    expect(parseArgs(['--out', 'x', '--agent', 'omp'])).toMatchObject({ agent: 'omp', keys: ['ready', 'new-chat', 'quit'] })
    expect(parseArgs(['--out', 'x', '--agent', 'omp', '--steps', 'ready,new-chat']).keys).toEqual(['ready', 'new-chat'])
    expect(() => parseArgs(['--out', 'x', '--agent', 'omp', '--steps', 'ready,stream'])).toThrow('--agent omp runs only ready, new-chat, quit, coord-tabs, coord-mail, coord-wake, coord-close, model-pick, model-busy, model-restart, polish-multiquestion; stream drive the claude fake.')
    expect(() => parseArgs(['--out', 'x', '--agent', 'codex'])).toThrow('--agent takes claude or omp, not codex.')
    expect(() => parseArgs(['--out', 'x', '--agent'])).toThrow('--agent takes claude or omp, not nothing.')
  })

  it('runs the polish steps only when named, in the order given, after ready; claude only but polish-multiquestion', () => {
    const polish = ['polish-picker', 'polish-composer', 'polish-copy', 'polish-multiselect', 'polish-worked-for', 'polish-untrack']
    expect(parseArgs(['--out', 'x']).keys.filter((key) => key.startsWith('polish-'))).toEqual([])
    expect(parseArgs(['--out', 'x', '--steps', polish.join(',')]).keys).toEqual(['ready', ...polish])
    expect(parseArgs(['--out', 'x', '--steps', `ready,${polish[0]}`]).keys).toEqual(['ready', polish[0]])
    expect(parseArgs(['--out', 'x', '--steps', 'quit']).keys).toEqual(['ready', 'quit'])
    expect(() => parseArgs(['--out', 'x', '--agent', 'omp', '--steps', 'polish-picker'])).toThrow('polish-picker drive the claude fake.')
    expect(parseArgs(['--out', 'x', '--steps', 'polish-multiquestion'])).toMatchObject({ agent: 'omp', keys: ['ready', 'polish-multiquestion'] })
    expect(() => parseArgs(['--out', 'x', '--agent', 'claude', '--steps', 'polish-multiquestion'])).toThrow('polish-multiquestion drive the omp fake: leave out --agent claude.')
  })

  it('runs the browser steps only when named, on the claude default with their fixed deadlines; never with --agent omp', () => {
    const browser = ['browser-drive', 'browser-skitarii', 'browser-shot', 'browser-guard', 'browser-signin']
    expect(parseArgs(['--out', 'x']).keys.filter((key) => key.startsWith('browser-'))).toEqual([])
    const parsed = parseArgs(['--out', 'x', '--steps', [...browser, 'quit'].join(',')])
    expect(parsed).toMatchObject({ agent: 'claude', keys: ['ready', ...browser, 'quit'] })
    expect(stepPhases(parsed.keys).map((phase) => [phase.name, phase.deadlineMs])).toEqual([
      ['app ready', undefined], ['browser-drive', 60_000], ['browser-skitarii', 60_000], ['browser-shot', 30_000],
      ['browser-guard', 30_000], ['browser-signin', 20_000], ['quit', undefined]
    ])
    expect(parseArgs(['--out', 'x', '--steps', 'browser-skitarii']).agent).toBe('claude')
    expect(parseArgs(['--out', 'x', '--agent', 'claude', '--steps', 'browser-skitarii']).keys).toEqual(['ready', 'browser-skitarii'])
    expect(() => parseArgs(['--out', 'x', '--agent', 'omp', '--steps', 'browser-drive,browser-skitarii'])).toThrow('browser-drive, browser-skitarii run on the claude default: leave out --agent omp.')
  })
})

describe('polish verdict', () => {
  it('names one verdict step per polish step, each {name, ok, ms, detail}, run once under the deadline', async () => {
    const keys = parseArgs(['--out', 'x', '--steps', 'polish-picker,polish-composer,polish-copy,polish-multiselect,polish-worked-for,polish-untrack']).keys
    const phases = stepPhases(keys)
    expect(phases.map((phase) => phase.name)).toEqual([
      'app ready', 'polish-picker', 'polish-composer', 'polish-copy', 'polish-multiselect', 'polish-worked-for', 'polish-untrack'
    ])
    const runs = []
    const steps = []
    for (const phase of phases) {
      steps.push(await runStep(phase.name, async () => { runs.push(phase.name); return { screenshot: { file: `e2e-${phase.name}.png` } } }))
    }
    const result = JSON.parse(JSON.stringify(verdict(steps)))
    expect(runs).toEqual(phases.map((phase) => phase.name))
    expect(result.ok).toBe(true)
    for (const step of result.steps) {
      expect(Object.keys(step)).toEqual(['name', 'ok', 'ms', 'detail'])
      expect(step.ms).toBeLessThan(10_000)
    }
  })

  it('keeps every classic step\'s phases, restart-resume\'s seven included', () => {
    expect(stepPhases(['restart-resume']).map((phase) => phase.name)).toHaveLength(7)
    expect(stepPhases(['ready', 'quit']).map((phase) => phase.name)).toEqual(['app ready', 'quit'])
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

/** A harness root under `parent`, owned by `pid` (none: no owner file). */
const root = (parent, name, pid) => {
  const path = join(parent, name)
  mkdirSync(join(path, 'user-data'), { recursive: true })
  if (pid !== undefined) writeFileSync(join(path, 'harness.json'), JSON.stringify({ pid }))
  return path
}

describe('stale isolated roots', () => {
  it('are the harness roots whose owner is gone, or ownerless ones older than any run; others and live ones stay', () => {
    const parent = temp()
    const dead = root(parent, 'dm-e2e-agent-chat-dead', 111)
    const live = root(parent, 'dm-e2e-agent-chat-live', 222)
    const fresh = root(parent, 'dm-e2e-agent-chat-fresh')
    const old = root(parent, 'dm-e2e-agent-chat-old')
    const past = new Date(Date.now() - 7 * 60 * 60_000)
    utimesSync(old, past, past)
    root(parent, 'other-run-dead', 111)
    const alive = (pid) => pid === 222
    expect(staleRoots(parent, alive).sort()).toEqual([dead, old].sort())
    expect(removeStaleRoots(parent, alive).removed.sort()).toEqual([dead, old].sort())
    expect([dead, live, fresh, old].map((path) => existsSync(path))).toEqual([false, true, true, false])
  })

  it('keep a two-minute-old ownerless root: a live run of a harness from before owner files', () => {
    const parent = temp()
    const running = root(parent, 'dm-e2e-agent-chat-running')
    const past = new Date(Date.now() - 120_000)
    utimesSync(running, past, past)
    expect(staleRoots(parent, () => false)).toEqual([])
    expect(removeStaleRoots(parent, () => false)).toEqual({ removed: [] })
    expect(existsSync(running)).toBe(true)
  })
})

describe('a sweep racing other runs', () => {
  it('skips a root that disappears during the sweep', () => {
    const parent = temp()
    const roots = [root(parent, 'dm-e2e-agent-chat-a', 222), root(parent, 'dm-e2e-agent-chat-b', 222)]
    // The first owner checked is a run finishing: both roots go before the sweep reaches the second one.
    const alive = () => {
      for (const path of roots) rmSync(path, { recursive: true, force: true })
      return true
    }
    expect(staleRoots(parent, alive)).toEqual([])
    expect(roots.map((path) => existsSync(path))).toEqual([false, false])
  })

  it('includes the root of a run that was killed, and the next run removes it', () => {
    const parent = temp()
    const script = `const { mkdtempSync, writeFileSync } = require('node:fs'); const { join } = require('node:path')
      const root = mkdtempSync(join(${JSON.stringify(parent)}, 'dm-e2e-agent-chat-'))
      writeFileSync(join(root, 'harness.json'), JSON.stringify({ pid: process.pid }))
      process.kill(process.pid, 'SIGKILL')`
    spawnSync(process.execPath, ['-e', script])
    const [killed] = staleRoots(parent)
    expect(killed).toBeDefined()
    expect(removeStaleRoots(parent)).toEqual({ removed: [killed] })
    expect(existsSync(killed)).toBe(false)
  })
})

/** `restartResume.ts`'s `restartMarkerSchema`, restated: strict, `x.y.z`, an ISO datetime, at most 20 non-empty chats. */
function assertRestartMarkerShape(marker) {
  expect(Object.keys(marker).sort()).toEqual(['chats', 'fromVersion', 'writtenAt'])
  expect(marker.fromVersion).toMatch(/^\d+\.\d+\.\d+$/)
  expect(marker.writtenAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/)
  expect(Number.isNaN(Date.parse(marker.writtenAt))).toBe(false)
  expect(Array.isArray(marker.chats) && marker.chats.length <= 20).toBe(true)
  for (const chat of marker.chats) {
    expect(Object.keys(chat).sort()).toEqual(['chatId', 'folder'])
    expect(typeof chat.folder === 'string' && chat.folder.length > 0).toBe(true)
    expect(typeof chat.chatId === 'string' && chat.chatId.length > 0).toBe(true)
  }
}

describe('restart-resume seeding', () => {
  const folder = join(tmpdir(), 'e2e-repo')

  it('writes a marker the marker schema accepts, listing the seeded chat', () => {
    const marker = restartMarker({ fromVersion: '0.0.1', writtenAt: new Date().toISOString(), folder, chatId: 'ch_1' })
    assertRestartMarkerShape(marker)
    expect(marker).toEqual({ fromVersion: '0.0.1', writtenAt: expect.any(String), chats: [{ folder, chatId: 'ch_1' }] })
  })

  it('creates a run-bound orchestrator GUI chat of the claude-kind fake through the store, then gives it session U', () => {
    const sessionId = '0d5c8e2a-7f41-4b6e-9a3d-5e8f1c2b4a60'
    const { create, patch } = restartChat({ folder, epicId: 'ep_1', sessionId })
    expect(create).toEqual({
      folder, agent: 'claude', model: null, role: 'orchestrator', allowSave: true, epicId: 'ep_1', surface: 'gui', title: 'Restart resume Magos'
    })
    // Only NewChat's fields: the seeder adds the started run's id, and the patch sets the session id createChat leaves null.
    const newChat = ['folder', 'agent', 'model', 'role', 'allowSave', 'epicId', 'surface', 'title', 'runId']
    expect(Object.keys(create).filter((key) => !newChat.includes(key))).toEqual([])
    expect(patch).toEqual({ sessionId })
  })

  it('puts the fake session where claudeSession.ts looks for it', () => {
    expect(claudeSessionPath(join('C:', 'cfg'), 'C:\\Users\\a b\\e2e-repo', 'u-1'))
      .toBe(join('C:', 'cfg', 'projects', 'C--Users-a-b-e2e-repo', 'u-1.jsonl'))
  })

  it('builds the fixed restart text and compares versions numerically', () => {
    expect(restartResumeText('0.0.1', '0.83.0')).toBe('[App restarted after an update from v0.0.1 to v0.83.0: resume your run from get_run]')
    expect(newerVersion('0.83.0', '0.0.1')).toBe(true)
    expect(newerVersion('0.10.0', '0.9.9')).toBe(true)
    expect(newerVersion('0.83.0', '0.83.0')).toBe(false)
    expect(newerVersion('0.0.1', '0.83.0')).toBe(false)
  })

  it('accepts exactly one restart message followed by the reply', () => {
    const text = restartResumeText('0.0.1', '0.83.0')
    const user = (id, value) => ({ id, kind: 'user_message', text: value })
    const reply = (id, value) => ({ id, kind: 'assistant_text', text: value })
    expect(restartTurn([user('1', text), reply('2', 'Hello world')], text, 'Hello world')).toEqual({ ok: true, messages: 1, reply: 'Hello world' })
    expect(restartTurn([user('1', text)], text, 'Hello world').ok).toBe(false)
    expect(restartTurn([user('1', text), reply('2', 'Hello world'), user('3', text), reply('4', 'Hello world')], text, 'Hello world'))
      .toEqual({ ok: false, messages: 2, reply: 'Hello world' })
    expect(restartTurn([user('1', 'hello'), reply('2', 'Hello world')], text, 'Hello world').messages).toBe(0)
  })
})

describe('image steps', () => {
  const swatch = readFileSync(resolve('src', 'main', 'agentChat', '__fixtures__', 'images', 'swatch.png'))

  it('run only when named, after ready, each its own verdict step', () => {
    expect(parseArgs(['--out', 'x']).keys.filter((key) => key.startsWith('image-'))).toEqual([])
    const keys = parseArgs(['--out', 'x', '--steps', 'image-send,image-result']).keys
    expect(keys).toEqual(['ready', 'image-send', 'image-result'])
    expect(stepPhases(keys).map((phase) => phase.name)).toEqual(['app ready', 'image-send', 'image-result'])
    expect(() => parseArgs(['--out', 'x', '--agent', 'omp', '--steps', 'image-send'])).toThrow('image-send drive the claude fake.')
  })

  it('names swatch.png by mime, size and the first 12 hex digits of its sha256, as the fake echoes it', () => {
    expect(sha12(swatch)).toBe('6f7ffeeb8892')
    expect(sha12(Buffer.from('abc'))).toBe('ba7816bf8f01')
    expect(imageEchoLine('image/png', swatch)).toBe('received image image/png 132 6f7ffeeb8892')
  })

  it('reads a transcript file\'s last user message line and searches the whole file, CRLF included', () => {
    const needle = swatch.toString('base64').slice(0, 32)
    const ref = { id: 'img-1', mime: 'image/png', width: 64, height: 64, bytes: 132 }
    const lines = [
      { id: 'u1', kind: 'user_message', text: 'look' },
      { id: 'a1', kind: 'assistant_text', text: 'received image' },
      { id: 'u1', kind: 'user_message', text: 'look', images: [ref] }
    ].map((item) => JSON.stringify(item))
    expect(transcriptImageRefs(`${lines.join('\r\n')}\r\n`, 'look', needle)).toEqual({ found: true, images: [ref], needleFound: false })
    expect(transcriptImageRefs(`${lines[0]}\n`, 'look', needle)).toEqual({ found: true, images: [], needleFound: false })
    expect(transcriptImageRefs(`${lines.join('\n')}\n${JSON.stringify({ id: 't1', kind: 'tool_call', output: needle })}\n`, 'look', needle).needleFound).toBe(true)
    expect(transcriptImageRefs('', 'look', needle)).toEqual({ found: false, images: [], needleFound: false })
  })

  it('accepts exactly one comment with exactly one attachment of the expected sha256', () => {
    const attachment = (sha256) => ({ id: 'at-1', sha256, mime: 'image/png', bytes: 132, width: 64, height: 64, label: 'Chat image', purpose: 'evidence' })
    const comment = (attachments) => ({ id: 'c-1', epicId: 'e', ticketId: null, body: 'Evidence', author: { role: 'desktop', label: 'x' }, createdAt: 't', attachments })
    expect(evidenceComment([comment([attachment('aa')])], 'aa')).toEqual({
      ok: true, comments: [{ id: 'c-1', ticketId: null, body: 'Evidence', attachments: [{ id: 'at-1', sha256: 'aa', mime: 'image/png', bytes: 132, purpose: 'evidence' }] }]
    })
    expect(evidenceComment([comment([attachment('bb')])], 'aa').ok).toBe(false)
    expect(evidenceComment([comment([attachment('aa'), attachment('aa')])], 'aa').ok).toBe(false)
    expect(evidenceComment([comment([attachment('aa')]), comment([attachment('aa')])], 'aa').ok).toBe(false)
    expect(evidenceComment([{ ...comment([]), attachments: undefined }], 'aa').ok).toBe(false)
    expect(evidenceComment([], 'aa').ok).toBe(false)
  })

  it('collects console and log text and finds image refusals', () => {
    const refusal = 'Refused to load the image \'dm-chat-image://k/c/i\' because it violates the following Content Security Policy directive: "img-src \'self\'".'
    expect(consoleText({ method: 'Log.entryAdded', params: { entry: { source: 'security', level: 'error', text: refusal } } })).toBe(refusal)
    expect(consoleText({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: 'a' }, { type: 'number', value: 2 }, { type: 'object', description: 'Object' }] } }))
      .toBe('a 2 Object')
    expect(consoleText({ method: 'Page.loadEventFired', params: {} })).toBeNull()
    const blocked = 'Loading the image \'dm-chat-image://k/c/i\' violates the following Content Security Policy directive: "img-src \'self\' data: dm-attachment:". The action has been blocked.'
    expect(refusedImages(['fine', refusal, blocked, 'Loading the image editor'])).toEqual([refusal, blocked])
  })
})

describe('coord steps', () => {
  const coord = ['coord-tabs', 'coord-mail', 'coord-wake', 'coord-close']

  it('run only when named, after ready, each its own verdict step, with the omp fake', () => {
    expect(parseArgs(['--out', 'x']).keys.filter((key) => key.startsWith('coord-'))).toEqual([])
    expect(parseArgs(['--out', 'x', '--agent', 'omp']).keys.filter((key) => key.startsWith('coord-'))).toEqual([])
    const parsed = parseArgs(['--out', 'x', '--steps', coord.join(',')])
    expect(parsed).toMatchObject({ agent: 'omp', keys: ['ready', ...coord] })
    expect(stepPhases(parsed.keys).map((phase) => phase.name)).toEqual(['app ready', ...coord])
    expect(parseArgs(['--out', 'x', '--agent', 'omp', '--steps', 'coord-tabs,coord-mail'])).toMatchObject({ agent: 'omp', keys: ['ready', 'coord-tabs', 'coord-mail'] })
    expect(() => parseArgs(['--out', 'x', '--agent', 'claude', '--steps', 'coord-tabs'])).toThrow('coord-tabs drive the omp fake: leave out --agent claude.')
    expect(() => parseArgs(['--out', 'x', '--steps', 'coord-tabs,stream'])).toThrow('stream drive the claude fake.')
  })

  it('find a chat\'s launches by the chat id its OMP session folder names, telling GUI from terminal (PTY) ones', () => {
    const entry = (mode, pid, argv) => JSON.stringify({ mode, persona: 'omp', pid, at: pid, argv })
    const dir = (chatId) => `C:\\u\\agents\\omp\\${chatId}\\sessions`
    const log = [
      entry('omp', 1, ['--mode', 'rpc-ui', '--session-dir', dir('chat_lex')]),
      entry('version', 2, ['--version']),
      entry('omp', 3, ['--mode', 'rpc-ui', '--session-dir', dir('chat_magos')]),
      entry('tui', 4, ['--session-dir', dir('chat_lex'), '--resume', 's']),
      entry('omp', 5, ['--mode', 'rpc-ui', '--session-dir', dir('chat_lex'), '--resume', 's'])
    ].join('\n')
    expect(coordLaunches(log, 'chat_lex')).toEqual([
      { mode: 'omp', surface: 'gui', pid: 1, at: 1 }, { mode: 'tui', surface: 'terminal', pid: 4, at: 4 }, { mode: 'omp', surface: 'gui', pid: 5, at: 5 }
    ])
    expect(coordLaunches(log, 'chat_magos').map((launch) => launch.pid)).toEqual([3])
    expect(coordLaunches(log, 'chat_none')).toEqual([])
  })

  it('expect the body the fake mails a role with', () => {
    expect(coordMailBody('orchestrator')).toBe('Fake coordination mail for the orchestrator.')
    expect(coordMailBody('planner')).toBe('Fake coordination mail for the planner.')
  })
})

describe('model steps', () => {
  const model = ['model-pick', 'model-busy', 'model-restart']

  it('run only when named, after ready, with the omp fake; model-restart runs as its quit, launch and resumed phases', () => {
    expect(parseArgs(['--out', 'x']).keys.filter((key) => key.startsWith('model-'))).toEqual([])
    expect(parseArgs(['--out', 'x', '--agent', 'omp']).keys.filter((key) => key.startsWith('model-'))).toEqual([])
    const parsed = parseArgs(['--out', 'x', '--steps', model.join(',')])
    expect(parsed).toMatchObject({ agent: 'omp', keys: ['ready', ...model] })
    expect(stepPhases(parsed.keys).map((phase) => phase.name)).toEqual([
      'app ready', 'model-pick', 'model-busy', 'model-restart quit', 'model-restart launch', 'model-restart resumed'
    ])
    expect(() => parseArgs(['--out', 'x', '--agent', 'claude', '--steps', 'model-pick'])).toThrow('model-pick drive the omp fake: leave out --agent claude.')
    expect(() => parseArgs(['--out', 'x', '--steps', 'model-pick,stream'])).toThrow('stream drive the claude fake.')
  })

  it('read the controls one fake run logged since a time, in order', () => {
    const log = [
      { pid: 7, at: 10, type: 'set_model', provider: 'anthropic', modelId: 'claude-opus-5-5', busy: false },
      { pid: 8, at: 20, type: 'set_model', provider: 'openai-codex', modelId: 'gpt-6.1-sol', busy: false },
      { pid: 7, at: 30, type: 'set_model', provider: 'openai-codex', modelId: 'gpt-6.1-sol', busy: true },
      { pid: 7, at: 31, type: 'set_thinking_level', level: 'medium', busy: true }
    ].map((entry) => JSON.stringify(entry)).join('\r\n')
    expect(fakeControls(log, 7).map((entry) => entry.at)).toEqual([10, 30, 31])
    expect(fakeControls(`${log}\n`, 7, 30).map((entry) => entry.type)).toEqual(['set_model', 'set_thinking_level'])
    expect(fakeControls('', 7)).toEqual([])
  })

  it('expect one switch as set_model then set_thinking_level', () => {
    expect(switchControls('openai-codex/gpt-6.1-sol', 'medium')).toEqual([
      { type: 'set_model', provider: 'openai-codex', modelId: 'gpt-6.1-sol' }, { type: 'set_thinking_level', level: 'medium' }
    ])
  })

  it('read a launch\'s --model and --thinking', () => {
    expect(launchModelFlags(['--mode', 'rpc-ui', '--model', 'anthropic/claude-sonnet-5-5', '--thinking', 'high'])).toEqual({ model: 'anthropic/claude-sonnet-5-5', thinking: 'high' })
    expect(launchModelFlags(['--mode', 'rpc-ui'])).toEqual({ model: null, thinking: null })
    expect(launchModelFlags(['--model'])).toEqual({ model: null, thinking: null })
  })
})

describe('siteFile', () => {
  it('names the folder\'s site file by the app\'s own folderStoreId and holds a version 1 list of the origins', () => {
    const folder = 'C:\\Users\\Me\\AppData\\Local\\Temp\\dm-e2e-agent-chat-x\\e2e-repo'
    const file = siteFile('C:\\run\\user-data', folder, ['http://127.0.0.1:4100'], 'win32')
    expect(file.path).toBe(join('C:\\run\\user-data', 'browser', 'sites', `${folderStoreId(folder, 'win32')}.json`))
    expect(JSON.parse(file.text)).toEqual({ version: 1, origins: ['http://127.0.0.1:4100'] })
    expect(siteFile('C:\\run\\user-data', folder.toUpperCase(), [], 'win32').path).toBe(file.path)
    expect(siteFile('/run/user-data', '/tmp/E2E-repo', [], 'linux').path).toBe(join('/run/user-data', 'browser', 'sites', `${folderStoreId('/tmp/E2E-repo', 'linux')}.json`))
    expect(siteFile('/run/user-data', '/tmp/e2e-repo', [], 'linux').path).not.toBe(siteFile('/run/user-data', '/tmp/E2E-repo', [], 'linux').path)
  })
})

describe('viewTarget', () => {
  const app = { id: 'APP', type: 'page', url: 'file:///C:/repo/out/renderer/index.html' }
  const view = { id: 'V1', type: 'page', url: 'http://127.0.0.1:4100/' }
  const other = { id: 'V2', type: 'page', url: 'http://127.0.0.1:4101/' }
  const worker = { id: 'W1', type: 'service_worker', url: 'http://127.0.0.1:4100/' }

  it('finds a browser view by its exact URL or its id, never the app page or a non-page target', () => {
    expect(viewTarget([app, worker, view, other], { url: 'http://127.0.0.1:4100/' })).toBe(view)
    expect(viewTarget([app, view, other], { id: 'V2' })).toBe(other)
    expect(viewTarget([app, view], { url: 'http://127.0.0.1:4100' })).toBeNull()
    expect(viewTarget([app], { id: 'APP' })).toBeNull()
    expect(viewTarget([], { url: 'http://127.0.0.1:4100/' })).toBeNull()
  })

  it('refuses two views showing the URL: the harness could not tell which one it drives', () => {
    expect(() => viewTarget([view, { ...view, id: 'V3' }], { url: view.url })).toThrow('2 browser views show http://127.0.0.1:4100/: V1, V3.')
  })
})

describe('browserToolCalls', () => {
  const bash = (command, resultSummary, status = 'completed') => ({ name: 'Bash', input: { command }, status, resultSummary })

  it('parses the fake\'s dm call browser_* Bash calls in order, with the CLI reply, skipping any other call', () => {
    const tools = [
      { name: 'Read', input: { file_path: 'a' }, status: 'completed', resultSummary: 'x' },
      bash('dm call browser_navigate {"url":"http://127.0.0.1:4100/","as":"Acolyte:DM-442"}', '{"ok":true,"data":{"tab":{"url":"http://127.0.0.1:4100/"}}}'),
      bash('npm test', 'passed'),
      bash('dm call browser_screenshot {"label":"hidden"}', '{"ok":false,"error":{"code":"view_hidden","message":"m"}}', 'failed'),
      bash('dm call browser_read {"mode":"text"}', 'not json')
    ]
    expect(browserToolCalls(tools)).toEqual([
      { op: 'browser_navigate', args: { url: 'http://127.0.0.1:4100/', as: 'Acolyte:DM-442' }, status: 'completed', reply: { ok: true, data: { tab: { url: 'http://127.0.0.1:4100/' } } } },
      { op: 'browser_screenshot', args: { label: 'hidden' }, status: 'failed', reply: { ok: false, error: { code: 'view_hidden', message: 'm' } } },
      { op: 'browser_read', args: { mode: 'text' }, status: 'completed', reply: null }
    ])
  })
})
