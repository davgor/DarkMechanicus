/** Runs `action` and returns whatever it throws, or `undefined` when it does not throw. Not shipped. */
export function thrownBy(action: () => unknown): unknown {
  try {
    action()
  } catch (error: unknown) {
    return error
  }
  return undefined
}
