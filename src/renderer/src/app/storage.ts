/** The slice of Web Storage the app needs, so tests can supply a hand-written store. */
export type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>

/** localStorage, or null when the browser blocks it (private windows, cleared site data). */
function browserStorage(): KeyValueStore | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/** Reads a persisted value; anything missing, malformed or invalid yields the fallback. */
export function readStored<T>(
  key: string,
  fallback: T,
  isValid: (value: unknown) => value is T,
  store: KeyValueStore | null = browserStorage()
): T {
  try {
    const raw = store?.getItem(key)
    if (typeof raw !== 'string') {
      return fallback
    }
    const parsed: unknown = JSON.parse(raw)
    return isValid(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

/** Persists a value on a best-effort basis: storage failures are ignored. */
export function writeStored(
  key: string,
  value: unknown,
  store: KeyValueStore | null = browserStorage()
): void {
  try {
    store?.setItem(key, JSON.stringify(value))
  } catch {
    // Persistence is a convenience; a blocked or full store must never break the UI.
  }
}
