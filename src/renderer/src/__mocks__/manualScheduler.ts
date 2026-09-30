import type { Scheduler } from '../app/scheduler'

interface Entry {
  ms: number
  run: () => void
  repeat: boolean
}

/** Scheduler whose clock only moves when a test says so. */
export class ManualScheduler implements Scheduler {
  private nextId = 1
  private readonly entries = new Map<number, Entry>()

  after(ms: number, task: () => void): () => void {
    return this.add({ ms, run: task, repeat: false })
  }

  every(ms: number, task: () => void): () => void {
    return this.add({ ms, run: task, repeat: true })
  }

  /** Delays of the repeating tasks that are still scheduled, in scheduling order. */
  intervals(): number[] {
    return this.list(true)
  }

  /** Delays of the one-shot tasks that are still scheduled, in scheduling order. */
  timeouts(): number[] {
    return this.list(false)
  }

  /** Runs each scheduled repeating task once (optionally only those with the given delay). */
  fireIntervals(ms?: number): void {
    for (const entry of Array.from(this.entries.values())) {
      if (entry.repeat && (ms === undefined || entry.ms === ms)) entry.run()
    }
  }

  /** Runs and clears every scheduled one-shot task (optionally only those with the given delay). */
  fireTimeouts(ms?: number): void {
    for (const [id, entry] of Array.from(this.entries)) {
      if (!entry.repeat && (ms === undefined || entry.ms === ms)) {
        this.entries.delete(id)
        entry.run()
      }
    }
  }

  private add(entry: Entry): () => void {
    const id = this.nextId
    this.nextId += 1
    this.entries.set(id, entry)
    return () => {
      this.entries.delete(id)
    }
  }

  private list(repeat: boolean): number[] {
    return [...this.entries.values()].filter((entry) => entry.repeat === repeat).map((entry) => entry.ms)
  }
}
