import { cpus } from 'node:os'
import { performance } from 'node:perf_hooks'
import { isMainThread, threadId } from 'node:worker_threads'

export function identity() {
  return { pid: process.pid, isMainThread, threadId, node: process.versions.node, electron: process.versions.electron }
}

export function absoluteNow(): number {
  return performance.timeOrigin + performance.now()
}

export function loopSink(intervalMs = 10) {
  const gaps: number[] = []
  let last = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    gaps.push(now - last)
    last = now
  }, intervalMs)
  return {
    read() {
      const samples = gaps.splice(0)
      return { count: samples.length, maxGapMs: Math.max(0, ...samples) }
    },
    close: () => clearInterval(timer)
  }
}

export interface LatencyStats { count: number; p50Ms: number; p95Ms: number; maxMs: number; minMs: number; meanMs: number }

/** Nearest-rank percentiles over milliseconds; an empty sample reports zero count and null-free zeros. */
export function latencyStats(samples: readonly number[]): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = (p: number): number => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0
  const round = (value: number): number => Math.round(value * 10) / 10
  const total = sorted.reduce((sum, value) => sum + value, 0)
  return {
    count: sorted.length, p50Ms: round(rank(0.5)), p95Ms: round(rank(0.95)), maxMs: round(sorted.at(-1) ?? 0),
    minMs: round(sorted[0] ?? 0), meanMs: round(sorted.length === 0 ? 0 : total / sorted.length)
  }
}

/** Counts each call outcome under its error code, or `ok`; a missing code counts as `no_json`. */
export function outcomeCounts(outcomes: readonly { ok: boolean; code?: string | null }[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const outcome of outcomes) {
    const key = outcome.ok ? 'ok' : outcome.code ?? 'no_json'
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}

export interface HoldRecord { tag: string | null; outcome: string; acquireMs: number; holdMs: number }

/** Write-lock hold and acquire statistics per caller tag (`untagged` for a transaction outside any scope). */
export function holdSummary(holds: readonly HoldRecord[]) {
  const byTag = new Map<string, HoldRecord[]>()
  for (const hold of holds) {
    const key = hold.tag ?? 'untagged'
    byTag.set(key, [...(byTag.get(key) ?? []), hold])
  }
  return Object.fromEntries([...byTag.entries()].map(([tag, rows]) => [tag, {
    transactions: rows.length,
    rollbacks: rows.filter((row) => row.outcome === 'rollback').length,
    hold: latencyStats(rows.map((row) => row.holdMs)),
    acquire: latencyStats(rows.map((row) => row.acquireMs))
  }]))
}

function cpuTotals() {
  let idle = 0
  let total = 0
  for (const cpu of cpus()) {
    const { user, nice, sys, irq } = cpu.times
    idle += cpu.times.idle
    total += user + nice + sys + irq + cpu.times.idle
  }
  return { idle, total }
}

/** Host-wide CPU busy percentage sampled once a second; `read` returns and clears the samples since the last read. */
export function cpuSink(intervalMs = 1_000) {
  let previous = cpuTotals()
  const busy: number[] = []
  const timer = setInterval(() => {
    const current = cpuTotals()
    const total = current.total - previous.total
    if (total > 0) busy.push(100 * (1 - (current.idle - previous.idle) / total))
    previous = current
  }, intervalMs)
  timer.unref()
  return {
    read() {
      const samples = busy.splice(0)
      const mean = samples.length === 0 ? 0 : samples.reduce((sum, value) => sum + value, 0) / samples.length
      return { samples: samples.length, meanBusyPct: Math.round(mean * 10) / 10, maxBusyPct: Math.round(Math.max(0, ...samples) * 10) / 10 }
    },
    close: () => clearInterval(timer)
  }
}
