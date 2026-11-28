'use strict'
/**
 * DM-1041 throwaway desktop-control fixture, Electron side. `scripts/spike/desktop/fixture.mjs` spawns it with the
 * repo's Electron in a temporary profile. It shows one small always-on-top window with a "Probe button" and a
 * "Probe input" text box, and records what reaches it: button clicks, the input's text and every keydown (Escape
 * included). Each change is written to `--state` as JSON and printed as one `{"fixture":...}` line on stdout, together
 * with the window's bounds in DIPs and in physical screen pixels, so a probe can check that its coordinates fall inside
 * the window. Imported by no product code. It sends no input of its own.
 */
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const { writeFileSync } = require('node:fs')

const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const STATE = arg('state')
const TITLE = arg('title') ?? 'DM-1041 fixture'
const state = { title: TITLE, ready: false, clicks: 0, text: '', keys: [], bounds: null, hwnd: null, pid: process.pid }

app.setPath('userData', arg('profile'))
app.on('window-all-closed', () => app.quit())
// `--force-a11y` adds Chromium's --force-renderer-accessibility switch, which agent-desktop suggests for thin trees.
if (process.argv.includes('--force-a11y')) app.commandLine.appendSwitch('force-renderer-accessibility')

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>${TITLE}</title>
<style>body{font:16px Segoe UI,sans-serif;margin:24px;background:#fdf6e3;color:#222}
button{font-size:18px;padding:10px 24px}input{font-size:18px;width:320px;padding:6px}
#status{margin-top:14px;font-family:Consolas,monospace}</style></head><body>
<h2 style="margin-top:0">${TITLE}</h2>
<p><button id="probe-button" aria-label="Probe button">Probe button</button></p>
<p><label for="probe-input">Probe input </label><input id="probe-input" aria-label="Probe input" autocomplete="off"></p>
<div id="status" role="status" aria-label="Probe status">clicks=0 text="" keys=</div>
<script>
const { ipcRenderer } = require('electron')
let clicks = 0; const keys = []
const input = document.getElementById('probe-input')
const status = document.getElementById('status')
const show = () => { status.textContent = 'clicks=' + clicks + ' text="' + input.value + '" keys=' + keys.slice(-6).join(',') }
document.getElementById('probe-button').addEventListener('click', () => { clicks++; show(); ipcRenderer.send('fx', { clicks }); input.focus() })
input.addEventListener('input', () => { show(); ipcRenderer.send('fx', { text: input.value }) })
document.addEventListener('keydown', (event) => { keys.push(event.key); show(); ipcRenderer.send('fx', { key: { key: event.key, trusted: event.isTrusted, at: Date.now() } }) }, true)
</script></body></html>`

function publish() {
  if (STATE) writeFileSync(STATE, JSON.stringify(state, null, 2))
  process.stdout.write(`${JSON.stringify({ fixture: state })}\n`)
}

function recordBounds(win) {
  const dip = win.getBounds()
  const content = win.getContentBounds()
  state.bounds = {
    dip,
    physical: screen.dipToScreenRect(win, dip),
    contentPhysical: screen.dipToScreenRect(win, content),
    scaleFactor: screen.getDisplayMatching(dip).scaleFactor
  }
  const handle = win.getNativeWindowHandle()
  state.hwnd = handle.length >= 8 ? Number(handle.readBigUInt64LE(0)) : handle.readUInt32LE(0)
}

function raise(win) {
  win.setAlwaysOnTop(true, 'screen-saver')
  win.moveTop()
  win.show()
  win.focus()
}

ipcMain.on('fx', (_event, change) => {
  if (typeof change.clicks === 'number') state.clicks = change.clicks
  if (typeof change.text === 'string') state.text = change.text
  if (change.key) state.keys.push(change.key)
  publish()
})

app.whenReady().then(async () => {
  app.setAccessibilitySupportEnabled(true)
  const win = new BrowserWindow({
    width: 560, height: 340, title: TITLE, show: false, autoHideMenuBar: true, backgroundColor: '#fdf6e3',
    webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false }
  })
  win.on('page-title-updated', (event) => event.preventDefault())
  win.on('move', () => { recordBounds(win); publish() })
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)
  win.center()
  raise(win)
  recordBounds(win)
  state.ready = true
  publish()
  // Re-assert the stacking a few times: the person's own always-on-top window must not cover the fixture (DM-851).
  for (const ms of [500, 1500, 3000]) setTimeout(() => { if (!win.isDestroyed()) raise(win) }, ms)
})
