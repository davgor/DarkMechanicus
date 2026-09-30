import { useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { Button } from './Button'

interface MenuItem {
  id: string
  label: string
  onSelect(): void
}

interface MenuProps {
  /** Accessible name of the trigger and of the menu. */
  label: string
  open: boolean
  items: readonly MenuItem[]
  onOpenChange(open: boolean): void
}

/** Closes the menu on Escape or a press outside it, only while it is open. */
function useDismiss(open: boolean, anchor: RefObject<HTMLElement>, dismiss: () => void): void {
  useEffect(() => {
    if (!open) {
      return undefined
    }
    const onPress = (event: globalThis.MouseEvent): void => {
      if (!(event.target instanceof Node && anchor.current?.contains(event.target))) {
        dismiss()
      }
    }
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') {
        dismiss()
      }
    }
    document.addEventListener('mousedown', onPress)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPress)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, anchor, dismiss])
}

export function Menu({ label, open, items, onOpenChange }: MenuProps): JSX.Element {
  const anchor = useRef<HTMLDivElement>(null)
  useDismiss(open, anchor, () => onOpenChange(false))
  return (
    <div className="menu-anchor" ref={anchor}>
      <Button
        variant="ghost"
        size="sm"
        icon="more"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onOpenChange(!open)}
      />
      {open ? (
        <div className="menu" role="menu" aria-label={label}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className="menu-item"
              onClick={() => {
                onOpenChange(false)
                item.onSelect()
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
