import '../epic/tones.css'
import './ticket.css'
import { useCallback, useEffect, useState } from 'react'
import type { DraftOp } from '../../../shared/domain/api'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { Runner } from '../epic/runner'
import { StatePill } from '../epic/StatePill'
import type { Result } from '../epic/workspaceActions'
import type { TicketBadge } from '../graph/graphModel'
import { BasicFields, CapabilityFields, CriteriaFields, DetailFields, PrerequisiteFields } from './editorFields'
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
  bundle: PlanBundle
  ticketId: string
  badge: TicketBadge
  busy: boolean
  applyOps(ops: DraftOp[]): Promise<Result<unknown>>
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
  const { bundle, ticketId, applyOps, onRemoved } = props
  const [state, setState] = useState(() => initialEditor(bundle, ticketId))
  useEffect(() => setState((current) => syncEditor(current, bundle, ticketId)), [bundle, ticketId])
  const update = useCallback((form: TicketForm) => setState((current) => editForm(current, form)), [])
  const ops = state.form === null ? [] : formToOps(state.form, bundle, ticketId)
  const apply = async (): Promise<void> => {
    const invalid = state.form === null ? null : formErrors(state.form)
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
        <DetailFields form={form} update={editor.update} bundle={props.bundle} />
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
