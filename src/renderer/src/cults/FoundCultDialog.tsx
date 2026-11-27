import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { CULT_ARCHETYPES, ARCHETYPE_INFO } from '../../../shared/cults/archetypes'
import type { CultDefinitionInput, CultModelsView } from '../../../shared/cults/cultApi'
import type { CultView } from '../../../shared/cults/cult'
import { formatDuration } from '../../../shared/cults/duration'
import { cultistName } from '../../../shared/cults/names'
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { EpicSummaryView } from '../../../shared/domain/views'
import { runCommand } from '../api/dm'
import { Button } from '../components/Button'
import { Dialog } from '../components/Dialog'
import { RosterEditor } from './RosterEditor'
import { checkDraft, chooseArchetype, draftOf, newDraft, type DraftCheck, type FoundCultDraft } from './foundCultForm'
import './cults.css'

type Models = { status: 'loading' } | { status: 'ready'; view: CultModelsView }
type Epics = { status: 'none' } | { status: 'loading' } | { status: 'ready'; epics: EpicSummaryView[] } | { status: 'error' }
type Change = (patch: Partial<FoundCultDraft>) => void
type Errors = DraftCheck['errors']

interface FoundCultDialogProps {
  /** The tracked folders a cult may work in. */
  folders: readonly TrackedFolderView[]
  /** The cult being edited; absent to found a new one. */
  cult?: CultView
  /** Resolves with null once saved (the dialog then closes), or the reason it was refused. */
  onSubmit(input: CultDefinitionInput): Promise<string | null>
  onClose(): void
}

/** A labelled control with its refusal beneath it; the control takes the id. */
function FormRow({ label, error, hint, children }: { label: string; error?: string; hint?: string; children(id: string, describedBy: string | undefined): ReactNode }): JSX.Element {
  const id = useId()
  const noteId = `${id}-note`
  const note = error ?? hint
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      {children(id, note === undefined ? undefined : noteId)}
      {note === undefined ? null : <span id={noteId} className={error === undefined ? 'field-hint' : 'form-error'}>{note}</span>}
    </div>
  )
}

function ArchetypeChooser({ draft, change }: { draft: FoundCultDraft; change(next: FoundCultDraft): void }): JSX.Element {
  return (
    <fieldset className="cult-archetypes">
      <legend className="field-label">Archetype</legend>
      {CULT_ARCHETYPES.map((archetype) => {
        const info = ARCHETYPE_INFO[archetype]
        return (
          <label key={archetype} className="cult-archetype">
            <input type="radio" name="archetype" value={archetype} checked={draft.archetype === archetype} onChange={() => change(chooseArchetype(draft, archetype))} />
            <span className="cult-archetype-text">
              <span className="cult-archetype-name">{info.displayName}</span>
              <span className="field-hint">{info.description}</span>
            </span>
          </label>
        )
      })}
      <p className="field-hint cult-archetype-contract">{ARCHETYPE_INFO[draft.archetype].reviewContract}</p>
    </fieldset>
  )
}

/** The epics of a Plan Forge's folder, for its Target plan. */
function useFolderEpics(folderPath: string | null, wanted: boolean): Epics {
  const [epics, setEpics] = useState<Epics>({ status: 'none' })
  useEffect(() => {
    if (!wanted || folderPath === null) {
      setEpics({ status: 'none' })
      return undefined
    }
    let current = true
    setEpics({ status: 'loading' })
    runCommand(folderPath, 'listEpics', undefined).then(
      (list) => current && setEpics({ status: 'ready', epics: list }),
      () => current && setEpics({ status: 'error' })
    )
    return () => {
      current = false
    }
  }, [folderPath, wanted])
  return epics
}

function TargetPlan({ draft, change, error }: { draft: FoundCultDraft; change: Change; error?: string }): JSX.Element {
  const epics = useFolderEpics(draft.folderPath, true)
  const hint = draft.folderPath === null ? 'Choose a tracked folder first.' : epics.status === 'error' ? 'Could not load this folder’s plans.' : undefined
  return (
    <FormRow label="Target plan" error={error} hint={hint}>
      {(id, describedBy) => (
        <select id={id} className="connect-select" value={draft.targetEpicId ?? ''} aria-describedby={describedBy} aria-invalid={error !== undefined}
          onChange={(event) => change({ targetEpicId: event.target.value === '' ? null : event.target.value })}>
          <option value="">{epics.status === 'loading' ? 'Loading plans…' : 'Choose a plan'}</option>
          {epics.status === 'ready' ? epics.epics.map((epic) => <option key={epic.id} value={epic.id}>{epic.title}</option>) : null}
        </select>
      )}
    </FormRow>
  )
}

function PlaceFields({ draft, folders, change, errors }: { draft: FoundCultDraft; folders: readonly TrackedFolderView[]; change: Change; errors: Errors }): JSX.Element {
  const planForge = draft.archetype === 'plan_forge'
  return (
    <>
      <FormRow label="Workspace" error={errors.folder} hint={planForge ? 'A Plan Forge works in a tracked folder.' : undefined}>
        {(id, describedBy) => (
          <select id={id} className="connect-select" value={draft.folderPath ?? ''} aria-describedby={describedBy} aria-invalid={errors.folder !== undefined}
            onChange={(event) => change({ folderPath: event.target.value === '' ? null : event.target.value, targetEpicId: null })}>
            {folders.map((folder) => <option key={folder.path} value={folder.path}>{folder.name}</option>)}
            <option value="">No folder (project-less)</option>
          </select>
        )}
      </FormRow>
      {planForge ? <TargetPlan draft={draft} change={change} error={errors.target} /> : null}
    </>
  )
}

function useModels(): { models: Models; refresh(): void } {
  const [models, setModels] = useState<Models>({ status: 'loading' })
  const load = (refresh: boolean): void => {
    setModels({ status: 'loading' })
    void window.dm.cults.models(refresh).then((result) =>
      setModels({ status: 'ready', view: result.ok ? result.data : { options: [], reason: result.error.message } })
    )
  }
  useEffect(() => load(false), [])
  return { models, refresh: () => load(true) }
}

function ModelField({ models, value, onChange, onRefresh }: { models: Models; value: string | null; onChange(id: string): void; onRefresh(): void }): JSX.Element {
  const reason = models.status === 'ready' ? models.view.reason : null
  const options = models.status === 'ready' ? models.view.options : []
  return (
    <FormRow label="Magos model" error={reason ?? undefined} hint={models.status === 'loading' ? 'Asking OMP for its models…' : 'Cheapest first.'}>
      {(id, describedBy) => (
        <div className="cult-model-line">
          {reason === null ? (
            <select id={id} className="connect-select" value={value ?? ''} aria-describedby={describedBy} disabled={models.status === 'loading'} onChange={(event) => onChange(event.target.value)}>
              {options.map((option) => <option key={option.id} value={option.id}>{`${option.label} · ${option.tier}`}</option>)}
            </select>
          ) : <span id={id} className="cult-model-none">No model offered</span>}
          <Button variant="ghost" size="sm" icon="refresh" aria-label="Refresh models" onClick={onRefresh} />
        </div>
      )}
    </FormRow>
  )
}

function MagosFields({ draft, change, errors }: { draft: FoundCultDraft; change: Change; errors: Errors }): JSX.Element {
  const { models, refresh } = useModels()
  const options = models.status === 'ready' ? models.view.options : null
  const cheapest = options?.[0]?.id ?? null
  useEffect(() => {
    if (options === null) return
    if (options.length === 0) change({ magosModelId: null })
    else if (!options.some((option) => option.id === draft.magosModelId)) change({ magosModelId: cheapest })
  }, [options, cheapest, draft.magosModelId, change])
  return (
    <>
      <FormRow label="Magos name" error={errors.magosName}>
        {(id, describedBy) => <input id={id} className="input" value={draft.magosName} maxLength={80} aria-describedby={describedBy} onChange={(event) => change({ magosName: event.target.value })} />}
      </FormRow>
      <ModelField models={models} value={draft.magosModelId} onChange={(magosModelId) => change({ magosModelId })} onRefresh={refresh} />
    </>
  )
}

function LimitFields({ draft, change, errors }: { draft: FoundCultDraft; change: Change; errors: Errors }): JSX.Element {
  return (
    <div className="cult-limits">
      <FormRow label="Time limit" error={draft.unlimited ? undefined : errors.timeLimit} hint="A duration such as 30m, 90hr, 2d or 1d 6h; at least 1 minute.">
        {(id, describedBy) => <input id={id} className="input mono" value={draft.timeLimit} disabled={draft.unlimited} aria-describedby={describedBy} aria-invalid={errors.timeLimit !== undefined} onChange={(event) => change({ timeLimit: event.target.value })} />}
      </FormRow>
      <label className="cult-check">
        <input type="checkbox" checked={draft.unlimited} onChange={(event) => change({ unlimited: event.target.checked })} />
        Unlimited
      </label>
      <FormRow label="Acolyte cap" error={errors.cap} hint={draft.archetype === 'plan_forge' ? 'From 6 to 24 for a Plan Forge.' : 'From 1 to 24.'}>
        {(id, describedBy) => <input id={id} className="input mono" inputMode="numeric" value={draft.cap} aria-describedby={describedBy} aria-invalid={errors.cap !== undefined} onChange={(event) => change({ cap: event.target.value })} />}
      </FormRow>
    </div>
  )
}

function AdvancedTimings({ draft, change, errors, backstop }: { draft: FoundCultDraft; change: Change; errors: Errors; backstop: number | null }): JSX.Element {
  return (
    <details className="cult-advanced">
      <summary>Advanced timings</summary>
      <FormRow label="Acolyte grace" error={errors.acolyteGrace} hint="From 30s to 60m.">
        {(id, describedBy) => <input id={id} className="input mono" value={draft.acolyteGrace} aria-describedby={describedBy} aria-invalid={errors.acolyteGrace !== undefined} onChange={(event) => change({ acolyteGrace: event.target.value })} />}
      </FormRow>
      <FormRow label="Magos window" error={errors.magosWindow} hint="From 30s to 60m.">
        {(id, describedBy) => <input id={id} className="input mono" value={draft.magosWindow} aria-describedby={describedBy} aria-invalid={errors.magosWindow !== undefined} onChange={(event) => change({ magosWindow: event.target.value })} />}
      </FormRow>
      <p className="field-hint" role="status">
        {backstop === null ? 'Backstop: fix the timings above.' : `Backstop: a run still going ${formatDuration(backstop)} after shutdown starts is killed.`}
      </p>
    </details>
  )
}

/** Name, charter and roster fields are refused only once Save is pressed; bounds are refused as they are typed. */
const LIVE_ERRORS = ['timeLimit', 'cap', 'acolyteGrace', 'magosWindow', 'magosName'] as const

function shownErrors(check: DraftCheck, attempted: boolean): Errors {
  if (attempted) return check.errors
  return Object.fromEntries(LIVE_ERRORS.filter((key) => check.errors[key] !== undefined).map((key) => [key, check.errors[key]]))
}

function useFoundCultForm(props: FoundCultDialogProps): { draft: FoundCultDraft; setDraft(next: FoundCultDraft): void; change: Change } {
  const [draft, setDraft] = useState<FoundCultDraft>(() =>
    props.cult === undefined ? newDraft(cultistName([], 'magos', String(Date.now())), props.folders[0]?.path ?? null) : draftOf(props.cult)
  )
  const change = useRef<Change>((patch) => setDraft((previous) => ({ ...previous, ...patch }))).current
  return { draft, setDraft, change }
}

/**
 * Founds a cult, or edits one: its archetype and roster, name and charter, workspace (and a Plan Forge's target plan),
 * Magos, time limit or Unlimited, acolyte cap and, under Advanced timings, the shutdown timings with their backstop.
 */
export function FoundCultDialog(props: FoundCultDialogProps): JSX.Element {
  const formId = useId()
  const { draft, setDraft, change } = useFoundCultForm(props)
  const [attempted, setAttempted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refusal, setRefusal] = useState<string | null>(null)
  const check = checkDraft(draft)
  const errors = shownErrors(check, attempted)
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    setAttempted(true)
    if (check.input === null || busy) return
    setBusy(true)
    const refused = await props.onSubmit(check.input)
    setBusy(false)
    if (refused === null) props.onClose()
    else setRefusal(refused)
  }
  const editing = props.cult !== undefined
  return (
    <Dialog title={editing ? 'Edit cult' : 'Found a cult'} onClose={props.onClose}
      actions={<>
        <Button onClick={props.onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form={formId} busy={busy}>{editing ? 'Save cult' : 'Found cult'}</Button>
      </>}>
      <form id={formId} className="form cult-form" onSubmit={(event) => void submit(event)}>
        <ArchetypeChooser draft={draft} change={setDraft} />
        <RosterEditor draft={draft} change={change} issues={attempted ? check.rosterIssues : []} />
        <FormRow label="Name" error={errors.name}>
          {(id, describedBy) => <input id={id} className="input" value={draft.name} maxLength={120} aria-describedby={describedBy} onChange={(event) => change({ name: event.target.value })} />}
        </FormRow>
        <FormRow label="Charter" error={errors.charter}>
          {(id, describedBy) => <textarea id={id} className="input" rows={4} value={draft.charter} maxLength={32_000} aria-describedby={describedBy} onChange={(event) => change({ charter: event.target.value })} />}
        </FormRow>
        <PlaceFields draft={draft} folders={props.folders} change={change} errors={errors} />
        <MagosFields draft={draft} change={change} errors={errors} />
        <LimitFields draft={draft} change={change} errors={errors} />
        <AdvancedTimings draft={draft} change={change} errors={errors} backstop={check.backstopMs} />
        {refusal === null ? null : <p role="alert" className="form-error">{refusal}</p>}
      </form>
    </Dialog>
  )
}
