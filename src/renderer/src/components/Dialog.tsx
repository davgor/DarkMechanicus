import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent, MouseEvent, ReactNode, RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * Where Tab should jump to keep focus inside a dialog: the first item when tabbing past the last,
 * the last when shift-tabbing before the first, otherwise null (the browser moves normally).
 */
export function wrapTarget<T>(items: readonly T[], active: unknown, backwards: boolean): T | null {
  const first = items[0]
  const last = items[items.length - 1]
  if (first === undefined || last === undefined) {
    return null
  }
  if (backwards) {
    return active === first ? last : null
  }
  return active === last ? first : null
}

function useDialogFocus(panel: RefObject<HTMLElement>): void {
  useEffect(() => {
    const previous = document.activeElement
    const target = panel.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panel.current
    target?.focus()
    return () => {
      if (previous instanceof HTMLElement) {
        previous.focus()
      }
    }
  }, [panel])
}

function trapTab(event: KeyboardEvent<HTMLElement>): void {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
  const target = wrapTarget(items, document.activeElement, event.shiftKey)
  if (target !== null) {
    event.preventDefault()
    target.focus()
  }
}

interface DialogProps {
  title: string
  description?: ReactNode
  onClose(): void
  children?: ReactNode
  /** Footer controls, usually a Cancel and a confirming Button. */
  actions?: ReactNode
}

export function Dialog({ title, description, onClose, children, actions }: DialogProps): JSX.Element {
  const titleId = useId()
  const descriptionId = useId()
  const panel = useRef<HTMLDivElement>(null)
  useDialogFocus(panel)

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    } else if (event.key === 'Tab') {
      trapTab(event)
    }
  }
  // Pressing (not clicking) the backdrop closes, so a text selection dragged out of a field does not.
  const onBackdropDown = (event: MouseEvent<HTMLElement>): void => {
    if (event.target === event.currentTarget) {
      onClose()
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={onBackdropDown}>
      <div
        ref={panel}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="dialog-header">
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="dialog-description">
              {description}
            </p>
          ) : null}
        </header>
        <div className="dialog-body">{children}</div>
        {actions ? <footer className="dialog-actions">{actions}</footer> : null}
      </div>
    </div>
  )
}
