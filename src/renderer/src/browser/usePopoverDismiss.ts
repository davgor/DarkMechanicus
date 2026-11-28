import { useEffect } from 'react'
import type { RefObject } from 'react'

/**
 * Closes a Browser toolbar popover on Escape (focus back on its trigger, the anchor's own button) or a press outside
 * the anchor, only while it is open.
 */
export function usePopoverDismiss(open: boolean, anchor: RefObject<HTMLElement>, close: () => void): void {
  useEffect(() => {
    if (!open) return undefined
    const onPress = (event: MouseEvent): void => {
      if (!(event.target instanceof Node && anchor.current?.contains(event.target))) close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      close()
      anchor.current?.querySelector<HTMLElement>(':scope > button')?.focus()
    }
    document.addEventListener('mousedown', onPress)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPress)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, anchor, close])
}
