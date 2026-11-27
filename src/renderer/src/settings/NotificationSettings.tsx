import { useEffect, useId, useState } from 'react'
import type { FormEvent } from 'react'
import { NOTIFICATION_EVENTS, type NotificationSettings as Settings } from '../../../shared/desktop/notificationSettings'
import { Button } from '../components/Button'
import { CommandError, errorMessage } from '../api/dm'
import { useToasts } from '../app/toasts'
import {
  NOTES_LIMIT,
  addAlwaysAsk,
  isDirty,
  notesError,
  removeAlwaysAsk,
  validForm
} from './notificationSettingsForm'

type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number]
type Arbitration = Settings['arbitration']

const EVENT_LABELS: Record<NotificationEvent, string> = {
  approval_needed: 'An approval needs you',
  question: 'A question needs you',
  checkpoint_ready: 'A checkpoint is ready',
  run_failed: 'A run failed',
  run_stalled: 'A run went quiet (5 minutes)'
}

const ARBITRATE_HELP =
  "While a worker waits on a tool approval, the Magos's turn is blocked, so a short-lived Magos session decides allow or deny from the ticket and your rules, or asks you. Questions, paths outside the folder and tools you always want to approve are never decided for you."

const NOT_CONFIRMED = 'Not changed: you did not confirm it.'

interface NotificationForm {
  kind: 'ready'
  baseline: Settings
  form: Settings
  notice: string | null
  saving: boolean
  /** Bumped on a revert or a finished save, so per-field drafts and their inline errors start over. */
  generation: number
  edit(next: Settings): void
  revert(): void
  save(): Promise<void>
}

type NotificationFormState =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string; retry(): void }
  | NotificationForm

type LoadState = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; settings: Settings }

/** Reads main's settings, again each time `retry` is pressed after a failure. */
function useStoredSettings(): { load: LoadState; retry(): void } {
  const [attempt, setAttempt] = useState(0)
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  useEffect(() => {
    let live = true
    window.dm.settings
      .getNotifications()
      .then((result) => {
        if (!result.ok) throw new CommandError(result.error)
        if (live) setLoad({ kind: 'loaded', settings: result.data })
      })
      .catch((error: unknown) => {
        if (live) setLoad({ kind: 'failed', message: errorMessage(error) })
      })
    return () => {
      live = false
    }
  }, [attempt])
  const retry = (): void => {
    setLoad({ kind: 'loading' })
    setAttempt((count) => count + 1)
  }
  return { load, retry }
}

/** Loads main's settings, tracks the edited copy and saves the whole object, taking main's answer as the baseline. */
function useNotificationForm(): NotificationFormState {
  const toasts = useToasts()
  const { load, retry } = useStoredSettings()
  const [saved, setSaved] = useState<Settings | null>(null)
  const [edited, setEdited] = useState<Settings | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [generation, setGeneration] = useState(0)
  if (load.kind === 'loading') return load
  if (load.kind === 'failed') return { ...load, retry }
  const baseline = saved ?? load.settings
  const form = edited ?? baseline

  const restart = (): void => setGeneration((count) => count + 1)
  const save = async (): Promise<void> => {
    const next = validForm(form)
    if (next === null) return
    setSaving(true)
    setNotice(null)
    try {
      const result = await window.dm.settings.setNotifications(next)
      if (result.ok) {
        setSaved(result.data)
        setEdited(null)
        restart()
      } else if (result.error.code === 'cancelled') {
        setEdited(null)
        setNotice(NOT_CONFIRMED)
        restart()
      } else {
        toasts.reportError(new CommandError(result.error))
      }
    } catch (error) {
      toasts.reportError(error)
    } finally {
      setSaving(false)
    }
  }
  const edit = (next: Settings): void => {
    setNotice(null)
    setEdited(next)
  }
  const revert = (): void => {
    setNotice(null)
    setEdited(null)
    restart()
  }
  return { kind: 'ready', baseline, form, notice, saving, generation, edit, revert, save }
}

/** The "Notifications & approvals" section: edits main's settings and saves the whole object at once. */
export function NotificationSettings(): JSX.Element {
  const state = useNotificationForm()
  if (state.kind === 'loading') return <p className="settings-empty">Loading…</p>
  if (state.kind === 'failed') {
    return (
      <div className="settings-load-failed">
        <p className="form-error" role="alert">
          Could not load the notification settings. {state.message}
        </p>
        <Button size="sm" onClick={state.retry}>
          Retry
        </Button>
      </div>
    )
  }
  const { baseline, form, notice, saving, generation, edit, revert, save } = state
  const dirty = isDirty(form, baseline)
  return (
    <div className="notification-settings">
      <EventsGroup form={form} edit={edit} />
      <FocusedGroup form={form} edit={edit} />
      <ArbitrationGroup
        arbitration={form.arbitration}
        generation={generation}
        change={(patch) => edit({ ...form, arbitration: { ...form.arbitration, ...patch } })}
      />
      {notice === null ? null : (
        <p className="settings-notice" role="status">
          {notice}
        </p>
      )}
      <div className="settings-actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!dirty || saving || validForm(form) === null}
          onClick={() => void save()}
        >
          Save
        </button>
        <button type="button" className="btn" disabled={!dirty || saving} onClick={revert}>
          Revert
        </button>
      </div>
    </div>
  )
}

interface GroupProps {
  form: Settings
  edit(next: Settings): void
}

function EventsGroup({ form, edit }: GroupProps): JSX.Element {
  return (
    <fieldset className="settings-group">
      <legend className="settings-legend">Notify me when</legend>
      {NOTIFICATION_EVENTS.map((event) => (
        <label key={event} className="settings-check">
          <input
            type="checkbox"
            checked={form.events[event]}
            onChange={(change) => edit({ ...form, events: { ...form.events, [event]: change.target.checked } })}
          />
          {EVENT_LABELS[event]}
        </label>
      ))}
      <label className="settings-check">
        <input type="checkbox" checked={form.sound} onChange={(change) => edit({ ...form, sound: change.target.checked })} />
        Play a sound
      </label>
    </fieldset>
  )
}

const FOCUSED_CHOICES: readonly { value: Settings['whenFocused']; label: string }[] = [
  { value: 'skip', label: "Don't notify" },
  { value: 'notify', label: 'Notify anyway' }
]

function FocusedGroup({ form, edit }: GroupProps): JSX.Element {
  const id = useId()
  return (
    <fieldset className="settings-group" role="radiogroup" aria-labelledby={`${id}-legend`}>
      <legend id={`${id}-legend`} className="settings-legend">
        When Dark Mechanicus is focused
      </legend>
      {FOCUSED_CHOICES.map(({ value, label }) => (
        <label key={value} className="settings-check">
          <input
            type="radio"
            name={`${id}-focused`}
            checked={form.whenFocused === value}
            onChange={() => edit({ ...form, whenFocused: value })}
          />
          {label}
        </label>
      ))}
    </fieldset>
  )
}

interface ArbitrationProps {
  arbitration: Arbitration
  generation: number
  change(patch: Partial<Arbitration>): void
}

function ArbitrationGroup({ arbitration, generation, change }: ArbitrationProps): JSX.Element {
  const helpId = useId()
  return (
    <fieldset className="settings-group">
      <legend className="settings-legend">Approvals</legend>
      <label className="settings-check">
        <input
          type="checkbox"
          role="switch"
          checked={arbitration.enabled}
          aria-describedby={helpId}
          onChange={(event) => change({ enabled: event.target.checked })}
        />
        Let the Magos arbitrate
      </label>
      <p id={helpId} className="field-hint settings-help">
        {ARBITRATE_HELP}
      </p>
      <AlwaysAskEditor key={generation} list={arbitration.alwaysAsk} change={(alwaysAsk) => change({ alwaysAsk })} />
      <NotesField notes={arbitration.autoHandleNotes} change={(autoHandleNotes) => change({ autoHandleNotes })} />
    </fieldset>
  )
}

interface AlwaysAskEditorProps {
  list: readonly string[]
  change(list: string[]): void
}

/** The always-ask input with Add, its inline refusal, and the entries with a Remove button each. */
function AlwaysAskEditor({ list, change }: AlwaysAskEditorProps): JSX.Element {
  const id = useId()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const add = (event: FormEvent): void => {
    event.preventDefault()
    const added = addAlwaysAsk(list, draft)
    if (!added.ok) return setError(added.error)
    setDraft('')
    change(added.list)
  }
  return (
    <form className="field" onSubmit={add}>
      <label htmlFor={`${id}-input`} className="field-label">
        Always ask me
      </label>
      <p id={`${id}-hint`} className="field-hint settings-help">
        Tools the Magos never decides for you, such as <code>Bash</code>. End an entry with <code>*</code> to match a
        prefix: <code>mcp__server__*</code> covers every tool of that MCP server. At most 50 entries.
      </p>
      <div className="settings-row">
        <input
          id={`${id}-input`}
          className="input"
          value={draft}
          aria-invalid={error !== null}
          aria-describedby={error === null ? `${id}-hint` : `${id}-hint ${id}-error`}
          onChange={(event) => {
            setDraft(event.target.value)
            setError(null)
          }}
        />
        <button type="submit" className="btn">
          Add
        </button>
      </div>
      <InlineError id={`${id}-error`} message={error} />
      <AlwaysAskList list={list} change={change} />
    </form>
  )
}

function AlwaysAskList({ list, change }: AlwaysAskEditorProps): JSX.Element | null {
  if (list.length === 0) return null
  return (
    <ul className="settings-list" aria-label="Always-ask entries">
      {list.map((entry, index) => (
        <li key={entry} className="settings-list-item">
          <code>{entry}</code>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            aria-label={`Remove ${entry}`}
            onClick={() => change(removeAlwaysAsk(list, index))}
          >
            Remove
          </button>
        </li>
      ))}
    </ul>
  )
}

interface NotesFieldProps {
  notes: string
  change(notes: string): void
}

/** The Magos auto-handles notes with a live counter; over the limit it shows why Save is off. */
function NotesField({ notes, change }: NotesFieldProps): JSX.Element {
  const id = useId()
  const error = notesError(notes)
  return (
    <div className="field">
      <label htmlFor={`${id}-notes`} className="field-label">
        Magos auto-handles
      </label>
      <textarea
        id={`${id}-notes`}
        className="input settings-notes"
        rows={5}
        value={notes}
        placeholder="Notes the Magos applies when deciding, such as which commands are routine in this project."
        aria-invalid={error !== null}
        aria-describedby={error === null ? `${id}-counter` : `${id}-counter ${id}-error`}
        onChange={(event) => change(event.target.value)}
      />
      <p id={`${id}-counter`} className={error === null ? 'field-hint settings-counter' : 'field-hint settings-counter is-over'}>
        {notes.length.toLocaleString('en-US')} / {NOTES_LIMIT.toLocaleString('en-US')}
      </p>
      <InlineError id={`${id}-error`} message={error} />
    </div>
  )
}

function InlineError({ id, message }: { id: string; message: string | null }): JSX.Element | null {
  if (message === null) return null
  return (
    <p id={id} className="form-error" role="alert">
      {message}
    </p>
  )
}
