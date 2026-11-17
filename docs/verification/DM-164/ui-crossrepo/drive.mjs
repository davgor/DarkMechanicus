// DM-164 c25/c27/c28 real-app evidence: the built app (out/main/index.js) launched isolated over seeded two-repository
// fixtures, driven over CDP. Each phase seeds a fresh root under %TEMP% (or reuses `--root=<dir>` already seeded).
//   node drive.mjs a   c25 (choose the checkout, aliases, missing, wrong repository/project, relocated, renamed) then
//                      c27 (preview, Create, Open the draft in dm-checkout, its own Save/Start run, source unchanged)
//   node drive.mjs b   c28 Flow 1 controls on an open checkpoint, then a request kept Pending while the checkout is
//                      missing, Withdraw's confirmation, Retry once it is back, Bring back its grades
//   node drive.mjs c   c28 on the DM-193 seed's end state: linked request, grades brought back, Before / after,
//                      Reassess now, Metrics link, the correction epic's link back
// Isolation as DM-193's screens.mjs: own userData, home, app-data and Dark Mechanicus home in the root; DM_SESSION_TOKEN,
// DM_DESKTOP_PIPE, ELECTRON_* and NODE_OPTIONS removed. The native folder dialog of "Choose another folder…" cannot be
// driven over CDP, so the launcher replaces `dialog.showOpenDialog` in main with one that answers the folder written
// to `<root>/dialog-answer.json` (logged with the dialog title to `<root>/dialog-log.jsonl`); everything after the
// dialog (screening, tracking, canonicalizing, associating) is the app's own code.
// The target and source repositories are hashed before/after each step (`snapshot`): every file under
// `.darkmechanicus/` except the machine-local `local/` (listed separately), HEAD, `git log --all` and `git status`.
// PNGs and shots.json go beside this file.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, symlinkSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..', '..')
const require = createRequire(import.meta.url)
const phase = process.argv[2]
if (!['a', 'b', 'c'].includes(phase)) throw new Error('usage: drive.mjs a|b|c [--root=<seeded root>]')
const rootArg = process.argv.find((arg) => arg.startsWith('--root='))?.slice('--root='.length)
const probe = process.argv.includes('--probe')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const shots = []
const steps = []
const sha256 = (data) => createHash('sha256').update(data).digest('hex')

function isolatedEnv(root) {
  const home = join(root, 'home')
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    DARKMECHANICUS_HOME: join(root, 'dm-home')
  }
  for (const key of Object.keys(env)) if (/^(?:DM_SESSION_TOKEN|DM_DESKTOP_PIPE|ELECTRON_.*|NODE_OPTIONS)$/iu.test(key)) delete env[key]
  return env
}

async function freePort() {
  const server = createServer()
  await new Promise((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  return port
}

async function connect(url) {
  const socket = new WebSocket(url)
  await new Promise((done, fail) => {
    socket.onopen = done
    socket.onerror = fail
  })
  const pending = new Map()
  let next = 0
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (entry === undefined) return
    pending.delete(message.id)
    if (message.error) entry.fail(new Error(JSON.stringify(message.error)))
    else entry.done(message.result)
  }
  const call = (method, params = {}) =>
    new Promise((done, fail) => {
      next += 1
      pending.set(next, { done, fail })
      socket.send(JSON.stringify({ id: next, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 600))
    return result.result.value
  }
  return { call, evaluate, close: () => socket.close() }
}

async function pageTarget(port) {
  for (let tries = 0; tries < 600; tries += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const target = targets.find((entry) => entry.type === 'page' && entry.url.includes('/renderer/index.html'))
      if (target) return target.webSocketDebuggerUrl
    } catch {
      // The endpoint is still starting.
    }
    await sleep(100)
  }
  throw new Error(`No page target on ${port}`)
}

const hooks = pathToFileURL(join(repo, 'docs', 'verification', 'DM-193', 'raw-hooks.mjs')).href
function runSeed(root, script, args) {
  const seeded = spawnSync(process.execPath, ['--import', hooks, '--import', 'tsx', script, root, ...args], { cwd: repo, env: isolatedEnv(root), encoding: 'utf8' })
  if (seeded.status !== 0) throw new Error(`Seeding failed: ${seeded.stderr}\n${seeded.stdout}`)
  return JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'))
}

/** The built app in `root`, with the folder dialog answered from `<root>/dialog-answer.json`. */
async function launch(root) {
  const port = await freePort()
  const app = join(root, 'app.cjs')
  const answerFile = join(root, 'dialog-answer.json')
  const logFile = join(root, 'dialog-log.jsonl')
  writeFileSync(
    app,
    `const electron = require('electron'); const fs = require('fs');
const answerFile = ${JSON.stringify(answerFile)}; const logFile = ${JSON.stringify(logFile)};
const fake = async (...args) => { const options = args[args.length - 1] || {}; let answer = null; try { answer = JSON.parse(fs.readFileSync(answerFile, 'utf8')) } catch {}
  fs.appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), title: options.title, answer }) + '\\n');
  return answer ? { canceled: false, filePaths: [answer] } : { canceled: true, filePaths: [] } };
try { electron.dialog.showOpenDialog = fake } catch {}
if (electron.dialog.showOpenDialog !== fake) {
  const Module = require('module'); const real = electron;
  const dialog = new Proxy({}, { get: (t, k) => (k === 'showOpenDialog' ? fake : Reflect.get(real.dialog, k)) });
  const value = (k) => (k === 'dialog' ? dialog : real[k]);
  const proxy = new Proxy({}, { get: (t, k) => value(k), has: (t, k) => k in real, ownKeys: () => Reflect.ownKeys(real), getOwnPropertyDescriptor: (t, k) => (k in real ? { configurable: true, enumerable: true, writable: false, value: value(k) } : undefined) });
  const load = Module._load; Module._load = function (request, ...rest) { return request === 'electron' ? proxy : load.call(this, request, ...rest) };
  fs.appendFileSync(logFile, JSON.stringify({ patched: 'Module._load' }) + '\\n');
} else fs.appendFileSync(logFile, JSON.stringify({ patched: 'assigned' }) + '\\n');
electron.app.setAppPath(${JSON.stringify(repo)}); electron.app.setPath('userData', ${JSON.stringify(join(root, 'userData'))}); electron.app.setPath('home', ${JSON.stringify(join(root, 'home'))});
require(${JSON.stringify(join(repo, 'out', 'main', 'index.js'))});
`
  )
  const child = spawn(require('electron'), [app, `--remote-debugging-port=${port}`], { cwd: repo, env: isolatedEnv(root), stdio: 'ignore' })
  const exited = new Promise((done) => child.once('exit', done))
  const renderer = await connect(await pageTarget(port))
  return { child, exited, renderer }
}

async function quit(app) {
  app.renderer.close()
  spawnSync('taskkill', ['/PID', String(app.child.pid), '/T'])
  const closed = await Promise.race([app.exited.then(() => true), sleep(8_000).then(() => false)])
  if (!closed) {
    spawnSync('taskkill', ['/PID', String(app.child.pid), '/T', '/F'])
    await app.exited
  }
  await sleep(1_500)
}

/** Renames with retries: a folder the app just let go of can stay locked for a moment on Windows. */
async function move(from, to) {
  for (let tries = 0; ; tries += 1) {
    try {
      renameSync(from, to)
      steps.push({ move: { from, to } })
      return
    } catch (error) {
      if (tries >= 20) throw error
      await sleep(500)
    }
  }
}

function driver(renderer, shotsDir) {
  const ev = renderer.evaluate
  const until = async (expression, label, timeout = 30_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await ev(expression)) return
      await sleep(100)
    }
    const body = await ev(`document.querySelector('main')?.innerText.slice(0, 3000) ?? ''`).catch(() => '')
    throw new Error(`Timed out waiting for ${label}\n--- main text ---\n${body}`)
  }
  const shot = async (name, note, values = {}) => {
    await sleep(500)
    const { data } = await renderer.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(shotsDir, name), Buffer.from(data, 'base64'))
    shots.push({ phase, name, note, values })
    console.log(`saved ${name}: ${note}`)
  }
  const click = (expression) => ev(`(${expression}).click()`)
  const text = (selector) => ev(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`)
  const scrollTo = async (selector) => {
    const found = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: 'start' }); return true })()`)
    if (!found) throw new Error(`Nothing to scroll to: ${selector}`)
    await sleep(250)
  }
  const size = (width, height) => renderer.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
  const json = async (expression) => JSON.parse(await ev(`(async () => JSON.stringify(await (${expression})))()`))
  /** Scrolls the `dt` labelled `label` inside `scope` to the middle of the view. */
  const scrollToField = async (scope, label) => {
    const found = await ev(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(`${scope} dt`)})].find((dt) => dt.textContent.trim() === ${JSON.stringify(label)}); if (!el) return false; el.scrollIntoView({ block: 'center' }); return true })()`)
    if (!found) throw new Error(`No field ${label} in ${scope}`)
    await sleep(250)
  }
  return { ev, until, shot, click, text, scrollTo, scrollToField, size, json, renderer }
}

const button = (scope, text) =>
  `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))`
const tabNamed = (scope, text) =>
  `[...document.querySelectorAll(${JSON.stringify(`${scope} [role=tab]`)})].find((t) => t.textContent.trim() === ${JSON.stringify(text)})`

function expect(label, screen, expected) {
  for (const value of expected) if (!screen.includes(value)) throw new Error(`${label}: the screen does not show ${JSON.stringify(value)}:\n${screen.slice(0, 2500)}`)
  return expected
}

// ---------- repository snapshots ----------

function walk(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else out.push(relative(base, full).replaceAll('\\', '/'))
  }
  return out.sort()
}

function fileHash(file) {
  try {
    return sha256(readFileSync(file))
  } catch (error) {
    return `unreadable:${error.code}`
  }
}

/** What a repository holds: its `.darkmechanicus/` records (not `local/`), HEAD, every commit and its working-tree status. */
function snapshot(dir) {
  const dmDir = join(dir, '.darkmechanicus')
  const files = walk(dmDir)
  const records = files.filter((file) => !file.startsWith('local/')).map((file) => `${file} ${fileHash(join(dmDir, file))}`)
  const local = files.filter((file) => file.startsWith('local/')).map((file) => ({ file, size: statSync(join(dmDir, file)).size, sha256: fileHash(join(dmDir, file)) }))
  const git = (...args) => spawnSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8' }).stdout.trim()
  const log = git('log', '--all', '--format=%H %P %s')
  const status = git('status', '--porcelain=v1', '--untracked-files=all')
  return {
    dir,
    recordFiles: records.length,
    recordsSha256: sha256(records.join('\n')),
    head: git('rev-parse', 'HEAD'),
    branch: git('rev-parse', '--abbrev-ref', 'HEAD'),
    commits: log === '' ? 0 : log.split('\n').length,
    logSha256: sha256(log),
    statusSha256: sha256(status),
    statusLines: status === '' ? 0 : status.split('\n').length,
    local
  }
}

/** Fails unless `after` holds the same records, HEAD, history and status as `before`; returns both for shots.json. */
function unchanged(label, before, after) {
  const keys = ['recordsSha256', 'recordFiles', 'head', 'branch', 'commits', 'logSha256', 'statusSha256']
  const differs = keys.filter((key) => before[key] !== after[key])
  const localChanged = JSON.stringify(before.local) !== JSON.stringify(after.local)
  const entry = { label, equal: differs.length === 0, differs, localChanged, before: { ...before, local: before.local.length }, after: { ...after, local: after.local.length } }
  steps.push({ snapshot: entry, beforeLocal: before.local, afterLocal: after.local })
  if (differs.length > 0) {
    console.error(`FINDING ${label}: ${differs.join(', ')} changed`)
  }
  return { equal: entry.equal, differs, localChanged, records: `${after.recordFiles} files ${after.recordsSha256.slice(0, 16)}`, head: after.head.slice(0, 12), commits: after.commits, status: `${after.statusLines} lines ${after.statusSha256.slice(0, 16)}` }
}

// ---------- navigation ----------

async function openFolder(d, name) {
  await d.until(`${button('nav', name)} !== undefined`, `folder ${name} in the sidebar`)
  await d.click(button('nav', name))
  await d.until(`${tabNamed('main', 'Epics')} !== undefined`, 'folder page')
}

async function openEpic(d, folderName, title) {
  await openFolder(d, folderName)
  await d.click(tabNamed('main', 'Epics'))
  await d.until(`${button('main', title)} !== undefined || ${button('main', 'Completed')} !== undefined`, 'epic list')
  if (await d.ev(`${button('main', title)} === undefined`)) await d.click(button('main', 'Completed'))
  await d.until(`${button('main', title)} !== undefined`, `epic ${title}`)
  await d.click(button('main', title))
  await d.until(`document.querySelector('[aria-label="Epic workspace"]') !== null && document.querySelector('[role=group][aria-label=View]') !== null`, 'epic workspace')
}

const BAR = `[...document.querySelectorAll('.ew-bar-actions button')]`
const PANEL = 'section.cp-xr'
const PANEL_SETTLED = `(() => { const el = document.querySelector(${JSON.stringify(PANEL)}); if (!el) return false; const t = el.innerText; return !t.includes('Reading what it would write') && !t.includes('Reading the chosen checkout') && ![...el.querySelectorAll('button')].some((b) => b.disabled && /…$/.test(b.textContent.trim())) })()`

/** The Sprint 1 report's Improvement tab, from the run bar's report button. */
async function openImprovement(d) {
  // An epic with an open draft opens on the draft (no run bar): its "View saved" leads back to the run.
  await d.until(`${BAR}.some((b) => /^(Sprint report|Epic report)$/.test(b.textContent.trim())) || ${button('main', 'View saved')} !== undefined`, 'run bar report button or View saved')
  if (await d.ev(`${button('main', 'View saved')} !== undefined`)) await d.click(button('main', 'View saved'))
  await d.until(`${BAR}.some((b) => /^(Sprint report|Epic report)$/.test(b.textContent.trim()))`, 'run bar report button')
  await d.click(`${BAR}.find((b) => /^(Sprint report|Epic report)$/.test(b.textContent.trim()))`)
  const withImprovement = `[...document.querySelectorAll('article.cp-report')].filter((a) => [...a.querySelectorAll('[role=tab]')].some((t) => t.textContent.trim() === 'Improvement'))`
  const dump = `JSON.stringify([...document.querySelectorAll('article.cp-report')].map((a) => ({ label: a.getAttribute('aria-label'), tabs: [...a.querySelectorAll('[role=tab]')].map((t) => t.textContent.trim()) })))`
  try {
    await d.until(`${withImprovement}.length > 0`, 'a report article with an Improvement tab', 15_000)
  } catch (error) {
    throw new Error(`${error.message}\narticles: ${await d.ev(dump)}`)
  }
  const label = await d.ev(`(${withImprovement}.find((a) => a.getAttribute('aria-label').includes('Sprint 1')) ?? ${withImprovement}[0]).getAttribute('aria-label')`)
  const article = `article.cp-report[aria-label="${label}"]`
  await d.click(tabNamed(article, 'Improvement'))
  await d.until(`document.querySelector(${JSON.stringify(`${article} [role=group][aria-label=Improvement]`)}) !== null`, 'Improvement tab')
  return article
}

async function openPanel(d, f, epicTitle = 'Checkout flow') {
  await openEpic(d, f.project.name, epicTitle)
  const article = await openImprovement(d)
  await d.until(`document.querySelector(${JSON.stringify(PANEL)}) !== null`, 'Dark Mechanicus source panel')
  await d.until(PANEL_SETTLED, 'panel settled')
  await d.scrollTo(PANEL)
  return article
}

const radioFor = (path) =>
  `[...document.querySelectorAll('${PANEL} [role=radiogroup] label')].find((l) => l.querySelector('.field-hint')?.textContent.trim() === ${JSON.stringify(path)})?.querySelector('input')`
const OUTCOME = `${PANEL} section[aria-label="What the last request did"]`

async function checkAgain(d) {
  await d.click(button(PANEL, 'Check again'))
  await sleep(300)
  await d.until(PANEL_SETTLED, 'panel settled after Check again')
}

const checkoutRead = (d) => d.json('window.dm.sourceCheckout.get()')
const foldersRead = (d) => d.json('window.dm.listFolders()')
const sourceCheckoutFile = (f) => JSON.parse(readFileSync(join(f.userData, 'source-checkout.json'), 'utf8'))

async function session(root, width = 1600, height = 1000) {
  const app = await launch(root)
  const d = driver(app.renderer, here)
  await d.size(width, height)
  return { app, d }
}

async function dumpProbe(d) {
  console.log(
    await d.ev(
      `JSON.stringify({ bar: ${BAR}.map((b) => b.textContent.trim()), buttons: [...document.querySelectorAll('main button')].map((b) => b.textContent.trim()).slice(0, 80), text: document.querySelector('main')?.innerText.slice(0, 4000) })`
    )
  )
}

/** What the source epic shows of itself (as spaceCorrections.test's `sourceFacts`): epic, run, sealed scorecard, saved plan. */
async function sourceFacts(d, f) {
  const cmd = (name, input) => d.json(`window.dm.command(${JSON.stringify(f.project.path)}, ${JSON.stringify(name)}, ${JSON.stringify(input)})`)
  return {
    epic: await cmd('getEpic', { epicId: f.project.epicId }),
    run: await cmd('getRun', { runId: f.project.runId }),
    card: await cmd('getReportScorecard', { reportId: f.project.reportId }),
    saved: await cmd('getPlan', { epicId: f.project.epicId, view: 'saved' })
  }
}

// ---------- phase a: c25 then c27 ----------

async function phaseA(root, f) {
  const dmPath = f.dm.path
  const real = () => snapshot(dmPath)
  const T0 = real()
  const S0 = snapshot(f.project.path)
  let { app, d } = await session(root)
  try {
    await openPanel(d, f)
    if (probe) return dumpProbe(d)
    const before = await checkoutRead(d)
    const folders0 = await foldersRead(d)
    let screen = await d.text(PANEL)
    await d.shot('c25-01-not-chosen.png', 'Improvement tab of Sprint 1 (shop): the Dark Mechanicus source panel before any checkout is chosen (Not chosen; tracked folders offered)', {
      shows: expect('not chosen', screen, ['Not chosen', 'Choose another folder…', dmPath]),
      sourceCheckoutGet: before.status,
      trackedFolders: folders0.map((folder) => folder.path)
    })

    // 1. Choose the real clone among the tracked folders.
    await d.click(radioFor(dmPath))
    await d.until(`document.querySelector(${JSON.stringify(OUTCOME)})?.innerText.includes('Chosen:') === true`, 'chosen outcome')
    await d.until(PANEL_SETTLED, 'panel settled')
    await d.until(`document.querySelector(${JSON.stringify(PANEL)}).innerText.includes('Available')`, 'Available')
    screen = await d.text(PANEL)
    let read = await checkoutRead(d)
    if (read.status !== 'available' || read.local.path !== dmPath || read.target.projectId !== f.dm.projectId) throw new Error(`unexpected association ${JSON.stringify(read)}`)
    await d.scrollTo(PANEL)
    await d.shot('c25-02-chosen-available.png', `The real clone ${dmPath} chosen through the tracked-folder radio: Available, project ${f.dm.projectName} (${f.dm.projectId})`, {
      shows: expect('chosen', screen, [`Chosen: ${f.dm.projectName} at ${dmPath}`, 'Available', f.dm.projectId, dmPath]),
      sourceCheckoutGet: { status: read.status, path: read.local.path, projectId: read.target.projectId },
      sourceCheckoutJson: sourceCheckoutFile(f).checkout,
      target: unchanged('c25 choose: target', T0, real())
    })
    await d.size(1024, 768)
    await d.scrollTo(PANEL)
    await d.shot('c25-02n-chosen-available-narrow.png', 'Same state at the narrow width (1024x768)')
    await d.size(1600, 1000)

    // 2. Aliases through "Choose another folder…" (the dialog answered with the alias path).
    const junction = join(root, 'dm-alias-junction')
    symlinkSync(dmPath, junction, 'junction')
    const aliases = [
      ['junction', junction, 'a directory junction leading to the clone'],
      ['case', dmPath.replace(/dm-checkout$/u, 'DM-CHECKOUT').replace(/^([a-z]):/u, (drive) => drive.toUpperCase()), 'the same path in another letter case'],
      ['dotdot', [f.project.path, '..', 'dm-checkout'].join(sep), "a '..' detour through shop"]
    ]
    for (const [name, alias, what] of aliases) {
      const T = real()
      writeFileSync(join(root, 'dialog-answer.json'), JSON.stringify(alias))
      await d.click(button(PANEL, 'Dismiss')).catch(() => undefined)
      await d.until(`document.querySelector(${JSON.stringify(OUTCOME)}) === null`, 'outcome dismissed', 5_000).catch(() => undefined)
      await d.click(button(PANEL, 'Choose another folder…'))
      await d.until(`document.querySelector(${JSON.stringify(OUTCOME)}) !== null`, `outcome for ${name}`)
      await d.until(PANEL_SETTLED, 'panel settled')
      screen = await d.text(PANEL)
      read = await checkoutRead(d)
      const folders = await foldersRead(d)
      const file = sourceCheckoutFile(f).checkout
      if (read.local.path !== dmPath || file.local.path !== dmPath || folders.length !== folders0.length) {
        console.error(`FINDING alias ${name}: ${JSON.stringify({ read: read.local, file: file.local, folders: folders.map((x) => x.path) })}`)
      }
      await d.scrollTo(PANEL)
      await d.shot(`c25-03-alias-${name}.png`, `"Choose another folder…" answered with ${what} (${alias}): the outcome names the one canonical checkout ${dmPath}; nothing added to the folder list`, {
        dialogAnswer: alias,
        shows: expect(`alias ${name}`, screen, [`Chosen: ${f.dm.projectName} at ${dmPath}`, 'Available']),
        addedNote: screen.includes('also added to your folder list'),
        sourceCheckoutGet: { status: read.status, path: read.local.path, projectId: read.target.projectId },
        sourceCheckoutJsonPath: file.local.path,
        trackedFolders: { before: folders0.length, after: folders.length },
        target: unchanged(`c25 alias ${name}: target`, T, real())
      })
    }
    rmSync(junction, { recursive: false, force: true })

    // 3. Wrong project, another Git repository: the source folder itself (shop) offered as a radio.
    {
      const T = real()
      const shop0 = snapshot(f.project.path)
      await d.click(button(PANEL, 'Dismiss')).catch(() => undefined)
      await d.click(radioFor(f.project.path))
      await d.until(`document.querySelector(${JSON.stringify(OUTCOME)})?.innerText.includes('Not usable') === true`, 'refusal for shop')
      await d.until(PANEL_SETTLED, 'panel settled')
      screen = await d.text(PANEL)
      read = await checkoutRead(d)
      await d.scrollTo(PANEL)
      await d.shot('c25-04-wrong-repo-shop.png', `Choosing ${f.project.path} (another Git repository: the shop project) is refused (not_dm_source); the association stays on the clone`, {
        shows: expect('wrong repo', screen, ['Not usable as the Dark Mechanicus checkout', 'is not a checkout of the Dark Mechanicus source']),
        sourceCheckoutGet: { status: read.status, path: read.local.path, projectId: read.target.projectId },
        target: unchanged('c25 wrong repo: target', T, real()),
        shop: unchanged('c25 wrong repo: shop', shop0, snapshot(f.project.path))
      })
    }
    await quit(app)

    // 4..7. States only a changed folder produces: the app is closed while the folders change, then opened again.
    const moved = `${dmPath}.moved`
    const states = [
      {
        name: 'missing',
        file: 'c25-05-missing.png',
        note: `The clone moved away (${dmPath} -> ${moved}) after the association: Unavailable, missing, with its recovery`,
        expectText: ['Unavailable', 'No folder exists at', 'choose it at its new place'],
        realAt: moved,
        arrange: async () => move(dmPath, moved),
        restore: async () => move(moved, dmPath)
      },
      {
        name: 'project_mismatch',
        file: 'c25-06-wrong-project.png',
        note: `Another clone whose project.json names a different project (${f.other.projectName}, ${f.other.projectId}) now sits at ${dmPath}: Unavailable, project_mismatch`,
        expectText: ['Unavailable', `now holds project ${f.other.projectId}`, f.dm.projectId],
        realAt: `${dmPath}.real`,
        arrange: async () => {
          await move(dmPath, `${dmPath}.real`)
          await move(f.other.path, dmPath)
        },
        restore: async () => {
          await move(dmPath, f.other.path)
          await move(`${dmPath}.real`, dmPath)
        }
      },
      {
        name: 'relocated',
        file: 'c25-07-relocated.png',
        note: `${dmPath} replaced by a junction leading to the other clone: Unavailable, relocated`,
        expectText: ['Unavailable', 'a link or junction on the way changed'],
        realAt: `${dmPath}.real`,
        arrange: async () => {
          await move(dmPath, `${dmPath}.real`)
          symlinkSync(f.other.path, dmPath, 'junction')
        },
        restore: async () => {
          rmSync(dmPath, { recursive: false, force: true })
          await move(`${dmPath}.real`, dmPath)
        }
      },
      {
        name: 'renamed',
        file: 'c25-08-renamed.png',
        note: `The clone renamed in letter case only (dm-checkout -> DM-Checkout): Unavailable, renamed`,
        expectText: ['Unavailable', 'only the letter case changed'],
        realAt: join(dirname(dmPath), 'DM-Checkout'),
        arrange: async () => {
          await move(dmPath, `${dmPath}.tmp`)
          await move(`${dmPath}.tmp`, join(dirname(dmPath), 'DM-Checkout'))
        },
        restore: async () => {
          await move(join(dirname(dmPath), 'DM-Checkout'), `${dmPath}.tmp`)
          await move(`${dmPath}.tmp`, dmPath)
        }
      }
    ]
    for (const state of states) {
      const T = real()
      await state.arrange()
      ;({ app, d } = await session(root))
      await openPanel(d, f)
      screen = await d.text(PANEL)
      read = await checkoutRead(d)
      await d.shot(state.file, state.note, {
        shows: expect(state.name, screen, state.expectText),
        sourceCheckoutGet: { status: read.status, problem: read.problem, path: read.local?.path, projectId: read.target?.projectId },
        target: unchanged(`c25 ${state.name}: target (at ${state.realAt})`, T, snapshot(state.realAt))
      })
      if (read.problem !== state.name) console.error(`FINDING ${state.name}: problem read ${read.problem}`)
      await quit(app)
      await state.restore()
    }

    // 8. Back where it was: Available again, the target exactly as at the start of c25.
    ;({ app, d } = await session(root))
    await openPanel(d, f)
    screen = await d.text(PANEL)
    read = await checkoutRead(d)
    await d.shot('c25-09-restored-available.png', `The clone back at ${dmPath}: Available again; the target holds exactly what it held before c25`, {
      shows: expect('restored', screen, ['Available', f.dm.projectId]),
      sourceCheckoutGet: { status: read.status, path: read.local.path },
      targetSinceSeed: unchanged('c25 whole: target since the seed', T0, real()),
      sourceSinceSeed: unchanged('c25 whole: shop since the seed', S0, snapshot(f.project.path))
    })

    // ---------- c27 ----------
    const T1 = real()
    const S1 = snapshot(f.project.path)
    const sourceEpic0 = await sourceFacts(d, f)
    await d.until(`${button(PANEL, 'Create the epic in')} !== undefined`, 'Create button')
    screen = await d.text(PANEL)
    await d.scrollTo(`${PANEL} [role=group][aria-label="Where it stands"]`)
    await d.shot('c27-01-preview.png', `Preview of the Dark Mechanicus correction for experiment ${f.project.experiments.dm}: Ready, the new epic owned by ${f.dm.projectName}, its tickets, plan check, who asked and the request key; nothing written`, {
      shows: expect('preview', screen, ['Ready', 'New epic', `owned by ${f.dm.projectName}`, 'Asked by', 'Request key', f.project.experiments.dm]),
      planCheck: screen.match(/Plan check\s*\n?(.*)/u)?.[1] ?? null,
      target: unchanged('c27 preview: target', T1, real())
    })
    await d.click(button(PANEL, 'Create the epic in'))
    await d.until(`document.querySelector(${JSON.stringify(OUTCOME)})?.innerText.includes('Created in the Dark Mechanicus source') === true`, 'created outcome', 60_000)
    await d.until(PANEL_SETTLED, 'panel settled')
    screen = await d.text(PANEL)
    const links = await d.json(`window.dm.crossRepoCorrections.list(${JSON.stringify(f.project.path)}, {})`).catch((error) => ({ error: String(error) }))
    await d.scrollTo(PANEL)
    await d.shot('c27-02-created.png', 'After Create: "Created in the Dark Mechanicus source and linked here"; state Created; Open the new epic', {
      shows: expect('created', screen, ['Created in the Dark Mechanicus source and linked here', 'Created', 'Open "']),
      links,
      source: unchanged('c27 create: shop records', S1, snapshot(f.project.path))
    })
    const openLabel = await d.ev(`${button(PANEL, 'Open "')}.textContent.trim()`)
    await d.click(button(PANEL, 'Open "'))
    await d.until(`document.querySelector('[aria-label="Epic workspace"]') !== null && ${button('main', 'Save rev')} !== undefined`, 'the correction draft in dm-checkout')
    await sleep(800)
    const ws = await d.text('[aria-label="Epic workspace"]')
    const active = await d.ev(`[...document.querySelectorAll('nav button')].find((b) => b.getAttribute('aria-current') === 'page' || b.classList.contains('active'))?.textContent.trim() ?? null`)
    await d.shot('c27-03-draft-in-target.png', `"${openLabel}" opened the correction epic's draft in the dm-checkout folder: its own header (DRAFT, Save rev 1, Discard draft), link back to the asking epic`, {
      shows: expect('draft', ws, ['DRAFT REV 1', 'Save rev 1', 'Discard draft', 'EDITING DRAFT']),
      header: ws.slice(0, 600),
      sidebarActive: active
    })
    await d.size(1024, 768)
    await d.shot('c27-03n-draft-in-target-narrow.png', 'Same draft at the narrow width (1024x768)')
    await d.size(1600, 1000)
    // Save it there (the person's own step in that project), then its own Start run.
    const saveDisabled = await d.ev(`${button('main', 'Save rev')}.disabled`)
    let saved = false
    if (!saveDisabled) {
      await d.click(button('main', 'Save rev'))
      saved = await d
        .until(`${button('main', 'Start run')} !== undefined`, 'Start run after Save', 30_000)
        .then(() => true)
        .catch(() => false)
    }
    const ws2 = await d.text('[aria-label="Epic workspace"]')
    await d.shot('c27-04-saved-start-run.png', saved ? 'The correction epic saved in dm-checkout (REV 1 · SAVED): its own Start run, Edit draft and Transfer controls' : 'Save in dm-checkout was not possible as shown (see values)', {
      saveDisabled,
      saved,
      shows: saved ? expect('saved', ws2, ['REV 1 · SAVED', 'Start run']) : [],
      header: ws2.slice(0, 900)
    })
    if (saved) {
      await d.click(button('main', 'Start run'))
      await d.until(`[...document.querySelectorAll('[role=dialog]')].some((x) => x.innerText.includes('Start run'))`, 'Start run dialog')
      const dialog = await d.ev(`[...document.querySelectorAll('[role=dialog]')].find((x) => x.innerText.includes('Start run')).innerText`)
      await d.shot('c27-05-start-run-dialog.png', "The correction epic's own Start run dialog (dm-checkout); cancelled, no run started", { dialog: dialog.slice(0, 800) })
      await d.click(`[...document.querySelectorAll('[role=dialog] button')].find((b) => b.textContent.trim() === 'Cancel')`)
      await d.until(`![...document.querySelectorAll('[role=dialog]')].some((x) => x.innerText.includes('Start run'))`, 'dialog closed')
    }
    // The source epic: its own run, untouched.
    await openEpic(d, f.project.name, 'Checkout flow')
    await d.until(`document.querySelector('[aria-label="Epic workspace"]') !== null`, 'source epic')
    await sleep(800)
    const runBar = await d.text('[aria-label="Epic workspace"]')
    const sourceEpic1 = await sourceFacts(d, f)
    await d.shot('c27-06-source-run-unchanged.png', "Back in shop: the source epic's own run bar, unchanged by the correction in dm-checkout", {
      runBar,
      sourceFactsEqual: JSON.stringify(sourceEpic0) === JSON.stringify(sourceEpic1),
      sourceFacts: { epicStatus: sourceEpic1.epic?.data?.status, runState: sourceEpic1.run?.data?.state, scorecardSha256: sha256(JSON.stringify(sourceEpic1.card ?? null)).slice(0, 16) },
      source: unchanged('c27 whole: shop records and history', S1, snapshot(f.project.path)),
      sourceSinceSeed: unchanged('c27 whole: shop since the seed', S0, snapshot(f.project.path)),
      target: { before: { records: T1.recordFiles, sha: T1.recordsSha256.slice(0, 16), commits: T1.commits }, after: (() => { const t = real(); return { records: t.recordFiles, sha: t.recordsSha256.slice(0, 16), commits: t.commits, head: t.head.slice(0, 12) } })() }
    })
    steps.push({ sourceFacts: { before: sourceEpic0, after: sourceEpic1 } })
  } finally {
    await quit(app).catch(() => undefined)
  }
}

// ---------- phase b: c28 Flow 1 + Pending / Withdraw / Retry ----------

async function phaseB(root, f) {
  const dmPath = f.dm.path
  const moved = `${dmPath}.moved`
  let { app, d } = await session(root)
  try {
    await openEpic(d, f.project.name, 'Checkout flow')
    const article = await openImprovement(d)
    if (probe) return dumpProbe(d)
    const planner = 'section.cp-planner'
    await d.until(`document.querySelector('${planner}') !== null`, 'corrective planner')
    const tick = `document.querySelector('input[aria-label="Select ${f.project.experiments.local} for corrective work"]')`
    await d.until(`${tick} !== null`, 'experiment tick box')
    await d.click(tick)
    await sleep(400)
    await d.scrollTo(planner)
    let screen = await d.text(planner)
    await d.shot('c28-01-flow1-planner.png', `Flow 1 on the open Sprint 1 checkpoint: experiment ${f.project.experiments.local} ticked; destination, where the work goes, Fireguard ticket, Preview`, {
      shows: expect('planner', screen, ['Destination', 'Where the work goes', 'Preview corrective work']),
      fireguardChecked: await d.ev(`[...document.querySelectorAll('${planner} input[type=checkbox]')].find((i) => i.closest('label')?.innerText.includes('Fireguard'))?.checked ?? null`)
    })
    await d.click(button(planner, 'Preview corrective work'))
    await d.until(`document.querySelector('${planner} section[aria-label="Preview of the corrective work"]') !== null`, 'preview')
    await d.scrollTo(`${planner} section[aria-label="Preview of the corrective work"]`)
    screen = await d.text(planner)
    await d.shot('c28-02-flow1-preview.png', 'Flow 1 preview: tickets, criteria, destination, validation; Create draft work and Preview again', {
      shows: expect('preview', screen, ['Create draft work', 'Preview again'])
    })
    await d.click(button(planner, 'Create draft work'))
    await d.until(`document.querySelector('${planner} section[aria-label="Corrective work created"]') !== null`, 'created')
    await d.scrollTo(`${planner} section[aria-label="Corrective work created"]`)
    screen = await d.text(planner)
    await d.shot('c28-03-flow1-created.png', 'Flow 1 created: Draft work created, next steps, Open the draft to review and Save; the gate (Approve retro & redraft) stays the person\'s', {
      shows: expect('created', screen, ['Draft work created', 'Open the draft to review and Save', 'Approve retro & redraft'])
    })

    // Flow 2: choose, then lose the checkout and request anyway.
    await d.until(`document.querySelector(${JSON.stringify(PANEL)}) !== null`, 'panel')
    await d.until(PANEL_SETTLED, 'panel settled')
    await d.click(radioFor(dmPath))
    await d.until(`document.querySelector(${JSON.stringify(OUTCOME)})?.innerText.includes('Chosen:') === true`, 'chosen')
    await quit(app)
    const T0 = snapshot(dmPath)
    await move(dmPath, moved)
    ;({ app, d } = await session(root))
    await openEpic(d, f.project.name, 'Checkout flow')
    await openImprovement(d)
    await d.until(PANEL_SETTLED, 'panel settled')
    await d.scrollTo(PANEL)
    await d.until(`${button(PANEL, 'Save the request (pending)')} !== undefined`, 'Save the request (pending)')
    await d.shot('c28-04-unavailable-ready.png', 'Checkout missing: Unavailable with its recovery; the main button keeps the request pending ("Save the request (pending)")', {
      shows: expect('unavailable', await d.text(PANEL), ['Unavailable', 'No folder exists at', 'Save the request (pending)'])
    })
    await d.click(button(PANEL, 'Save the request (pending)'))
    await d.until(`document.querySelector(${JSON.stringify(OUTCOME)})?.innerText.includes('pending request') === true`, 'pending outcome', 60_000)
    await d.until(PANEL_SETTLED, 'panel settled')
    await d.scrollTo(PANEL)
    screen = await d.text(PANEL)
    await d.shot('c28-05-pending.png', 'Pending: "Kept here as a pending request; the Dark Mechanicus source was not written"; Retry the request and Withdraw the request offered', {
      shows: expect('pending', screen, ['Kept here as a pending request', 'Pending', 'Retry the request', 'Withdraw the request']),
      target: unchanged('c28 pending: target (moved away)', T0, snapshot(moved))
    })
    await d.click(button(PANEL, 'Dismiss')).catch(() => undefined)
    await d.click(button(PANEL, 'Withdraw the request'))
    const confirm = await d
      .until(`${button(PANEL, 'Withdraw anyway')} !== undefined`, 'Withdraw anyway', 30_000)
      .then(() => true)
      .catch(() => false)
    await d.scrollTo(PANEL)
    screen = await d.text(PANEL)
    await d.shot('c28-06-withdraw-anyway.png', 'Withdraw while the target cannot be checked asks for confirmation ("Withdraw anyway, without checking the target"); not pressed', {
      confirmOffered: confirm,
      shows: confirm ? expect('withdraw anyway', screen, ['Withdraw anyway, without checking the target']) : [],
      outcome: await d.text(OUTCOME)
    })
    await d.click(button(OUTCOME, 'Dismiss')).catch(() => undefined)
    await quit(app)
    await move(moved, dmPath)
    ;({ app, d } = await session(root))
    await openEpic(d, f.project.name, 'Checkout flow')
    await openImprovement(d)
    await d.until(PANEL_SETTLED, 'panel settled')
    await d.until(`${button(PANEL, 'Retry the request')} !== undefined`, 'Retry the request')
    await d.click(button(PANEL, 'Retry the request'))
    await d.until(`document.querySelector(${JSON.stringify(OUTCOME)})?.innerText.includes('Created in the Dark Mechanicus source') === true`, 'retried', 60_000)
    await d.until(PANEL_SETTLED, 'panel settled')
    await d.scrollTo(PANEL)
    screen = await d.text(PANEL)
    await d.shot('c28-07-retried-linked.png', 'Checkout back: Retry the request created the epic there and linked it; Created, Open and Bring back its grades', {
      shows: expect('retried', screen, ['Created in the Dark Mechanicus source and linked here', 'Created', 'Open "', 'Bring back its grades'])
    })
    await d.click(button(OUTCOME, 'Dismiss')).catch(() => undefined)
    await d.click(button(PANEL, 'Bring back its grades'))
    await d.until(`document.querySelector(${JSON.stringify(PANEL)}).innerText.includes('Its grades')`, 'its grades', 30_000)
    await d.until(PANEL_SETTLED, 'panel settled')
    await d.scrollTo(PANEL)
    screen = await d.text(PANEL)
    await d.shot('c28-08-grades-none-yet.png', 'Bring back its grades before the correction epic has run: no frozen grade yet', {
      shows: expect('grades', screen, ['Its grades', 'No frozen'])
    })
  } finally {
    await quit(app).catch(() => undefined)
  }
}

// ---------- phase c: DM-193 end state ----------

async function phaseC(root, f) {
  let { app, d } = await session(root)
  try {
    await openEpic(d, f.project.name, 'Checkout flow')
    let article = await openImprovement(d)
    if (probe) return dumpProbe(d)
    await d.until(`document.querySelector(${JSON.stringify(PANEL)}) !== null`, 'panel')
    await d.until(PANEL_SETTLED, 'panel settled')
    await d.scrollTo(PANEL)
    let screen = await d.text(PANEL)
    const experimentId = (await d.ev(`document.querySelector(${JSON.stringify(PANEL)}).getAttribute('aria-label')`)).replace('Dark Mechanicus source: ', '')
    await d.shot('c28-09-endstate-linked.png', "DM-193 end state: the dm experiment's correction Created and linked; Open, Bring back its grades, Check again", {
      experimentId,
      shows: expect('linked', screen, ['Created', 'Bring back its grades', 'Check again', 'Open "']),
      beforeAfterShown: screen.includes('Before / after')
    })
    await d.click(button(PANEL, 'Bring back its grades'))
    await d.until(`document.querySelector(${JSON.stringify(PANEL)}).innerText.includes('cite {')`, 'grades with cite', 30_000)
    await d.until(PANEL_SETTLED, 'panel settled')
    await d.scrollToField(PANEL, 'Its grades')
    screen = await d.text(PANEL)
    const cites = [...screen.matchAll(/cite \{ reportId: (\S+), assessmentId: (\S+) \}/gu)].map((match) => ({ reportId: match[1], assessmentId: match[2] }))
    await d.shot('c28-10-endstate-grades.png', 'Bring back its grades: the correction epic\'s frozen grades, each to cite by { reportId, assessmentId }; no Before / after until an agent records a result', {
      shows: expect('grades', screen, ['Its grades', 'cite { reportId:']),
      cites,
      beforeAfterShown: screen.includes('Before / after')
    })
    // The agent's step (runbook Flow 2, step 5): record the result citing the last grade brought back, app closed.
    await quit(app)
    const cite = cites.at(-1) ?? (() => { throw new Error('no grade to cite') })()
    const recorded = spawnSync(process.execPath, ['--import', hooks, '--import', 'tsx', join(here, 'record-result.ts'), root, experimentId, cite.reportId, cite.assessmentId, 'tokens'], { cwd: repo, env: isolatedEnv(root), encoding: 'utf8' })
    steps.push({ recordResult: { status: recorded.status, stdout: recorded.stdout, stderr: recorded.stderr.slice(0, 2000) } })
    if (recorded.status !== 0) throw new Error(`record-result failed: ${recorded.stdout}\n${recorded.stderr}`)
    ;({ app, d } = await session(root))
    await openEpic(d, f.project.name, 'Checkout flow')
    article = await openImprovement(d)
    await d.until(`document.querySelector(${JSON.stringify(PANEL)})?.innerText.includes('Before / after') === true`, 'Before / after', 30_000)
    await d.until(PANEL_SETTLED, 'panel settled')
    await d.scrollToField(PANEL, 'Before / after')
    screen = await d.text(PANEL)
    await d.shot('c28-11-endstate-before-after.png', `After the orchestrator recorded the result (record_experiment_event citing ${cite.reportId} / ${cite.assessmentId}): Before / after against the source baseline, Open the correction epic`, {
      shows: expect('before/after', screen, ['Before / after', 'Before:', 'After:', 'Open the correction epic']),
      recordResult: recorded.stdout.trim().split('\n').at(-1)
    })
    await d.click(tabNamed(article, 'Scorecard'))
    await d.until(`${button(article, 'Reassess')} !== undefined`, 'Reassess now', 30_000)
    await d.scrollTo(article)
    await d.shot('c28-12-endstate-reassess-now.png', "Sprint 1 report's Scorecard tab: the frozen scorecard and Reassess now; Metrics link in the sidebar footer", {
      button: await d.ev(`${button(article, 'Reassess')}.textContent.trim()`),
      metricsLink: await d.ev(`[...document.querySelectorAll('button.footer-link')].some((b) => b.textContent.trim() === 'Metrics')`)
    })
    await d.click(tabNamed(article, 'Improvement'))
    await d.until(`document.querySelector(${JSON.stringify(PANEL)})?.innerText.includes('Open the correction epic') === true`, 'panel again')
    await d.click(`[...document.querySelectorAll('${PANEL} button.sc-link')].find((b) => b.textContent.trim() === 'Open the correction epic')`)
    await d.until(`document.querySelector('[aria-label="Epic workspace"]')?.innerText.startsWith('dm-checkout') === true`, 'correction epic in dm-checkout')
    await sleep(800)
    const ws = await d.text('[aria-label="Epic workspace"]')
    await d.shot('c28-13-correction-epic-links-back.png', 'The correction epic in dm-checkout (completed, its own run): its header links back to the epic that asked for it', {
      shows: expect('links back', ws, ['dm-checkout', 'Corrective work from shop']),
      header: ws.slice(0, 900)
    })
  } finally {
    await quit(app).catch(() => undefined)
  }
}

// ---------- main ----------

const root = rootArg ?? mkdtempSync(join(tmpdir(), `dm164-xr-${phase}-`))
const seeded = existsSync(join(root, 'fixture.json'))
const f = seeded
  ? JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'))
  : phase === 'c'
    ? runSeed(root, join(repo, 'docs', 'verification', 'DM-193', 'seed.ts'), [])
    : runSeed(root, join(here, 'seed.ts'), [phase === 'a' ? 'completed' : 'report1'])
console.log(`root ${root}`)
let failure = null
try {
  if (phase === 'a') await phaseA(root, f)
  else if (phase === 'b') await phaseB(root, f)
  else await phaseC(root, f)
} catch (error) {
  failure = String(error?.stack ?? error)
  console.error(failure)
  process.exitCode = 1
}
if (!probe) {
  const file = join(here, 'shots.json')
  const all = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { phases: {} }
  const launched = Object.fromEntries(['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html'].map((name) => [name, sha256(readFileSync(join(repo, name)))]))
  all.phases[phase] = { root, buildCommit: f.buildCommit, launched, fixture: { project: f.project, dm: f.dm, other: f.other }, failure, shots, dialogLog: existsSync(join(root, 'dialog-log.jsonl')) ? readFileSync(join(root, 'dialog-log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [] }
  writeFileSync(file, `${JSON.stringify(all, null, 2)}\n`)
  writeFileSync(join(here, `steps-${phase}.json`), `${JSON.stringify({ root, steps }, null, 2)}\n`)
}
