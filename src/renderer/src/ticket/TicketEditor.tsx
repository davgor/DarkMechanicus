import '../epic/tones.css'
import './ticket.css'
import { useCallback, useEffect, useState } from 'react'
import type { DraftOp } from '../../../shared/domain/api'
import type { PlanBundle, TicketBudget } from '../../../shared/domain/bundle'
import type { SetTicketBudgetResultView } from '../../../shared/domain/scoreReads'
import type { RepositoryView } from '../../../shared/domain/views'
import type { Runner } from '../epic/runner'
import { useViewMemory } from '../epic/viewMemory'
import { StatePill } from '../epic/StatePill'
import type { Result } from '../epic/workspaceActions'
import type { TicketBadge } from '../graph/graphModel'
import { BudgetFields } from './BudgetFields'
import { BasicFields, CapabilityFields, CriteriaFields, DetailFields, ImageFields, PrerequisiteFields } from './editorFields'
import { ProfileBar } from './ProfileBar'
import {
  applyOutcome,
  editForm,
  formErrors,
  formToOps,
  initialEditor,
  rejectForm,
  syncEditor,
  type EditorState,
  type TicketForm
} from './ticketForm'

interface TicketEditorProps {
  /** Reads and saves named capability profiles for this folder. */
  runner: Runner
  /** The folder's attachment key: the host of each image address. */
  folderKey: string
  /** Cache scope for unapplied edits across workspace visits. */
  workspaceIdentity?: string
  bundle: PlanBundle
  /** The folder's repositories, or null for a single repository (or while they load). */
  repositories: RepositoryView[] | null
  ticketId: string
  badge: TicketBadge
  busy: boolean
  /** The epic, its run (null before any run) and the draft revision shown: where the budget is set and read. */
  epicId: string
  runId: string | null
  /** The run has ended: its dispatches are history, and the next dispatch is in a later run. */
  runEnded: boolean
  draftRevision: number | null
  applyOps(ops: DraftOp[]): Promise<Result<unknown>>
  /** Sets or clears the ticket's budget in the draft against the draft revision shown (`setTicketBudget`). */
  setBudget(budget: TicketBudget | null): Promise<Result<SetTicketBudgetResultView>>
  onClose(): void
  onRemoved(): void
}

interface Editor {
  state: EditorState
  ops: DraftOp[]
  update(form: TicketForm): void
  apply(): Promise<void>
  remove(): Promise<void>
  revert(): void
}

function useEditor(props: TicketEditorProps): Editor {
  const { bundle, ticketId, applyOps, onRemoved, workspaceIdentity, epicId } = props
  const memory = useViewMemory()
  const [state, setState] = useState(() => (
    workspaceIdentity === undefined ? undefined : memory.editor(workspaceIdentity, epicId, ticketId)
  ) ?? initialEditor(bundle, ticketId))
  useEffect(() => {
    if (workspaceIdentity !== undefined) memory.saveEditor(workspaceIdentity, epicId, ticketId, state)
  }, [memory, workspaceIdentity, epicId, ticketId, state])
  useEffect(() => setState((current) => syncEditor(current, bundle, ticketId)), [bundle, ticketId])
  const update = useCallback((form: TicketForm) => setState((current) => editForm(current, form)), [])
  const ops = state.form === null ? [] : formToOps(state.form, bundle, ticketId)
  const apply = async (): Promise<void> => {
    const invalid = state.form === null ? null : formErrors(state.form, props.repositories)
    if (invalid !== null) {
      setState((current) => rejectForm(current, invalid))
      return
    }
    const result = await applyOps(ops)
    const outcome = result.ok ? { ok: true as const } : { ok: false as const, ...result.failure }
    setState((current) => applyOutcome(current, outcome))
  }
  const remove = async (): Promise<void> => {
    const result = await applyOps([{ op: 'remove_ticket', ticket: ticketId }])
    if (result.ok) {
      onRemoved()
      return
    }
    setState((current) => rejectForm(current, result.failure.message))
  }
  const revert = (): void => setState(initialEditor(bundle, ticketId))
  return { state, ops, update, apply, remove, revert }
}

function RemoveTicket(props: { busy: boolean; onRemove(): void }): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  if (!confirming) {
    return (
      <button type="button" className="btn btn-ghost tp-danger-link" onClick={() => setConfirming(true)}>
        Remove ticket…
      </button>
    )
  }
  return (
    <div className="tp-remove" role="alertdialog" aria-label="Remove ticket">
      <span>Remove this ticket and its dependencies from the draft?</span>
      <button type="button" className="btn btn-danger" disabled={props.busy} onClick={props.onRemove}>
        Remove ticket
      </button>
      <button type="button" className="btn btn-ghost" onClick={() => setConfirming(false)}>
        Keep
      </button>
    </div>
  )
}

function EditorFooter({ editor, busy }: { editor: Editor; busy: boolean }): JSX.Element {
  const message = editor.state.message
  const pending = editor.ops.length > 0
  return (
    <div className="tp-footer">
      {message === null ? null : (
        <p className={`tp-message is-${message.tone}`} role={message.tone === 'error' ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
      <div className="tp-row-actions">
        <span className="ew-muted">{pending ? 'Unapplied edits' : 'No unapplied edits'}</span>
        <button type="button" className="btn btn-ghost" disabled={!editor.state.touched} onClick={editor.revert}>
          Revert
        </button>
        <button type="button" className="btn btn-primary" disabled={busy || !pending} onClick={() => void editor.apply()}>
          Apply
        </button>
      </div>
    </div>
  )
}

function EditorHead(props: { ticketKey: string; badge: TicketBadge; onClose(): void }): JSX.Element {
  return (
    <div className="tp-head">
      <div className="tp-head-row">
        <span className="ew-mono tp-key">{props.ticketKey}</span>
        <StatePill tone={props.badge.tone} label={props.badge.label} />
        <span className="tp-head-actions">
          <button type="button" className="ew-icon-btn" aria-label="Close ticket" onClick={props.onClose}>
            ×
          </button>
        </span>
      </div>
      <p className="tp-meta">Edits stay in this panel until you apply them to the draft.</p>
    </div>
  )
}

/** Draft-view ticket editor: all fields, applied together as one draft update. */
export function TicketEditor(props: TicketEditorProps): JSX.Element {
  const editor = useEditor(props)
  const form = editor.state.form
  const ticketKey = props.bundle.tickets.find((item) => item.id === props.ticketId)?.key ?? props.ticketId
  if (form === null) {
    return (
      <aside className="tp" aria-label={`Edit ticket ${ticketKey}`}>
        <EditorHead ticketKey={ticketKey} badge={props.badge} onClose={props.onClose} />
        <p className="ew-muted tp-body">This ticket is no longer in the draft.</p>
      </aside>
    )
  }
  return (
    <aside className="tp tp-editor" aria-label={`Edit ticket ${ticketKey}`}>
      <EditorHead ticketKey={ticketKey} badge={props.badge} onClose={props.onClose} />
      <div className="tp-body tp-form">
        <BasicFields form={form} update={editor.update} />
        <CriteriaFields form={form} update={editor.update} />
        <ImageFields form={form} update={editor.update} runner={props.runner} folderKey={props.folderKey} />
        <DetailFields form={form} update={editor.update} bundle={props.bundle} repositories={props.repositories} />
        <BudgetFields
          runner={props.runner}
          epicId={props.epicId}
          ticketId={props.ticketId}
          runId={props.runId}
          runEnded={props.runEnded}
          draftBudget={props.bundle.tickets.find((item) => item.id === props.ticketId)?.budget}
          draftRevision={props.draftRevision}
          busy={props.busy}
          setBudget={props.setBudget}
        />
        <PrerequisiteFields form={form} update={editor.update} bundle={props.bundle} ticketId={props.ticketId} />
        <CapabilityFields form={form} update={editor.update}>
          <ProfileBar runner={props.runner} form={form} update={editor.update} />
        </CapabilityFields>
        <RemoveTicket busy={props.busy} onRemove={() => void editor.remove()} />
      </div>
      <EditorFooter editor={editor} busy={props.busy} />
    </aside>
  )
}
