/** Injectable timers, so polling and auto-dismissal stay deterministic under test. */
export interface Scheduler {
  /** Runs the task once after `ms`; the returned function cancels it. */
  after(ms: number, task: () => void): () => void
  /** Runs the task every `ms`; the returned function stops it. */
  every(ms: number, task: () => void): () => void
}

export const browserScheduler: Scheduler = {
  after(ms, task) {
    const id = window.setTimeout(task, ms)
    return () => window.clearTimeout(id)
  },
  every(ms, task) {
    const id = window.setInterval(task, ms)
    return () => window.clearInterval(id)
  }
}
