import { useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { attachmentUrl } from '../../../shared/desktop/attachmentUrl'
import type { AttachmentPurpose, AttachmentRef } from '../../../shared/domain/views'
import { classNames } from '../components/classNames'
import { Icon } from '../components/Icon'
import './attachments.css'

/** What the gallery shows of an image: its id, label, purpose and size, and whether its bytes are gone. */
export interface GalleryAttachment extends Pick<AttachmentRef, 'id' | 'label' | 'purpose' | 'width' | 'height'> {
  /** True when the stored bytes are gone: a placeholder is shown and nothing is requested. */
  missing?: boolean
}

interface AttachmentGalleryProps {
  /** The folder's attachment key (`TrackedFolderView.attachmentKey`): the host of each image address. */
  folderKey: string
  attachments: readonly GalleryAttachment[]
}

const PURPOSE_LABEL: Record<AttachmentPurpose, string> = { evidence: 'Evidence', reference: 'Reference' }

/** Ids of images that failed to load in this view; a failed image shows the same placeholder as a missing one. */
type BrokenIds = ReadonlySet<string>

interface PictureProps {
  folderKey: string
  item: GalleryAttachment
  broken: BrokenIds
  onBroken(id: string): void
  className: string
}

/** The image itself, or a placeholder with its label when the bytes are missing or will not load. */
function Picture({ folderKey, item, broken, onBroken, className }: PictureProps): JSX.Element {
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
      src={attachmentUrl(folderKey, item.id)}
      alt={item.label}
      width={item.width}
      height={item.height}
      onError={() => onBroken(item.id)}
    />
  )
}

function PurposeBadge({ purpose }: { purpose: AttachmentPurpose }): JSX.Element {
  return <span className={classNames('attachment-badge', `attachment-badge-${purpose}`)}>{PURPOSE_LABEL[purpose]}</span>
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

interface LightboxProps {
  folderKey: string
  attachments: readonly GalleryAttachment[]
  index: number
  broken: BrokenIds
  onBroken(id: string): void
  onIndex(index: number): void
  onClose(): void
}

/** The full-size view of one image, with its label, its position in the set, and previous and next controls. */
function Lightbox({ folderKey, attachments, index, broken, onBroken, onIndex, onClose }: LightboxProps): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null)
  const count = attachments.length
  useFocusOnOpen(closeRef)
  useLightboxKeys(count, index, onIndex, onClose)
  const item = attachments[index]
  if (item === undefined) {
    return <></>
  }
  const step = (delta: number): void => onIndex((index + delta + count) % count)
  return (
    <div className="attachment-lightbox-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="attachment-lightbox" role="dialog" aria-modal="true" aria-label={item.label}>
        <header className="attachment-lightbox-header">
          <PurposeBadge purpose={item.purpose} />
          <span className="attachment-lightbox-label">{item.label}</span>
          <span className="attachment-lightbox-count">
            {index + 1} / {count}
          </span>
          <button ref={closeRef} type="button" className="btn btn-ghost btn-sm btn-icon" aria-label="Close" title="Close" onClick={onClose}>
            <Icon name="close" />
          </button>
        </header>
        <div className="attachment-lightbox-stage">
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Previous attachment" disabled={count < 2} onClick={() => step(-1)}>
            ‹
          </button>
          <Picture folderKey={folderKey} item={item} broken={broken} onBroken={onBroken} className="attachment-lightbox-image" />
          <button type="button" className="btn btn-ghost btn-sm" aria-label="Next attachment" disabled={count < 2} onClick={() => step(1)}>
            ›
          </button>
        </div>
      </div>
    </div>
  )
}

interface ThumbnailProps extends Omit<PictureProps, 'className'> {
  onOpen(): void
}

/** One image as a fixed-height thumbnail, with its badge and label under it. */
function Thumbnail({ onOpen, ...picture }: ThumbnailProps): JSX.Element {
  const { item } = picture
  return (
    <div role="listitem" className="attachment-item">
      <button type="button" className="attachment-thumb" aria-label={`Open ${item.label}`} onClick={onOpen}>
        <Picture {...picture} className="attachment-thumb-image" />
      </button>
      <div className="attachment-caption">
        <PurposeBadge purpose={item.purpose} />
        <span className="attachment-caption-label">{item.label}</span>
      </div>
    </div>
  )
}

/**
 * Thumbnails of stored images, fixed height, each with its label and an Evidence or Reference badge. A click
 * opens the lightbox at full size. Images are requested through `dm-attachment:` by id; nothing here takes a path.
 */
export function AttachmentGallery({ folderKey, attachments }: AttachmentGalleryProps): JSX.Element | null {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [broken, setBroken] = useState<BrokenIds>(() => new Set())

  if (attachments.length === 0) {
    return null
  }
  const onBroken = (id: string): void => {
    setBroken((previous) => new Set(previous).add(id))
  }

  return (
    <>
      <div className="attachment-gallery" role="list" aria-label="Attachments">
        {attachments.map((item, index) => (
          <Thumbnail
            key={item.id}
            folderKey={folderKey}
            item={item}
            broken={broken}
            onBroken={onBroken}
            onOpen={() => setOpenIndex(index)}
          />
        ))}
      </div>
      {openIndex === null ? null : (
        <Lightbox
          folderKey={folderKey}
          attachments={attachments}
          index={openIndex}
          broken={broken}
          onBroken={onBroken}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </>
  )
}
