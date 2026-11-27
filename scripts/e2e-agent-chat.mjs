/**
 * Built-app e2e harness for agent chats. Launches the built Electron app (run `npm run build` first) with an isolated
 * profile and the deterministic fake agent CLI seeded as the built-in `claude` agent (`fake-claude`) and, with
 * `--agent omp`, also as the built-in `omp` (Skitarii) agent (`fake-omp`), drives it over CDP and runs named steps, each
 * exactly once under a 10 s condition-based deadline with no retries.
 *
 *   node scripts/e2e-agent-chat.mjs --out <dir> [--exe <packaged app exe>] [--agent claude|omp] [--steps ready,new-chat,stream,tool,approval,todo,toggle,epic-agent,quit,restart-resume]
 *   node scripts/e2e-agent-chat.mjs --out <dir> --steps polish-picker,polish-composer,polish-copy,polish-multiselect,polish-worked-for,polish-untrack
 *   node scripts/e2e-agent-chat.mjs --out <dir> --steps polish-multiquestion
 *   node scripts/e2e-agent-chat.mjs --out <dir> --steps image-send,image-result
 *   node scripts/e2e-agent-chat.mjs --out <dir> --steps coord-tabs,coord-mail,coord-wake,coord-close
 *   node scripts/e2e-agent-chat.mjs --out <dir> --steps model-pick,model-busy,model-restart
 *
 * `--agent` selects the kind the fixture folder's chats use (its default agent; `claude` when omitted, `omp` when a
 * coord or model step is named). Both shims are always written, but the omp agent is only connected with `--agent omp`:
 * the app prefers a signed-in OMP for a planner, and the Claude steps after `new-chat` drive Claude-protocol scenarios.
 * So `--agent omp` runs only `ready`, `new-chat`, `quit`, the coord and model steps and `polish-multiquestion`.
 *
 * The `polish-*` steps (the polished GUI chat: role picker, composer, Copy, multi-question forms, `Worked for`, untrack)
 * run only when named: `polish-picker` starts the chat the others drive, and `polish-untrack` seeds a second fixture
 * folder. A step list that does not start the app itself (`ready` or `restart-resume`) gets `ready` first.
 * `polish-multiquestion` instead starts its own folder chat on the omp fake (`--agent omp` implied, `--agent claude`
 * refused), which replays the recorded OMP 18.20.2 ask form, and answers all three questions with one Submit.
 *
 * The `image-*` steps (screenshots in GUI chats) also run only when named: `image-send` sends `swatch.png` from a new
 * folder chat's composer, and `image-result` has the seeded epic's Magos (started through Start run) return it from a
 * tool, opens it and attaches it to the epic as evidence.
 *
 * The `coord-*` steps (the epic's Lexmechanic and Magos as tabs, coordinating over Skitarii mail) also run only when
 * named, and they run the omp fake (`--agent omp` is implied; `--agent claude` is refused): `coord-tabs` starts the
 * seeded epic's Magos through Start run and a Lexmechanic from the tab strip's "+", `coord-mail` has the Lexmechanic's
 * fake find the Magos by epic and role and mail it with the real `dm` CLI, `coord-wake` stops the Lexmechanic and has
 * the Magos mail it awake in the GUI, and `coord-close` stops it for good from its tab.
 *
 * The `model-*` steps (a Skitarii chat's composer model picker) also run only when named, on the omp fake (`--agent
 * omp` implied), which starts on Opus 5.5 at High as the person's configured default: `model-pick` opens a new folder
 * chat and switches it to a Codex model at Medium, `model-busy` switches it to a Claude model at High during a `[slow]`
 * turn, and `model-restart` relaunches the app and checks the chat starts again on that model and effort. The fake
 * logs each session control it receives to `<out>/fake-controls.jsonl`.
 *
 * Without `--steps` every step but the polish, image, coord and model ones runs. Writes `<out>/verdict.json` ({steps: [{name, ok, ms, detail}], ok}), a
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
import { execFile, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
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
/** What the fake's OMP persona prints for `--version` (`omp/18.16.0`), as the app stores it. */
const FAKE_OMP_VERSION = '18.16.0'
/** The agent kinds `--agent` takes; with `omp` only these steps run (see the header). */
const AGENT_KINDS = ['claude', 'omp']
const OMP_STEPS = ['ready', 'new-chat', 'quit']
const EPIC_TITLE = 'E2E epic'
/** The window every chat step is captured at, and the wide one the epic's Agent stage with its open rail is. */
const WINDOW = { width: 1024, height: 768 }
const WIDE_WINDOW = { width: 1440, height: 900 }
/** Inherited variables that would redirect the app: `ELECTRON_RUN_AS_NODE=1` alone would start plain Node. */
const STRIPPED_ENV = /^(?:ELECTRON_.*|NODE_OPTIONS|DM_SESSION_TOKEN|DM_DESKTOP_PIPE|DM_BROWSER_PIPE)$/i
/**
 * The protocol (GUI) and TUI invocations, which run until the app stops them. Version, auth and arbiter runs exit by
 * themselves and the app observes that directly; Windows recycles their pids, so they are not checked.
 */
const LONG_LIVED_MODES = new Set(['claude', 'omp', 'tui'])
const TERMINAL_STOP_TITLE = 'Stop the terminal and switch to the GUI?'
/** The isolated roots under the system temp folder, and the file in each naming the harness pid that owns it. */
const ROOT_PREFIX = 'dm-e2e-agent-chat-'
const OWNER_FILE = 'harness.json'
/**
 * A root with no owner file is a fresh run's own until it writes one, or a live run of a harness from before owner
 * files, which lasts minutes. Only one older than any run is stale.
 */
const UNOWNED_GRACE_MS = 6 * 60 * 60_000
/** The title the fake agent names a new chat with (`fakeAgentCli.mjs`, FAKE_CHAT_TITLE); scripts cannot import it. */
const FAKE_CHAT_TITLE = 'Fake agent conversation'
/** The second fixture folder, seeded and tracked only for `polish-untrack`, which untracks it. */
const SECOND_FOLDER_NAME = 'e2e-repo-2'
/** The fake's `[markdown]` reply (`fakeAgentCli.mjs`, MARKDOWN_REPLY) and the code of its fenced block. */
const MARKDOWN_REPLY = 'Here is the **fix**:\n\n```js\nconst answer = 42\nconsole.log(answer)\n```'
const MARKDOWN_CODE = 'const answer = 42\nconsole.log(answer)'
/** The steps that start the app themselves; a step list starting with any other step gets `ready` first. */
const APP_STARTING_STEPS = ['ready', 'restart-resume']
/** The fixture image both `image-*` steps send or receive; the fake's `[image]` tool result carries the same bytes. */
const SWATCH = join(REPO, 'src', 'main', 'agentChat', '__fixtures__', 'images', 'swatch.png')
/** The confirmation the epic shows once Attach as evidence took (`ChatImages.tsx`, AttachEvidence). */
const EVIDENCE_TOAST = 'Attached the image to the epic as evidence.'

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

/**
 * The same shim text as `src/main/agentChat/__mocks__/fakeAgentShim.ts`; scripts cannot import TypeScript. The
 * `fake-omp` shim sets FAKE_AGENT_PERSONA so the fake answers `--version` as OMP.
 */
function shimFiles(fixture, platform, kind) {
  const name = `fake-${kind}`
  const persona = kind === 'omp' ? `process.env.FAKE_AGENT_PERSONA = 'omp'\n` : ''
  if (platform === 'win32') {
    return [
      { name: `${name}.cmd`, text: `@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nnode "%dp0%\\${name}.js" %*\r\n` },
      // A bare `C:\…` specifier makes import() fail with ERR_UNSUPPORTED_ESM_URL_SCHEME, so it goes through a file URL.
      { name: `${name}.js`, text: `${persona}import(require('node:url').pathToFileURL(${JSON.stringify(fixture)}).href)\n` }
    ]
  }
  const exported = kind === 'omp' ? 'export FAKE_AGENT_PERSONA=omp\n' : ''
  return [{ name, text: `#!/bin/sh\n${exported}exec node '${fixture.replaceAll("'", "'\\''")}' "$@"\n`, mode: 0o755 }]
}

/** Writes the fake agent's `kind` shim (`fake-claude` or `fake-omp`) into `directory` and returns the executable to register. */
export function writeShim(directory, fixture, platform = process.platform, kind = 'claude') {
  mkdirSync(directory, { recursive: true })
  const files = shimFiles(fixture, platform, kind)
  for (const file of files) {
    const path = join(directory, file.name)
    writeFileSync(path, file.text)
    if (file.mode !== undefined) chmodSync(path, file.mode)
  }
  return join(directory, files[0].name)
}

/** The connected agents a run seeds: always the claude fake, and the omp fake when the fixture chats use OMP. */
export function seededAgents(shims, agent) {
  const claude = { kind: 'claude', executablePath: shims.claude, version: FAKE_VERSION }
  return agent === 'omp' ? [claude, { kind: 'omp', executablePath: shims.omp, version: FAKE_OMP_VERSION }] : [claude]
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
 * and is older than six hours. A reused pid keeps a root, never removes a live one. A root that disappears during the
 * sweep (its run finished and removed it) is skipped.
 */
export function staleRoots(parent, alive = isAlive, now = Date.now()) {
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(ROOT_PREFIX))
    .map((entry) => join(parent, entry.name))
    .filter((root) => {
      try {
        const owner = rootOwner(root)
        return owner === null ? now - statSync(root).mtimeMs > UNOWNED_GRACE_MS : !alive(owner)
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
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

/**
 * A run's state. With a coord step the fakes deliver their inbox at startup (`FAKE_AGENT_DELIVER_MAIL`), as the
 * Skitarii extension delivers mail; other runs never make that `dm` call.
 */
function createSession(out, exe, agent = 'claude', keys = []) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), ROOT_PREFIX)))
  writeFileSync(join(root, OWNER_FILE), JSON.stringify({ pid: process.pid }))
  const env = withNodeFirst(isolatedEnv(process.env, root))
  if (keys.some((key) => STEPS[key].coord)) env.FAKE_AGENT_DELIVER_MAIL = '1'
  if (keys.some((key) => STEPS[key].model)) {
    Object.assign(env, {
      FAKE_AGENT_OMP_START_MODEL: MODEL_START.model, FAKE_AGENT_OMP_START_THINKING: MODEL_START.thinking,
      FAKE_AGENT_CONTROL_LOG: join(root, 'fake-controls.jsonl'), FAKE_AGENT_SLOW_MS: String(MODEL_SLOW_MS)
    })
  }
  return {
    out, root, exe, agent, env,
    userData: join(root, 'user-data'), folder: join(root, FOLDER_NAME), wrapper: join(root, 'app.cjs'),
    second: keys.includes('polish-untrack') ? join(root, SECOND_FOLDER_NAME) : null,
    shims: null, child: null, exited: null, port: null, inspectorPort: null, page: null, main: null, version: null,
    stdout: '', stderr: '', lastProbe: null, fakePids: [], dialogs: null, epicId: null, folderPath: null, chat: null,
    store: null, restart: null, console: [], coord: null, model: null
  }
}

function git(session, folder, args) {
  const result = spawnSync('git', args, { cwd: folder, env: session.env, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.at(-1)} failed: ${result.stderr || result.error}`)
}

function seedRepository(session, folder) {
  mkdirSync(folder)
  git(session, folder, ['init', '-q'])
  writeFileSync(join(folder, 'README.md'), '# e2e fixture\n')
  git(session, folder, ['add', 'README.md'])
  git(session, folder, ['-c', 'user.name=DM e2e', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Seed'])
}

/** The folders a run seeds as Git repositories: the fixture folder, and the second one when `polish-untrack` runs. */
function fixtureFolders(session) {
  return session.second === null ? [session.folder] : [session.folder, session.second]
}

/**
 * The fakes are built-in agents (`seededAgents`): a custom agent is terminal-only and its sign-in is never checked. The
 * folder is set up in database mode (its records live under the isolated Dark Mechanicus home, so the Git tree stays
 * clean) with one saved epic, whose id the seed prints, and its default agent is the kind `--agent` selects. A second
 * folder (`polish-untrack`) is set up and tracked the same way, without an epic.
 * Notifications are on while the window is focused, as an unattended run's window is.
 */
const SEED_SOURCE = `
import { openWorkspace } from './src/core/workspace'
import { openAppDatabase } from './src/main/desktop/appDatabase'
import { createAgentRegistry } from './src/main/desktop/agentRegistry'
import { createAppSettings } from './src/main/desktop/appSettings'
import { createFolderAgentDefaults } from './src/main/desktop/folderAgentDefaults'
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
  if (seed.second !== null) {
    const second = openWorkspace({ repoRoot: seed.second, homeDir: seed.dmHome, role: 'desktop', transport: 'desktop', label: 'e2e seed' })
    try {
      await second.initializeRepository({ name: 'E2E second fixture', keyPrefix: 'DM', mode: 'db' })
    } finally {
      second.close()
    }
  }
  const folders = createFolderRegistry({ file: seed.folders, homeDir: seed.home, dmHome: seed.dmHome })
  const tracked = [seed.folder, ...(seed.second === null ? [] : [seed.second])].map((path) => folders.track(path).folder)
  const db = openAppDatabase(seed.userData)
  try {
    const registry = createAgentRegistry({ db })
    for (const agent of seed.agents) registry.upsert({ ...agent, connectedVia: 'found' })
    for (const folder of tracked) createFolderAgentDefaults({ db }).set(folder.path, seed.defaultAgent)
    await createAppSettings({ db, confirm: async () => false, logger: console })
      .setNotifications({ ...DEFAULT_NOTIFICATION_SETTINGS, whenFocused: 'notify' })
  } finally {
    db.close()
  }
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
    userData: session.userData, agents: seededAgents(session.shims, session.agent), defaultAgent: session.agent,
    folders: join(session.userData, 'folders.json'), home: session.env.HOME, dmHome: session.env.DARKMECHANICUS_HOME,
    folder: session.folder, second: session.second, epicTitle: EPIC_TITLE
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
  const shimDirectory = join(session.root, 'shim')
  session.shims = Object.fromEntries(AGENT_KINDS.map((kind) => [kind, writeShim(shimDirectory, FAKE_AGENT_CLI, process.platform, kind)]))
  for (const folder of fixtureFolders(session)) seedRepository(session, folder)
  seedStores(session)
  if (session.exe === null) {
    const { version } = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
    session.version = version
    writeFileSync(session.wrapper, wrapperSource({ repo: REPO, main: BUILT_MAIN, home: session.env.HOME, version }))
  }
  if (process.platform === 'win32') startDialogHelper(session)
  return {
    shims: session.shims, agent: session.agent, folder: session.folder, second: session.second, userData: session.userData, epicId: session.epicId, home: session.env.HOME,
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
  session.page = await connect(target.webSocketDebuggerUrl, (message) => {
    const text = consoleText(message)
    if (text !== null) session.console.push(text)
  })
  // The renderer's console and browser log (a Content-Security-Policy refusal is a log entry), from the page's start.
  await cdp(session, 'Log.enable')
  await cdp(session, 'Runtime.enable')
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

/**
 * Ready: the renderer is mounted and lists each seeded agent with its shim and the folder, and each fake signs in
 * through its shim (Claude's `auth status`, OMP's `usage --json`). `agent` is the one the fixture chats use.
 */
function readyProbe(seeded, selected) {
  return `(async () => {
    if (typeof window.dm !== 'object' || !document.getElementById('root')?.firstElementChild) return { ready: false, reason: 'renderer not mounted' }
    try {
      const agents = await window.dm.listAgents()
      const auths = {}
      for (const seeded of ${JSON.stringify(seeded)}) {
        const agent = agents.find((entry) => entry.id === seeded.kind)
        if (agent?.executablePath !== seeded.executablePath) return { ready: false, reason: 'seeded ' + seeded.kind + ' agent not listed', agent: agent ?? null }
        const auth = await window.dm.agentStatus(seeded.kind)
        if (auth.state !== 'signed_in') return { ready: false, reason: 'fake ' + seeded.kind + ' not signed in', auth }
        auths[seeded.kind] = auth.state
      }
      const folder = (await window.dm.listFolders()).find((entry) => entry.name === ${JSON.stringify(FOLDER_NAME)})
      if (!folder?.available || !folder.initialized) return { ready: false, reason: 'seeded folder not tracked and set up' }
      const defaultAgent = await window.dm.folderDefaultAgent(folder.path)
      if (defaultAgent !== ${JSON.stringify(selected)}) return { ready: false, reason: 'folder default agent is ' + defaultAgent }
      const agent = agents.find((entry) => entry.id === ${JSON.stringify(selected)})
      return {
        ready: true, agent: { id: agent.id, kind: agent.kind, version: agent.version, connectedVia: agent.connectedVia },
        agents: agents.map((entry) => ({ id: entry.id, kind: entry.kind, executablePath: entry.executablePath })),
        folder: { name: folder.name, path: folder.path, storageMode: folder.storageMode }, defaultAgent, auth: auths
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
    /** The GUI chat's section, found by its composer; null while it is not shown. */
    chatSection(chatId) {
      return document.getElementById(`agent-message-${chatId}`)?.closest('section.agent-chat') ?? null
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
  const send = input.form?.querySelector('button[aria-label="Send"]') ?? null
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
    session.lastProbe = await evaluate(session, readyProbe(seededAgents(session.shims, session.agent), session.agent))
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

/**
 * The GUI (protocol) launch of the new chat, the run's first chat: the one long-lived fake run whose mode and persona
 * are the selected kind. Throws unless there is exactly one.
 */
export function newChatLaunch(logText, agent) {
  const launches = fakeAgentLog(logText).filter((entry) => entry.mode === agent && entry.persona === agent)
  if (launches.length !== 1) throw new Error(`Expected one ${agent} GUI launch; the log has ${launches.length}.`)
  const [{ mode, persona, pid, cwd, argv }] = launches
  return { mode, persona, pid, cwd, argv }
}

/** Step 1: a folder chat from the New chat popup, with the selected kind's fake, opens in the GUI with its first turn. */
async function newChat(session, signal) {
  await until(session, signal, clickSelector, `button[aria-label="New chat in ${FOLDER_NAME}"]`)
  await until(session, signal, fill, '.dialog[role="dialog"] textarea', 'hello first')
  await until(session, signal, clickButton, '.dialog[role="dialog"] .dialog-actions', 'Start')
  const { chat } = await until(session, signal, chatRecord, session.folderPath, { firstPrompt: 'hello first' })
  if (chat.surface !== 'gui' || chat.agent !== session.agent) {
    throw new Error(`The new chat is ${chat.agent} on ${chat.surface}, not ${session.agent} on gui.`)
  }
  session.chat = { chatId: chat.id, sessionId: chat.sessionId }
  await until(session, signal, turnDone, session.folderPath, chat.id, { text: 'hello first' })
  const shown = await until(session, signal, guiShows, chat.id, 'hello first', 'Hello world')
  const launch = newChatLaunch(readLog(session), session.agent)
  if (!isAlive(launch.pid)) throw new Error(`The ${session.agent} fake (pid ${launch.pid}) is not running.`)
  return { chat, launch, section: shown.section, messages: shown.messages, screenshot: await capture(session, 'e2e-new-chat.png', WINDOW) }
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

/** The tool card's state; an ended turn folds its work behind a `Worked for` row, so a missing card opens the newest folded row. */
function toolCard(_h, name, state) {
  const section = document.querySelector('section.agent-chat')
  if (!section) return { ok: false, section: false }
  const card = section.querySelector(`.chat-transcript li.chat-tool[aria-label="Tool call: ${name}"]`)
  if (!card) {
    const folded = [...section.querySelectorAll('.chat-work-toggle[aria-expanded="false"]')].at(-1)
    if (folded) folded.click()
    return { ok: false, found: false, opened: Boolean(folded) }
  }
  const actual = card.querySelector('[data-state]')?.getAttribute('data-state') ?? null
  return { ok: actual === state, found: true, state: actual }
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

/** Step 4: `[approval]` docks a card above the composer; Allow once finishes the turn, whose folded work holds the Bash card. */
async function approval(session, signal) {
  const { chatId } = session.chat
  await until(session, signal, composeAndSend, chatId, '[approval]')
  const prompt = await until(session, signal, dockedPrompt, chatId)
  if (prompt.arbitrated) throw new Error('The New chat approval went to the Magos; a New chat is never arbitrated.')
  const card = await capture(session, 'e2e-approval-card.png', WINDOW)
  await until(session, signal, clickButton, 'section.agent-chat section.agent-prompt', 'Allow once')
  await until(session, signal, turnDone, session.folderPath, chatId, { text: '[approval]' })
  const bash = await until(session, signal, toolCard, 'Bash', 'accepted')
  // Step 2's own reply is still the bubble right after its `hello`: a turn with nothing but its reply folds nothing.
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

/** Every seeded project's database: the fixture folder's and, for `polish-untrack`, the second folder's. */
function grantDatabases(session) {
  const projects = join(session.env.DARKMECHANICUS_HOME, 'projects')
  const expected = session.second === null ? 1 : 2
  const found = readdirSync(projects)
  if (found.length !== expected) throw new Error(`Expected ${expected} project(s) under ${projects}; found ${found.length}.`)
  return found.map((project) => join(projects, project, 'local', 'state.sqlite'))
}

/** The grant row a launch's `grantHash` names, read-only from the project database that holds it. */
function grantOf(session, grantHash) {
  for (const file of grantDatabases(session)) {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const row = db.prepare('SELECT id, created_at, revoked_at FROM grants WHERE token_hash = ?').get(grantHash)
      if (row !== undefined) return { id: row.id, createdAt: row.created_at, revokedAt: row.revoked_at }
    } finally {
      db.close()
    }
  }
  throw new Error('No grant row matches the launch.')
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
  const relay = section?.querySelector('form.chat-composer textarea') ?? null
  if (!section || !relay) return { ok: false, section: !!section }
  const items = section.querySelectorAll('.chat-transcript li').length
  // The relay note is the text area's screen-reader description, beside the keys.
  const note = document.getElementById(relay.getAttribute('aria-describedby'))?.textContent ?? ''
  const relayLabel = relay.labels[0]?.textContent ?? ''
  const ownComposer = !!section.querySelector('textarea[id^="agent-message-"]')
  const ok = [
    items > 0, note.startsWith('Your message goes through Lexmechanic, which passes it to this worker.'),
    relayLabel === 'Message Acolyte:DM-2', !ownComposer
  ].every(Boolean)
  return { ok, items, note, relayLabel, ownComposer }
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
 * Step 6: the saved epic's Agent stage starts the planner from its Lexmechanic role card and, after `[subagent_tree]`,
 * names its workers in the rail's tree; a finished worker sits in the collapsed Finished group; a row opens its thread
 * read-only.
 */
async function epicAgent(session, signal) {
  await resizeWindow(session, signal, WIDE_WINDOW)
  await until(session, signal, clickEpic, EPIC_TITLE)
  await until(session, signal, agentToggle)
  await until(session, signal, clickSelector, 'section.eap .eap-empty .arc[data-role="planner"]')
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

/** The chat `polish-picker` started, which the later polish steps drive. */
function polishChat(session) {
  if (session.chat === null) throw new Error('The polish steps after polish-picker drive its chat: run polish-picker first.')
  return session.chat
}

/** Checks the New chat dialog's `role` card; ok once it is the checked radio. Clicking a checked card again is harmless. */
function chooseRole(_h, role) {
  const card = document.querySelector(`.dialog[role="dialog"] .first-prompt-roles .arc[data-role="${role}"]`)
  if (!card) return { ok: false, card: false }
  if (card.querySelector('[role="radio"]')?.getAttribute('aria-checked') !== 'true') {
    card.click()
    return { ok: false, checked: false }
  }
  return { ok: true, role, name: card.querySelector('.arc-name')?.textContent ?? null }
}

/** Polish 1: folder New chat with the Lexmechanic card stores a planner GUI chat, which opens with its first turn. */
async function polishPicker(session, signal) {
  await until(session, signal, clickSelector, `button[aria-label="New chat in ${FOLDER_NAME}"]`)
  const picked = await until(session, signal, chooseRole, 'planner')
  await until(session, signal, fill, '.dialog[role="dialog"] textarea', 'hello')
  await until(session, signal, clickButton, '.dialog[role="dialog"] .dialog-actions', 'Start')
  const { chat } = await until(session, signal, chatRecord, session.folderPath, { firstPrompt: 'hello' })
  if (chat.role !== 'planner' || chat.surface !== 'gui') throw new Error(`The new chat is a ${chat.role} on ${chat.surface}, not a planner on gui.`)
  session.chat = { chatId: chat.id, sessionId: chat.sessionId }
  await until(session, signal, turnDone, session.folderPath, chat.id, { text: 'hello' })
  const shown = await until(session, signal, guiShows, chat.id, 'hello', 'Hello world')
  return { picked, chat, section: shown.section, messages: shown.messages, screenshot: await capture(session, 'e2e-polish-picker.png', WINDOW) }
}

function focusComposer(_h, chatId) {
  const input = document.getElementById(`agent-message-${chatId}`)
  if (!input || input.disabled) return { ok: false, found: !!input }
  input.focus()
  return { ok: document.activeElement === input }
}

function composerValue(_h, chatId, text) {
  const input = document.getElementById(`agent-message-${chatId}`)
  return { ok: input?.value === text, value: input?.value ?? null, height: input ? Math.round(input.getBoundingClientRect().height) : null }
}

/** A real Enter key press in the focused element, with Shift held when `shift`. */
async function pressEnter(session, shift = false) {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: shift ? 8 : 0 }
  await cdp(session, 'Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', unmodifiedText: '\r', ...key })
  await cdp(session, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/** The kinds of the items after the last user message `text` in the stored transcript, and the last reply text among them. */
async function turnItems(_h, folder, chatId, text) {
  const result = await window.dm.agentChat.snapshot({ folder, chatId })
  if (!result.ok) return { ok: false, error: result.error.message }
  const { items, status } = result.data
  const sent = items.findLastIndex((item) => item.kind === 'user_message' && item.text === text)
  const after = sent < 0 ? [] : items.slice(sent + 1)
  return { ok: sent >= 0, status, kinds: after.map((item) => item.kind), reply: after.findLast((item) => item.kind === 'assistant_text')?.text ?? null }
}

/** Clicks the composer's Stop, which replaces Send while the agent works. */
function clickStop(_h, chatId) {
  const form = document.getElementById(`agent-message-${chatId}`)?.form
  const stop = form?.querySelector('button[aria-label="Stop"]') ?? null
  if (!stop || stop.disabled) return { ok: false, stop: !!stop }
  const send = !!form.querySelector('button[aria-label="Send"]')
  stop.click()
  return { ok: true, title: stop.title, sendShown: send }
}

const TWO_LINES = '[echo] first line\nsecond line'

/**
 * Polish 2: two lines typed with real keys (Shift+Enter between them) go out on Enter and the fake echoes both; then
 * `[slow]` shows Stop in place of Send, and Stop ends that turn as `turn_stopped`.
 */
async function polishComposer(session, signal) {
  const { chatId } = polishChat(session)
  const folder = session.folderPath
  await until(session, signal, focusComposer, chatId)
  const [first, second] = TWO_LINES.split('\n')
  await cdp(session, 'Input.insertText', { text: first })
  await pressEnter(session, true)
  await cdp(session, 'Input.insertText', { text: second })
  const typed = await until(session, signal, composerValue, chatId, TWO_LINES)
  await pressEnter(session)
  await until(session, signal, turnDone, folder, chatId, { text: TWO_LINES })
  const echoed = await until(session, signal, turnItems, folder, chatId, TWO_LINES)
  if (echoed.reply !== 'first line\nsecond line') throw new Error(`The fake did not echo both lines: ${JSON.stringify(echoed.reply)}`)
  await until(session, signal, composeAndSend, chatId, '[slow]')
  const stop = await until(session, signal, clickStop, chatId)
  if (stop.sendShown) throw new Error('Send was shown beside Stop while the agent worked.')
  await until(session, signal, turnDone, folder, chatId, { text: '[slow]' })
  const stopped = await until(session, signal, turnItems, folder, chatId, '[slow]')
  if (!stopped.kinds.includes('turn_stopped')) throw new Error(`Stop did not end the turn as turn_stopped: ${JSON.stringify(stopped.kinds)}`)
  return {
    typed, echo: echoed.reply, stop, stoppedTurn: stopped.kinds,
    screenshot: await capture(session, 'e2e-polish-composer.png', WINDOW)
  }
}

/** Clicks the newest reply's message Copy or its code block's Copy once; ok once it says Copied or Copy failed. */
function clickCopy(_h, which) {
  const reply = [...document.querySelectorAll('section.agent-chat .chat-transcript li.chat-msg-assistant')].at(-1)
  const button = which === 'code' ? reply?.querySelector('.md-code-block .md-code-copy') : reply?.querySelector(':scope > .chat-msg-actions .copy-button')
  if (!button) return { ok: false, reply: !!reply, button: false }
  if (button.dataset.e2eClicked !== '1') {
    button.dataset.e2eClicked = '1'
    button.click()
  }
  const state = button.getAttribute('data-state')
  return { ok: state !== 'idle', state, title: button.title }
}

/** Copies through `which`'s button and reads the clipboard back in the page. */
async function copyAndRead(session, signal, which) {
  const clicked = await until(session, signal, clickCopy, which)
  if (clicked.state !== 'copied') throw new Error(`${clicked.title} says ${clicked.state}.`)
  return { button: clicked.title, clipboard: await evaluate(session, 'navigator.clipboard.readText()') }
}

/** Polish 3: the reply's Copy puts its raw Markdown on the clipboard; its code block's Copy puts only the code. */
async function polishCopy(session, signal) {
  const { chatId } = polishChat(session)
  // The page reads the clipboard only while it has focus, which an unattended window may not: focus is emulated here.
  await cdp(session, 'Emulation.setFocusEmulationEnabled', { enabled: true })
  await until(session, signal, composeAndSend, chatId, 'Show the fix [markdown]')
  await until(session, signal, turnDone, session.folderPath, chatId, { text: 'Show the fix [markdown]' })
  const stored = await until(session, signal, turnItems, session.folderPath, chatId, 'Show the fix [markdown]')
  if (stored.reply !== MARKDOWN_REPLY) throw new Error(`The stored reply is not the fake's Markdown: ${JSON.stringify(stored.reply)}`)
  const message = await copyAndRead(session, signal, 'message')
  const code = await copyAndRead(session, signal, 'code')
  // The Windows clipboard holds text with CRLF line ends (Chromium converts on write); every other byte is the copy's.
  const clipped = (text) => (process.platform === 'win32' ? text.replaceAll('\n', '\r\n') : text)
  if (message.clipboard !== clipped(MARKDOWN_REPLY)) throw new Error(`Copy message gave ${JSON.stringify(message.clipboard)}, not the raw Markdown.`)
  if (code.clipboard !== clipped(MARKDOWN_CODE)) throw new Error(`Copy code gave ${JSON.stringify(code.clipboard)}, not the code alone.`)
  return { stored: stored.reply, message, code, codeExpected: MARKDOWN_CODE, screenshot: await capture(session, 'e2e-polish-copy.png', WINDOW) }
}

const FORM_CARD = 'section.agent-chat section.agent-prompt.agent-prompt-form-card[role="alertdialog"]'

/**
 * The docked form: per fieldset its legend, checked option labels and free text, the answered count, and how many
 * Submit buttons it has and whether the one is enabled; ok once the card shows.
 */
function formState(_h, selector) {
  const card = document.querySelector(selector)
  if (!card) return { ok: false, card: false }
  const label = (input) => input.closest('label')?.querySelector('.agent-prompt-check-label')?.textContent ?? null
  const fields = [...card.querySelectorAll('fieldset.agent-prompt-field')].map((fieldset) => ({
    legend: fieldset.querySelector('legend')?.textContent ?? null,
    checked: [...fieldset.querySelectorAll('input:checked')].map(label),
    text: fieldset.querySelector(':scope > textarea')?.value ?? null
  }))
  const submits = [...card.querySelectorAll('button')].filter((button) => button.textContent === 'Submit')
  return {
    ok: true, heading: card.querySelector('h3')?.textContent ?? null, fields, count: card.querySelector('.agent-prompt-count')?.textContent ?? null,
    submits: submits.length, submitEnabled: submits.length === 1 && !submits[0].disabled
  }
}

/** Polls the docked form until `test` holds for its state. */
async function formWhere(session, signal, test) {
  return waitFor(async () => {
    assertRunning(session)
    const state = session.lastProbe = await page(session, formState, FORM_CARD)
    return state.ok && test(state) && state
  }, signal)
}

/** Checked option labels per field, in field order, for comparing a form's state. */
const checkedOf = (state) => JSON.stringify(state.fields.map((field) => field.checked))

/**
 * One option row of the form field `legend`: clicks its input (`via: 'input'`), its label text (`'label'`), or only
 * focuses the input (`'focus'`) for a key press. Ok once done.
 */
function formOption(_h, selector, { legend, option, via }) {
  const fieldset = [...(document.querySelector(selector)?.querySelectorAll('fieldset.agent-prompt-field') ?? [])]
    .find((entry) => entry.querySelector('legend')?.textContent === legend)
  const row = [...(fieldset?.querySelectorAll('label.agent-prompt-check') ?? [])]
    .find((entry) => entry.querySelector('.agent-prompt-check-label')?.textContent === option)
  const input = row?.querySelector('input')
  if (!input || input.disabled) return { ok: false, fieldset: !!fieldset, row: !!row }
  if (via === 'focus') {
    input.focus()
    return { ok: document.activeElement === input }
  }
  const target = via === 'label' ? row.querySelector('.agent-prompt-check-label') : input
  target.click()
  return { ok: true }
}

/** Focuses the free-text box of the form field `legend`. */
function focusFormText(_h, selector, legend) {
  const fieldset = [...(document.querySelector(selector)?.querySelectorAll('fieldset.agent-prompt-field') ?? [])]
    .find((entry) => entry.querySelector('legend')?.textContent === legend)
  const box = fieldset?.querySelector(':scope > textarea')
  if (!box || box.disabled) return { ok: false, found: !!box }
  box.focus()
  return { ok: document.activeElement === box }
}

/** A real Space key press in the focused element. */
async function pressSpace(session) {
  const key = { key: ' ', code: 'Space', windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 }
  await cdp(session, 'Input.dispatchKeyEvent', { type: 'keyDown', text: ' ', unmodifiedText: ' ', ...key })
  await cdp(session, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/**
 * The chat once the turn `text` started has ended: idle, nothing pending; the user messages after it (an answered
 * form's summary) and every assistant text after it.
 */
async function answeredTurn(_h, folder, chatId, text) {
  const result = await window.dm.agentChat.snapshot({ folder, chatId })
  if (!result.ok) return { ok: false, error: result.error.message }
  const { items, status, pending } = result.data
  const sent = items.findLastIndex((item) => item.kind === 'user_message' && item.text === text)
  const after = sent < 0 ? [] : items.slice(sent + 1)
  return {
    ok: sent >= 0 && status === 'idle' && pending === null, status,
    summaries: after.filter((item) => item.kind === 'user_message').map((item) => item.text),
    replies: after.filter((item) => item.kind === 'assistant_text').map((item) => item.text)
  }
}

/**
 * Polish 4: `[multiselect]` (Claude Code's two questions) docks one form with both questions; checking A and C and
 * choosing SQLite enables its one Submit, and once it is clicked the fake echoes both answers from one response.
 */
async function polishMultiselect(session, signal) {
  const { chatId } = polishChat(session)
  await until(session, signal, composeAndSend, chatId, '[multiselect]')
  const shown = await formWhere(session, signal, (state) => state.fields.length === 2 && state.submits === 1 && !state.submitEnabled)
  for (const [legend, option] of [['Which letters?', 'A'], ['Which letters?', 'C'], ['Which database?', 'SQLite']]) {
    await until(session, signal, formOption, FORM_CARD, { legend, option, via: 'input' })
  }
  const form = await formWhere(session, signal, (state) => checkedOf(state) === '[["A","C"],["SQLite"]]' && state.submitEnabled)
  const screenshot = await capture(session, 'e2e-polish-multiselect.png', WINDOW)
  await until(session, signal, clickButton, FORM_CARD, 'Submit')
  const turn = await until(session, signal, answeredTurn, session.folderPath, chatId, '[multiselect]')
  const echoes = turn.replies.filter((reply) => reply.startsWith('answers: '))
  if (echoes.length !== 1 || !echoes[0].includes('"Which letters?":"A, C"') || !echoes[0].includes('"Which database?":"SQLite"')) {
    throw new Error(`The fake did not echo both answers from one response: ${JSON.stringify(turn.replies)}`)
  }
  return { shown: shown.fields.map((field) => field.legend), form, summaries: turn.summaries, echo: echoes[0], screenshot }
}

/** The prompt of the multi-question chat: the fake replays the recorded OMP 18.20.2 ask form (`ask_multi_q`). */
const MULTI_QUESTION_PROMPT = '[ask-multi-q]'
/** The recorded form's questions and the defaults OMP marks checked. */
const ASK_DEFAULTS = '[["SQLite","Postgres"],["US"],[]]'

/**
 * Polish 7, on the omp fake: a new folder chat's `[ask-multi-q]` docks one form with all three questions, SQLite and
 * Postgres checked and US chosen, Submit enabled. Space unchecks Postgres and a click on its label checks it again
 * (the fake replays the recorded requests, so the group goes back at its default), EU replaces US and "note" goes in
 * the text field. One Submit answers every question: OMP takes one response per request it asks, and the fake echoes
 * them all in one reply; the transcript's summary carries every answer, the untouched databases default included.
 */
async function polishMultiquestion(session, signal) {
  await until(session, signal, clickSelector, `button[aria-label="New chat in ${FOLDER_NAME}"]`)
  await until(session, signal, fill, '.dialog[role="dialog"] textarea', MULTI_QUESTION_PROMPT)
  await until(session, signal, clickButton, '.dialog[role="dialog"] .dialog-actions', 'Start')
  const { chat } = await until(session, signal, chatRecord, session.folderPath, { firstPrompt: MULTI_QUESTION_PROMPT })
  if (chat.agent !== 'omp' || chat.surface !== 'gui') throw new Error(`The chat is ${chat.agent} on ${chat.surface}, not omp on gui.`)
  const defaults = await formWhere(session, signal, (state) => state.fields.length === 3 && checkedOf(state) === ASK_DEFAULTS
    && state.submits === 1 && state.submitEnabled && state.count === '3 of 3 answered')
  const defaultsShot = await capture(session, 'e2e-polish-multiquestion-defaults.png', WINDOW)
  await until(session, signal, formOption, FORM_CARD, { legend: 'Which databases?', option: 'Postgres', via: 'focus' })
  await pressSpace(session)
  const unchecked = await formWhere(session, signal, (state) => checkedOf(state) === '[["SQLite"],["US"],[]]')
  await until(session, signal, formOption, FORM_CARD, { legend: 'Which databases?', option: 'Postgres', via: 'label' })
  await formWhere(session, signal, (state) => checkedOf(state) === ASK_DEFAULTS)
  await until(session, signal, formOption, FORM_CARD, { legend: 'Which region?', option: 'EU', via: 'input' })
  await until(session, signal, focusFormText, FORM_CARD, 'Anything else?')
  await cdp(session, 'Input.insertText', { text: 'note' })
  const form = await formWhere(session, signal, (state) => checkedOf(state) === '[["SQLite","Postgres"],["EU"],[]]'
    && state.fields[2].text === 'note' && state.submitEnabled)
  const screenshot = await capture(session, 'e2e-polish-multiquestion.png', WINDOW)
  await until(session, signal, clickButton, FORM_CARD, 'Submit')
  const turn = await until(session, signal, answeredTurn, session.folderPath, chat.id, MULTI_QUESTION_PROMPT)
  const echoes = turn.replies.filter((reply) => reply.startsWith('answers: '))
  const responses = echoes.length === 1 ? JSON.parse(echoes[0].slice('answers: '.length)) : null
  const values = Array.isArray(responses) ? responses.map((response) => response.value) : null
  if (JSON.stringify(values) !== JSON.stringify(['✔ Done selecting', 'EU', 'note'])) {
    throw new Error(`The fake did not echo one reply with every response: ${JSON.stringify(turn.replies)}`)
  }
  const summary = 'Which databases?: SQLite, Postgres\nWhich region?: EU\nAnything else?: note'
  if (JSON.stringify(turn.summaries) !== JSON.stringify([summary])) throw new Error(`The answered form reads ${JSON.stringify(turn.summaries)}, not ${JSON.stringify(summary)}.`)
  return {
    chat, defaults, spaceUnchecked: unchecked.fields[0].checked, form, echo: echoes[0], responses: values, summary: turn.summaries[0],
    defaultsScreenshot: defaultsShot, screenshot
  }
}

/** The newest `Worked for` row: its label, whether it is open, and the state of its `name` tool card (null when hidden). */
function workRow(_h, name) {
  const row = [...document.querySelectorAll('section.agent-chat .chat-transcript li.chat-work')].at(-1)
  const toggle = row?.querySelector(':scope > .chat-work-toggle')
  if (!toggle) return { ok: false, row: !!row }
  const card = row.querySelector(`.chat-work-rows li.chat-tool[aria-label="Tool call: ${name}"]`)
  return {
    ok: true, label: toggle.textContent.replace('›', '').trim(), expanded: toggle.getAttribute('aria-expanded'),
    card: card === null ? null : card.querySelector('[data-state]')?.getAttribute('data-state') ?? 'unknown'
  }
}

/** The newest row is folded: `Worked for <time>`, collapsed, its `name` card hidden. */
async function workFolded(session, signal, name) {
  return waitFor(async () => {
    assertRunning(session)
    const row = session.lastProbe = await page(session, workRow, name)
    return row.ok && /^Worked for \d/.test(row.label) && row.expanded === 'false' && row.card === null && row
  }, signal)
}

function openNewestWork(_h) {
  const toggle = [...document.querySelectorAll('section.agent-chat .chat-transcript li.chat-work > .chat-work-toggle')].at(-1)
  if (toggle?.getAttribute('aria-expanded') !== 'false') return { ok: false, found: !!toggle }
  toggle.click()
  return { ok: true }
}

/** Opens the newest row (one click) until it shows its `name` card, finished. */
async function workOpened(session, signal, name) {
  await until(session, signal, openNewestWork)
  return waitFor(async () => {
    const row = session.lastProbe = await page(session, workRow, name)
    return row.ok && row.expanded === 'true' && row.card === 'accepted' && row
  }, signal)
}

/** Polish 5: a finished `[tool]` turn folds its work behind a collapsed `Worked for` row; opening it shows the Read card. */
async function polishWorkedFor(session, signal) {
  const { chatId } = polishChat(session)
  const shown = await sendInChat(session, signal, { chatId, text: '[tool]', reply: 'alpha' })
  const folded = await workFolded(session, signal, 'Read')
  const opened = await workOpened(session, signal, 'Read')
  return { folded, opened, messages: shown.messages, screenshot: await capture(session, 'e2e-polish-worked-for.png', WINDOW) }
}

/** Clicks the folder's New chat, expanding the folder first when its body is collapsed. */
function newChatIn(_h, name) {
  const button = document.querySelector(`button[aria-label="New chat in ${name}"]`)
  if (button && !button.disabled) {
    button.click()
    return { ok: true }
  }
  document.querySelector(`button[aria-label="Expand ${name}"]`)?.click()
  return { ok: false, button: !!button }
}

async function trackedFolder(_h, name) {
  const folders = await window.dm.listFolders()
  const folder = folders.find((entry) => entry.name === name)
  return { ok: folder?.available === true && folder.initialized === true, path: folder?.path ?? null, names: folders.map((entry) => entry.name) }
}

async function folderGone(_h, name) {
  const names = (await window.dm.listFolders()).map((entry) => entry.name)
  return { ok: !names.includes(name), names }
}

function clickMenuItem(_h, menu, label) {
  const item = [...document.querySelectorAll(`.menu[role="menu"][aria-label="${menu}"] [role="menuitem"]`)].find((entry) => entry.textContent.trim() === label)
  if (!item) return { ok: false, menu }
  item.click()
  return { ok: true }
}

/** Runs `dm --repo <repo> call <command>` as the app's chats run it: this build's runtime as Node, on the isolated home. */
function dmCall(session, { repo, command, args }, signal) {
  const runtime = session.exe ?? require('electron')
  const script = session.exe === null ? join(REPO, 'out', 'main', 'cli.js') : join(dirname(session.exe), 'resources', 'app.asar', 'out', 'main', 'cli.js')
  const options = { env: { ...session.env, ELECTRON_RUN_AS_NODE: '1' }, signal, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  return new Promise((resolveCall, reject) => {
    execFile(runtime, [script, '--repo', repo, 'call', command, JSON.stringify(args)], options, (error, stdout, stderr) => {
      if (error) reject(new Error(`dm call ${command} failed: ${stderr.trim() || error.message}`))
      else resolveCall(JSON.parse(stdout))
    })
  })
}

/** A GUI chat of the second folder, started from its New chat and live: its record, its one fake process and its grant. */
async function startSecondChat(session, signal) {
  if (session.second === null) throw new Error('polish-untrack needs the second fixture folder, seeded only when it is requested.')
  const { path: folder } = await until(session, signal, trackedFolder, SECOND_FOLDER_NAME)
  await until(session, signal, newChatIn, SECOND_FOLDER_NAME)
  await until(session, signal, fill, '.dialog[role="dialog"] textarea', 'hello second')
  await until(session, signal, clickButton, '.dialog[role="dialog"] .dialog-actions', 'Start')
  const { chat } = await until(session, signal, chatRecord, folder, { firstPrompt: 'hello second' })
  await until(session, signal, turnDone, folder, chat.id, { text: 'hello second' })
  const launches = chatLaunches(readLog(session), chat.sessionId)
  const [gui] = launches
  if (launches.length !== 1 || gui.surface !== 'gui') throw new Error(`Expected one GUI launch of the second folder's chat: ${JSON.stringify(launches)}`)
  if (!isAlive(gui.pid)) throw new Error(`The second folder's fake (pid ${gui.pid}) is not running.`)
  const grant = grantOf(session, gui.grantHash)
  if (grant.revokedAt !== null) throw new Error(`The live chat's grant is already revoked: ${JSON.stringify(grant)}`)
  return { folder, chat, gui, grant }
}

/**
 * Polish 6: a live GUI chat in the second fixture folder, then Stop tracking that folder from its sidebar menu: within
 * the deadline the chat's fake process has exited and its grant is revoked, as `dm call list_grants` shows.
 */
async function polishUntrack(session, signal) {
  const { folder, chat, gui, grant: before } = await startSecondChat(session, signal)
  const menu = `Actions for ${SECOND_FOLDER_NAME}`
  await until(session, signal, clickSelector, `button[aria-label="${menu}"]`)
  await until(session, signal, clickMenuItem, menu, 'Stop tracking folder')
  await until(session, signal, clickButton, '.dialog[role="dialog"] .dialog-actions', 'Stop tracking')
  const untrackedAt = Date.now()
  await waitFor(() => !isAlive(gui.pid), signal)
  const exitedWithinMs = Date.now() - untrackedAt
  const revoked = await waitFor(() => {
    const grant = grantOf(session, gui.grantHash)
    return grant.revokedAt !== null && grant
  }, signal)
  const gone = await until(session, signal, folderGone, SECOND_FOLDER_NAME)
  const listed = await dmCall(session, { repo: folder, command: 'list_grants', args: {} }, signal)
  const grant = listed.ok ? listed.data.find((entry) => entry.id === before.id) : undefined
  if (grant === undefined || grant.revokedAt === null || grant.active) throw new Error(`list_grants does not show the chat's grant revoked: ${JSON.stringify(listed)}`)
  return {
    chat: { id: chat.id, role: chat.role, surface: chat.surface }, folder, fakePid: gui.pid, fakeExited: true, exitedWithinMs,
    grant: { id: before.id, revokedAt: revoked.revokedAt }, listGrants: grant, folders: gone.names,
    screenshot: await capture(session, 'e2e-polish-untrack.png', WINDOW)
  }
}

/** The text of a renderer console call or browser log entry a DevTools event carries; null for any other event. */
export function consoleText({ method, params }) {
  if (method === 'Log.entryAdded') return params.entry.text
  if (method === 'Runtime.consoleAPICalled') return params.args.map((arg) => String(arg.value ?? arg.description ?? '')).join(' ')
  return null
}

/**
 * The console lines saying the page refused an image: a Content-Security-Policy img-src block. Older Chromium writes
 * "Refused to load the image …"; the Chromium in this Electron writes "Loading the image … violates the following
 * Content Security Policy directive … The action has been blocked."
 */
export function refusedImages(lines) {
  return lines.filter((line) => line.includes('Refused to load the image') || (line.includes('Loading the image') && line.includes('Content Security Policy')))
}

/** The first 12 hex digits of the SHA-256 of `bytes`, as the fake agent names an image it received. */
export function sha12(bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 12)
}

/** The line the fake agent replies with for an image a turn carries (`fakeAgentCli.mjs`, receivedImages). */
export function imageEchoLine(mime, bytes) {
  return `received image ${mime} ${bytes.length} ${sha12(bytes)}`
}

/**
 * A chat's transcript file (`<chat id>.jsonl`: one ChatItem per line, the last line per id winning): the image refs on
 * the last user message `text`, and whether `needle` occurs anywhere in the file's text.
 */
export function transcriptImageRefs(fileText, text, needle) {
  const items = new Map()
  for (const line of fileText.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const item = JSON.parse(line)
    items.set(item.id, item)
  }
  const sent = [...items.values()].findLast((item) => item.kind === 'user_message' && item.text === text)
  return { found: sent !== undefined, images: sent?.images ?? [], needleFound: fileText.includes(needle) }
}

/** `ok` when the epic's comments (`list_comments` data) are exactly one, with exactly one attachment of `sha256`. */
export function evidenceComment(comments, sha256) {
  const shown = comments.map(({ id, ticketId, body, attachments = [] }) => ({
    id, ticketId, body, attachments: attachments.map(({ id: attachmentId, sha256: hash, mime, bytes, purpose }) => ({ id: attachmentId, sha256: hash, mime, bytes, purpose }))
  }))
  const ok = shown.length === 1 && shown[0].attachments.length === 1 && shown[0].attachments[0].sha256 === sha256
  return { ok, comments: shown }
}

/** Throws when the page logged an image refusal; the check every image step ends with. */
function assertNoRefusedImages(session) {
  const refused = refusedImages(session.console)
  if (refused.length > 0) throw new Error(`The page refused images: ${JSON.stringify(refused)}`)
}

/** The chat's transcript file in the isolated profile's chat store (`<chats>/<folder key>/<chat id>.jsonl`). */
function transcriptFile(session, chatId) {
  const root = chatsRoot(session)
  const found = readdirSync(root).map((key) => join(root, key, `${chatId}.jsonl`)).filter((path) => existsSync(path))
  if (found.length !== 1) throw new Error(`Expected one transcript file of chat ${chatId}; found ${found.length}.`)
  return found[0]
}

const IMAGE_CHAT_PROMPT = 'hello image'
const IMAGE_TEXT = 'look'

/** The chat's composer has its hidden file input (the "+" button's picker). */
function fileInput(_h, chatId) {
  const section = document.getElementById(`agent-message-${chatId}`)?.closest('section.agent-chat')
  const input = section?.querySelector('input[type="file"]') ?? null
  return { ok: !!input && !input.disabled, section: !!section, accept: input?.getAttribute('accept') ?? null }
}

/** Sets the chat composer's hidden file input to `file`, as a pick in the native file dialog would. */
async function setComposerFile(session, chatId, file) {
  const expression = `document.getElementById(${JSON.stringify(`agent-message-${chatId}`)}).closest('section.agent-chat').querySelector('input[type="file"]')`
  const { result } = await cdp(session, 'Runtime.evaluate', { expression })
  if (result.objectId === undefined) throw new Error('The composer has no file input.')
  await cdp(session, 'DOM.setFileInputFiles', { files: [file], objectId: result.objectId })
}

/** The composer's staged image chips: ok once exactly `count` are staged, each one's image loaded. */
function composerChips(_h, chatId, count) {
  const section = document.getElementById(`agent-message-${chatId}`)?.closest('section.agent-chat')
  const chips = section ? [...section.querySelectorAll('ul.chat-image-chips > li.chat-image-chip')] : []
  const staging = chips.some((chip) => chip.classList.contains('is-staging'))
  const loaded = chips.map((chip) => chip.querySelector('img')).map((img) => img?.complete === true && img.naturalWidth > 0)
  const error = section?.querySelector('.chat-composer-error')?.textContent ?? null
  return { ok: !staging && chips.length === count && loaded.every(Boolean), chips: chips.length, staging, loaded, error }
}

/** The newest bubble of the person's images shows its thumbnail, loaded, and the composer holds no chip any more. */
function sentImage(_h, chatId) {
  const section = document.getElementById(`agent-message-${chatId}`)?.closest('section.agent-chat')
  if (!section) return { ok: false, section: false }
  const img = [...section.querySelectorAll('ul.chat-images[aria-label="Your images"] img')].at(-1)
  if (!img) return { ok: false, img: false }
  const chips = section.querySelectorAll('li.chat-image-chip').length
  return { ok: img.complete && img.naturalWidth > 0 && chips === 0, naturalWidth: img.naturalWidth, scheme: img.src.split(':')[0], chips }
}

/** A new folder GUI chat from the New chat popup, its first turn done. */
async function openImageChat(session, signal) {
  await until(session, signal, clickSelector, `button[aria-label="New chat in ${FOLDER_NAME}"]`)
  await until(session, signal, fill, '.dialog[role="dialog"] textarea', IMAGE_CHAT_PROMPT)
  await until(session, signal, clickButton, '.dialog[role="dialog"] .dialog-actions', 'Start')
  const { chat } = await until(session, signal, chatRecord, session.folderPath, { firstPrompt: IMAGE_CHAT_PROMPT })
  if (chat.surface !== 'gui') throw new Error(`The image chat runs on ${chat.surface}, not gui.`)
  await until(session, signal, turnDone, session.folderPath, chat.id, { text: IMAGE_CHAT_PROMPT })
  return chat
}

/**
 * Image 1: `swatch.png` set on a new GUI chat's composer file input stages one chip; `look` sends it, and the fake's
 * reply starts with the image's mime, size and hash. The stored user message names the image by ref, and the
 * transcript file holds none of its base64.
 */
async function imageSend(session, signal) {
  const bytes = readFileSync(SWATCH)
  const chat = await openImageChat(session, signal)
  const input = await until(session, signal, fileInput, chat.id)
  await setComposerFile(session, chat.id, SWATCH)
  const chips = await until(session, signal, composerChips, chat.id, 1)
  await until(session, signal, composeAndSend, chat.id, IMAGE_TEXT)
  await until(session, signal, turnDone, session.folderPath, chat.id, { text: IMAGE_TEXT })
  const turn = await until(session, signal, turnItems, session.folderPath, chat.id, IMAGE_TEXT)
  const expected = imageEchoLine('image/png', bytes)
  const firstLine = turn.reply?.split(/\r?\n/)[0] ?? null
  if (firstLine !== expected) throw new Error(`The reply starts ${JSON.stringify(firstLine)}, not ${JSON.stringify(expected)}.`)
  const shown = await until(session, signal, sentImage, chat.id)
  const file = transcriptFile(session, chat.id)
  const needle = bytes.toString('base64').slice(0, 32)
  const stored = transcriptImageRefs(readFileSync(file, 'utf8'), IMAGE_TEXT, needle)
  if (!stored.found || stored.images.length !== 1) throw new Error(`The stored user message does not carry one image ref: ${JSON.stringify(stored)}`)
  if (stored.needleFound) throw new Error(`The transcript ${file} holds the image's base64.`)
  assertNoRefusedImages(session)
  return {
    chat: { id: chat.id, surface: chat.surface }, input, chips, reply: turn.reply, expected, firstLineMatches: true, thumbnail: shown,
    transcript: { file, userImages: stored.images, base64Prefix: needle, base64Found: false }, refusedImages: [],
    screenshot: await capture(session, 'e2e-image-send.png', WINDOW)
  }
}

/** Opens Start run from the epic Agent stage's Magos card, or from the header once the stage holds a chat. */
function startRunDialog(h) {
  const dialog = document.querySelector('.dialog[role="dialog"]')
  if (dialog) return { ok: !!h.button(dialog.querySelector('.dialog-actions'), 'Run with agent'), dialog: true }
  const card = document.querySelector('section.eap .eap-empty .arc[data-role="orchestrator"]')
  const header = h.button(document.querySelector('section.ew[aria-label="Epic workspace"] header.ew-header'), 'Start run')
  const from = card ?? header
  from?.click()
  return { ok: false, card: !!card, header: !!header }
}

/** The image on the Read tool card of the epic's open chat; its thumbnail and its Attach as evidence lie inside it. */
const TOOL_IMAGE = 'section.eap section.agent-chat .chat-transcript li.chat-tool[aria-label="Tool call: Read"] ul.chat-images[aria-label="Images from the agent"] > li.chat-image'

/**
 * The tool card's image (`selector`) shows its thumbnail, loaded, and offers Attach as evidence. A finished turn folds
 * its work, so a missing image opens the newest folded row.
 */
function toolImage(_h, selector) {
  const item = document.querySelector(selector)
  if (!item) {
    const folded = [...document.querySelectorAll('section.eap section.agent-chat .chat-work-toggle[aria-expanded="false"]')].at(-1)
    folded?.click()
    return { ok: false, opened: Boolean(folded) }
  }
  const img = item.querySelector('img')
  if (!img) return { ok: false, img: false }
  const evidence = item.querySelector('button.chat-image-evidence')
  return {
    ok: img.complete && img.naturalWidth > 0 && evidence !== null, naturalWidth: img.naturalWidth, scheme: img.src.split(':')[0],
    thumb: item.querySelector('button.chat-image-thumb')?.getAttribute('aria-label'), evidence: evidence?.getAttribute('aria-label')
  }
}

function lightboxShown(_h) {
  const box = document.querySelector('.attachment-lightbox[role="dialog"]')
  const img = box?.querySelector('img.attachment-lightbox-image') ?? null
  return { ok: !!img && img.complete && img.naturalWidth > 0, label: box?.getAttribute('aria-label') ?? null, naturalWidth: img?.naturalWidth ?? null }
}

function lightboxClosed(_h) {
  const box = document.querySelector('.attachment-lightbox[role="dialog"]')
  box?.querySelector('button[aria-label="Close"]')?.click()
  return { ok: !document.querySelector('.attachment-lightbox[role="dialog"]') }
}

function toastShown(_h, text) {
  const toasts = [...document.querySelectorAll('.ew-toast[role="status"] > span')].map((toast) => toast.textContent.trim())
  return { ok: toasts.includes(text), toasts }
}

/**
 * Image 2: the seeded epic's Magos, started through Start run, answers `[image]` with a Read tool result image. In the
 * epic's Agent tab its thumbnail loads under the tool card with no image refused, the lightbox shows it, and Attach as evidence leaves one
 * epic comment whose attachment's sha256 is swatch.png's, as `dm call list_comments` (reader role, no token) reads it.
 */
async function imageResult(session, signal) {
  const sha256 = createHash('sha256').update(readFileSync(SWATCH)).digest('hex')
  await until(session, signal, openEpic, EPIC_TITLE)
  await until(session, signal, agentToggle)
  await until(session, signal, startRunDialog)
  await until(session, signal, clickButton, '.dialog[role="dialog"] .dialog-actions', 'Run with agent')
  const { chat } = await until(session, signal, chatRecord, session.folderPath, { role: 'orchestrator', epicId: session.epicId })
  if (chat.surface !== 'gui') throw new Error(`The Magos runs on ${chat.surface}, not gui.`)
  await until(session, signal, turnDone, session.folderPath, chat.id, { text: '', prefix: true })
  await until(session, signal, composeAndSend, chat.id, '[image]')
  await until(session, signal, turnDone, session.folderPath, chat.id, { text: '[image]' })
  // Run with agent opens the Magos as a folder chat; Attach as evidence lives in the epic's Agent tab.
  await until(session, signal, openEpic, EPIC_TITLE)
  await until(session, signal, agentToggle)
  const thumbnail = await until(session, signal, toolImage, TOOL_IMAGE)
  await until(session, signal, clickSelector, `${TOOL_IMAGE} button.chat-image-thumb`)
  const lightbox = await until(session, signal, lightboxShown)
  const lightboxShot = await capture(session, 'e2e-image-result-lightbox.png', WINDOW)
  await until(session, signal, lightboxClosed)
  await until(session, signal, clickSelector, `${TOOL_IMAGE} button.chat-image-evidence`)
  const toast = await until(session, signal, toastShown, EVIDENCE_TOAST)
  const screenshot = await capture(session, 'e2e-image-result.png', WINDOW)
  const listed = await dmCall(session, { repo: session.folderPath, command: 'list_comments', args: { epicId: session.epicId } }, signal)
  if (!listed.ok) throw new Error(`list_comments failed: ${JSON.stringify(listed)}`)
  const comment = evidenceComment(listed.data, sha256)
  if (!comment.ok) throw new Error(`list_comments does not show one comment with swatch.png attached: ${JSON.stringify(comment.comments)}`)
  assertNoRefusedImages(session)
  return {
    magos: { id: chat.id, role: chat.role, surface: chat.surface, epicId: chat.epicId }, thumbnail, lightbox, toast: toast.toasts,
    swatchSha256: sha256, listComments: comment.comments, refusedImages: [], screenshots: [lightboxShot, screenshot]
  }
}

/** The body the fake's `[mail] <role> <epicId>` sends (`fakeAgentCli.mjs`, mailPeer), shown on both mail cards. */
export function coordMailBody(role) {
  return `Fake coordination mail for the ${role}.`
}

/** The tab strip over the epic's Agent stage: each tab's chat, name, selection, unread dot and stopped look, and the chat shown. */
function tabStrip(_h) {
  const tabs = [...document.querySelectorAll('section.eap .ats [role="tab"]')].map((tab) => ({
    chatId: tab.dataset.chatId, name: tab.querySelector('.ats-name')?.textContent ?? null, label: tab.getAttribute('aria-label'),
    selected: tab.getAttribute('aria-selected') === 'true', unread: tab.querySelector('.ats-unread') !== null,
    stopped: tab.closest('.ats-tab')?.classList.contains('is-stopped') ?? false
  }))
  const shown = document.querySelector('section.eap .eap-centre section.agent-chat, section.eap .eap-centre section.eap-terminal')
  const dialog = document.querySelector('.dialog[role="dialog"] .dialog-title')?.textContent ?? null
  return { ok: true, tabs, shown: shown?.getAttribute('aria-label') ?? null, dialog }
}

/** Polls the tab strip until `test` accepts it, which it returns. */
function tabsWhere(session, signal, test) {
  return waitFor(async () => {
    assertRunning(session)
    const strip = await page(session, tabStrip)
    session.lastProbe = strip
    return test(strip) && strip
  }, signal)
}

const tabOf = (strip, chatId) => strip.tabs.find((tab) => tab.chatId === chatId)

/** Clicks the chat's tab until it is the selected one and its chat (`name chat`) fills the stage. */
async function selectTab(session, signal, chatId, name) {
  await until(session, signal, clickSelector, `section.eap .ats [role="tab"][data-chat-id="${chatId}"]`)
  return tabsWhere(session, signal, (strip) => tabOf(strip, chatId)?.selected && strip.shown === `${name} chat`)
}

/** A real Ctrl+Tab in the page, as the person cycles the tabs. */
async function pressCtrlTab(session) {
  const key = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9, modifiers: 2 }
  await cdp(session, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', ...key })
  await cdp(session, 'Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}

/** Clicks the Start an agent dialog's Lexmechanic card once; ok once it is clicked. */
function pickLexmechanic(_h) {
  const card = document.querySelector('.dialog[role="dialog"] .arc[data-role="planner"]')
  if (!card || card.getAttribute('aria-disabled') === 'true') return { ok: false, card: !!card }
  card.click()
  return { ok: true }
}

/** The long-lived fake launches of the chat: an OMP session folder names its chat id, a PTY would run the fake TUI. */
export function coordLaunches(logText, chatId) {
  return fakeAgentLog(logText)
    .filter((entry) => LONG_LIVED_MODES.has(entry.mode) && entry.argv.some((arg) => arg.includes(chatId)))
    .map((entry) => ({ mode: entry.mode, surface: entry.mode === 'tui' ? 'terminal' : 'gui', pid: entry.pid, at: entry.at }))
}

/** The chat's one live GUI fake process, its launches and that no terminal (PTY) launch ran for it. */
function liveGuiLaunch(session, chatId) {
  const launches = coordLaunches(readLog(session), chatId)
  const live = launches.filter((launch) => isAlive(launch.pid))
  const terminal = launches.filter((launch) => launch.surface === 'terminal')
  return live.length === 1 && live[0].mode === 'omp' && terminal.length === 0 ? { launch: live[0], launches, terminalLaunches: terminal } : null
}

/** The mail card the chat's transcript shows `body` on, the newest of `direction`: its header, text normalized. */
function mailCard(_h, name, direction, body) {
  const section = document.querySelector(`section.eap .eap-centre section.agent-chat[aria-label="${name} chat"]`)
  if (!section) return { ok: false, section: false }
  const cards = [...section.querySelectorAll(`.chat-transcript li.chat-mail-${direction} article.chat-mail-card`)]
    .filter((card) => card.querySelector('.chat-mail-body')?.textContent === body)
  const card = cards.at(-1)
  const head = card?.querySelector('.chat-mail-head')?.textContent.replace(/\s+/g, ' ').trim() ?? null
  return { ok: card !== undefined, head, label: card?.getAttribute('aria-label') ?? null, cards: cards.length }
}

/** Sends `[mail] <role> <epic>` from the chat and waits for its turn: the fake's reply names the endpoint it mailed. */
async function sendMail(session, signal, chatId, role) {
  const text = `[mail] ${role} ${session.epicId}`
  await until(session, signal, composeAndSend, chatId, text)
  await until(session, signal, turnDone, session.folderPath, chatId, { text })
  const turn = await until(session, signal, turnItems, session.folderPath, chatId, text)
  if (!turn.reply?.startsWith(`mailed the ${role} at `)) throw new Error(`The fake did not mail the ${role}: ${turn.reply}`)
  return { text, reply: turn.reply }
}

/** Clicks the tab's ✕ and answers the Stop confirmation with `button` (Cancel or Stop). */
async function answerTabStop(session, signal, name, button) {
  await until(session, signal, clickSelector, `section.eap .ats button.ats-close[aria-label="Stop ${name}"]`)
  await tabsWhere(session, signal, (strip) => strip.dialog === `Stop the ${name}?`)
  await until(session, signal, clickButton, '.dialog[role="dialog"] .dialog-actions', button)
  return tabsWhere(session, signal, (strip) => strip.dialog === null)
}

function coordChats(session) {
  if (session.coord === null) throw new Error('The coord steps after coord-tabs drive its two chats: run coord-tabs first.')
  return session.coord
}

/** The OMP session file the fake keeps for the chat holds an inbox delivery: the app counts its mail delivered. */
function inboxDelivered(session, chatId) {
  const sessions = join(session.userData, 'agents', 'omp', chatId, 'sessions')
  return existsSync(sessions) && readdirSync(sessions).some((name) => readFileSync(join(sessions, name), 'utf8').includes('"customType":"dm-inbox-delivery"'))
}

/**
 * Coord 1: the seeded epic's Magos through Start run, then a Lexmechanic from the tab strip's "+", both Skitarii
 * (omp-kind) GUI chats. Two tabs show; a click on each shows its chat, and Ctrl+Tab cycles between them.
 */
async function coordTabs(session, signal) {
  await until(session, signal, openEpic, EPIC_TITLE)
  await until(session, signal, agentToggle)
  await until(session, signal, startRunDialog)
  await until(session, signal, clickButton, '.dialog[role="dialog"] .dialog-actions', 'Run with agent')
  const { chat: magos } = await until(session, signal, chatRecord, session.folderPath, { role: 'orchestrator', epicId: session.epicId })
  // Run with agent opens the Magos as a folder chat; the tabs live in the epic's Agent tab.
  await until(session, signal, openEpic, EPIC_TITLE)
  await until(session, signal, agentToggle)
  await tabsWhere(session, signal, (strip) => tabOf(strip, magos.id)?.selected)
  await until(session, signal, clickSelector, 'section.eap .ats button.ats-new')
  await until(session, signal, pickLexmechanic)
  const { chat: lex } = await until(session, signal, chatRecord, session.folderPath, { role: 'planner', epicId: session.epicId })
  for (const chat of [magos, lex]) {
    if (chat.agent !== 'omp' || chat.surface !== 'gui') throw new Error(`The ${chat.role} is ${chat.agent} on ${chat.surface}, not omp on gui.`)
  }
  session.coord = { magos, lex }
  const both = await tabsWhere(session, signal, (strip) => strip.tabs.length === 2 && strip.tabs[0].chatId === magos.id && tabOf(strip, lex.id)?.selected && strip.shown === 'Lexmechanic chat')
  const clicked = [await selectTab(session, signal, magos.id, 'Magos'), await selectTab(session, signal, lex.id, 'Lexmechanic')]
  const cycled = []
  for (const [chat, name] of [[magos, 'Magos'], [lex, 'Lexmechanic']]) {
    await pressCtrlTab(session)
    cycled.push(await tabsWhere(session, signal, (strip) => tabOf(strip, chat.id)?.selected && strip.shown === `${name} chat`))
  }
  const launches = [magos, lex].map((chat) => liveGuiLaunch(session, chat.id))
  if (launches.includes(null)) throw new Error(`Expected one live GUI fake per chat: ${JSON.stringify([magos, lex].map((chat) => coordLaunches(readLog(session), chat.id)))}`)
  return {
    magos, lexmechanic: lex, tabs: both.tabs, clicked: clicked.map((strip) => strip.shown), ctrlTab: cycled.map((strip) => strip.shown),
    pids: { magos: launches[0].launch.pid, lexmechanic: launches[1].launch.pid }, screenshot: await capture(session, 'e2e-coord-tabs.png', WINDOW)
  }
}

/**
 * Coord 2: the Lexmechanic's fake finds the Magos by epic and role with its own grant and mails it (`[mail]`). The
 * Lexmechanic's transcript shows the sent card, the unselected Magos tab its unread dot, and once selected the Magos's
 * transcript the received card.
 */
async function coordMail(session, signal) {
  const { magos, lex } = coordChats(session)
  await selectTab(session, signal, lex.id, 'Lexmechanic')
  const body = coordMailBody('orchestrator')
  const mailed = await sendMail(session, signal, lex.id, 'orchestrator')
  const sent = await until(session, signal, mailCard, 'Lexmechanic', 'sent', body)
  const dot = await tabsWhere(session, signal, (strip) => tabOf(strip, magos.id)?.unread && !tabOf(strip, magos.id).selected)
  const sentShot = await capture(session, 'e2e-coord-mail-sent.png', WINDOW)
  await selectTab(session, signal, magos.id, 'Magos')
  const received = await until(session, signal, mailCard, 'Magos', 'received', body)
  const expected = { sent: '✉ Lexmechanic → Magos Sent', received: '✉ Lexmechanic → Magos Received' }
  if (sent.head !== expected.sent || received.head !== expected.received) throw new Error(`Unexpected mail card headers: ${JSON.stringify({ sent, received })}`)
  return {
    mailed, body, sentCard: sent, receivedCard: received, magosTabBeforeSelect: tabOf(dot, magos.id),
    screenshots: [sentShot, await capture(session, 'e2e-coord-mail.png', WINDOW)]
  }
}

/**
 * Coord 3: the Lexmechanic stopped from its tab (✕ → Stop) is gone with its process; the Magos's fake mails it. The
 * Lexmechanic restarts in the GUI (a new fake process, no terminal launch), its tab comes back with the unread dot,
 * and its fake delivers the mail into its session as the Skitarii extension does.
 */
async function coordWake(session, signal) {
  const { magos, lex } = coordChats(session)
  const before = liveGuiLaunch(session, lex.id)
  if (before === null) throw new Error(`The Lexmechanic has no one live GUI fake: ${JSON.stringify(coordLaunches(readLog(session), lex.id))}`)
  await answerTabStop(session, signal, 'Lexmechanic', 'Stop')
  await waitFor(() => !isAlive(before.launch.pid), signal)
  const stopped = await tabsWhere(session, signal, (strip) => strip.tabs.length === 1 && strip.tabs[0].chatId === magos.id)
  const mailed = await sendMail(session, signal, magos.id, 'planner')
  const woken = await waitFor(() => {
    const live = liveGuiLaunch(session, lex.id)
    return live !== null && live.launch.pid !== before.launch.pid && live
  }, signal)
  const back = await tabsWhere(session, signal, (strip) => tabOf(strip, lex.id)?.unread && !tabOf(strip, lex.id).stopped)
  await waitFor(() => inboxDelivered(session, lex.id), signal)
  const sent = await until(session, signal, mailCard, 'Magos', 'sent', coordMailBody('planner'))
  const { chat: record } = await until(session, signal, chatRecord, session.folderPath, { id: lex.id })
  if (record.surface !== 'gui') throw new Error(`The woken Lexmechanic is on ${record.surface}, not gui.`)
  return {
    stoppedPid: before.launch.pid, tabsWhileStopped: stopped.tabs, mailed, magosSentCard: sent, wokenPid: woken.launch.pid,
    launches: woken.launches, terminalLaunches: woken.terminalLaunches, surface: record.surface, lexmechanicTab: tabOf(back, lex.id),
    inboxDelivered: true, screenshot: await capture(session, 'e2e-coord-wake.png', WINDOW)
  }
}

/** How long coord-close watches a stopped Lexmechanic stay stopped: past one mail sweep (`agentMailDesktop.ts`, 2 s). */
const STAYS_STOPPED_MS = 3_000

/**
 * Coord 4: ✕ → Cancel leaves the Lexmechanic's tab and process; ✕ → Stop removes the tab once its fake has exited,
 * and the delivered mail wakes it no more.
 */
async function coordClose(session, signal) {
  const { magos, lex } = coordChats(session)
  const live = liveGuiLaunch(session, lex.id)
  if (live === null) throw new Error(`The Lexmechanic has no one live GUI fake: ${JSON.stringify(coordLaunches(readLog(session), lex.id))}`)
  const cancelled = await answerTabStop(session, signal, 'Lexmechanic', 'Cancel')
  if (!tabOf(cancelled, lex.id) || !isAlive(live.launch.pid)) throw new Error(`Cancel stopped the Lexmechanic: ${JSON.stringify(cancelled.tabs)}`)
  await answerTabStop(session, signal, 'Lexmechanic', 'Stop')
  await waitFor(() => !isAlive(live.launch.pid), signal)
  const closed = await tabsWhere(session, signal, (strip) => strip.tabs.length === 1 && strip.tabs[0].chatId === magos.id)
  const launchesBefore = coordLaunches(readLog(session), lex.id).length
  await delay(STAYS_STOPPED_MS, undefined, { signal })
  const after = await page(session, tabStrip)
  const launches = coordLaunches(readLog(session), lex.id)
  if (launches.length !== launchesBefore || tabOf(after, lex.id)) throw new Error(`The stopped Lexmechanic came back: ${JSON.stringify({ launches, tabs: after.tabs })}`)
  return {
    tabsAfterCancel: cancelled.tabs, stoppedPid: live.launch.pid, tabsAfterStop: closed.tabs, stayedStoppedMs: STAYS_STOPPED_MS,
    launches, screenshot: await capture(session, 'e2e-coord-close.png', WINDOW)
  }
}

/**
 * The model and effort the omp fake's sessions start on without `--model` (FAKE_AGENT_OMP_START_*), as the person's
 * configured default, and the chip they read as (`ModelPicker.tsx`: the catalog name without its provider, then the effort).
 */
const MODEL_START = { model: 'anthropic/claude-opus-5-5', thinking: 'high', chip: 'Opus 5.5 · High' }
/** The `[slow]` turn's pause between lines in a model run: about 4 s for its 10 lines, room to switch models during it. */
const MODEL_SLOW_MS = 400
const MODEL_CHAT_PROMPT = 'model switch'
/** The chip's title while the agent works (`ModelPicker.tsx`, BUSY_HINT), also the open menu's first note. */
const MODEL_BUSY_HINT = 'Applies to next response'

/** The controls the fake's run `pid` logged (FAKE_AGENT_CONTROL_LOG) at or after `from` (epoch ms), in order. */
export function fakeControls(logText, pid, from = 0) {
  return logText.split(/\r?\n/).filter((line) => line.trim() !== '').map((line) => JSON.parse(line))
    .filter((entry) => entry.pid === pid && entry.at >= from)
}

/** The `--model` and `--thinking` values a launch's argv carries; null for a flag it lacks. */
export function launchModelFlags(argv) {
  const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] ?? null : null)
  return { model: flag('--model'), thinking: flag('--thinking') }
}

/** The two controls one switch to `model` (`provider/id`) at `effort` sends, in order, as the fake logs them. */
export function switchControls(model, effort) {
  const slash = model.indexOf('/')
  return [
    { type: 'set_model', provider: model.slice(0, slash), modelId: model.slice(slash + 1) },
    { type: 'set_thinking_level', level: effort }
  ]
}

function controlsOf(session, pid, from) {
  const file = session.env.FAKE_AGENT_CONTROL_LOG
  return fakeControls(existsSync(file) ? readFileSync(file, 'utf8') : '', pid, from)
}

/** Whether `controls` are exactly `expected` (each a subset of the logged control's fields). */
function sameControls(controls, expected) {
  return controls.length === expected.length && expected.every((want, index) => Object.entries(want).every(([key, value]) => controls[index][key] === value))
}

/** The chat's composer model chip: what it reads, its title (the busy hint while the agent works), queued and open. */
function modelChip(h, chatId) {
  const chip = h.chatSection(chatId)?.querySelector('.model-picker button.model-picker-chip') ?? null
  if (!chip) return { ok: false, chip: false }
  return {
    ok: true, label: chip.querySelector('.model-picker-label')?.textContent ?? null, ariaLabel: chip.getAttribute('aria-label'), title: chip.title,
    queued: chip.querySelector('.model-picker-queued') !== null, open: chip.getAttribute('aria-expanded') === 'true', spinning: chip.getAttribute('aria-busy') === 'true'
  }
}

/** Polls the chat's model chip until `test` accepts it, which it returns. */
function chipWhere(session, signal, chatId, test) {
  return waitFor(async () => {
    assertRunning(session)
    const chip = await page(session, modelChip, chatId)
    session.lastProbe = chip
    return chip.ok && test(chip) && chip
  }, signal)
}

/** Opens the chat's model menu: a click on its chip while it is closed; ok once the menu shows. */
function openModelMenu(h, chatId) {
  const picker = h.chatSection(chatId)?.querySelector('.model-picker')
  if (!picker) return { ok: false, picker: false }
  if (picker.querySelector('[role="menu"]')) return { ok: true }
  picker.querySelector('button.model-picker-chip[aria-expanded="false"]')?.click()
  return { ok: false, menu: false }
}

/**
 * Clicks the first featured model under the open menu's `heading` group (Claude or Codex); ok with the name it shows
 * and the menu's notes (the busy hint) as it was clicked.
 */
function pickModel(h, chatId, heading) {
  const menu = h.chatSection(chatId)?.querySelector('.model-picker [role="menu"]')
  if (!menu) return { ok: false, menu: false }
  const hints = [...menu.querySelectorAll('.model-picker-hint')].map((hint) => hint.textContent)
  const item = menu.querySelector(`[role="group"][aria-label="${heading}"] [role="menuitemradio"]`)
  if (!item) return { ok: false, hints }
  item.click()
  return { ok: true, name: item.querySelector('.model-picker-name')?.textContent ?? null, hints }
}

/** The open menu's Effort control for the picked model; ok with its label and efforts once it shows them. */
function effortControl(h, chatId) {
  const control = h.chatSection(chatId)?.querySelector('.model-picker [role="menu"] .model-picker-effort')
  if (!control) return { ok: false, control: false }
  const label = control.querySelector('.model-picker-effort-label')?.textContent ?? ''
  return { ok: label.startsWith('Effort for '), label, efforts: [...control.querySelectorAll('[data-effort]')].map((segment) => segment.textContent) }
}

/** Clicks the open menu's `effort` segment (Medium, High, …), which switches the chat. */
function pickEffort(h, chatId, effort) {
  const segments = h.chatSection(chatId)?.querySelectorAll('.model-picker [role="menu"] .model-picker-effort [data-effort]') ?? []
  const segment = [...segments].find((button) => button.textContent === effort)
  segment?.click()
  return { ok: !!segment, segments: segments.length }
}

/** The chat's catalog (`agentChat:models`), each model's provider, id, name and efforts. */
async function chatCatalog(_h, folder, chatId) {
  const result = await window.dm.agentChat.models({ folder, chatId })
  if (!result.ok) return { ok: false, error: result.error.message }
  return { ok: true, options: result.data.map(({ provider, id, name, efforts }) => ({ provider, id, name, efforts })) }
}

/** The chat's live model, effort and status (its snapshot), and its newest `model_change` item. */
async function chatModel(_h, folder, chatId) {
  const result = await window.dm.agentChat.snapshot({ folder, chatId })
  if (!result.ok) return { ok: false, error: result.error.message }
  const { model, thinking, status, items } = result.data
  const change = items.findLast((item) => item.kind === 'model_change') ?? null
  return { ok: true, model: model ?? null, thinking: thinking ?? null, status, change: change && { from: change.from, to: change.to } }
}

/** The chat's transcript shows the notice `text` (a model change). */
function noticeShown(h, chatId, text) {
  const notices = [...(h.chatSection(chatId)?.querySelectorAll('.chat-transcript li.chat-notice') ?? [])].map((notice) => notice.textContent.trim())
  return { ok: notices.includes(text), notices }
}

/** The catalog model the menu showed as `name` under the provider of `heading` (`Opus 5.5` is `Claude Opus 5.5`): `provider/id`. */
async function pickedModel(session, signal, { chatId, heading, name }) {
  const { options } = await until(session, signal, chatCatalog, session.folderPath, chatId)
  const provider = { Claude: 'anthropic', Codex: 'openai-codex' }[heading]
  const option = options.find((entry) => entry.provider === provider && (entry.name === name || entry.name === `${heading} ${name}`))
  if (!option) throw new Error(`The catalog has no ${heading} model named ${name}.`)
  return `${option.provider}/${option.id}`
}

/** Polls the chat's snapshot until `test` accepts its model state, which it returns. */
function modelWhere(session, signal, chatId, test) {
  return waitFor(async () => {
    assertRunning(session)
    const state = await page(session, chatModel, session.folderPath, chatId)
    session.lastProbe = state
    return state.ok && test(state) && state
  }, signal)
}

/**
 * One switch from the open chip: the first featured `heading` model, a menu capture `menuShot` while its Effort control
 * shows, then `effort`. Resolves once the chip reads the switched model and effort and the fake logged exactly the
 * switch's two controls since `from`.
 */
async function switchModel(session, signal, { chatId, pid, heading, effort, menuShot, from, chipTest = () => true }) {
  await until(session, signal, openModelMenu, chatId)
  const picked = await until(session, signal, pickModel, chatId, heading)
  const control = await until(session, signal, effortControl, chatId)
  const menu = await capture(session, menuShot, WINDOW)
  await until(session, signal, pickEffort, chatId, effort)
  const model = await pickedModel(session, signal, { chatId, heading, name: picked.name })
  const chip = await chipWhere(session, signal, chatId, (state) => !state.spinning && state.label === `${picked.name} · ${effort}` && chipTest(state))
  const expected = switchControls(model, effort.toLowerCase())
  const controls = await waitFor(() => {
    const logged = controlsOf(session, pid, from)
    session.lastProbe = { controls: logged, expected }
    return logged.length >= expected.length && logged
  }, signal)
  if (!sameControls(controls, expected)) throw new Error(`The fake got ${JSON.stringify(controls)}, not ${JSON.stringify(expected)}.`)
  return { picked, effortControl: control, model, chip, controls, menuScreenshot: menu }
}

function modelChat(session) {
  if (session.model === null) throw new Error('The model steps after model-pick drive its chat: run model-pick first.')
  return session.model
}

/**
 * Model 1: a new Skitarii folder chat's chip reads the fake's `get_state` model and effort (Opus 5.5 at High). The
 * first featured Codex model at Medium makes the fake log `set_model` and `set_thinking_level` with exactly those, the
 * chip reads it, and the transcript shows the `model_change` notice.
 */
async function modelPick(session, signal) {
  await until(session, signal, clickSelector, `button[aria-label="New chat in ${FOLDER_NAME}"]`)
  await until(session, signal, fill, '.dialog[role="dialog"] textarea', MODEL_CHAT_PROMPT)
  await until(session, signal, clickButton, '.dialog[role="dialog"] .dialog-actions', 'Start')
  const { chat } = await until(session, signal, chatRecord, session.folderPath, { firstPrompt: MODEL_CHAT_PROMPT })
  if (chat.agent !== 'omp' || chat.surface !== 'gui') throw new Error(`The chat is ${chat.agent} on ${chat.surface}, not omp on gui.`)
  await until(session, signal, turnDone, session.folderPath, chat.id, { text: MODEL_CHAT_PROMPT })
  const live = liveGuiLaunch(session, chat.id)
  if (live === null) throw new Error(`The chat has no one live GUI fake: ${JSON.stringify(coordLaunches(readLog(session), chat.id))}`)
  const { pid } = live.launch
  const started = await modelWhere(session, signal, chat.id, (state) => state.model === MODEL_START.model && state.thinking === MODEL_START.thinking)
  const startChip = await chipWhere(session, signal, chat.id, (state) => state.label === MODEL_START.chip)
  const from = Date.now()
  const switched = await switchModel(session, signal, { chatId: chat.id, pid, heading: 'Codex', effort: 'Medium', menuShot: 'e2e-model-pick-menu.png', from })
  const state = await modelWhere(session, signal, chat.id, (snapshot) => snapshot.model === switched.model && snapshot.thinking === 'medium'
    && snapshot.change?.from === MODEL_START.model && snapshot.change.to === switched.model)
  const notice = await until(session, signal, noticeShown, chat.id, `Model changed from ${MODEL_START.model} to ${switched.model}.`)
  session.model = { chatId: chat.id, pid, codex: switched.model }
  return {
    chat, pid, startModel: { model: started.model, thinking: started.thinking }, startChip: startChip.label, ...switched,
    snapshot: { model: state.model, thinking: state.thinking, change: state.change }, notice: notice.notices,
    screenshot: await capture(session, 'e2e-model-pick.png', WINDOW)
  }
}

/**
 * Model 2: during a `[slow]` turn the chip carries the busy hint; the first featured Claude model at High goes to the
 * fake (at once, while the turn runs, or after it) and the chip says queued. The turn is never interrupted: the same
 * fake process ends it with its whole reply, no abort reaches it and no turn_stopped is stored.
 */
async function modelBusy(session, signal) {
  const { chatId, pid, codex } = modelChat(session)
  const from = Date.now()
  await until(session, signal, composeAndSend, chatId, '[slow]')
  const busyChip = await chipWhere(session, signal, chatId, (state) => state.title === MODEL_BUSY_HINT)
  const switched = await switchModel(session, signal, {
    chatId, pid, heading: 'Claude', effort: 'High', menuShot: 'e2e-model-busy-menu.png', from, chipTest: (state) => state.queued
  })
  if (!switched.picked.hints.includes(MODEL_BUSY_HINT)) throw new Error(`The menu did not show the busy hint: ${JSON.stringify(switched.picked.hints)}`)
  const queuedShot = await capture(session, 'e2e-model-busy-queued.png', WINDOW)
  await until(session, signal, turnDone, session.folderPath, chatId, { text: '[slow]' })
  const turn = await until(session, signal, turnItems, session.folderPath, chatId, '[slow]')
  if (turn.reply !== 'Hello world' || turn.kinds.includes('turn_stopped')) throw new Error(`The [slow] turn did not end whole: ${JSON.stringify(turn)}`)
  const controls = controlsOf(session, pid, from)
  if (!sameControls(controls, switchControls(switched.model, 'high'))) throw new Error(`The fake got more than the switch: ${JSON.stringify(controls)}`)
  if (!isAlive(pid)) throw new Error(`The chat's fake (pid ${pid}) is gone.`)
  const after = await chipWhere(session, signal, chatId, (state) => !state.queued && state.label === switched.chip.label)
  const state = await modelWhere(session, signal, chatId, (snapshot) => snapshot.model === switched.model && snapshot.thinking === 'high' && snapshot.change?.to === switched.model)
  if (state.change.from !== codex) throw new Error(`The model change is from ${state.change.from}, not ${codex}.`)
  session.model = { ...session.model, claude: switched.model }
  return {
    busyChip, ...switched, receivedWhileBusy: controls.map((control) => control.busy), turn, samePid: pid, chipAfter: after.label,
    snapshot: { model: state.model, thinking: state.thinking, change: state.change },
    screenshots: [switched.menuScreenshot, queuedShot, await capture(session, 'e2e-model-busy.png', WINDOW)]
  }
}

/** Model 3, phase 1: the chat's record keeps the Claude model and High; a plain quit ends the app and its fakes. */
async function modelRestartQuit(session, signal) {
  const { chatId, claude } = modelChat(session)
  if (!claude) throw new Error('model-restart checks the model model-busy switched to: run model-busy first.')
  const record = chatStore(session).getChat({ folder: session.folderPath, id: chatId })
  if (record?.model !== claude || record.thinking !== 'high') throw new Error(`The chat record keeps ${record?.model} at ${record?.thinking}, not ${claude} at high.`)
  const exited = await quit(session, signal)
  const fakes = await fakeProcessesExited(session, signal)
  session.model = { ...session.model, quitAt: Date.now() }
  return { record: { model: record.model, thinking: record.thinking }, ...exited, ...fakes }
}

/** Shows the chat: its composer, else a click on its sidebar row (by `title`). */
function showChat(_h, chatId, title) {
  if (document.getElementById(`agent-message-${chatId}`)) return { ok: true }
  const row = [...document.querySelectorAll('.chat-row button.chat-row-main')].find((button) => button.querySelector('.chat-row-title')?.textContent === title)
  row?.click()
  return { ok: false, row: !!row }
}

/**
 * Model 3, phase 3: the chat, shown and sent a message, starts one new GUI fake whose argv carries `--model` and
 * `--thinking` with the Claude model and High; its chip reads them back from `get_state`.
 */
async function modelRestartResumed(session, signal) {
  const { chatId, claude, quitAt } = modelChat(session)
  const { chat } = await until(session, signal, chatRecord, session.folderPath, { id: chatId })
  await until(session, signal, showChat, chatId, chat.title)
  await until(session, signal, composeAndSend, chatId, 'after restart')
  await until(session, signal, turnDone, session.folderPath, chatId, { text: 'after restart' })
  const launches = coordLaunches(readLog(session), chatId).filter((launch) => launch.at >= quitAt)
  if (launches.length !== 1 || launches[0].mode !== 'omp') throw new Error(`Expected one GUI launch after the restart: ${JSON.stringify(launches)}`)
  const entry = fakeAgentLog(readLog(session)).find((logged) => logged.pid === launches[0].pid && logged.at === launches[0].at)
  const flags = launchModelFlags(entry.argv)
  if (flags.model !== claude || flags.thinking !== 'high') throw new Error(`The relaunch carries --model ${flags.model} --thinking ${flags.thinking}, not ${claude} high.`)
  const state = await modelWhere(session, signal, chatId, (snapshot) => snapshot.model === claude && snapshot.thinking === 'high')
  const chip = await chipWhere(session, signal, chatId, (shown) => shown.label.endsWith(' · High') && !shown.queued)
  return {
    launch: { pid: entry.pid, argv: entry.argv }, flags, snapshot: { model: state.model, thinking: state.thinking }, chip: chip.label,
    screenshot: await capture(session, 'e2e-model-restart.png', WINDOW)
  }
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
  },
  'polish-picker': { name: 'polish-picker', run: polishPicker, polish: true },
  'polish-composer': { name: 'polish-composer', run: polishComposer, polish: true },
  'polish-copy': { name: 'polish-copy', run: polishCopy, polish: true },
  'polish-multiselect': { name: 'polish-multiselect', run: polishMultiselect, polish: true },
  'polish-worked-for': { name: 'polish-worked-for', run: polishWorkedFor, polish: true },
  'polish-untrack': { name: 'polish-untrack', run: polishUntrack, polish: true },
  'image-send': { name: 'image-send', run: imageSend, image: true },
  'image-result': { name: 'image-result', run: imageResult, image: true },
  'coord-tabs': { name: 'coord-tabs', run: coordTabs, coord: true, skitarii: true },
  'coord-mail': { name: 'coord-mail', run: coordMail, coord: true, skitarii: true },
  'coord-wake': { name: 'coord-wake', run: coordWake, coord: true, skitarii: true },
  'coord-close': { name: 'coord-close', run: coordClose, coord: true, skitarii: true },
  'model-pick': { name: 'model-pick', run: modelPick, model: true, skitarii: true },
  'model-busy': { name: 'model-busy', run: modelBusy, model: true, skitarii: true },
  'model-restart': {
    model: true, skitarii: true,
    phases: [
      { name: 'model-restart quit', run: modelRestartQuit },
      { name: 'model-restart launch', run: appReady },
      { name: 'model-restart resumed', run: modelRestartResumed }
    ]
  },
  'polish-multiquestion': { name: 'polish-multiquestion', run: polishMultiquestion, polish: true, skitarii: true }
}

async function captureFailure(session, step) {
  const detail = { stderrTail: session.stderr.trimEnd().split(/\r?\n/).slice(-STDERR_TAIL_LINES), lastProbe: session.lastProbe, refusedImages: refusedImages(session.console) }
  if (session.page?.socket.readyState !== WebSocket.OPEN) return { ...detail, screenshot: null, screenshotSkipped: 'no renderer connection' }
  const bound = delay(SCREENSHOT_BOUND_MS).then(() => { throw new Error('screenshot timed out') })
  const { data } = await Promise.race([cdp(session, 'Page.captureScreenshot', { format: 'png' }), bound])
  const file = join(session.out, failureScreenshotName(step))
  writeFileSync(file, Buffer.from(data, 'base64'))
  return { ...detail, screenshot: file }
}

/** The phases `keys` run, in order, each verdict step named after its phase: a step without phases is its own one. */
export function stepPhases(keys) {
  return keys.flatMap((key) => STEPS[key].phases ?? [STEPS[key]])
}

async function runSteps(session, keys, steps) {
  const onFailure = (step) => captureFailure(session, step)
  steps.push(await runStep('stale isolated roots removed', async () => removeStaleRoots()))
  const prepared = await runStep('setup', async () => setup(session), { onFailure })
  steps.push(prepared)
  for (const phase of prepared.ok ? stepPhases(keys) : []) {
    const result = await runStep(phase.name, (signal) => phase.run(session, signal), { onFailure })
    steps.push(result)
    if (!result.ok) break
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
  const controls = session.env.FAKE_AGENT_CONTROL_LOG
  if (controls && existsSync(controls)) copyFileSync(controls, join(session.out, 'fake-controls.jsonl'))
}

function removeIsolatedState(session) {
  rmSync(session.root, { recursive: true, force: true })
  if (existsSync(session.root)) throw new Error(`The isolated root ${session.root} is still present.`)
  return { removed: session.root }
}

/** Refuses the steps the selected fake cannot drive: Claude-only ones with the omp fake, Skitarii ones with the claude fake. */
function refuseOtherKind(keys, agent) {
  const ompSteps = [...OMP_STEPS, ...Object.keys(STEPS).filter((key) => STEPS[key].skitarii)]
  const claudeOnly = agent === 'omp' ? keys.filter((key) => !ompSteps.includes(key)) : []
  if (claudeOnly.length > 0) throw new Error(`--agent omp runs only ${ompSteps.join(', ')}; ${claudeOnly.join(', ')} drive the claude fake.`)
  const skitarii = agent === 'claude' ? keys.filter((key) => STEPS[key].skitarii) : []
  if (skitarii.length > 0) throw new Error(`${skitarii.join(', ')} drive the omp fake: leave out --agent claude.`)
}

/**
 * The steps to run: `--steps`, else every step but the polish, image, coord and model ones (only OMP_STEPS for `--agent
 * omp`); unknown ones are refused, as are those the selected fake cannot drive. A list that neither starts the app
 * nor names `ready` gets `ready` first.
 */
function stepKeys(requested, agent) {
  const keys = requested?.split(',') ?? (agent === 'omp' ? OMP_STEPS : Object.keys(STEPS).filter((key) => !STEPS[key].polish && !STEPS[key].image && !STEPS[key].skitarii))
  const unknown = keys.filter((key) => !Object.hasOwn(STEPS, key))
  if (unknown.length > 0) throw new Error(`Unknown step(s) ${unknown.join(', ')}; known: ${Object.keys(STEPS).join(', ')}`)
  refuseOtherKind(keys, agent)
  return APP_STARTING_STEPS.includes(keys[0]) || keys.includes('ready') ? keys : ['ready', ...keys]
}

/** `--agent`, else `omp` when a coord or model step is named (they run Skitarii chats), else `claude`. */
function agentOf(argv, requested) {
  const skitarii = requested?.split(',').some((key) => STEPS[key]?.skitarii) ?? false
  const agent = argv.includes('--agent') ? argv[argv.indexOf('--agent') + 1] : skitarii ? 'omp' : 'claude'
  if (!AGENT_KINDS.includes(agent)) throw new Error(`--agent takes ${AGENT_KINDS.join(' or ')}, not ${agent ?? 'nothing'}.`)
  return agent
}

export function parseArgs(argv) {
  const value = (flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined)
  const out = value('--out')
  if (!out) {
    throw new Error(`Usage: node scripts/e2e-agent-chat.mjs --out <dir> [--exe <packaged app exe>] [--agent ${AGENT_KINDS.join('|')}] [--steps ${Object.keys(STEPS).join(',')}]`)
  }
  if (argv.includes('--exe') && !value('--exe')) throw new Error('--exe needs the path of a packaged app executable.')
  const requested = value('--steps')
  const agent = agentOf(argv, requested)
  const exe = value('--exe')
  return { out: resolve(out), exe: exe === undefined ? null : resolve(exe), agent, keys: stepKeys(requested, agent) }
}

async function main(argv) {
  const { out, exe, agent, keys } = parseArgs(argv)
  mkdirSync(out, { recursive: true })
  const session = createSession(out, exe, agent, keys)
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
