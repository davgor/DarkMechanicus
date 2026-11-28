/**
 * DM-1041 throwaway helpers shared by the desktop-control probes: launch the Electron fixture window
 * (`fixture.electron.cjs`) in a temporary profile, read back what reached it, check a point against its bounds, crop a
 * screenshot to it, and test whether the Windows desktop is drawn at all (an RDP session that is minimized or
 * disconnected draws nothing). Imported by no product code.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const REPO = resolve(HERE, '..', '..', '..')
const require = createRequire(import.meta.url)

/** A filtered copy of the environment: no Electron or DM session variables reach a probe child. */
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra }
  for (const key of Object.keys(env)) if (/^(?:DM_SESSION_TOKEN|DM_DESKTOP_PIPE|DM_BROWSER_PIPE|ELECTRON_.*|NODE_OPTIONS)$/iu.test(key)) delete env[key]
  return env
}

export function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return
  spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/** Runs one of this folder's PowerShell scripts and parses the single JSON line it prints. */
export function powershell(script, args) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(HERE, script), ...args], { encoding: 'utf8', windowsHide: true })
  const line = result.stdout.trim().split('\n').pop() ?? ''
  try { return JSON.parse(line) } catch { return { error: `${script} exit ${result.status}: ${result.stdout}${result.stderr}`.trim() } }
}

/** Whole-desktop capture (every monitor, the virtual screen) with its timing and a non-black sample count. */
export const captureDesktop = (path) => powershell('screen.ps1', ['-Out', path])

/** The foreground window's handle and process id: physical keystrokes go only to the fixture when this is it. */
export const foreground = () => powershell('foreground.ps1', [])

/**
 * The visible frame of a Windows 11 window: its bounds include an invisible resize border (10 physical px at 150 %
 * on the sides and 11 at the bottom, measured against agent-desktop's own window capture of the fixture), and a crop
 * to the full bounds would show slivers of the windows behind it.
 */
export const visibleFrame = (rect) => ({ x: rect.x + 10, y: rect.y, width: rect.width - 20, height: rect.height - 11 })

/** Crops a PNG to the visible frame of a physical-pixel window rectangle in screen coordinates of the capture's origin. */
export function cropPng(source, target, rect, origin = { x: 0, y: 0 }) {
  const frame = visibleFrame(rect)
  return powershell('crop.ps1', ['-In', source, '-Out', target, '-X', String(frame.x - origin.x), '-Y', String(frame.y - origin.y), '-W', String(frame.width), '-H', String(frame.height)])
}

export function inside(rect, x, y) {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height
}

/** Launches the fixture and resolves once its window is shown, raised and has reported its bounds. */
export async function launchFixture(title, { limitMs = 30_000, forceA11y = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dm1041-fixture-'))
  const statePath = join(root, 'state.json')
  const args = [join(HERE, 'fixture.electron.cjs'), `--state=${statePath}`, `--title=${title}`, `--profile=${join(root, 'profile')}`, ...(forceA11y ? ['--force-a11y'] : [])]
  const child = spawn(require('electron'), args, {
    cwd: REPO, env: cleanEnv(), stdio: ['ignore', 'ignore', 'inherit'], windowsHide: false
  })
  const read = () => (existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null)
  const deadline = Date.now() + limitMs
  while (Date.now() < deadline && !read()?.ready) await sleep(200)
  if (!read()?.ready) {
    killTree(child)
    throw new Error(`The fixture window did not report ready within ${limitMs} ms.`)
  }
  const close = () => {
    killTree(child)
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
  return { child, title, statePath, read, close }
}

/** Polls the fixture state until `test` holds or `limitMs` passes; returns the last state either way. */
export async function waitFor(fixture, test, limitMs = 5_000) {
  const deadline = Date.now() + limitMs
  let current = fixture.read()
  while (Date.now() < deadline && !test(current)) {
    await sleep(100)
    current = fixture.read()
  }
  return current
}
