import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { createPortal } from 'react-dom'
import { classNames } from '../components/classNames'
import { Icon } from '../components/Icon'
import { useOverlayOpen } from '../components/overlays'
import './attachments.css'

/** What the shared image views need of an image: an id, the words that name it, its size, and whether its bytes are gone. */
export interface LightboxItem {
  id: string
  label: string
  width?: number
  height?: number
  /** True when the stored bytes are gone: a placeholder is shown and nothing is requested. */
  missing?: boolean
}

/** Ids of images that failed to load in this view; a failed image shows the same placeholder as a missing one. */
export type BrokenIds = ReadonlySet<string>

/** The images of one view that failed to load, and the callback an image calls when it fails. */
export function useBrokenIds(): [BrokenIds, (id: string) => void] {
  const [broken, setBroken] = useState<BrokenIds>(() => new Set())
  const onBroken = useCallback((id: string): void => {
    setBroken((previous) => new Set(previous).add(id))
  }, [])
  return [broken, onBroken]
}

interface PictureProps<T extends LightboxItem> {
  item: T
  /** The address of the image's bytes, a `dm-…:` scheme URL by id; never a path. */
  srcOf(item: T): string
  broken: BrokenIds
  onBroken(id: string): void
  className: string
  loading?: 'lazy'
}

/** The image itself, or a placeholder with its label when the bytes are missing or will not load. */
export function Picture<T extends LightboxItem>({ item, srcOf, broken, onBroken, className, loading }: PictureProps<T>): JSX.Element {
  if (item.missing === true || broken.has(item.id)) {
    return (
      <div className={classNames(className, 'attachment-missing')} role="img" aria-label={`${item.label} (image missing)`}>
        <Icon name="warning" />
        <span className="attachment-missing-label">{item.label}</span>
        <span className="attachment-missing-note">Image missing</span>
      </div>
    )
  }
  return (
    <img
      className={className}
      src={srcOf(item)}
      alt={item.label}
      width={item.width}
      height={item.height}
      loading={loading}
      onError={() => onBroken(item.id)}
    />
  )
}

/** Escape closes; the arrow keys step to the previous or next image, wrapping at either end. */
function useLightboxKeys(count: number, index: number, onIndex: (index: number) => void, onClose: () => void): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const step = event.key === 'ArrowLeft' ? -1 : 1
        onIndex((index + step + count) % count)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [count, index, onClose, onIndex])
}

/** Moves focus into the lightbox on open and back to whatever opened it on close. */
function useFocusOnOpen(target: RefObject<HTMLButtonElement>): void {
  useEffect(() => {
    const opener = document.activeElement
    target.current?.focus()
    return () => {
      if (opener instanceof HTMLElement) {
        opener.focus()
      }
    }
  }, [target])
}

interface LightboxProps<T extends LightboxItem> {
  items: readonly T[]
  index: number
  srcOf(item: T): string
  /** Shown before the label in the header, such as an attachment's purpose. */
  badge?(item: T): ReactNode
  broken: BrokenIds
  onBroken(id: string): void
  onIndex(index: number): void
  onClose(): void
}

/**
 * The full-size view of one image, with its label, its position in the set, and previous and next controls. It is
 * drawn into the document body, so no glass or scrolling ancestor clips it, and an Escape inside it closes it alone:
 * the key goes no further, so a chat behind it does not also take it as Stop.
 */
export function Lightbox<T extends LightboxItem>({ items, index, srcOf, badge, broken, onBroken, onIndex, onClose }: LightboxProps<T>): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const count = items.length
  useFocusOnOpen(closeRef)
  useLightboxKeys(count, index, onIndex, onClose)
  useOverlayOpen()
  const item = items[index]
  if (item === undefined) {
    return <></>
  }
  const step = (delta: number): void => onIndex((index + delta + count) % count)
  return createPortal(
    <div
      className="attachment-lightbox-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label={item.label}>
        <header className="attachment-lightbox-header">
          {badge?.(item)}
          <span className="attachment-lightbox-label">{item.label}</span>
          <span className="attachment-lightbox-count">
            {index + 1} / {count}
          </span>
          <button ref={closeRef} type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Close" title="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="attachment-lightbox-stage">
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Previous image" disabled={count < 2} onClick={() => step(-1)}>
            ‹
          </button>
          <Picture item={item} srcOf={srcOf} broken={broken} onBroken={onBroken} className="attachment-lightbox-image" />
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Next image" disabled={count < 2} onClick={() => step(1)}>
            ›
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
