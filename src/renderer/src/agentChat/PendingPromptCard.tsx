import { useRef, useState } from 'react'
import type { PendingPrompt } from '../../../shared/agents/agentChat'
import { formatCallsign } from '../../../shared/agents/callsign'
import type { CommandResult } from '../../../shared/desktop/api'
import './pendingPrompt.css'

interface Props {
  prompt: PendingPrompt | null
  answer: (promptId: string, optionId: string, text?: string) => Promise<CommandResult<null>>
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`
}

function heading(prompt: PendingPrompt): string {
  if (prompt.kind === 'question') return clip(prompt.title, 300)
  const name = prompt.callsign ? formatCallsign(prompt.callsign) : 'agent'
  const requester = name === 'Magos' || name === 'agent' ? `The ${name}` : name
  const command = prompt.tool?.input.command
  const action = typeof command === 'string' ? command : prompt.tool?.name || prompt.title
  return `${requester} wants to run: ${clip(action, 160)}`
}

/** A new prompt owns new draft/flight state; a late old reply cannot touch its replacement. */
export function PendingPromptCard({ prompt, answer }: Props): JSX.Element | null {
  return prompt ? <Prompt key={prompt.id} prompt={prompt} answer={answer} /> : null
}

function useAnswer(prompt: PendingPrompt, answer: Props['answer']) {
  const locked = useRef(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [closed, setClosed] = useState(false)
  async function submit(optionId: string, text?: string): Promise<void> {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setNotice(null)
    try {
      const result = await answer(prompt.id, optionId, text)
      if (result.ok || result.error.code === 'stale_prompt') {
        setClosed(true)
        setNotice(result.ok ? 'Answer sent.' : 'This prompt is no longer available.')
        return
      }
      setNotice(clip(result.error.message, 300))
    } catch {
      setNotice('The answer could not be sent. Please try again.')
    }
    locked.current = false
    setBusy(false)
  }
  return { busy, notice, closed, submit }
}

function Arbitration({ prompt }: { prompt: PendingPrompt }): JSX.Element | null {
  if (prompt.arbitration.state === 'deciding') return (
    <p className="agent-prompt-arbitration" role="status"><span className="agent-prompt-spinner" aria-hidden="true" />The Magos is deciding…</p>
  )
  return prompt.arbitration.state === 'escalated'
    ? <p className="agent-prompt-arbitration">The Magos asks you: {clip(prompt.arbitration.reason ?? '', 300)}</p>
    : null
}

function Prompt({ prompt, answer }: { prompt: PendingPrompt; answer: Props['answer'] }): JSX.Element {
  const { busy, notice, closed, submit } = useAnswer(prompt, answer)
  const [text, setText] = useState('')
  if (closed) return <p className="agent-prompt-notice" role="status">{notice}</p>
  const title = heading(prompt)
  const freeText = prompt.kind === 'question' ? prompt.options.find((option) => option.id === 'text') : undefined
  return (
    <section className="agent-prompt" role="alertdialog" aria-label={title} aria-busy={busy}>
      <h3>{title}</h3>
      {prompt.tool && <p className="agent-prompt-tool">Tool: {clip(prompt.tool.name, 120)}</p>}
      {prompt.detail && <p className="agent-prompt-detail">{clip(prompt.detail, 600)}</p>}
      <Arbitration prompt={prompt} />
      {notice && <p className="agent-prompt-error" role="alert">{notice}</p>}
      <div className="agent-prompt-options">
        {prompt.options.filter((option) => option !== freeText).map((option) => (
          <button className="btn" key={option.id} type="button" disabled={busy}
            onClick={() => { void submit(option.id) }}>{clip(option.label, 120)}</button>
        ))}
      </div>
      {freeText && <form className="agent-prompt-answer" onSubmit={(event) => { event.preventDefault(); void submit(freeText.id, text) }}>
        <label htmlFor={`prompt-answer-${prompt.id}`}>{clip(freeText.label, 120)}</label>
        <textarea className="input" id={`prompt-answer-${prompt.id}`} value={text} maxLength={20_000} rows={2}
          disabled={busy} onChange={(event) => setText(event.target.value)} />
        <button className="btn" type="submit" disabled={busy}>Submit answer</button>
      </form>}
    </section>
  )
}
