import { useRef, useState } from 'react'
import type { AgentChatAnswer, PendingPrompt } from '../../../shared/agents/agentChat'
import { formatCallsign } from '../../../shared/agents/callsign'
import type { CommandResult } from '../../../shared/desktop/api'
import './pendingPrompt.css'

interface Props {
  prompt: PendingPrompt | null
  answer: (request: AgentChatAnswer) => Promise<CommandResult<null>>
}

type WithoutPromptId<T> = T extends unknown ? Omit<T, 'promptId'> : never
/** An answer without its prompt id: one option, a multi question's options, or every field of a form prompt. */
type Choice = WithoutPromptId<AgentChatAnswer>
type Option = { id: string; label: string; description?: string }
type QuestionPrompt = Extract<PendingPrompt, { kind: 'question' }>
type FormField = NonNullable<QuestionPrompt['form']>['fields'][number]
type FieldAnswer = Extract<AgentChatAnswer, { fields: unknown }>['fields'][number]

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
  async function submit(choice: Choice): Promise<void> {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setNotice(null)
    try {
      const result = await answer({ promptId: prompt.id, ...choice })
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

function Detail({ text }: { text: string }): JSX.Element | null {
  return text ? <p className="agent-prompt-detail">{clip(text, 600)}</p> : null
}

function Prompt({ prompt, answer }: { prompt: PendingPrompt; answer: Props['answer'] }): JSX.Element {
  const { busy, notice, closed, submit } = useAnswer(prompt, answer)
  if (closed) return <p className="agent-prompt-notice" role="status">{notice}</p>
  const card = { prompt, title: heading(prompt), busy, notice, submit }
  const form = prompt.kind === 'question' ? prompt.form : undefined
  return form ? <FormCard {...card} fields={form.fields} /> : <ChoiceCard {...card} />
}

/** What every prompt card shows besides its answer controls, and how it answers. */
interface CardProps {
  prompt: PendingPrompt
  title: string
  busy: boolean
  notice: string | null
  submit: (choice: Choice) => Promise<void>
}

/** An approval or a question without a form: a button per option, or DM-1034's multi-select card. */
function ChoiceCard({ prompt, title, busy, notice, submit }: CardProps): JSX.Element {
  const freeText = prompt.kind === 'question' ? prompt.options.find((option) => option.id === 'text') : undefined
  const choices = prompt.options.filter((option) => option !== freeText)
  const multi = prompt.kind === 'question' && prompt.multi === true
  return (
    <section className={multi ? 'agent-prompt agent-prompt-multi-card glass-strong' : 'agent-prompt glass'} role="alertdialog"
      aria-label={title} aria-busy={busy}>
      {!multi && <><Progress prompt={prompt} /><h3>{title}</h3></>}
      {prompt.tool && <p className="agent-prompt-tool">Tool: {clip(prompt.tool.name, 120)}</p>}
      {!multi && <Detail text={prompt.detail} />}
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
  submit: (choice: Choice) => Promise<void>
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
      {freeText && <form className="agent-prompt-answer" onSubmit={(event) => { event.preventDefault(); void submit({ optionId: freeText.id, text }) }}>
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
      if (optionIds.length > 0) void submit(withText ? { optionIds, text } : { optionIds })
    }}>
      <fieldset disabled={busy}>
        <legend>{title}</legend>
        <Detail text={prompt.detail} />
        <div className="agent-prompt-choices">
          {choices.map((option) => (
            <OptionRow key={option.id} type="checkbox" option={option} checked={checked.has(option.id)} onChange={(on) => toggle(option.id, on)} />
          ))}
          {freeText && <div className="agent-prompt-other">
            <label htmlFor={`prompt-answer-${prompt.id}`}>{clip(freeText.label, 120)}</label>
            <textarea className="input" id={`prompt-answer-${prompt.id}`} value={text} maxLength={20_000} rows={2}
              onChange={(event) => setText(event.target.value)} />
          </div>}
        </div>
        <div className="agent-prompt-submit">
          {/* A multi question's progress shares the Submit row, leaving the docked card's height to its options. */}
          <Progress prompt={prompt} />
          <span className="agent-prompt-count" aria-live="polite">{optionIds.length} selected</span>
          <button className="btn btn-primary btn-sm" type="submit" disabled={optionIds.length === 0}>Submit</button>
        </div>
      </fieldset>
    </form>
  )
}

/** One option as a compact row: its checkbox or radio, label and one-line description; the whole row toggles it. */
function OptionRow({ type, name, option, checked, onChange }: {
  type: 'checkbox' | 'radio'; name?: string; option: Option; checked: boolean; onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className="agent-prompt-check">
      <input type={type} name={name} checked={checked} onChange={(event) => onChange(event.target.checked)} />
      <span className="agent-prompt-check-text">
        <span className="agent-prompt-check-label">{clip(option.label, 120)}</span>
        {option.description && <span className="agent-prompt-check-description">{clip(option.description, 300)}</span>}
      </span>
    </label>
  )
}

/** One form field's input: its checked options, whether a single choice picked Other, and its free text. */
interface FieldDraft { chosen: ReadonlySet<string>; other: boolean; text: string }

/** The agent's defaults: `preselected` options checked (a single choice's first), the text at `defaultText`. */
function initialDraft(field: FormField): FieldDraft {
  const preselected = field.options.filter((option) => option.preselected).map((option) => option.id)
  return { chosen: new Set(field.multi ? preselected : preselected.slice(0, 1)), other: false, text: field.defaultText ?? '' }
}

/**
 * A field's answer, or null while it has none. A text field always answers, sending `text` only once it differs from
 * the default so an untouched one keeps the agent's.
 */
function fieldAnswer(field: FormField, draft: FieldDraft): FieldAnswer | null {
  if (field.text !== 'only') return choiceAnswer(field, draft)
  return draft.text === (field.defaultText ?? '') ? { fieldId: field.id, optionIds: [] } : { fieldId: field.id, optionIds: [], text: draft.text }
}

/**
 * A choice field's answer, or null while it has none: options in option order, nonblank Other text as one more pick
 * (a single choice's only when Other is chosen); a single choice takes exactly one pick, a multi one at least one.
 */
function choiceAnswer(field: FormField, draft: FieldDraft): FieldAnswer | null {
  const written = field.text === 'other' && draft.text.trim() !== '' && (field.multi || draft.other)
  const optionIds = field.options.filter((option) => !draft.other && draft.chosen.has(option.id)).map((option) => option.id)
  const picks = optionIds.length + (written ? 1 : 0)
  if (field.multi ? picks === 0 : picks !== 1) return null
  return written ? { fieldId: field.id, optionIds, text: draft.text } : { fieldId: field.id, optionIds }
}

type FormProps = CardProps & { fields: FormField[] }

/** A form prompt's card: its heading, tool, detail, arbitration and error above the one form. */
function FormCard({ prompt, fields, title, busy, notice, submit }: FormProps): JSX.Element {
  return (
    <section className="agent-prompt agent-prompt-form-card glass-strong" role="alertdialog" aria-label={title} aria-busy={busy}>
      {/* A one-question form's legend already asks it; the heading would only repeat it. */}
      {(fields.length > 1 || fields[0].title !== prompt.title) && <h3>{title}</h3>}
      {prompt.tool && <p className="agent-prompt-tool">Tool: {clip(prompt.tool.name, 120)}</p>}
      <Detail text={prompt.detail} />
      <Arbitration prompt={prompt} />
      {notice && <p className="agent-prompt-error" role="alert">{notice}</p>}
      <FormChoice prompt={prompt} fields={fields} busy={busy} submit={submit} />
    </section>
  )
}

/**
 * Every question of one ask at once, each a fieldset with its question as legend, and one Submit sending every field.
 * Submit waits until each field has an answer (a default counts). The drafts live here, so they survive a failed
 * answer and reset only with the next prompt id.
 */
function FormChoice({ prompt, fields, busy, submit }: Omit<FormProps, 'title' | 'notice'>): JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, FieldDraft>>(() => Object.fromEntries(fields.map((field) => [field.id, initialDraft(field)])))
  const answers = fields.map((field) => fieldAnswer(field, drafts[field.id]))
  const answered = answers.filter((entry) => entry !== null)
  const complete = answered.length === answers.length
  function update(fieldId: string, change: (draft: FieldDraft) => Partial<FieldDraft>): void {
    setDrafts((current) => ({ ...current, [fieldId]: { ...current[fieldId], ...change(current[fieldId]) } }))
  }
  return (
    <form className="agent-prompt-form" onSubmit={(event) => {
      event.preventDefault()
      if (complete) void submit({ fields: answered })
    }}>
      <div className="agent-prompt-fields">
        {fields.map((field) => (
          <FormFieldset key={field.id} name={`prompt-${prompt.id}-${field.id}`} field={field} draft={drafts[field.id]} busy={busy}
            update={(change) => update(field.id, change)} />
        ))}
      </div>
      <div className="agent-prompt-submit">
        <span className="agent-prompt-count" aria-live="polite">{answered.length} of {answers.length} answered</span>
        <button className="btn btn-primary btn-sm" type="submit" disabled={busy || !complete}>Submit</button>
      </div>
    </form>
  )
}

/** A checkbox draft with `optionId` checked or not. */
function toggled(draft: FieldDraft, optionId: string, on: boolean): Partial<FieldDraft> {
  const chosen = new Set(draft.chosen)
  if (on) chosen.add(optionId)
  else chosen.delete(optionId)
  return { chosen }
}

/**
 * One question: a text box for a text field, else its options as checkboxes (multi) or radios (single, with an Other
 * radio where it takes free text), and the Other box; typing a single choice's Other answer picks Other.
 */
function FormFieldset({ name, field, draft, busy, update }: {
  name: string; field: FormField; draft: FieldDraft; busy: boolean; update: (change: (draft: FieldDraft) => Partial<FieldDraft>) => void
}): JSX.Element {
  return (
    <fieldset className="agent-prompt-field" disabled={busy}>
      <legend>{clip(field.title, 300)}</legend>
      {field.text === 'only'
        ? <textarea className="input" aria-label={clip(field.title, 300)} value={draft.text} maxLength={20_000} rows={1}
          onChange={(event) => update(() => ({ text: event.target.value }))} />
        : <div className="agent-prompt-choices">
          {field.options.map((option) => field.multi
            ? <OptionRow key={option.id} type="checkbox" option={option} checked={draft.chosen.has(option.id)}
              onChange={(on) => update((current) => toggled(current, option.id, on))} />
            : <OptionRow key={option.id} type="radio" name={name} option={option} checked={!draft.other && draft.chosen.has(option.id)}
              onChange={() => update(() => ({ chosen: new Set([option.id]), other: false }))} />)}
          {field.text === 'other' && !field.multi &&
            <OptionRow type="radio" name={name} option={{ id: 'other', label: 'Other' }} checked={draft.other}
              onChange={() => update(() => ({ chosen: new Set(), other: true }))} />}
          {field.text === 'other' && <div className="agent-prompt-other">
            <label htmlFor={`${name}-other`}>{field.multi ? 'Other' : 'Other answer'}</label>
            <textarea className="input" id={`${name}-other`} value={draft.text} maxLength={20_000} rows={1}
              onChange={(event) => update(() => field.multi ? { text: event.target.value } : { text: event.target.value, chosen: new Set(), other: true })} />
          </div>}
        </div>}
    </fieldset>
  )
}
