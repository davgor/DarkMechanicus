import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import type { CustomAgentRequest } from '../../../shared/desktop/api'
import { Button } from '../components/Button'
import { Field } from '../components/Field'
import { ActivityNote } from './ActivityNote'
import { describeActivity } from './agentActivity'
import type { AgentOutcome } from './agentOutcomes'
import { findOutcome } from './agentOutcomes'
import type { AgentsModel } from './useAgents'

/** What main matches a name against, at most (it trims and checks the rest). */
export const CUSTOM_NAME_MAX = 64

/** The arguments as they are sent: each trimmed, and the rows left empty dropped. */
export function cleanArgs(args: readonly string[]): string[] {
  return args.map((arg) => arg.trim()).filter((arg) => arg !== '')
}

/** What a custom CLI's name and arguments are being set to, as typed. */
export interface CustomDraft {
  name: string
  args: string[]
}

interface ArgumentRowsProps {
  args: readonly string[]
  disabled?: boolean
  onChange(args: string[]): void
}

/** The arguments, one per row, each removable, with a row added at the end; `{folder}` as a whole argument is the chat's folder. */
export function ArgumentRows({ args, disabled = false, onChange }: ArgumentRowsProps): JSX.Element {
  const hintId = useId()
  return (
    <fieldset className="chat-field custom-args" aria-describedby={hintId}>
      <legend className="field-label">Arguments</legend>
      {args.length === 0 ? <p className="field-hint">No arguments.</p> : null}
      {args.map((arg, index) => (
        <div key={index} className="custom-arg-row">
          <input
            className="input mono"
            aria-label={`Argument ${index + 1}`}
            value={arg}
            disabled={disabled}
            onChange={(event) => onChange(args.map((other, at) => (at === index ? event.target.value : other)))}
          />
          <Button icon="close" size="sm" variant="ghost" aria-label={`Remove argument ${index + 1}`} disabled={disabled} onClick={() => onChange(args.filter((_, at) => at !== index))} />
        </div>
      ))}
      <Button icon="plus" size="sm" disabled={disabled} onClick={() => onChange([...args, ''])}>
        Add argument
      </Button>
      <p id={hintId} className="field-hint">
        An argument <code>{'{folder}'}</code> becomes the chat’s folder.
      </p>
    </fieldset>
  )
}

interface AddForm {
  draft: CustomDraft
  busy: boolean
  outcome: AgentOutcome | null
  setDraft(draft: CustomDraft): void
  submit(event: FormEvent): Promise<void>
}

const EMPTY_DRAFT: CustomDraft = { name: '', args: [] }

function useAddForm(agents: AgentsModel): AddForm {
  const [draft, setDraft] = useState<CustomDraft>(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<AgentOutcome | null>(null)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const name = draft.name.trim()
    if (name === '' || busy) return
    // Exactly the name and arguments: the program is picked in main's file dialog.
    const request: CustomAgentRequest = { name, args: cleanArgs(draft.args) }
    setBusy(true)
    setOutcome(null)
    const result = await agents.addCustom(request)
    setBusy(false)
    setOutcome(result === null ? null : findOutcome(result.outcome === 'connected' ? result.agent.displayName : name, result))
    if (result?.outcome === 'connected') {
      setDraft(EMPTY_DRAFT)
    }
  }
  // What main said was about what was sent; a change makes it stale.
  const change = (next: CustomDraft): void => {
    setDraft(next)
    setOutcome(null)
  }
  return { draft, busy, outcome, setDraft: change, submit }
}

interface CustomAgentFormProps {
  agents: AgentsModel
  onClose(): void
}

/**
 * Adds a custom CLI: its name and its arguments. Choose executable sends exactly those two; main opens its file
 * dialog and shows the command in a native confirmation, and its refusal is shown here. There is no protocol:
 * the CLI runs as it is in a chat's terminal.
 */
export function CustomAgentForm({ agents, onClose }: CustomAgentFormProps): JSX.Element {
  const form = useAddForm(agents)
  const { draft, busy } = form
  return (
    <form className="form custom-agent-form" aria-label="Custom CLI" onSubmit={(event) => void form.submit(event)}>
      <Field label="Name" value={draft.name} maxLength={CUSTOM_NAME_MAX} onChange={(name) => form.setDraft({ ...draft, name })} />
      <ArgumentRows args={draft.args} disabled={busy} onChange={(args) => form.setDraft({ ...draft, args })} />
      <ActivityNote name={draft.name.trim() || 'Custom CLI'} activity={describeActivity({ finding: busy, download: null, outcome: form.outcome })} />
      <div className="button-row">
        <Button variant="primary" type="submit" icon="search" busy={busy} disabled={draft.name.trim() === ''}>
          Choose executable…
        </Button>
        <Button disabled={busy} onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
