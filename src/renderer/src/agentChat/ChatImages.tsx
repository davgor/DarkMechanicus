import { useMemo, useState } from 'react'
import type { ChatItem } from '../../../shared/agents/chat'
import { Lightbox, Picture, useBrokenIds, type LightboxItem } from '../attachments/Lightbox'
import './chatImages.css'

/** An image a transcript item names: one the person sent (PNG or JPEG) or one a tool returned (also WebP). */
export type TranscriptImageRef = NonNullable<Extract<ChatItem, { kind: 'tool_call' }>['images']>[number]

/** The address of a transcript image's bytes; a GUI chat answers `chatImageUrl(folderKey, chatId, ref.id)`. */
export type ChatImageSrc = (ref: TranscriptImageRef) => string

interface Shown extends LightboxItem {
  ref: TranscriptImageRef
}

interface ChatImagesProps {
  /** Who the images came from: the person's message or the agent's tool. */
  from: 'you' | 'agent'
  images: readonly TranscriptImageRef[]
  imageSrc: ChatImageSrc
}

/**
 * The images on one transcript item as lazy thumbnails at most 160 px wide; a click opens the shared lightbox at full
 * size. An image whose file is gone shows the broken placeholder. Each thumbnail's list item is the slot for its
 * "Attach as evidence" action, which renders nothing until that action exists.
 */
export function ChatImages({ from, images, imageSrc }: ChatImagesProps): JSX.Element | null {
  const [openIndex, setOpenIndex] = useState<number | null>(null)
  const [broken, onBroken] = useBrokenIds()
  const items = useMemo<Shown[]>(() => images.map((ref) => ({
    id: ref.id, ref, width: ref.width, height: ref.height, label: `Image from ${from}, ${ref.width}x${ref.height}`
  })), [from, images])
  if (items.length === 0) {
    return null
  }
  const srcOf = (item: Shown): string => imageSrc(item.ref)
  return (
    <>
      <ul className="chat-images" aria-label={from === 'you' ? 'Your images' : 'Images from the agent'}>
        {items.map((item, index) => (
          <li key={item.id} className="chat-image">
            <button type="button" className="chat-image-thumb" aria-label={`Open ${item.label}`} onClick={() => setOpenIndex(index)}>
              <Picture item={item} srcOf={srcOf} broken={broken} onBroken={onBroken} className="chat-image-picture" loading="lazy" />
            </button>
          </li>
        ))}
      </ul>
      {openIndex === null ? null : (
        <Lightbox items={items} index={openIndex} srcOf={srcOf} broken={broken} onBroken={onBroken} onIndex={setOpenIndex}
          onClose={() => setOpenIndex(null)} />
      )}
    </>
  )
}
