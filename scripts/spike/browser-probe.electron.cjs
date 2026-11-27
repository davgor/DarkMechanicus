'use strict'
/**
 * DM-851 throwaway probe, Electron side; `scripts/spike/browser-probe.mjs` spawns it with the repo's Electron. It proves
 * the Electron behaviours the agent-browser tickets rely on against two local fixture servers, in a temporary profile
 * the launcher deletes. Each probe item prints one JSON line `{ item, title, verdict, ms, observations }` on stdout;
 * PNG evidence goes to `--out`. Imported by no product code. No native or global input is sent to the desktop.
 */
const { app, BrowserWindow, WebContentsView, desktopCapturer, nativeImage, protocol, screen, session } = require('electron')
const { execFile } = require('node:child_process')
const http = require('node:http')
const { writeFileSync } = require('node:fs')
const { release } = require('node:os')
const { join } = require('node:path')
const { performance } = require('node:perf_hooks')

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const OUT = arg('out')
const PARTITION = 'persist:dm-browser-spike'
const SECRET = 'hunter2-attribute-secret'
const TYPED_SECRET = 'typed-secret-7f3a'
/** The app's privileged schemes, registered as `src/main/desktop/attachmentProtocol.ts` registers them. */
const SCHEMES = ['dm-attachment', 'dm-chat-image']
/** A declared per-item bound: an item that has not answered by then is reported NO-GO with this reason. */
const ITEM_LIMIT_MS = 45_000
const VIEW_PREFS = { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false }
const NAV_EVENTS = ['will-navigate', 'will-redirect', 'will-frame-navigate', 'did-start-navigation', 'did-redirect-navigation', 'did-fail-load']
const WILL_EVENTS = ['will-navigate', 'will-redirect', 'will-frame-navigate']
const WINDOW_TITLE = 'DM-851 browser probe'

app.setPath('userData', arg('profile'))
protocol.registerSchemesAsPrivileged(SCHEMES.map((scheme) => ({ scheme, privileges: { standard: true, secure: true } })))
// The host has no microphone, and Chromium answers NotFoundError before it asks the permission handler; fake devices
// let the request reach the partition's handler, which is what item 5 tests.
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
app.on('window-all-closed', () => {})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (value) => Math.round(value * 10) / 10
const errorText = (error) => (error instanceof Error ? error.message : String(error))
const js = (contents, code) => contents.executeJavaScript(code, true)

async function settle(promise) {
  try { return { ok: true, value: await promise } } catch (error) { return { ok: false, error: errorText(error) } }
}
/** A CDP command, settled; a detached debugger throws synchronously, which this reports like a rejection. */
const cdp = (dbg, method, params) => settle(Promise.resolve().then(() => dbg.sendCommand(method, params)))
const withLimit = (promise, ms) => Promise.race([promise, wait(ms).then(() => ({ ok: false, error: `still pending after ${ms} ms` }))])

/** The event's arguments and elapsed ms, or `{ timedOut: true }` once `ms` passes without it. */
function once(emitter, name, ms) {
  const started = performance.now()
  return new Promise((resolve) => {
    const listener = (...args) => { clearTimeout(timer); resolve({ timedOut: false, args, ms: round(performance.now() - started) }) }
    const timer = setTimeout(() => { emitter.removeListener(name, listener); resolve({ timedOut: true, ms }) }, ms)
    emitter.once(name, listener)
  })
}
async function until(predicate, ms) {
  const deadline = performance.now() + ms
  while (!predicate() && performance.now() < deadline) await wait(50)
  return predicate()
}
async function step(timings, name, run) {
  const started = performance.now()
  const value = await run()
  timings[name] = round(performance.now() - started)
  return value
}

async function runItem(item, title, probe) {
  const started = performance.now()
  const outcome = await withLimit(settle(probe()), ITEM_LIMIT_MS)
  const result = outcome.ok ? outcome.value : { verdict: 'NO-GO', observations: { error: outcome.error } }
  const record = { item, title, verdict: result.verdict, ms: round(performance.now() - started), observations: result.observations }
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

// ---- Fixtures -------------------------------------------------------------------------------------------------

function listen(routes) {
  const server = http.createServer((request, response) => {
    const route = routes[new URL(request.url, 'http://fixture').pathname]
    if (route === undefined) response.writeHead(404).end()
    else route(response)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}
const originOf = (server) => `http://127.0.0.1:${server.address().port}`
const html = (body) => (response) => response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(`<!doctype html><html><body>${body}</body></html>`)
const redirect = (location) => (response) => response.writeHead(302, { location }).end()
const download = (response) => response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="probe.bin"' }).end('probe download')

const mainPage = (frameOrigin) => `<style>body{margin:0;padding:8px;background:#20a020;font:14px sans-serif}</style>
<h1 id="heading">before</h1><button id="btn" onclick="document.getElementById('heading').textContent='clicked'">Change heading</button>
<input id="text" aria-label="Name"><input id="pw" type="password" aria-label="Password" value="${SECRET}"><p id="keys"></p>
<iframe id="frame" src="${frameOrigin}/frame" width="320" height="60"></iframe><p>
<a id="link" href="/page2">link</a> <a id="redir-http" href="/redirect-http">302 to http</a> <a id="redir-file" href="/redirect-file">302 to file</a>
<a id="popup" href="#" onclick="window.open('/popup');return false">popup</a> <a id="dl" href="/download">download</a></p>
<script>document.getElementById('text').addEventListener('keydown',(e)=>{document.getElementById('keys').textContent+=e.key+';'})
window.slow=()=>new Promise((r)=>setTimeout(()=>r('slow-done'),3000))</script>`
/** The main window's stand-in for the rail: a composer, and a magenta placeholder the view must cover exactly. */
const HOST_PAGE = `<style>body{margin:0;background:#151211}</style>
<textarea id="composer" style="position:absolute;left:20px;top:20px;width:300px;height:40px"></textarea>
<div id="placeholder" style="position:absolute;left:37px;top:93px;width:641px;height:401px;background:#ff00ff"></div>`

async function servers() {
  const frame = await listen({ '/frame': html('<a id="flink" href="/frame2">frame link</a>'), '/frame2': html('frame2'), '/landing': html('<h1>landing</h1>') })
  const b = originOf(frame)
  const page = await listen({
    '/': html(mainPage(b)), '/page2': html('<h1>page2</h1>'), '/popup': html('popup'), '/host': html(HOST_PAGE), '/download': download,
    '/redirect-http': redirect(`${b}/landing`), '/redirect-file': redirect('file:///C:/Windows/win.ini')
  })
  return { a: originOf(page), b, list: [frame, page] }
}

function recordNavigation(ctx) {
  for (const name of NAV_EVENTS) {
    ctx.wc.on(name, (event, ...rest) => ctx.nav.log.push({
      scenario: ctx.nav.scenario, event: name, url: event?.url ?? null, isMainFrame: event?.isMainFrame ?? null,
      args: rest.filter((value) => ['string', 'number', 'boolean'].includes(typeof value)).slice(0, 4)
    }))
  }
}
function trackDownload(iso, item) {
  const record = { url: item.getURL(), filename: item.getFilename(), state: null, receivedBytes: null }
  iso.downloads.push(record)
  item.once('done', (_event, state) => { record.state = state; record.receivedBytes = item.getReceivedBytes() })
  item.cancel()
}
/** The stub on the default session stands in for the app's real handlers; the partition gets the browser's policy. */
function installIsolation(ctx) {
  ctx.iso = { hits: {}, opened: [], downloads: [], permissions: [], createdWindows: 0 }
  for (const scheme of SCHEMES) {
    ctx.iso.hits[scheme] = 0
    protocol.handle(scheme, () => { ctx.iso.hits[scheme] += 1; return new Response('stub', { headers: { 'access-control-allow-origin': '*' } }) })
  }
  ctx.wc.setWindowOpenHandler((details) => { ctx.iso.opened.push(details.url); return { action: 'deny' } })
  ctx.wc.on('did-create-window', () => { ctx.iso.createdWindows += 1 })
  ctx.part.on('will-download', (_event, item) => trackDownload(ctx.iso, item))
  ctx.part.setPermissionRequestHandler((_contents, permission, callback, details) => {
    ctx.iso.permissions.push({ permission, mediaTypes: details.mediaTypes ?? [] })
    callback(false)
  })
}

const rectOf = (contents, selector) => contents.executeJavaScript(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height } })()`)
/** The renderer rect × the host's zoom factor, in DIPs, is the view's bounds. */
async function placeView(ctx) {
  const rect = await rectOf(ctx.win.webContents, '#placeholder')
  const zoom = ctx.win.webContents.getZoomFactor()
  const bounds = { x: Math.round(rect.x * zoom), y: Math.round(rect.y * zoom), width: Math.round(rect.width * zoom), height: Math.round(rect.height * zoom) }
  ctx.view.setBounds(bounds)
  return { rendererRect: rect, zoomFactor: zoom, viewBounds: bounds }
}

async function setup() {
  const fixtures = await servers()
  const win = new BrowserWindow({ width: 1100, height: 760, show: true, title: WINDOW_TITLE, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } })
  win.on('page-title-updated', (event) => event.preventDefault())
  const view = new WebContentsView({ webPreferences: VIEW_PREFS })
  win.contentView.addChildView(view)
  const ctx = { ...fixtures, win, view, wc: view.webContents, part: session.fromPartition(PARTITION), nav: { scenario: 'setup', log: [] } }
  recordNavigation(ctx)
  installIsolation(ctx)
  await win.loadURL(`${ctx.a}/host`)
  await placeView(ctx)
  ctx.nav.scenario = 'main-process loadURL (initial page, with iframe)'
  await ctx.wc.loadURL(`${ctx.a}/`)
  await wait(500)
  ctx.nav.scenario = '(other items)'
  return ctx
}

// ---- Item 1: debugger -----------------------------------------------------------------------------------------

async function axSnapshot(dbg) {
  const tree = await dbg.sendCommand('Accessibility.getFullAXTree')
  const json = JSON.stringify(tree)
  return { tree, json, bytes: Buffer.byteLength(json), nodes: tree.nodes.length }
}
const axNamed = (tree, name) => tree.nodes.find((node) => node.name?.value === name)

async function boxCenter(dbg, backendNodeId) {
  const first = await cdp(dbg, 'DOM.getBoxModel', { backendNodeId })
  if (!first.ok) await dbg.sendCommand('DOM.getDocument', { depth: 0 })
  const { model } = first.ok ? first.value : await dbg.sendCommand('DOM.getBoxModel', { backendNodeId })
  const [x1, y1, , , x3, y3] = model.content
  return { x: (x1 + x3) / 2, y: (y1 + y3) / 2, width: model.width, height: model.height, firstCallError: first.ok ? null : first.error }
}
async function cdpClick(dbg, point) {
  for (const type of ['mousePressed', 'mouseReleased']) await dbg.sendCommand('Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button: 'left', clickCount: 1 })
}
async function cdpType(dbg, backendNodeId, text) {
  await dbg.sendCommand('DOM.focus', { backendNodeId })
  await dbg.sendCommand('Input.insertText', { text })
}
async function cdpEnter(dbg) {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
  await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', text: '\r', ...key })
  await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...key })
}
function passwordExposure(before, after) {
  const node = axNamed(after.tree, 'Password')
  const leaked = [[SECRET, 'value attribute'], [TYPED_SECRET, 'typed value']].filter(([secret]) => before.json.includes(secret) || after.json.includes(secret))
  return { exposed: leaked.length > 0, leaked: leaked.map(([, label]) => label), role: node?.role?.value ?? null, value: node?.value ?? null, properties: (node?.properties ?? []).map((entry) => entry.name) }
}
async function devToolsFalseAttach(ctx) {
  const probe = new WebContentsView({ webPreferences: { ...VIEW_PREFS, devTools: false } })
  await probe.webContents.loadURL(`${ctx.a}/page2`)
  const attach = await settle(Promise.resolve().then(() => probe.webContents.debugger.attach('1.3')))
  const evaluated = attach.ok ? await cdp(probe.webContents.debugger, 'Runtime.evaluate', { expression: '6 * 7', returnByValue: true }) : null
  probe.webContents.close()
  return { attached: attach.ok, attachError: attach.ok ? null : attach.error, evaluate6x7: evaluated?.ok ? evaluated.value.result.value : (evaluated?.error ?? null) }
}
const pageState = (contents) => js(contents, `({ heading: document.getElementById('heading').textContent, text: document.getElementById('text').value, keys: document.getElementById('keys').textContent, passwordLength: document.getElementById('pw').value.length })`)
const debuggerGo = (page, password, devTools) => page.heading === 'clicked' && page.text === 'hello probe' && page.keys.includes('Enter') && !password.exposed && devTools.attached

async function probeDebugger(ctx) {
  const dbg = ctx.wc.debugger
  const timingsMs = {}
  await step(timingsMs, 'attach', () => dbg.attach('1.3'))
  const ax = await step(timingsMs, 'Accessibility.getFullAXTree', () => axSnapshot(dbg))
  const point = await step(timingsMs, 'DOM.getBoxModel', () => boxCenter(dbg, axNamed(ax.tree, 'Change heading').backendDOMNodeId))
  await step(timingsMs, 'Input.dispatchMouseEvent click', () => cdpClick(dbg, point))
  await step(timingsMs, 'DOM.focus + Input.insertText', () => cdpType(dbg, axNamed(ax.tree, 'Name').backendDOMNodeId, 'hello probe'))
  await step(timingsMs, 'Input.dispatchKeyEvent Enter', () => cdpEnter(dbg))
  await cdpType(dbg, axNamed(ax.tree, 'Password').backendDOMNodeId, TYPED_SECRET)
  const after = await axSnapshot(dbg)
  const page = await pageState(ctx.wc)
  const password = passwordExposure(ax, after)
  const devTools = await devToolsFalseAttach(ctx)
  return {
    verdict: debuggerGo(page, password, devTools) ? 'GO' : 'NO-GO',
    observations: { timingsMs, axTree: { bytes: ax.bytes, nodes: ax.nodes }, axTreeAfterTyping: { bytes: after.bytes, nodes: after.nodes }, boxModel: point, page, password, devToolsFalse: devTools }
  }
}

// ---- Item 2: detach -------------------------------------------------------------------------------------------

const eventSummary = (event) => (event.timedOut ? `not emitted within ${event.ms} ms` : { reason: event.args[1], ms: event.ms })

async function devToolsWhileAttached(ctx) {
  const dbg = ctx.wc.debugger
  const detached = once(dbg, 'detach', 4000)
  const opened = once(ctx.wc, 'devtools-opened', 8000)
  ctx.wc.openDevTools({ mode: 'detach', activate: false })
  const openResult = await opened
  const event = await detached
  const isAttached = dbg.isAttached()
  const command = await cdp(dbg, 'Runtime.evaluate', { expression: '2 + 2', returnByValue: true })
  const attachWhileOpen = isAttached ? 'already attached' : await settle(Promise.resolve().then(() => dbg.attach('1.3')))
  ctx.wc.closeDevTools()
  await wait(300)
  return {
    devtoolsOpenedMs: openResult.timedOut ? null : openResult.ms, detachEvent: eventSummary(event), isAttachedAfterOpen: isAttached,
    commandAfterOpen: command.ok ? command.value.result.value : command.error, attachWhileOpen
  }
}
async function probeDetach(ctx) {
  const dbg = ctx.wc.debugger
  const detached = once(dbg, 'detach', 3000)
  const inflight = cdp(dbg, 'Runtime.evaluate', { expression: 'window.slow()', awaitPromise: true, returnByValue: true })
  const started = performance.now()
  dbg.detach()
  const detachCallMs = round(performance.now() - started)
  const [event, flight] = await Promise.all([detached, withLimit(inflight, 6000)])
  const flightMs = round(performance.now() - started)
  const reattach = await settle(Promise.resolve().then(() => dbg.attach('1.3')))
  const afterReattach = await cdp(dbg, 'Runtime.evaluate', { expression: '1 + 1', returnByValue: true })
  const devTools = await devToolsWhileAttached(ctx)
  const inFlight = flight.ok ? { rejected: false, value: flight.value.result?.value ?? null, settledMs: flightMs } : { rejected: true, error: flight.error, settledMs: flightMs }
  const reattached = reattach.ok && afterReattach.ok && afterReattach.value.result.value === 2
  return {
    verdict: reattached && inFlight.rejected ? 'GO' : 'NO-GO',
    observations: { detachCallMs, detachEventOnDetach: eventSummary(event), inFlight, reattached, reattachError: reattach.ok ? null : reattach.error, devToolsOpened: devTools }
  }
}

// ---- Item 3: capture ------------------------------------------------------------------------------------------

/** Each case first repaints the page in its own colour, so a capture showing that colour is fresh, not a cached frame. */
async function captureCase(ctx, { label, rgb, arrange }) {
  await arrange()
  await js(ctx.wc, `document.body.style.background = 'rgb(${rgb.join(',')})'`)
  await wait(500)
  const bounds = ctx.view.getBounds()
  const scaleFactor = screen.getDisplayMatching(ctx.win.getBounds()).scaleFactor
  const started = performance.now()
  const shot = await withLimit(settle(ctx.wc.capturePage()), 5000)
  const ms = round(performance.now() - started)
  if (!shot.ok) return { label, ms, error: shot.error }
  const png = shot.value.toPNG()
  if (png.length > 0) writeFileSync(join(OUT, `capture-${label}.png`), png)
  const size = shot.value.getSize()
  const expected = { width: Math.round(bounds.width * scaleFactor), height: Math.round(bounds.height * scaleFactor) }
  const sizeMatches = Math.abs(size.width - expected.width) <= 1 && Math.abs(size.height - expected.height) <= 1
  const freshPixels = countColor(shot.value, rgb).count
  // The view's whole area in the case colour; a few matching pixels (anti-aliasing) would not prove a fresh frame.
  const fresh = freshPixels >= 0.5 * size.width * size.height
  return { label, ms, isEmpty: shot.value.isEmpty(), pngBytes: png.length, size, viewDipBounds: bounds, scaleFactor, expectedDeviceSize: expected, sizeMatches, freshPixels, fresh }
}
async function probeCapture(ctx) {
  const placed = ctx.view.getBounds()
  const cases = []
  for (const entry of [
    { label: 'visible', rgb: [32, 160, 32], arrange: () => {} },
    { label: 'view-setVisible-false', rgb: [32, 64, 192], arrange: () => ctx.view.setVisible(false) },
    { label: 'off-window-bounds', rgb: [192, 64, 32], arrange: () => { ctx.view.setVisible(true); ctx.view.setBounds({ ...placed, x: 5000, y: 5000 }) } },
    { label: 'window-hidden', rgb: [160, 32, 160], arrange: () => { ctx.view.setBounds(placed); ctx.win.hide() } }
  ]) cases.push(await captureCase(ctx, entry))
  ctx.win.show()
  ctx.view.setBounds(placed)
  await js(ctx.wc, `document.body.style.background = '#20a020'`)
  await wait(300)
  const visible = cases[0]
  return { verdict: visible.isEmpty === false && visible.sizeMatches && visible.fresh ? 'GO' : 'NO-GO', observations: { cases } }
}

// ---- Item 4: navigation events --------------------------------------------------------------------------------

const firedFor = (events) => Object.fromEntries(WILL_EVENTS.map((name) => [name, events.filter((entry) => entry.event === name).map((entry) => `${entry.isMainFrame ? 'main' : 'sub'} ${entry.url}`)]))
const scenarioOf = (ctx, scenario, finalUrl) => {
  const events = ctx.nav.log.filter((entry) => entry.scenario === scenario)
  return { scenario, fired: firedFor(events), finalUrl, events }
}
async function navScenario(ctx, scenario, trigger) {
  ctx.nav.scenario = scenario
  const stopped = once(ctx.wc, 'did-stop-loading', 5000)
  const triggered = await settle(Promise.resolve().then(trigger))
  await stopped
  await wait(400)
  return { ...scenarioOf(ctx, scenario, ctx.wc.getURL()), triggerError: triggered.ok ? null : triggered.error }
}
const clickIn = (contents, selector) => () => js(contents, `document.querySelector('${selector}').click()`)
/** Whether a scenario's main-frame navigation fired none of the will-* events (subframes it loads are counted apart). */
const mainFrameNone = (result) => result.events.every((entry) => !WILL_EVENTS.includes(entry.event) || entry.isMainFrame === false)

function navigationVerdict(byName) {
  const linkGuarded = byName['link click'].fired['will-navigate'].length > 0
  const redirectGuarded = byName['link to a 302 to http'].fired['will-redirect'].length > 0
  const fileNeverCommits = !byName['link to a 302 to file:'].finalUrl.startsWith('file:')
  const frameGuarded = byName['iframe link click'].fired['will-frame-navigate'].some((entry) => entry.startsWith('sub'))
  const loadUrls = ['main-process loadURL (initial page, with iframe)', 'main-process loadURL (cross-origin http)', 'main-process loadURL (file:)']
  const fileLoadCommits = byName['main-process loadURL (file:)'].finalUrl.startsWith('file:')
  return { linkGuarded, redirectGuarded, fileNeverCommits, frameGuarded, loadUrlMainFrameFiresNoWillEvent: loadUrls.every((name) => mainFrameNone(byName[name])), mainProcessFileLoadCommits: fileLoadCommits }
}
async function probeNavigation(ctx) {
  const home = () => ctx.wc.loadURL(`${ctx.a}/`)
  const results = [scenarioOf(ctx, 'main-process loadURL (initial page, with iframe)', `${ctx.a}/`)]
  results.push(await navScenario(ctx, 'iframe link click', () => js(ctx.wc.mainFrame.frames[0], `document.getElementById('flink').click()`)))
  results.push(await navScenario(ctx, 'link click', clickIn(ctx.wc, '#link')))
  await navScenario(ctx, 'reset (loadURL home)', home)
  results.push(await navScenario(ctx, 'link to a 302 to http', clickIn(ctx.wc, '#redir-http')))
  await navScenario(ctx, 'reset (loadURL home) 2', home)
  results.push(await navScenario(ctx, 'link to a 302 to file:', clickIn(ctx.wc, '#redir-file')))
  results.push(await navScenario(ctx, 'main-process loadURL (cross-origin http)', () => ctx.wc.loadURL(`${ctx.b}/landing`)))
  results.push(await navScenario(ctx, 'main-process loadURL (file:)', () => ctx.wc.loadURL('file:///C:/Windows/win.ini')))
  const checks = navigationVerdict(Object.fromEntries(results.map((result) => [result.scenario, result])))
  const go = checks.linkGuarded && checks.redirectGuarded && checks.fileNeverCommits && checks.frameGuarded
  return { verdict: go ? 'GO' : 'NO-GO', observations: { checks, expectationLoadUrlFiresNone: checks.loadUrlMainFrameFiresNoWillEvent ? 'confirmed' : 'refuted', scenarios: results } }
}

// ---- Item 5: isolation ----------------------------------------------------------------------------------------

/** A page fetch and an image load of `url`; only the stub's hit counter shows whether either reached a handler. */
const pageRequest = (contents, url) => js(contents, `Promise.all([
  fetch(${JSON.stringify(url)}).then((r) => r.text().then((t) => 'ok ' + r.status + ' ' + t), (e) => 'rejected: ' + e.message),
  new Promise((done) => { const image = new Image(); image.onload = () => done('loaded'); image.onerror = () => done('error'); image.src = ${JSON.stringify(url)} })
]).then(([fetch, img]) => ({ fetch, img }))`)
/** The same requests from a view in the default session, where the stub handler is registered: the control. */
async function controlRequest(ctx) {
  const control = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  await control.webContents.loadURL(`${ctx.a}/page2`)
  const result = await pageRequest(control.webContents, 'dm-attachment://x/y')
  control.webContents.close()
  return result
}
async function popupDenied(ctx) {
  const windowsBefore = BrowserWindow.getAllWindows().length
  await js(ctx.wc, `document.getElementById('popup').click()`)
  await wait(800)
  return { handlerSaw: [...ctx.iso.opened], windowsBefore, windowsAfter: BrowserWindow.getAllWindows().length, didCreateWindow: ctx.iso.createdWindows }
}
async function downloadCancelled(ctx) {
  await js(ctx.wc, `document.getElementById('dl').click()`)
  await until(() => ctx.iso.downloads[0]?.state != null, 5000)
  return { downloads: ctx.iso.downloads, pageUrlAfter: ctx.wc.getURL() }
}
function isolationGo(o) {
  const schemes = o.handled.every((entry) => entry.defaultSession && !entry.partition)
  const fetches = o.partitionRequests.every((entry) => entry.result.fetch.startsWith('rejected')) && o.handlerHitsFromPartition === 0
  const popup = o.popup.handlerSaw.length === 1 && o.popup.windowsAfter === o.popup.windowsBefore && o.popup.didCreateWindow === 0
  const media = o.getUserMedia.startsWith('NotAllowedError') && o.permissionRequests.some((entry) => entry.permission === 'media')
  return schemes && fetches && popup && o.download.downloads[0]?.state === 'cancelled' && media
}
async function probeIsolation(ctx) {
  const handled = SCHEMES.map((scheme) => ({ scheme, defaultSession: protocol.isProtocolHandled(scheme), partition: ctx.part.protocol.isProtocolHandled(scheme) }))
  const partitionRequests = await Promise.all(SCHEMES.map(async (scheme) => ({ url: `${scheme}://x/y`, result: await pageRequest(ctx.wc, `${scheme}://x/y`) })))
  const handlerHitsFromPartition = Object.values(ctx.iso.hits).reduce((sum, value) => sum + value, 0)
  const defaultSessionControl = { result: await controlRequest(ctx), handlerHits: { ...ctx.iso.hits } }
  const popup = await popupDenied(ctx)
  const download = await downloadCancelled(ctx)
  const getUserMedia = await js(ctx.wc, `navigator.mediaDevices.getUserMedia({ audio: true }).then(() => 'granted', (e) => e.name + ': ' + e.message)`)
  const observations = { handled, partitionRequests, handlerHitsFromPartition, defaultSessionControl, popup, download, getUserMedia, permissionRequests: ctx.iso.permissions }
  return { verdict: isolationGo(observations) ? 'GO' : 'NO-GO', observations }
}

// ---- Item 6: IPC ----------------------------------------------------------------------------------------------

async function probeIpc(ctx) {
  const globals = await js(ctx.wc, `({ require: typeof require, process: typeof process, ipcRenderer: typeof ipcRenderer, electron: typeof window.electron, bridgeKeys: Object.keys(window).filter((key) => /electron|ipc|darkmech|^dm/i.test(key)) })`)
  const frame = ctx.wc.mainFrame
  const noBridge = ['require', 'process', 'ipcRenderer', 'electron'].every((key) => globals[key] === 'undefined') && globals.bridgeKeys.length === 0
  return { verdict: noBridge ? 'GO' : 'NO-GO', observations: { globals, senderFrame: { url: frame.url, topLevel: frame.parent === null } } }
}

// ---- Items 7 and 8: bounds, DPI, focus, overlay ---------------------------------------------------------------

const MAGENTA = [255, 0, 255]
function countColor(image, rgb) {
  const bitmap = image.toBitmap()
  const { width } = image.getSize()
  let count = 0
  const box = { left: Infinity, top: Infinity, right: -1, bottom: -1 }
  for (let index = 0; index < bitmap.length; index += 4) {
    if (Math.abs(bitmap[index + 2] - rgb[0]) + Math.abs(bitmap[index + 1] - rgb[1]) + Math.abs(bitmap[index] - rgb[2]) > 60) continue
    const pixel = index / 4
    count += 1
    Object.assign(box, { left: Math.min(box.left, pixel % width), right: Math.max(box.right, pixel % width), top: Math.min(box.top, Math.floor(pixel / width)), bottom: Math.max(box.bottom, Math.floor(pixel / width)) })
  }
  return { count, box: count === 0 ? null : box }
}
/** Fewer than 4 distinct colours in a sample is a blank capture: the desktop is not being drawn (a minimized RDP session). */
function isBlank(image) {
  const bitmap = image.toBitmap()
  const colours = new Set()
  for (let index = 0; index < bitmap.length && colours.size < 4; index += 4 * 97) colours.add(bitmap.readUInt32LE(index))
  return colours.size < 4
}
const BLANK = 'UNTESTED on screen: the screen capture is blank, so the desktop is not being drawn (this host runs in an RDP session)'
/** The host page and the view captured apart, the view pasted at its DIP bounds × scale: checks the arithmetic, not the compositor. */
async function simulatedComposite(ctx, label) {
  const scale = scaleOf(ctx.win)
  const host = await ctx.win.webContents.capturePage()
  const view = await ctx.wc.capturePage()
  const bounds = ctx.view.getBounds()
  const target = Buffer.from(host.toBitmap())
  const { width } = host.getSize()
  const source = view.toBitmap()
  const size = view.getSize()
  const left = Math.round(bounds.x * scale)
  const top = Math.round(bounds.y * scale)
  for (let row = 0; row < size.height; row += 1) source.copy(target, ((top + row) * width + left) * 4, row * size.width * 4, (row + 1) * size.width * 4)
  const image = nativeImage.createFromBitmap(target, { ...host.getSize(), scaleFactor: 1 })
  writeFileSync(join(OUT, `${label}.png`), image.toPNG())
  return { file: `${label}.png`, hostDevicePx: host.getSize(), viewOffsetDevicePx: { left, top }, viewDevicePx: size, magenta: countColor(image, MAGENTA) }
}
const scaleOf = (win) => screen.getDisplayMatching(win.getBounds()).scaleFactor

const gdiCapture = (rect, file) => [
  `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public static class Dpi { [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); }'`,
  '[Dpi]::SetProcessDPIAware() | Out-Null', 'Add-Type -AssemblyName System.Drawing',
  `$b = New-Object System.Drawing.Bitmap ${rect.width}, ${rect.height}`, '$g = [System.Drawing.Graphics]::FromImage($b)',
  `$g.CopyFromScreen(${rect.x}, ${rect.y}, 0, 0, $b.Size)`, `$b.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)`
].join('; ')
/**
 * What the person sees: the screen pixels under the window's content area (the window is kept on top), copied with GDI
 * in device pixels, so the native view and any separate popup widget are included. Only that region is saved.
 * (desktopCapturer lists no source for this window on the host; item 7 records that diagnostic.)
 */
async function windowShot(win, label) {
  const rect = screen.dipToScreenRect(win, win.getContentBounds())
  const file = join(OUT, `${label}.png`)
  await new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', gdiCapture(rect, file)], { windowsHide: true, timeout: 20_000 }, (error) => (error ? reject(error) : resolve()))
  })
  const image = nativeImage.createFromPath(file)
  return { image, file: `${label}.png`, size: image.getSize(), deviceRect: rect }
}
async function capturerDiagnostic(win) {
  const windows = await settle(desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 64, height: 64 }, fetchWindowIcons: false }))
  const screens = await settle(desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 640, height: 400 } }))
  return {
    mediaSourceId: win.getMediaSourceId(), windowSources: windows.ok ? windows.value.length : windows.error,
    listsThisWindow: windows.ok && windows.value.some((entry) => entry.id === win.getMediaSourceId()),
    screenThumbnailSizes: screens.ok ? screens.value.map((entry) => entry.thumbnail.getSize()) : screens.error
  }
}

async function alignmentAt(ctx, zoom) {
  ctx.win.webContents.setZoomFactor(zoom)
  await wait(500)
  const placed = await placeView(ctx)
  await wait(700)
  const shot = await windowShot(ctx.win, `bounds-zoom-${zoom}`)
  const scale = scaleOf(ctx.win)
  /** A one-device-pixel fringe round the view is sub-pixel rounding, not misalignment. */
  const fringeLimit = Math.ceil(2 * (placed.viewBounds.width + placed.viewBounds.height) * scale)
  const onScreen = isBlank(shot.image) ? BLANK : { file: shot.file, deviceRect: shot.deviceRect, magenta: countColor(shot.image, MAGENTA), viewGreen: countColor(shot.image, [32, 160, 32]).count }
  return { ...placed, fringeLimit, onScreen, simulated: await simulatedComposite(ctx, `bounds-zoom-${zoom}-simulated`) }
}
/** On screen when the desktop is drawn; otherwise only the simulated composite can be judged, and the verdict says so. */
function boundsVerdict(zooms) {
  const drawn = zooms.every((entry) => typeof entry.onScreen === 'object')
  const aligned = zooms.every((entry) => (drawn ? entry.onScreen.viewGreen > 0 && entry.onScreen.magenta.count <= entry.fringeLimit : entry.simulated.magenta.count <= entry.fringeLimit))
  if (!aligned) return 'NO-GO'
  return drawn ? 'GO' : 'GO on geometry (simulated composite); on-screen alignment UNTESTED'
}
async function focusState(ctx) {
  const host = ctx.win.webContents
  return {
    windowFocused: ctx.win.isFocused(), hostContentsFocused: host.isFocused(), viewContentsFocused: ctx.wc.isFocused(),
    hostActiveElement: await host.executeJavaScript('document.activeElement?.id || document.activeElement?.tagName'),
    hostHasFocus: await host.executeJavaScript('document.hasFocus()'), viewHasFocus: await ctx.wc.executeJavaScript('document.hasFocus()')
  }
}
async function focusCase(ctx, name, act) {
  ctx.win.focus()
  ctx.win.webContents.focus()
  await ctx.win.webContents.executeJavaScript(`document.getElementById('composer').focus()`)
  await wait(250)
  const before = await focusState(ctx)
  await act()
  await wait(300)
  return { name, before, after: await focusState(ctx) }
}
async function probeFocus(ctx) {
  const dbg = ctx.wc.debugger
  const sendInput = async () => { for (const type of ['mouseDown', 'mouseUp']) ctx.wc.sendInputEvent({ type, x: 60, y: 60, button: 'left', clickCount: 1 }) }
  return [
    await focusCase(ctx, 'webContents.sendInputEvent click on the view (closest to a real click; no OS input is sent)', sendInput),
    await focusCase(ctx, 'CDP Input.dispatchMouseEvent click on the view', () => cdpClick(dbg, { x: 60, y: 60 })),
    await focusCase(ctx, 'CDP Input.insertText into the view', () => dbg.sendCommand('Input.insertText', { text: 'x' }))
  ]
}
async function probeBounds(ctx) {
  ctx.win.setAlwaysOnTop(true)
  const scale = scaleOf(ctx.win)
  const zooms = [await alignmentAt(ctx, 1), await alignmentAt(ctx, 1.25)]
  ctx.win.webContents.setZoomFactor(1)
  await wait(300)
  await placeView(ctx)
  const focus = await probeFocus(ctx)
  const desktopCapturerDiagnostic = await capturerDiagnostic(ctx.win)
  ctx.win.setAlwaysOnTop(false)
  const at100Percent = scale === 1 ? 'tested: the host is at 100%' : 'UNTESTED: the host is not at 100% and display settings are never changed'
  return { verdict: boundsVerdict(zooms), observations: { hostScaleFactor: scale, hostScalingPercent: Math.round(scale * 100), at100Percent, zooms, focus, desktopCapturerDiagnostic } }
}

/** Each overlay sits wholly inside the view's area; shot with the view shown and hidden, so a drawn element proves the test. */
const OVERLAYS = [
  { name: 'absolutely positioned menu (div, z-index 1000)', rgb: [0, 0, 255], open: `{ const d=document.createElement('div');d.id='ov';d.style.cssText='position:absolute;left:100px;top:150px;width:200px;height:120px;background:#0000ff;z-index:1000';document.body.append(d) }` },
  { name: 'modal <dialog> (showModal, top layer)', rgb: [255, 255, 0], open: `{ const d=document.createElement('dialog');d.id='ov';d.style.cssText='width:200px;height:120px;background:#ffff00;border:0;padding:0';document.body.append(d);d.showModal() }` },
  { name: 'position:fixed toast', rgb: [255, 128, 0], open: `{ const d=document.createElement('div');d.id='ov';d.style.cssText='position:fixed;left:300px;top:400px;width:150px;height:50px;background:#ff8000';document.body.append(d) }` },
  { name: '<select> picker (showPicker; a separate popup widget)', rgb: [0, 255, 255], open: `{ const s=document.createElement('select');s.id='ov';s.style.cssText='position:absolute;left:200px;top:200px;width:200px';s.innerHTML=Array.from({length:6},(_,i)=>'<option style="background:#00ffff">option '+i+'</option>').join('');document.body.append(s);s.focus();s.showPicker() }` }
]
async function overlayCase(ctx, overlay, index) {
  const host = ctx.win.webContents
  const opened = await settle(host.executeJavaScript(overlay.open, true))
  await wait(700)
  // The host page's own capture: proves the overlay is drawn in the renderer's surface, which the native view covers.
  const inRenderer = countColor(await host.capturePage(), overlay.rgb).count
  const shownShot = await windowShot(ctx.win, `overlay-${index}-view-shown`)
  ctx.view.setVisible(false)
  await wait(500)
  const hiddenShot = await windowShot(ctx.win, `overlay-${index}-view-hidden`)
  ctx.view.setVisible(true)
  await settle(host.executeJavaScript(`document.getElementById('ov')?.remove()`))
  await wait(300)
  const shown = countColor(shownShot.image, overlay.rgb).count
  const hidden = countColor(hiddenShot.image, overlay.rgb).count
  const blank = isBlank(shownShot.image) || isBlank(hiddenShot.image)
  const drawn = hidden === 0 ? 'inconclusive: not drawn even with the view hidden' : shown === 0 ? 'renders UNDER the view' : 'renders over the view'
  return { overlay: overlay.name, openError: opened.ok ? null : opened.error, pixelsInHostPageCapture: inRenderer, pixelsWithViewShown: shown, pixelsWithViewHidden: hidden, result: blank ? BLANK : drawn }
}
async function probeOverlay(ctx) {
  ctx.win.setAlwaysOnTop(true)
  const cases = []
  for (const [index, overlay] of OVERLAYS.entries()) cases.push(await overlayCase(ctx, overlay, index))
  ctx.win.setAlwaysOnTop(false)
  const under = cases.filter((entry) => entry.result.includes('UNDER')).map((entry) => entry.overlay)
  const untested = cases.every((entry) => entry.result === BLANK)
  return { verdict: untested ? 'UNTESTED on screen' : 'GO', observations: { cases, underneath: under, designRule: 'the panel hides the view (setVisible(false)) whenever a renderer dialog, menu or toast may overlap it' } }
}

async function main() {
  await app.whenReady()
  const ctx = await setup()
  const environment = { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, platform: process.platform, osRelease: release(), scaleFactor: scaleOf(ctx.win), fixtureOrigins: [ctx.a, ctx.b] }
  process.stdout.write(`${JSON.stringify({ item: 0, title: 'Environment', verdict: 'n/a', ms: 0, observations: environment })}\n`)
  await runItem(1, 'Debugger', () => probeDebugger(ctx))
  await runItem(6, 'IPC guard', () => probeIpc(ctx))
  await runItem(5, 'Isolation', () => probeIsolation(ctx))
  await runItem(7, 'Bounds, DPI and focus', () => probeBounds(ctx))
  await runItem(8, 'Overlay', () => probeOverlay(ctx))
  await runItem(3, 'Capture', () => probeCapture(ctx))
  await runItem(2, 'Detach', () => probeDetach(ctx))
  await runItem(4, 'Navigation events', () => probeNavigation(ctx))
  for (const server of ctx.list) server.close()
}

main().then(() => app.exit(0), (error) => {
  process.stderr.write(`browser probe failed: ${error instanceof Error ? error.stack : String(error)}\n`)
  app.exit(1)
})
