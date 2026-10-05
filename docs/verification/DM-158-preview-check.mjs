import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const require = createRequire(import.meta.url)
const { chromium } = require('C:/Users/davgo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')
const sharp = require('C:/Users/davgo/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const evidenceDir = path.dirname(fileURLToPath(import.meta.url))
const outputDir = path.join(os.tmpdir(), 'dm-158-production-preview')
const origin = 'http://127.0.0.1:5180'
const csp = ["default-src 'self'", "script-src 'self'", "style-src 'self'", "connect-src 'self'", "img-src 'self' data: file:", "object-src 'none'", "base-uri 'none'"].join('; ')
const atlas = JSON.parse(await readFile(path.join(root, 'src/renderer/src/assets/mascot/atlas.json'), 'utf8'))

await build({
  configFile: path.join(root, 'preview/mascot/vite.config.ts'), root, base: './',
  build: { outDir: outputDir, emptyOutDir: true, rollupOptions: { input: {
    actions: path.join(root, 'preview/mascot/actions.html'),
    graph: path.join(root, 'preview/mascot/graph.html')
  } } }
})

const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' }
const server = createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url ?? '/', origin).pathname)
  if (pathname === '/favicon.ico') return void response.writeHead(204).end()
  const file = path.resolve(outputDir, `.${pathname}`)
  if (!file.startsWith(`${outputDir}${path.sep}`)) return void response.writeHead(403).end()
  try {
    const [body, info] = await Promise.all([readFile(file), stat(file)])
    response.writeHead(200, { 'Content-Type': `${contentTypes[path.extname(file)] ?? 'application/octet-stream'}; charset=utf-8`, 'Content-Length': info.size,
      'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' }).end(body)
  } catch { response.writeHead(404).end() }
})

await new Promise((resolve) => server.listen(5180, '127.0.0.1', resolve))
const browser = await chromium.launch({ channel: 'msedge', headless: true })
const failures = []
const result = { production: { entries: ['actions.html', 'graph.html'], csp, browser: 'headless Edge' }, checks: {}, screenshots: [], errors: failures }

function watch(page, label) {
  page.on('console', (message) => { if (message.type() === 'error') failures.push(`${label}: console ${message.text()}`) })
  page.on('pageerror', (error) => failures.push(`${label}: pageerror ${error.message}`))
  page.on('requestfailed', (request) => failures.push(`${label}: requestfailed ${request.url()} ${request.failure()?.errorText ?? ''}`))
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(evidenceDir, name), fullPage: true })
  result.screenshots.push(name)
}
async function pose(page) {
  return page.locator('.pg-mascot-sprite').first().evaluate((el) => ({
    action: el.dataset.action, frame: Number(el.dataset.frame), style: el.getAttribute('style'),
    rect: (() => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, bottom: r.bottom } })(),
    shakeId: el.closest('.pg-mascot-layer')?.getAttribute('data-shake-id')
  }))
}
async function support(page, ticketId) {
  const current = await pose(page)
  const board = await page.locator('.pg').boundingBox()
  const card = await page.locator(`[data-ticket="${ticketId}"]`).boundingBox()
  const frame = atlas.actions[current.action].frames[current.frame]
  const anchor = frame.footAnchor ?? atlas.actions[current.action].footAnchor
  const scale = 100 / atlas.cell.width * atlas.actions[current.action].renderScale
  const left = Number.parseFloat(/left: ([\d.-]+)px/.exec(current.style)?.[1] ?? 'NaN')
  const top = Number.parseFloat(/top: ([\d.-]+)px/.exec(current.style)?.[1] ?? 'NaN')
  const foot = { x: board.x + left + anchor.x * scale, y: board.y + top + anchor.y * scale }
  return { pose: current, foot, ticketId, card: { x: card.x, y: card.y, width: card.width, height: card.height },
    onCard: Math.abs(foot.y - card.y) < 0.5 && foot.x >= card.x + 26 && foot.x <= card.x + card.width - 26 }
}
async function waitSupport(page, ticketId, timeout = 30000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    const sample = await support(page, ticketId)
    if (sample.pose.action === 'drill' && sample.onCard) return sample
    await page.waitForTimeout(40)
  }
  throw new Error(`Never saw drill supported by ${ticketId}`)
}
async function waitDrillFrame(page, frame) {
  await page.waitForFunction((f) => {
    const sprite = document.querySelector('.pg-mascot-layer .pg-mascot-sprite')
    return sprite?.getAttribute('data-action') === 'drill' && sprite.getAttribute('data-frame') === String(f)
  }, frame, { timeout: 30000 })
}
async function viewport(page) { return page.locator('.react-flow__viewport').getAttribute('style') }
async function wiggle(page) {
  const box = await page.locator('.pg').boundingBox()
  const x = box.x + 70, y = box.y + 380
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (const dx of [70, -70, 70]) await page.mouse.move(x + dx, y, { steps: 3 })
  await page.mouse.up()
}
async function openGraph(label) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  watch(page, label)
  const response = await page.goto(`${origin}/preview/mascot/graph.html`, { waitUntil: 'networkidle' })
  await page.locator('.react-flow__node').first().waitFor()
  await page.waitForTimeout(800)
  return { page, status: response?.status(), csp: response?.headers()['content-security-policy'] }
}

try {
  const drill = atlas.actions.drill
  result.checks.drillArt = []
  for (const frame of drill.frames) {
    const image = await sharp(path.join(root, 'src/renderer/src/assets/mascot', drill.image)).extract({ left: frame.x, top: frame.y, width: frame.width, height: frame.height }).png().toBuffer()
    result.checks.drillArt.push({ name: frame.name, hash: createHash('sha256').update(image).digest('hex'), footAnchor: frame.footAnchor ?? drill.footAnchor })
  }
  const actions = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
  watch(actions, 'actions')
  const actionsResponse = await actions.goto(`${origin}/preview/mascot/actions.html`, { waitUntil: 'networkidle' })
  await actions.locator('.preview-actions .preview-action').first().waitFor()
  result.checks.actions = { status: actionsResponse?.status(), csp: actionsResponse?.headers()['content-security-policy'],
    names: await actions.locator('.preview-actions .preview-action strong').allTextContents(),
    drillFrames: [] }
  const drillTile = actions.locator('.preview-actions .preview-action').filter({ hasText: 'drill' })
  for (let i = 0; i < 6; i += 1) {
    result.checks.actions.drillFrames.push(Number(await drillTile.locator('.pg-mascot-sprite').getAttribute('data-frame')))
    await actions.waitForTimeout(180)
  }
  await shot(actions, 'DM-158-actions-production.png')
  await actions.close()

  const { page, status, csp: graphCsp } = await openGraph('graph')
  result.checks.graph = { status, csp: graphCsp, nodeCount: await page.locator('.react-flow__node').count(), initialShake: (await pose(page)).shakeId }
  result.checks.graph.topDrill = { support: await waitSupport(page, 'tk_1'), status: await page.locator('.preview-fixture-state').textContent() }
  await waitDrillFrame(page, 2)
  result.checks.graph.topSpark = await support(page, 'tk_1')
  await shot(page, 'DM-158-top-drill-production.png')
  const sprite = page.locator('.pg-mascot-layer .pg-mascot-sprite')
  const pause = page.getByRole('button', { name: 'Pause mascot animation' })
  await pause.click()
  const paused = await pose(page)
  await page.waitForTimeout(550)
  result.checks.pause = { first: paused, afterWait: await pose(page), active: await page.locator('.pg-mascot-layer').getAttribute('data-animated') }
  await shot(page, 'DM-158-paused-drill-production.png')
  await page.getByRole('button', { name: 'Resume mascot animation' }).click()
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(120)
  result.checks.reduced = { pose: await pose(page), active: await page.locator('.pg-mascot-layer').getAttribute('data-animated') }
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.waitForTimeout(120)

  const shakeBeforeControls = (await pose(page)).shakeId
  const transformBefore = await viewport(page)
  await page.locator('.react-flow__controls-zoomin').click()
  await page.waitForFunction((before) => document.querySelector('.react-flow__viewport')?.getAttribute('style') !== before, transformBefore)
  const zoomed = await viewport(page)
  await page.locator('.react-flow__controls-fitview').click()
  await page.waitForFunction((before) => document.querySelector('.react-flow__viewport')?.getAttribute('style') !== before, zoomed)
  await page.waitForTimeout(900)
  result.checks.controls = { initial: transformBefore, zoomed, fitted: await viewport(page), shakeBeforeControls, shakeAfterControls: (await pose(page)).shakeId }
  const beforePan = await viewport(page)
  const board = await page.locator('.pg').boundingBox()
  await page.mouse.move(board.x + 80, board.y + 300)
  await page.mouse.down()
  await page.mouse.move(board.x + 145, board.y + 310, { steps: 8 })
  await page.mouse.up()
  await page.waitForTimeout(150)
  result.checks.gentlePan = { before: beforePan, after: await viewport(page), shakeBefore: (await pose(page)).shakeId }
  const card = page.locator('[data-ticket="tk_3"]')
  await card.click({ position: { x: 30, y: 20 } })
  result.checks.selection = await page.locator('.preview-fixture-state').textContent()
  const cardBox = await card.boundingBox()
  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(cardBox.x + cardBox.width / 2 + 70, cardBox.y + cardBox.height / 2 + 45, { steps: 7 })
  await page.mouse.up()
  result.checks.drag = await page.locator('.preview-fixture-state').textContent()
  await page.waitForTimeout(150)
  result.checks.gentlePan.shakeAfter = (await pose(page)).shakeId
  result.checks.preWiggleTop = await waitSupport(page, 'tk_1')
  await wiggle(page)
  const shakeImmediately = (await pose(page)).shakeId
  result.checks.topWiggle = { shakeImmediately, pose: await pose(page) }
  await shot(page, 'DM-158-top-tumble-production.png')
  result.checks.topWiggle.trajectory = []
  result.checks.topWiggle.candidates = await Promise.all(['tk_2', 'tk_3', 'tk_4'].map((id) => support(page, id)))
  const fallX = result.checks.topWiggle.candidates[0].foot.x
  const fallY = result.checks.topWiggle.candidates[0].foot.y
  result.checks.topWiggle.expectedFirst = result.checks.topWiggle.candidates
    .filter((item) => item.card.y > fallY && fallX >= item.card.x + 26 && fallX <= item.card.x + item.card.width - 26)
    .sort((a, b) => a.card.y - b.card.y)[0]?.ticketId ?? 'floor'
  const catchUntil = Date.now() + 2400
  let stableCatch = 0
  let lastCaught = null
  while (Date.now() < catchUntil) {
    const samples = await Promise.all(['tk_2', 'tk_3', 'tk_4'].map((id) => support(page, id)))
    result.checks.topWiggle.trajectory.push({ action: samples[0].pose.action, frame: samples[0].pose.frame, foot: samples[0].foot,
      dy: Object.fromEntries(samples.map((item) => [item.ticketId, item.foot.y - item.card.y])) })
    const caught = samples.find((item) => item.onCard)
    stableCatch = caught && caught.ticketId === lastCaught?.ticketId && Math.abs(caught.foot.y - lastCaught.foot.y) < 0.5 ? stableCatch + 1 : caught ? 1 : 0
    lastCaught = caught ?? null
    if (stableCatch >= 3) { result.checks.topWiggle.firstCatch = { ...caught, stableSamples: stableCatch }; break }
    await page.waitForTimeout(30)
  }
  await shot(page, 'DM-158-lower-catch-production.png')
  await page.getByRole('button', { name: 'Complete upper task' }).click()
  result.checks.completion = { state: await page.locator('.preview-fixture-state').textContent(), upper: await page.locator('[data-ticket="tk_1"]').textContent() }
  result.checks.completion.bottomDrill = await waitSupport(page, 'tk_4')
  await waitDrillFrame(page, 2)
  result.checks.completion.bottomSpark = await support(page, 'tk_4')
  await shot(page, 'DM-158-bottom-drill-production.png')
  await wiggle(page)
  result.checks.bottomWiggle = { shakeImmediately: (await pose(page)).shakeId }
  result.checks.bottomWiggle.trajectory = []
  const floorUntil = Date.now() + 2400
  while (Date.now() < floorUntil) {
    const current = await support(page, 'tk_4')
    const floor = await page.locator('.pg').boundingBox()
    const dyToFloor = current.foot.y - (floor.y + floor.height)
    result.checks.bottomWiggle.trajectory.push({ action: current.pose.action, frame: current.pose.frame, foot: current.foot, dyToFloor })
    if (Math.abs(dyToFloor) < 5) { result.checks.bottomWiggle.floorCatch = { ...current, dyToFloor }; break }
    await page.waitForTimeout(30)
  }
  await shot(page, 'DM-158-floor-fall-production.png')
  await page.setViewportSize({ width: 760, height: 900 })
  await page.waitForTimeout(400)
  result.checks.resize = { viewportWidth: 760, scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth), board: await page.locator('.pg').boundingBox(), pose: await pose(page) }
  await shot(page, 'DM-158-narrow-production.png')
  await page.close()

  result.checks.contracts = {
    productionLoadsUnderCsp: result.checks.actions.status === 200 && result.checks.graph.status === 200 && result.checks.actions.csp === csp && result.checks.graph.csp === csp,
    sevenActionsAndChangingDrill: result.checks.actions.names.length === 7 && new Set(result.checks.actions.drillFrames).size > 1 && new Set(result.checks.drillArt.map((item) => item.hash)).size === drill.frames.length,
    highestActiveDrill: result.checks.graph.topDrill.support.onCard && result.checks.graph.topSpark.onCard && result.checks.graph.topSpark.pose.frame === 2 && result.checks.graph.topSpark.pose.style.includes('scaleX(-1)'),
    pauseFreezesWholeSprite: result.checks.pause.first.style === result.checks.pause.afterWait.style && result.checks.pause.first.frame === result.checks.pause.afterWait.frame && result.checks.pause.active === 'false',
    reducedStaticIdle: result.checks.reduced.pose.action === 'idle' && result.checks.reduced.pose.frame === 0 && result.checks.reduced.active === 'false',
    zoomAndFit: transformBefore !== zoomed && zoomed !== result.checks.controls.fitted && result.checks.controls.shakeAfterControls === shakeBeforeControls,
    gentlePanAndCardActions: beforePan !== result.checks.gentlePan.after && result.checks.gentlePan.shakeAfter === result.checks.gentlePan.shakeBefore && result.checks.selection.includes('Selected: tk_3') && result.checks.drag.includes('Last drop: tk_3 at'),
    deliberateWiggle: Number(shakeImmediately) === Number(result.checks.gentlePan.shakeAfter) + 1,
    lowerTicketCatchesFirst: result.checks.topWiggle.firstCatch?.onCard === true && result.checks.topWiggle.firstCatch.ticketId === result.checks.topWiggle.expectedFirst,
    semanticCompletion: result.checks.completion.state.includes('Upper task: accepted') && result.checks.completion.bottomDrill.onCard && result.checks.completion.bottomSpark.onCard && result.checks.completion.bottomSpark.pose.frame === 2 && !result.checks.completion.bottomSpark.pose.style.includes('scaleX(-1)'),
    floorWiggle: Number(result.checks.bottomWiggle.shakeImmediately) === Number(shakeImmediately) + 1,
    floorCatch: Math.abs(result.checks.bottomWiggle.floorCatch?.dyToFloor ?? Infinity) < 5,
    narrowNoOverflow: result.checks.resize.scrollWidth <= 760,
    noBrowserErrors: failures.length === 0
  }
  result.checks.overallPassed = Object.values(result.checks.contracts).every(Boolean)
} finally {
  await browser.close()
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  await writeFile(path.join(evidenceDir, 'DM-158-preview-metadata.json'), `${JSON.stringify(result, null, 2)}\n`)
}
if (!result.checks.overallPassed) process.exitCode = 1
