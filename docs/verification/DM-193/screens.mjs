// DM-193 c1/c4: real-app screenshots of the SPACE loop over the two-repository fixture. Seeds a fresh root with
// `seed.ts` (a real clone of this repository as the Dark Mechanicus checkout), launches the app isolated (its own
// userData, home and app-data folders; DM_SESSION_TOKEN, DM_DESKTOP_PIPE, ELECTRON_* and NODE_OPTIONS removed), drives
// it over CDP and captures the ticket, epic and sprint-report Scorecard tabs and the Metrics dashboard. Each screen's
// grade is read from the page and compared with the MCP read the seed recorded (`fixture.json`); a mismatch fails.
//   node docs/verification/DM-193/screens.mjs              the built app (`npm run build` first: out/main/index.js)
//   node docs/verification/DM-193/screens.mjs --packaged   release/win-unpacked/DarkMechanicus.exe (`npm run package:win`)
// PNGs and shots.json go to docs/verification/DM-193/screens/ (built) or screens-packaged/ (packaged).
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..')
const require = createRequire(import.meta.url)
const packaged = process.argv.includes('--packaged')
const out = join(here, packaged ? 'screens-packaged' : 'screens')
mkdirSync(out, { recursive: true })
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const shots = []

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
    const result = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    })
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

function seed(root) {
  const hooks = pathToFileURL(join(here, 'raw-hooks.mjs')).href
  const seeded = spawnSync(process.execPath, ['--import', hooks, '--import', 'tsx', join(here, 'seed.ts'), root], {
    cwd: repo,
    env: isolatedEnv(root),
    encoding: 'utf8'
  })
  if (seeded.status !== 0) throw new Error(`Seeding failed: ${seeded.stderr}`)
  return JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'))
}

/** The unpacked app electron-builder leaves beside the installer (`release/win-unpacked`, see package.json `build`). */
const packagedExe = () => join(repo, 'release', 'win-unpacked', 'DarkMechanicus.exe')

async function launch(root) {
  const port = await freePort()
  let child
  if (packaged) {
    // The packaged executable keeps its own app path; userData and home are moved into the root by switch and env.
    child = spawn(packagedExe(), [`--user-data-dir=${join(root, 'userData')}`, `--remote-debugging-port=${port}`], {
      cwd: root,
      env: isolatedEnv(root),
      stdio: 'ignore'
    })
  } else {
    const app = join(root, 'app.cjs')
    writeFileSync(
      app,
      `const {app}=require('electron');app.setAppPath(${JSON.stringify(repo)});app.setPath('userData',${JSON.stringify(join(root, 'userData'))});app.setPath('home',${JSON.stringify(join(root, 'home'))});require(${JSON.stringify(join(repo, 'out', 'main', 'index.js'))});`
    )
    child = spawn(require('electron'), [app, `--remote-debugging-port=${port}`], { cwd: repo, env: isolatedEnv(root), stdio: 'ignore' })
  }
  return { child, renderer: await connect(await pageTarget(port)) }
}

function driver(renderer) {
  const ev = renderer.evaluate
  const until = async (expression, label, timeout = 30_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await ev(expression)) return
      await sleep(100)
    }
    throw new Error(`Timed out waiting for ${label}`)
  }
  const shot = async (name, note, values = {}) => {
    await sleep(400)
    const { data } = await renderer.call('Page.captureScreenshot', {
      format: 'png'
    })
    writeFileSync(join(out, name), Buffer.from(data, 'base64'))
    shots.push({ name, note, values })
    console.log(`saved ${name}: ${note}`)
  }
  const click = (expression) => ev(`(${expression}).click()`)
  const text = (selector) => ev(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`)
  /** Scrolls whichever container holds `selector` so it sits at the top; fails when it is not on the page. */
  const scrollTo = async (selector) => {
    const found = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: 'start' }); return true })()`)
    if (!found) throw new Error(`Nothing to scroll to: ${selector}`)
    await sleep(250)
  }
  const size = (width, height) =>
    renderer.call('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false
    })
  return { ev, until, shot, click, text, scrollTo, size }
}

const button = (scope, text) =>
  `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent.trim().startsWith(${JSON.stringify(text)}))`
const tabNamed = (scope, text) =>
  `[...document.querySelectorAll(${JSON.stringify(`${scope} [role=tab]`)})].find((t) => t.textContent.trim() === ${JSON.stringify(text)})`

/** Fails unless `screen` shows `expected` (a letter and status or score the MCP read returned). */
function same(label, screen, expected) {
  for (const value of expected)
    if (!screen.includes(value)) throw new Error(`${label}: the screen does not show the MCP value ${JSON.stringify(value)}:\n${screen.slice(0, 1500)}`)
  return expected
}

async function openFolder(d, name) {
  await d.click(button('nav', name))
  await d.until(`${tabNamed('main', 'Epics')} !== undefined`, 'folder page')
}

async function openEpic(d, f) {
  await openFolder(d, f.project.name)
  await d.click(tabNamed('main', 'Epics'))
  await d.until(`${button('main', 'Checkout flow')} !== undefined || ${button('main', 'Completed')} !== undefined`, 'epic list')
  if (await d.ev(`${button('main', 'Checkout flow')} === undefined`)) await d.click(button('main', 'Completed'))
  await d.until(`${button('main', 'Checkout flow')} !== undefined`, 'epic Checkout flow')
  await d.click(button('main', 'Checkout flow'))
  await d.until(
    `document.querySelector('[aria-label="Epic workspace"]') !== null && document.querySelector('[role=group][aria-label=View]') !== null`,
    'epic workspace'
  )
}

async function run(root) {
  const f = seed(root)
  const { child, renderer } = await launch(root)
  try {
    const d = driver(renderer)
    await d.size(1600, 1000)
    await d.until(`${button('nav', f.project.name)} !== undefined`, 'tracked folders in the sidebar')
    if (process.argv.includes('--probe')) {
      await openEpic(d, f)
      console.log(
        await d.ev(
          `JSON.stringify({ view: [...document.querySelectorAll('[role=group][aria-label=View] button')].map((b) => b.textContent.trim()), articles: [...document.querySelectorAll('article')].map((a) => a.getAttribute('aria-label')) })`
        )
      )
      return f
    }
    await screens(d, f)
    return f
  } finally {
    renderer.close()
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
  }
}

/** The letter and score an MCP grade read returned, as the screens print them. */
const shown = (grade) => [grade.letter, grade.displayScore].filter((value) => typeof value === 'string')

const LOADED = (scope) =>
  `document.querySelector(${JSON.stringify(`${scope} .sc-headline`)}) !== null && document.querySelector(${JSON.stringify(`${scope} .sc-loading`)}) === null`

/** 1. The epic Scorecard of the completed epic. */
async function epicScreens(d, f) {
  await openEpic(d, f)
  await d.click(`[...document.querySelectorAll('[role=group][aria-label=View] button')].find((b) => b.textContent.trim() === 'Scorecard')`)
  await d.until(LOADED('.es'), 'epic scorecard')
  await d.shot('01-epic-scorecard.png', 'Epic tab: the Scorecard of the completed epic Checkout flow (shop), grade equal to get_epic_grade', {
    mcp: same('epic', await d.text('.es .sc-headline'), shown(f.reads.epic.data.grade))
  })
  await d.scrollTo('.es-list')
  await d.shot('02-epic-scorecard-outcomes.png', 'Epic tab: ticket outcomes and runs below the headline')
}

/** 2. The sprint report Scorecard of Sprint 1 (frozen with the report) in the completed epic's overview. */
async function reportScreen(d, reads) {
  await d.click(`[...document.querySelectorAll('[role=group][aria-label=View] button')].find((b) => b.textContent.trim() === 'Graph')`)
  await d.until(`document.querySelector('.ew-bar-actions button') !== null`, 'run bar report button')
  await d.click(`[...document.querySelectorAll('.ew-bar-actions button')].at(-1)`)
  await d.until(`document.querySelector('[aria-label="Epic overview"] article') !== null`, 'epic overview')
  const sprint1 = await d.ev(`document.querySelector('[aria-label="Epic overview"] article').getAttribute('aria-label')`)
  const article = `article[aria-label="${sprint1}"]`
  await d.click(tabNamed(article, 'Scorecard'))
  await d.until(LOADED(article), 'sprint 1 report scorecard')
  await d.scrollTo(article)
  await d.shot(
    '03-sprint-report-scorecard.png',
    `Sprint report tab: ${sprint1} Scorecard, the snapshot frozen with report revision 1, equal to get_report_scorecard and get_sprint_grade`,
    {
      mcp: same('report', await d.text(`${article} .sc-headline`), shown(reads.report1.data.scorecard.snapshot.sprint.result))
    }
  )
}

/** 3. The ticket Scorecard tab of each Sprint 1 ticket (the page ticket carries the rejected attempt). */
async function ticketScreens(d, reads) {
  await d.click(`[...document.querySelectorAll('.ew-bar-actions button')].at(-1)`)
  await d.until(`document.querySelector('[aria-label="Plan graph"]') !== null`, 'plan graph')
  const keys = {
    node: 'SHOP-1',
    api: 'SHOP-2',
    page: 'SHOP-3',
    docs: 'SHOP-4'
  }
  for (const [name, key] of Object.entries(keys)) {
    await d.click(
      `[...document.querySelectorAll('[aria-label="Plan graph"] [aria-label]')].find((n) => n.getAttribute('aria-label').startsWith(${JSON.stringify(`${key} ·`)}))`
    )
    await d.until(`${tabNamed('aside.tp', 'Scorecard')} !== undefined`, `ticket panel ${key}`)
    await d.click(tabNamed('aside.tp', 'Scorecard'))
    await d.until(`${LOADED('aside.tp')} && document.querySelector('aside.tp')?.innerText.includes(${JSON.stringify(key)})`, `ticket scorecard ${key}`)
    await d.shot(`04-ticket-scorecard-${name}.png`, `Ticket tab: ${key} (${name}) Scorecard, grade equal to get_ticket_grade`, {
      mcp: same(`ticket ${key}`, await d.text('aside.tp .sc-headline'), shown(reads[`ticket:${name}`].data.grade))
    })
  }
}

/** 4. The Metrics dashboard of the project. */
async function metricsScreens(d, f) {
  const reads = f.reads
  await d.click(`[...document.querySelectorAll('button.footer-link')].find((b) => b.textContent.trim() === 'Metrics')`)
  await d.until(
    `document.querySelector('section.metrics') !== null && !document.querySelector('section.metrics').innerText.includes('Loading')`,
    'metrics dashboard'
  )
  const metrics = await d.text('section.metrics')
  const trend = reads.metrics.data.trend.filter((entry) => entry.epicId === f.project.epicId).flatMap((entry) => shown(entry.grade))
  await d.shot('05-metrics-dashboard.png', 'Metrics dashboard of shop: summary, per-epic grade and the three-sprint trend, equal to get_metrics_summary', {
    mcp: same('metrics', metrics, [...shown(reads.metrics.data.epics[0].grade), ...trend])
  })
  await d.scrollTo('section.metrics [aria-label="Sprint trend"]')
  await d.shot('06-metrics-dashboard-trend.png', 'Metrics dashboard: the grade trend across the three sprint reports (B final, A provisional +11.8, A final 0.0)')
  await d.scrollTo('section.metrics [aria-label="Measurement capabilities"]')
  await d.shot('07-metrics-measurement-capabilities.png', 'Metrics dashboard: Measurement capabilities, the hosts whose usage cannot be read labelled Not readable (c4)', {
    labels: same('capabilities', await d.text('section.metrics [aria-label="Measurement capabilities"]'), ['Codex', 'Not readable', 'Custom agents', 'Read from the host'])
  })
}

async function screens(d, f) {
  await epicScreens(d, f)
  await reportScreen(d, f.reads)
  await ticketScreens(d, f.reads)
  await metricsScreens(d, f)
}

const root = mkdtempSync(join(tmpdir(), packaged ? 'dm193-pkg-' : 'dm193-app-'))
if (packaged && !existsSync(packagedExe())) throw new Error(`No packaged app at ${packagedExe()}: run npm run package:win`)
const fixture = await run(root)
/** What was launched, by content: the packaged app's asar, or the built main and renderer bundles. */
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const launched = packaged
  ? {
      'release/win-unpacked/resources/app.asar': sha256(join(repo, 'release', 'win-unpacked', 'resources', 'app.asar')),
      'release/win-unpacked/DarkMechanicus.exe': sha256(packagedExe())
    }
  : Object.fromEntries(['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html'].map((file) => [file, sha256(join(repo, file))]))
writeFileSync(join(out, 'shots.json'), `${JSON.stringify({ buildCommit: fixture.buildCommit, packaged, launched, root, shots }, null, 2)}\n`)
writeFileSync(join(out, 'mcp-reads.json'), `${JSON.stringify({ project: fixture.project, dm: fixture.dm, reads: fixture.reads }, null, 2)}\n`)
console.log(`root ${root}`)
