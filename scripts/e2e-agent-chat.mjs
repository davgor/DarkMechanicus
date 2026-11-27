/**
 * Built-app e2e harness for agent chats. Launches the built Electron app (run `npm run build` first) with an isolated
 * profile and the deterministic fake agent CLI seeded as the built-in `claude` agent, drives it over CDP and runs named
 * steps, each exactly once under a 10 s condition-based deadline with no retries.
 *
 *   node scripts/e2e-agent-chat.mjs --out <dir> [--exe <packaged app exe>] [--steps ready,new-chat,stream,tool,approval,todo,toggle,epic-agent,quit,restart-resume]
 *
 * Without `--steps` every step runs. Writes `<out>/verdict.json` ({steps: [{name, ok, ms, detail}], ok}), a
 * `<out>/e2e-<step>.png` per passed scenario step (size-checked), the main-process output and the fake agent's
 * invocation log; a failed step leaves `<out>/e2e-<step>-failed.png`. Exits 1 unless every step passed. The `toggle`
 * step answers the app's real native terminal-stop dialog through Windows UI Automation (`e2e-native-dialog.ps1`),
 * only in the isolated app it launched, so it runs on Windows only. The `restart-resume` step starts the app itself
 * (with the app stopped: alone, or after `quit`) on a seeded restart marker, as Restart now leaves it, and runs in
 * phases, each under the same deadline.
 *
 * `--exe` runs the same steps against a packaged app (for example an extracted Portable build) instead of the built
 * sources: the exe starts in the same isolated environment, paused in main's inspector (`--inspect-brk`), which the
 * harness uses to point the app's home at the isolated one before main runs, and later to resize and quit it. The
 * header must show the packaged app's own version. The stores are seeded by this checkout's code, so the exe should be
 * built from the same revision.
 *
 * Each run first removes the isolated roots that earlier runs left behind when they were killed before their own
 * cleanup (`harness.json` names the harness that owns a root; a root whose harness is gone is stale).
 */
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { createInterface } from 'node:readline'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const FAKE_AGENT_CLI = join(REPO, 'src', 'main', 'agentChat', '__fixtures__', 'fakeAgentCli.mjs')
const NATIVE_DIALOG_HELPER = join(REPO, 'scripts', 'e2e-native-dialog.ps1')
const BUILT_MAIN = join(REPO, 'out', 'main', 'index.js')
const STEP_DEADLINE_MS = 10_000
const POLL_MS = 100
const SCREENSHOT_BOUND_MS = 5_000
const STDERR_TAIL_LINES = 40
const FOLDER_NAME = 'e2e-repo'
const FAKE_VERSION = '2.1.329'
const EPIC_TITLE = 'E2E epic'
/** The window every chat step is captured at, and the wide one the epic's Agent stage with its open rail is. */
const WINDOW = { width: 1024, height: 768 }
const WIDE_WINDOW = { width: 1440, height: 900 }
/** Inherited variables that would redirect the app: `ELECTRON_RUN_AS_NODE=1` alone would start plain Node. */
const STRIPPED_ENV = /^(?:ELECTRON_.*|NODE_OPTIONS|DM_SESSION_TOKEN|DM_DESKTOP_PIPE)$/i
/**
 * The protocol (GUI) and TUI invocations, which run until the app stops them. Version, auth and arbiter runs exit by
 * themselves and the app observes that directly; Windows recycles their pids, so they are not checked.
 */
const LONG_LIVED_MODES = new Set(['claude', 'omp', 'tui'])
const TERMINAL_STOP_TITLE = 'Stop the terminal and switch to the GUI?'
/** The isolated roots under the system temp folder, and the file in each naming the harness pid that owns it. */
const ROOT_PREFIX = 'dm-e2e-agent-chat-'
const OWNER_FILE = 'harness.json'
/** A root with no owner file is a run's own only between its creation and the next line; older, it is stale. */
const UNOWNED_GRACE_MS = 60_000
/** The title the fake agent names a new chat with (`fakeAgentCli.mjs`, FAKE_CHAT_TITLE); scripts cannot import it. */
const FAKE_CHAT_TITLE = 'Fake agent conversation'

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
    // OMP's and Codex's own folders, should either ever run: nothing reads the person's agent folders.
    PI_CODING_AGENT_DIR: path.join(home, '.omp', 'agent'),
    CODEX_HOME: path.join(home, '.codex'),
    DARKMECHANICUS_HOME: path.join(root, 'dm-home'),
    DISABLE_AUTO_UPDATE: '1',
    FAKE_AGENT_LOG: path.join(root, 'fake-agent.jsonl'),
    // The fake then reports the session id it was started with, as Claude Code does, instead of a fixture placeholder
    // the app would store over the chat's UUID (and a terminal could then never resume); and a resumed session goes
    // on numbering its turns, so its replies never reuse an earlier turn's message ids.
    FAKE_AGENT_SESSION_FILES: '1',
    FAKE_AGENT_CONTINUE_TURNS: '1',
    // A new chat's first message is named through the app's own `dm` line, as a real agent names it.
    FAKE_AGENT_NAME_CHATS: '1'
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

/** The fake agent's invocation log, one entry per launch, in launch order. */
export function fakeAgentLog(logText) {
  return logText.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => {
    const entry = JSON.parse(line)
    if (!Number.isInteger(entry.pid)) throw new Error(`Fake agent log line without a pid: ${line}`)
    return entry
  })
}

/** Pids of the long-lived (protocol and TUI) fake agent processes in a `FAKE_AGENT_LOG`. */
export function fakeAgentPids(logText) {
  return [...new Set(fakeAgentLog(logText).filter((entry) => LONG_LIVED_MODES.has(entry.mode)).map((entry) => entry.pid))]
}

/** The GUI (protocol) and terminal (TUI) launches that name `sessionId`, with the flag that names it. */
export function chatLaunches(logText, sessionId) {
  return fakeAgentLog(logText)
    .filter((entry) => LONG_LIVED_MODES.has(entry.mode) && entry.argv.includes(sessionId))
    .map((entry) => ({
      surface: entry.mode === 'tui' ? 'terminal' : 'gui', flag: entry.argv[entry.argv.indexOf(sessionId) - 1],
      pid: entry.pid, at: entry.at, grantHash: entry.grantHash
    }))
}

/** The toggle's three launches of one session: GUI `--session-id`, PTY `--resume`, GUI `--resume`; throws otherwise. */
export function assertToggleLaunches(launches) {
  const seen = launches.map((launch) => `${launch.surface} ${launch.flag}`)
  const expected = ['gui --session-id', 'terminal --resume', 'gui --resume']
  if (JSON.stringify(seen) !== JSON.stringify(expected)) {
    throw new Error(`Expected the launches ${expected.join(', ')}; the log has ${seen.join(', ') || 'none'}.`)
  }
  return { gui: launches[0], terminal: launches[1], resumed: launches[2] }
}

/**
 * The confirmed handoff's order, all in epoch ms: the click on "Stop terminal and switch" comes first, then the old
 * terminal's exit and its grant's revocation, and only after both the GUI's resume launch. Throws on any inversion.
 */
export function assertHandoffOrder({ confirmedAt, terminalExitedAt, grantRevokedAt, resumedAt }) {
  for (const [name, value] of Object.entries({ confirmedAt, terminalExitedAt, grantRevokedAt, resumedAt })) {
    if (!Number.isFinite(value)) throw new Error(`The handoff has no ${name}.`)
  }
  const order = [['confirmation', confirmedAt], ['terminal exit', terminalExitedAt], ['GUI resume', resumedAt]]
  const revocation = [['confirmation', confirmedAt], ['grant revocation', grantRevokedAt], ['GUI resume', resumedAt]]
  for (const sequence of [order, revocation]) {
    for (let index = 1; index < sequence.length; index++) {
      const [before, earlier] = sequence[index - 1]
      const [after, later] = sequence[index]
      if (later < earlier) throw new Error(`The ${after} (${later}) came before the ${before} (${earlier}).`)
    }
  }
  return { confirmedAt, terminalExitedAt, grantRevokedAt, resumedAt }
}

/** A PNG's pixel size, from its IHDR chunk. */
export function pngSize(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(0) !== 0x89504e47 || bytes.toString('latin1', 12, 16) !== 'IHDR') {
    throw new Error('Not a PNG.')
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
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

function rootOwner(root) {
  try {
    return JSON.parse(readFileSync(join(root, OWNER_FILE), 'utf8')).pid
  } catch {
    return null
  }
}

/**
 * The isolated roots in `parent` that no running harness owns: a run killed outright (a crash, `taskkill /F`) never
 * reaches its own cleanup. A root is stale when the pid in its `harness.json` is gone, or when it has no such file
 * and is older than a minute. A reused pid keeps a root, never removes a live one.
 */
export function staleRoots(parent, alive = isAlive, now = Date.now()) {
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(ROOT_PREFIX))
    .map((entry) => join(parent, entry.name))
    .filter((root) => {
      const owner = rootOwner(root)
      return owner === null ? now - statSync(root).mtimeMs > UNOWNED_GRACE_MS : !alive(owner)
    })
}

/** Removes every stale root; one that cannot be removed (a file still held open) fails the step, named. */
export function removeStaleRoots(parent = tmpdir(), alive = isAlive) {
  const removed = []
  const kept = []
  for (const root of staleRoots(parent, alive)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
    if (existsSync(root)) kept.push(root)
    else removed.push(root)
  }
  if (kept.length > 0) throw new Error(`Stale isolated roots could not be removed: ${kept.join(', ')}`)
  return { removed }
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

/** `env` with this Node's folder first on its one PATH key (whatever its case): the fake's shim runs `node`. */
export function withNodeFirst(env, nodePath = process.execPath, platform = process.platform) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH'
  const separator = platform === 'win32' ? ';' : ':'
  const folder = (platform === 'win32' ? win32 : posix).dirname(nodePath)
  return { ...env, [key]: [folder, env[key]].filter(Boolean).join(separator) }
}

function createSession(out, exe) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), ROOT_PREFIX)))
  writeFileSync(join(root, OWNER_FILE), JSON.stringify({ pid: process.pid }))
  return {
    out, root, exe, env: withNodeFirst(isolatedEnv(process.env, root)),
    userData: join(root, 'user-data'), folder: join(root, FOLDER_NAME), wrapper: join(root, 'app.cjs'),
    shim: null, child: null, exited: null, port: null, inspectorPort: null, page: null, main: null, version: null,
    stdout: '', stderr: '', lastProbe: null, fakePids: [], dialogs: null, epicId: null, folderPath: null, chat: null,
    store: null, restart: null
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

/**
 * The fake is the built-in claude-kind agent: a custom agent is terminal-only and its sign-in is never checked. The
 * folder is set up in database mode (its records live under the isolated Dark Mechanicus home, so the Git tree stays
 * clean) with one saved epic, whose id the seed prints. Notifications are on while the window is focused, as an
 * unattended run's window is.
 */
const SEED_SOURCE = `
import { openWorkspace } from './src/core/workspace'
import { openAppDatabase } from './src/main/desktop/appDatabase'
import { createAgentRegistry } from './src/main/desktop/agentRegistry'
import { createAppSettings } from './src/main/desktop/appSettings'
import { createFolderRegistry } from './src/main/desktop/folderRegistry'
import { DEFAULT_NOTIFICATION_SETTINGS } from './src/shared/desktop/notificationSettings'
const seed = JSON.parse(process.argv[2])
async function main() {
  const workspace = openWorkspace({ repoRoot: seed.folder, homeDir: seed.dmHome, role: 'desktop', transport: 'desktop', label: 'e2e seed' })
  let epicId
  try {
    await workspace.initializeRepository({ name: 'E2E fixture', keyPrefix: 'DM', mode: 'db' })
    const epic = await workspace.createEpic({ title: seed.epicTitle, successCriteria: ['GUI agent chats work end to end'] })
    const draft = await workspace.updatePlanDraft({ epicId: epic.id, ops: [
      { op: 'add_ticket', ref: 'one', sprint: '1', ticket: { title: 'Add retry banner' } },
      { op: 'add_ticket', ref: 'two', sprint: '1', ticket: { title: 'Fix lint' } }
    ] })
    const saved = await workspace.savePlan({ epicId: epic.id, expectedDraftRevision: draft.draftRevision })
    if (saved.status !== 'saved') throw new Error('The seeded plan was not saved: ' + saved.status)
    epicId = epic.id
  } finally {
    workspace.close()
  }
  const db = openAppDatabase(seed.userData)
  try {
    createAgentRegistry({ db }).upsert({ kind: 'claude', executablePath: seed.shim, version: seed.version, connectedVia: 'found' })
    await createAppSettings({ db, confirm: async () => false, logger: console })
      .setNotifications({ ...DEFAULT_NOTIFICATION_SETTINGS, whenFocused: 'notify' })
  } finally {
    db.close()
  }
  createFolderRegistry({ file: seed.folders, homeDir: seed.home, dmHome: seed.dmHome }).track(seed.folder)
  process.stdout.write(JSON.stringify({ epicId }))
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
`

function seedStores(session) {
  const bundle = join(session.root, 'seed.cjs')
  buildSync({
    absWorkingDir: REPO, stdin: { resolveDir: REPO, contents: SEED_SOURCE, loader: 'ts' }, outfile: bundle,
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'warning'
  })
  const seed = {
    userData: session.userData, shim: session.shim, version: FAKE_VERSION, folders: join(session.userData, 'folders.json'),
    home: session.env.HOME, dmHome: session.env.DARKMECHANICUS_HOME, folder: session.folder, epicTitle: EPIC_TITLE
  }
  const result = spawnSync(process.execPath, [bundle, JSON.stringify(seed)], { env: session.env, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`Seeding the app stores failed: ${result.stderr || result.error}`)
  session.epicId = JSON.parse(result.stdout).epicId
}

/**
 * The Electron entry the harness launches: the app's own `home` path is the isolated one (Electron reads the real
 * profile otherwise), its version is the package's (an unpackaged entry file otherwise reports Electron's own), a
 * `quit` message asks for a normal quit, with the app's process disposal, on every platform, and a `resize` message
 * sets the app window's content size. A harness that goes away (crash, kill) closes the IPC channel: the app then
 * quits the same way, so it never outlives the run.
 *
 * Windows' native occlusion tracking is off. An unattended run's window is often covered by other windows. Chromium
 * then marks its page hidden and does not lay out a larger content size until the window is shown again: the
 * `epic-agent` step's grow to 1440x900 then never reached the page within its deadline, while shrinking still did.
 */
export function wrapperSource({ repo, main, home, version }) {
  return [
    `const { app, BrowserWindow } = require('electron')`,
    `app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')`,
    `app.setAppPath(${JSON.stringify(repo)})`,
    `app.setPath('home', ${JSON.stringify(home)})`,
    `app.setVersion(${JSON.stringify(version)})`,
    `process.on('disconnect', () => app.quit())`,
    `process.on('message', (message) => {`,
    `  if (message === 'quit') app.quit()`,
    `  if (message?.type === 'resize') {`,
    `    const [window] = BrowserWindow.getAllWindows()`,
    `    if (window?.isMaximized()) window.unmaximize()`,
    `    window?.setContentSize(message.width, message.height)`,
    `  }`,
    `})`,
    `require(${JSON.stringify(main)})`,
    ''
  ].join('\n')
}

/**
 * The UI Automation helper (`e2e-native-dialog.ps1`), started once so each dialog answer costs no PowerShell start.
 * `request` sends one JSON request and resolves with its answer; requests are answered in order.
 */
function startDialogHelper(session) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', NATIVE_DIALOG_HELPER]
  const child = spawn('powershell.exe', args, { env: session.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const waiting = []
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk })
  // A helper that died leaves a closed pipe: the write fails (EPIPE) and the waiting request is rejected on exit.
  child.stdin.on('error', (error) => { stderr += `\nstdin: ${error.message}` })
  createInterface({ input: child.stdout }).on('line', (line) => waiting.shift()?.resolve(line))
  child.once('exit', (code) => {
    for (const entry of waiting.splice(0)) entry.reject(new Error(`The dialog helper exited (code ${code}): ${stderr.trim()}`))
  })
  const next = () => new Promise((resolveLine, reject) => waiting.push({ resolve: resolveLine, reject }))
  const ready = next()
  // A helper that dies before any step asks is reported by the step that asks; it must not end the harness.
  ready.catch(() => {})
  session.dialogs = {
    child,
    async request(body) {
      await ready
      const line = next()
      child.stdin.write(`${JSON.stringify(body)}\n`)
      const answer = JSON.parse(await line)
      if (!answer.ok) throw new Error(`Dialog helper ${body.op}: ${answer.error}`)
      return answer
    }
  }
}

function stopDialogHelper(session) {
  if (session.dialogs === null) return
  session.dialogs.child.stdin.end()
  if (session.dialogs.child.exitCode === null) session.dialogs.child.kill()
  session.dialogs = null
}

function setup(session) {
  if (session.exe === null && !existsSync(BUILT_MAIN)) throw new Error('out/main/index.js is missing: run `npm run build` first.')
  if (session.exe !== null && !existsSync(session.exe)) throw new Error(`The packaged app ${session.exe} does not exist.`)
  const { env } = session
  for (const directory of [env.APPDATA, env.LOCALAPPDATA, env.CLAUDE_CONFIG_DIR, env.DARKMECHANICUS_HOME, session.userData]) {
    mkdirSync(directory, { recursive: true })
  }
  session.shim = writeShim(join(session.root, 'shim'), FAKE_AGENT_CLI)
  seedRepository(session)
  seedStores(session)
  if (session.exe === null) {
    const { version } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    session.version = version
    writeFileSync(session.wrapper, wrapperSource({ repo: REPO, main: BUILT_MAIN, home: session.env.HOME, version }))
  }
  if (process.platform === 'win32') startDialogHelper(session)
  return {
    shim: session.shim, folder: session.folder, userData: session.userData, epicId: session.epicId, home: session.env.HOME,
    app: session.exe ?? BUILT_MAIN
  }
}

async function freePort() {
  const server = createServer()
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()
  await new Promise((resolveClose) => server.close(resolveClose))
  return port
}

/** Starts the app: the built sources through the wrapper, or the packaged exe paused in main's inspector. */
async function launch(session, signal) {
  session.port = await freePort()
  const chromium = [`--remote-debugging-port=${session.port}`, `--user-data-dir=${session.userData}`]
  if (session.exe === null) {
    session.child = spawn(require('electron'), [session.wrapper, ...chromium], { cwd: REPO, env: session.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  } else {
    let inspector = await freePort()
    while (inspector === session.port) inspector = await freePort()
    // The occlusion switch is the wrapper's (see `wrapperSource`), here on the command line.
    const args = [`--inspect-brk=127.0.0.1:${inspector}`, '--disable-features=CalculateNativeWinOcclusion', ...chromium]
    session.child = spawn(session.exe, args, { cwd: session.root, env: session.env, stdio: ['ignore', 'pipe', 'pipe'] })
    session.inspectorPort = inspector
  }
  const { child } = session
  child.stdout.on('data', (chunk) => { session.stdout += chunk })
  child.stderr.on('data', (chunk) => { session.stderr += chunk })
  session.exited = new Promise((resolveExit) => child.once('exit', (code, signal) => resolveExit({ code, signal })))
  if (session.exe !== null) await startPackagedMain(session, signal)
}

const isRunning = (child) => child !== null && child.exitCode === null && child.signalCode === null

function assertRunning(session) {
  if (!isRunning(session.child)) throw new Error(`The app exited (code ${session.child.exitCode}) before it was ready.`)
}

/**
 * One DevTools protocol connection (the renderer page, or main's Node inspector): `call` sends a command and resolves
 * with its result; every event goes to `onEvent`.
 */
async function connect(url, onEvent = () => {}) {
  const socket = new WebSocket(url)
  await new Promise((resolveOpen, reject) => {
    socket.onopen = resolveOpen
    socket.onerror = () => reject(new Error(`The DevTools socket ${url} did not open.`))
  })
  const pending = new Map()
  let nextId = 0
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (entry === undefined) return onEvent(message)
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(`CDP ${message.error.message}`))
    else entry.resolve(message.result)
  }
  const call = (method, params = {}) => new Promise((resolveCall, reject) => {
    const id = ++nextId
    pending.set(id, { resolve: resolveCall, reject })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return { socket, call }
}

function cdp(session, method, params = {}) {
  return session.page.call(method, params)
}

async function evaluateOn(connection, expression, params = {}) {
  const result = await connection.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...params })
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  return result.result.value
}

function evaluate(session, expression) {
  return evaluateOn(session.page, expression)
}

/**
 * Runs `expression` in the packaged app's main process, where the inspector's command-line `require` loads `electron`.
 * Never `awaitPromise`: while main is paused on its first line no microtask runs, and an awaited evaluation never answers.
 */
function evaluateMain(session, expression) {
  const wrapped = `(() => { const { app, BrowserWindow } = require('electron'); return ${expression} })()`
  return evaluateOn(session.main, wrapped, { includeCommandLineAPI: true, awaitPromise: false })
}

/** The first target a DevTools endpoint lists that `match` accepts, once it lists one. */
async function devtoolsTarget(session, port, signal, match) {
  assertRunning(session)
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`, { signal }).then((response) => response.json(), () => [])
  return targets.find(match)
}

async function attach(session, signal) {
  const target = await waitFor(() => devtoolsTarget(session, session.port, signal, (entry) => entry.type === 'page' && entry.url.includes('/renderer/index.html')), signal)
  session.page = await connect(target.webSocketDebuggerUrl)
}

/**
 * Under `--inspect-brk` a worker thread inherits the break and waits for a debugger before its first line. node-pty
 * starts its ConPTY output worker and then blocks main until that worker reads, so a terminal would deadlock the app.
 * Worker threads the app starts get an explicit empty `execArgv` (Electron's main has none of its own), which drops
 * the inherited break; a worker given its own `execArgv` keeps it.
 */
const UNPAUSED_WORKERS = `(() => {
  const threads = require('node:worker_threads')
  const { Worker } = threads
  threads.Worker = class extends Worker { constructor(file, options) { super(file, { execArgv: [], ...options }) } }
  return true
})()`

/**
 * The packaged app's main, paused on its first line by `--inspect-brk`: its home becomes the isolated one (Electron
 * reads the real profile otherwise; the wrapper does the same for the built sources), its worker threads start
 * unpaused, it quits once this harness is gone (as the wrapper's IPC disconnect does), and then it runs.
 */
async function startPackagedMain(session, signal) {
  const target = await waitFor(() => devtoolsTarget(session, session.inspectorPort, signal, () => true), signal)
  let paused
  const firstPause = new Promise((resolvePause) => { paused = resolvePause })
  session.main = await connect(target.webSocketDebuggerUrl, (event) => { if (event.method === 'Debugger.paused') paused() })
  await session.main.call('Runtime.enable')
  await session.main.call('Debugger.enable')
  await session.main.call('Runtime.runIfWaitingForDebugger')
  await Promise.race([firstPause, new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))])
  await evaluateMain(session, `(app.setPath('home', ${JSON.stringify(session.env.HOME)}), true)`)
  await evaluateMain(session, UNPAUSED_WORKERS)
  await evaluateMain(session, `(setInterval(() => { try { process.kill(${process.pid}, 0) } catch { app.quit() } }, 1000).unref(), true)`)
  session.version = await evaluateMain(session, 'app.getVersion()')
  await session.main.call('Debugger.resume')
  await session.main.call('Debugger.disable')
}

/** Asks the app to resize its window or to quit: over the wrapper's IPC, or in the packaged app's main. */
function tellApp(session, message) {
  if (session.exe === null) {
    session.child.send(message)
    return Promise.resolve()
  }
  const command = message === 'quit'
    ? 'app.quit()'
    : `(() => { const [window] = BrowserWindow.getAllWindows(); if (window?.isMaximized()) window.unmaximize(); window?.setContentSize(${message.width}, ${message.height}) })()`
  return evaluateMain(session, `(${command}, true)`)
}

/** Ready: the renderer is mounted and lists the seeded claude agent and folder, and the fake signs in through its shim. */
function readyProbe(shim) {
  return `(async () => {
    if (typeof window.dm !== 'object' || !document.getElementById('root')?.firstElementChild) return { ready: false, reason: 'renderer not mounted' }
    try {
      const agents = await window.dm.listAgents()
      const agent = agents.find((entry) => entry.id === 'claude')
      if (agent?.executablePath !== ${JSON.stringify(shim)}) return { ready: false, reason: 'seeded claude agent not listed', agent: agent ?? null }
      const folder = (await window.dm.listFolders()).find((entry) => entry.name === ${JSON.stringify(FOLDER_NAME)})
      if (!folder?.available || !folder.initialized) return { ready: false, reason: 'seeded folder not tracked and set up' }
      const auth = await window.dm.agentStatus('claude')
      if (auth.state !== 'signed_in') return { ready: false, reason: 'fake claude not signed in', auth }
      return {
        ready: true, agent: { id: agent.id, kind: agent.kind, version: agent.version, connectedVia: agent.connectedVia },
        agents: agents.map((entry) => ({ id: entry.id, kind: entry.kind, executablePath: entry.executablePath })),
        folder: { name: folder.name, path: folder.path, storageMode: folder.storageMode }, auth: auth.state
      }
    } catch (error) {
      return { ready: false, reason: String(error) }
    }
  })()`
}

function readLog(session) {
  const log = session.env.FAKE_AGENT_LOG
  return existsSync(log) ? readFileSync(log, 'utf8') : ''
}

function fakeInvocations(session) {
  return fakeAgentLog(readLog(session)).map(({ mode, pid, argv }) => ({ mode, pid, argv }))
}

/**
 * Page-side helpers, installed once after the app is ready. A reload would drop them, so their presence later proves
 * the page was not reloaded. `events` records each agent chat push's shape (never its text).
 */
function installHelpers(_h) {
  const events = []
  window.dm.agentChat.onEvent((event) => {
    events.push({ type: event.type, chatId: event.chatId, kind: event.kind ?? event.item?.kind ?? null })
  })
  window.__e2e = {
    events,
    setValue(element, value) {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value)
      element.dispatchEvent(new Event('input', { bubbles: true }))
    },
    button(root, label) {
      return root ? [...root.querySelectorAll('button')].find((button) => button.textContent.trim() === label) ?? null : null
    },
    rect(element) {
      const { left, top, right, bottom, width, height } = element.getBoundingClientRect()
      return { left, top, right, bottom, width, height }
    },
    /** The top-level bubbles of a chat transcript: who wrote each and its text. */
    messages(root) {
      const articles = root ? [...root.querySelectorAll('.chat-transcript > ol.chat-rows > li.chat-msg > article')] : []
      return articles.map((article) => ({
        who: article.getAttribute('aria-label'),
        text: [...article.children].slice(1).map((child) => child.textContent).join(' ').trim()
      }))
    }
  }
  return { ok: true }
}

/** Runs `fn` in the page with the helpers and `args`; `fn` is serialized, so it may use only its parameters. */
function page(session, fn, ...args) {
  return evaluate(session, `(${fn.toString()})(window.__e2e, ...${JSON.stringify(args)})`)
}

/** Polls `fn` in the page until it answers `{ok: true}`, which it returns; the last answer is kept for a failure. */
function until(session, signal, fn, ...args) {
  return waitFor(async () => {
    assertRunning(session)
    session.lastProbe = await page(session, fn, ...args)
    return session.lastProbe?.ok ? session.lastProbe : null
  }, signal)
}

function clickSelector(_h, selector) {
  const element = document.querySelector(selector)
  if (!element || element.disabled) return { ok: false, selector, found: !!element }
  element.click()
  return { ok: true }
}

function buttonReady(h, scope, label) {
  const button = h.button(document.querySelector(scope), label)
  return { ok: !!button && !button.disabled, scope, label, found: !!button }
}

function clickButton(h, scope, label) {
  const button = h.button(document.querySelector(scope), label)
  if (!button || button.disabled) return { ok: false, scope, label, found: !!button }
  button.click()
  return { ok: true }
}

function fill(h, selector, text) {
  const element = document.querySelector(selector)
  if (!element || element.disabled) return { ok: false, selector, found: !!element }
  if (element.value !== text) h.setValue(element, text)
  return { ok: element.value === text }
}

/** Types `text` into the chat's GUI composer, then (on a later poll, once React enabled it) clicks Send. */
function composeAndSend(h, chatId, text) {
  const input = document.getElementById(`agent-message-${chatId}`)
  if (!input || input.disabled) return { ok: false, phase: 'composer', found: !!input }
  if (input.value !== text) {
    h.setValue(input, text)
    return { ok: false, phase: 'typed' }
  }
  const send = h.button(input.form, 'Send')
  if (!send || send.disabled) return { ok: false, phase: 'send button', found: !!send }
  send.click()
  return { ok: true }
}

/**
 * Whether the turn that the user message `text` started has ended in `snapshot`: the last user message equal to
 * `text` (or starting with it, for `prefix`, as a kickoff) exists and the chat is idle with nothing pending or queued.
 * The message is stored and `busy` pushed in the same send, so idle after it means its turn ended. Installed in the
 * page as `h.turnEnded`.
 */
export function turnEnded({ items, status, pending, queued }, text, prefix = false) {
  const sent = items.findLastIndex((item) => item.kind === 'user_message' && (prefix ? item.text.startsWith(text) : item.text === text))
  return { ok: sent >= 0 && status === 'idle' && pending === null && queued === 0, status, pending: pending?.kind ?? null, sent }
}

/**
 * The bubble right after the last `You` bubble that is exactly `user`, when it is the assistant's reply `reply`
 * exactly; null otherwise. A later turn's reply never stands in. Installed in the page as `h.replyAfter`.
 */
export function replyAfter(messages, user, reply) {
  const asked = messages.findLastIndex((message) => message.who === 'You' && message.text === user)
  const next = asked >= 0 ? messages[asked + 1] : undefined
  return next?.who === 'Assistant' && next.text === reply ? { index: asked + 1, ...next } : null
}

/** `match` is the user message `text`, matched exactly unless `prefix` (a kickoff the harness only knows the start of). */
async function turnDone(h, folder, chatId, match) {
  const result = await window.dm.agentChat.snapshot({ folder, chatId })
  if (!result.ok) return { ok: false, error: result.error.message }
  return h.turnEnded(result.data, match.text, match.prefix === true)
}

/** The GUI chat shows its composer, and the bubble `user` directly followed by the assistant's `reply`. */
function guiShows(h, chatId, user, reply) {
  const composer = document.getElementById(`agent-message-${chatId}`)
  const section = composer?.closest('section.agent-chat')
  const messages = h.messages(section)
  const answered = h.replyAfter(messages, user, reply)
  return { ok: !!composer && answered !== null, composer: !!composer, section: section?.getAttribute('aria-label') ?? null, answered, messages }
}

async function chatRecord(_h, folder, predicate) {
  const result = await window.dm.chats.list(folder)
  if (!result.ok) return { ok: false, error: result.error.message }
  const chat = result.data.find((entry) => Object.entries(predicate).every(([key, value]) => entry[key] === value))
  if (!chat) return { ok: false, chats: result.data.length }
  const { id, agent, surface, sessionId, role, runId, epicId, title, firstPrompt } = chat
  return { ok: sessionId !== null, chat: { id, agent, surface, sessionId, role, runId: runId ?? null, epicId: epicId ?? null, title, firstPrompt } }
}

async function sendInChat(session, signal, { chatId, text, reply }) {
  await until(session, signal, composeAndSend, chatId, text)
  await until(session, signal, turnDone, session.folderPath, chatId, { text })
  return until(session, signal, guiShows, chatId, text, reply)
}

async function resizeWindow(session, signal, size) {
  await tellApp(session, { type: 'resize', ...size })
  await waitFor(async () => {
    const view = await evaluate(session, '({ width: innerWidth, height: innerHeight })')
    session.lastProbe = { resize: size, view }
    return view.width === size.width && view.height === size.height
  }, signal)
}

/** Saves the app window's page as `<out>/<name>`, after checking the window is `size` and the PNG matches it. */
async function capture(session, name, size) {
  const view = await evaluate(session, '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })')
  if (view.width !== size.width || view.height !== size.height) {
    throw new Error(`${name}: the window is ${view.width}x${view.height}, not ${size.width}x${size.height}.`)
  }
  const { data } = await cdp(session, 'Page.captureScreenshot', { format: 'png' })
  const bytes = Buffer.from(data, 'base64')
  const png = pngSize(bytes)
  const expected = { width: Math.round(size.width * view.dpr), height: Math.round(size.height * view.dpr) }
  if (png.width !== expected.width || png.height !== expected.height) {
    throw new Error(`${name}: the capture is ${png.width}x${png.height}, not ${expected.width}x${expected.height}.`)
  }
  writeFileSync(join(session.out, name), bytes)
  return { file: name, window: `${view.width}x${view.height}`, png: `${png.width}x${png.height}`, dpr: view.dpr }
}

/** The version the sidebar header shows, from its label (`AppVersionLabel`), or null before it renders. */
function headerVersion() {
  return document.querySelector('.app-version-label')?.getAttribute('aria-label')?.replace(/^Application version /, '') ?? null
}

async function appReady(session, signal) {
  await launch(session, signal)
  await attach(session, signal)
  const probe = await waitFor(async () => {
    assertRunning(session)
    session.lastProbe = await evaluate(session, readyProbe(session.shim))
    return session.lastProbe.ready && session.lastProbe
  }, signal)
  session.folderPath = probe.folder.path
  // The header shows the app's own version: the package's for the built sources, the packaged app's for `--exe`.
  const header = await waitFor(async () => {
    session.lastProbe = { header: await evaluate(session, `(${headerVersion.toString()})()`), expected: session.version }
    return session.lastProbe.header === session.version && session.lastProbe.header
  }, signal)
  await page(session, installHelpers)
  // The matchers the unit tests cover run in the page as they are, serialized from this module.
  await evaluate(session, `Object.assign(window.__e2e, { turnEnded: ${turnEnded.toString()}, replyAfter: ${replyAfter.toString()} }), true`)
  await resizeWindow(session, signal, WINDOW)
  return {
    ...probe, app: session.exe ?? BUILT_MAIN, headerVersion: header, cdpPort: session.port,
    window: `${WINDOW.width}x${WINDOW.height}`, fakeInvocations: fakeInvocations(session)
  }
}

/** Step 1: a folder chat from the New chat popup, with the claude-kind fake, opens in the GUI with its first turn. */
async function newChat(session, signal) {
  await until(session, signal, clickSelector, `button[aria-label="New chat in ${FOLDER_NAME}"]`)
  await until(session, signal, fill, '.dialog[role="dialog"] textarea', 'hello first')
  await until(session, signal, clickButton, '.dialog[role="dialog"] .dialog-actions', 'Start')
  const { chat } = await until(session, signal, chatRecord, session.folderPath, { firstPrompt: 'hello first' })
  if (chat.surface !== 'gui' || chat.agent !== 'claude') throw new Error(`The new chat is ${chat.agent} on ${chat.surface}, not claude on gui.`)
  session.chat = { chatId: chat.id, sessionId: chat.sessionId }
  await until(session, signal, turnDone, session.folderPath, chat.id, { text: 'hello first' })
  const shown = await until(session, signal, guiShows, chat.id, 'hello first', 'Hello world')
  return { chat, section: shown.section, messages: shown.messages, screenshot: await capture(session, 'e2e-new-chat.png', WINDOW) }
}

function streamEvents(h, chatId, from) {
  const events = h.events.slice(from).filter((event) => event.chatId === chatId)
  const textDeltas = events.filter((event) => event.type === 'delta' && event.kind === 'text').length
  const streamEnds = events.filter((event) => event.type === 'stream_end').length
  return { ok: textDeltas > 0 && streamEnds > 0, textDeltas, streamEnds, total: events.length }
}

/** Step 2: `hello` streams its reply (text deltas, then the stored bubble). */
async function stream(session, signal) {
  const { chatId } = session.chat
  const from = await page(session, (h) => h.events.length)
  const shown = await sendInChat(session, signal, { chatId, text: 'hello', reply: 'Hello world' })
  const streamed = await until(session, signal, streamEvents, chatId, from)
  return { streamed, messages: shown.messages, screenshot: await capture(session, 'e2e-stream.png', WINDOW) }
}

function toolCard(_h, name, state) {
  const card = document.querySelector(`section.agent-chat .chat-transcript li.chat-tool[aria-label="Tool call: ${name}"]`)
  const pill = card?.querySelector('[data-state]')
  return { ok: pill?.getAttribute('data-state') === state, found: !!card, state: pill?.getAttribute('data-state') ?? null, pill: pill?.textContent ?? null }
}

/** Step 3: `[tool]` shows a tool card that finishes. */
async function tool(session, signal) {
  const shown = await sendInChat(session, signal, { chatId: session.chat.chatId, text: '[tool]', reply: 'alpha' })
  const card = await until(session, signal, toolCard, 'Read', 'accepted')
  return { card, messages: shown.messages, screenshot: await capture(session, 'e2e-tool.png', WINDOW) }
}

function dockedPrompt(h, chatId) {
  const card = document.querySelector('section.agent-chat section.agent-prompt[role="alertdialog"]')
  const composer = document.getElementById(`agent-message-${chatId}`)?.form
  if (!card || !composer) return { ok: false, card: !!card, composer: !!composer }
  const docked = h.rect(card).bottom <= h.rect(composer).top + 1
  return {
    ok: docked && !!h.button(card, 'Allow once'), docked, heading: card.getAttribute('aria-label'),
    buttons: [...card.querySelectorAll('.agent-prompt-options button')].map((button) => button.textContent.trim()),
    arbitrated: !!card.querySelector('.agent-prompt-arbitration')
  }
}

/** Step 4: `[approval]` docks a card above the composer; Allow once finishes the turn, and no earlier turn collapses. */
async function approval(session, signal) {
  const { chatId } = session.chat
  await until(session, signal, composeAndSend, chatId, '[approval]')
  const prompt = await until(session, signal, dockedPrompt, chatId)
  if (prompt.arbitrated) throw new Error('The New chat approval went to the Magos; a New chat is never arbitrated.')
  const card = await capture(session, 'e2e-approval-card.png', WINDOW)
  await until(session, signal, clickButton, 'section.agent-chat section.agent-prompt', 'Allow once')
  await until(session, signal, turnDone, session.folderPath, chatId, { text: '[approval]' })
  const bash = await until(session, signal, toolCard, 'Bash', 'accepted')
  // Step 2's own reply is still the bubble right after its `hello`: the approval turn collapsed no earlier turn.
  const { messages, answered } = await until(session, signal, guiShows, chatId, 'hello', 'Hello world')
  const asked = messages.filter((message) => message.who === 'You').map((message) => message.text)
  const expected = ['hello first', 'hello', '[tool]', '[approval]']
  if (JSON.stringify(asked) !== JSON.stringify(expected)) throw new Error(`The transcript's own bubbles are ${JSON.stringify(asked)}.`)
  return { prompt, bash, stepTwoReply: answered, messages, screenshots: [card, await capture(session, 'e2e-approval.png', WINDOW)] }
}

/** The To-dos card of the chat, with its `closed/total` count, docked above the composer; no TodoWrite card shown. */
function todoCard(h, chatId) {
  const composer = document.getElementById(`agent-message-${chatId}`)?.form
  const section = composer?.closest('section.agent-chat')
  if (!section) return { ok: false, section: false }
  const card = section.querySelector('section.todo-card[aria-label="To-dos"]')
  if (!card) return { ok: false, card: false }
  const count = card.querySelector('.todo-card-header > span')?.textContent ?? ''
  const shownTodoCalls = section.querySelectorAll('li.chat-tool[aria-label="Tool call: TodoWrite"]').length
  const above = h.rect(card).bottom <= h.rect(composer).top + 1
  return { ok: /^\d+\/\d+$/.test(count) && above && shownTodoCalls === 0, count, above, shownTodoCalls }
}

/** How many TodoWrite calls the chat stored: the card hides calls the agent really made. */
async function storedTodoCalls(_h, folder, chatId) {
  const snapshot = await window.dm.agentChat.snapshot({ folder, chatId })
  const count = snapshot.ok ? snapshot.data.items.filter((item) => item.kind === 'tool_call' && item.name === 'TodoWrite').length : 0
  return { ok: count > 0, count }
}

/** Step 4b: `[todo]` shows the To-dos card above the composer with its count, and no TodoWrite card in the transcript. */
async function todo(session, signal) {
  const { chatId } = session.chat
  await until(session, signal, composeAndSend, chatId, '[todo]')
  await until(session, signal, turnDone, session.folderPath, chatId, { text: '[todo]' })
  const card = await until(session, signal, todoCard, chatId)
  const stored = await until(session, signal, storedTodoCalls, session.folderPath, chatId)
  return { card, storedTodoCalls: stored.count, screenshot: await capture(session, 'e2e-todo.png', WINDOW) }
}

/** The chat's record, as the renderer lists it. */
async function listedChat(_h, folder, chatId) {
  const listed = await window.dm.chats.list(folder)
  const chat = listed.ok ? listed.data.find((entry) => entry.id === chatId) : undefined
  return { ok: chat !== undefined, surface: chat?.surface ?? null, sessionId: chat?.sessionId ?? null }
}

/** The chat's record carries `title`, the name the fake agent gave it through `dm call name_chat`. Self-contained. */
async function chatNamed(_h, folder, chatId, title) {
  const listed = await window.dm.chats.list(folder)
  const chat = listed.ok ? listed.data.find((entry) => entry.id === chatId) : undefined
  return { ok: chat?.title === title, title: chat?.title ?? null, titleStatus: chat?.titleStatus ?? null }
}

/** The terminal pane with its xterm, and the main-side screen of the running PTY (xterm draws on a canvas). */
async function terminalScreen(h, folder, chatId) {
  if (!h) return { ok: false, reason: 'the page was reloaded' }
  const pane = document.querySelector('section.terminal-pane')
  if (!pane) return { ok: false, pane: false }
  const attached = await window.dm.terminals.attach(folder, chatId)
  if (!attached.ok) return { ok: false, error: attached.error.message }
  if (attached.data.terminal) attached.data.terminal.close()
  return {
    ok: attached.data.state === 'running', state: attached.data.state, screen: attached.data.snapshot ?? '',
    xterm: !!pane.querySelector('[data-testid="terminal-host"] .xterm'), pane: pane.getAttribute('aria-label'),
    notice: pane.querySelector('.chat-header .note[role="alert"]')?.textContent ?? null
  }
}

/** The chat runs in the terminal pane: its record on the terminal with the same session, the xterm, the TUI's banner. */
async function terminalShown(session, signal) {
  const { chatId, sessionId } = session.chat
  return waitFor(async () => {
    const record = await page(session, listedChat, session.folderPath, chatId)
    const terminal = await page(session, terminalScreen, session.folderPath, chatId)
    const banner = terminal.ok && terminal.screen.includes(`fake-tui ready ${sessionId}`)
    session.lastProbe = { record, terminal: { ...terminal, screen: undefined }, banner }
    const ok = record.surface === 'terminal' && record.sessionId === sessionId && terminal.xterm && banner
    return ok && { surface: record.surface, sessionId: record.sessionId, xterm: terminal.xterm, banner, state: terminal.state, pane: terminal.pane, notice: terminal.notice }
  }, signal)
}

function guiResumed(h, folder, chatId) {
  if (!h) return { ok: false, reason: 'the page was reloaded' }
  return window.dm.chats.list(folder).then((listed) => {
    const chat = listed.ok ? listed.data.find((entry) => entry.id === chatId) : null
    const composer = document.getElementById(`agent-message-${chatId}`)
    return { ok: chat?.surface === 'gui' && !!composer && !composer.disabled, surface: chat?.surface ?? null, composer: !!composer }
  })
}

function grantDatabase(session) {
  const projects = join(session.env.DARKMECHANICUS_HOME, 'projects')
  const [project, ...others] = readdirSync(projects)
  if (project === undefined || others.length > 0) throw new Error(`Expected one project under ${projects}.`)
  return join(projects, project, 'local', 'state.sqlite')
}

/** The grant row a launch's `grantHash` names, read-only from the project's database. */
function grantOf(session, grantHash) {
  const db = new DatabaseSync(grantDatabase(session), { readOnly: true })
  try {
    const row = db.prepare('SELECT id, created_at, revoked_at FROM grants WHERE token_hash = ?').get(grantHash)
    if (row === undefined) throw new Error('No grant row matches the terminal launch.')
    return { id: row.id, createdAt: row.created_at, revokedAt: row.revoked_at }
  } finally {
    db.close()
  }
}

/**
 * Clicks the terminal header's GUI button and answers the app's native "Stop the terminal" dialog with `button`,
 * saving the dialog window as `<out>/<file>`. The helper waits for the dialog before the click is sent, and acts only
 * on a window of the isolated app's process.
 */
async function answerTerminalStop(session, signal, button, file) {
  const scope = 'section.terminal-pane .chat-title-row'
  await until(session, signal, buttonReady, scope, 'GUI')
  const answered = session.dialogs.request({
    op: 'dialog', pid: session.child.pid, title: TERMINAL_STOP_TITLE, button, png: join(session.out, file), timeoutMs: 5_000
  })
  const clicked = await page(session, clickButton, scope, 'GUI')
  if (!clicked.ok) throw new Error(`The GUI button could not be clicked: ${JSON.stringify(clicked)}`)
  const answer = await answered
  const png = pngSize(readFileSync(answer.png))
  for (const label of ['Cancel', 'Stop terminal and switch']) {
    if (!answer.buttons.includes(label)) throw new Error(`The native dialog has no "${label}" button: ${answer.buttons.join(', ')}`)
  }
  return { ...answer, png: file, pngSize: `${png.width}x${png.height}` }
}

/**
 * Step 5: GUI → terminal (the fake TUI resumes the session), then terminal → GUI through the native confirmation:
 * Cancel first changes nothing, then an explicit confirmation stops the terminal (process exit and grant revocation)
 * before the GUI resumes the same session, all without a reload.
 */
async function toggle(session, signal) {
  if (session.dialogs === null) throw new Error('The toggle step answers a native dialog through Windows UI Automation; it runs on Windows only.')
  const { chatId, sessionId } = session.chat
  const folder = session.folderPath
  const [gui] = chatLaunches(readLog(session), sessionId)
  await session.dialogs.request({ op: 'watch', pid: gui.pid })
  await until(session, signal, clickButton, 'section.agent-chat header.agent-chat-header', 'Terminal')
  const terminal = await waitFor(() => chatLaunches(readLog(session), sessionId).find((launch) => launch.surface === 'terminal'), signal)
  await session.dialogs.request({ op: 'watch', pid: terminal.pid })
  const shown = await terminalShown(session, signal)
  const guiExit = await session.dialogs.request({ op: 'exitTime', pid: gui.pid })
  if (!guiExit.exited || guiExit.exitMs > terminal.at) throw new Error(`The GUI process did not exit before the terminal launched: ${JSON.stringify(guiExit)}`)
  const terminalCapture = await capture(session, 'e2e-toggle-terminal.png', WINDOW)

  const cancel = await answerTerminalStop(session, signal, 'Cancel', 'e2e-toggle-dialog-cancel.png')
  await until(session, signal, buttonReady, 'section.terminal-pane .chat-title-row', 'GUI')
  const afterCancel = await terminalShown(session, signal)
  const stillRunning = await session.dialogs.request({ op: 'exitTime', pid: terminal.pid })
  const launchesAfterCancel = chatLaunches(readLog(session), sessionId)
  const grantAfterCancel = grantOf(session, terminal.grantHash)
  if (stillRunning.exited || !isAlive(terminal.pid)) throw new Error('Cancel stopped the terminal.')
  if (launchesAfterCancel.length !== 2) throw new Error(`Cancel launched something: ${JSON.stringify(launchesAfterCancel)}`)
  if (grantAfterCancel.revokedAt !== null) throw new Error('Cancel revoked the terminal grant.')
  const cancelledCapture = await capture(session, 'e2e-toggle-cancelled.png', WINDOW)

  const confirm = await answerTerminalStop(session, signal, 'Stop terminal and switch', 'e2e-toggle-dialog-confirm.png')
  await until(session, signal, guiResumed, folder, chatId)
  const shownAgain = await sendInChat(session, signal, { chatId, text: 'again', reply: 'Hello world' })
  const launches = assertToggleLaunches(chatLaunches(readLog(session), sessionId))
  const terminalExit = await session.dialogs.request({ op: 'exitTime', pid: terminal.pid })
  const grant = grantOf(session, terminal.grantHash)
  const order = assertHandoffOrder({
    confirmedAt: confirm.clickedAt, terminalExitedAt: terminalExit.exitMs,
    grantRevokedAt: grant.revokedAt === null ? Number.NaN : Date.parse(grant.revokedAt), resumedAt: launches.resumed.at
  })
  return {
    sessionId, launches, guiExitedAt: guiExit.exitMs, terminal: shown,
    cancel: { dialog: cancel, after: afterCancel, terminalPid: terminal.pid, terminalAlive: true, grantRevokedAt: grantAfterCancel.revokedAt, launches: launchesAfterCancel.length },
    confirm: { dialog: confirm, grant, order }, messages: shownAgain.messages,
    screenshots: [terminalCapture, cancelledCapture, await capture(session, 'e2e-toggle.png', WINDOW)]
  }
}

function clickEpic(_h, title) {
  const row = [...document.querySelectorAll('button.epic-row')].find((button) => button.querySelector('.epic-row-title')?.textContent === title)
  if (!row) return { ok: false }
  row.click()
  return { ok: true }
}

function agentToggle(_h) {
  const toggle = document.querySelector('section.ew[aria-label="Epic workspace"] button.ew-toggle-agent')
  if (!toggle) return { ok: false }
  if (toggle.getAttribute('aria-pressed') !== 'true') toggle.click()
  return { ok: toggle.getAttribute('aria-pressed') === 'true' }
}

/**
 * The Epic agents rail lies right of the stage, open, and its tree's visible rows include each `[name, level]` of
 * `expected`. Self-contained: `page` serializes only this function.
 */
function railHas(h, expected) {
  const aside = document.querySelector('section.eap aside[aria-label="Epic agents"]')
  const stage = document.querySelector('section.eap .eap-centre')
  if (!aside || !stage) return { ok: false, aside: !!aside, stage: !!stage }
  const rows = [...aside.querySelectorAll('[role="treeitem"]')].map((item) => ({
    name: item.getAttribute('aria-label'), level: Number(item.getAttribute('aria-level')), expanded: item.getAttribute('aria-expanded'),
    unverified: item.querySelector(':scope > .at-row .at-unverified')?.getAttribute('title') ?? null
  }))
  const right = h.rect(aside).left >= h.rect(stage).right - 1
  // An <aside> with an accessible name is a complementary landmark.
  const role = aside.getAttribute('role') ?? (aside.tagName === 'ASIDE' && aside.hasAttribute('aria-label') ? 'complementary' : null)
  const found = expected.every(([name, level]) => rows.some((row) => row.name === name && row.level === level))
  const open = aside.getAttribute('data-collapsed') !== 'true'
  return { ok: right && role === 'complementary' && open && found, right, role, open, rows }
}

function plannerKickoff(h) {
  const section = document.querySelector('section.eap .eap-centre section.agent-chat[aria-label="Lexmechanic chat"]')
  const kickoff = h.messages(section).find((message) => message.who === 'You')
  return { ok: !!kickoff && kickoff.text.startsWith('Plan this Dark Mechanicus epic'), kickoff: kickoff?.text.slice(0, 80) ?? null }
}

function threadView(_h) {
  const section = document.querySelector('section.eap section.agent-chat[aria-label="Acolyte:DM-2 thread"]')
  if (!section) return { ok: false }
  const items = section.querySelectorAll('.chat-transcript li').length
  const hint = section.querySelector('.agent-chat-hint')?.textContent ?? null
  const relayLabel = section.querySelector('form.agent-chat-composer label')?.textContent ?? null
  const ownComposer = !!section.querySelector('textarea[id^="agent-message-"]')
  return {
    ok: items > 0 && hint === 'Your message goes through Lexmechanic, which passes it to this worker.' && relayLabel === 'Message Acolyte:DM-2' && !ownComposer,
    items, hint, relayLabel, ownComposer
  }
}

/** The epic View buttons in their displayed order, and the stage each one opens. */
const EPIC_VIEWS = [
  ['Agent', 'section.eap'],
  ['Graph', '[aria-label="Plan graph"]'],
  ['List', '[aria-label="Plan list"]'],
  ['Scorecard', 'section.es[aria-labelledby="es-title"]']
]

/**
 * The epic header holds one row: the breadcrumb is a single line left of the View group, overlapping it neither
 * across nor down, and carries its text as a title; nothing in the heading spills past it and nothing in the header
 * past the window; the View group reads Agent, Graph, List, Scorecard with the mascot on Agent. Self-contained:
 * `page` serializes only this function.
 */
function headerRow(h, order) {
  const header = document.querySelector('section.ew[aria-label="Epic workspace"] header.ew-header')
  const found = ['.ew-heading', '.ew-crumb', '[role="group"][aria-label="View"]'].map((selector) => header?.querySelector(selector) ?? null)
  if (found.includes(null)) return { ok: false, found: found.map(Boolean) }
  const [heading, crumb, view] = found
  const box = { header: h.rect(header), heading: h.rect(heading), crumb: h.rect(crumb), view: h.rect(view) }
  const buttons = [...view.querySelectorAll('button')].map((button) => button.textContent.trim())
  const checks = {
    oneLine: box.crumb.height <= parseFloat(getComputedStyle(crumb).lineHeight) + 1,
    beside: box.heading.right <= box.view.left + 0.5,
    contained: [...heading.querySelectorAll('*')].every((element) => h.rect(element).right <= box.heading.right + 0.5),
    fits: header.scrollWidth <= header.clientWidth && box.header.right <= innerWidth,
    sameRow: box.crumb.top < box.view.bottom && box.crumb.bottom > box.view.top,
    titled: crumb.title === crumb.textContent,
    mascot: !!view.querySelector('button.ew-toggle-agent:first-child .mascot-glyph'),
    ordered: JSON.stringify(buttons) === JSON.stringify(order)
  }
  return { ok: Object.values(checks).every(Boolean), ...checks, buttons, box }
}

/** Presses `label` in the epic View group (once) until it is pressed and `selector`'s stage is shown. */
function showView(h, label, selector) {
  const button = h.button(document.querySelector('section.ew[aria-label="Epic workspace"] [role="group"][aria-label="View"]'), label)
  if (!button) return { ok: false, label, found: false }
  if (button.getAttribute('aria-pressed') !== 'true') button.click()
  const shown = !!document.querySelector(selector)
  return { ok: button.getAttribute('aria-pressed') === 'true' && shown, label, shown }
}

function focusView(h, label) {
  const button = h.button(document.querySelector('section.ew[aria-label="Epic workspace"] [role="group"][aria-label="View"]'), label)
  button?.focus()
  return { ok: !!button && document.activeElement === button, label }
}

function focusedLabel(_h) {
  const active = document.activeElement
  const inView = !!active?.closest('section.ew[aria-label="Epic workspace"] [role="group"][aria-label="View"]')
  return { ok: true, label: inView ? active.textContent.trim() : null }
}

/** Real Tab presses from the first View button: the focus visits each View button once, in the displayed order. */
async function tabThroughView(session, signal) {
  await until(session, signal, focusView, EPIC_VIEWS[0][0])
  const visited = [EPIC_VIEWS[0][0]]
  for (let index = 1; index < EPIC_VIEWS.length; index++) {
    for (const type of ['rawKeyDown', 'keyUp']) {
      await cdp(session, 'Input.dispatchKeyEvent', { type, key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
    }
    visited.push((await page(session, focusedLabel)).label)
  }
  const expected = EPIC_VIEWS.map(([label]) => label)
  if (JSON.stringify(visited) !== JSON.stringify(expected)) throw new Error(`Tab visits the View group as ${JSON.stringify(visited)}, not ${JSON.stringify(expected)}`)
  return visited
}

/**
 * Every other view opens from the View group in displayed order and Agent returns to the same selected worker thread;
 * the header holds one row at `size`, which is captured after Agent returns.
 */
async function epicViews(session, signal, size, file) {
  const order = EPIC_VIEWS.map(([label]) => label)
  const header = await until(session, signal, headerRow, order)
  const tabOrder = await tabThroughView(session, signal)
  for (const [label, selector] of [...EPIC_VIEWS.slice(1), EPIC_VIEWS[0]]) await until(session, signal, showView, label, selector)
  const thread = await until(session, signal, threadView)
  return { header: { buttons: header.buttons, box: header.box }, tabOrder, thread, screenshot: await capture(session, file, size) }
}

/**
 * Step 6: the saved epic's Agent stage starts the planner (Lexmechanic) and, after `[subagent_tree]`, names its
 * workers in the rail's tree; a finished worker sits in the collapsed Finished group; a row opens its thread read-only.
 */
async function epicAgent(session, signal) {
  await resizeWindow(session, signal, WIDE_WINDOW)
  await until(session, signal, clickEpic, EPIC_TITLE)
  await until(session, signal, agentToggle)
  await until(session, signal, clickButton, 'section.eap .eap-empty', 'Start planner')
  const { chat } = await until(session, signal, chatRecord, session.folderPath, { role: 'planner', epicId: session.epicId })
  const kickoff = await until(session, signal, plannerKickoff)
  await until(session, signal, turnDone, session.folderPath, chat.id, { text: 'Plan this Dark Mechanicus epic', prefix: true })
  const root = await until(session, signal, railHas, [['Lexmechanic', 1]])
  await until(session, signal, composeAndSend, chat.id, '[subagent_tree]')
  await until(session, signal, turnDone, session.folderPath, chat.id, { text: '[subagent_tree]' })
  const tree = await until(session, signal, railHas, [['Lexmechanic', 1], ['Acolyte:DM-2', 2], ['Inquisitor:DM-2', 3], ['Finished 1', 2]])
  const finished = tree.rows.find((row) => row.name === 'Finished 1')
  if (finished.expanded !== 'false' || tree.rows.some((row) => row.name === 'Acolyte:DM-1')) {
    throw new Error(`The Finished group is not collapsed by default: ${JSON.stringify(tree.rows)}`)
  }
  await until(session, signal, clickSelector, 'aside[aria-label="Epic agents"] [role="treeitem"][aria-label="Finished 1"] > .at-row')
  const expanded = await until(session, signal, railHas, [['Acolyte:DM-1', 3]])
  const workers = expanded.rows.filter((row) => row.name !== 'Lexmechanic' && row.name !== 'Finished 1')
  if (workers.some((row) => row.unverified !== 'Not confirmed by a claim')) throw new Error(`A worker is shown verified: ${JSON.stringify(workers)}`)
  await until(session, signal, clickSelector, 'aside[aria-label="Epic agents"] [role="treeitem"][aria-label="Acolyte:DM-2"] > .at-row')
  const thread = await until(session, signal, threadView)
  const wide = await epicViews(session, signal, WIDE_WINDOW, 'e2e-epic-agent.png')
  await resizeWindow(session, signal, WINDOW)
  const narrow = await until(session, signal, railHas, [['Acolyte:DM-2', 2]])
  const compact = await epicViews(session, signal, WINDOW, 'e2e-epic-agent-1024.png')
  return {
    planner: chat, kickoff, root: root.rows, collapsedTree: tree.rows, expandedTree: expanded.rows, thread, narrowRailRight: narrow.right,
    views: { wide, compact }, screenshots: [wide.screenshot, compact.screenshot]
  }
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
  session.page?.socket.close()
  session.page = null
}

/** Asks the app for a normal quit and waits for a clean exit; at the deadline the process tree is killed. */
async function quit(session, signal) {
  const { child } = session
  if (child === null) return { launched: false }
  closeSocket(session)
  if (!isRunning(child)) throw new Error(`The app exited before quit (code ${child.exitCode}).`)
  signal.addEventListener('abort', () => forceKill(child), { once: true })
  await tellApp(session, 'quit')
  // An attached inspector session would hold the packaged app's exit; it is closed before the wait.
  session.main?.socket.close()
  session.main = null
  const { code, signal: killedBy } = await session.exited
  if (code !== 0) throw new Error(`The app exited with code ${code}${killedBy ? ` (${killedBy})` : ''}.`)
  return { exitCode: code }
}

async function fakeProcessesExited(session, signal) {
  session.fakePids = fakeAgentPids(readLog(session))
  await waitFor(() => session.fakePids.every((pid) => !isAlive(pid)), signal)
  return { checkedPids: session.fakePids }
}

/**
 * Step 7: quit the app; every protocol-mode and TUI-mode fake agent is gone. The capture is the last state before it,
 * once the new chat (when the run made one) carries the title the fake named it with.
 */
async function quitApp(session, signal) {
  const named = session.chat === null ? null : await until(session, signal, chatNamed, session.folderPath, session.chat.chatId, FAKE_CHAT_TITLE)
  const screenshot = await capture(session, 'e2e-quit.png', WINDOW)
  const exited = await quit(session, signal)
  return { ...exited, ...await fakeProcessesExited(session, signal), newChatTitle: named?.title ?? null, screenshot }
}

/** The fixed session id of the seeded Magos chat, and the version its restart marker says the app was updated from. */
const RESTART_SESSION_ID = '0d5c8e2a-7f41-4b6e-9a3d-5e8f1c2b4a60'
const RESTART_FROM_VERSION = '0.0.1'
const RESTART_REPLY = 'Hello world'
const NO_RESUME_WINDOW_MS = 5_000

/** The marker Restart now writes (`restartResume.ts`, `writeRestartMarker`), listing one chat. */
export function restartMarker({ fromVersion, writtenAt, folder, chatId }) {
  return { fromVersion, writtenAt, chats: [{ folder, chatId }] }
}

/**
 * The seeded Magos: `create` is the chat store's `createChat` input (an orchestrator GUI chat of the claude-kind fake,
 * bound to the epic; the seeder adds the started run's id), `patch` then gives it its fixed session id.
 */
export function restartChat({ folder, epicId, sessionId }) {
  return {
    create: { folder, agent: 'claude', model: null, role: 'orchestrator', allowSave: true, epicId, surface: 'gui', title: 'Restart resume Magos' },
    patch: { sessionId }
  }
}

/** Where Claude Code keeps a session (`claudeSession.ts`): `<config>/projects/<folder, non-alphanumerics as ->/<id>.jsonl`. */
export function claudeSessionPath(configDir, folder, sessionId) {
  return join(configDir, 'projects', folder.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`)
}

/** The app's one restart message (`restartResume.ts`, `restartResumeText`); scripts cannot import TypeScript. */
export function restartResumeText(from, to) {
  return `[App restarted after an update from v${from} to v${to}: resume your run from get_run]`
}

/** Whether `x.y.z` version `a` is newer than `b`. */
export function newerVersion(a, b) {
  const [left, right] = [a, b].map((version) => version.split('.').map(Number))
  const index = left.findIndex((part, at) => part !== right[at])
  return index >= 0 && left[index] > right[index]
}

/**
 * The restart messages `text` in a transcript's items and the reply right after the last one: `ok` when there is
 * exactly one and the assistant's `reply` follows it.
 */
export function restartTurn(items, text, reply) {
  const sent = items.flatMap((item, index) => (item.kind === 'user_message' && item.text === text ? [index] : []))
  const after = sent.length > 0 ? items.slice(sent.at(-1) + 1).find((item) => item.kind === 'assistant_text') : undefined
  return { ok: sent.length === 1 && after?.text === reply, messages: sent.length, reply: after?.text ?? null }
}

/** Starts a run of the seeded epic, then creates its Magos through the app's chat store and gives it its session. */
const RESTART_SEED_SOURCE = `
import { openWorkspace } from './src/core/workspace'
import { createChatStore } from './src/main/agents/chatStore'
const seed = JSON.parse(process.argv[2])
async function main() {
  const workspace = openWorkspace({ repoRoot: seed.folder, homeDir: seed.dmHome, role: 'orchestrator', transport: 'in_process', label: 'e2e restart seed' })
  let runId
  try {
    runId = (await workspace.startRun({ epicId: seed.epicId })).id
  } finally {
    workspace.close()
  }
  const store = createChatStore({ root: seed.chats })
  const created = store.createChat({ ...seed.chat, runId })
  const chat = store.updateChat({ folder: created.folder, id: created.id }, seed.patch)
  process.stdout.write(JSON.stringify({ runId, chat }))
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
`

const chatsRoot = (session) => join(session.userData, 'agents', 'chats')
const markerFile = (session) => join(session.userData, 'agents', 'restart-resume.json')

function bundle(session, name, contents) {
  const outfile = join(session.root, name)
  buildSync({
    absWorkingDir: REPO, stdin: { resolveDir: REPO, contents, loader: 'ts' }, outfile,
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', logLevel: 'warning'
  })
  return outfile
}

/** The app's own chat store over the isolated profile, read in this process. */
function chatStore(session) {
  session.store ??= require(bundle(session, 'chat-store.cjs', `export { createChatStore } from './src/main/agents/chatStore'`))
    .createChatStore({ root: chatsRoot(session) })
  return session.store
}

function writeMarker(session, fromVersion) {
  const { folder, chatId } = session.restart
  const marker = restartMarker({ fromVersion, writtenAt: new Date().toISOString(), folder, chatId })
  mkdirSync(dirname(markerFile(session)), { recursive: true })
  writeFileSync(markerFile(session), JSON.stringify(marker))
  return marker
}

function restartTranscript(session) {
  const { folder, chatId } = session.restart
  const transcript = chatStore(session).readTranscript({ folder, id: chatId })
  if (transcript === null) throw new Error(`The chat store has no chat ${chatId}.`)
  return transcript
}

/**
 * Restart phase 1, with the app stopped: the run's Magos (a GUI chat on session U) through the app's chat store, the
 * fake's session file for U, so the app resumes it, and the marker Restart now would leave, from v0.0.1.
 */
async function restartSeed(session) {
  if (session.child !== null && isRunning(session.child)) {
    throw new Error('restart-resume starts the app itself: run it alone or after quit.')
  }
  const folder = realpathSync.native(session.folder)
  const { create, patch } = restartChat({ folder, epicId: session.epicId, sessionId: RESTART_SESSION_ID })
  const seeder = bundle(session, 'restart-seed.cjs', RESTART_SEED_SOURCE)
  const input = { folder, dmHome: session.env.DARKMECHANICUS_HOME, epicId: session.epicId, chats: chatsRoot(session), chat: create, patch }
  const result = spawnSync(process.execPath, [seeder, JSON.stringify(input)], { env: session.env, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`Seeding the restart chat failed: ${result.stderr || result.error}`)
  const { runId, chat } = JSON.parse(result.stdout)
  const stored = chatStore(session).getChat({ folder, id: chat.id })
  if (stored?.sessionId !== RESTART_SESSION_ID || stored.role !== 'orchestrator' || stored.surface !== 'gui' || stored.runId !== runId) {
    throw new Error(`The chat store does not hold the seeded Magos: ${JSON.stringify(stored)}`)
  }
  const sessionFile = claudeSessionPath(session.env.CLAUDE_CONFIG_DIR, folder, RESTART_SESSION_ID)
  mkdirSync(dirname(sessionFile), { recursive: true })
  writeFileSync(sessionFile, `${JSON.stringify({ type: 'system', sessionId: RESTART_SESSION_ID })}\n`)
  session.restart = { folder, chatId: chat.id, runId, version: null, launchesBefore: null }
  const marker = writeMarker(session, RESTART_FROM_VERSION)
  const { id, agent, role, surface, sessionId, epicId } = stored
  return { chat: { id, agent, role, surface, sessionId, runId: stored.runId, epicId }, sessionFile, marker }
}

/** Launches the app on the seeded profile and reads its runtime version, the one the header shows. */
async function restartLaunch(session, signal) {
  const ready = await appReady(session, signal)
  const version = await evaluate(session, 'window.appInfo.getVersion()')
  if (!/^\d+\.\d+\.\d+$/.test(version) || !newerVersion(version, RESTART_FROM_VERSION)) {
    throw new Error(`The app's runtime version ${version} is not newer than v${RESTART_FROM_VERSION}.`)
  }
  return { runtimeVersion: version, headerVersion: ready.headerVersion, folder: ready.folder, cdpPort: ready.cdpPort }
}

/** Phase 3: one protocol launch with `--resume U`, the fixed message and the fake's reply stored, the marker gone. */
async function restartResumed(session, signal) {
  const text = restartResumeText(RESTART_FROM_VERSION, await evaluate(session, 'window.appInfo.getVersion()'))
  const launch = await waitFor(() => chatLaunches(readLog(session), RESTART_SESSION_ID)[0], signal)
  const resumeLaunch = fakeAgentLog(readLog(session)).find((entry) => entry.pid === launch.pid)
  if (resumeLaunch.mode !== 'claude' || launch.flag !== '--resume') {
    throw new Error(`The chat was launched ${resumeLaunch.mode} ${launch.flag}, not in protocol mode with --resume.`)
  }
  const turn = await waitFor(() => {
    session.lastProbe = restartTurn(restartTranscript(session).items, text, RESTART_REPLY)
    return session.lastProbe.ok && session.lastProbe
  }, signal)
  if (existsSync(markerFile(session))) throw new Error('The restart marker is still present.')
  const launches = chatLaunches(readLog(session), RESTART_SESSION_ID)
  if (launches.length !== 1) throw new Error(`The chat was launched ${launches.length} times: ${JSON.stringify(launches)}`)
  session.restart.text = text
  return { text, launch: { mode: resumeLaunch.mode, argv: resumeLaunch.argv, pid: launch.pid }, turn, markerRemoved: true }
}

/** Opens the epic (unless a remembered selection already shows it). */
function openEpic(h, title) {
  if (document.querySelector('section.ew[aria-label="Epic workspace"]')) return { ok: true, already: true }
  const row = [...document.querySelectorAll('button.epic-row')].find((button) => button.querySelector('.epic-row-title')?.textContent === title)
  if (!row) return { ok: false }
  row.click()
  return { ok: true, already: false }
}

/**
 * Phase 4: the epic's Agent tab shows the Magos with the restart message and the fake's reply. Captured at the
 * standard window, the size every step but `epic-agent` uses and the size the relaunched app is set to on start.
 */
async function restartShown(session, signal) {
  const { chatId, text } = session.restart
  await until(session, signal, openEpic, EPIC_TITLE)
  await until(session, signal, agentToggle)
  const shown = await until(session, signal, guiShows, chatId, text, RESTART_REPLY)
  return { section: shown.section, answered: shown.answered, screenshot: await capture(session, 'e2e-restart-resume.png', WINDOW) }
}

function leaveEpic(_h, name) {
  const epic = document.querySelector('section.ew[aria-label="Epic workspace"]')
  if (!epic) return { ok: true }
  const folder = [...document.querySelectorAll('button.folder-main')].find((button) => button.querySelector('.folder-name')?.textContent === name)
  folder?.click()
  return { ok: false, folder: !!folder }
}

/**
 * Phase 5: a plain quit, with the folder home shown so the next start opens no chat view (which would start the
 * chat). The app's processes all exit and no marker is written: only Restart now writes one.
 */
async function restartPlainQuit(session, signal) {
  await until(session, signal, leaveEpic, FOLDER_NAME)
  const exited = await quit(session, signal)
  const fakes = await fakeProcessesExited(session, signal)
  if (existsSync(markerFile(session))) throw new Error('A plain quit wrote a restart marker.')
  return { ...exited, ...fakes, markerWritten: false }
}

/** Phase 6: a marker from the version the app runs now, then a start. */
async function restartEqualLaunch(session, signal) {
  const { version } = session
  session.restart.launchesBefore = chatLaunches(readLog(session), RESTART_SESSION_ID).length
  const marker = writeMarker(session, version)
  const launched = await restartLaunch(session, signal)
  if (launched.runtimeVersion !== version) throw new Error(`The marker says v${version}; the app runs v${launched.runtimeVersion}.`)
  return { marker, ...launched }
}

/** Phase 7: in 5 s the equal-version marker launches nothing for the chat and adds no message; it is consumed. */
async function restartEqualVersion(session, signal) {
  await delay(NO_RESUME_WINDOW_MS, undefined, { signal })
  const launches = chatLaunches(readLog(session), RESTART_SESSION_ID)
  if (launches.length !== session.restart.launchesBefore) {
    throw new Error(`The equal-version start launched the chat: ${JSON.stringify(launches.slice(session.restart.launchesBefore))}`)
  }
  if (existsSync(markerFile(session))) throw new Error('The equal-version marker was not consumed.')
  const turn = restartTurn(restartTranscript(session).items, session.restart.text, RESTART_REPLY)
  if (!turn.ok) throw new Error(`The transcript no longer holds exactly one restart message: ${JSON.stringify(turn)}`)
  const exited = await quit(session, signal)
  return { waitedMs: NO_RESUME_WINDOW_MS, launches: launches.length, markerRemoved: true, turn, ...exited, ...await fakeProcessesExited(session, signal) }
}

const STEPS = {
  ready: { name: 'app ready', run: appReady },
  'new-chat': { name: 'new-chat', run: newChat },
  stream: { name: 'stream', run: stream },
  tool: { name: 'tool', run: tool },
  approval: { name: 'approval', run: approval },
  todo: { name: 'todo', run: todo },
  toggle: { name: 'toggle', run: toggle },
  'epic-agent': { name: 'epic-agent', run: epicAgent },
  quit: { name: 'quit', run: quitApp },
  'restart-resume': {
    phases: [
      { name: 'restart-resume seed', run: restartSeed },
      { name: 'restart-resume launch', run: restartLaunch },
      { name: 'restart-resume resumed', run: restartResumed },
      { name: 'restart-resume shown', run: restartShown },
      { name: 'restart-resume plain quit', run: restartPlainQuit },
      { name: 'restart-resume equal-version launch', run: restartEqualLaunch },
      { name: 'restart-resume equal version', run: restartEqualVersion }
    ]
  }
}

async function captureFailure(session, step) {
  const detail = { stderrTail: session.stderr.trimEnd().split(/\r?\n/).slice(-STDERR_TAIL_LINES), lastProbe: session.lastProbe }
  if (session.page?.socket.readyState !== WebSocket.OPEN) return { ...detail, screenshot: null, screenshotSkipped: 'no renderer connection' }
  const bound = delay(SCREENSHOT_BOUND_MS).then(() => { throw new Error('screenshot timed out') })
  const { data } = await Promise.race([cdp(session, 'Page.captureScreenshot', { format: 'png' }), bound])
  const file = join(session.out, failureScreenshotName(step))
  writeFileSync(file, Buffer.from(data, 'base64'))
  return { ...detail, screenshot: file }
}

async function runSteps(session, keys, steps) {
  const onFailure = (step) => captureFailure(session, step)
  steps.push(await runStep('stale isolated roots removed', async () => removeStaleRoots()))
  const prepared = await runStep('setup', async () => setup(session), { onFailure })
  steps.push(prepared)
  steps: for (const key of prepared.ok ? keys : []) {
    for (const phase of STEPS[key].phases ?? [STEPS[key]]) {
      const result = await runStep(phase.name, (signal) => phase.run(session, signal), { onFailure })
      steps.push(result)
      if (!result.ok) break steps
    }
  }
  // Whatever stopped before the quit step still ends the app and checks its fakes.
  if (session.child === null || isRunning(session.child)) {
    steps.push(await runStep('quit (cleanup)', (signal) => quit(session, signal), { onFailure }))
    steps.push(await runStep('fake processes exited (cleanup)', (signal) => fakeProcessesExited(session, signal), {
      onFailure: async () => ({ alive: session.fakePids.filter((pid) => isAlive(pid)) })
    }))
  }
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

export function parseArgs(argv) {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
  const out = value('--out')
  if (!out) throw new Error(`Usage: node scripts/e2e-agent-chat.mjs --out <dir> [--exe <packaged app exe>] [--steps ${Object.keys(STEPS).join(',')}]`)
  if (argv.includes('--exe') && !value('--exe')) throw new Error('--exe needs the path of a packaged app executable.')
  const keys = value('--steps')?.split(',') ?? Object.keys(STEPS)
  const unknown = keys.filter((key) => !Object.hasOwn(STEPS, key))
  if (unknown.length > 0) throw new Error(`Unknown step(s) ${unknown.join(', ')}; known: ${Object.keys(STEPS).join(', ')}`)
  const exe = value('--exe')
  return { out: resolve(out), exe: exe === undefined ? null : resolve(exe), keys }
}

async function main(argv) {
  const { out, exe, keys } = parseArgs(argv)
  mkdirSync(out, { recursive: true })
  const session = createSession(out, exe)
  const steps = []
  try {
    await runSteps(session, keys, steps)
  } finally {
    forceKill(session.child)
    closeSocket(session)
    session.main?.socket.close()
    stopDialogHelper(session)
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
