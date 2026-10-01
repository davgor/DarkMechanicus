import { useRef } from 'react'
import type { MutableRefObject } from 'react'

/** A ref that always holds the newest value, so effects can call current callbacks without re-running. */
export function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value)
  ref.current = value
  return ref
}
