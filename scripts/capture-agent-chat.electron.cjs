/**
 * The Electron side of `capture-agent-chat.mjs`: for each state, a fresh hidden window of the requested content size
 * (1280×800 unless `--viewport` says otherwise) loads the preview URL,
 * waits (up to the per-state deadline) for `#observations[data-ready="1"]`, reads the observations, then writes
 * `capturePage()` to `<out>/<state>.png`. Each state's record goes to the parent over IPC; the parent judges it.
 * A parent that goes away closes the IPC channel, and the app then quits, so it never outlives the run.
 */
const { app, BrowserWindow } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const VIEWPORT_SIZE = '[window.innerWidth, window.innerHeight]'
const READY = `(() => {
  const node = document.querySelector('#observations[data-ready="1"]')
  return node === null ? null : node.textContent
})()`

const flag = process.argv.find((arg) => arg.startsWith('--capture-config='))
const config = JSON.parse(Buffer.from(flag.slice('--capture-config='.length), 'base64').toString('utf8'))

const send = (message) => process.send?.(message)
process.on('disconnect', () => app.exit(1))
// Display scaling (150% on the Windows host) rounds a hidden window's content to whole device pixels (800 CSS px
// became 802); at scale 1 the page is exactly the requested size and the PNG the same on every host.
app.commandLine.appendSwitch('force-device-scale-factor', '1')

function sleep(ms) {
  const { promise, resolve } = Promise.withResolvers()
  setTimeout(resolve, ms)
  return promise
}

async function waitForObservations(window) {
  const deadline = Date.now() + config.deadlineMs
  while (Date.now() < deadline) {
    const raw = await window.webContents.executeJavaScript(READY, true).catch(() => null)
    if (raw !== null) return JSON.parse(raw)
    await sleep(100)
  }
  return null
}

async function captureState(state) {
  const { width, height } = config.viewport
  // Offscreen rendering keeps painting while hidden, so `capturePage()` shows the reached state rather than the first
  // frame, and the page's viewport is exactly the requested size (no native frame or display scaling in between).
  const window = new BrowserWindow({
    show: false, width, height, paintWhenInitiallyHidden: true, useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  try {
    const url = `${config.base}?state=${encodeURIComponent(state)}`
    const loaded = window.loadURL(url).then(() => null, (error) => error.message)
    const observations = await waitForObservations(window)
    if (observations === null) {
      const failedLoad = await Promise.race([loaded, sleep(0)])
      const errors = await window.webContents.executeJavaScript('JSON.stringify(window.__errors ?? [])', true).catch(() => '[]')
      const pageErrors = JSON.parse(errors)
      const detail = failedLoad ?? `no observations within ${config.deadlineMs} ms`
      return { state, ready: false, error: pageErrors.length === 0 ? detail : `${detail}; page errors: ${pageErrors.join(' | ')}` }
    }
    const [pageWidth, pageHeight] = await window.webContents.executeJavaScript(VIEWPORT_SIZE, true)
    const image = await window.webContents.capturePage()
    const png = image.toPNG()
    const file = join(config.out, `${state}.png`)
    if (!image.isEmpty()) writeFileSync(file, png)
    return {
      state, ready: true, observations, empty: image.isEmpty(), bytes: png.length, file,
      viewport: { width: pageWidth, height: pageHeight }, image: image.getSize()
    }
  } finally {
    window.destroy()
  }
}

app.whenReady().then(async () => {
  send({ type: 'started', electron: process.versions.electron })
  for (const state of config.states) send({ type: 'state', record: await captureState(state) })
  app.exit(0)
}).catch((error) => {
  send({ type: 'fatal', error: error instanceof Error ? error.stack ?? error.message : String(error) })
  app.exit(1)
})

app.on('window-all-closed', () => { /* states open one at a time; the run quits on its own when done. */ })
