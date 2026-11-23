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
