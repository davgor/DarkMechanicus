import { createContext, useRef, useState } from 'react'
import { CHAT_IMAGES_PER_MESSAGE } from '../../../shared/agents/agentChat'
import type { ChatImageRef } from '../../../shared/agents/chat'
import type { CommandResult } from '../../../shared/desktop/api'
import { errorMessage } from '../api/dm'
import {
  pickerPropsFor, precheck, readBase64, targetPropsFor, type ImagePickerProps, type ImageTargetProps
} from '../attachments/useImageAttach'

/** Hands main one image's plain base64 for the chat (`agentChat.stageImage`). */
type StageImage = (data: string) => Promise<CommandResult<{ image: ChatImageRef }>>

/** What other panels may do with the composer's images: add one main already staged for the chat. */
interface ChatImagesHandle {
  /** Adds a staged image as a chip; refuses it inline and answers false when the message is full. */
  addStaged(ref: ChatImageRef): boolean
}

/** The open chat's composer images, for panels that stage images themselves (the browser camera); null outside a chat. */
export const ChatImagesContext = createContext<ChatImagesHandle | null>(null)

export interface ChatImages extends ChatImagesHandle {
  /** The staged images, in the order they were added: the chips, and the ids Send names. */
  images: readonly ChatImageRef[]
  /** The last refusal or staging failure, shown inline; null when the last batch went through. */
  error: string | null
  /** An image is being read or staged; Send waits for it. */
  staging: boolean
  remove(id: string): void
  /** Drops the chips of a message once it was sent; chips added meanwhile stay. */
  clear(ids: readonly string[]): void
  /** Spread onto the composer, which takes paste and drop. */
  targetProps: ImageTargetProps
  /** Spread onto the file `<input>` behind the attach button. */
  pickerProps: ImagePickerProps
}

const FULL = `At most ${CHAT_IMAGES_PER_MESSAGE} images can go with one message.`

/** Splits dropped, pasted or picked files into those to stage (at most `room`) and the first refusal, shown inline. */
function sortIntake(files: File[], room: number): { accepted: File[]; problem: string | null } {
  const accepted: File[] = []
  let problem: string | null = null
  for (const file of files) {
    const refused = precheck(file) ?? (accepted.length >= room ? FULL : null)
    if (refused === null) accepted.push(file)
    else problem ??= refused
  }
  return { accepted, problem }
}

/** Stages each file in turn as plain base64; `add` takes each ref main answers. Resolves with the first failure. */
async function stageFiles(stage: StageImage, files: File[], add: (image: ChatImageRef) => void, settled: () => void): Promise<string | null> {
  let problem: string | null = null
  for (const file of files) {
    try {
      const result = await stage(await readBase64(file))
      if (result.ok) add(result.data.image)
      else problem ??= result.error.message
    } catch (failure: unknown) {
      problem ??= errorMessage(failure)
    }
    settled()
  }
  return problem
}

/**
 * Paste, drop and picker intake for one chat's composer. Each PNG or JPEG is checked in the renderer, read as plain
 * base64 and staged with main; the ref main answers becomes a chip. A wrong type, an oversized file or an image past
 * the per-message limit is refused inline without staging; a failed stage shows its message and adds nothing.
 */
export function useChatImages(stage: StageImage): ChatImages {
  const [images, setImages] = useState<readonly ChatImageRef[]>([])
  const [error, setError] = useState<string | null>(null)
  const [inFlight, setInFlight] = useState(0)
  // The chips as of the last change, and the images still staging: together they count against the limit, so a
  // second paste before the first one lands sees the first one's images.
  const list = useRef<readonly ChatImageRef[]>([])
  const staging = useRef(0)
  const room = (): number => CHAT_IMAGES_PER_MESSAGE - list.current.length - staging.current
  const publish = (next: readonly ChatImageRef[]): void => {
    list.current = next
    setImages(next)
  }

  const take = (files: File[]): void => {
    const { accepted, problem } = sortIntake(files, room())
    setError(problem)
    if (accepted.length === 0) return
    staging.current += accepted.length
    setInFlight((count) => count + 1)
    void stageFiles(stage, accepted, (image) => publish([...list.current, image]), () => { staging.current -= 1 }).then((failure) => {
      setError(problem ?? failure)
      setInFlight((count) => count - 1)
    })
  }
  const drop = (ids: readonly string[]): void => {
    publish(list.current.filter((image) => !ids.includes(image.id)))
    setError(null)
  }

  return {
    images,
    error,
    staging: inFlight > 0,
    addStaged: (ref) => {
      if (list.current.some((image) => image.id === ref.id)) return true
      const full = room() <= 0
      setError(full ? FULL : null)
      if (!full) publish([...list.current, ref])
      return !full
    },
    remove: (id) => drop([id]),
    clear: drop,
    targetProps: targetPropsFor(take),
    pickerProps: pickerPropsFor(take)
  }
}
