/**
 * Packaged-build proof for the project utility's sync lane (DM-963): a reconcile runs on the utility's worker thread,
 * on its own connection, while the utility keeps serving the screen.
 *
 *   node scripts/sync-lane-probe.mjs <packaged DarkMechanicus executable> <new evidence .jsonl> [tickets] [temp parent]
 *
 * Seeds a disposable project (default 10,000 tickets in 10 completed epics, as the Forge performance fixture) under a
 * new temporary directory, tracks it in a private profile, and launches the packaged app with that profile, a private
 * home and Dark Mechanicus home, so the person's own profile and projects are never opened. Over CDP it then times the
 * renderer's own plan view, ticket panel and Kanban board loads, and a card creation, idle and while an explicit
 * reconcile imports a changed epic state, and writes one JSONL row per view and condition plus a verdict.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const [exe, output, ticketsArg = '10000', parent = tmpdir()] = process.argv.slice(2)
assert(exe !== undefined && existsSync(exe), 'Pass the packaged DarkMechanicus executable.')
assert(output !== undefined && !existsSync(output), 'Pass the path of a new JSONL evidence file; evidence is never overwritten.')
const tickets = Number(ticketsArg)
assert(Number.isInteger(tickets) && tickets >= 1 && tickets <= 10_000, 'Tickets must be an integer from 1 through 10,000.')
const ITERATIONS = 30
const VIEWS = ['plan', 'ticket', 'kanban', 'mutation']
const BUDGET_MS = 300

const root = realpathSync.native(mkdtempSync(join(parent, 'dm-sync-lane-probe-')))
const home = join(root, 'home'), userData = join(root, 'userData'), dmHome = join(root, 'dm-home'), project = join(root, 'project')
for (const path of [home, userData, dmHome]) mkdirSync(path, { recursive: true })
mkdirSync(dirname(resolve(output)), { recursive: true })
const report = (kind, row) => appendFileSync(output, `${JSON.stringify({ kind, ...row })}\n`)

const SEED = `
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { attachmentRefOf, claimAttachments, createStagedAttachment } from './src/core/services/attachments'
import { createKanbanCard } from './src/core/services/kanban/cards'
import { createFolderRegistry } from './src/main/desktop/folderRegistry'
import { makeBundle, tid } from './src/test/bundles'
import { pngBytes } from './src/test/images'
import { createRepoEnv, flush, initProject, saveRevision } from './src/test/repoEnv'
import { idOf, insertAttempt, insertComment, insertOutbox, insertRun, T0 } from './src/test/repoFixtures'
import { createTestCtx } from './src/test/testContext'

const { project, tickets, userData, home, dmHome } = JSON.parse(process.argv[2])
const flushed = (outcome) => { if (outcome.failed !== 0) throw new Error(JSON.stringify(outcome.errors)) }

function seedEpic(env, ctx, epic) {
  const first = epic * 1000
  const numbers = Array.from({ length: Math.min(tickets - first, 1000) }, (_, index) => first + index + 1)
  const epicId = idOf('epic', epic + 1), runId = idOf('run', epic + 1)
  const firstRevision = idOf('revision', epic * 2 + 1), revisionId = idOf('revision', epic * 2 + 2)
  const bundle = makeBundle([numbers])
  flushed(saveRevision(env, { epicId, revisionId: firstRevision, number: 1, bundle }))
  bundle.rationale = 'Synthetic second revision'
  flushed(saveRevision(env, { epicId, revisionId, number: 2, baseRevisionId: firstRevision, bundle }))
  env.db.run("UPDATE epics SET title = ?, status = 'completed', completed_at = ? WHERE id = ?", 'Probe epic ' + (epic + 1), T0, epicId)
  env.db.run("UPDATE ticket_status SET status = 'completed' WHERE epic_id = ?", epicId)
  insertOutbox(env.db, { kind: 'epic_state', epicId })
  insertRun(env.db, { id: runId, epicId, revisionId, state: 'completed' })
  for (const number of numbers.slice(0, 16)) insertAttempt(env.db, { id: idOf('attempt', number), runId, ticketId: tid(number), revisionId })
  const owner = { kind: 'attempt', id: idOf('attempt', first + 1) }
  const image = createStagedAttachment(ctx, { bytes: Buffer.concat([pngBytes(40, 30, epic), Buffer.alloc(128 * 1024, epic)]), label: 'Probe image', purpose: 'evidence' })
  const refs = claimAttachments(ctx, [image.id], owner).map(attachmentRefOf)
  env.db.run('UPDATE attempts SET evidence_json = ? WHERE id = ?', JSON.stringify({ checks: [], criteria: [], attachments: refs }), owner.id)
  insertOutbox(env.db, { kind: 'run_history', epicId, runId })
  for (let index = 0; index < 32; index += 1) {
    const commentId = idOf('comment', epic * 32 + index + 1)
    insertComment(env.db, { id: commentId, epicId, body: 'Probe comment in completed history' })
    insertOutbox(env.db, { kind: 'comment', epicId, entityId: commentId })
  }
  flushed(flush(env))
}

mkdirSync(project)
execFileSync('git', ['-C', project, 'init', '-q', '-b', 'main'])
const env = createRepoEnv({ root: project })
initProject(env)
const ctx = createTestCtx({ db: env.db, clock: env.clock })
for (let index = 0; index < 13; index += 1) createKanbanCard(ctx, { title: 'Probe card ' + (index + 1) })
const epics = Math.ceil(tickets / 1000)
for (let epic = 0; epic < epics; epic += 1) seedEpic(env, ctx, epic)
let bytes = 0
for (const [path, content] of env.fs.files()) {
  const name = relative(env.layout.dmDir, path)
  if (isAbsolute(name) || name.startsWith('..') || name.split(sep)[0] === 'local') continue
  const data = env.fs.getBytes(path) ?? Buffer.from(content)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
  bytes += data.byteLength
}
env.db.close()
createFolderRegistry({ file: join(userData, 'folders.json'), homeDir: home, dmHome }).track(project)
process.stdout.write(JSON.stringify({ epics, bytes, epicId: idOf('epic', 1), ticketId: tid(1) }))
`

const RENDERER = `
import { loadWorkspace } from './src/renderer/src/epic/workspaceLoad'
import { loadHistory } from './src/renderer/src/ticket/ticketData'

const dm = Reflect.get(window, 'dm')
const runnerFor = (folder) => async (name, input) => {
  const reply = await dm.command(folder, name, input)
  if (!reply.ok) throw new Error(name + ': ' + reply.error?.code + ' ' + reply.error?.message)
  return reply.data
}
// The epic workspace (useWorkspaceLoad), the ticket panel with its History tab, the Kanban board and its sidebar count.
const loads = {
  plan: ({ folder, epicId }) => loadWorkspace(runnerFor(folder), epicId),
  ticket: ({ folder, epicId, ticketId }) => {
    const run = runnerFor(folder)
    return Promise.all([run('getTicket', { epicId, ticketId, view: 'saved' }), loadHistory(run, epicId)])
  },
  kanban: ({ folder }) => {
    const run = runnerFor(folder)
    return Promise.all([run('listKanbanCards', { doneLimit: 20 }), run('getKanbanOpenCount', undefined)])
  },
  mutation: ({ folder, index, condition }) => runnerFor(folder)('createKanbanCard', { title: 'Probe write ' + condition + ' ' + index })
}

async function timed(request) {
  const start = performance.now()
  await loads[request.view](request)
  const end = performance.now()
  return { ms: end - start, end }
}

async function sample(request) {
  if (request.condition === 'idle') return { ms: (await timed(request)).ms }
  const started = performance.now()
  let syncEnd = Number.POSITIVE_INFINITY
  const synced = dm.command(request.folder, 'reconcileRepository', undefined).then((reply) => { syncEnd = performance.now(); return reply })
  // The request is admitted on the owner's queue before any later command; give the lane a moment to start reading.
  await new Promise((resolve) => setTimeout(resolve, 25))
  const load = await timed(request)
  const reply = await synced
  return {
    ms: load.ms, syncMs: syncEnd - started, during: load.end < syncEnd, ok: reply.ok,
    imported: reply.ok ? reply.data.imported.includes(request.epicId) : false, error: reply.ok ? null : reply.error
  }
}

Object.assign(window, { dmSyncLaneProbe: { sample } })
`

function bundle(contents, platform) {
  const built = buildSync({
    stdin: { contents, resolveDir: repo, loader: 'ts' }, bundle: true, write: false, platform,
    format: platform === 'node' ? 'cjs' : 'iife', target: platform === 'node' ? 'node24' : 'chrome140', loader: { '.md': 'text' }, logLevel: 'warning'
  })
  return built.outputFiles[0].text
}

function seed() {
  const file = join(root, 'seed.cjs')
  writeFileSync(file, bundle(SEED, 'node'))
  const seeded = spawnSync(process.execPath, [file, JSON.stringify({ project, tickets, userData, home, dmHome })], { encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  assert.equal(seeded.status, 0, seeded.stderr)
  return JSON.parse(seeded.stdout)
}

/** Bumps the first epic's tracked state, as a pull of another machine's change would: the next reconcile imports it. */
function stageChange(epicId) {
  const target = join(project, '.darkmechanicus', 'epics', epicId, 'state.json')
  const record = JSON.parse(readFileSync(target, 'utf8'))
  writeFileSync(`${target}.probe.tmp`, JSON.stringify({ ...record, generation: record.generation + 1, updatedAt: '2026-01-02T00:00:00.000Z' }))
  renameSync(`${target}.probe.tmp`, target)
}

async function freePort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  return port
}

function isolatedEnv() {
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PI_CODING_AGENT_DIR: join(home, '.omp', 'agent'), CLAUDE_CONFIG_DIR: join(home, '.claude'), CODEX_HOME: join(home, '.codex'),
    DARKMECHANICUS_HOME: dmHome, DISABLE_AUTO_UPDATE: '1'
  }
  for (const key of Object.keys(env)) if (/^(?:DM_SESSION_TOKEN|DM_DESKTOP_PIPE|DM_BROWSER_PIPE|ELECTRON_.*|NODE_OPTIONS)$/iu.test(key)) delete env[key]
  return env
}

async function until(probe, what, limitMs) {
  const deadline = Date.now() + limitMs
  for (;;) {
    const value = await probe().catch(() => undefined)
    if (value !== undefined && value !== null && value !== false) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise((done) => setTimeout(done, 100))
  }
}

async function attach(port) {
  const target = await until(async () => {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    return targets.find((entry) => entry.type === 'page' && entry.url.includes('/renderer/index.html'))
  }, 'the packaged renderer', 60_000)
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((opened, failed) => { socket.onopen = opened; socket.onerror = failed })
  const pending = new Map()
  let next = 0
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (!entry) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
    else entry.resolve(message.result)
  }
  const send = (method, params) => new Promise((resolved, rejected) => {
    const id = ++next
    pending.set(id, { resolve: resolved, reject: rejected })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result.value
  }
  return { evaluate, close: () => socket.close() }
}

function launch(port) {
  const log = join(root, 'app.log')
  const child = spawn(exe, [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { env: isolatedEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false })
  child.stdout.on('data', (chunk) => appendFileSync(log, chunk))
  child.stderr.on('data', (chunk) => appendFileSync(log, chunk))
  const exited = new Promise((done) => child.once('exit', (code) => done(code)))
  return { child, exited, log }
}

async function quit(app, page) {
  if (app.child.exitCode !== null) return app.child.exitCode
  await page?.evaluate('window.close()').catch(() => undefined)
  page?.close()
  const code = await Promise.race([app.exited, new Promise((done) => setTimeout(() => done('timeout'), 20_000))])
  if (code !== 'timeout') return code
  spawnSync('taskkill.exe', ['/PID', String(app.child.pid), '/T', '/F'], { windowsHide: true })
  return 'killed'
}

function stats(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const at = (quantile) => Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1)])
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), max: Math.round(sorted.at(-1)) }
}

async function measureRow(page, fixture, view, condition) {
  const samples = []
  for (let index = 0; index < ITERATIONS; index += 1) {
    if (condition === 'sync') stageChange(fixture.epicId)
    const request = { folder: project, epicId: fixture.epicId, ticketId: fixture.ticketId, view, condition, index }
    samples.push(await page.evaluate(`dmSyncLaneProbe.sample(${JSON.stringify(request)})`))
  }
  const synced = samples.filter((sample) => sample.syncMs !== undefined)
  const row = {
    tickets, view, condition, ...stats(samples.map((sample) => sample.ms)),
    ...(condition === 'sync' ? {
      sync: stats(synced.map((sample) => sample.syncMs)), finishedDuringSync: synced.filter((sample) => sample.during).length,
      syncsOk: synced.filter((sample) => sample.ok).length, importedChangedEpic: synced.filter((sample) => sample.imported).length,
      errors: synced.filter((sample) => !sample.ok).map((sample) => sample.error)
    } : {})
  }
  report('view', row)
  return row
}

async function measure(page, fixture) {
  const rows = []
  for (const view of VIEWS) {
    for (const condition of ['idle', 'sync']) rows.push(await measureRow(page, fixture, view, condition))
  }
  return rows
}

function identity(appInfo) {
  const asar = join(dirname(exe), 'resources', 'app.asar')
  const head = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim()
  return { exe: resolve(exe), asarSha256: createHash('sha256').update(readFileSync(asar)).digest('hex'), head, platform: process.platform, arch: process.arch, ...appInfo }
}

function verdict(rows) {
  const during = rows.filter((row) => row.condition === 'sync')
  const go = during.every((row) => row.syncsOk === row.n && row.errors.length === 0) && during.some((row) => row.finishedDuringSync > 0)
  const views = during.filter((row) => row.view !== 'mutation')
  return {
    go, rule: 'GO when every explicit reconcile in the packaged build succeeds and loads finish while one is still running',
    withinBudget: views.every((row) => row.p95 < BUDGET_MS), budgetMs: BUDGET_MS,
    p95: Object.fromEntries(during.map((row) => [row.view, row.p95])), finishedDuringSync: Object.fromEntries(during.map((row) => [row.view, `${row.finishedDuringSync}/${row.n}`]))
  }
}

let app, page
try {
  const fixture = seed()
  report('fixture', { tickets, epics: fixture.epics, bytes: fixture.bytes })
  const port = await freePort()
  app = launch(port)
  page = await attach(port)
  await until(() => page.evaluate('typeof window.dm === "object"'), 'the preload bridge', 60_000)
  const coldStart = Date.now()
  // The first command opens the owner; its open-time reconcile imports the cold project on the lane.
  await until(async () => {
    const reply = await page.evaluate(`window.dm.command(${JSON.stringify(project)}, 'listEpics', undefined)`)
    return reply.ok && reply.data.length === fixture.epics
  }, 'the cold import', 600_000)
  report('identity', identity({ userAgent: await page.evaluate('navigator.userAgent'), coldImportMs: Date.now() - coldStart }))
  await page.evaluate(bundle(RENDERER, 'browser'))
  report('verdict', verdict(await measure(page, fixture)))
} finally {
  const code = app === undefined ? null : await quit(app, page)
  report('exit', { code, logTail: app !== undefined && existsSync(app.log) ? readFileSync(app.log, 'utf8').slice(-4000) : '' })
  if (process.env.DM_PROBE_KEEP !== '1') rmSync(root, { recursive: true, force: true, maxRetries: 5 })
}
