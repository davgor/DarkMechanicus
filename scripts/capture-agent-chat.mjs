/**
 * Captures the epic Agent tab's states unattended: `node scripts/capture-agent-chat.mjs --out <dir>` serves
 * `preview/epic-agent` with the repo's Vite, opens each `?state=` in the repo's own Electron (hidden windows, one
 * temporary profile) and writes `<state>.png` per state plus `observations.json`. Any launch failure, missed
 * deadline, page error, missing observation or empty/small capture fails the run with its reason; nothing is
 * reported as skipped. The Vite server, the Electron process tree and the temporary profile never outlive the run.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PREVIEW = join(REPO, 'preview', 'epic-agent')
const ELECTRON_ENTRY = join(REPO, 'scripts', 'capture-agent-chat.electron.cjs')

/** Every state the preview page knows, in capture order. */
export const STATES = Object.freeze([
  'graph', 'agent-empty', 'agent-streaming', 'agent-tool', 'agent-approval', 'agent-worker', 'agent-tree', 'rail-collapsed',
  'chat-rail', 'agent-todos', 'agent-todos-collapsed', 'agent-stalled', 'agent-changes', 'agent-approval-named',
  'agent-magos-decided', 'agent-needs-you', 'settings-notifications'
])

/** Per state, from loading its URL to `#observations[data-ready="1"]`. */
export const STATE_DEADLINE_MS = 15_000
/** A declared bound: 17 states at up to 15 s each, plus the Vite and Electron start. */
export const OVERALL_LIMIT_MS = 300_000
export const MIN_PNG_BYTES = 10 * 1024

/** Inherited variables that would change how Electron starts: `ELECTRON_RUN_AS_NODE=1` alone runs it as plain Node. */
const STRIPPED_ENV = /^(?:ELECTRON_.*|NODE_OPTIONS|DM_SESSION_TOKEN|DM_DESKTOP_PIPE)$/i

/** The window's content size when `--viewport` is not given: the ticket's 1280×800. */
export const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 800 })

function parseViewport(value) {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(value ?? '')
  if (match === null) throw new Error(`--viewport takes WIDTHxHEIGHT, such as 1024x768; got ${value}`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

export function parseArgs(argv) {
  let out = null
  let viewport = DEFAULT_VIEWPORT
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg.startsWith('--out=')) out = arg.slice('--out='.length)
    else if (arg === '--out') out = argv[++index] ?? null
    else if (arg.startsWith('--viewport=')) viewport = parseViewport(arg.slice('--viewport='.length))
    else if (arg === '--viewport') viewport = parseViewport(argv[++index])
    else throw new Error(`Unknown argument: ${arg}`)
  }
  if (out === null || out.trim() === '') throw new Error('Usage: node scripts/capture-agent-chat.mjs --out <dir>')
  return { out: resolve(out), viewport }
}

/** A copy of `env` without the variables that would redirect Electron or hand it the app's session. */
export function electronEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !STRIPPED_ENV.test(key)))
}

const BASE_FIELDS = [
  'viewButtons', 'agentFontWeight', 'planGraph', 'planList', 'scorecard', 'agentChatRegion', 'railWidth', 'railRightOfStage',
  'treeRows', 'todosHeader', 'todoRows', 'todoListScrolls', 'activeRowVisible', 'activityLine', 'changesHeader', 'cardHeading',
  'needsYouHeader', 'badgedRows', 'settingsControls', 'errors'
]
const VIEW_BUTTONS = ['Graph', 'List', 'Agent', 'Scorecard']
const EPIC_STATES = new Set(STATES.filter((state) => state !== 'chat-rail' && state !== 'settings-notifications'))
const AGENT_STATES = new Set([...EPIC_STATES].filter((state) => state !== 'graph'))

const near = (value, target) => typeof value === 'number' && Math.abs(value - target) <= 1
const rowNamed = (o, name) => Array.isArray(o.treeRows) && o.treeRows.find((row) => row.name === name)
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value)

/** What each state must show, beyond the fields every state reports: [description, check]. */
const STATE_CHECKS = {
  graph: [['the Plan graph is present', (o) => o.planGraph === true], ['no Agent chat region', (o) => o.agentChatRegion === false]],
  'agent-empty': [['no plan graph, list or scorecard', (o) => !o.planGraph && !o.planList && !o.scorecard]],
  'agent-tool': [['the tree lists Magos and the subagent Acolyte:DM-785', (o) => rowNamed(o, 'Magos') && rowNamed(o, 'Acolyte:DM-785')]],
  'agent-approval': [['a docked card heading', (o) => matches(o.cardHeading, /wants to run/)]],
  'agent-worker': [['Acolyte:DM-2 is selected', (o) => rowNamed(o, 'Acolyte:DM-2')?.selected === true]],
  'agent-tree': [
    ['railWidth is 280±1', (o) => near(o.railWidth, 280)],
    ['the tree shows Magos, Finished 1 > Acolyte:DM-1, Acolyte:DM-2 > Inquisitor:DM-2 and Servitor-1',
      (o) => ['Magos', 'Finished 1', 'Acolyte:DM-1', 'Acolyte:DM-2', 'Inquisitor:DM-2', 'Servitor-1'].every((name) => rowNamed(o, name))]
  ],
  'rail-collapsed': [['railWidth is 40±1', (o) => near(o.railWidth, 40)]],
  'chat-rail': [
    ['the Chat agents rail is right of the chat', (o) => o.railRightOfStage === true],
    ['Inquisitor:DM-2 is selected', (o) => rowNamed(o, 'Inquisitor:DM-2')?.selected === true]
  ],
  'agent-todos': [
    ['a To-dos header', (o) => matches(o.todosHeader, /To-dos/)],
    ['task rows', (o) => o.todoRows > 5],
    ['the task list scrolls', (o) => o.todoListScrolls === true],
    ['the active row is inside the list', (o) => o.activeRowVisible === true],
    ['the activity line reads Working … · Bash', (o) => matches(o.activityLine, /^Working .* · Bash$/)]
  ],
  'agent-todos-collapsed': [
    ['the collapsed header shows the active task', (o) => matches(o.todosHeader, /Implementing the card/)],
    ['no task rows', (o) => o.todoRows === 0]
  ],
  'agent-stalled': [['the activity line reads No activity for 31s', (o) => matches(o.activityLine, /^No activity for 31s(?!\d)/)]],
  'agent-changes': [['the Changes header lists 2 files', (o) => o.changesHeader === 'Changes · 2 files']],
  'agent-approval-named': [
    ['the card is headed Acolyte:DM-442 wants to run: npm test', (o) => o.cardHeading === 'Acolyte:DM-442 wants to run: npm test'],
    ['the card says The Magos asks you', (o) => matches(o.cardArbitration, /^The Magos asks you: \S/)]
  ],
  'agent-magos-decided': [
    ['the record reads Asked by Acolyte:DM-442 and Denied by the Magos with its reason',
      (o) => matches(o.approvalRecord, /Asked by Acolyte:DM-442/) && matches(o.approvalRecord, /Denied by the Magos/)
        && matches(o.approvalRecord, /The Magos decided: \S/)]
  ],
  'agent-needs-you': [
    ['the header reads 2 needs you', (o) => matches(o.needsYouHeader, /^2 needs you/)],
    ['two badged rows', (o) => o.badgedRows === 2]
  ],
  'settings-notifications': [['the controls have accessible names', (o) => Array.isArray(o.settingsControls)
    && o.settingsControls.length > 0 && o.settingsControls.every((name) => typeof name === 'string' && name.trim() !== '')]]
}

/** What every epic state must show, and the agent states besides: [description, applies, check]. */
const EPIC_CHECKS = [
  ['the View buttons are Graph, List, Agent, Scorecard in order', () => true,
    (o) => JSON.stringify(o.viewButtons) === JSON.stringify(VIEW_BUTTONS)],
  ['a bold Agent label', () => true, (o) => Number(o.agentFontWeight) >= 600],
  ['an Agent chat region', (state) => AGENT_STATES.has(state), (o) => o.agentChatRegion === true],
  ['no plan graph, list or scorecard node', (state) => AGENT_STATES.has(state), (o) => !o.planGraph && !o.planList && !o.scorecard],
  ['the rail right of the stage', (state) => AGENT_STATES.has(state), (o) => o.railRightOfStage !== false]
]

function stateChecks(state) {
  const epic = EPIC_STATES.has(state) ? EPIC_CHECKS.filter(([, applies]) => applies(state)) : []
  return [...epic.map(([description, , check]) => [description, check]), ...STATE_CHECKS[state] ?? []]
}

/** A record's own shape: data-ready, every observation field, the right state and no page errors. */
function shapeProblems(state, record) {
  if (!record || record.ready !== true) return [`#observations[data-ready="1"] never appeared${record?.error ? ` (${record.error})` : ''}`]
  const o = record.observations
  if (o === null || typeof o !== 'object') return ['the observations are not an object']
  const problems = BASE_FIELDS.filter((field) => !(field in o)).map((field) => `missing observation ${field}`)
  if (o.state !== state) problems.push(`observations are for "${o.state}"`)
  if (!Array.isArray(o.errors)) return [...problems, 'errors is not a list']
  return [...problems, ...o.errors.map((error) => `page error: ${error}`)]
}

/**
 * The reasons one state's capture record fails, empty when it passes: no `data-ready`, a missing observation, a
 * page error, or what the state must show.
 */
export function validateObservations(state, record) {
  const shape = shapeProblems(state, record)
  const problems = shape.length > 0
    ? shape
    : stateChecks(state).filter(([, check]) => !check(record.observations)).map(([description]) => `expected ${description}`)
  return problems.map((problem) => `${state}: ${problem}`)
}

function sameSize(page, viewport) {
  return page?.width === viewport.width && page?.height === viewport.height
}

/**
 * The reasons a captured image fails: an empty image, a PNG under 10 KB, or a page whose CSS viewport (read from the
 * fresh page itself) is not the requested size.
 */
export function validateCapture(state, record, viewport = DEFAULT_VIEWPORT) {
  if (!record || record.ready !== true) return []
  if (record.empty) return [`${state}: capturePage() returned an empty image`]
  const problems = []
  if (!(record.bytes >= MIN_PNG_BYTES)) problems.push(`${state}: the PNG is ${record.bytes} bytes, under ${MIN_PNG_BYTES}`)
  if (!sameSize(record.viewport, viewport)) {
    problems.push(`${state}: the page viewport was ${record.viewport?.width}x${record.viewport?.height}, not ${viewport.width}x${viewport.height}`)
  }
  return problems
}

/** Every reason the run fails, across all states; a state Electron never reported is a failure too. */
export function runFailures(records, viewport = DEFAULT_VIEWPORT) {
  return STATES.flatMap((state) => {
    const record = records[state]
    if (record === undefined) return [`${state}: Electron reported nothing for this state`]
    return [...validateObservations(state, record), ...validateCapture(state, record, viewport)]
  })
}

function freePort() {
  const { promise, resolve: done, reject } = Promise.withResolvers()
  const server = createNetServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address()
    server.close(() => done(port))
  })
  return promise
}

function killTree(child) {
  if (child === null || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill('SIGKILL')
}

async function startVite() {
  const { createServer } = await import('vite')
  const port = await freePort()
  const server = await createServer({
    configFile: join(PREVIEW, 'vite.config.ts'), root: PREVIEW, logLevel: 'error', clearScreen: false,
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false }
  })
  await server.listen()
  return { server, base: `http://127.0.0.1:${port}/agent.html` }
}

/**
 * Runs the Electron entry over every state and resolves with its per-state records once it exits 0; rejects when it
 * cannot start, exits otherwise, or outlives the overall limit (its process tree is killed then).
 */
function runElectron({ base, out, userData, session, viewport }) {
  const { promise, resolve: done, reject } = Promise.withResolvers()
  const config = Buffer.from(JSON.stringify({ base, states: STATES, out, deadlineMs: STATE_DEADLINE_MS, viewport })).toString('base64')
  const electron = createRequire(import.meta.url)('electron')
  const child = spawn(electron, [ELECTRON_ENTRY, `--user-data-dir=${userData}`, `--capture-config=${config}`],
    { cwd: REPO, env: electronEnv(process.env), stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
  session.child = child
  const records = {}
  let started = false
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4_000) })
  child.stdout.resume()
  child.on('message', (message) => {
    if (message?.type === 'started') started = true
    if (message?.type === 'state') records[message.record.state] = message.record
    if (message?.type === 'fatal') stderr = `${stderr}\n${message.error}`
  })
  child.once('error', (error) => reject(new Error(`Electron failed to start: ${error.message}`)))
  child.once('exit', (code, signal) => {
    if (!started) reject(new Error(`Electron failed to start (exit ${code ?? signal}): ${stderr.trim() || 'no output'}`))
    else if (code !== 0) reject(new Error(`Electron exited with ${code ?? signal}: ${stderr.trim() || 'no output'}`))
    else done(records)
  })
  return promise
}

function overallLimit(session) {
  const { promise, reject } = Promise.withResolvers()
  session.timer = setTimeout(() => {
    killTree(session.child)
    reject(new Error(`The capture exceeded its ${OVERALL_LIMIT_MS / 1_000} s overall limit`))
  }, OVERALL_LIMIT_MS)
  return promise
}

function report(out, records, failures) {
  const states = Object.fromEntries(STATES.map((state) => [state, records[state] ?? null]))
  writeFileSync(join(out, 'observations.json'), `${JSON.stringify({ states, failures }, null, 2)}\n`)
}

async function main() {
  const { out, viewport } = parseArgs(process.argv.slice(2))
  mkdirSync(out, { recursive: true })
  const userData = mkdtempSync(join(tmpdir(), 'dm-capture-agent-chat-'))
  const session = { child: null, timer: null, server: null }
  let records = {}
  let failures
  try {
    const capture = (async () => {
      const vite = await startVite()
      session.server = vite.server
      return runElectron({ base: vite.base, out, userData, session, viewport })
    })()
    records = await Promise.race([capture, overallLimit(session)])
    failures = runFailures(records, viewport)
  } catch (error) {
    failures = [error instanceof Error ? error.message : String(error)]
  } finally {
    clearTimeout(session.timer)
    killTree(session.child)
    await session.server?.close()
    rmSync(userData, { recursive: true, force: true })
  }
  report(out, records, failures)
  if (failures.length > 0) {
    console.error(`Capture failed (${failures.length}):\n${failures.map((line) => `- ${line}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`Captured ${STATES.length} states into ${out}`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main()
}
