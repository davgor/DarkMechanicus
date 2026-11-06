import { type ChangeEvent, type ClipboardEvent, type DragEvent, useState } from 'react'
import { errorMessage } from '../api/dm'
import type { Runner } from '../epic/runner'

/** An uploaded, still unattached image: staged in the folder, claimed when the record that lists it is saved. */
export interface PendingImage {
  id: string
  label: string
}

/** What the command layer allows on one record. */
export const MAX_PENDING_IMAGES = 20
/** The command layer's cap on one image's bytes. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const ACCEPTED_TYPES = ['image/png', 'image/jpeg']
const DEFAULT_LABEL = 'Pasted image'

export interface ImageAttach {
  pending: PendingImage[]
  /** The last upload problem, shown inline; null when the last batch went through. */
  error: string | null
  busy: boolean
  /** Drops the image from the list. The staged row stays until it is pruned. */
  remove(id: string): void
  /** Empties the list (after the record is saved). */
  clear(): void
  /** Spread onto the element that takes paste and drop. */
  targetProps: {
    onPaste(event: ClipboardEvent): void
    onDrop(event: DragEvent): void
    onDragOver(event: DragEvent): void
  }
  /** Spread onto a file `<input>` behind the picker button. */
  pickerProps: {
    type: 'file'
    accept: string
    multiple: true
    onChange(event: ChangeEvent<HTMLInputElement>): void
  }
}

/** The file's bytes as plain base64 (the data: prefix of a data URL is dropped). */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : ''
      const comma = url.indexOf(',')
      resolve(comma === -1 ? '' : url.slice(comma + 1))
    }
    reader.onerror = () => reject(new Error(`Could not read ${file.name === '' ? DEFAULT_LABEL : file.name}.`))
    reader.readAsDataURL(file)
  })
}

function precheck(file: File): string | null {
  const name = file.name === '' ? DEFAULT_LABEL : file.name
  if (!ACCEPTED_TYPES.includes(file.type)) {
    return `${name} is not a PNG or JPEG image.`
  }
  if (file.size > MAX_IMAGE_BYTES) {
    return `${name} is larger than 10 MB.`
  }
  return null
}

interface UploadOutcome {
  uploaded: PendingImage[]
  problem: string | null
}

/** Uploads each file in turn (at most `room` of them) and reports what was staged and the first problem met. */
async function uploadFiles(runner: Runner, files: File[], room: number): Promise<UploadOutcome> {
  const uploaded: PendingImage[] = []
  let problem: string | null = null
  for (const file of files) {
    const refused = precheck(file)
    if (refused !== null) {
      problem ??= refused
    } else if (uploaded.length >= room) {
      problem ??= `At most ${MAX_PENDING_IMAGES} images can be attached.`
    } else {
      try {
        const label = file.name === '' ? DEFAULT_LABEL : file.name
        const view = await runner('uploadAttachment', { data: await readBase64(file), label, purpose: 'reference' })
        uploaded.push({ id: view.id, label: view.label })
      } catch (failure: unknown) {
        problem ??= errorMessage(failure)
      }
    }
  }
  return { uploaded, problem }
}

function clipboardImages(event: ClipboardEvent): File[] {
  return Array.from(event.clipboardData.items)
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

/** The element props for paste and drop; `take` receives the files of an event that carried any. */
function targetPropsFor(take: (files: File[]) => void): ImageAttach['targetProps'] {
  return {
    onPaste: (event) => {
      const files = clipboardImages(event)
      if (files.length > 0) {
        // Only an image paste is taken over; pasting text still goes to the field.
        event.preventDefault()
        take(files)
      }
    },
    onDrop: (event) => {
      const files = Array.from(event.dataTransfer.files)
      if (files.length > 0) {
        event.preventDefault()
        take(files)
      }
    },
    onDragOver: (event) => {
      if (Array.from(event.dataTransfer.types).includes('Files')) {
        event.preventDefault()
      }
    }
  }
}

/**
 * Paste, drop and picker intake for images. Each file is read in the renderer, sent as base64 through
 * `uploadAttachment` (never a path) and listed as pending. A failed upload shows its message inline and attaches nothing.
 */
export function useImageAttach(runner: Runner): ImageAttach {
  const [pending, setPending] = useState<PendingImage[]>([])
  const [error, setError] = useState<string | null>(null)
  const [inFlight, setInFlight] = useState(0)

  const take = (files: File[]): void => {
    setError(null)
    setInFlight((count) => count + 1)
    void uploadFiles(runner, files, MAX_PENDING_IMAGES - pending.length).then(({ uploaded, problem }) => {
      setPending((list) => [...list, ...uploaded])
      setError(problem)
      setInFlight((count) => count - 1)
    })
  }

  return {
    pending,
    error,
    busy: inFlight > 0,
    remove: (id) => setPending((list) => list.filter((item) => item.id !== id)),
    clear: () => {
      setPending([])
      setError(null)
    },
    targetProps: targetPropsFor(take),
    pickerProps: {
      type: 'file',
      accept: 'image/png,image/jpeg',
      multiple: true,
      onChange: (event) => {
        const files = Array.from(event.target.files ?? [])
        // Picking the same file again must fire a change.
        event.target.value = ''
        if (files.length > 0) {
          take(files)
        }
      }
    }
  }
}
