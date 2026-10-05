import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { isNearBottom } from './activityView'

interface FollowScroll<T extends HTMLElement> {
  ref: RefObject<T>
  onScroll(): void
  /** True while the person has scrolled away from the newest row: the log no longer follows. */
  away: boolean
  /** Scrolls to the newest row and follows again. */
  jump(): void
}

/**
 * Keeps a scrolling log at its newest row whenever `changeKey` changes, unless the person has scrolled up:
 * following stops when they leave the end of the log and resumes when they come back to it (or jump).
 */
export function useFollowScroll<T extends HTMLElement>(changeKey: unknown): FollowScroll<T> {
  const ref = useRef<T>(null)
  const following = useRef(true)
  const [away, setAway] = useState(false)

  const onScroll = useCallback((): void => {
    const element = ref.current
    if (element !== null) {
      following.current = isNearBottom(element)
      setAway(!following.current)
    }
  }, [])

  const jump = useCallback((): void => {
    const element = ref.current
    if (element !== null) {
      element.scrollTop = element.scrollHeight
    }
    following.current = true
    setAway(false)
  }, [])

  useLayoutEffect(() => {
    const element = ref.current
    if (element !== null && following.current) {
      element.scrollTop = element.scrollHeight
    }
  }, [changeKey])

  return { ref, onScroll, away, jump }
}
