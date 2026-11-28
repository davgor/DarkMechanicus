/**
 * DM-1042 spike: the unattended overlay and kill-path probe.
 *
 *   node scripts/spike/desktop/overlay-probe.mjs --out <dir>
 *
 * 1. Overlay above fixtures: for a normal (top-centre), a maximized and a borderless-fullscreen fixture window, show
 *    the overlay, then record the z-ordered window list, the foreground window, a GDI desktop capture's border
 *    pixels (kept only as a crop to the fixture) and a click sent through the overlay onto the fixture's button.
 * 2. Content protection: desktopCapturer and GDI captures with setContentProtection off and on.
 * 3. SendInput Escape into the fixture with the hook running: reported injected, no kill, fixture receives it.
 * 4. Kill paths with a stand-in agent tree: a triggered kill, the hook helper killed, the heartbeat stopped.
 * 5. The hook helper and the overlay exit when their parent process dies.
 *
 * Writes overlay-probe.json and cropped PNGs to --out. Never sends a key or click unless the foreground window is the
 * fixture this probe launched. Imported by no product code.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureDesktop, cropPng, launchFixture, powershell, waitFor } from './fixture.mjs'
import { controller, injectEsc, msBetween, nowNs, pidAlive, startAgentTree, startHook, startOverlay } from './overlay/control.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const flag = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at === -1 ? fallback : process.argv[at + 1] }
const OUT = resolve(flag('out'))
const SCRATCH = mkdtempSync(join(tmpdir(), 'dm1042-probe-'))
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
mkdirSync(OUT, { recursive: true })
const record = { startedAt: new Date().toISOString(), modes: [], contentProtection: null, sendInputEscape: null, kills: {}, parentExit: null }
const log = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)

const windowList = (...pids) => powershell('windows.ps1', ['-Pids', pids.join(',')])

async function overlayCommand(overlay, command, test) {
  overlay.send(command)
  return overlay.next(test, 20_000)
}

/** A GDI capture of the whole desktop, sampled for the border, kept only as a crop to `rect`; the full PNG is deleted. */
async function gdiShot(overlay, name, rect) {
  const full = join(SCRATCH, `${name}-full.png`)
  const capture = captureDesktop(full)
  const sampled = await overlayCommand(overlay, { cmd: 'sample', path: full }, (line) => line.sampled === full)
  const crop = rect ? cropPng(full, join(OUT, `${name}.png`), { ...rect, height: rect.height + 11, x: rect.x - 10, width: rect.width + 20 }) : null
  rmSync(full, { force: true })
  return { captureMs: capture.captureMs, result: capture.result, nonBlack: capture.nonBlack, redPoints: sampled.redPoints, points: sampled.points, crop: crop && { ...crop, path: undefined } }
}

/** The crop rectangle (physical, screen origin) of a fixture: its visible frame, clamped to the display it fills. */
function fixtureRect(state, display) {
  const b = state.bounds.physical
  // A maximized window overhangs every screen edge by its invisible 11 px border; a normal one has it on 3 sides.
  const frame = state.mode === 'fullscreen' ? b
    : state.mode === 'maximized' ? { x: b.x + 11, y: b.y + 11, width: b.width - 22, height: b.height - 22 }
    : { x: b.x + 10, y: b.y, width: b.width - 20, height: b.height - 11 }
  const x = Math.max(display.x, frame.x)
  const y = Math.max(display.y, frame.y)
  return { x, y, width: Math.min(frame.x + frame.width, display.x + display.width) - x, height: Math.min(frame.y + frame.height, display.y + display.height) - y }
}

async function clickThrough(fixture) {
  const state = fixture.read()
  const fg = windowList(state.pid).foreground
  if (fg.pid !== state.pid) return { skipped: 'fixture not in front', foreground: fg }
  const point = state.buttonPhysical
  const sent = powershell('inject.ps1', ['-ClickX', String(point.x), '-ClickY', String(point.y)])
  const after = await waitFor(fixture, (s) => s.clicks >= 1, 3000)
  return { point, sent: sent.sent, clicksAfter: after.clicks }
}

async function probeMode(mode) {
  const fixture = await launchFixture(`DM-1042 fixture ${mode}`, { mode })
  const overlay = await startOverlay()
  await sleep(4500)
  const state = fixture.read()
  const entry = { mode, fixtureBounds: state.bounds.physical, maximized: state.maximized, fullScreen: state.fullScreen }
  entry.windows = windowList(state.pid, overlay.child.pid)
  entry.overlay = (await overlayCommand(overlay, { cmd: 'list' }, (line) => line.list === true))
  const rect = fixtureRect(state, overlay.shown.windows[0].physical)
  entry.gdi = await gdiShot(overlay, `overlay-over-${mode}`, rect)
  entry.click = await clickThrough(fixture)
  entry.foregroundAfterClick = windowList(state.pid).foreground
  if (mode === 'top') {
    record.contentProtection = await contentProtection(overlay, rect)
    record.sendInputEscape = await sendInputEscape(fixture, overlay)
  } else {
    overlay.send({ cmd: 'close' })
  }
  await overlay.exited
  overlay.cleanup()
  fixture.close()
  record.modes.push(entry)
  log({ mode, foreground: entry.windows.foreground, clicks: entry.click.clicksAfter, red: entry.gdi.redPoints })
}

async function contentProtection(overlay, rect) {
  const result = {}
  const crop = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  for (const on of [false, true]) {
    await overlayCommand(overlay, { cmd: 'protect', on }, (line) => line.protect === on && !('sampled' in line) && !('capture' in line))
    await sleep(700)
    const name = on ? 'protected' : 'unprotected'
    const dc = await overlayCommand(overlay, { cmd: 'capture', save: join(OUT, `desktopCapturer-${name}.png`), crop }, (line) => line.capture === 'desktopCapturer' && line.protect === on)
    const gdi = await gdiShot(overlay, `gdi-${name}`, crop)
    const list = windowList(overlay.child.pid)
    result[name] = { desktopCapturer: { ms: dc.ms, redPoints: dc.redPoints, points: dc.points }, gdi: { redPoints: gdi.redPoints, points: gdi.points, captureMs: gdi.captureMs }, displayAffinity: list.windows.map((w) => w.displayAffinity), overlayWindowsListed: list.windows.length }
  }
  await overlayCommand(overlay, { cmd: 'protect', on: false }, (line) => line.protect === false)
  return result
}

/** An untagged SendInput Escape from another process into the fixture, with the hook and its kill path running. */
async function sendInputEscape(fixture, overlay) {
  const hook = await startHook()
  const ctl = controller({ overlay, hook })
  await sleep(1500)
  const state = fixture.read()
  const fg = windowList(state.pid).foreground
  if (fg.pid !== state.pid) {
    await ctl.stop()
    return { skipped: 'fixture not in front', foreground: fg }
  }
  const sent = await injectEsc(0)
  const seen = await hook.next((line) => line.type === 'key' && line.vk === 0x1b && line.down && !line.own, 5000).catch(() => null)
  const after = await waitFor(fixture, (s) => s.keys.some((k) => k.key === 'Escape'), 3000)
  await sleep(1000)
  const result = {
    hookLine: seen, injectToCallbackMs: seen ? msBetween(sent.qpcNs, seen.qpcNs) : null, killFired: ctl.state.killed !== null,
    fixtureKeys: after.keys.map((k) => ({ key: k.key, trusted: k.trusted })), ignored: ctl.state.ignored
  }
  await ctl.stop()
  return result
}

/** One kill: overlay + hook + stand-in agent tree + controller, then `trigger(ctx)` starts the kill some way. */
async function measureKill(name, trigger) {
  const overlay = await startOverlay()
  const hook = await startHook()
  const tree = startAgentTree(hook.ready.pid, 10)
  await tree.started
  const ctl = controller({ overlay, hook, tree })
  await sleep(1500)
  const treePids = descendants(tree.child.pid)
  const triggeredNs = nowNs()
  await trigger({ ctl, hook, overlay, tree })
  const result = await Promise.race([ctl.killed, sleep(15_000).then(() => ({ timedOut: true }))])
  result.fromTriggerActionMs = result.overlayClosedNs ? msBetween(triggeredNs, result.overlayClosedNs) : msBetween(triggeredNs, result.overlayExitNs)
  result.treePids = treePids
  result.treePidsAliveAfter = treePids.filter(pidAlive)
  result.overlayWindowsAfter = windowList(overlay.child.pid).windows.length
  hook.send('quit')
  await Promise.race([hook.exited, sleep(3000)])
  if (pidAlive(hook.child.pid)) hook.child.kill()
  overlay.cleanup()
  record.kills[name] = result
  log({ kill: name, reason: result.reason, overlayClosedMs: result.overlayClosedMs, treeEndedMs: result.treeEndedMs, after: result.agentKeysAfterTreeEnded })
}

function descendants(pid) {
  const out = spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | % { "$($_.ProcessId) $($_.ParentProcessId)" }'], { encoding: 'utf8', windowsHide: true }).stdout
  const pairs = out.trim().split(/\r?\n/u).map((line) => line.trim().split(/\s+/u).map(Number))
  const found = [pid]
  for (let i = 0; i < found.length; i++) for (const [child, parent] of pairs) if (parent === found[i] && !found.includes(child)) found.push(child)
  return found
}

/** Polls until every named pid is gone (or 10 s pass); returns ms from `fromNs` per name. */
async function goneAfter(pids, fromNs) {
  const gone = {}
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && Object.keys(gone).length < Object.keys(pids).length) {
    for (const [name, pid] of Object.entries(pids)) if (!(name in gone) && !pidAlive(pid)) gone[name] = msBetween(fromNs, nowNs())
    await sleep(5)
  }
  for (const pid of Object.values(pids)) if (pidAlive(pid)) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
  return gone
}

/**
 * Job-bound: a stub node parent starts the helper and the overlay with child_process (as DM's main process would),
 * then is terminated. Node puts its children in a kill-on-close job ([INFERENCE] libuv), so the OS ends them with it.
 */
async function parentExitJobBound() {
  const control = new URL('./overlay/control.mjs', import.meta.url).href
  const script = `import { startHook, startOverlay } from ${JSON.stringify(control)}
const overlay = await startOverlay(); const hook = await startHook()
process.stdout.write(JSON.stringify({ hookPid: hook.ready.pid, overlayPid: overlay.child.pid }) + '\\n'); setInterval(() => {}, 1000)`
  const stub = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: HERE, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
  const pids = await new Promise((done) => stub.stdout.once('data', (chunk) => done(JSON.parse(String(chunk)))))
  await sleep(1500)
  const aliveBefore = Object.fromEntries(Object.entries(pids).map(([name, pid]) => [name, pidAlive(pid)]))
  const killedNs = nowNs()
  stub.kill()
  record.parentExit.jobBound = { stubPid: stub.pid, ...pids, aliveBefore, goneAfterMs: await goneAfter(pids, killedNs) }
}

/**
 * Own watch only: this probe starts the helper and the overlay (so no job ties them to the watched process) with
 * -ParentPid / --parent pointing at a separate idle process, then terminates that process. Only the helper's
 * WaitForExit thread and the overlay's 250 ms poll can end them; the helper reports why it exited.
 */
async function parentExitOwnWatch() {
  const parent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true })
  const overlay = await startOverlay({ parentPid: parent.pid })
  const hook = await startHook({ parentPid: parent.pid })
  await sleep(1500)
  const pids = { hookPid: hook.child.pid, overlayPid: overlay.child.pid }
  const aliveBefore = Object.fromEntries(Object.entries(pids).map(([name, pid]) => [name, pidAlive(pid)]))
  const killedNs = nowNs()
  parent.kill()
  const goneAfterMs = await goneAfter(pids, killedNs)
  const exitLine = hook.lines.find((line) => line.type === 'exit') ?? null
  overlay.cleanup()
  record.parentExit.ownWatch = {
    parentPid: parent.pid, ...pids, aliveBefore, goneAfterMs, hookExitReason: exitLine?.why ?? null,
    hookExitLineAfterMs: exitLine ? msBetween(killedNs, exitLine.qpcNs) : null
  }
}

async function main() {
  for (const mode of ['top', 'maximized', 'fullscreen']) await probeMode(mode)
  await measureKill('triggered', ({ ctl }) => { ctl.kill('simulated-physical-esc', { qpcNs: String(nowNs()) }) })
  await measureKill('hookHelperKilled', ({ hook }) => { spawnSync('taskkill.exe', ['/PID', String(hook.child.pid), '/F'], { windowsHide: true }) })
  await measureKill('heartbeatStopped', ({ hook }) => { hook.send('mute') })
  record.parentExit = {}
  await parentExitJobBound()
  await parentExitOwnWatch()
  log({ parentExit: record.parentExit })
  record.endedAt = new Date().toISOString()
  writeFileSync(join(OUT, 'overlay-probe.json'), JSON.stringify(record, null, 2))
  rmSync(SCRATCH, { recursive: true, force: true })
}

await main()
