/**
 * DM-1042 spike: the parent side of the desktop-control safety switch. It starts the overlay (`overlay.electron.cjs`,
 * repo Electron, `ELECTRON_RUN_AS_NODE` deleted from its environment) and the hook helper (`esc-hook.ps1`), watches
 * the helper's heartbeat and liveness pings, and runs the kill: end the controlled process tree with
 * `taskkill /T /F` (as `src/main/processTree.ts` does) and close every overlay window at once. A physical Escape, the
 * helper exiting, or its heartbeat or pings stopping all take the same kill path (fail closed). Imported by no
 * product code.
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { shouldKill } from '../escDecision.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP = join(HERE, '..')
const REPO = join(HERE, '..', '..', '..', '..')
const require = createRequire(import.meta.url)

/** No heartbeat for this long, or no ping for PING_LIMIT_MS, means the hook may be gone: kill. */
export const HEARTBEAT_LIMIT_MS = 1000
export const PING_LIMIT_MS = 2500

export const nowNs = () => process.hrtime.bigint()
export const msBetween = (fromNs, toNs) => Number(BigInt(toNs) - BigInt(fromNs)) / 1e6
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/**
 * The environment for an Electron child: `ELECTRON_RUN_AS_NODE` (which DM terminals set, `terminalEnv.ts`) would start
 * Electron as plain Node, and the DM session variables must not leak into a spike process.
 */
export function electronEnv() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  for (const key of Object.keys(env)) if (/^(?:ELECTRON_.*|NODE_OPTIONS|DM_SESSION_TOKEN|DM_DESKTOP_PIPE|DM_BROWSER_PIPE)$/iu.test(key)) delete env[key]
  return env
}

/** A child that speaks JSON lines on stdout; `next(test)` waits for the first line (seen or future) that passes. */
function jsonChild(child, name) {
  const emitter = new EventEmitter()
  const lines = []
  readline.createInterface({ input: child.stdout }).on('line', (text) => {
    let value
    try { value = JSON.parse(text) } catch { return }
    lines.push(value)
    emitter.emit('line', value)
  })
  const next = (test, limitMs = 15_000) => new Promise((done, fail) => {
    const seen = lines.find(test)
    if (seen) return done(seen)
    const timer = setTimeout(() => { emitter.off('line', on); fail(new Error(`${name}: no matching line within ${limitMs} ms`)) }, limitMs)
    const on = (value) => { if (test(value)) { clearTimeout(timer); emitter.off('line', on); done(value) } }
    emitter.on('line', on)
  })
  const send = (value) => { if (child.stdin.writable) child.stdin.write(`${typeof value === 'string' ? value : JSON.stringify(value)}\n`) }
  return { child, lines, next, send, on: (fn) => emitter.on('line', fn) }
}

/** `parentPid` is the process whose end removes the overlay (default: this one); the parent-exit probe points it elsewhere. */
export async function startOverlay({ protect = false, parentPid = process.pid } = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'dm1042-overlay-'))
  const env = electronEnv()
  const args = [join(HERE, 'overlay.electron.cjs'), `--profile=${profile}`, `--parent=${parentPid}`, ...(protect ? ['--protect'] : [])]
  const child = spawn(require('electron'), args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: false })
  const overlay = jsonChild(child, 'overlay')
  overlay.envStripped = !('ELECTRON_RUN_AS_NODE' in env)
  overlay.exited = new Promise((done) => child.on('exit', (code) => { overlay.exitNs = nowNs(); done(code) }))
  overlay.cleanup = () => rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  const { port } = await overlay.next((line) => typeof line.port === 'number', 30_000)
  const socket = connect(port, '127.0.0.1')
  socket.setNoDelay(true)
  socket.on('error', () => {})
  overlay.send = (value) => { if (socket.writable) socket.write(`${JSON.stringify(value)}\n`) }
  overlay.shown = await overlay.next((line) => line.overlay === 'shown', 30_000)
  return overlay
}

export async function startHook({ parentPid = process.pid, pingMs = 1000 } = {}) {
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(DESKTOP, 'esc-hook.ps1'), '-ParentPid', String(parentPid), '-PingMs', String(pingMs)],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const hook = jsonChild(child, 'hook')
  hook.exited = new Promise((done) => child.on('exit', (code) => { hook.exitNs = nowNs(); done(code) }))
  hook.ready = await hook.next((line) => line.type === 'ready', 30_000)
  if (!hook.ready.hook) throw new Error(`SetWindowsHookEx failed: ${JSON.stringify(hook.ready)}`)
  return hook
}

/**
 * The stand-in for a computer-use process tree: node → powershell. With `inject` it runs `inject.ps1 -Loop`, sending
 * tagged keys the hook swallows; they reach the foreground window if the hook is gone, so an injecting tree may run
 * only while the hook is alive and a probe fixture is in front. Without `inject` the powershell child only sleeps.
 */
export function startAgentTree(hookPid, { intervalMs = 20, inject = true } = {}) {
  const child = inject
    ? `spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',${JSON.stringify(join(DESKTOP, 'inject.ps1'))},'-Loop','-Tag','${hookPid}','-Kind','3','-IntervalMs','${intervalMs}'], { stdio: 'inherit', windowsHide: true })`
    : `spawn('powershell.exe', ['-NoProfile','-Command','Start-Sleep -Seconds 3600'], { stdio: 'ignore', windowsHide: true }); process.stdout.write('{"looping":false}\\n')`
  const script = `const { spawn } = require('node:child_process');
${child};
setInterval(() => {}, 1000)`
  const tree = jsonChild(spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }), 'agent-tree')
  tree.started = tree.next((line) => typeof line.looping === 'boolean', 30_000)
  return tree
}

export function injectEsc(tag = 0) {
  return new Promise((done) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(DESKTOP, 'inject.ps1'), '-Esc', '-Tag', String(tag)], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('exit', () => { try { done(JSON.parse(out.trim().split('\n').pop())) } catch { done({ error: out }) } })
  })
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Heartbeat and ping bookkeeping: the largest gaps seen and the last time each arrived. */
function trackLiveness(state, line) {
  const at = BigInt(line.qpcNs ?? nowNs())
  if (line.type === 'hb') {
    state.maxHbGapMs = Math.max(state.maxHbGapMs, msBetween(state.lastHbNs, at))
    state.lastHbNs = at
  }
  if (line.type === 'key' && line.own && line.kind === 1 && line.down) {
    state.maxPingGapMs = Math.max(state.maxPingGapMs, msBetween(state.lastPingNs, at))
    state.lastPingNs = at
  }
}

/** An Escape the hook saw: the kill when `shouldKill` says so, otherwise recorded as passed through. */
function onEscape(state, line, kill) {
  if (line.type !== 'key' || line.vk !== 0x1b) return
  if (shouldKill({ vk: line.vk, injected: line.injected, down: line.down })) kill('physical-esc', line)
  else if (line.down) state.ignored.push({ injected: line.injected, own: line.own, kind: line.kind, lagMs: line.lagMs, qpcNs: line.qpcNs, callbackToParentMs: msBetween(line.qpcNs, nowNs()) })
}

/** taskkill /T /F of the controlled tree (as src/main/processTree.ts does); resolves with its exit code and end time. */
function endTree(tree) {
  if (!tree) return Promise.resolve(null)
  return new Promise((done) => {
    const killer = spawn('taskkill.exe', ['/PID', String(tree.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    killer.on('exit', (code) => done({ code, ns: nowNs() }))
  })
}

/** Closes every overlay window; force-kills the overlay process when it has not confirmed within 1 s (fail closed). */
async function closeOverlay(overlay) {
  overlay.send({ cmd: 'close' })
  const closed = await Promise.race([overlay.next((line) => line.closed === true, 1000).catch(() => null), sleep(1000)])
  if (!closed) overlay.child.kill()
  await overlay.exited
  return closed ?? null
}

function overlayTimes(record, { startNs, trigger, closed, overlay }) {
  record.overlayClosedNs = closed?.qpcNs ?? null
  record.overlayExitNs = String(overlay.exitNs)
  record.overlayClosedMs = closed ? msBetween(startNs, closed.qpcNs) : null
  if (!trigger?.qpcNs) return
  record.triggerToOverlayClosedMs = closed ? msBetween(trigger.qpcNs, closed.qpcNs) : null
  record.triggerToOverlayExitMs = msBetween(trigger.qpcNs, overlay.exitNs)
}

/** After the tree ended, keep listening `watchMs`: the agent stand-in's tagged keys must stop at the tree's end. */
async function auditAgentInput(record, { hook, startNs, ended, watchMs }) {
  record.treeEndedMs = msBetween(startNs, ended.ns)
  record.taskkillExit = ended.code
  record.treeEndedNs = String(ended.ns)
  await sleep(watchMs)
  const agentKeys = hook.lines.filter((line) => line.type === 'key' && line.own && line.kind === 3 && line.down)
  const before = agentKeys.filter((line) => BigInt(line.qpcNs) <= ended.ns)
  record.agentKeysBefore = before.length
  record.agentKeysAfterTreeEnded = agentKeys.length - before.length
  record.lastAgentKeyBeforeEndMs = before.length > 0 ? msBetween(before.at(-1).qpcNs, ended.ns) : null
  record.agentKeysBetweenKillStartAndTreeEnded = before.filter((line) => BigInt(line.qpcNs) > startNs).length
  record.watchedAfterMs = watchMs
}

/**
 * Watches the hook and owns the kill; `killed` resolves with the kill record. `tree` (optional) is the process tree
 * that holds desktop control: the kill ends it with taskkill /T /F, closes the overlay, and keeps the hook listening
 * for `watchMs` afterwards to prove no tagged agent input arrives after the tree ended.
 */
export function controller({ overlay, hook, tree = null, watchMs = 1000 }) {
  const state = { killed: null, ignored: [], lastHbNs: nowNs(), lastPingNs: nowNs(), maxHbGapMs: 0, maxPingGapMs: 0 }
  let resolveKill
  const killed = new Promise((done) => { resolveKill = done })
  const watchdog = setInterval(() => {
    const t = nowNs()
    if (msBetween(state.lastHbNs, t) > HEARTBEAT_LIMIT_MS) kill('heartbeat-lost', { qpcNs: String(state.lastHbNs) })
    else if (msBetween(state.lastPingNs, t) > PING_LIMIT_MS) kill('ping-lost', { qpcNs: String(state.lastPingNs) })
  }, 100)

  async function kill(reason, trigger) {
    if (state.killed) return
    const startNs = nowNs()
    const record = { reason, triggerNs: trigger?.qpcNs ?? null, startNs: String(startNs) }
    state.killed = record
    clearInterval(watchdog)
    // The overlay close goes out first (synchronously), then taskkill starts: neither waits for the other.
    const closing = closeOverlay(overlay)
    const treeEnded = endTree(tree)
    const closed = await closing
    overlayTimes(record, { startNs, trigger, closed, overlay })
    const ended = await treeEnded
    if (ended) await auditAgentInput(record, { hook, startNs, ended, watchMs })
    resolveKill(record)
  }

  hook.on((line) => { trackLiveness(state, line); onEscape(state, line, kill) })
  hook.exited.then(() => kill('hook-exited', { qpcNs: String(hook.exitNs) }))

  /** A normal stop (no kill): stop watching, close the overlay and the hook. */
  async function stop() {
    clearInterval(watchdog)
    state.killed ??= { reason: 'none' }
    overlay.send({ cmd: 'close' })
    hook.send('quit')
    await Promise.race([Promise.all([overlay.exited, hook.exited]), sleep(3000)])
    if (pidAlive(overlay.child.pid)) overlay.child.kill()
    if (pidAlive(hook.child.pid)) hook.child.kill()
  }

  return { state, killed, kill, stop }
}
