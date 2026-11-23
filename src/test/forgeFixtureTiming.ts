import { sep } from 'node:path'
import { onTestFailed } from 'vitest'

type Span = { name: string; startedMs: number; endedMs?: number }

const live = new Map<string, ForgeFixtureTiming>()
let nextId = 0
const gitOperations = new Set(['add', 'branch', 'commit', 'config', 'diff', 'fetch', 'init', 'log', 'ls-files', 'ls-remote',
  'ls-tree', 'merge', 'push', 'remote', 'rev-list', 'rev-parse', 'status', 'symbolic-ref', 'update-ref', 'var'])

export function gitTimingLabel(args: readonly string[]): string {
  return args.find(arg => gitOperations.has(arg)) ?? 'other'
}

export function forgeTimingForPath(path: string): ForgeFixtureTiming | undefined {
  for (const [root, trace] of live) if (path === root || path.startsWith(root + sep)) return trace
  return undefined
}

export class ForgeFixtureTiming {
  private readonly id = ++nextId
  private readonly started = performance.now()
  private readonly predecessors = [...live.values()].map(trace => trace.id)
  private readonly spans: Span[] = []
  private pending = 0
  private discarded = 0
  private disposed = false

  constructor(private readonly root: string) {
    live.set(root, this)
    onTestFailed(({ task }) => {
      process.stdout.write(JSON.stringify({ forgeFixtureTiming: task.name, ...this.snapshot() }) + '\n')
    })
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
    this.disposed = true
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
      live: [...live.values()].map(trace => trace.id), groups,
      pending: this.spans.filter(span => span.endedMs === undefined),
      phases: this.spans.filter(span => /^(ipc|fixture|timer):/.test(span.name)),
      slow: this.spans.filter(span => duration(span) >= 250).sort((left, right) => duration(right) - duration(left)).slice(0, 12) }
  }
}
