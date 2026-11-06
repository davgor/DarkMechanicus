import { useEffect, useRef } from 'react'
import { attachmentUrl } from '../../../shared/desktop/attachmentUrl'
import type { Runner } from '../epic/runner'
import { useImageAttach } from './useImageAttach'

/** An image a form lists: one the record already has, or one just uploaded and not yet claimed. */
export interface FormImage {
  id: string
  label: string
}

interface ImageAttachFieldProps {
  runner: Runner
  /** The folder's attachment key: the host of each image address. */
  folderKey: string
  /** Every image the record will carry once saved, existing and newly uploaded. */
  images: readonly FormImage[]
  onChange(images: FormImage[]): void
}

/**
 * The attach control of a record form: paste, drop or pick PNG and JPEG images; each upload joins the list and each
 * listed image (new or existing) can be removed. Nothing is claimed until the form is saved with the ids.
 */
export function ImageAttachField({ runner, folderKey, images, onChange }: ImageAttachFieldProps): JSX.Element {
  const attach = useImageAttach(runner)
  const latest = useRef(images)
  latest.current = images
  const { pending } = attach
  useEffect(() => {
    const fresh = pending.filter((item) => !latest.current.some((image) => image.id === item.id))
    if (fresh.length > 0) {
      onChange([...latest.current, ...fresh])
    }
  }, [pending])
  const remove = (id: string): void => {
    attach.remove(id)
    onChange(images.filter((image) => image.id !== id))
  }
  return (
    <div className="field" {...attach.targetProps}>
      <span className="field-label">Images</span>
      <span className="field-hint">Paste or drop PNG or JPEG images here, or attach them.</span>
      {attach.error === null ? null : (
        <p role="alert" className="form-error">
          {attach.error}
        </p>
      )}
      {images.length === 0 ? null : (
        <ul className="tp-pending-images" aria-label="Attached images">
          {images.map((image) => (
            <li key={image.id} className="tp-pending-image">
              <img src={attachmentUrl(folderKey, image.id)} alt={image.label} height={48} />
              <span>{image.label}</span>
              <button type="button" className="btn" aria-label={`Remove ${image.label}`} onClick={() => remove(image.id)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <label className="btn">
        {attach.busy ? 'Uploading…' : 'Attach image'}
        <input {...attach.pickerProps} hidden />
      </label>
    </div>
  )
}
