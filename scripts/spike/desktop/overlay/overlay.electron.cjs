'use strict'
/**
 * DM-1042 spike: the "agent in control" overlay, Electron side. One transparent, frameless, click-through,
 * non-focusable, always-on-top (`screen-saver` level) window per display draws a light red border and a top-centre
 * note. It re-asserts its stacking every 500 ms (`moveTop`, which does not activate a window) so that another
 * topmost window raised later cannot cover it, and rebuilds itself when a display is added, removed or changes scale.
 *
 * `control.mjs` spawns it with the repo's Electron. It reports on stdout as JSON lines and takes commands as JSON lines
 * on a loopback TCP socket whose port it prints first (`{"port":..}`): stdin of an Electron main process on Windows
 * did not deliver piped lines in this spike. Commands:
 *   {"cmd":"close"}                      destroy every overlay window, report {"closed":..} with the hrtime, then exit
 *   {"cmd":"protect","on":true|false}    setContentProtection on every overlay window
 *   {"cmd":"list"}                       report the windows (bounds, HWND, flags) and the displays
 *   {"cmd":"capture","save":..,"crop":{x,y,width,height}}  desktopCapturer whole-screen capture, border pixels sampled
 *   {"cmd":"sample","path":..}           sample the border pixels of a PNG another route captured
 * Times are process.hrtime.bigint() (QueryPerformanceCounter, the hook helper's clock). Imported by no product code.
 */
const { app, BrowserWindow, desktopCapturer, nativeImage, screen } = require('electron')
const { writeFileSync } = require('node:fs')
const net = require('node:net')
const readline = require('node:readline')

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const NOTE = 'A Skitarii agent is controlling the desktop \u2014 press Esc to stop'
const BORDER = 'rgba(255,64,64,0.85)'
let protect = process.argv.includes('--protect')
let windows = []
let reasserts = 0

const now = () => process.hrtime.bigint().toString()
const say = (value) => { try { process.stdout.write(`${JSON.stringify({ ...value, qpcNs: now() })}\n`) } catch { /* no reader */ } }

app.setPath('userData', arg('profile'))
app.disableHardwareAcceleration()
// The overlay never outlives its controller. This watch starts before anything else, so it holds even when stdout
// or the command socket never works: the parent process ending, or no controller connecting within 10 s, removes it.
const parent = Number(arg('parent'))
setInterval(() => { try { process.kill(parent, 0) } catch { close() } }, 250)
let connected = false
setTimeout(() => { if (!connected) close() }, 10_000)
app.on('window-all-closed', () => {})

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none}
#frame{position:fixed;inset:0;border:4px solid ${BORDER};box-sizing:border-box}
#note{position:fixed;top:4px;left:50%;transform:translateX(-50%);background:${BORDER};color:#fff;
font:600 13px 'Segoe UI',sans-serif;padding:3px 12px;border-radius:0 0 8px 8px;white-space:nowrap}
</style></head><body><div id="frame"></div><div id="note">${NOTE}</div></body></html>`

function hwnd(win) {
  const handle = win.getNativeWindowHandle()
  return handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0)
}

function describe() {
  return {
    windows: windows.filter((w) => !w.win.isDestroyed()).map(({ win, display }) => ({
      hwnd: hwnd(win), displayId: display.id, bounds: win.getBounds(), physical: screen.dipToScreenRect(win, win.getBounds()),
      alwaysOnTop: win.isAlwaysOnTop(), focusable: win.isFocusable(), focused: win.isFocused(), visible: win.isVisible(),
      contentProtection: protect
    })),
    displays: screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id })),
    reasserts
  }
}

async function open(display) {
  const win = new BrowserWindow({
    ...display.bounds, show: false, frame: false, transparent: true, backgroundColor: '#00000000', focusable: false,
    skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    hasShadow: false, alwaysOnTop: true, title: 'DM-1042 overlay', webPreferences: { sandbox: true }
  })
  win.setIgnoreMouseEvents(true)
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setContentProtection(protect)
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)
  win.setBounds(display.bounds)
  win.showInactive()
  return { win, display }
}

async function build(reason) {
  for (const { win } of windows) if (!win.isDestroyed()) win.destroy()
  windows = await Promise.all(screen.getAllDisplays().map(open))
  say({ overlay: 'shown', reason, ...describe() })
}

function close() {
  for (const { win } of windows) if (!win.isDestroyed()) win.destroy()
  say({ closed: true, remaining: windows.filter(({ win }) => !win.isDestroyed()).length })
  app.exit(0)
}

/** Border and note pixels of a capture whose (0,0) is the virtual screen's top-left, in physical pixels. */
function sample(image, origin = { x: 0, y: 0 }) {
  const { width, height } = image.getSize()
  const bitmap = image.toBitmap()
  const scaleX = width / origin.width
  const scaleY = height / origin.height
  const red = (x, y) => {
    const px = Math.min(width - 1, Math.max(0, Math.round(x)))
    const py = Math.min(height - 1, Math.max(0, Math.round(y)))
    const i = (py * width + px) * 4
    const [b, g, r] = [bitmap[i], bitmap[i + 1], bitmap[i + 2]]
    return { x: px, y: py, r, g, b, red: r >= 180 && r - g >= 70 && r - b >= 70 }
  }
  const points = []
  for (const { display } of windows) {
    const p = screen.dipToScreenRect(null, display.bounds)
    const sx = (p.x - origin.x) * scaleX
    const sy = (p.y - origin.y) * scaleY
    const w = p.width * scaleX
    const h = p.height * scaleY
    const edge = 2 * scaleX
    for (const f of [0.1, 0.3, 0.7, 0.9]) points.push({ where: 'top', ...red(sx + w * f, sy + edge) }, { where: 'bottom', ...red(sx + w * f, sy + h - 1 - edge) })
    for (const f of [0.2, 0.5, 0.8]) points.push({ where: 'left', ...red(sx + edge, sy + h * f) }, { where: 'right', ...red(sx + w - 1 - edge, sy + h * f) })
  }
  return { width, height, points: points.length, redPoints: points.filter((p) => p.red).length, samples: points }
}

async function capture({ save, crop }) {
  const primary = screen.getPrimaryDisplay()
  const physical = screen.dipToScreenRect(null, primary.bounds)
  const started = process.hrtime.bigint()
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: physical.width, height: physical.height } })
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  const source = sources.find((s) => s.display_id === String(primary.id)) ?? sources[0]
  const result = sample(source.thumbnail, physical)
  if (save) writeFileSync(save, (crop ? source.thumbnail.crop(crop) : source.thumbnail).toPNG())
  say({ capture: 'desktopCapturer', sources: sources.length, ms, protect, ...result })
}

function sampleFile(path) {
  const primary = screen.getPrimaryDisplay()
  const image = nativeImage.createFromPath(path)
  say({ sampled: path, protect, ...sample(image, screen.dipToScreenRect(null, primary.bounds)) })
}

async function onCommand(line) {
  const command = JSON.parse(line)
  if (command.cmd === 'close') return close()
  if (command.cmd === 'protect') {
    protect = command.on === true
    for (const { win } of windows) win.setContentProtection(protect)
    return say({ protect })
  }
  if (command.cmd === 'list') return say({ list: true, ...describe() })
  if (command.cmd === 'capture') return capture(command)
  if (command.cmd === 'sample') return sampleFile(command.path)
}

app.whenReady().then(async () => {
  await build('start')
  setInterval(() => {
    for (const { win } of windows) if (!win.isDestroyed()) { win.setAlwaysOnTop(true, 'screen-saver'); win.moveTop() }
    reasserts++
  }, 500)
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) {
    screen.on(event, () => { say({ displayEvent: event }); build(event) })
  }
  // The command socket closing (the controller gone) also removes it.
  const server = net.createServer((socket) => {
    connected = true
    const lines = readline.createInterface({ input: socket })
    lines.on('line', (line) => { onCommand(line).catch((error) => say({ error: String(error) })) })
    lines.on('close', () => close())
  })
  server.listen(0, '127.0.0.1', () => say({ port: server.address().port }))
})
