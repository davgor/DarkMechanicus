/**
 * DM-1041 throwaway probe of candidate B, vercel-labs agent-desktop v1.3.1, against the Electron fixture window.
 * `node scripts/spike/desktop/agent-desktop-probe.mjs --exe <agent-desktop.exe> --out <dir>` runs the observations of
 * the ticket in order (whole-desktop screenshot, window screenshot, UI snapshot, click, type, injected ESC) and times
 * every command. The exe is the release asset the caller downloaded and verified; its state root is redirected into
 * `--out` (AGENT_DESKTOP_HOME). Physical keystrokes are sent only after the foreground window is checked to be the
 * fixture. Prints and writes `agent-desktop-probe.json`. Imported by no product code.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { captureDesktop, cleanEnv, cropPng, foreground, inside, launchFixture, powershell, waitFor } from './fixture.mjs'

const flag = (name) => { const at = process.argv.indexOf(`--${name}`); return at === -1 ? undefined : process.argv[at + 1] }
const EXE = resolve(flag('exe'))
const OUT = resolve(flag('out'))
mkdirSync(OUT, { recursive: true })
const ENV = cleanEnv({ AGENT_DESKTOP_HOME: join(OUT, 'agent-desktop-home') })
const FORCE_A11Y = process.argv.includes('--force-a11y')
const records = []

/** One agent-desktop command: its argv, wall time (process start included), exit code and parsed JSON envelope. */
function ad(step, args) {
  const started = performance.now()
  const run = spawnSync(EXE, args, { env: ENV, encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 })
  const ms = Math.round(performance.now() - started)
  let envelope = null
  try { envelope = JSON.parse(run.stdout) } catch { envelope = null }
  const record = { step, argv: ['agent-desktop', ...args], ms, exit: run.status, ok: envelope?.ok ?? false, error: envelope?.error ?? (run.error ? String(run.error) : undefined) }
  records.push(record)
  process.stdout.write(`${JSON.stringify({ step, ms, exit: run.status, ok: record.ok, error: record.error?.code ?? record.error })}\n`)
  return { record, data: envelope?.data, stderr: run.stderr }
}

/** Every node of a snapshot tree, depth first. */
function nodes(tree, list = []) {
  if (!tree || typeof tree !== 'object') return list
  list.push(tree)
  for (const child of tree.children ?? []) nodes(child, list)
  return list
}

function treeOf(data) {
  return data?.tree ?? data?.root ?? data?.snapshot ?? data
}

const named = (all, role, name) => all.find((node) => String(node.role ?? '').toLowerCase().includes(role) && String(node.name ?? '').toLowerCase().includes(name))

function fixtureWindow(list, title) {
  const windows = list?.windows ?? list ?? []
  return windows.find((win) => String(win.title ?? '').includes(title))
}

async function observeScreens(fixture) {
  const physical = fixture.read().bounds.physical
  const screen = ad('whole-desktop screenshot (screen 0)', ['screenshot', '--screen', '0', join(OUT, 'b-desktop-full.png')])
  screen.record.crop = cropPng(join(OUT, 'b-desktop-full.png'), join(OUT, 'b-desktop-cropped-to-fixture.png'), physical)
  // The full capture shows the person's own windows: only the crop to the fixture is kept.
  rmSync(join(OUT, 'b-desktop-full.png'), { force: true })
  ad('list-displays', ['list-displays']).record.displays = undefined
  const listed = ad('list-windows', ['list-windows'])
  const win = fixtureWindow(listed.data, fixture.title)
  listed.record.fixtureWindow = win ?? null
  if (win) ad('window screenshot (fixture only)', ['screenshot', '--window-id', String(win.id), join(OUT, 'b-window.png')])
  return win
}

/** One snapshot: Chromium builds its UIA tree only after first contact (10-25 s cold), so the budget covers the settle. */
function snapshotOnce(win, label, extra) {
  const snap = ad(label, ['snapshot', '--window-id', String(win.id), '--include-bounds', ...extra])
  const all = nodes(treeOf(snap.data))
  const button = named(all, 'button', 'probe button')
  const input = all.find((node) => /edit|text/iu.test(String(node.role ?? '')) && /probe input/iu.test(String(node.name ?? '')))
  snap.record.nodeCount = all.length
  snap.record.complete = snap.data?.complete ?? null
  snap.record.refCount = snap.data?.ref_count ?? null
  snap.record.button = button ? { ref_id: button.ref_id, role: button.role, name: button.name, bounds: button.bounds } : null
  snap.record.input = input ? { ref_id: input.ref_id, role: input.role, name: input.name, bounds: input.bounds } : null
  return { button, input, data: snap.data, record: snap.record }
}

/** A shallow skeleton first, then the full tree the ref actions need (the agent-desktop Electron guidance). */
function snapshot(win) {
  const skeleton = snapshotOnce(win, 'UI snapshot, skeleton', ['--skeleton', '--timeout-ms', '10000'])
  writeFileSync(join(OUT, 'b-snapshot-skeleton.json'), JSON.stringify(skeleton.data ?? null, null, 2))
  const full = snapshotOnce(win, 'UI snapshot, full tree', ['--timeout-ms', '30000', '--max-depth', '40'])
  writeFileSync(join(OUT, 'b-snapshot.json'), JSON.stringify(full.data ?? null, null, 2))
  return full
}

/** Refuses (and records the refusal) unless the fixture window is the foreground window. */
function fixtureInFront(fixture, step) {
  const front = foreground()
  const state = fixture.read()
  const ok = front.hwnd === state.hwnd || front.pid === state.pid
  records.push({ step: `foreground check before ${step}`, front, fixture: { hwnd: state.hwnd, pid: state.pid }, ok })
  return ok
}

async function escapes(fixture, win) {
  const headless = ad('press escape (headless, --window-id)', ['press', 'escape', '--window-id', String(win.id)])
  headless.record.readBack = (await waitFor(fixture, (s) => s.keys.some((k) => k.key === 'Escape'), 2000)).keys
  if (!fixtureInFront(fixture, 'escape')) return
  const before = fixture.read().keys.filter((k) => k.key === 'Escape').length
  const headed = ad('press escape (--headed, --window-id)', ['--headed', 'press', 'escape', '--window-id', String(win.id)])
  headed.record.readBack = (await waitFor(fixture, (s) => s.keys.filter((k) => k.key === 'Escape').length > before, 2000)).keys
}

/** The ref route: UIA press on the button, then SendInput typing into the field (agent-desktop's own contract). */
async function actByRef(fixture, found) {
  const click = ad('click Probe button (UIA press, headless)', ['click', found.button.ref_id])
  click.record.readBack = (await waitFor(fixture, (s) => s.clicks >= 1)).clicks
  if (!fixtureInFront(fixture, 'type')) return
  const typed = ad('type "hello" into Probe input (--headed, SendInput)', ['--headed', 'type', found.input.ref_id, 'hello'])
  typed.record.readBack = (await waitFor(fixture, (s) => s.text === 'hello')).text
}

/**
 * The coordinate route, used when agent-desktop cannot produce refs for the window: the button's centre comes from the
 * in-box UIA read (`uia-tree.ps1`), is checked against the fixture's bounds, and is clicked with `--headed
 * mouse-click`; the click focuses the field, and the text goes out key by key with `--headed press`.
 */
async function actByPoint(fixture, win) {
  const uia = powershell('uia-tree.ps1', ['-Hwnd', String(fixture.read().hwnd)])
  records.push({ step: 'locate targets with in-box UIA (agent-desktop gave no refs)', uia })
  const b = uia.found?.['Probe button']
  const point = b && { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
  if (!point || !inside(fixture.read().bounds.physical, point.x, point.y) || !fixtureInFront(fixture, 'mouse-click')) return null
  const click = ad('mouse-click Probe button centre (--headed)', ['--headed', 'mouse-click', '--xy', `${point.x},${point.y}`])
  click.record.readBack = (await waitFor(fixture, (s) => s.clicks >= 1)).clicks
  for (const letter of 'hello') {
    if (!fixtureInFront(fixture, `press ${letter}`)) return point
    ad(`press ${letter} (--headed, --window-id)`, ['--headed', 'press', letter, '--window-id', String(win.id)])
  }
  records.at(-1).readBack = (await waitFor(fixture, (s) => s.text === 'hello')).text
  return point
}

/** Every point an action used must lie inside the fixture window's physical bounds. */
function checkTargets(fixture, found, clicked) {
  const rect = fixture.read().bounds.physical
  const centre = (b) => b && { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  const points = [['button', centre(found.button?.bounds)], ['input', centre(found.input?.bounds)], ['mouse-click', clicked]]
  return points.filter(([, point]) => point).map(([target, point]) => ({ target, point, window: rect, inside: inside(rect, point.x, point.y) }))
}

async function main() {
  ad('version', ['version'])
  ad('status', ['status'])
  ad('permissions', ['permissions'])
  const fixture = await launchFixture('DM-1041 fixture B', { forceA11y: FORCE_A11Y })
  records.push({ step: 'fixture launched', forceRendererAccessibility: FORCE_A11Y })
  const result = { startedAt: new Date().toISOString(), records, baseline: null, targets: null, finalState: null }
  try {
    // Let the window's show animation and the fixture's re-raises finish, or the capture shows what lies behind it.
    await new Promise((done) => setTimeout(done, 3500))
    result.baseline = captureDesktop(join(OUT, 'baseline-desktop-full.png'))
    rmSync(join(OUT, 'baseline-desktop-full.png'), { force: true })
    const win = await observeScreens(fixture)
    if (!win) throw new Error('agent-desktop list-windows did not list the fixture window.')
    const found = snapshot(win)
    let clicked = null
    if (found.button && found.input) await actByRef(fixture, found)
    else clicked = await actByPoint(fixture, win)
    await escapes(fixture, win)
    result.targets = checkTargets(fixture, found, clicked)
    ad('window screenshot after actions (fixture only)', ['screenshot', '--window-id', String(win.id), join(OUT, 'b-window-after.png')])
    result.finalState = fixture.read()
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
  } finally {
    fixture.close()
  }
  result.endedAt = new Date().toISOString()
  writeFileSync(join(OUT, 'agent-desktop-probe.json'), JSON.stringify(result, null, 2))
  process.stdout.write(`${JSON.stringify({ done: true, error: result.error ?? null, targets: result.targets })}\n`)
}

await main()
