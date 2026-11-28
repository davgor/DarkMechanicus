/**
 * DM-1042 spike: DM-1041's recommended backend (OMP built-in computer use) against the overlay and the ESC hook.
 *
 *   node scripts/spike/desktop/omp-esc-probe.mjs --out <dir> [--omp <omp.exe>]
 *
 * Launches the fixture, the overlay, the hook helper and its controller, then `omp --mode rpc-ui` with DM-1041's argv
 * shape (temporary --config overlay with computer.enabled, unique temp root, --max-time / --max-cost caps; the global
 * OMP config is never written). The agent takes two silent desktop screenshots 4 s apart (the harness turns the
 * overlay's content protection on as soon as the first file appears), then presses Escape in the fixture. The harness
 * samples the border pixels of both OMP screenshot files and deletes every `%TEMP%/omp-computer-*.png` the run
 * wrote. It checks that OMP's Escape reached the hook as injected without firing the kill and reached the fixture,
 * then runs the kill on the live OMP process tree (taskkill /T /F) and records how long the tree and the overlay took
 * to go. Writes omp-esc-probe.json and a redacted transcript. Imported by no product code.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { cleanEnv, killTree, launchFixture, waitFor } from './fixture.mjs'
import { summarize } from './omp-transcript.mjs'
import { controller, nowNs, pidAlive, startHook, startOverlay } from './overlay/control.mjs'

const flag = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at === -1 ? fallback : process.argv[at + 1] }
const OUT = resolve(flag('out'))
const OMP = flag('omp', join(homedir(), 'AppData', 'Local', 'omp', 'omp.exe'))
const TITLE = 'DM-1042 fixture OMP'
const LIMIT_MS = 9 * 60_000
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
mkdirSync(OUT, { recursive: true })

const OVERLAY = ['setupVersion: 3', 'computer:', '  enabled: true', '  display: all', ''].join('\n')
const INSTRUCTIONS = `You are running a bounded desktop-control probe (DM-1042) for Dark Mechanicus.
Act only on the window titled exactly "${TITLE}"; it is a test fixture the probe launched. Never send input to any other
window, to the desktop root or to a display target. Use only the eval tool (JavaScript) and its computer prelude.`
const PROMPT = `Run exactly this in ONE eval cell (JavaScript), then stop and reply "done":
await computer.display("all");
const t0 = Date.now();
const a = await computer.screenshot({ silent: true });
await new Promise((r) => setTimeout(r, 4000));
const b = await computer.screenshot({ silent: true });
const win = await computer.window({ title: "${TITLE}" });
const t1 = Date.now();
await win.press("escape");
const t2 = Date.now();
print("PROBE_RESULT " + JSON.stringify({ a: { w: a.width, h: a.height }, b: { w: b.width, h: b.height }, pressMs: t2 - t1, totalMs: t2 - t0 }));
Do not look at the screenshots: they show the person's own windows.`

let nextId = 0
const id = () => `probe-${++nextId}`

function answerFor(request) {
  const base = { type: 'extension_ui_response', id: request.id }
  if (request.method === 'confirm') return { ...base, confirmed: true }
  if (request.method === 'select') return { ...base, value: request.options?.[0] ?? '' }
  if (request.method === 'input' || request.method === 'editor') return { ...base, value: '' }
  return null
}

function chunker() {
  let parts = []
  return (frame) => {
    if (frame.type !== 'rpc_chunk') return frame
    parts[frame.index] = Buffer.from(frame.data, 'base64')
    if (frame.index + 1 < frame.count) return null
    const whole = JSON.parse(Buffer.concat(parts).toString('utf8'))
    parts = []
    return whole
  }
}

const ompShots = (since) => readdirSync(tmpdir()).filter((name) => /^omp-computer-.*\.png$/u.test(name)).map((name) => join(tmpdir(), name)).filter((path) => statSync(path).mtimeMs >= since)

/** Starts OMP; resolves `settled` once the prompt has a result. The caller kills the tree afterwards. */
function startOmp(root, record) {
  writeFileSync(join(root, 'instructions.md'), INSTRUCTIONS)
  writeFileSync(join(root, 'config.yml'), OVERLAY)
  const args = ['--mode', 'rpc-ui', '--cwd', root, '--append-system-prompt', join(root, 'instructions.md'), '--config', join(root, 'config.yml'),
    '--session-dir', join(root, 'sessions'), '--max-time', '8m', '--max-cost', '2']
  record.argv = ['omp', ...args.map((value) => value.replaceAll(root, '<probe-root>'))]
  const child = spawn(OMP, args, { cwd: root, env: cleanEnv(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const frames = []
  const send = (frame) => { child.stdin.write(`${JSON.stringify(frame)}\n`); frames.push({ at: new Date().toISOString(), dir: 'in', frame }) }
  const decode = chunker()
  const ids = { status: id(), prompt: id() }
  let buffer = ''
  const settled = new Promise((done) => {
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines.filter((entry) => entry.trim())) {
        const frame = decode(JSON.parse(line))
        if (!frame) continue
        frames.push({ at: new Date().toISOString(), dir: 'out', frame })
        if (onFrame(frame, { send, ids, record })) done()
      }
    })
    child.on('exit', (code) => { record.ompExit = code; done() })
  })
  return { child, frames, settled }
}

/** Reacts to one OMP frame; returns true once the probe prompt has its result. */
function onFrame(frame, { send, ids, record }) {
  if (frame.type === 'ready') {
    for (const command of [{ type: 'negotiate_protocol', protocolVersion: 2 }, { type: 'set_event_filter', events: null, messageUpdates: 'delta' }]) send({ ...command, id: id() })
    send({ type: 'prompt', id: ids.status, message: '/computer status' })
    send({ type: 'prompt', id: ids.prompt, message: PROMPT })
  }
  if (frame.type === 'command_output') record.computerStatus = String(frame.text ?? '').split('\n')[0]
  if (frame.type === 'extension_ui_request') { const answer = answerFor(frame); if (answer) send(answer) }
  if (frame.type !== 'prompt_result' || frame.id !== ids.prompt) return false
  record.promptResult = { status: frame.status, sessionSettled: frame.sessionSettled, error: frame.error ?? null }
  return true
}

/** What reached the fixture and the hook, and the border pixels of each OMP screenshot file. */
async function inspect(record, { fixture, hook, overlay, ctl, since }) {
  record.fixtureAfter = (await waitFor(fixture, (s) => s.keys.some((k) => k.key === 'Escape'), 3000)).keys
  record.escapesSeenByHook = hook.lines.filter((line) => line.type === 'key' && line.vk === 0x1b && line.down).map(({ injected, own, kind, lagMs }) => ({ injected, own, kind, lagMs }))
  record.killFiredBeforeOurKill = ctl.state.killed !== null
  const shots = ompShots(since).sort((x, y) => statSync(x).mtimeMs - statSync(y).mtimeMs)
  record.ompScreenshots = []
  for (const path of shots) {
    overlay.send({ cmd: 'sample', path })
    const sampled = await overlay.next((line) => line.sampled === path, 20_000)
    record.ompScreenshots.push({ name: path.split(/[\\/]/u).pop(), width: sampled.width, height: sampled.height, redPoints: sampled.redPoints, points: sampled.points, protectedWhenTaken: statSync(path).mtimeMs >= Date.parse(record.protectOnAt ?? '9999') })
  }
}

async function main() {
  const record = { startedAt: new Date().toISOString() }
  const root = mkdtempSync(join(tmpdir(), 'dm1042-omp-'))
  const fixture = await launchFixture(TITLE)
  const overlay = await startOverlay()
  const hook = await startHook()
  const since = Date.now()
  const omp = startOmp(root, record)
  const ctl = controller({ overlay, hook, tree: omp })
  // Content protection goes on as soon as OMP's first screenshot file exists; the second is then protected.
  const toggler = setInterval(() => {
    if (record.protectOnAt || ompShots(since).length === 0) return
    record.protectOnAt = new Date().toISOString()
    overlay.send({ cmd: 'protect', on: true })
  }, 50)
  const timer = setTimeout(() => killTree(omp.child), LIMIT_MS)
  try {
    await omp.settled
    clearInterval(toggler)
    await sleep(500)
    await inspect(record, { fixture, hook, overlay, ctl, since })
    record.ompPidAliveBeforeKill = pidAlive(omp.child.pid)
    ctl.kill('simulated-physical-esc', { qpcNs: String(nowNs()) })
    record.kill = await ctl.killed
    record.kill.ompPidAliveAfter = pidAlive(omp.child.pid)
  } finally {
    clearTimeout(timer)
    clearInterval(toggler)
    killTree(omp.child)
    hook.send('quit')
    overlay.send({ cmd: 'close' })
    fixture.close()
    overlay.cleanup()
    record.removedOmpScreenshots = ompShots(since).map((path) => { rmSync(path, { force: true }); return path.split(/[\\/]/u).pop() })
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
  }
  record.summary = summarize(omp.frames, join(OUT, 'omp-esc.rpc.redacted.jsonl'))
  record.endedAt = new Date().toISOString()
  writeFileSync(join(OUT, 'omp-esc-probe.json'), JSON.stringify(record, null, 2))
  process.stdout.write(`${JSON.stringify({ promptResult: record.promptResult, status: record.computerStatus, escapes: record.escapesSeenByHook, fixtureKeys: record.fixtureAfter?.map((k) => k.key), shots: record.ompScreenshots?.map((s) => [s.width, s.redPoints, s.protectedWhenTaken]), kill: record.kill && { reason: record.kill.reason, overlayClosedMs: record.kill.overlayClosedMs, treeEndedMs: record.kill.treeEndedMs, ompAlive: record.kill.ompPidAliveAfter } })}\n`)
}

await main()
