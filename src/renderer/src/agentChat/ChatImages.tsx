import { createContext, useContext, useMemo, useState } from 'react'
import type { AgentChatApi } from '../../../shared/agents/agentChat'
import type { ChatItem } from '../../../shared/agents/chat'
import type { CommandResult } from '../../../shared/desktop/api'
import { errorMessage } from '../api/dm'
import { Lightbox, Picture, useBrokenIds, type LightboxItem } from '../attachments/Lightbox'
import './chatImages.css'

/** An image a transcript item names: one the person sent (PNG or JPEG) or one a tool returned (also WebP). */
type TranscriptImageRef = NonNullable<Extract<ChatItem, { kind: 'tool_call' }>['images']>[number]

/** The address of a transcript image's bytes; a GUI chat answers `chatImageUrl(folderKey, chatId, ref.id)`. */
export type ChatImageSrc = (ref: TranscriptImageRef) => string

/** A ticket of the epic an image can go to: its id, and the key the person reads. */
interface EvidenceTicket {
  id: string
  key: string
}

/** The epic a chat works in, which its images can be attached to as evidence; a chat outside an epic has none. */
export interface ChatEpic {
  epicId: string
  /** The epic's saved tickets, to resolve a thread's bound ticket key to its id. */
  tickets: readonly EvidenceTicket[]
  /** Confirms an attach, naming where the image went. */
  confirm(message: string): void
}

/** Attach as evidence for one chat's images: where each one goes, and the request that attaches it. */
interface ChatEvidence {
  /** The ticket the image's thread is bound to; null for the epic. */
  targetOf(imageId: string): EvidenceTicket | null
  attach(imageId: string, ticket: EvidenceTicket | null): Promise<CommandResult<unknown>>
  confirm(message: string): void
}

/** The open chat's evidence action; null outside an epic, where no thumbnail offers it. */
const ChatEvidenceContext = createContext<ChatEvidence | null>(null)
export const ChatEvidenceProvider = ChatEvidenceContext.Provider

type ThreadItem = Extract<ChatItem, { kind: 'thread' }>

/**
 * The ticket each image goes to: the nearest thread, from the item that carries the image outward, that main bound to
 * an attempt of one of the epic's tickets (a verified callsign); an image outside such a thread goes to the epic.
 */
function evidenceTargets(items: readonly ChatItem[], tickets: readonly EvidenceTicket[]): ReadonlyMap<string, EvidenceTicket> {
  const byKey = new Map(tickets.map((ticket) => [ticket.key, ticket]))
  const threads = new Map(items.filter((item): item is ThreadItem => item.kind === 'thread').map((thread) => [thread.id, thread]))
  const boundTicket = (threadId: string | undefined): EvidenceTicket | null => {
    const seen = new Set<string>()
    let thread = threadId === undefined ? undefined : threads.get(threadId)
    while (thread !== undefined && !seen.has(thread.id)) {
      seen.add(thread.id)
      const { callsign } = thread
      if (callsign?.ticketVerified === true && callsign.ticketKey !== null) return byKey.get(callsign.ticketKey) ?? null
      thread = thread.threadId === undefined ? undefined : threads.get(thread.threadId)
    }
    return null
  }
  const targets = new Map<string, EvidenceTicket>()
  for (const item of items) {
    if ((item.kind !== 'user_message' && item.kind !== 'tool_call') || item.images === undefined) continue
    const ticket = boundTicket(item.threadId)
    if (ticket !== null) for (const image of item.images) targets.set(image.id, ticket)
  }
  return targets
}

/** The chat's evidence action inside an epic (`epic`); null for a chat outside one or without a folder. */
export function useChatEvidence({ folder, chatId, api, items, epic }: {
  folder: string | null
  chatId: string
  /** Defaults to `window.dm.agentChat`, like the chat's own subscription. */
  api: AgentChatApi | undefined
  items: readonly ChatItem[]
  epic: ChatEpic | undefined
}): ChatEvidence | null {
  const epicId = epic?.epicId, tickets = epic?.tickets, confirm = epic?.confirm
  return useMemo<ChatEvidence | null>(() => {
    if (epicId === undefined || tickets === undefined || confirm === undefined || folder === null) return null
    const targets = evidenceTargets(items, tickets)
    return {
      targetOf: (imageId) => targets.get(imageId) ?? null,
      attach: (imageId, ticket) => (api ?? window.dm.agentChat).attachEvidence({
        folder, chatId, imageId, epicId, ...(ticket === null ? {} : { ticketId: ticket.id })
      }),
      confirm
    }
  }, [folder, chatId, api, items, epicId, tickets, confirm])
}

/** A thumbnail's Attach as evidence: to its thread's bound ticket, else the epic; failures show under it. */
function AttachEvidence({ imageId, label }: { imageId: string; label: string }): JSX.Element | null {
  const evidence = useContext(ChatEvidenceContext)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (evidence === null) return null
  const ticket = evidence.targetOf(imageId)
  const where = ticket === null ? 'the epic' : ticket.key
  async function attach(current: ChatEvidence): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const result = await current.attach(imageId, ticket)
      if (result.ok) current.confirm(`Attached the image to ${where} as evidence.`)
      else setError(result.error.message)
    } catch (cause) {
      setError(errorMessage(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <button type="button" className="chat-image-evidence" disabled={busy} aria-label={`Attach ${label} as evidence to ${where}`}
        onClick={() => { void attach(evidence) }}>
        Attach as evidence
      </button>
      {error !== null && <p className="chat-image-error" role="alert">{error}</p>}
    </>
  )
}

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
 * size. An image whose file is gone shows the broken placeholder. Inside an epic each thumbnail offers Attach as
 * evidence.
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
            <AttachEvidence imageId={item.id} label={item.label} />
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
