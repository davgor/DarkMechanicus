import { useCallback, useEffect, useState } from 'react'
import type { ProfileView } from '../../../shared/domain/views'
import { errorMessage } from '../api/dm'
import type { Runner } from '../epic/runner'
import { applyProfile, profileSaveInput, type TicketForm } from './ticketForm'

interface ProfileList {
  profiles: ProfileView[] | null
  error: string | null
}

interface Notice {
  tone: 'info' | 'error'
  text: string
}

interface SaveEntry {
  open: boolean
  name: string
  description: string
  busy: boolean
}

const CLOSED: SaveEntry = { open: false, name: '', description: '', busy: false }

/** The repository's named profiles, loaded once per editor and reloaded after a save. */
function useProfiles(runner: Runner): { list: ProfileList; reload(): void } {
  const [list, setList] = useState<ProfileList>({ profiles: null, error: null })
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let active = true
    runner('listProfiles', undefined).then(
      (profiles) => {
        if (active) {
          setList({ profiles, error: null })
        }
      },
      (error: unknown) => {
        if (active) {
          setList({ profiles: null, error: errorMessage(error) })
        }
      }
    )
    return () => {
      active = false
    }
  }, [runner, version])
  const reload = useCallback(() => setVersion((value) => value + 1), [])
  return { list, reload }
}

function hintText(list: ProfileList): string {
  if (list.error !== null) {
    return `Profiles unavailable: ${list.error}`
  }
  return list.profiles === null ? 'Loading profiles…' : 'No named profiles yet.'
}

function filledNote(profile: ProfileView): string {
  const description = profile.description === '' ? '' : `: ${profile.description}`
  return `Filled from ${profile.name}${description}. Apply to update the draft.`
}

function ProfilePicker(props: { profiles: ProfileView[]; form: TicketForm; update(form: TicketForm): void }): JSX.Element {
  const { profiles, form, update } = props
  const chosen = profiles.find((item) => item.name === form.profile)
  const choose = (name: string): void => {
    const profile = profiles.find((item) => item.name === name)
    if (profile !== undefined) {
      update(applyProfile(form, profile))
    }
  }
  return (
    <>
      <label className="tp-field">
        <span>Start from profile</span>
        <select value={form.profile} onChange={(event) => choose(event.target.value)}>
          <option value="">Choose a profile…</option>
          {profiles.map((item) => (
            <option key={item.name} value={item.name} title={item.description}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {chosen === undefined ? null : <p className="ew-muted tp-profile-note">{filledNote(chosen)}</p>}
    </>
  )
}

function NoticeLine({ notice }: { notice: Notice | null }): JSX.Element | null {
  if (notice === null) {
    return null
  }
  return (
    <p className={`tp-message is-${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
      {notice.text}
    </p>
  )
}

interface SaveFormProps {
  entry: SaveEntry
  existing: ProfileView | undefined
  notice: Notice | null
  onChange(entry: SaveEntry): void
  onSave(): void
  onCancel(): void
}

function SaveProfileForm(props: SaveFormProps): JSX.Element {
  const { entry, existing } = props
  const hint =
    existing === undefined
      ? 'Lowercase letters, digits, and hyphens. Saves the requirements shown here; tickets copy a profile when it is applied.'
      : `Replaces the saved profile ${existing.name} (revision ${existing.revision}).`
  return (
    <div className="tp-save-profile" role="group" aria-label="Save as profile">
      <input className="tp-input" aria-label="Profile name" placeholder="ui-implementation" value={entry.name} onChange={(event) => props.onChange({ ...entry, name: event.target.value })} />
      <input
        className="tp-input"
        aria-label="Profile description"
        placeholder={existing?.description || 'When to use it (optional)'}
        value={entry.description}
        onChange={(event) => props.onChange({ ...entry, description: event.target.value })}
      />
      <p className="ew-muted">{hint}</p>
      <NoticeLine notice={props.notice} />
      <div className="tp-inline">
        <button type="button" className="btn btn-primary" disabled={entry.busy || entry.name.trim() === ''} onClick={props.onSave}>
          {existing === undefined ? 'Save profile' : 'Replace profile'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function SaveAsProfile(props: { runner: Runner; form: TicketForm; profiles: ProfileView[]; onSaved(): void }): JSX.Element {
  const [entry, setEntry] = useState<SaveEntry>(CLOSED)
  const [notice, setNotice] = useState<Notice | null>(null)
  const existing = props.profiles.find((item) => item.name === entry.name.trim())
  const save = async (): Promise<void> => {
    setEntry({ ...entry, busy: true })
    try {
      const saved = await props.runner('saveProfile', profileSaveInput(props.form, entry, existing))
      setEntry(CLOSED)
      setNotice({ tone: 'info', text: `Saved profile ${saved.name}.` })
      props.onSaved()
    } catch (error: unknown) {
      setEntry((current) => ({ ...current, busy: false }))
      setNotice({ tone: 'error', text: errorMessage(error) })
    }
  }
  if (entry.open) {
    const cancel = (): void => setEntry(CLOSED)
    return <SaveProfileForm entry={entry} existing={existing} notice={notice} onChange={setEntry} onSave={() => void save()} onCancel={cancel} />
  }
  const open = (): void => {
    setNotice(null)
    setEntry({ ...CLOSED, open: true })
  }
  return (
    <div className="tp-profile-actions">
      <button type="button" className="btn btn-ghost" onClick={open}>
        Save as profile…
      </button>
      <NoticeLine notice={notice} />
    </div>
  )
}

/**
 * Named capability profiles in the ticket editor: start the capability fields from a saved profile
 * (applied with the other edits), or save the requirements shown as a profile for reuse.
 */
export function ProfileBar(props: { runner: Runner; form: TicketForm; update(form: TicketForm): void }): JSX.Element {
  const { list, reload } = useProfiles(props.runner)
  const profiles = list.profiles ?? []
  return (
    <div className="tp-profile-bar">
      {profiles.length > 0 ? (
        <ProfilePicker profiles={profiles} form={props.form} update={props.update} />
      ) : (
        <p className="ew-muted">{hintText(list)}</p>
      )}
      <SaveAsProfile runner={props.runner} form={props.form} profiles={profiles} onSaved={reload} />
    </div>
  )
}
