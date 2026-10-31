import type { ApplyAndTest, MutationLanes } from '../src/types.js';

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

/** A promise the test settles by hand (the ES2022 lib has no `Promise.withResolvers`). */
export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Resolves once every queued microtask has run (one macrotask turn, not a wall-clock wait). */
export function settleMicrotasks(): Promise<void> {
  const done = deferred();
  setImmediate(() => done.resolve());
  return done.promise;
}

/** One in-place mutation lane, as the CLI opens with `concurrency: 1`. */
export function inPlaceLanes(
  applyAndTest: ApplyAndTest,
  close: () => Promise<void> = async () => {}
): MutationLanes {
  return {
    appliers: [applyAndTest],
    execution: { lanes: 1, workspace: 'in-place' },
    close,
  };
}
