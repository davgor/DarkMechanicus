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
  'graph', 'header-long', 'agent-empty', 'agent-streaming', 'agent-tool', 'agent-approval', 'agent-worker', 'agent-legacy-thread',
  'agent-tree', 'rail-collapsed', 'landing-notification', 'landing-activity', 'chat-rail', 'chat-rail-collapsed', 'agent-todos',
  'agent-todos-collapsed', 'agent-stalled', 'agent-changes', 'agent-approval-named', 'agent-magos-decided', 'agent-needs-you',
  'agent-planners', 'chat-rail-legacy',
  'agent-glass', 'agent-composer',
  'settings-notifications', 'delivery-editor', 'delivery-pending', 'delivery-checkpoint'
])

/** Per state, from loading its URL to `#observations[data-ready="1"]`. */
export const STATE_DEADLINE_MS = 15_000
/** A declared bound: 29 states at up to 15 s each, plus the Vite and Electron start. */
export const OVERALL_LIMIT_MS = 450_000
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
  'viewButtons', 'agentFontWeight', 'header', 'planGraph', 'planList', 'scorecard', 'agentChatRegion', 'railWidth', 'railRightOfStage',
  'treeRows', 'finishedExpandedAtStart', 'todosHeader', 'todoRows', 'todoListScrolls', 'activeRowVisible', 'activityLine',
  'changesHeader', 'cardHeading', 'needsYouHeader', 'badgedRows', 'ticketPanel', 'settingsControls', 'agentsPressed',
  'sprintDeliveryRegion', 'deliveryLine', 'deliveryApproval', 'previousDelivery', 'firstFailedCheck', 'errors'
]
const VIEW_BUTTONS = ['Agent', 'Graph', 'List', 'Scorecard']
const CHAT_STATES = new Set(['chat-rail', 'chat-rail-collapsed', 'chat-rail-legacy', 'agent-composer', 'settings-notifications'])
const EPIC_STATES = new Set(STATES.filter((state) => !CHAT_STATES.has(state)))
/** Epic states over the plan, the draft editor or the checkpoint rather than the Agent tab. */
const PLAN_STATES = new Set(['graph', 'header-long', 'delivery-editor', 'delivery-pending', 'delivery-checkpoint'])
const AGENT_STATES = new Set([...EPIC_STATES].filter((state) => !PLAN_STATES.has(state)))
/** The seeded Sprint 1 delivery check's failure, as the delivery states report their first failed check. */
const STALE_INSTALL = 'Installed app version: 0.49.0 is older than 0.50.0'

const near = (value, target) => typeof value === 'number' && Math.abs(value - target) <= 1
const rowNamed = (o, name) => Array.isArray(o.treeRows) && o.treeRows.find((row) => row.name === name)
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value)
/** The alpha of a computed `rgb()`/`rgba()` color; null for anything else. */
const alphaOf = (color) => {
  const match = /^rgba?\([^,]+,[^,]+,[^,)]+(?:,\s*([\d.]+))?\)$/.exec(typeof color === 'string' ? color : '')
  return match === null ? null : match[1] === undefined ? 1 : Number(match[1])
}
/** A frosted surface: a translucent background (at most 0.72 alpha) under a backdrop blur. */
const frosted = (surface) => matches(surface?.backdropFilter, /blur\(\d+px\)/) && alphaOf(surface?.background) > 0
  && alphaOf(surface?.background) <= 0.72
/** The agent-composer state's composers, or none. */
const composersOf = (o) => Array.isArray(o.composers) ? o.composers : []
/** Which of Send and Stop a composer shows: `send`, `stop`, `both` or `none`. */
const composerButtons = (card) => card?.send && card?.stop ? 'both' : card?.send ? 'send' : card?.stop ? 'stop' : 'none'
const round = (button) => button?.radius === '50%' && near(button.width, 32) && near(button.height, 32)
const square = (button) => button?.radius === '8px' && near(button.width, 32) && near(button.height, 32)

/**
 * The agent-tree state's shipped tree in document order, as [name, level, parent]: the Magos root, its live workers
 * (Acolyte:DM-2 with its own Inquisitor:DM-2, then Servitor-1) and last the Finished group, which holds Acolyte:DM-1.
 */
const AGENT_TREE_LEVELS = [
  ['Magos', 1, null], ['Acolyte:DM-2', 2, 'Magos'], ['Inquisitor:DM-2', 3, 'Acolyte:DM-2'], ['Servitor-1', 2, 'Magos'],
  ['Finished 1', 2, 'Magos'], ['Acolyte:DM-1', 3, 'Finished 1']
]

/** Where a tree row sits: its aria-level and its parent, the nearest row before it one level up (rows are in document order). */
function placement(o, name) {
  const rows = Array.isArray(o.treeRows) ? o.treeRows : []
  const index = rows.findIndex((row) => row.name === name)
  if (index < 0) return null
  const { level } = rows[index]
  const parent = rows.slice(0, index).findLast((row) => row.level === level - 1)
  return { level, parent: level === 1 ? null : parent?.name ?? null }
}

const describePlacement = (where) => where === null ? 'no such row' : `level ${where.level} under ${where.parent ?? 'no parent'}`

/** One check per agent-tree node: its tree level and parent, reporting where the capture placed it on a mismatch. */
const treeLevelChecks = AGENT_TREE_LEVELS.map(([name, level, parent]) => [
  `${name} at level ${level} under ${parent ?? 'no parent'}`,
  (o) => { const where = placement(o, name); return where !== null && where.level === level && where.parent === parent },
  (o) => describePlacement(placement(o, name))
])

/** What each state must show, beyond the fields every state reports: [description, check, observed?]. */
const STATE_CHECKS = {
  graph: [['the Plan graph is present', (o) => o.planGraph === true], ['no Agent chat region', (o) => o.agentChatRegion === false]],
  'header-long': [
    ['the Plan graph is present', (o) => o.planGraph === true],
    ['the long breadcrumb and title truncate', (o) => o.header?.crumbTruncated === true && o.header?.titleTruncated === true]
  ],
  'agent-empty': [['no plan graph, list or scorecard', (o) => !o.planGraph && !o.planList && !o.scorecard]],
  'agent-tool': [['the tree lists Magos and the subagent Acolyte:DM-785', (o) => rowNamed(o, 'Magos') && rowNamed(o, 'Acolyte:DM-785')]],
  'agent-approval': [['a docked card heading', (o) => matches(o.cardHeading, /wants to run/)]],
  'agent-worker': [['Acolyte:DM-2 is selected', (o) => rowNamed(o, 'Acolyte:DM-2')?.selected === true]],
  'agent-legacy-thread': [
    ['the legacy parent Servitor-2 is selected beside its nested Servitor-3 and the stamped Servitor-1, each named once',
      (o) => rowNamed(o, 'Servitor-2')?.selected === true && rowNamed(o, 'Servitor-3') && rowNamed(o, 'Servitor-1')
        && new Set(o.treeRows.map((row) => row.name)).size === o.treeRows.length]
  ],
  'agent-tree': [
    ['railWidth is 280±1', (o) => near(o.railWidth, 280)],
    ['the Finished 1 group is collapsed by default', (o) => o.finishedExpandedAtStart === false],
    ...treeLevelChecks
  ],
  'rail-collapsed': [['railWidth is 40±1', (o) => near(o.railWidth, 40)]],
  'landing-notification': [
    ['railWidth is 280±1 with no Expand click', (o) => near(o.railWidth, 280)],
    ['Acolyte:DM-2 is selected', (o) => rowNamed(o, 'Acolyte:DM-2')?.selected === true]
  ],
  'landing-activity': [
    ['railWidth is 280±1 with no Expand click', (o) => near(o.railWidth, 280)],
    ['no ticket panel over the rail', (o) => o.ticketPanel === false],
    ['Acolyte:DM-1 is selected inside the opened Finished 1 group',
      (o) => rowNamed(o, 'Acolyte:DM-1')?.selected === true && placement(o, 'Acolyte:DM-1')?.parent === 'Finished 1',
      (o) => describePlacement(placement(o, 'Acolyte:DM-1'))]
  ],
  'chat-rail': [
    ['the Chat agents rail is right of the chat', (o) => o.railRightOfStage === true],
    ['Inquisitor:DM-2 is selected', (o) => rowNamed(o, 'Inquisitor:DM-2')?.selected === true]
  ],
  'chat-rail-collapsed': [
    ['no Chat agents rail', (o) => o.railWidth === null],
    ['the Agents toggle reads collapsed', (o) => o.agentsPressed === 'false']
  ],
  'chat-rail-legacy': [
    ['the Chat agents rail is right of the chat', (o) => o.railRightOfStage === true],
    ['the legacy and stamped helpers are Servitor-2 (selected) and Servitor-1, each named once',
      (o) => rowNamed(o, 'Servitor-2')?.selected === true && rowNamed(o, 'Servitor-1')
        && new Set(o.treeRows.map((row) => row.name)).size === o.treeRows.length]
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
  'agent-glass': [
    ['the stage paints the brass and crimson radial glows', (o) => matches(o.glass?.backdrop, /radial-gradient.*radial-gradient/), (o) => o.glass?.backdrop],
    ['the open rail is frosted glass', (o) => near(o.railWidth, 280) && frosted(o.glass?.rail), (o) => JSON.stringify(o.glass?.rail)],
    ['the docked approval card is frosted glass', (o) => matches(o.cardHeading, /wants to run/) && frosted(o.glass?.card),
      (o) => JSON.stringify(o.glass?.card)],
    ['the transcript sits on a near-solid surface (alpha 0.9 or more)', (o) => alphaOf(o.glass?.transcript?.background) >= 0.9,
      (o) => JSON.stringify(o.glass?.transcript)]
  ],
  'agent-magos-decided': [
    ['the record reads Asked by Acolyte:DM-442 and Denied by the Magos with its reason',
      (o) => matches(o.approvalRecord, /Asked by Acolyte:DM-442/) && matches(o.approvalRecord, /Denied by the Magos/)
        && matches(o.approvalRecord, /The Magos decided: \S/)]
  ],
  'agent-needs-you': [
    ['the header reads 3 needs you', (o) => matches(o.needsYouHeader, /^3 needs you/)],
    ['three badged rows, the unwatched planner’s among them', (o) => o.badgedRows === 3]
  ],
  'agent-composer': [
    ['two composers: the idle one with Send and no Stop, the busy one with Stop and no Send',
      (o) => Array.isArray(o.composers) && o.composers.length === 2 && composerButtons(o.composers[0]) === 'send'
        && composerButtons(o.composers[1]) === 'stop',
      (o) => JSON.stringify(o.composers?.map(composerButtons))],
    ['each composer is a frosted glass card rounded 16 px or more, at most 760 px wide',
      (o) => composersOf(o).every((card) => frosted(card) && parseFloat(card.radius) >= 16 && card.width <= 760),
      (o) => JSON.stringify(composersOf(o).map(({ radius, background, backdropFilter, width }) => ({ radius, background, backdropFilter, width })))],
    ['a round 32 px Send and a square 32 px Stop', (o) => round(composersOf(o)[0]?.send) && square(composersOf(o)[1]?.stop),
      (o) => JSON.stringify([composersOf(o)[0]?.send, composersOf(o)[1]?.stop])],
    ['both composers chip the agent, the context and 2 queued', (o) => composersOf(o).length === 2 && composersOf(o).every((card) =>
      JSON.stringify(card.chips) === JSON.stringify(['Magos · Skitarii', 'dark-mechanicus', '2 queued'])),
      (o) => JSON.stringify(composersOf(o).map((card) => card.chips))],
    ['the idle draft grew to two lines and the empty busy composer holds one', (o) => composersOf(o)[0]?.lines === 2
      && composersOf(o)[1]?.lines === 1, (o) => JSON.stringify(composersOf(o).map((card) => card.lines))],
    ['both placeholders reply to the Magos', (o) => composersOf(o).every((card) => card.placeholder === 'Reply to Magos…')]
  ],
  'agent-planners': [
    ['the tree names the Magos and nine planners apart, Lexmechanic-2 selected', (o) => rowNamed(o, 'Magos')
      && rowNamed(o, 'Lexmechanic') && rowNamed(o, 'Lexmechanic-2')?.selected === true && rowNamed(o, 'Lexmechanic-9')
      && new Set(o.treeRows.map((row) => row.name)).size === o.treeRows.length]
  ],
  'settings-notifications': [['the controls have accessible names', (o) => Array.isArray(o.settingsControls)
    && o.settingsControls.length > 0 && o.settingsControls.every((name) => typeof name === 'string' && name.trim() !== '')]],
  'delivery-editor': [
    ['the acceptance node editor shows the Sprint delivery region', (o) => o.sprintDeliveryRegion === true]
  ],
  'delivery-pending': [
    ['the run bar reads Sprint 1 delivery to main: the latest check failed',
      (o) => o.deliveryLine === 'Sprint 1 delivery to main: the latest check failed', (o) => JSON.stringify(o.deliveryLine)],
    [`the first failed check reads ${STALE_INSTALL}`, (o) => o.firstFailedCheck === STALE_INSTALL, (o) => JSON.stringify(o.firstFailedCheck)]
  ],
  'delivery-checkpoint': [
    ['the gate’s Delivery on approval note holds Sprint 3', (o) => matches(o.deliveryApproval, /^After approval, Sprint 3 claims wait /)],
    ['the Previous sprint delivery region', (o) => o.previousDelivery === true],
    [`the first failed check reads ${STALE_INSTALL}`, (o) => o.firstFailedCheck === STALE_INSTALL, (o) => JSON.stringify(o.firstFailedCheck)]
  ]
}

/** What every epic state must show, and the agent states besides: [description, applies, check]. */
const EPIC_CHECKS = [
  ['the View buttons are Agent, Graph, List, Scorecard in order', () => true,
    (o) => JSON.stringify(o.viewButtons) === JSON.stringify(VIEW_BUTTONS)],
  ['a bold Agent label', () => true, (o) => Number(o.agentFontWeight) >= 600],
  ['a one-line breadcrumb beside the View group, the heading holding its content, both names titled', () => true,
    (o) => o.header?.crumbOneLine === true && o.header.besideView === true && o.header.sameRow === true && o.header.contained === true
      && o.header.crumbTitle === o.header.crumb && o.header.titleTitle === o.header.title],
  ['an Agent chat region', (state) => AGENT_STATES.has(state), (o) => o.agentChatRegion === true],
  ['no plan graph, list or scorecard node', (state) => AGENT_STATES.has(state), (o) => !o.planGraph && !o.planList && !o.scorecard],
  ['the rail right of the stage', (state) => AGENT_STATES.has(state), (o) => o.railRightOfStage !== false]
]

function stateChecks(state) {
  const epic = EPIC_STATES.has(state) ? EPIC_CHECKS.filter(([, applies]) => applies(state)) : []
  return [...epic.map(([description, , check]) => [description, check]), ...STATE_CHECKS[state] ?? []]
}

const failure = (o) => ([description, , observed]) => observed ? `expected ${description}; got ${observed(o)}` : `expected ${description}`

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
    : stateChecks(state).filter(([, check]) => !check(record.observations)).map(failure(record.observations))
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
