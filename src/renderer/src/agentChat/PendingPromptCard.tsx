import { useRef, useState } from 'react'
import type { AgentChatAnswer, PendingPrompt } from '../../../shared/agents/agentChat'
import { formatCallsign } from '../../../shared/agents/callsign'
import type { CommandResult } from '../../../shared/desktop/api'
import './pendingPrompt.css'

interface Props {
  prompt: PendingPrompt | null
  answer: (request: AgentChatAnswer) => Promise<CommandResult<null>>
}

type Choice = { optionId: string } | { optionIds: string[] }
type Option = { id: string; label: string; description?: string }

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
  async function submit(choice: Choice, text?: string): Promise<void> {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setNotice(null)
    try {
      const result = await answer({ promptId: prompt.id, ...choice, ...(text === undefined ? {} : { text }) })
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

/** `Question i of n` when the CLI asks several questions in sequence; nothing otherwise. */
function Progress({ prompt }: { prompt: PendingPrompt }): JSX.Element | null {
  const progress = prompt.kind === 'question' ? prompt.progress : undefined
  return progress ? <p className="agent-prompt-progress">Question {progress.index} of {progress.total}</p> : null
}

function Prompt({ prompt, answer }: { prompt: PendingPrompt; answer: Props['answer'] }): JSX.Element {
  const { busy, notice, closed, submit } = useAnswer(prompt, answer)
  if (closed) return <p className="agent-prompt-notice" role="status">{notice}</p>
  const title = heading(prompt)
  const freeText = prompt.kind === 'question' ? prompt.options.find((option) => option.id === 'text') : undefined
  const choices = prompt.options.filter((option) => option !== freeText)
  const multi = prompt.kind === 'question' && prompt.multi === true
  return (
    <section className={`agent-prompt ${multi ? 'glass-strong' : 'glass'}`} role="alertdialog" aria-label={title} aria-busy={busy}>
      <Progress prompt={prompt} />
      {!multi && <h3>{title}</h3>}
      {prompt.tool && <p className="agent-prompt-tool">Tool: {clip(prompt.tool.name, 120)}</p>}
      {prompt.detail && <p className="agent-prompt-detail">{clip(prompt.detail, 600)}</p>}
      <Arbitration prompt={prompt} />
      {notice && <p className="agent-prompt-error" role="alert">{notice}</p>}
      {multi
        ? <MultiChoice prompt={prompt} title={title} choices={choices} freeText={freeText} busy={busy} submit={submit} />
        : <SingleChoice prompt={prompt} choices={choices} freeText={freeText} busy={busy} submit={submit} />}
    </section>
  )
}

interface ChoiceProps {
  prompt: PendingPrompt
  choices: Option[]
  freeText: Option | undefined
  busy: boolean
  submit: (choice: Choice, text?: string) => Promise<void>
}

/** One click answers: a button per option, and the free-text form when offered. */
function SingleChoice({ prompt, choices, freeText, busy, submit }: ChoiceProps): JSX.Element {
  const [text, setText] = useState('')
  return (
    <>
      <div className="agent-prompt-options">
        {choices.map((option) => (
          <button className="btn" key={option.id} type="button" disabled={busy}
            onClick={() => { void submit({ optionId: option.id }) }}>{clip(option.label, 120)}</button>
        ))}
      </div>
      {freeText && <form className="agent-prompt-answer" onSubmit={(event) => { event.preventDefault(); void submit({ optionId: freeText.id }, text) }}>
        <label htmlFor={`prompt-answer-${prompt.id}`}>{clip(freeText.label, 120)}</label>
        <textarea className="input" id={`prompt-answer-${prompt.id}`} value={text} maxLength={20_000} rows={2}
          disabled={busy} onChange={(event) => setText(event.target.value)} />
        <button className="btn" type="submit" disabled={busy}>Submit answer</button>
      </form>}
    </>
  )
}

/**
 * A checkbox per option and one Submit. Nonblank "Other" text counts as a choice: `text` joins the ids in option
 * order. The selection lives here, so it survives a failed answer and resets with the next prompt id.
 */
function MultiChoice({ prompt, title, choices, freeText, busy, submit }: ChoiceProps & { title: string }): JSX.Element {
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [text, setText] = useState('')
  const withText = freeText !== undefined && text.trim() !== ''
  const optionIds = prompt.options.filter((option) => option === freeText ? withText : checked.has(option.id)).map((option) => option.id)
  function toggle(id: string, on: boolean): void {
    setChecked((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })
  }
  return (
    <form className="agent-prompt-multi" onSubmit={(event) => {
      event.preventDefault()
      if (optionIds.length > 0) void submit({ optionIds }, withText ? text : undefined)
    }}>
      <fieldset disabled={busy}>
        <legend>{title}</legend>
        {choices.map((option) => (
          <label className="agent-prompt-check" key={option.id}>
            <input type="checkbox" checked={checked.has(option.id)} onChange={(event) => toggle(option.id, event.target.checked)} />
            <span className="agent-prompt-check-text">
              <span className="agent-prompt-check-label">{clip(option.label, 120)}</span>
              {option.description && <span className="agent-prompt-check-description">{clip(option.description, 300)}</span>}
            </span>
          </label>
        ))}
        {freeText && <div className="agent-prompt-other">
          <label htmlFor={`prompt-answer-${prompt.id}`}>{clip(freeText.label, 120)}</label>
          <textarea className="input" id={`prompt-answer-${prompt.id}`} value={text} maxLength={20_000} rows={2}
            onChange={(event) => setText(event.target.value)} />
        </div>}
        <div className="agent-prompt-submit">
          <span className="agent-prompt-count" aria-live="polite">{optionIds.length} selected</span>
          <button className="btn btn-primary" type="submit" disabled={optionIds.length === 0}>Submit</button>
        </div>
      </fieldset>
    </form>
  )
}
