import { useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { ImageTargetProps } from '../attachments/useImageAttach'
import { Icon } from '../components/Icon'
import './chatComposer.css'

/** The keys, said once: the Send button's title and the text area's screen-reader note. */
const SEND_KEYS = 'Enter to send · Shift+Enter for a new line'
/** The composer grows with its text up to this share of the chat pane's height, then scrolls. */
const MAX_PANE_SHARE = 0.4

interface ChatComposerProps {
  /** The text area's id. */
  id: string
  /** The text area's accessible name, such as `Message Magos`. */
  label: string
  placeholder: string
  /** The agent chip: its label with its role or callsign, such as `Magos · Skitarii`. */
  agent: string
  /** The context chip (the epic or the folder); none when null. */
  context: string | null
  /** Turns waiting behind the running one; a chip shows them when there are any. */
  queued: number
  maxLength: number
  /** No text can be written or sent (the agent is not ready). */
  disabled: boolean
  /** A command is in flight: Send and Stop wait for it. */
  acting: boolean
  /** The agent is working: Stop replaces Send. */
  busy: boolean
  error: string | null
  /** A screen-reader note on the text area beside the keys, such as where a relayed message goes. */
  note?: string
  /** Sends the text (empty when only images go); resolves true once it was taken, which clears it while it is still the current text. */
  send(text: string): Promise<boolean>
  stop?(): void
  /** Controls before the chips (the attach button). */
  leading?: ReactNode
  /** Controls between the chips and Send (the model chip). */
  trailing?: ReactNode
  /** Images going with the next message: their chips above the text area, and paste and drop onto the card. */
  attachments?: {
    chips: ReactNode
    /** Staged images: Send is allowed with them even when the text is empty. */
    count: number
    /** An image is still staging: Send waits for it. */
    staging: boolean
    intake: ImageTargetProps
  }
}

/** Sizes the text area to its content, capped at a share of the chat pane, on every text change and pane resize. */
function useAutoGrow(text: string): RefObject<HTMLTextAreaElement> {
  const area = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const node = area.current
    if (node === null) return
    const pane = node.closest<HTMLElement>('.agent-chat') ?? node.parentElement
    const fit = (): void => {
      node.style.height = 'auto'
      const cap = (pane?.clientHeight ?? 0) * MAX_PANE_SHARE
      const content = node.scrollHeight
      if (content === 0) {
        node.style.height = ''
        return
      }
      const overflows = cap > 0 && content > cap
      node.style.height = `${overflows ? cap : content}px`
      node.style.overflowY = overflows ? 'auto' : 'hidden'
    }
    fit()
    if (typeof ResizeObserver === 'undefined' || pane === null) return
    const observer = new ResizeObserver(fit)
    observer.observe(pane)
    return () => observer.disconnect()
  }, [text])
  return area
}

/** What Send would send: the draft, or empty text when only images go; null while nothing may be sent. */
function outgoing(text: string, { disabled, maxLength, attachments }: ChatComposerProps): string | null {
  if (disabled || text.length > maxLength || attachments?.staging === true) return null
  if (text.trim() !== '') return text
  return (attachments?.count ?? 0) > 0 ? '' : null
}

/**
 * Every GUI chat's composer: a rounded glass card holding any image chips over an auto-growing text area over a row of
 * the leading slot, the agent, context and queue chips, the trailing slot and a round Send that turns into a square Stop
 * while busy. Pasting or dropping images anywhere on the card hands them to `attachments`.
 */
export function ChatComposer(props: ChatComposerProps): JSX.Element {
  const { id, label, placeholder, agent, context, queued, maxLength, disabled, acting, busy, error, note, send, stop, leading, trailing, attachments } = props
  const [text, setText] = useState('')
  const area = useAutoGrow(text)
  const keysId = useId()
  // A second Enter can land before the parent re-renders with `acting`; one send at a time either way.
  const inFlight = useRef(false)
  const message = outgoing(text, props)
  async function submit(): Promise<void> {
    if (message === null || acting || inFlight.current) return
    const draft = text
    inFlight.current = true
    try {
      if (await send(message)) setText((current) => (current === draft ? '' : current))
    } finally {
      inFlight.current = false
    }
  }
  return (
    <form className="chat-composer glass" {...attachments?.intake} onSubmit={(event) => { event.preventDefault(); void submit() }}>
      {error !== null && <p className="chat-composer-error" role="alert">{error}</p>}
      {attachments?.chips}
      <label className="sr-only" htmlFor={id}>{label}</label>
      <span className="sr-only" id={keysId}>{note === undefined ? SEND_KEYS : `${note} ${SEND_KEYS}`}</span>
      <textarea ref={area} className="chat-composer-input" id={id} value={text} maxLength={maxLength} rows={1} disabled={disabled}
        placeholder={placeholder} aria-describedby={keysId} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void submit()
          }
        }} />
      <div className="chat-composer-row">
        {leading}
        <span className="chat-composer-chip" aria-label={`Agent: ${agent}`}>{agent}</span>
        {context !== null && <span className="chat-composer-chip" aria-label={`Context: ${context}`}>{context}</span>}
        {queued > 0 && <span className="chat-composer-chip" aria-label="Queued messages">{queued} queued</span>}
        <span className="chat-composer-spacer" />
        {trailing}
        {busy
          ? <button className="chat-composer-stop" type="button" aria-label="Stop" title="Stop (Escape)" disabled={acting}
            onClick={() => stop?.()}><span className="chat-composer-stop-mark" aria-hidden="true" /></button>
          : <button className="chat-composer-send" type="submit" aria-label="Send" title={SEND_KEYS} aria-describedby={keysId}
            disabled={message === null || acting}><Icon name="arrow-up" size={16} strokeWidth={2} /></button>}
      </div>
    </form>
  )
}
