/**
 * DM-1041 throwaway probe of candidate A, OMP's built-in computer use, driven the way a Skitarii GUI chat drives OMP.
 * `node scripts/spike/desktop/omp-computer-probe.mjs --out <dir> [--omp <omp.exe>]` launches the Electron fixture,
 * then `omp --mode rpc-ui` with the argv shape of `src/main/agentChat/agentChatLaunch.ts` (`--cwd`,
 * `--append-system-prompt`, `--config <overlay>`, `--session-dir`) under a unique temp root, plus OMP's own
 * `--max-time` and `--max-cost` caps. The temporary overlay turns `computer.enabled` on for this one session; the
 * global OMP config is never written. The harness answers every UI request itself, sends `/computer status` and then
 * one fixed prompt, and records every stdout frame. Writes `rpc-transcript.raw.jsonl` (local only, never committed),
 * `rpc-transcript.redacted.jsonl` (images and secrets replaced) and `omp-computer-probe.json`. Imported by no product
 * code.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { captureDesktop, cleanEnv, cropPng, killTree, launchFixture, waitFor } from './fixture.mjs'
import { coordinateChecks, summarize } from './omp-transcript.mjs'

const flag = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at === -1 ? fallback : process.argv[at + 1] }
const OUT = resolve(flag('out'))
const OMP = flag('omp', join(homedir(), 'AppData', 'Local', 'omp', 'omp.exe'))
const TITLE = 'DM-1041 fixture A'
const MAX_TIME = '12m'
const MAX_COST = '4'
/** The harness's own bound on the whole session: OMP's --max-time plus shutdown. */
const LIMIT_MS = 13 * 60_000
mkdirSync(OUT, { recursive: true })

const OVERLAY = ['setupVersion: 3', 'computer:', '  enabled: true', '  display: all', ''].join('\n')

const INSTRUCTIONS = `You are running a bounded desktop-control probe (DM-1041) for Dark Mechanicus.
Act only on the window titled exactly "${TITLE}"; it is a test fixture the probe launched. Never send input to any other
window, to the desktop root or to a display target. Use only the eval tool (JavaScript) and its computer prelude.`

const PROMPT = `Probe the fixture window titled "${TITLE}" with the eval tool's \`computer\` prelude (JavaScript), timing every step
with Date.now(). Run the steps in as few eval cells as you can, then stop and give a short report.
1. Print JSON of await computer.capabilities() and await computer.displays().
2. Take one screenshot of all displays with { silent: true } (do not look at it; it shows the person's own windows):
   await computer.display("all"); const shot = await computer.screenshot({ silent: true }); print its width,
   height and path only.
3. const win = await computer.window({ title: "${TITLE}" }); print win.id, win.bounds and win.focused.
4. const tree = await win.ax(); print the node count (lines containing "[ref=") and whether a button named
   "Probe button" and an edit field named "Probe input" appear.
5. Press the button: const [btn] = await win.find({ role: "button", title: "Probe button" }); await btn.press().
6. Type hello: const [field] = await win.find({ title: "Probe input" }); await field.type("hello").
7. Take a window screenshot (await win.screenshot()) and click the button once more by pixel: compute its centre in the
   screenshot from btn's bounds and the window bounds, check that the point lies inside the screenshot, then
   await win.click(x, y).
8. Inject Escape into the fixture: await win.press("escape").
9. Print one line starting with PROBE_RESULT followed by JSON {stepMs:{...}, nodeCount, buttonFound, inputFound,
   clickPoint, windowBounds, screenshotSize} and nothing else on that line.`

const records = { frames: 0, uiAnswered: [], startedAt: null, endedAt: null }
let nextId = 0
const id = () => `probe-${++nextId}`

function answerFor(request) {
  const base = { type: 'extension_ui_response', id: request.id }
  if (request.method === 'confirm') return { ...base, confirmed: true }
  if (request.method === 'select') return { ...base, value: request.options?.[0] ?? '' }
  if (request.method === 'input' || request.method === 'editor') return { ...base, value: '' }
  if (request.method === 'ask') return { ...base, answers: request.questions.map((q) => ({ id: q.id, selectedOptions: [q.options[q.recommended ?? 0]?.label].filter(Boolean) })) }
  return null
}

/** Reassembles protocol-v2 `rpc_chunk` sequences into the logical frame. */
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

function initLines() {
  return [
    { type: 'negotiate_protocol', protocolVersion: 2 },
    { type: 'set_ask_dialog', enabled: true },
    { type: 'set_subagent_subscription', level: 'progress' },
    { type: 'set_event_filter', events: null, messageUpdates: 'delta' },
    { type: 'get_state' }
  ].map((command) => ({ ...command, id: id() }))
}

function launchArgs(root) {
  const instructions = join(root, 'instructions.md')
  const config = join(root, 'config.yml')
  writeFileSync(instructions, INSTRUCTIONS)
  writeFileSync(config, OVERLAY)
  return [
    '--mode', 'rpc-ui', '--cwd', root, '--append-system-prompt', instructions,
    '--config', config, '--session-dir', join(root, 'sessions'), '--max-time', MAX_TIME, '--max-cost', MAX_COST
  ]
}

/** Runs one OMP session to its settled end (or the harness bound) and resolves with every frame it wrote. */
function runOmp(root, rawPath) {
  const args = launchArgs(root)
  records.argv = ['omp', ...args.map((value) => value.replaceAll(root, '<probe-root>'))]
  const child = spawn(OMP, args, { cwd: root, env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const frames = []
  const send = (frame) => { child.stdin.write(`${JSON.stringify(frame)}\n`); frames.push({ at: new Date().toISOString(), dir: 'in', frame }) }
  const decode = chunker()
  const ids = { status: id(), prompt: id() }
  let buffer = ''
  return new Promise((done) => {
    const timer = setTimeout(() => { records.harnessTimeout = true; killTree(child) }, LIMIT_MS)
    child.stderr.on('data', (chunk) => appendFileSync(join(OUT, 'omp-stderr.log'), chunk))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop()
      for (const line of lines.filter((entry) => entry.trim())) onLine(line)
    })
    child.on('exit', (code) => { clearTimeout(timer); records.exitCode = code; done(frames) })
    function onLine(line) {
      appendFileSync(rawPath, `${line}\n`)
      const frame = decode(JSON.parse(line))
      if (!frame) return
      frames.push({ at: new Date().toISOString(), dir: 'out', frame })
      react(frame, { send, ids, child })
    }
  })
}

function onReady(send, ids) {
  for (const line of initLines()) send(line)
  send({ type: 'prompt', id: ids.status, message: '/computer status' })
  send({ type: 'prompt', id: ids.prompt, message: PROMPT })
}

function onUiRequest(frame, send) {
  const answer = answerFor(frame)
  if (!answer) return
  send(answer)
  records.uiAnswered.push({ method: frame.method, title: frame.title ?? null })
}

function react(frame, { send, ids, child }) {
  records.frames++
  if (frame.type === 'ready') onReady(send, ids)
  if (frame.type === 'extension_ui_request') onUiRequest(frame, send)
  if (frame.type === 'prompt_result' && frame.id === ids.prompt) {
    records.promptResult = { status: frame.status, sessionSettled: frame.sessionSettled, error: frame.error ?? null }
    if (frame.sessionSettled) child.stdin.end()
  }
  if (frame.type === 'session_settled' && records.promptResult) child.stdin.end()
}

/**
 * OMP saves every computer screenshot as `%TEMP%/omp-computer-*.png` and leaves it there; the whole-desktop one shows
 * the person's own windows, so the probe deletes the ones its session wrote and records their names and sizes.
 */
function removeOmpScreenshots(since) {
  const removed = []
  for (const name of readdirSync(tmpdir()).filter((entry) => /^omp-computer-.*\.png$/u.test(entry))) {
    const path = join(tmpdir(), name)
    const { mtimeMs, size } = statSync(path)
    if (mtimeMs < since) continue
    rmSync(path, { force: true })
    removed.push({ name, size })
  }
  return removed
}

/** A whole-desktop capture after the session, kept only as a crop to the fixture's visible frame. */
function evidenceShot(fixture) {
  const full = join(OUT, 'a-desktop-after-full.png')
  const capture = captureDesktop(full)
  const crop = cropPng(full, join(OUT, 'a-fixture-after.png'), fixture.read().bounds.physical, capture.virtual)
  rmSync(full, { force: true })
  return { capture: { ...capture, path: undefined }, crop }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), 'dm1041-omp-'))
  const rawPath = join(OUT, 'rpc-transcript.raw.jsonl')
  const fixture = await launchFixture(TITLE)
  records.fixtureBefore = fixture.read()
  const since = Date.now()
  records.startedAt = new Date(since).toISOString()
  let frames = []
  try {
    frames = await runOmp(root, rawPath)
    records.fixtureAfter = await waitFor(fixture, (s) => s.text === 'hello', 2000)
    records.evidence = evidenceShot(fixture)
  } finally {
    records.endedAt = new Date().toISOString()
    fixture.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
    records.removedOmpScreenshots = removeOmpScreenshots(since)
  }
  const summary = summarize(frames, join(OUT, 'rpc-transcript.redacted.jsonl'))
  records.summary = summary
  records.coordinates = coordinateChecks(summary, records.fixtureBefore.bounds)
  writeFileSync(join(OUT, 'omp-computer-probe.json'), JSON.stringify(records, null, 2))
  process.stdout.write(`${JSON.stringify({ done: true, promptResult: records.promptResult ?? null, text: records.fixtureAfter?.text, clicks: records.fixtureAfter?.clicks, keys: records.fixtureAfter?.keys?.map((k) => k.key) })}\n`)
}

await main()
