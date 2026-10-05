import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import { Button } from '../components/Button'

/** The chat's limit for one message (characters), as the main process enforces it. */
const MAX_MESSAGE_LENGTH = 100_000

interface ChatComposerProps {
  /** The transcript is shown, so a message can be written. */
  ready: boolean
  /** The display name of the agent while it is signed out, which keeps the box off until it is signed in; null otherwise. */
  signedOutOf: string | null
  /** A turn is running: the input is off and Stop is offered. */
  running: boolean
  stopping: boolean
  /** Why the last send, stop or model switch failed. */
  error: string | null
  /** Resolves true once the message is stored, false after saying why it was not. */
  onSend(text: string): Promise<boolean>
  onStop(): void
}

/** Focuses the input again when a turn ends, so the next message can be typed at once. */
function useRefocusAfterTurn(running: boolean): RefObject<HTMLTextAreaElement> {
  const input = useRef<HTMLTextAreaElement>(null)
  const was = useRef(running)
  useEffect(() => {
    if (was.current && !running) {
      input.current?.focus()
    }
    was.current = running
  }, [running])
  return input
}

interface Draft {
  text: string
  setText(text: string): void
  /** Sends the draft if it can be sent; a message that could not be stored is put back unless something new was typed. */
  submit(): void
  onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void
  canSend: boolean
}

function useDraft(options: Pick<ChatComposerProps, 'ready' | 'running' | 'onSend'>): Draft {
  const [text, setText] = useState('')
  const canSend = options.ready && !options.running && text.trim() !== ''
  const submit = (): void => {
    if (!canSend) {
      return
    }
    setText('')
    void options.onSend(text).then((sent) => {
      if (!sent) setText((current) => (current === '' ? text : current))
    })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault()
      submit()
    }
  }
  return { text, setText, submit, onKeyDown, canSend }
}

/**
 * The message box. Enter sends, Shift+Enter adds a line. While a turn runs the input is disabled
 * and Stop replaces Send; a message that could not be sent is put back so nothing typed is lost.
 */
export function ChatComposer({ ready, signedOutOf, running, stopping, error, onSend, onStop }: ChatComposerProps): JSX.Element {
  const open = ready && signedOutOf === null
  const draft = useDraft({ ready: open, running, onSend })
  const input = useRefocusAfterTurn(running)
  return (
    <form
      className="chat-composer"
      onSubmit={(event) => {
        event.preventDefault()
        draft.submit()
      }}
    >
      {error === null ? null : (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      <div className="chat-composer-row">
        <textarea
          ref={input}
          className="input chat-input"
          aria-label="Message"
          rows={2}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder={running ? 'The agent is answering…' : 'Message the agent'}
          value={draft.text}
          disabled={!open || running}
          onChange={(event) => draft.setText(event.target.value)}
          onKeyDown={draft.onKeyDown}
        />
        {running ? (
          <Button variant="danger" busy={stopping} onClick={onStop}>
            Stop
          </Button>
        ) : (
          <Button variant="primary" type="submit" disabled={!draft.canSend}>
            Send
          </Button>
        )}
      </div>
      {signedOutOf === null ? (
        <p className="field-hint">Enter sends. Shift+Enter adds a line.</p>
      ) : (
        <p className="field-hint" role="status">
          {`Signed out of ${signedOutOf}. Sign in above to keep chatting.`}
        </p>
      )}
    </form>
  )
}
