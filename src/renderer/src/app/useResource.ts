import { useEffect, useState } from 'react'
import { useLatest } from './useLatest'

type Outcome<T> = { status: 'error' } | { status: 'ready'; value: T }

/** A value being loaded for a key: loading until it arrives, an error if it could not. */
export type Resource<T> = { status: 'loading' } | Outcome<T>

interface ResourceOptions<T> {
  /** Identity of what is loaded (e.g. a folder path). Null means there is nothing to load. */
  key: string | null
  /** Bump to refetch the same key. */
  version: number
  load(): Promise<T>
  onError(error: unknown): void
}

interface Loaded<T> {
  key: string
  outcome: Outcome<T>
}

const LOADING = { status: 'loading' } as const

/**
 * Loads a value per key and refetches on version changes. A response for a key that is no longer
 * current is dropped, the previous key's value is never shown, and a failed refresh keeps the last
 * good value instead of blanking the UI.
 */
export function useResource<T>(options: ResourceOptions<T>): Resource<T> {
  const [loaded, setLoaded] = useState<Loaded<T> | null>(null)
  const load = useLatest(options.load)
  const report = useLatest(options.onError)
  const { key, version } = options

  useEffect(() => {
    if (key === null) {
      return undefined
    }
    let current = true
    load.current().then(
      (value) => {
        if (current) setLoaded({ key, outcome: { status: 'ready', value } })
      },
      (error: unknown) => {
        if (!current) return
        setLoaded((previous) => keepReady(previous, key) ?? { key, outcome: { status: 'error' } })
        report.current(error)
      }
    )
    return () => {
      current = false
    }
  }, [key, version, load, report])

  return loaded !== null && loaded.key === key ? loaded.outcome : LOADING
}

/** The previous state when it already holds a good value for this key. */
function keepReady<T>(previous: Loaded<T> | null, key: string): Loaded<T> | null {
  return previous !== null && previous.key === key && previous.outcome.status === 'ready' ? previous : null
}
