/**
 * What a test heard from a real process, with a way to wait for the next thing it says. Tests of real
 * processes wait on what the process does (a line on stdout, its close) and never on a timer or a poll:
 * `reached(count)` settles the moment the count-th item arrives, so a slow machine only makes a test slower.
 */
export interface EventLog<T> {
  /** Everything heard so far, in order. */
  readonly items: readonly T[]
  /** Records one item and wakes whoever waits for it. Wire this to the process's event. */
  push(item: T): void
  /** Resolves once at least `count` items have been heard, immediately if they already have. */
  reached(count: number): Promise<void>
}

export function createEventLog<T>(): EventLog<T> {
  const items: T[] = []
  let waiting: { count: number; wake: () => void }[] = []
  return {
    items,
    push(item) {
      items.push(item)
      const ready = waiting.filter((waiter) => waiter.count <= items.length)
      waiting = waiting.filter((waiter) => waiter.count > items.length)
      for (const waiter of ready) {
        waiter.wake()
      }
    },
    reached(count) {
      return new Promise<void>((resolve) => {
        if (items.length >= count) {
          resolve()
          return
        }
        waiting.push({ count, wake: resolve })
      })
    }
  }
}
