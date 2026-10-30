import { useState } from 'react'
import type { FormEvent } from 'react'
import type { AgentView, CustomAgentUpdate } from '../../../shared/desktop/api'
import { Button } from '../components/Button'
import { Field } from '../components/Field'
import { ActivityNote } from './ActivityNote'
import { describeActivity } from './agentActivity'
import type { AgentOutcome } from './agentOutcomes'
import { editOutcome } from './agentOutcomes'
import { ArgumentRows, CUSTOM_NAME_MAX, cleanArgs } from './CustomAgentForm'
import type { CustomDraft } from './CustomAgentForm'
import type { AgentsModel } from './useAgents'

interface CustomAgentEditProps {
  agent: AgentView
  agents: AgentsModel
  /** Main saved the edit; the outcome says so on the page. */
  onSaved(outcome: AgentOutcome | null): void
  onCancel(): void
}

interface EditForm {
  draft: CustomDraft
  repick: boolean
  busy: boolean
  outcome: AgentOutcome | null
  setDraft(draft: CustomDraft): void
  setRepick(repick: boolean): void
  submit(event: FormEvent): Promise<void>
}

function useEditForm({ agent, agents, onSaved }: CustomAgentEditProps): EditForm {
  const [draft, setDraft] = useState<CustomDraft>({ name: agent.displayName, args: [...agent.args] })
  const [repick, setRepick] = useState(false)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<AgentOutcome | null>(null)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const name = draft.name.trim()
    if (name === '' || busy) return
    // The protocol never changes; the program changes only through main's file dialog, which repick opens.
    const update: CustomAgentUpdate = { id: agent.id, name, args: cleanArgs(draft.args), repick }
    setBusy(true)
    setOutcome(null)
    const result = await agents.updateCustom(update)
    setBusy(false)
    if (result?.outcome === 'connected') {
      onSaved(editOutcome(result.agent.displayName, result))
      return
    }
    setOutcome(result === null ? null : editOutcome(name, result))
  }
  // What main said was about what was sent; a change makes it stale.
  const change = (next: CustomDraft): void => {
    setDraft(next)
    setOutcome(null)
  }
  return { draft, repick, busy, outcome, setDraft: change, setRepick, submit }
}

/** Edits a custom CLI's name and arguments, or picks its program again; main checks, confirms and runs the handshake as when it was added. */
export function CustomAgentEdit(props: CustomAgentEditProps): JSX.Element {
  const form = useEditForm(props)
  const { draft, busy } = form
  return (
    <form className="card form custom-agent-form" aria-label={`Edit ${props.agent.displayName}`} onSubmit={(event) => void form.submit(event)}>
      <h2 className="card-title">Edit</h2>
      <Field label="Name" value={draft.name} maxLength={CUSTOM_NAME_MAX} onChange={(name) => form.setDraft({ ...draft, name })} />
      <ArgumentRows args={draft.args} disabled={busy} onChange={(args) => form.setDraft({ ...draft, args })} />
      <label className="connect-check">
        <input type="checkbox" checked={form.repick} disabled={busy} onChange={(event) => form.setRepick(event.target.checked)} />
        <span>Choose another executable</span>
        <span className="field-hint">A file dialog opens when you save.</span>
      </label>
      <ActivityNote name={props.agent.displayName} activity={describeActivity({ finding: busy && form.repick, download: null, outcome: form.outcome })} />
      <div className="button-row">
        <Button variant="primary" type="submit" busy={busy} disabled={draft.name.trim() === ''}>
          Save
        </Button>
        <Button disabled={busy} onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
