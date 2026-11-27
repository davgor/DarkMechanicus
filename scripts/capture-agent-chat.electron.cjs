/**
 * The Electron side of `capture-agent-chat.mjs`: for each state, a fresh hidden window of that state's content size
 * (1280×800 unless `--viewport` says otherwise; 1024×768 or 1440×900 for a `-1024` or `-1440` state) loads the preview URL,
 * waits (up to the per-state deadline) for `#observations[data-ready="1"]`, reads the observations, then writes
 * `capturePage()` to `<out>/<state>.png`. Each state's record goes to the parent over IPC; the parent judges it.
 * A parent that goes away closes the IPC channel, and the app then quits, so it never outlives the run.
 */
const { app, BrowserWindow, nativeImage, protocol } = require('electron')
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
// The app's chat images scheme, registered as main registers it, so composer and transcript thumbnails load in the
// preview. An image id ending `zz` stands for one whose file is gone: it answers 404, so the page shows its placeholder.
const CHAT_IMAGE_SCHEME = 'dm-chat-image'
protocol.registerSchemesAsPrivileged([{ scheme: CHAT_IMAGE_SCHEME, privileges: { standard: true, secure: true } }])
/** Thumbnail accents, picked by an image id's last character: brass, crimson, blue, green. */
const ACCENTS = [[214, 155, 74], [181, 26, 31], [74, 143, 214], [90, 164, 105]]
/** The accent boxes of a fixture screenshot as [top, bottom, left, right]: the title bar, then two text lines. */
const ACCENT_BOXES = [[0, 18, 0, 160], [32, 41, 12, 122], [50, 59, 12, 92]]
const accentAt = (x, y) => ACCENT_BOXES.some(([top, bottom, left, right]) => y >= top && y < bottom && x >= left && x < right)

/** A 160×100 PNG standing in for a staged screenshot: a dark window with an accent title bar and two text lines. */
function fixtureImage(imageId) {
  const width = 160
  const height = 100
  const [red, green, blue] = ACCENTS[imageId.charCodeAt(imageId.length - 1) % ACCENTS.length]
  const bitmap = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    // BGRA, as nativeImage takes a bitmap.
    for (let x = 0; x < width; x++) bitmap.set(accentAt(x, y) ? [blue, green, red, 255] : [21, 23, 27, 255], (y * width + x) * 4)
  }
  return nativeImage.createFromBitmap(bitmap, { width, height }).toPNG()
}

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

/** How many distinct colours a capture holds among up to 4096 pixels sampled on an even grid; a blank page holds one or two. */
function distinctColors(image) {
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 4096)))
  const colors = new Set()
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) colors.add(bitmap.readUInt32LE((y * width + x) * 4))
  }
  return colors.size
}

async function captureState({ state, viewport }) {
  const { width, height } = viewport
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
      state, ready: true, observations, empty: image.isEmpty(), bytes: png.length, file, colors: image.isEmpty() ? 0 : distinctColors(image),
      viewport: { width: pageWidth, height: pageHeight }, image: image.getSize()
    }
  } finally {
    window.destroy()
  }
}

app.whenReady().then(async () => {
  protocol.handle(CHAT_IMAGE_SCHEME, (request) => {
    const { pathname } = new URL(request.url)
    if (pathname.endsWith('zz')) return new Response(null, { status: 404 })
    return new Response(fixtureImage(pathname), { headers: { 'content-type': 'image/png' } })
  })
  send({ type: 'started', electron: process.versions.electron })
  for (const state of config.states) send({ type: 'state', record: await captureState(state) })
  app.exit(0)
}).catch((error) => {
  send({ type: 'fatal', error: error instanceof Error ? error.stack ?? error.message : String(error) })
  app.exit(1)
})

app.on('window-all-closed', () => { /* states open one at a time; the run quits on its own when done. */ })
