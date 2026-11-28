/**
 * DM-851 throwaway probe launcher: `node scripts/spike/browser-probe.mjs [--out <dir>]` spawns the repo's Electron
 * with `browser-probe.electron.cjs`, in a temporary profile deleted afterwards, with the environment filtered as
 * `scripts/first-prompt-smoke.mjs` filters it. It prints every probe item's record, checks the view's sender URL
 * against the app's real IPC guard (`src/main/ipcGuard.ts`), and writes `probe-output.json` and the PNGs to the
 * output directory. Exit 0 only when Electron ran every item; the verdicts are in the records. Imported by no
 * product code.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildSync } from 'esbuild'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ENTRY = join(REPO, 'scripts', 'spike', 'browser-probe.electron.cjs')
/** A declared bound for the whole Electron run: 8 items at up to 45 s each, plus start-up. */
const OVERALL_LIMIT_MS = 420_000
const ITEMS = [1, 2, 3, 4, 5, 6, 7, 8]
const require = createRequire(import.meta.url)
const electron = require('electron')

const outFlag = process.argv.indexOf('--out')
const out = outFlag === -1 ? mkdtempSync(join(tmpdir(), 'dm-browser-probe-out-')) : resolve(process.argv[outFlag + 1])
mkdirSync(out, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'dm-browser-probe-profile-'))

const env = { ...process.env }
for (const key of Object.keys(env)) if (/^(?:DM_SESSION_TOKEN|DM_DESKTOP_PIPE|DM_BROWSER_PIPE|ELECTRON_.*|NODE_OPTIONS)$/iu.test(key)) delete env[key]

function killTree(child) {
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
  else child.kill('SIGKILL')
}

/** The view's top-level frame URL through the app's own guard, for the dev-server and packaged app URLs. */
function guardCheck(senderUrl) {
  const bundle = join(profile, 'ipcGuard.cjs')
  buildSync({ entryPoints: [join(REPO, 'src', 'main', 'ipcGuard.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, external: ['electron'], logLevel: 'silent' })
  const { isTrustedSender } = require(bundle)
  const frame = { url: senderUrl, parent: null, detached: false, isDestroyed: () => false }
  const appUrls = ['http://localhost:5173/', pathToFileURL(join(REPO, 'out', 'renderer', 'index.html')).href]
  return appUrls.map((appUrl) => ({ appUrl, trusted: isTrustedSender(frame, appUrl) }))
}

function runElectron(records) {
  const child = spawn(electron, [ENTRY, `--out=${out}`, `--profile=${profile}`], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true })
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines.map((entry) => entry.trim()).filter(Boolean)) {
      if (line.startsWith('{"item"')) records.push(JSON.parse(line))
      else process.stdout.write(`[electron] ${line}\n`)
    }
  })
  const timer = setTimeout(() => { process.stderr.write(`browser probe: no exit within ${OVERALL_LIMIT_MS} ms; killing Electron\n`); killTree(child) }, OVERALL_LIMIT_MS)
  return new Promise((resolveExit) => child.on('exit', (code) => { clearTimeout(timer); resolveExit(code) }))
}

function addGuard(records) {
  const ipc = records.find((record) => record.item === 6)
  if (ipc?.observations.senderFrame === undefined) return
  const guard = guardCheck(ipc.observations.senderFrame.url)
  ipc.observations.guardIpc = guard
  if (guard.some((entry) => entry.trusted)) ipc.verdict = 'NO-GO'
}

const records = []
const exitCode = await runElectron(records)
addGuard(records)
records.sort((left, right) => left.item - right.item)
for (const record of records) process.stdout.write(`\n## Item ${record.item}: ${record.title} -> ${record.verdict} (${record.ms} ms)\n${JSON.stringify(record.observations, null, 2)}\n`)
const missing = ITEMS.filter((item) => !records.some((record) => record.item === item))
writeFileSync(join(out, 'probe-output.json'), `${JSON.stringify({ exitCode, missing, records }, null, 2)}\n`)
process.stdout.write(`\nSummary: ${records.filter((record) => record.item > 0).map((record) => `${record.item}=${record.verdict}`).join(' ')}; Electron exit ${exitCode}; missing items: ${missing.join(',') || 'none'}\nOutput: ${out}\n`)
rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
process.exitCode = exitCode === 0 && missing.length === 0 ? 0 : 1
