import { useRef } from 'react'
import type { ChatImageRef } from '../../../shared/agents/chat'
import { chatImageUrl } from '../../../shared/agents/chatImageUrl'
import type { ImagePickerProps } from '../attachments/useImageAttach'
import { Icon } from '../components/Icon'

/**
 * The composer's staged images, above its text area: the last refusal or staging failure, then each image as a
 * thumbnail served by `dm-chat-image:` with a remove button, then a placeholder while another image stages.
 */
export function ChatImageChips({ folderKey, chatId, images, staging, error, remove }: {
  /** The chat's folder attachment key (`TrackedFolderView.attachmentKey`); null for a project-less chat. */
  folderKey: string | null
  chatId: string
  images: readonly ChatImageRef[]
  staging: boolean
  error: string | null
  remove(id: string): void
}): JSX.Element {
  return (
    <>
      {error !== null && <p className="chat-composer-error" role="alert">{error}</p>}
      {(images.length > 0 || staging) && <ul className="chat-image-chips" aria-label="Attached images">
        {images.map((image, index) => (
          <li key={image.id} className="chat-image-chip">
            <img src={chatImageUrl(folderKey, chatId, image.id)} alt={`Image ${index + 1}`} />
            <button type="button" className="chat-image-chip-remove" aria-label={`Remove image ${index + 1}`} title="Remove image"
              onClick={() => remove(image.id)}><Icon name="close" size={12} strokeWidth={2} /></button>
          </li>
        ))}
        {staging && <li className="chat-image-chip is-staging" aria-label="Adding image"><span className="chat-image-chip-spinner" aria-hidden="true" /></li>}
      </ul>}
    </>
  )
}

/** The composer's "+" button: opens the picker for PNG and JPEG images. */
export function ChatImageAttachButton({ pickerProps, disabled }: { pickerProps: ImagePickerProps; disabled: boolean }): JSX.Element {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button type="button" className="chat-composer-attach" aria-label="Attach images" title="Attach PNG or JPEG images"
        disabled={disabled} onClick={() => input.current?.click()}><Icon name="plus" size={16} strokeWidth={2} /></button>
      <input ref={input} {...pickerProps} hidden tabIndex={-1} />
    </>
  )
}
