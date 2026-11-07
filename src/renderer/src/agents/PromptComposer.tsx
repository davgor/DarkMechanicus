import { useRef, useState, type FormEvent } from 'react'
import { Button } from '../components/Button'
import { unwrapChat } from './chatCalls'

interface PromptComposerProps {
  folder: string
  chatId: string
  disabled: boolean
}

/** An explicit prompt boundary, separate from CLI commands, passwords and other raw terminal input. */
export function PromptComposer({ folder, chatId, disabled }: PromptComposerProps): JSX.Element {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const sending = useRef(false)
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (disabled || sending.current || !text.trim()) return
    sending.current = true
    setBusy(true)
    setProblem(null)
    try {
      const result = await unwrapChat(window.dm.chats.submitPrompt({ folder, chatId, text }))
      if (result.problem !== null) {
        setProblem(result.problem)
      } else {
        setText('')
      }
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }
  return (
    <form className="terminal-prompt" aria-label="Send a prompt to the agent" onSubmit={(event) => void submit(event)}>
      <label htmlFor={`prompt-${chatId}`}>Prompt</label>
      <textarea id={`prompt-${chatId}`} value={text} onChange={(event) => setText(event.target.value)} disabled={disabled || busy} maxLength={65_536} rows={2} placeholder="Ask the agent a question…" />
      <Button type="submit" variant="primary" size="sm" busy={busy} disabled={disabled || !text.trim()}>Send prompt</Button>
      <small>The first prompt names a new chat. Direct terminal input does not.</small>
      {problem === null ? null : <p role="alert">{problem}</p>}
    </form>
  )
}
