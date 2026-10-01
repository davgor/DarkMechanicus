import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import type { CreateEpicInput } from '../../../shared/domain/api'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { Field } from '../components/Field'
import { MAX_TITLE, buildNewEpic } from './newEpic'

interface NewEpicDialogProps {
  /** Resolves true once the epic exists (the dialog then closes), false if it could not be created. */
  onSubmit(input: CreateEpicInput): Promise<boolean>
  onClose(): void
}

interface Draft {
  title: string
  intent: string
  criteria: string
}

interface NewEpicForm {
  draft: Draft
  problem: string | null
  busy: boolean
  edit(field: keyof Draft, value: string): void
  submit(event: FormEvent): Promise<void>
}

function useNewEpicForm({ onSubmit, onClose }: NewEpicDialogProps): NewEpicForm {
  const [draft, setDraft] = useState<Draft>({ title: '', intent: '', criteria: '' })
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const edit = (field: keyof Draft, value: string): void => {
    setDraft((previous) => ({ ...previous, [field]: value }))
    setProblem(null)
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const built = buildNewEpic(draft)
    if (!built.ok) {
      setProblem(built.message)
      return
    }
    setBusy(true)
    const created = await onSubmit(built.input)
    setBusy(false)
    if (created) onClose()
  }
  return { draft, problem, busy, edit, submit }
}

function EpicForm({ form, formId }: { form: NewEpicForm; formId: string }): JSX.Element {
  const { draft, problem, edit } = form
  return (
    <form id={formId} className="form" onSubmit={(event) => void form.submit(event)}>
      <Field label="Title" value={draft.title} maxLength={MAX_TITLE} onChange={(value) => edit('title', value)} />
      <Field label="Intent" value={draft.intent} rows={3} onChange={(value) => edit('intent', value)} />
      <Field
        label="Success criteria"
        value={draft.criteria}
        rows={4}
        hint="One per line. Agents check finished work against these."
        onChange={(value) => edit('criteria', value)}
      />
      {problem === null ? null : (
        <p className="form-error" role="alert">
          {problem}
        </p>
      )}
    </form>
  )
}

/** Title, intent and success criteria for a new epic; the epic opens once it is created. */
export function NewEpicDialog(props: NewEpicDialogProps): JSX.Element {
  const formId = useId()
  const form = useNewEpicForm(props)
  return (
    <Dialog
      title="New epic"
      description="An epic is a goal with a plan of sprints and tickets. It starts as a draft in the backlog."
      onClose={props.onClose}
      actions={
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} busy={form.busy}>
            {form.busy ? 'Creating…' : 'Create epic'}
          </Button>
        </>
      }
    >
      <EpicForm form={form} formId={formId} />
    </Dialog>
  )
}
