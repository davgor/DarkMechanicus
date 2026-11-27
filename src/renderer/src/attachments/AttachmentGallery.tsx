import { useState } from 'react'
import { attachmentUrl } from '../../../shared/desktop/attachmentUrl'
import type { AttachmentPurpose, AttachmentRef } from '../../../shared/domain/views'
import { classNames } from '../components/classNames'
import { Lightbox, Picture, useBrokenIds, type BrokenIds } from './Lightbox'
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

function PurposeBadge({ purpose }: { purpose: AttachmentPurpose }): JSX.Element {
  return <span className={classNames('attachment-badge', `attachment-badge-${purpose}`)}>{PURPOSE_LABEL[purpose]}</span>
}

interface ThumbnailProps {
  folderKey: string
  item: GalleryAttachment
  broken: BrokenIds
  onBroken(id: string): void
  onOpen(): void
}

/** One image as a fixed-height thumbnail, with its badge and label under it. */
function Thumbnail({ folderKey, item, broken, onBroken, onOpen }: ThumbnailProps): JSX.Element {
  return (
    <div role="listitem" className="attachment-item">
      <button type="button" className="attachment-thumb" aria-label={`Open ${item.label}`} onClick={onOpen}>
        <Picture item={item} srcOf={(shown) => attachmentUrl(folderKey, shown.id)} broken={broken} onBroken={onBroken}
          className="attachment-thumb-image" />
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
  const [broken, onBroken] = useBrokenIds()

  if (attachments.length === 0) {
    return null
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
          items={attachments}
          index={openIndex}
          srcOf={(item) => attachmentUrl(folderKey, item.id)}
          badge={(item) => <PurposeBadge purpose={item.purpose} />}
          broken={broken}
          onBroken={onBroken}
          onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)}
        />
      )}
    </>
  )
}
