import { useId, useState } from 'react'
import type { FormEvent } from 'react'
import { TICKET_PRIORITIES } from '../../../shared/domain/bundle'
import type { TicketPriority } from '../../../shared/domain/bundle'
import type { KanbanCardView } from '../../../shared/domain/kanban'
import { errorMessage } from '../api/dm'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { Field } from '../components/Field'
import { MAX_TITLE } from '../home/newEpic'

export const PRIORITY_LABELS: Record<TicketPriority, string> = { low: 'Low', normal: 'Normal', high: 'High', critical: 'Critical' }

/** What the form sends: the same fields for a new card and an edit. */
export interface CardContent {
  title: string
  body: string
  acceptanceCriteria: string[]
  expectedArtifacts: string[]
  priority: TicketPriority
}

interface Draft {
  title: string
  body: string
  criteria: string
  artifacts: string
  priority: TicketPriority
}

const EMPTY_DRAFT: Draft = { title: '', body: '', criteria: '', artifacts: '', priority: 'normal' }

/** An existing card's content as the form edits it. */
function draftOf(card: KanbanCardView): Draft {
  return {
    title: card.title,
    body: card.body,
    criteria: card.acceptanceCriteria.map((criterion) => criterion.text).join('\n'),
    artifacts: card.expectedArtifacts.join('\n'),
    priority: card.priority
  }
}

const lines = (text: string): string[] => text.split('\n').map((line) => line.trim()).filter((line) => line !== '')

interface CardFormDialogProps {
  /** The card being edited; absent for a new card. */
  card?: KanbanCardView
  /** Sends the content; rejects with the server's refusal, which the form shows. */
  onSubmit(content: CardContent): Promise<void>
  onClose(): void
}

interface CardForm {
  draft: Draft
  problem: string | null
  busy: boolean
  edit<K extends keyof Draft>(field: K, value: Draft[K]): void
  submit(event: FormEvent): Promise<void>
}

function useCardForm({ card, onSubmit, onClose }: CardFormDialogProps): CardForm {
  const [draft, setDraft] = useState<Draft>(card === undefined ? EMPTY_DRAFT : draftOf(card))
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const edit = <K extends keyof Draft>(field: K, value: Draft[K]): void => {
    setDraft((previous) => ({ ...previous, [field]: value }))
    setProblem(null)
  }
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const title = draft.title.trim()
    if (title === '') {
      setProblem('Give the card a title.')
      return
    }
    setBusy(true)
    try {
      const { body, priority } = draft
      await onSubmit({ title, body, acceptanceCriteria: lines(draft.criteria), expectedArtifacts: lines(draft.artifacts), priority })
      onClose()
    } catch (error) {
      setProblem(errorMessage(error))
      setBusy(false)
    }
  }
  return { draft, problem, busy, edit, submit }
}

function CardFields({ form, formId }: { form: CardForm; formId: string }): JSX.Element {
  const priorityId = useId()
  const { draft, problem, edit } = form
  return (
    <form id={formId} className="form" onSubmit={(event) => void form.submit(event)}>
      <Field label="Title" value={draft.title} maxLength={MAX_TITLE} onChange={(value) => edit('title', value)} />
      <Field label="Body" value={draft.body} rows={5} hint="Markdown." onChange={(value) => edit('body', value)} />
      <Field label="Acceptance criteria" value={draft.criteria} rows={3} hint="One per line." onChange={(value) => edit('criteria', value)} />
      <Field label="Expected artifacts" value={draft.artifacts} rows={2} hint="One path per line." onChange={(value) => edit('artifacts', value)} />
      <div className="field">
        <label className="field-label" htmlFor={priorityId}>
          Priority
        </label>
        <select id={priorityId} className="input" value={draft.priority} onChange={(event) => edit('priority', event.target.value as TicketPriority)}>
          {TICKET_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>
              {PRIORITY_LABELS[priority]}
            </option>
          ))}
        </select>
      </div>
      {problem === null ? null : (
        <p className="form-error" role="alert">
          {problem}
        </p>
      )}
    </form>
  )
}

/** The New card and Edit form: title (required), Markdown body, acceptance criteria, expected artifacts and priority. */
export function CardFormDialog(props: CardFormDialogProps): JSX.Element {
  const formId = useId()
  const form = useCardForm(props)
  const { card, onClose } = props
  return (
    <Dialog
      title={card === undefined ? 'New card' : `Edit ${card.key}`}
      description={card === undefined ? 'A card is one isolated piece of work. It starts in Backlog.' : undefined}
      onClose={onClose}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form={formId} busy={form.busy}>
            {card === undefined ? 'Create card' : 'Save card'}
          </Button>
        </>
      }
    >
      <CardFields form={form} formId={formId} />
    </Dialog>
  )
}
