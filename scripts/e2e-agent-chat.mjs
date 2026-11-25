#!/usr/bin/env node
/**
 * Built-app e2e harness for agent chats. Launches the built Electron app (run `npm run build` first) with an isolated
 * profile and the deterministic fake agent CLI seeded as the built-in `claude` agent, drives it over CDP and runs named
 * steps, each under a 10 s condition-based deadline with no retries.
 *
 *   node scripts/e2e-agent-chat.mjs --out <dir> --steps ready
 *
 * Writes `<out>/verdict.json` ({steps: [{name, ok, ms, detail}], ok}), the main-process output and the fake agent's
 * invocation log; a failed step also leaves `<out>/e2e-<step>-failed.png`. Exits 1 unless every step passed.
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const FAKE_AGENT_CLI = join(REPO, 'src', 'main', 'agentChat', '__fixtures__', 'fakeAgentCli.mjs')
const BUILT_MAIN = join(REPO, 'out', 'main', 'index.js')
const STEP_DEADLINE_MS = 10_000
const POLL_MS = 100
const SCREENSHOT_BOUND_MS = 5_000
const STDERR_TAIL_LINES = 40
const FOLDER_NAME = 'e2e-repo'
const FAKE_VERSION = '2.1.329'
/** Inherited variables that would redirect the app: `ELECTRON_RUN_AS_NODE=1` alone would start plain Node. */
const STRIPPED_ENV = /^(?:ELECTRON_.*|NODE_OPTIONS|DM_SESSION_TOKEN|DM_DESKTOP_PIPE)$/i
/** Invocations whose exit the app observes directly; Windows recycles their pids, so they are not checked. */
const SHORT_LIVED_MODES = new Set(['version', 'auth'])

/**
 * The environment the app and its children get: `base` minus the stripped variables, with every home and config
 * directory under `root`. Keys are replaced case-insensitively, so a Windows `UserProfile` never survives beside ours.
 */
export function isolatedEnv(base, root, platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix
  const home = path.join(root, 'home')
  const isolated = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
    DARKMECHANICUS_HOME: path.join(root, 'dm-home'),
    DISABLE_AUTO_UPDATE: '1',
    FAKE_AGENT_LOG: path.join(root, 'fake-agent.jsonl')
  }
  const replaced = new Set(Object.keys(isolated))
  const kept = Object.entries(base).filter(
    ([key, value]) => value !== undefined && !STRIPPED_ENV.test(key) && !replaced.has(key.toUpperCase())
  )
  return { ...Object.fromEntries(kept), ...isolated }
}

/** The same shim text as `src/main/agentChat/__mocks__/fakeAgentShim.ts`; scripts cannot import TypeScript. */
function shimFiles(fixture, platform) {
  if (platform === 'win32') {
    return [
      { name: 'fake-claude.cmd', text: '@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nnode "%dp0%\\fake-claude.js" %*\r\n' },
      // A bare `C:\…` specifier makes import() fail with ERR_UNSUPPORTED_ESM_URL_SCHEME, so it goes through a file URL.
      { name: 'fake-claude.js', text: `import(require('node:url').pathToFileURL(${JSON.stringify(fixture)}).href)\n` }
    ]
  }
  return [{ name: 'fake-claude', text: `#!/bin/sh\nexec node '${fixture.replaceAll("'", "'\\''")}' "$@"\n`, mode: 0o755 }]
}

/** Writes the fake agent's shim into `directory` and returns the executable to register. */
export function writeShim(directory, fixture, platform = process.platform) {
  mkdirSync(directory, { recursive: true })
  const files = shimFiles(fixture, platform)
  for (const file of files) {
    const path = join(directory, file.name)
    writeFileSync(path, file.text)
    if (file.mode !== undefined) chmodSync(path, file.mode)
  }
  return join(directory, files[0].name)
}

/** Pids of the long-lived (protocol and TUI) fake agent processes in a `FAKE_AGENT_LOG`. */
export function fakeAgentPids(logText) {
  const pids = new Set()
  for (const line of logText.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const entry = JSON.parse(line)
    if (!Number.isInteger(entry.pid)) throw new Error(`Fake agent log line without a pid: ${line}`)
    if (!SHORT_LIVED_MODES.has(entry.mode)) pids.add(entry.pid)
  }
  return [...pids]
}

/** Signal 0 only checks: ESRCH means gone, EPERM means alive but not ours to signal. */
export function isAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === 'ESRCH') return false
    if (error.code === 'EPERM') return true
    throw error
  }
}

/** Polls `condition` until it returns a truthy value, which it returns; throws once `signal` aborts. */
export async function waitFor(condition, signal, intervalMs = POLL_MS) {
  for (;;) {
    signal.throwIfAborted()
    const value = await condition()
    if (value) return value
    await delay(intervalMs, undefined, { signal })
  }
}

const elapsed = (started) => Math.round(performance.now() - started)
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Runs one step exactly once under its deadline: `run` gets a signal that aborts at the deadline. A step that misses
 * it, throws, or blocks past it fails with its name; `onFailure` adds what the failure leaves behind to its detail.
 */
export async function runStep(name, run, { deadlineMs = STEP_DEADLINE_MS, onFailure = async () => ({}) } = {}) {
  const started = performance.now()
  const controller = new AbortController()
  let timer
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${name}: missed its ${deadlineMs} ms deadline`)), deadlineMs)
  })
  let outcome
  try {
    const detail = await Promise.race([run(controller.signal), deadline])
    const ms = elapsed(started)
    outcome = ms > deadlineMs
      ? { ok: false, ms, detail: { error: `${name}: took ${ms} ms, past its ${deadlineMs} ms deadline` } }
      : { ok: true, ms, detail: detail ?? null }
  } catch (error) {
    outcome = { ok: false, ms: elapsed(started), detail: { error: messageOf(error) } }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  if (!outcome.ok) {
    const extra = await onFailure(name).catch((error) => ({ failureCapture: messageOf(error) }))
    outcome.detail = { ...outcome.detail, ...extra }
  }
  return { name, ...outcome }
}

export function verdict(steps) {
  return { steps, ok: steps.length > 0 && steps.every((step) => step.ok) }
}

export function failureScreenshotName(step) {
  return `e2e-${step.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-failed.png`
}

function createSession(out) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'dm-e2e-agent-chat-')))
  return {
    out, root, env: isolatedEnv(process.env, root),
    userData: join(root, 'user-data'), folder: join(root, FOLDER_NAME), wrapper: join(root, 'app.cjs'),
    shim: null, child: null, exited: null, port: null, socket: null, pending: new Map(), nextId: 0,
    stdout: '', stderr: '', lastProbe: null, fakePids: []
  }
}

function git(session, args) {
  const result = spawnSync('git', args, { cwd: session.folder, env: session.env, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.at(-1)} failed: ${result.stderr || result.error}`)
}

function seedRepository(session) {
  mkdirSync(session.folder)
  git(session, ['init', '-q'])
  writeFileSync(join(session.folder, 'README.md'), '# e2e fixture\n')
  git(session, ['add', 'README.md'])
  git(session, ['-c', 'user.name=DM e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Seed'])
}

/** The fake is the built-in claude-kind agent: a custom agent is terminal-only and its sign-in is never checked. */
const SEED_SOURCE = `
import { openAppDatabase } from './src/main/desktop/appDatabase'
import { createAgentRegistry } from './src/main/desktop/agentRegistry'
import { createFolderRegistry } from './src/main/desktop/folderRegistry'
const seed = JSON.parse(process.argv[2])
const db = openAppDatabase(seed.userData)
try {
  createAgentRegistry({ db }).upsert({ kind: 'claude', executablePath: seed.shim, version: seed.version, connectedVia: 'found' })
} finally {
  db.close()
}
createFolderRegistry({ file: seed.folders, homeDir: seed.home, dmHome: seed.dmHome }).track(seed.folder)
`

function seedStores(session) {
  const bundle = join(session.root, 'seed.cjs')
  buildSync({
    absWorkingDir: REPO, stdin: { resolveDir: REPO, contents: SEED_SOURCE, loader: 'ts' }, outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'warning'
  })
  const seed = {
    userData: session.userData, shim: session.shim, version: FAKE_VERSION, folders: join(session.userData, 'folders.json'),
    home: session.env.HOME, dmHome: session.env.DARKMECHANICUS_HOME, folder: session.folder
  }
  const result = spawnSync(process.execPath, [bundle, JSON.stringify(seed)], { env: session.env, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`Seeding the app stores failed: ${result.stderr || result.error}`)
}

function setup(session) {
  if (!existsSync(BUILT_MAIN)) throw new Error('out/main/index.js is missing: run `npm run build` first.')
  const { env } = session
  for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.CLAUDE_CONFIG_DIR, env.DARKMECHANICUS_HOME, session.userData]) {
    mkdirSync(directory, { recursive: true })
  }
  session.shim = writeShim(join(session.root, 'shim'), FAKE_AGENT_CLI)
  seedRepository(session)
  seedStores(session)
  // The wrapper lets the harness ask for a normal quit (with the app's process disposal) on every platform.
  writeFileSync(session.wrapper, [
    `const { app } = require('electron')`,
    `app.setAppPath(${JSON.stringify(REPO)})`,
    `process.on('message', (message) => { if (message === 'quit') app.quit() })`,
    `require(${JSON.stringify(BUILT_MAIN)})`,
    ''
  ].join('\n'))
  return { shim: session.shim, folder: session.folder, userData: session.userData }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  await new Promise((resolveClose) => server.close(resolveClose))
  return port
}

async function launch(session) {
  session.port = await freePort()
  const args = [session.wrapper, `--remote-debugging-port=${session.port}`, `--user-data-dir=${session.userData}`]
  const child = spawn(require('electron'), args, { cwd: REPO, env: session.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  session.child = child
  child.stdout.on('data', (chunk) => { session.stdout += chunk })
  child.stderr.on('data', (chunk) => { session.stderr += chunk })
  session.exited = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })))
}

const isRunning = (child) => child !== null && child.exitCode === null && child.signalCode === null

function assertRunning(session) {
  if (!isRunning(session.child)) throw new Error(`The app exited (code ${session.child.exitCode}) before it was ready.`)
}

function settle(session, message) {
  const entry = session.pending.get(message.id)
  if (entry === undefined) return
  session.pending.delete(message.id)
  if (message.error) entry.reject(new Error(`CDP ${message.error.message}`))
  else entry.resolve(message.result)
}

function cdp(session, method, params = {}) {
  const id = ++session.nextId
  return new Promise((resolveCall, reject) => {
    session.pending.set(id, { resolve: resolveCall, reject })
    session.socket.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(session, expression) {
  const result = await cdp(session, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

async function rendererTarget(session, signal) {
  assertRunning(session)
  const targets = await fetch(`http://127.0.0.1:${session.port}/json/list`, { signal }).then((response) => response.json(), () => [])
  return targets.find((target) => target.type === 'page' && target.url.includes('/renderer/index.html'))
}

async function attach(session, signal) {
  const target = await waitFor(() => rendererTarget(session, signal), signal)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolveOpen, reject) => {
    socket.onopen = resolveOpen
    socket.onerror = () => reject(new Error('The CDP socket did not open.'))
  })
  socket.onmessage = (event) => settle(session, JSON.parse(event.data))
  session.socket = socket
}

/** Ready: the renderer is mounted and lists the seeded claude agent and folder, and the fake signs in through its shim. */
function readyProbe(shim) {
  return `(async () => {
    if (typeof window.dm !== 'object' || !document.getElementById('root')?.firstElementChild) return { ready: false, reason: 'renderer not mounted' }
    try {
      const agent = (await window.dm.listAgents()).find((entry) => entry.id === 'claude')
      if (agent?.executablePath !== ${JSON.stringify(shim)}) return { ready: false, reason: 'seeded claude agent not listed', agent: agent ?? null }
      const folder = (await window.dm.listFolders()).find((entry) => entry.name === ${JSON.stringify(FOLDER_NAME)})
      if (!folder?.available) return { ready: false, reason: 'seeded folder not tracked' }
      const auth = await window.dm.agentStatus('claude')
      if (auth.state !== 'signed_in') return { ready: false, reason: 'fake claude not signed in', auth }
      return { ready: true, agent: { id: agent.id, kind: agent.kind, version: agent.version, connectedVia: agent.connectedVia }, folder: folder.name, auth: auth.state }
    } catch (error) {
      return { ready: false, reason: String(error) }
    }
  })()`
}

function fakeInvocations(session) {
  const log = session.env.FAKE_AGENT_LOG
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    const { mode, pid, argv } = JSON.parse(line)
    return { mode, pid, argv }
  })
}

async function appReady(session, signal) {
  await launch(session)
  await attach(session, signal)
  const probe = await waitFor(async () => {
    assertRunning(session)
    session.lastProbe = await evaluate(session, readyProbe(session.shim))
    return session.lastProbe.ready && session.lastProbe
  }, signal)
  return { ...probe, cdpPort: session.port, fakeInvocations: fakeInvocations(session) }
}

const STEPS = {
  ready: { name: 'app ready', run: appReady }
}

function forceKill(child) {
  if (!isRunning(child)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  } else {
    child.kill('SIGKILL')
  }
}

function closeSocket(session) {
  session.socket?.close()
  session.socket = null
}

/** Asks the app for a normal quit and waits for a clean exit; at the deadline the process tree is killed. */
async function quit(session, signal) {
  const { child } = session
  if (child === null) return { launched: false }
  closeSocket(session)
  if (!isRunning(child)) throw new Error(`The app exited before quit (code ${child.exitCode}).`)
  signal.addEventListener('abort', () => forceKill(child), { once: true })
  child.send('quit')
  const { code, signal: killedBy } = await session.exited
  if (code !== 0) throw new Error(`The app exited with code ${code}${killedBy ? ` (${killedBy})` : ''}.`)
  return { exitCode: code }
}

async function fakeProcessesExited(session, signal) {
  const log = session.env.FAKE_AGENT_LOG
  session.fakePids = existsSync(log) ? fakeAgentPids(readFileSync(log, 'utf8')) : []
  await waitFor(() => session.fakePids.every((pid) => !isAlive(pid)), signal)
  return { checkedPids: session.fakePids }
}

async function captureFailure(session, step) {
  const detail = { stderrTail: session.stderr.trimEnd().split(/\r?\n/).slice(-STDERR_TAIL_LINES), lastProbe: session.lastProbe }
  if (session.socket?.readyState !== WebSocket.OPEN) return { ...detail, screenshot: null, screenshotSkipped: 'no renderer connection' }
  const bound = delay(SCREENSHOT_BOUND_MS).then(() => { throw new Error('screenshot timed out') })
  const { data } = await Promise.race([cdp(session, 'Page.captureScreenshot', { format: 'png' }), bound])
  const file = join(session.out, failureScreenshotName(step))
  writeFileSync(file, Buffer.from(data, 'base64'))
  return { ...detail, screenshot: file }
}

async function runSteps(session, keys, steps) {
  const onFailure = (step) => captureFailure(session, step)
  const prepared = await runStep('setup', async () => setup(session), { onFailure })
  steps.push(prepared)
  for (const key of prepared.ok ? keys : []) {
    const result = await runStep(STEPS[key].name, (signal) => STEPS[key].run(session, signal), { onFailure })
    steps.push(result)
    if (!result.ok) break
  }
  steps.push(await runStep('quit', (signal) => quit(session, signal), { onFailure }))
  steps.push(await runStep('fake processes exited', (signal) => fakeProcessesExited(session, signal), {
    onFailure: async () => ({ alive: session.fakePids.filter((pid) => isAlive(pid)) })
  }))
}

function preserveLogs(session) {
  writeFileSync(join(session.out, 'electron-main.log'), `${session.stdout}\n--- stderr ---\n${session.stderr}`)
  const log = session.env.FAKE_AGENT_LOG
  if (existsSync(log)) copyFileSync(log, join(session.out, 'fake-agent.jsonl'))
}

function removeIsolatedState(session) {
  rmSync(session.root, { recursive: true, force: true })
  if (existsSync(session.root)) throw new Error(`The isolated root ${session.root} is still present.`)
  return { removed: session.root }
}

function parseArgs(argv) {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
  const out = value('--out')
  const steps = value('--steps')
  if (!out || !steps) throw new Error(`Usage: node scripts/e2e-agent-chat.mjs --out <dir> --steps ${Object.keys(STEPS).join(',')}`)
  const keys = steps.split(',')
  const unknown = keys.filter((key) => !Object.hasOwn(STEPS, key))
  if (unknown.length > 0) throw new Error(`Unknown step(s) ${unknown.join(', ')}; known: ${Object.keys(STEPS).join(', ')}`)
  return { out: resolve(out), keys }
}

async function main(argv) {
  const { out, keys } = parseArgs(argv)
  mkdirSync(out, { recursive: true })
  const session = createSession(out)
  const steps = []
  try {
    await runSteps(session, keys, steps)
  } finally {
    forceKill(session.child)
    preserveLogs(session)
  }
  steps.push(await runStep('isolated state removed', async () => removeIsolatedState(session)))
  const result = verdict(steps)
  writeFileSync(join(out, 'verdict.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = result.ok ? 0 : 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
