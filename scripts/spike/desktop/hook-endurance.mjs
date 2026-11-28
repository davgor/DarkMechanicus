/**
 * DM-1042 spike: does the WH_KEYBOARD_LL hook helper survive about 10 minutes idle and 2 minutes with every CPU
 * saturated? Windows silently unhooks a low-level hook whose callback overruns LowLevelHooksTimeout, so the helper's
 * own tagged pings (swallowed by its hook, so no window receives them) are the liveness signal, next to its
 * message-loop heartbeat.
 *
 *   node scripts/spike/desktop/hook-endurance.mjs --out <file.json> [--idle-min 10] [--load-min 2]
 *
 * Records per phase: heartbeat gaps, ping gaps, SendInput-to-callback latency of every ping, and the moments a parent
 * using control.mjs's limits would have killed. Ends with an injected Escape that must be seen as injected. The load
 * generator is four tight-loop worker threads per logical CPU, started and terminated by this script: one per CPU
 * reached only about 40 % busy on this host (run 2), four reached 99.7 % in a check. Imported by no product code.
 */
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { availableParallelism, cpus } from 'node:os'
import { Worker } from 'node:worker_threads'
import { HEARTBEAT_LIMIT_MS, PING_LIMIT_MS, injectEsc, msBetween, nowNs, startHook } from './overlay/control.mjs'

/** Summed CPU times of every logical CPU, to show how busy the machine really was during a phase. */
function cpuTimes() {
  return cpus().reduce((sum, { times }) => ({ busy: sum.busy + times.user + times.nice + times.sys + times.irq, total: sum.total + times.user + times.nice + times.sys + times.irq + times.idle }), { busy: 0, total: 0 })
}
const busyShare = (from, to) => Math.round((1000 * (to.busy - from.busy)) / (to.total - from.total)) / 10

const flag = (name, fallback) => { const at = process.argv.indexOf(`--${name}`); return at === -1 ? fallback : process.argv[at + 1] }
const OUT = flag('out')
const IDLE_MS = Number(flag('idle-min', '10')) * 60_000
const LOAD_MS = Number(flag('load-min', '2')) * 60_000
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

function percentile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

/** Statistics of the hook's lines whose clock falls in [fromNs, toNs). */
function phase(name, lines, fromNs, toNs) {
  const within = lines.filter((line) => line.qpcNs && BigInt(line.qpcNs) >= fromNs && BigInt(line.qpcNs) < toNs)
  const gaps = (items) => {
    let max = 0
    let last = fromNs
    for (const item of items) {
      const gap = msBetween(last, item.qpcNs)
      max = Math.max(max, gap)
      last = BigInt(item.qpcNs)
    }
    return { max, tail: msBetween(last, toNs) }
  }
  const hbs = within.filter((line) => line.type === 'hb')
  const sent = within.filter((line) => line.type === 'sent' && line.kind === 1)
  const seen = within.filter((line) => line.type === 'key' && line.own && line.kind === 1 && line.down)
  const latencies = sent.map((s) => {
    const hit = seen.find((k) => BigInt(k.qpcNs) >= BigInt(s.qpcNs))
    return hit ? msBetween(s.qpcNs, hit.qpcNs) : null
  })
  const hbGaps = gaps(hbs)
  const pingGaps = gaps(seen)
  return {
    phase: name,
    durationMs: msBetween(fromNs, toNs),
    heartbeats: hbs.length,
    maxHeartbeatGapMs: Math.max(hbGaps.max, hbGaps.tail),
    pingsSent: sent.length,
    pingsSeen: seen.length,
    pingsMissed: latencies.filter((value) => value === null).length,
    maxPingGapMs: Math.max(pingGaps.max, pingGaps.tail),
    pingLatencyMs: { p50: percentile(latencies.filter((v) => v !== null), 0.5), p99: percentile(latencies.filter((v) => v !== null), 0.99), max: Math.max(...latencies.filter((v) => v !== null)) },
    wouldKill: Math.max(hbGaps.max, hbGaps.tail) > HEARTBEAT_LIMIT_MS || Math.max(pingGaps.max, pingGaps.tail) > PING_LIMIT_MS
  }
}

function startLoad() {
  const code = 'let x = 0; for (;;) x = (x * 31 + 7) % 1000003'
  return Array.from({ length: 4 * availableParallelism() }, () => new Worker(code, { eval: true }))
}

async function main() {
  const timeout = spawnSync('reg.exe', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'LowLevelHooksTimeout'], { encoding: 'utf8', windowsHide: true })
  const hook = await startHook()
  const record = {
    startedAt: new Date().toISOString(), helper: hook.ready, cpus: availableParallelism(),
    lowLevelHooksTimeoutRegistry: timeout.status === 0 ? timeout.stdout.trim().split('\n').pop().trim() : 'not set (Windows default applies)',
    limits: { heartbeatMs: HEARTBEAT_LIMIT_MS, pingMs: PING_LIMIT_MS }
  }
  const t0 = nowNs()
  const c0 = cpuTimes()
  await sleep(IDLE_MS)
  const t1 = nowNs()
  const c1 = cpuTimes()
  const workers = startLoad()
  record.loadStartedAt = new Date().toISOString()
  await sleep(LOAD_MS)
  const t2 = nowNs()
  const c2 = cpuTimes()
  await Promise.all(workers.map((worker) => worker.terminate()))
  record.loadStoppedAt = new Date().toISOString()
  const esc = await injectEsc(hook.ready.pid)
  const seen = await hook.next((line) => line.type === 'key' && line.vk === 0x1b && line.down && BigInt(line.qpcNs) >= BigInt(esc.qpcNs), 5000).catch(() => null)
  record.phases = [{ ...phase('idle', hook.lines, t0, t1), cpuBusyPercent: busyShare(c0, c1) }, { ...phase('cpu-load', hook.lines, t1, t2), cpuBusyPercent: busyShare(c1, c2) }]
  record.finalEscape = seen ? { injected: seen.injected, own: seen.own, injectToCallbackMs: msBetween(esc.qpcNs, seen.qpcNs) } : { seen: false }
  record.helperAliveAtEnd = hook.child.exitCode === null
  record.endedAt = new Date().toISOString()
  hook.send('quit')
  await hook.exited
  if (OUT) writeFileSync(OUT, JSON.stringify(record, null, 2))
  process.stdout.write(`${JSON.stringify(record)}\n`)
}

await main()
