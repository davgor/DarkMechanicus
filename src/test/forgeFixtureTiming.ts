import { execFileSync } from 'node:child_process'
import { cpus, freemem, totalmem } from 'node:os'
import { sep } from 'node:path'
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks'
import { onTestFailed, onTestFinished, TestRunner } from 'vitest'

type Span = { name: string; startedMs: number; endedMs?: number }

const live = new Map<string, ForgeFixtureTiming>()
let nextId = 0
const gitOperations = new Set(['add', 'branch', 'commit', 'config', 'diff', 'fetch', 'init', 'log', 'ls-files', 'ls-remote',
  'ls-tree', 'merge', 'push', 'remote', 'rev-list', 'rev-parse', 'status', 'symbolic-ref', 'update-ref', 'var'])
/** The event loop is sampled this often; a gap of `STALL_MS` or more between samples is recorded as a stall. */
const SAMPLE_MS = 100
const STALL_MS = 400
// Taken before any test fakes timers: the stall sampler must keep real time.
const { setInterval: realSetInterval, clearInterval: realClearInterval } = globalThis

export function gitTimingLabel(args: readonly string[]): string {
  return args.find(arg => gitOperations.has(arg)) ?? 'other'
}

export function forgeTimingForPath(path: string): ForgeFixtureTiming | undefined {
  for (const [root, trace] of live) if (path === root || path.startsWith(root + sep)) return trace
  return undefined
}

function machineTimes(): { busy: number; total: number } {
  let busy = 0
  let total = 0
  for (const { times } of cpus()) {
    const all = times.user + times.nice + times.sys + times.irq + times.idle
    total += all
    busy += all - times.idle
  }
  return { busy, total }
}

/**
 * Whether a slow fixture computed, waited or lost the CPU: the worker's CPU time, the machine's busy share, the
 * longest event-loop delay (a synchronous wait) and garbage collection, from the fixture's start.
 */
class ResourceSample {
  private readonly cpu = process.cpuUsage()
  private readonly machine = machineTimes()
  private readonly delay = monitorEventLoopDelay({ resolution: 20 })
  private readonly gc = { count: 0, totalMs: 0, maxMs: 0 }
  private readonly observer = new PerformanceObserver(list => {
    for (const { duration } of list.getEntries()) {
      this.gc.count++
      this.gc.totalMs += duration
      this.gc.maxMs = Math.max(this.gc.maxMs, duration)
    }
  })
  private frozen: Record<string, number | null> | undefined

  constructor() {
    this.delay.enable()
    this.observer.observe({ entryTypes: ['gc'] })
  }

  stop(): void {
    if (this.frozen !== undefined) return
    this.frozen = this.read()
    this.delay.disable()
    this.observer.disconnect()
  }

  read(): Record<string, number | null> {
    if (this.frozen !== undefined) return this.frozen
    const cpu = process.cpuUsage(this.cpu)
    const machine = machineTimes()
    const total = machine.total - this.machine.total
    return {
      workerUserMs: Math.round(cpu.user / 1000), workerSystemMs: Math.round(cpu.system / 1000),
      machineBusyPercent: total > 0 ? Math.round(100 * (machine.busy - this.machine.busy) / total) : null, cpus: cpus().length,
      eventLoopMaxMs: Math.round(this.delay.max / 1e6), eventLoopP99Ms: Math.round(this.delay.percentile(99) / 1e6),
      gcCount: this.gc.count, gcTotalMs: Math.round(this.gc.totalMs), gcMaxMs: Math.round(this.gc.maxMs),
      rssMb: Math.round(process.memoryUsage.rss() / 2 ** 20), freeMemoryMb: Math.round(freemem() / 2 ** 20),
      totalMemoryMb: Math.round(totalmem() / 2 ** 20)
    }
  }
}

/** On Windows, the busiest processes and the disk's load now, from one second of performance counters. */
function machineLoad(): string {
  if (process.platform !== 'win32') return ''
  const counters = "'\\Process(*)\\% Processor Time','\\PhysicalDisk(_Total)\\% Disk Time','\\PhysicalDisk(_Total)\\Avg. Disk Queue Length'"
  const script = `(Get-Counter ${counters} -ErrorAction SilentlyContinue).CounterSamples | Where-Object { $_.CookedValue -gt 1 } | ` +
    'Sort-Object CookedValue -Descending | Select-Object -First 20 | ForEach-Object { "$($_.Path)=$([math]::Round($_.CookedValue))" }'
  try {
    return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 10_000, windowsHide: true }).trim()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * The phases, Git runs and waits of one disposable fixture, printed when its test fails (and, with `slowMs`, when it
 * passes that slowly), and again when a failed test's body finally disposes the fixture. Event-loop stalls (a
 * synchronous wait in this worker) are spans too, so they line up with whatever was running.
 */
export class ForgeFixtureTiming {
  private readonly id = ++nextId
  private readonly started = performance.now()
  private readonly predecessors = [...live.values()].map(trace => trace.id)
  private readonly spans: Span[] = []
  private readonly resources = new ResourceSample()
  private readonly sampler: NodeJS.Timeout
  private sampled = performance.now()
  private pending = 0
  private discarded = 0
  private disposed = false
  private failedTest: string | undefined

  constructor(private readonly root: string, options: { slowMs?: number } = {}) {
    live.set(root, this)
    this.sampler = realSetInterval(() => this.sample(), SAMPLE_MS)
    this.sampler.unref()
    // A fixture prepared once for a whole file (in `beforeAll`) has no test to report to.
    if (TestRunner.getCurrentTest() === undefined) return
    onTestFailed(({ task }) => {
      this.failedTest = task.name
      this.emit(task.name, 'failed')
    })
    const { slowMs } = options
    if (slowMs === undefined) return
    onTestFinished(({ task }) => {
      if (task.result?.state !== 'fail' && this.elapsed() >= slowMs) this.emit(task.name, 'slow')
    })
  }

  private sample(): void {
    const now = performance.now()
    const gap = now - this.sampled
    this.sampled = now
    if (gap >= STALL_MS) this.record('stall:event loop', gap - SAMPLE_MS)
  }

  private emit(test: string, outcome: 'failed' | 'slow' | 'disposed after failure'): void {
    // The machine's load takes a second of counters: only a failure pays for it.
    const load = outcome === 'slow' ? {} : { machineLoad: machineLoad() }
    process.stdout.write(JSON.stringify({ forgeFixtureTiming: test, outcome, ...this.snapshot(), ...load }) + '\n')
  }

  private begin(name: string): () => void {
    const span: Span = { name, startedMs: this.elapsed() }
    live.set(this.root, this)
    this.pending++
    if (this.spans.length < 512) this.spans.push(span)
    else this.discarded++
    return () => {
      span.endedMs = this.elapsed()
      this.pending--
      this.retire()
    }
  }

  mark(name: string): void { this.begin(name)() }

  /** A span that ended `endedAgoMs` ago after `durationMs`, measured by the code under test (a SQLite lock wait or hold). */
  record(name: string, durationMs: number, endedAgoMs = 0): void {
    if (this.spans.length >= 512) {
      this.discarded++
      return
    }
    const endedMs = Math.round(this.elapsed() - endedAgoMs)
    this.spans.push({ name, startedMs: Math.round(endedMs - durationMs), endedMs })
  }

  observe<T>(name: string, call: () => T): T {
    const end = this.begin(name)
    try {
      const result = call()
      if (result instanceof Promise) void result.then(end, end)
      else end()
      return result
    } catch (error) {
      end()
      throw error
    }
  }

  finished(): void {
    this.mark('fixture:disposed')
    realClearInterval(this.sampler)
    this.resources.stop()
    this.disposed = true
    // A timed-out test's body runs on: this shows where it spent the rest of its time.
    if (this.failedTest !== undefined) this.emit(this.failedTest, 'disposed after failure')
    this.retire()
  }

  private retire(): void {
    if (this.disposed && this.pending === 0) live.delete(this.root)
  }

  private elapsed(): number { return Math.round(performance.now() - this.started) }

  private snapshot() {
    const groups: Record<string, { count: number; totalMs: number; maxMs: number }> = {}
    const duration = (span: Span) => (span.endedMs ?? this.elapsed()) - span.startedMs
    for (const span of this.spans) {
      const group = groups[span.name] ??= { count: 0, totalMs: 0, maxMs: 0 }
      const elapsed = duration(span)
      group.count++
      group.totalMs += elapsed
      group.maxMs = Math.max(group.maxMs, elapsed)
    }
    return { id: this.id, elapsedMs: this.elapsed(), predecessors: this.predecessors, discarded: this.discarded,
      live: [...live.values()].map(trace => trace.id), resources: this.resources.read(), groups,
      pending: this.spans.filter(span => span.endedMs === undefined),
      phases: this.spans.filter(span => /^(ipc|fixture|timer|stall):/.test(span.name)),
      slow: this.spans.filter(span => duration(span) >= 250).sort((left, right) => duration(right) - duration(left)).slice(0, 16) }
  }
}
