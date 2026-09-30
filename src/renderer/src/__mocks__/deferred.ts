export interface Deferred {
  promise: Promise<void>
  resolve(): void
}

/** A promise a test settles by hand, to observe in-flight UI states deterministically. */
export function deferred(): Deferred {
  let settle: () => void = () => undefined
  const promise = new Promise<void>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: settle }
}
