// DM-164 sprint acceptance, real-app evidence for c13, c14, c15, c16, c19 and c23. For each seed variant (`seed.ts`) it
// seeds a fresh root under %TEMP%, launches the BUILT app (out/main/index.js under the shared Electron) isolated (its
// own userData, home and app-data folders; DM_SESSION_TOKEN, DM_DESKTOP_PIPE, ELECTRON_* and NODE_OPTIONS removed),
// drives it over CDP, captures viewport PNGs at 1600x1000 (normal) and 1024x768 (narrow) and checks each screen's text
// against the MCP reads the seed recorded (fixture.json), in-app `dm:command` reads, and, after the app is closed, the
// MCP reads of `after.ts` (after.json). Every check is recorded in shots.json, pass or fail; nothing is skipped silently.
//   node docs/verification/DM-164/ui-scorecards/screens.mjs [--only=loop,regress,report1,failed]
// Never builds: run `npm run build` first. PNGs and shots.json go beside this script.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..', '..', '..', '..')
const hooks = pathToFileURL(join(repo, 'docs', 'verification', 'DM-193', 'raw-hooks.mjs')).href
const require = createRequire(import.meta.url)
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const NORMAL = [1600, 1000]
const NARROW = [1024, 768]
const only = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length).split(',') ?? ['loop', 'regress', 'report1', 'failed']

const shots = []
const sessions = []
/** Per criterion: every check made (pass or fail) and the error that stopped it, if any. */
const results = {}
const crit = (id) => (results[id] ??= { checks: [], errors: [] })
function check(id, label, ok, detail) {
  crit(id).checks.push({ label, ok: Boolean(ok), detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${id} ${label}${ok ? '' : `: ${JSON.stringify(detail).slice(0, 600)}`}`)
  return Boolean(ok)
}
/** Where two JSON values differ: up to 20 `path: mcp -> now` entries. */
function diffPaths(a, b, path = '', out = []) {
  if (out.length >= 20) return out
  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[key], b[key], `${path}.${key}`, out)
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`)
  return out
}
const missing = (text, values) => values.filter((value) => !text.includes(value))
const n = (value) => (typeof value === 'number' ? value.toLocaleString('en-US') : String(value))
const shown = (grade) => [grade?.letter, grade?.displayScore].filter((value) => typeof value === 'string')
const summary = (grade) => (grade === null || grade === undefined ? 'not graded' : grade.letter === null ? grade.status : `${grade.letter} ${grade.displayScore ?? '—'} (${grade.status})`)
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')

function save() {
  const launched = Object.fromEntries(['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html'].map((file) => [file, sha256(join(repo, file))]))
  const commit = spawnSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim()
  const summaryOf = Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { passed: r.checks.filter((c) => c.ok).length, failed: r.checks.filter((c) => !c.ok).length, errors: r.errors }]))
  writeFileSync(join(here, 'shots.json'), `${JSON.stringify({ commit, launched, summary: summaryOf, sessions, shots, results }, null, 2)}\n`)
}

function isolatedEnv(root) {
  const home = join(root, 'home')
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'), DARKMECHANICUS_HOME: join(root, 'dm-home') }
  for (const key of Object.keys(env)) if (/^(?:DM_SESSION_TOKEN|DM_DESKTOP_PIPE|ELECTRON_.*|NODE_OPTIONS)$/iu.test(key)) delete env[key]
  return env
}

function tsx(script, args, root) {
  const ran = spawnSync(process.execPath, ['--import', hooks, '--import', 'tsx', join(here, script), ...args], { cwd: repo, env: isolatedEnv(root), encoding: 'utf8', timeout: 600_000 })
  if (ran.status !== 0) throw new Error(`${script} failed (${ran.status}): ${ran.stderr}\n${ran.stdout}`)
  return ran.stdout
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

async function launch(root) {
  const port = await freePort()
  const app = join(root, 'app.cjs')
  writeFileSync(
    app,
    `const {app}=require('electron');app.setAppPath(${JSON.stringify(repo)});app.setPath('userData',${JSON.stringify(join(root, 'userData'))});app.setPath('home',${JSON.stringify(join(root, 'home'))});require(${JSON.stringify(join(repo, 'out', 'main', 'index.js'))});`
  )
  const child = spawn(require('electron'), [app, `--remote-debugging-port=${port}`], { cwd: repo, env: isolatedEnv(root), stdio: 'ignore' })
  return { child, renderer: await connect(await pageTarget(port)) }
}

function driver(renderer, session) {
  const ev = renderer.evaluate
  let current = NORMAL
  const until = async (expression, label, timeout = 30_000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (await ev(expression)) return
      await sleep(100)
    }
    throw new Error(`Timed out waiting for ${label}`)
  }
  const size = async ([width, height]) => {
    current = [width, height]
    await renderer.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await sleep(500)
  }
  const shot = async (id, name, note, values = {}) => {
    await sleep(400)
    const { data } = await renderer.call('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(here, name), Buffer.from(data, 'base64'))
    shots.push({ criterion: id, name, viewport: `${current[0]}x${current[1]}`, session: session.variant, root: session.root, note, values })
    console.log(`saved ${name}`)
  }
  const click = async (expression, label = expression) => {
    const found = await ev(`(() => { const el = (${expression}); if (!el) return false; el.click(); return true })()`)
    if (!found) throw new Error(`Nothing to click: ${label}`)
    await sleep(300)
  }
  const text = (selector) => ev(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`)
  const scrollTo = async (selector) => {
    const found = await ev(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.scrollIntoView({ block: 'start' }); return true })()`)
    if (!found) throw new Error(`Nothing to scroll to: ${selector}`)
    await sleep(300)
  }
  /** Sets a React-controlled input or textarea the way typing does. */
  const type = async (expression, value) => {
    const done = await ev(
      `(() => { const el = (${expression}); if (!el) return false; el.focus(); const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true })()`
    )
    if (!done) throw new Error(`Nothing to type into: ${expression}`)
    await sleep(200)
  }
  /** The app's own `dm:command` channel (the preload's window.dm), as the screens read it. */
  const command = (folder, name, input) => ev(`window.dm.command(${JSON.stringify(folder)}, ${JSON.stringify(name)}, ${JSON.stringify(input)})`)
  return { ev, until, size, shot, click, text, scrollTo, type, command }
}

const button = (scope, label) =>
  `[...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((b) => b.textContent.trim().startsWith(${JSON.stringify(label)}))`
const tabNamed = (scope, label) => `[...document.querySelectorAll(${JSON.stringify(`${scope} [role=tab]`)})].find((t) => t.textContent.trim() === ${JSON.stringify(label)})`
const viewButton = (label) => `[...document.querySelectorAll('[role=group][aria-label=View] button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})`
const graphNode = (key) => `[...document.querySelectorAll('[aria-label="Plan graph"] [aria-label]')].find((n) => n.getAttribute('aria-label').startsWith(${JSON.stringify(`${key} ·`)}))`
const LOADED = (scope) => `document.querySelector(${JSON.stringify(`${scope} .sc-headline`)}) !== null && document.querySelector(${JSON.stringify(`${scope} .sc-loading`)}) === null`

async function openEpic(d, f) {
  const title = f.project.epicTitle
  await d.click(button('nav', f.project.name), `folder ${f.project.name}`)
  await d.until(`${tabNamed('main', 'Epics')} !== undefined`, 'folder page')
  await d.click(tabNamed('main', 'Epics'), 'Epics tab')
  await d.until(`${button('main', title)} !== undefined || ${button('main', 'Completed')} !== undefined`, 'epic list')
  if (await d.ev(`${button('main', title)} === undefined`)) await d.click(button('main', 'Completed'), 'Completed')
  await d.until(`${button('main', title)} !== undefined`, `epic ${title}`)
  await d.click(button('main', title), title)
  await d.until(`document.querySelector('[aria-label="Epic workspace"]') !== null && document.querySelector('[role=group][aria-label=View]') !== null`, 'epic workspace')
}

/** The run bar's report toggle (Sprint report / Epic report / Open graph). */
const REPORT_TOGGLE = `[...document.querySelectorAll('[aria-label="Run"] .ew-bar-actions button')].at(-1)`

async function ticketScorecard(d, key) {
  await d.until(`${graphNode(key)} !== undefined`, `graph node ${key}`)
  await d.click(graphNode(key), `node ${key}`)
  await d.until(`${tabNamed('aside.tp', 'Scorecard')} !== undefined`, `ticket panel ${key}`)
  await d.click(tabNamed('aside.tp', 'Scorecard'), 'ticket Scorecard tab')
  await d.until(`${LOADED('aside.tp')} && document.querySelector('aside.tp')?.innerText.includes(${JSON.stringify(key)})`, `ticket scorecard ${key}`)
}

// ---------------------------------------------------------------------------------------------------------------
// c13: the ticket Scorecard tab of a complete, a partial and a rejected/retried ticket, normal and narrow

async function c13(d, f) {
  const id = 'c13'
  await openEpic(d, f)
  if (await d.ev(`document.querySelector('[aria-label="Plan graph"]') === null`)) await d.click(viewButton('Graph'), 'Graph view')
  const cases = [
    { name: 'api', key: 'SHOP-2', kind: 'complete' },
    { name: 'node', key: 'SHOP-1', kind: 'partial' },
    { name: 'page', key: 'SHOP-3', kind: 'rejected-retried' }
  ]
  for (const item of cases) {
    const read = f.reads[`ticket:${item.name}`]?.data
    const grade = read?.grade
    await d.size(NORMAL)
    await ticketScorecard(d, item.key)
    for (const [width, label] of [
      [NORMAL, 'normal'],
      [NARROW, 'narrow']
    ]) {
      await d.size(width)
      await d.scrollTo('aside.tp .sc-headline')
      const headline = await d.text('aside.tp .sc-headline')
      const expected = [...shown(grade), ...(grade?.statusReasons?.length > 0 ? [`Status ${grade.status}`] : [])]
      check(id, `${item.key} ${label}: headline shows get_ticket_grade ${expected.join(' ')}`, missing(headline, expected).length === 0 && expected.length >= 2, { headline: headline.slice(0, 400), expected })
      const values = { mcp: { letter: grade?.letter, displayScore: grade?.displayScore, status: grade?.status, outcome: grade?.outcome, statusReasons: grade?.statusReasons }, headline: headline.slice(0, 300) }
      await d.shot(id, `c13-${item.kind}-${item.key}-${label}.png`, `Ticket Scorecard tab of ${item.key} (${item.kind}) at ${label} width; headline equal to get_ticket_grade`, values)
      if (item.kind === 'rejected-retried') {
        await d.scrollTo('aside.tp [aria-label="Attempts in this run"]')
        const attempts = await d.text('aside.tp [aria-label="Attempts in this run"]')
        const corrections = await d.text('aside.tp [aria-label="Corrections"]')
        const deductions = (read?.sources?.signals?.C?.deductions ?? []).map((entry) => entry.kind)
        check(id, `${item.key} ${label}: two attempts listed`, attempts.includes('ATTEMPTS IN THIS RUN (2)'), attempts.slice(0, 500))
        check(id, `${item.key} ${label}: the rejection is shown (attempts or corrections)`, /reject/iu.test(attempts) || /Submission rejected/u.test(corrections), { attempts: attempts.slice(0, 500), corrections: corrections.slice(0, 500) })
        check(id, `${item.key}: get_ticket_grade C carries the rejected submission`, deductions.includes('rejected_submission'), deductions)
        await d.shot(id, `c13-rejected-retried-${item.key}-attempts-${label}.png`, `Ticket Scorecard tab of ${item.key}: the rejected attempt and the accepted corrective retry, and the rejection deduction, at ${label} width`, {
          attempts: attempts.slice(0, 600),
          mcpDeductions: deductions
        })
      }
    }
  }
  await d.size(NORMAL)
}

// ---------------------------------------------------------------------------------------------------------------
// c19: the Metrics link right below the MCP indicator, the dashboard against get_metrics_summary, an epic row

async function c19(d, f) {
  const id = 'c19'
  await d.size(NORMAL)
  const footer = await d.ev(`(() => {
    const footer = document.querySelector('footer.sidebar-footer')
    if (!footer) return null
    const lines = [...footer.children]
    const mcp = lines.find((line) => line.querySelector('.footer-key')?.textContent.trim() === 'MCP')
    const after = mcp?.nextElementSibling ?? null
    const link = after?.querySelector('button.footer-link') ?? null
    const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
    return { mcpIndex: lines.indexOf(mcp), mcpText: mcp?.innerText ?? null, nextText: after?.innerText ?? null, linkText: link?.textContent.trim() ?? null, mcpBox: mcp ? box(mcp) : null, nextBox: after ? box(after) : null }
  })()`)
  check(id, 'sidebar footer: the element directly after the MCP indicator holds the Metrics link', footer?.linkText === 'Metrics' && footer.mcpIndex === 0 && footer.nextBox.y > footer.mcpBox.y, footer)
  await d.click(`[...document.querySelectorAll('button.footer-link')].find((b) => b.textContent.trim() === 'Metrics')`, 'Metrics link')
  await d.until(`document.querySelector('section.metrics') !== null && document.querySelector('section.metrics [aria-label="Epics"]') !== null`, 'metrics dashboard')
  const m = f.reads.metrics.data
  const epicRow = m.epics.find((row) => row.epicId === f.project.epicId)
  const trend = m.trend.filter((entry) => entry.epicId === f.project.epicId).flatMap((entry) => shown(entry.grade))
  const tokens = m.totals?.tokens?.total?.value
  const expected = [...shown(epicRow?.grade), ...trend, ...(typeof tokens === 'number' ? [n(tokens)] : [])]
  for (const [width, label] of [
    [NORMAL, 'normal'],
    [NARROW, 'narrow']
  ]) {
    await d.size(width)
    await d.scrollTo('section.metrics')
    const page = await d.text('section.metrics')
    const live = await d.command(f.project.path, 'getMetricsSummary', {})
    check(id, `dashboard ${label}: shows get_metrics_summary epic grade, trend grades and total tokens`, missing(page, expected).length === 0, { missing: missing(page, expected), expected })
    // The epic row's grade is regraded at the read's cutoff (metricsSummary `liveGrade`), so its inputHash names that cutoff and moves with every read; it is recorded, not compared.
    const differs = live.ok ? diffPaths({ epics: m.epics, totals: m.totals, trend: m.trend }, { epics: live.data.epics, totals: live.data.totals, trend: live.data.trend }) : null
    const compared = differs?.filter((path) => !path.startsWith('.epics.0.grade.inputHash')) ?? null
    check(id, `dashboard ${label}: in-app getMetricsSummary has the same epics, totals and trend as the MCP read (inputHash aside)`, live.ok && compared.length === 0, live.ok ? { differs } : live.error)
    await d.shot(id, `c19-metrics-dashboard-${label}.png`, `Metrics dashboard of shop at ${label} width (opened from the sidebar Metrics link), equal to get_metrics_summary`, {
      footer,
      mcp: { epicGrade: shown(epicRow?.grade), trend, totalTokens: tokens },
      shownExcerpt: page.slice(0, 600)
    })
    await d.scrollTo('section.metrics [aria-label="Epics"]')
    await d.shot(id, `c19-metrics-epic-row-${label}.png`, `Metrics dashboard: the epic table with the ${f.project.epicTitle} row at ${label} width`, { row: (await d.text('section.metrics table[aria-label="Epics"]')).slice(0, 600) })
  }
  await d.size(NORMAL)
  await d.click(`[...document.querySelectorAll('section.metrics table[aria-label="Epics"] button.sc-link')].find((b) => b.textContent.trim() === ${JSON.stringify(f.project.epicTitle)})`, 'epic row link')
  await d.until(LOADED('.es'), 'epic scorecard from the metrics row', 60_000)
  for (const [width, label] of [
    [NORMAL, 'normal'],
    [NARROW, 'narrow']
  ]) {
    await d.size(width)
    await d.scrollTo('.es')
    const headline = await d.text('.es .sc-headline')
    const pressed = await d.ev(`[...document.querySelectorAll('[role=group][aria-label=View] button[aria-pressed=true]')].map((b) => b.textContent.trim())`)
    check(id, `epic Scorecard ${label}: opened from the row, headline equals get_epic_grade and the metrics row`, missing(headline, shown(f.reads.epic.data.grade)).length === 0 && missing(headline, shown(epicRow?.grade)).length === 0 && pressed.includes('Scorecard'), { headline: headline.slice(0, 300), pressed, epic: shown(f.reads.epic.data.grade) })
    await d.shot(id, `c19-epic-scorecard-from-metrics-${label}.png`, `The epic row's link opened ${f.project.epicTitle}'s Scorecard tab at ${label} width; grade equal to get_epic_grade`, { headline: headline.slice(0, 300), mcp: shown(f.reads.epic.data.grade) })
  }
  await d.size(NORMAL)
}

// ---------------------------------------------------------------------------------------------------------------
// c15: the approved Sprint 1 scorecard beside a dated regression reassessment; the approval stays bound

async function c15(d, f) {
  const id = 'c15'
  await d.size(NORMAL)
  await openEpic(d, f)
  if (await d.ev(`document.querySelector('[aria-label="Plan graph"]') === null`)) await d.click(viewButton('Graph'), 'Graph view')
  await d.click(REPORT_TOGGLE, 'report toggle')
  await d.until(`document.querySelector('[aria-label="Epic overview"] article') !== null`, 'epic overview')
  const label = await d.ev(`document.querySelector('[aria-label="Epic overview"] article').getAttribute('aria-label')`)
  const article = `[aria-label="Epic overview"] article[aria-label="${label}"]`
  await d.click(tabNamed(article, 'Scorecard'), 'report Scorecard tab')
  await d.until(LOADED(article), 'sprint 1 report scorecard')
  const card = f.reads.report1.data
  const snapshot = card.scorecard.snapshot
  const reassess = f.reads.reassess1.data
  const sprintSubject = reassess.subjects.find((entry) => entry.subject.level === 'sprint')
  const pinned = await d.text(`${article} [aria-label="Pinned report"]`)
  const headline = await d.text(`${article} .sc-headline`)
  const mode = await d.text(`${article} .cp-sc-mode`)
  check(id, 'snapshot headline equals get_report_scorecard (pinned revision) sprint result', missing(headline, shown(snapshot.sprint.result)).length === 0, { headline: headline.slice(0, 300), mcp: shown(snapshot.sprint.result) })
  check(id, 'pinned report facts name report 1, revision and the snapshot id of get_report_scorecard', missing(pinned, [f.project.reports[0], `${f.project.report1Revision} (pinned`, snapshot.snapshotId]).length === 0, pinned)
  await d.scrollTo(article)
  await d.shot(id, 'c15-approved-snapshot-normal.png', `Sprint 1 report Scorecard (completed epic overview): the snapshot frozen with report revision ${f.project.report1Revision} and approved at its checkpoint`, {
    mode,
    headline: headline.slice(0, 300),
    mcp: { result: summary(snapshot.sprint.result), snapshotId: snapshot.snapshotId, reportRevision: card.report?.reportRevision ?? f.project.report1Revision }
  })
  const section = `${article} [aria-label="Later reassessment"]`
  await d.scrollTo(section)
  await d.click(button(section, 'Reassess now'), 'Reassess now')
  await d.until(`document.querySelector(${JSON.stringify(`${section} [aria-label="Reassessed subjects"]`)}) !== null`, 'reassessment', 60_000)
  const approvedText = `approved ${summary(sprintSubject.approved)}`
  const currentText = `reassessed ${summary(sprintSubject.current)}`
  const mcpDiffs = sprintSubject.differences.map((entry) => [entry.component, entry.approved?.score, entry.current?.score])
  for (const [width, widthLabel] of [
    [NORMAL, 'normal'],
    [NARROW, 'narrow']
  ]) {
    await d.size(width)
    await d.scrollTo(section)
    const shownText = await d.text(section)
    check(id, `reassessment ${widthLabel}: dated, approved vs reassessed sprint grade as reassess_report_scorecard`, missing(shownText, ['Reassessment ·', approvedText, currentText, `snapshot ${snapshot.snapshotId}`]).length === 0, { missing: missing(shownText, ['Reassessment ·', approvedText, currentText, `snapshot ${snapshot.snapshotId}`]), excerpt: shownText.slice(0, 900) })
    check(id, `reassessment ${widthLabel}: the P difference is listed`, /(^|\n)P\s/u.test(shownText) || shownText.includes('\nP '), shownText.slice(0, 1200))
    await d.shot(id, `c15-reassessment-${widthLabel}.png`, `Later reassessment of Sprint 1 (dated now, after the high-severity defect recorded at ${f.regressedAt} + 1 h): approved snapshot vs reassessed grade, P difference`, {
      mcp: { approved: summary(sprintSubject.approved), current: summary(sprintSubject.current), differences: mcpDiffs, assessedAt: reassess.assessedAt, comparedWithSnapshot: reassess.approved?.snapshotId },
      shownExcerpt: shownText.slice(0, 900)
    })
  }
  await d.size(NORMAL)
  check(id, 'reassess_report_scorecard: sprint differences are exactly P 100 -> 70', JSON.stringify(mcpDiffs) === JSON.stringify([['P', 100, 70]]), mcpDiffs)
  check(id, 'reassess_report_scorecard: approved snapshot is the pinned get_report_scorecard snapshot (id and hash)', reassess.approved?.snapshotId === snapshot.snapshotId && reassess.approved?.snapshotHash === snapshot.snapshotHash, { reassessed: reassess.approved?.snapshotId, pinned: snapshot.snapshotId })
  check(id, 'get_report_scorecard after the regression equals the read before it', JSON.stringify(f.beforeRegression?.report1) === JSON.stringify(f.reads.report1), null)
  // Refresh the snapshot itself after reassessing: it must not move.
  await d.scrollTo(article)
  await d.click(button(`${article} [aria-label="Data freshness"]`, 'Refresh'), 'Refresh')
  await sleep(1500)
  await d.until(LOADED(article), 'snapshot after refresh')
  const after = await d.text(`${article} .sc-headline`)
  const inApp = await d.command(f.project.path, 'getReportScorecard', { reportId: f.project.reports[0], reportRevision: f.project.report1Revision })
  check(id, 'after Reassess and Refresh the snapshot headline is unchanged', missing(after, shown(snapshot.sprint.result)).length === 0, after.slice(0, 300))
  check(id, 'in-app getReportScorecard (pinned revision) after reassessing equals the MCP read', inApp.ok && JSON.stringify(inApp.data) === JSON.stringify(card), inApp.ok ? null : inApp.error)
  const approval = (f.approvals ?? []).find((row) => row.report_id === f.project.reports[0])
  check(id, 'the Sprint 1 approval record is bound to report 1 and its content hash (snapshot report.contentHash)', approval !== undefined && approval.report_hash === snapshot.report?.contentHash, { approval, contentHash: snapshot.report?.contentHash })
  await d.shot(id, 'c15-snapshot-after-reassess-normal.png', 'Sprint 1 report Scorecard after Reassess now and Refresh: the approved snapshot unchanged', { headline: after.slice(0, 300), approval })
}

// ---------------------------------------------------------------------------------------------------------------
// c14: every feature ticket accepted, the integrated outcome failed; sprint drill-down and reconciled totals

const tokensIn = (text) => [...text.matchAll(/([\d,]+) tokens/gu)].map((match) => Number(match[1].replaceAll(',', '')))

async function c14(d, f) {
  const id = 'c14'
  await d.size(NORMAL)
  await openEpic(d, f)
  await d.click(viewButton('Scorecard'), 'Scorecard view')
  await d.until(LOADED('.es'), 'epic scorecard', 60_000)
  const epic = f.reads.epic.data
  const outcomes = epic.outcomes ?? epic.grade?.outcomes ?? []
  const work = outcomes.filter((o) => o.role === 'work' && o.counted)
  const integrated = outcomes.filter((o) => o.role === 'integrated' && o.counted)
  check(id, 'get_epic_grade: outcome failed, every counted feature outcome verified, an integrated one failed', epic.grade?.outcome === 'failed' && work.length > 0 && work.every((o) => o.state === 'verified') && integrated.some((o) => o.state === 'failed'), {
    outcome: epic.grade?.outcome,
    work: work.map((o) => [o.ticketId, o.state]),
    integrated: integrated.map((o) => [o.ticketId, o.state])
  })
  const scopeSel = '.es [aria-label="Original scope and outcomes"]'
  for (const [width, label] of [
    [NORMAL, 'normal'],
    [NARROW, 'narrow']
  ]) {
    await d.size(width)
    await d.scrollTo('.es')
    const headline = await d.text('.es .sc-headline')
    check(id, `epic headline ${label} equals get_epic_grade`, missing(headline, shown(epic.grade)).length === 0, { headline: headline.slice(0, 300), mcp: shown(epic.grade) })
    await d.shot(id, `c14-epic-failed-headline-${label}.png`, `Epic Scorecard of Payment receipts at ${label} width: grade capped by the failed integrated outcome`, { headline: headline.slice(0, 300), mcp: summary(epic.grade) })
    await d.scrollTo(scopeSel)
    const scope = await d.text(scopeSel)
    check(id, `outcome section ${label}: says the epic failed although feature tickets are verified`, missing(scope, ['yet the epic failed', 'so completed tickets alone do not make the epic a success', `${work.length} of ${work.length} feature ticket(s)`]).length === 0, scope.slice(0, 900))
    await d.shot(id, `c14-epic-outcome-failed-${label}.png`, `Epic Scorecard: ${work.length} of ${work.length} feature tickets verified, yet the epic failed on the integrated outcome (${label})`, { conclusion: scope.slice(0, 700) })
  }
  await d.size(NORMAL)
  const sprintsSel = '.es [aria-label="Sprints"]'
  await d.scrollTo(sprintsSel)
  const toggles = await d.ev(`[...document.querySelectorAll(${JSON.stringify(`${sprintsSel} button.es-sprint-toggle`)})].map((b) => b.innerText)`)
  const s1 = f.reads.sprint1.data.grade
  const s2 = f.reads.sprint2.data.grade
  check(id, 'sprint toggles show each sprint grade (get_sprint_grade)', toggles.length === 2 && missing(toggles[0], shown(s1)).length === 0 && missing(toggles[1], shown(s2)).length === 0, { toggles, s1: shown(s1), s2: shown(s2) })
  await d.click(`[...document.querySelectorAll(${JSON.stringify(`${sprintsSel} button.es-sprint-toggle`)})].find((b) => b.innerText.startsWith('Sprint 2'))`, 'Sprint 2 toggle')
  const region = `${sprintsSel} [role=region][aria-label^="Sprint 2 of"]`
  await d.until(`document.querySelector(${JSON.stringify(region)}) !== null`, 'sprint 2 drill-down')
  const kOf = (grade) => grade.components.find((c) => c.component === 'K')?.inputs?.actual ?? null
  for (const [width, label] of [
    [NORMAL, 'normal'],
    [NARROW, 'narrow']
  ]) {
    await d.size(width)
    await d.scrollTo(sprintsSel)
    const detail = await d.text(region)
    check(id, `Sprint 2 drill-down ${label}: its own grade and "yet the sprint failed"`, missing(detail, [...shown(s2), 'yet the sprint failed']).length === 0, detail.slice(0, 900))
    await d.shot(id, `c14-sprint-drilldown-${label}.png`, `Epic Scorecard sprint drill-down: Sprint 2 opened to its grade and outcomes (${label})`, { toggles, sprint2: summary(s2), detail: detail.slice(0, 600) })
  }
  await d.size(NORMAL)
  const totalsSel = '.es [aria-label="Total resources"]'
  await d.scrollTo(totalsSel)
  const totals = await d.text('.es [aria-label="Epic totals"]')
  const runUsage = await d.ev(`[...document.querySelectorAll('.es [aria-label="Total resources"] dl')].map((dl) => [dl.getAttribute('aria-label'), dl.innerText])`)
  const screenTokens = tokensIn(totals)[0] ?? null
  const ledger = f.ledgerTotals
  const sprintK = [kOf(s1), kOf(s2)]
  const runMetricsTokens = f.reads.runMetrics?.data?.totals?.tokens?.total?.value ?? f.reads.runMetrics?.data?.tokens?.total?.value ?? null
  check(id, 'epic totals tokens on screen = ledger total = sum of the per-sprint K actuals (get_sprint_grade)', screenTokens === ledger.tokens && sprintK.every((v) => typeof v === 'number') && sprintK[0] + sprintK[1] === ledger.tokens, { screenTokens, ledger, sprintK })
  check(id, 'per-sprint K actuals equal the ledger per sprint', JSON.stringify(sprintK) === JSON.stringify(ledger.perSprint.map((s) => s.tokens)), { sprintK, perSprint: ledger.perSprint })
  check(id, 'epic K actual (get_epic_grade) recorded', true, { epicK: kOf(epic.grade), epicT: epic.grade.components.find((c) => c.component === 'T')?.inputs?.actual ?? null, runMetricsTokens })
  for (const [width, label] of [
    [NORMAL, 'normal'],
    [NARROW, 'narrow']
  ]) {
    await d.size(width)
    await d.scrollTo(totalsSel)
    await d.shot(id, `c14-total-resources-${label}.png`, `Epic Scorecard total resources (${label}): ${n(screenTokens)} tokens = ledger ${n(ledger.tokens)} = Sprint 1 ${n(sprintK[0])} + Sprint 2 ${n(sprintK[1])}`, { totals: totals.slice(0, 900), runUsage, ledger, sprintK })
  }
  await d.size(NORMAL)
}

// ---------------------------------------------------------------------------------------------------------------
// c23: select an experiment drawn from a measured finding, preview, create the draft, and no run started

async function openCheckpoint(d) {
  if (await d.ev(`document.querySelector('[aria-label="Sprint checkpoint"]') === null`)) await d.click(REPORT_TOGGLE, 'Sprint report toggle')
  await d.until(`document.querySelector('[aria-label="Sprint checkpoint"] article[aria-label="Sprint report"]') !== null`, 'checkpoint review')
}
const REPORT = '[aria-label="Sprint checkpoint"] article[aria-label="Sprint report"]'

async function runState(d, f) {
  const run = await d.command(f.project.path, 'getRun', { epicId: f.project.epicId })
  if (!run.ok) return { error: run.error }
  return { id: run.data.id, number: run.data.number, state: run.data.state, revisionId: run.data.revisionId, activeSprintOrdinal: run.data.activeSprintOrdinal, attempts: run.data.attempts.length, updatedAt: run.data.updatedAt }
}

async function c23(d, f, state) {
  const id = 'c23'
  await d.size(NORMAL)
  await openEpic(d, f)
  await openCheckpoint(d)
  const before = await runState(d, f)
  const seedRun = f.reads.run.data
  check(id, 'before: the in-app run equals the seed get_run (same run, state, attempts)', before.id === seedRun.id && before.state === seedRun.state && before.attempts === seedRun.attempts.length, { before, seed: { id: seedRun.id, state: seedRun.state, attempts: seedRun.attempts.length } })
  state.before = before
  await d.click(tabNamed(REPORT, 'Improvement'), 'Improvement tab')
  await d.until(`document.querySelector('${REPORT} [aria-label="Findings"]') !== null && !document.querySelector('${REPORT} [aria-label="Findings"]').innerText.includes('Reading the findings')`, 'findings')
  const findings = f.reads.findings.data.findings
  const findingsText = await d.text(`${REPORT} [aria-label="Findings"]`)
  check(id, 'findings shown are get_retro_findings (count)', findingsText.includes(`2 · FINDINGS · ${findings.length}`), { heading: findingsText.slice(0, 200), mcp: findings.length })
  await d.scrollTo(`${REPORT} [aria-label="Findings"]`)
  await d.shot(id, 'c23-findings-normal.png', 'Sprint 1 report Improvement tab: the measured findings of the frozen scorecard (get_retro_findings)', { count: findings.length, kinds: findings.map((x) => x.kind ?? x.type ?? null), excerpt: findingsText.slice(0, 600) })
  const xp = f.project.experiments.local
  const box = `document.querySelector(${JSON.stringify(`${REPORT} input[aria-label="Select ${xp} for corrective work"]`)})`
  await d.scrollTo(`${REPORT} [aria-label="Experiments"]`)
  const fromFindings = await d.text(`${REPORT} [aria-label="Experiments"]`)
  const top = findings.find((x) => x.rank === 1)
  check(id, `the experiment is drawn from measured finding #1 (${top?.kind} on ${top?.subject?.id}, ${top?.magnitude?.measure}) per get_retro_findings`, fromFindings.includes(`← #1 `) && top?.magnitude?.measure === 'E.corrective_ms' && top?.subject?.id === f.project.tickets.page, { excerpt: fromFindings.slice(0, 1500), finding: top })
  await d.click(box, `select ${xp}`)
  await d.until(`${box}.checked === true`, 'experiment selected')
  await d.shot(id, 'c23-experiment-selected-normal.png', `Experiment ${xp} (E.corrective_ms -50% on SHOP-3) ticked for corrective work`, { experiment: xp, checked: true })
  await d.ev(`[...document.querySelectorAll(${JSON.stringify(`${REPORT} [aria-label="Experiments"] button.sc-link`)})].find((b) => b.textContent.startsWith('← #1'))?.scrollIntoView({ block: 'center' })`)
  await d.shot(id, 'c23-experiment-from-finding-normal.png', `The ticked experiment's "From findings" link: ← #1 ${top?.statement?.slice(0, 80)}…`, { finding: { rank: top?.rank, kind: top?.kind, measure: top?.magnitude?.measure, statement: top?.statement } })
  const planner = `${REPORT} [aria-label="Corrective work"]`
  await d.scrollTo(planner)
  check(id, 'planner selection names the experiment', (await d.text(planner)).includes(`Selected: ${xp}`), (await d.text(planner)).slice(0, 300))
  await d.click(button(planner, 'Preview corrective work'), 'Preview corrective work')
  const preview = `${REPORT} [aria-label="Preview of the corrective work"]`
  await d.until(`document.querySelector(${JSON.stringify(preview)}) !== null`, 'preview', 60_000)
  const draftBefore = await d.command(f.project.path, 'getPlan', { epicId: f.project.epicId, view: 'draft' })
  for (const [width, label] of [
    [NORMAL, 'normal'],
    [NARROW, 'narrow']
  ]) {
    await d.size(width)
    await d.scrollTo(preview)
    const text = await d.text(preview)
    check(id, `preview ${label}: nothing written yet, the generated ticket shown`, missing(text, ['NOTHING IS WRITTEN YET', 'Write the card validation rules into the page ticket template']).length === 0, text.slice(0, 900))
    await d.shot(id, `c23-preview-${label}.png`, `Corrective work preview (${label}): tickets it would add, nothing written`, { excerpt: text.slice(0, 700) })
  }
  await d.size(NORMAL)
  const runAfterPreview = await runState(d, f)
  check(id, 'after Preview the run is unchanged', JSON.stringify(runAfterPreview) === JSON.stringify(before), runAfterPreview)
  await d.click(button(planner, 'Create draft work'), 'Create draft work')
  const created = `${REPORT} [aria-label="Corrective work created"]`
  await d.until(`document.querySelector(${JSON.stringify(created)}) !== null`, 'created', 60_000)
  const after = await runState(d, f)
  const draft = await d.command(f.project.path, 'getPlan', { epicId: f.project.epicId, view: 'draft' })
  const saved = await d.command(f.project.path, 'getPlan', { epicId: f.project.epicId, view: 'saved' })
  const newTicket = draft.ok ? draft.data.bundle.tickets.find((t) => t.title === 'Write the card validation rules into the page ticket template') : undefined
  state.newTicket = newTicket ? { id: newTicket.id, key: newTicket.key } : null
  check(id, 'after Create: same run, same state, no new attempt (no run started or advanced)', JSON.stringify(after) === JSON.stringify(before), { before, after })
  check(id, 'after Create: the draft holds the corrective ticket', newTicket !== undefined, { draftRevision: draft.ok ? draft.data.draftRevision : draft.error, draftBefore: draftBefore.ok ? draftBefore.data.draftRevision : draftBefore.error })
  check(id, 'after Create: the saved plan revision is unchanged (nothing saved)', saved.ok && saved.data.revisionId === f.reads.saved.data.revisionId, { saved: saved.ok ? saved.data.revisionId : saved.error, seed: f.reads.saved.data.revisionId })
  check(id, 'after Create: the new ticket is not in the run', newTicket !== undefined && !(await d.command(f.project.path, 'getRun', { epicId: f.project.epicId })).data.tickets.some((t) => t.ticketId === newTicket.id), null)
  for (const [width, label] of [
    [NORMAL, 'normal'],
    [NARROW, 'narrow']
  ]) {
    await d.size(width)
    await d.scrollTo(created)
    const text = await d.text(created)
    check(id, `created panel ${label}: Draft work created`, text.includes('Draft work created'), text.slice(0, 600))
    await d.shot(id, `c23-draft-created-${label}.png`, `Corrective draft work created (${label}); run ${after.number} still ${after.state} with ${after.attempts} attempts`, { excerpt: text.slice(0, 600), runBefore: before, runAfter: after, newTicket: state.newTicket })
  }
  await d.size(NORMAL)
  await d.scrollTo('[aria-label="Run"]')
  await d.shot(id, 'c23-run-bar-after-create-normal.png', 'Run bar after Create draft work: the run is still awaiting its checkpoint; nothing started', { runBar: (await d.text('[aria-label="Run"]')).slice(0, 400), runAfter: after })
}

// ---------------------------------------------------------------------------------------------------------------
// c16: one sprint rating and a future budget edit; the inherited context and the unchanged historical grades

async function c16(d, f, state) {
  const id = 'c16'
  await d.size(NORMAL)
  await openCheckpoint(d)
  await d.click(tabNamed(REPORT, 'Scorecard'), 'report Scorecard tab')
  await d.until(LOADED(REPORT), 'report scorecard')
  const snapshot = f.reads.report1.data.scorecard.snapshot
  const headline = await d.text(`${REPORT} .sc-headline`)
  check(id, 'Sprint 1 snapshot headline equals get_report_scorecard before the rating', missing(headline, shown(snapshot.sprint.result)).length === 0, { headline: headline.slice(0, 300), mcp: shown(snapshot.sprint.result) })
  await d.scrollTo(REPORT)
  await d.shot(id, 'c16-sprint1-snapshot-before-normal.png', 'Sprint 1 report Scorecard before the rating: the frozen snapshot', { headline: headline.slice(0, 300), mcp: summary(snapshot.sprint.result) })
  const fb = `${REPORT} [aria-label="Sprint feedback"]`
  await d.scrollTo(fb)
  const fbBefore = await d.text(fb)
  await d.click(`document.querySelector(${JSON.stringify(`${fb} input[type=radio][value="5"]`)})`, 'rating 5')
  const share = `document.querySelector(${JSON.stringify(`${fb} .tp-check-field input[type=checkbox]`)})`
  if (await d.ev(`${share}?.checked === false`)) await d.click(share, 'share with tickets')
  await d.until(`${share}?.checked === true`, 'shared')
  await d.click(button(fb, 'Record rating'), 'Record rating')
  await d.until(`document.querySelector(${JSON.stringify(fb)}).innerText.includes('Rating 5 of 5 recorded.') && document.querySelector(${JSON.stringify(fb)}).innerText.includes('Rated 5 of 5, shared')`, 'rating recorded', 30_000)
  for (const [width, label] of [
    [NORMAL, 'normal'],
    [NARROW, 'narrow']
  ]) {
    await d.size(width)
    await d.scrollTo(fb)
    const text = await d.text(fb)
    check(id, `sprint feedback ${label}: the recorded rating is shown, shared with the tickets, and the snapshot note`, missing(text, ['Rated 5 of 5, shared', 'Rating 5 of 5 recorded.', 'a rating recorded now never changes it']).length === 0, text.slice(0, 900))
    await d.shot(id, `c16-sprint-feedback-recorded-${label}.png`, `Sprint feedback on the Sprint 1 report: one rating (5 of 5, shared with the tickets) recorded through the desktop (${label})`, { before: fbBefore.slice(0, 400), after: text.slice(0, 600) })
  }
  await d.size(NORMAL)
  await d.scrollTo(REPORT)
  const headlineAfter = await d.text(`${REPORT} .sc-headline`)
  check(id, 'after the rating the Sprint 1 snapshot headline is unchanged', missing(headlineAfter, shown(snapshot.sprint.result)).length === 0, headlineAfter.slice(0, 300))
  // Budget edits in the draft: SHOP-2 (dispatched: applies to later dispatches) and the corrective ticket (never dispatched).
  await d.click(button('[aria-label="Checkpoint gate"]', 'Edit draft to change the gate'), 'Edit draft')
  await d.until(`document.querySelector('[aria-label="Draft"]') !== null && document.querySelector('[aria-label="Plan graph"]') !== null`, 'draft view')
  const edits = [{ key: 'SHOP-2', tokens: '40000', minutes: '25', expect: 'already dispatched', what: 'dispatched' }]
  if (state.newTicket !== null && state.newTicket !== undefined) edits.push({ key: state.newTicket.key, tokens: '20000', minutes: '15', expect: 'applies from the ticket’s next dispatch', what: 'never dispatched' })
  else check(id, 'the corrective ticket from c23 exists for a never-dispatched budget edit', false, state)
  for (const edit of edits) {
    await d.click(graphNode(edit.key), `draft node ${edit.key}`)
    const editor = `aside[aria-label="Edit ticket ${edit.key}"]`
    const fields = `${editor} [aria-label="Planned budget"]`
    await d.until(`document.querySelector(${JSON.stringify(fields)}) !== null && !document.querySelector(${JSON.stringify(fields)}).innerText.includes('Reading the saved budget versions')`, `budget fields ${edit.key}`)
    const inputs = `[...document.querySelectorAll(${JSON.stringify(`${fields} input.tp-input`)})]`
    await d.type(`${inputs}[0]`, edit.tokens)
    await d.type(`${inputs}[1]`, edit.minutes)
    await d.click(button(fields, 'Set budget in draft'), 'Set budget in draft')
    await d.until(`document.querySelector(${JSON.stringify(`${fields} .tp-message`)}) !== null`, 'budget notice')
    for (const [width, label] of [
      [NORMAL, 'normal'],
      [NARROW, 'narrow']
    ]) {
      await d.size(width)
      await d.scrollTo(fields)
      const text = await d.text(fields)
      check(id, `budget ${edit.key} (${edit.what}) ${label}: set in the draft, for future dispatches only`, missing(text, [`Set in the draft`, edit.expect]).length === 0, text.slice(0, 900))
      await d.shot(id, `c16-budget-${edit.what.replace(' ', '-')}-${edit.key}-${label}.png`, `Draft ticket editor ${edit.key} (${edit.what}): budget set to ${edit.tokens} tokens / ${edit.minutes} min in the draft (${label})`, { excerpt: text.slice(0, 900) })
    }
    await d.size(NORMAL)
  }
  const draft = await d.command(f.project.path, 'getPlan', { epicId: f.project.epicId, view: 'draft' })
  const api = draft.ok ? draft.data.bundle.tickets.find((t) => t.key === 'SHOP-2') : undefined
  check(id, 'in-app draft: SHOP-2 budget is the edit (40,000 tokens, 25 min)', api?.budget?.tokens === 40_000 && api?.budget?.activeMs === 25 * 60_000, api?.budget)
  // Back to the saved plan: the ticket view labels the inherited rating and keeps its grades.
  if (await d.ev(`${button('main', 'View saved')} !== undefined`)) await d.click(button('main', 'View saved'), 'View saved')
  else await d.click(`document.querySelector('[aria-label="Draft"] .ew-link')`, 'view saved link')
  await d.until(`document.querySelector('[aria-label="Draft"]') === null && document.querySelector('[aria-label="Plan graph"]') !== null`, 'saved view')
  await ticketScorecard(d, 'SHOP-2')
  const ticketGrade = f.reads['ticket:api'].data.grade
  const frozenApi = snapshot.tickets.find((t) => t.subject.id === f.project.tickets.api)?.result ?? null
  for (const [width, label] of [
    [NORMAL, 'normal'],
    [NARROW, 'narrow']
  ]) {
    await d.size(width)
    await d.scrollTo('aside.tp .sc-headline')
    const head = await d.text('aside.tp .sc-headline')
    const chip = await d.ev(`[...document.querySelectorAll('aside.tp .ew-chip')].some((c) => c.textContent.trim() === 'inherited')`)
    const live = await d.command(f.project.path, 'getTicketGrade', { runId: f.project.runId, ticketId: f.project.tickets.api })
    const liveGrade = live.ok ? live.data.grade : null
    check(id, `SHOP-2 ${label}: live headline equals in-app getTicketGrade now (seed read before the rating: ${summary(ticketGrade)})`, liveGrade !== null && missing(head, shown(liveGrade)).length === 0, { headline: head.slice(0, 300), now: summary(liveGrade), seed: summary(ticketGrade), S: liveGrade?.components.find((c) => c.component === 'S') })
    check(id, `SHOP-2 ${label}: S component marked inherited`, chip, null)
    await d.shot(id, `c16-ticket-SHOP-2-headline-${label}.png`, `Ticket Scorecard of SHOP-2 after the rating and the budget edit (${label})`, { headline: head.slice(0, 300), seed: summary(ticketGrade), inheritedChip: chip })
    await d.scrollTo(`aside.tp [aria-label="People's feedback"]`)
    const people = await d.text(`aside.tp [aria-label="People's feedback"]`)
    check(id, `SHOP-2 ${label}: feedback says S inherits the sprint's 5 of 5`, people.includes("No rating of its own: S inherits the sprint's rating, 5 of 5"), people.slice(0, 600))
    await d.shot(id, `c16-ticket-SHOP-2-inherited-${label}.png`, `SHOP-2 People's feedback: S inherits the Sprint 1 rating (5 of 5, shared), marked inherited (${label})`, { excerpt: people.slice(0, 700) })
    await d.scrollTo(`aside.tp [aria-label="Original and reassessed grades"]`)
    const orig = await d.text(`aside.tp [aria-label="Original and reassessed grades"]`)
    check(id, `SHOP-2 ${label}: original frozen grade shown${frozenApi ? ` (${summary(frozenApi)})` : ''}`, frozenApi === null ? orig.includes('Original (frozen') : orig.includes(summary(frozenApi)), { excerpt: orig.slice(0, 600), frozen: summary(frozenApi) })
    await d.shot(id, `c16-ticket-SHOP-2-original-${label}.png`, `SHOP-2: the grade frozen in the Sprint 1 report beside the reassessment (${label})`, { excerpt: orig.slice(0, 700) })
  }
  await d.size(NORMAL)
  await d.click(`document.querySelector('aside.tp [aria-label="Close ticket"]')`, 'close ticket')
  await openCheckpoint(d)
  await d.click(tabNamed(REPORT, 'Scorecard'), 'report Scorecard tab')
  await d.until(LOADED(REPORT), 'report scorecard again')
  await d.scrollTo(REPORT)
  const end = await d.text(`${REPORT} .sc-headline`)
  check(id, 'Sprint 1 snapshot after rating and budget edits still equals the seed get_report_scorecard', missing(end, shown(snapshot.sprint.result)).length === 0, end.slice(0, 300))
  const inApp = await d.command(f.project.path, 'getReportScorecard', { reportId: f.project.reportId, reportRevision: f.project.reportRevision })
  check(id, 'in-app getReportScorecard snapshot equals the seed MCP read', inApp.ok && JSON.stringify(inApp.data.scorecard?.snapshot) === JSON.stringify(snapshot), inApp.ok ? null : inApp.error)
  await d.shot(id, 'c16-sprint1-snapshot-after-normal.png', `Sprint 1 report Scorecard after the rating and the budget edits: still ${summary(snapshot.sprint.result)}`, { headline: end.slice(0, 300) })
  const section = `${REPORT} [aria-label="Later reassessment"]`
  await d.scrollTo(section)
  await d.click(button(section, 'Reassess now'), 'Reassess now')
  await d.until(`document.querySelector(${JSON.stringify(`${section} [aria-label="Reassessed subjects"]`)}) !== null`, 'reassessment', 60_000)
  const reassessed = await d.text(section)
  await d.shot(id, 'c16-sprint1-reassessment-normal.png', 'Sprint 1 Later reassessment: the late rating shows only here, the approved snapshot stays', { excerpt: reassessed.slice(0, 900) })
}

// ---------------------------------------------------------------------------------------------------------------
// After the app closed: the MCP reads of what the person did (after.json)

function afterChecks(f, state) {
  const a = JSON.parse(readFileSync(join(f.root, 'after.json'), 'utf8'))
  if (f.variant === 'regress') {
    check('c15', 'after the session: MCP get_report_scorecard (pinned) equals the seed read', JSON.stringify(a.reads.report1) === JSON.stringify(f.reads.report1), null)
    const sprint = a.reads.reassess1.data?.subjects?.find((s) => s.subject.level === 'sprint')
    check('c15', 'after the session: MCP reassess_report_scorecard still P 100 -> 70 against the same snapshot', JSON.stringify(sprint?.differences.map((x) => [x.component, x.approved?.score, x.current?.score])) === JSON.stringify([['P', 100, 70]]) && a.reads.reassess1.data.approved?.snapshotId === f.reads.report1.data.scorecard.snapshot.snapshotId, sprint?.differences)
    check('c15', 'after the session: the approval records are unchanged and bound to report 1', JSON.stringify(a.approvals) === JSON.stringify(f.approvals), a.approvals)
    return a
  }
  if (f.variant === 'report1') {
    const seedRuns = f.runs
    check('c23', 'after the session (MCP/DB): still one run, same state and attempt count', JSON.stringify(a.runs.map((r) => [r.id, r.number, r.state, r.attempts])) === JSON.stringify(seedRuns.map((r) => [r.id, r.number, r.state, r.attempts])), { before: seedRuns, after: a.runs })
    check('c23', 'after the session: MCP get_run is the same run, same state', a.reads.run.data?.id === f.reads.run.data.id && a.reads.run.data?.state === f.reads.run.data.state && a.reads.run.data?.attempts.length === f.reads.run.data.attempts.length, { id: a.reads.run.data?.id, state: a.reads.run.data?.state })
    const corrective = a.reads.draft.data?.bundle?.tickets.find((t) => t.title === 'Write the card validation rules into the page ticket template')
    check('c23', 'after the session: MCP get_plan draft holds the corrective ticket; saved revision unchanged', corrective !== undefined && a.reads.saved.data?.revisionId === f.reads.saved.data.revisionId, { corrective: corrective?.key, saved: a.reads.saved.data?.revisionId })
    check('c16', 'after the session: MCP get_report_scorecard equals the seed read (frozen snapshot unchanged)', JSON.stringify(a.reads.report1.data?.scorecard?.snapshot) === JSON.stringify(f.reads.report1.data.scorecard.snapshot), null)
    const rating = a.reads.signals.data?.S?.input?.sprintRating ?? null
    check('c16', 'after the session: MCP get_space_signals sprint rating 5, shared with tickets (one desktop record added)', rating?.value === 5 && rating?.sharedWithTickets === true, { rating, ratings: a.reads.signals.data?.S?.ratings?.length, seedRatings: f.reads.signals.data?.S?.ratings?.length })
    const apiDraft = a.reads.draft.data?.bundle?.tickets.find((t) => t.key === 'SHOP-2')?.budget
    const apiSaved = a.reads.saved.data?.bundle?.tickets.find((t) => t.key === 'SHOP-2')?.budget
    check('c16', 'after the session: SHOP-2 draft budget is the edit, saved budget unchanged', apiDraft?.tokens === 40_000 && apiSaved?.tokens === 50_000, { apiDraft, apiSaved })
    const k = (grade) => grade?.components?.find((c) => c.component === 'K')?.inputs ?? null
    const seedApi = f.reads['ticket:api'].data.grade
    const nowApi = a.reads['ticket:api'].data?.grade
    check('c16', 'after the session: SHOP-2 K inputs (frozen budget) unchanged by the budget edit', JSON.stringify(k(seedApi)) === JSON.stringify(k(nowApi)), { seed: k(seedApi), now: k(nowApi) })
    check('c16', 'after the session: SHOP-2 live grade vs seed (recorded; S may move with the late rating)', true, { seed: summary(seedApi), now: summary(nowApi), S: nowApi?.components?.find((c) => c.component === 'S') })
    const s = a.reads.reassess1.data?.subjects?.find((x) => x.subject.level === 'sprint')
    check('c16', 'after the session: reassessment keeps the approved Sprint 1 grade; the rating is a dated difference', summary(s?.approved) === summary(f.reads.report1.data.scorecard.snapshot.sprint.result), { approved: summary(s?.approved), current: summary(s?.current), differences: s?.differences })
    return a
  }
  return a
}

// ---------------------------------------------------------------------------------------------------------------

const plan = {
  loop: [c13, c19],
  regress: [c15],
  report1: [c23, c16],
  failed: [c14]
}

for (const variant of only) {
  const root = mkdtempSync(join(tmpdir(), `dm164-${variant}-`))
  const session = { variant, root, criteria: plan[variant].map((fn) => fn.name) }
  sessions.push(session)
  console.log(`== ${variant}: ${root}`)
  let f
  try {
    const started = Date.now()
    console.log(tsx('seed.ts', [root, variant], root).trim())
    session.seedMs = Date.now() - started
    f = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8'))
    session.fixture = { project: f.project, unexpected: f.unexpected }
  } catch (error) {
    session.error = String(error)
    for (const fn of plan[variant]) crit(fn.name).errors.push(`seed: ${String(error).slice(0, 2000)}`)
    save()
    continue
  }
  const state = {}
  const { child, renderer } = await launch(root)
  try {
    const d = driver(renderer, session)
    await d.size(NORMAL)
    await d.until(`${button('nav', f.project.name)} !== undefined`, 'tracked folders in the sidebar', 60_000)
    for (const fn of plan[variant]) {
      try {
        await fn(d, f, state)
      } catch (error) {
        crit(fn.name).errors.push(String(error.stack ?? error).slice(0, 2000))
        console.log(`ERROR ${fn.name}: ${error}`)
        await d.shot(fn.name, `${fn.name}-error-${variant}.png`, `State when ${fn.name} stopped: ${String(error).slice(0, 200)}`).catch(() => undefined)
      }
      save()
    }
  } finally {
    renderer.close()
    await sleep(1500)
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'])
    await sleep(1500)
  }
  if (variant === 'regress' || variant === 'report1') {
    try {
      console.log(tsx('after.ts', [root], root).trim())
      session.after = join(root, 'after.json')
      afterChecks(f, state)
    } catch (error) {
      session.afterError = String(error).slice(0, 2000)
      console.log(`ERROR after: ${error}`)
    }
  }
  save()
}
save()
console.log(JSON.stringify(Object.fromEntries(Object.entries(results).map(([id, r]) => [id, { passed: r.checks.filter((c) => c.ok).length, failed: r.checks.filter((c) => !c.ok).map((c) => c.label), errors: r.errors.length }])), null, 2))
