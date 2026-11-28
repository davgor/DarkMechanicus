import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { parseCallsignLabel } from '../../../shared/agents/callsign'
import type { ChatImageRef } from '../../../shared/agents/chat'
import { chatImageUrl } from '../../../shared/agents/chatImageUrl'
import type { BrowserApi, BrowserState } from '../../../shared/browser/browserApi'
import type { ChatEpic } from '../agentChat/ChatImages'
import { ChatImagesContext, type ChatImagesHandle } from '../agentChat/useChatImages'
import { errorMessage } from '../api/dm'
import { Icon } from '../components/Icon'
import { usePopoverDismiss } from './usePopoverDismiss'

/** The epic the browser's chat works in, whose captures Attach as evidence can go to; none outside an epic. */
export const BrowserEpicContext = createContext<ChatEpic | null>(null)

type EvidenceTicket = ChatEpic['tickets'][number]

/** A capture the popover shows: the image main stored for the chat and where its evidence goes, or why it failed. */
type Shot = { image: ChatImageRef; ticket: EvidenceTicket | null } | { failure: string }

const NO_COMPOSER = 'No message is open for this chat here. Open its chat to add the capture to a message.'
const FULL = 'The message already has as many images as it can take.'

/** The bound ticket of the agent driving the browser: main names it in the badge only once it verified the callsign. */
function drivingTicket(state: BrowserState | null, tickets: readonly EvidenceTicket[]): EvidenceTicket | null {
  if (state?.owner !== 'agent' || state.ownerLabel === null) return null
  const key = parseCallsignLabel(state.ownerLabel)?.ticketKey
  return tickets.find((ticket) => ticket.key === key) ?? null
}

/** Why the camera is off: no agent tab yet, or the private tab shown over it, which is never captured. */
function cameraTitle(state: BrowserState | null): string {
  if (state?.tab == null) return 'Capture the agent tab (no page open yet)'
  return state.signIn === null ? 'Capture the agent tab' : 'The private tab is never captured'
}

/** False once the component unmounted, so a late answer leaves its state alone. */
function useAlive(): { readonly current: boolean } {
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])
  return alive
}

/** One capture at a time of the chat's agent tab; each answer, a shot or why it failed, opens the popover. */
function useCapture({ folder, chatId, state, api, epic, opened }: {
  folder: string | null
  chatId: string
  state: BrowserState | null
  api: BrowserApi
  epic: ChatEpic | null
  opened(): void
}): { shot: Shot | null; capturing: boolean; capture(): Promise<void> } {
  const [shot, setShot] = useState<Shot | null>(null)
  const [capturing, setCapturing] = useState(false)
  const alive = useAlive()
  async function capture(): Promise<void> {
    setCapturing(true)
    let next: Shot
    try {
      const result = await api.capture({ folder, chatId })
      // The evidence target is the agent driving when the page was captured, which is what the picture shows.
      next = result.ok ? { image: result.data.image, ticket: epic === null ? null : drivingTicket(state, epic.tickets) } : { failure: result.error.message }
    } catch (cause) {
      next = { failure: errorMessage(cause) }
    }
    if (!alive.current) return
    setCapturing(false)
    setShot(next)
    opened()
  }
  return { shot, capturing, capture }
}

/**
 * The Browser toolbar's camera: captures the chat's agent tab (`browser.capture`, which keeps the PNG in the chat's
 * image store) and opens a popover with its thumbnail. **Add to message** puts it on the chat's composer as a chip
 * (`ChatImagesContext`); with no composer open for the chat (a terminal chat, or a thread shown in its place) it is
 * off and says why. **Attach as evidence** shows only inside an epic (`BrowserEpicContext`) and attaches the image
 * to the driving agent's bound ticket when the badge names one, else to the epic. The panel hides the native view
 * while the popover is open, since it drops over the page area.
 */
export function BrowserCamera({ folder, folderKey, chatId, state, api, open, onOpenChange }: {
  folder: string | null
  /** The folder's attachment key, the host of the thumbnail's address; null for a project-less chat. */
  folderKey: string | null
  chatId: string
  state: BrowserState | null
  api: BrowserApi
  open: boolean
  onOpenChange(open: boolean): void
}): JSX.Element {
  const composer = useContext(ChatImagesContext)
  const epic = useContext(BrowserEpicContext)
  const anchor = useRef<HTMLDivElement>(null)
  const close = useCallback(() => onOpenChange(false), [onOpenChange])
  usePopoverDismiss(open, anchor, close)
  const { shot, capturing, capture } = useCapture({ folder, chatId, state, api, epic, opened: () => onOpenChange(true) })

  const capturable = state?.tab != null && state.signIn === null && !capturing
  return (
    <div className="bp-camera" ref={anchor}>
      <button type="button" className="bp-icon" aria-label="Capture the agent tab" title={cameraTitle(state)} aria-haspopup="dialog"
        aria-expanded={open} disabled={!open && !capturable} onClick={() => { if (open) close(); else void capture() }}>
        <Icon name="camera" />
      </button>
      {open && shot !== null && (
        <div className="bp-camera-popover" role="dialog" aria-label="Captured page">
          {'failure' in shot
            ? <p className="bp-error" role="alert">{shot.failure}</p>
            : <ShotActions folder={folder} folderKey={folderKey} chatId={chatId} shot={shot} composer={composer} epic={epic} close={close} />}
        </div>
      )}
    </div>
  )
}

type CapturedShot = Extract<Shot, { image: ChatImageRef }>

/** Attach as evidence for one capture: to its ticket, else the epic; a refusal stays in the popover. */
function useEvidenceAttach(chatId: string, shot: CapturedShot, close: () => void) {
  const [attaching, setAttaching] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const alive = useAlive()
  const where = shot.ticket === null ? 'the epic' : shot.ticket.key
  async function attach(target: ChatEpic, chatFolder: string): Promise<void> {
    setAttaching(true)
    setProblem(null)
    try {
      const result = await window.dm.agentChat.attachEvidence({
        folder: chatFolder, chatId, imageId: shot.image.id, epicId: target.epicId, ...(shot.ticket === null ? {} : { ticketId: shot.ticket.id })
      })
      if (!alive.current) return
      if (result.ok) {
        target.confirm(`Attached the capture to ${where} as evidence.`)
        close()
      } else {
        setProblem(result.error.message)
      }
    } catch (cause) {
      if (alive.current) setProblem(errorMessage(cause))
    } finally {
      if (alive.current) setAttaching(false)
    }
  }
  return { attaching, problem, setProblem, where, attach }
}

function ShotActions({ folder, folderKey, chatId, shot, composer, epic, close }: {
  folder: string | null
  folderKey: string | null
  chatId: string
  shot: CapturedShot
  composer: ChatImagesHandle | null
  epic: ChatEpic | null
  close(): void
}): JSX.Element {
  const { attaching, problem, setProblem, where, attach } = useEvidenceAttach(chatId, shot, close)
  function add(): void {
    if (composer === null) return
    if (composer.addStaged(shot.image)) close()
    else setProblem(FULL)
  }

  return (
    <>
      <img className="bp-camera-thumb" src={chatImageUrl(folderKey, chatId, shot.image.id)}
        alt={`Capture of the agent tab, ${shot.image.width}x${shot.image.height}`} />
      <div className="bp-camera-actions">
        <button type="button" className="btn btn-sm btn-primary" disabled={composer === null} title={composer === null ? NO_COMPOSER : undefined}
          onClick={add}>Add to message</button>
        {epic !== null && folder !== null && (
          <button type="button" className="btn btn-sm" disabled={attaching} title={`Attach to ${where}`}
            onClick={() => { void attach(epic, folder) }}>Attach as evidence</button>
        )}
      </div>
      {composer === null && <p className="bp-camera-note">{NO_COMPOSER}</p>}
      {epic !== null && folder !== null && <p className="bp-camera-note">Evidence goes to {where}.</p>}
      {problem !== null && <p className="bp-error" role="alert">{problem}</p>}
    </>
  )
}
