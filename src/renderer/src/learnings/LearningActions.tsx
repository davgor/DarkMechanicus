import { useState } from 'react'
import { LEARNING_EVENTS, type LearningReplacementContent, type LearningView } from '../../../shared/domain/learnings'
import { CommandError, errorMessage, runCommand } from '../api/dm'
import { Button } from '../components/Button'
import { Field } from '../components/Field'

const ROLES = ['orchestrator', 'worker'] as const
type Role = (typeof ROLES)[number]
type LearningEvent = (typeof LEARNING_EVENTS)[number]

interface ActionsProps {
  folder: string
  learning: LearningView
  /** The change landed: reload the list and detail, opening `openId` when the change created a new learning. */
  onChanged(openId: string | null): void
  /** Reads the learning again after a stale revision; the draft is kept. */
  onReload(): void
}

/** What a failed change shows: the stale-revision notice (the draft stays) or the command's own message. */
type Failure = { kind: 'stale' } | { kind: 'error'; message: string }

interface Draft {
  title: string
  rule: string
  check: string
  roles: Role[]
  events: LearningEvent[]
  paths: string
}

function draftOf(learning: LearningView): Draft {
  const { title, rule, check, applicability } = learning
  return { title, rule, check, roles: [...applicability.roles], events: [...applicability.events], paths: applicability.paths.join('\n') }
}

function replacementOf(draft: Draft): LearningReplacementContent {
  const paths = draft.paths.split('\n').map((path) => path.trim()).filter((path) => path !== '')
  return { title: draft.title.trim(), rule: draft.rule.trim(), check: draft.check.trim(), applicability: { roles: draft.roles, events: draft.events, paths } }
}

function FailureNotice({ failure, onReload }: { failure: Failure; onReload(): void }): JSX.Element {
  if (failure.kind === 'error') {
    return <p className="inline-warning" role="alert">{failure.message}</p>
  }
  return (
    <div className="inline-warning learnings-stale" role="alert">
      <span>This learning changed since you opened it, so nothing was saved. Your draft is kept: reload to see the current revision, then try again.</span>
      <Button size="sm" icon="refresh" onClick={onReload}>Reload learning</Button>
    </div>
  )
}

function Checks<T extends string>({ legend, options, chosen, onChange }: { legend: string; options: readonly T[]; chosen: readonly T[]; onChange(next: T[]): void }): JSX.Element {
  return (
    <fieldset className="learnings-checks">
      <legend className="field-label">{legend}</legend>
      {options.map((option) => (
        <label key={option} className="learnings-check">
          <input
            type="checkbox"
            checked={chosen.includes(option)}
            onChange={(event) => onChange([...chosen.filter((entry) => entry !== option), ...(event.target.checked ? [option] : [])])}
          />
          <span className="mono">{option}</span>
        </label>
      ))}
    </fieldset>
  )
}

function ReplacementFields({ draft, onChange }: { draft: Draft; onChange(next: Draft): void }): JSX.Element {
  return (
    <>
      <Field label="New title" value={draft.title} onChange={(title) => onChange({ ...draft, title })} />
      <Field label="New rule" rows={3} value={draft.rule} onChange={(rule) => onChange({ ...draft, rule })} />
      <Field label="New check" rows={2} value={draft.check} onChange={(check) => onChange({ ...draft, check })} />
      <Checks legend="Roles" options={ROLES} chosen={draft.roles} onChange={(roles) => onChange({ ...draft, roles })} />
      <Checks legend="Events (none: any event)" options={LEARNING_EVENTS} chosen={draft.events} onChange={(events) => onChange({ ...draft, events })} />
      <Field label="Paths (one per line; none: any path)" rows={2} value={draft.paths} onChange={(paths) => onChange({ ...draft, paths })} />
    </>
  )
}

type Mode = 'retire' | 'replace'

/** Sends the change at the revision the person saw; a stale revision keeps the draft and says so. */
async function send(props: ActionsProps, mode: Mode, reason: string, draft: Draft): Promise<string | null> {
  const base = { learningId: props.learning.id, expectedRevision: props.learning.revision, reason: reason.trim() }
  if (mode === 'retire') {
    await runCommand(props.folder, 'retireLearning', base)
    return null
  }
  const result = await runCommand(props.folder, 'replaceLearning', { ...base, replacement: replacementOf(draft) })
  return result.replacement.id
}

function ChangeForm(props: ActionsProps & { mode: Mode; onClose(): void }): JSX.Element {
  const { mode } = props
  const [reason, setReason] = useState('')
  const [draft, setDraft] = useState(() => draftOf(props.learning))
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const submit = (): void => {
    setBusy(true)
    setFailure(null)
    send(props, mode, reason, draft)
      .then((openId) => {
        props.onClose()
        props.onChanged(openId)
      })
      .catch((error: unknown) =>
        setFailure(error instanceof CommandError && error.code === 'conflict' ? { kind: 'stale' } : { kind: 'error', message: errorMessage(error) })
      )
      .finally(() => setBusy(false))
  }
  const verb = mode === 'retire' ? 'Retire' : 'Replace'
  return (
    <form className="learnings-form" aria-label={`${verb} learning`} onSubmit={(event) => { event.preventDefault(); submit() }}>
      {mode === 'replace' ? <ReplacementFields draft={draft} onChange={setDraft} /> : null}
      <Field label="Reason (one line)" value={reason} maxLength={500} onChange={setReason} />
      {failure === null ? null : <FailureNotice failure={failure} onReload={props.onReload} />}
      <div className="button-row">
        <Button type="submit" variant={mode === 'retire' ? 'danger' : 'primary'} busy={busy} disabled={reason.trim() === ''}>
          {verb} at revision {props.learning.revision}
        </Button>
        <Button onClick={props.onClose}>Cancel</Button>
      </div>
    </form>
  )
}

/** Retire and Replace for an active learning; a retired one is history and has neither. */
export function LearningActions(props: ActionsProps): JSX.Element | null {
  const [mode, setMode] = useState<Mode | null>(null)
  if (props.learning.state !== 'active') return null
  if (mode !== null) return <ChangeForm {...props} mode={mode} onClose={() => setMode(null)} />
  return (
    <div className="button-row">
      <Button onClick={() => setMode('replace')}>Replace…</Button>
      <Button variant="danger" onClick={() => setMode('retire')}>Retire…</Button>
    </div>
  )
}
