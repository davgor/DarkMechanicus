import { useEffect, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { readStored, writeStored } from './storage'

/**
 * useState backed by localStorage. Reads are validated (stored data is untrusted) and writes are
 * best-effort, so the app behaves the same, minus memory, when storage is blocked.
 */
export function usePersistentState<T>(
  key: string,
  fallback: T,
  isValid: (value: unknown) => value is T
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => readStored(key, fallback, isValid))
  useEffect(() => {
    writeStored(key, value)
  }, [key, value])
  return [value, setValue]
}
