/**
 * The corrective planner of a sprint report's Improvement tab: the person selects experiments, picks where their work
 * goes (a future sprint of this epic's draft, or a follow-up epic of a completed one; the Dark Mechanicus destination
 * stays pending), edits the generated tickets, previews them with their criteria, dependencies and destination, and
 * creates them as DRAFT work. It never saves, adopts, starts or approves anything: it leads to the draft's normal Save
 * and run controls. Selections and edits live in the planner store, so tab switches, reloads, a newer report revision
 * and refusals never lose them; a request in flight ignores further clicks. Edits are made per work item of the
 * selected experiments, with or without a preview, so an edit that blocks its experiment can always be fixed or reset.
 */
import { type RefObject, useEffect, useId, useRef } from 'react'
import type { CorrectionPlanView, CorrectionsInput, CorrectionsResultView, CreateCorrectionsInput } from '../../../shared/domain/corrections'
import type { RetroExperiment } from '../../../shared/domain/experiments'
import type { SprintReportView } from '../../../shared/domain/views'
import type { Result } from '../epic/workspaceActions'
import { SIZE_LABELS } from '../ticket/ticketView'
import { correctionRoute, routeText } from './correctionRoute'
import {
  createBlock,
  editBasis,
  editDefaults,
  editStanding,
  type HeldEdit,
  type PlannerNotice,
  plannerFailure,
  type PlannerRequest,
  plannerRequest,
  type PlannerState,
  previewStanding,
  type PreviewStanding,
  previewView,
  type PreviewTicketRow,
  type PreviewView,
  requestKey,
  type RequestScope,
  resultStands,
  resultView,
  shownNotice,
  type TargetChoice,
  type WorkEditState,
  workRef
} from './improvementView'
import { plannerKey, plannerState, usePlanner } from './plannerStore'
import { Lines } from './RetroSections'

/** What the planner may do: preview and create through the workspace, and open a draft's normal controls. */
export interface CorrectionHost {
  busy: boolean
  /** The draft's sprints (else the saved plan's), to name an existing future sprint as the target. */
  sprints: { id: string; ordinal: number; goal: string }[]
  /** This epic's open draft revision; null when it has none. */
  draftRevision: number | null
  preview(input: CorrectionsInput): Promise<Result<CorrectionPlanView>>
  create(input: CreateCorrectionsInput): Promise<Result<CorrectionsResultView>>
  /** Opens an epic's draft with its normal Save and run controls: this epic's draft view, or another epic. */
  openDraft(epicId: string): void
  /**
   * Opens an epic of another tracked folder in its own workspace, with that project's normal Save, Start run and
   * checkpoint controls (a correction epic in the Dark Mechanicus checkout); null where the screen cannot navigate.
   */
  openFolderEpic: ((folderPath: string, epicId: string) => void) | null
  /** Tells the shell another tracked folder changed (a correction epic created there); null where it cannot. */
  folderChanged: ((folderPath: string) => void) | null
  /** Reads the workspace again (to pick up a newer report revision). */
  reload(): void
}

interface PlannerProps {
  /** The folder the planner state belongs to. */
  folder: string
  report: SprintReportView
  epicTitle: string
  epicCompleted: boolean
  /** The report's sprint ordinal: corrections go after it. */
  sprintOrdinal: number | null
  experiments: RetroExperiment[]
  /** Why each experiment that cannot be selected now is left out of the request. */
  unselectable: ReadonlyMap<string, string>
  host: CorrectionHost
}

type Update = (change: (state: PlannerState) => PlannerState) => void

/** The draft's sprints after the report's sprint, in order. */
function laterSprints(props: PlannerProps): CorrectionHost['sprints'] {
  const after = props.sprintOrdinal ?? 0
  return props.host.sprints.filter((sprint) => sprint.ordinal > after).sort((a, b) => a.ordinal - b.ordinal)
}

function scopeOf(props: PlannerProps): RequestScope {
  return { unselectable: props.unselectable, epicCompleted: props.epicCompleted, laterSprints: laterSprints(props).map((sprint) => sprint.id) }
}

/**
 * The destination: this project's repository (each experiment's tickets go to the repository it names). Experiments
 * aimed at the Dark Mechanicus source are routed to the chosen Dark Mechanicus checkout from their own panel (see
 * `correctionRoute.ts` and `CrossRepoCorrection`), never created here.
 */
function DestinationChoice({ experiments }: { experiments: RetroExperiment[] }): JSX.Element {
  const name = useId()
  const routes = experiments.map((experiment) => correctionRoute(experiment.destination))
  const same = [...new Set(routes.flatMap((route) => (route.kind === 'same_repository' ? [routeText(route)] : [])))]
  const elsewhere = routes.filter((route) => route.kind === 'darkmechanicus_source').length
  return (
    <fieldset className="cp-plan-fieldset">
      <legend>Destination</legend>
      <label className="cp-plan-option">
        <input type="radio" name={name} checked readOnly />
        <span>
          <span>This project&apos;s source repository</span>
          <span className="field-hint">Each experiment&apos;s tickets go to the repository it names{same.length === 0 ? '' : `: ${same.join(', ')}`}.</span>
        </span>
      </label>
      <label className="cp-plan-option is-disabled">
        <input type="radio" name={name} disabled />
        <span>
          <span>Dark Mechanicus source checkout</span>
          <span className="field-hint">
            {elsewhere === 0
              ? 'No experiment of this retro is aimed at it.'
              : `${elsewhere} experiment(s) aimed at it are routed from their own "Dark Mechanicus source" panel above, as a new epic of your Dark Mechanicus checkout.`}
          </span>
        </span>
      </label>
    </fieldset>
  )
}

function FollowUpTarget(props: { planner: PlannerProps; target: TargetChoice | null; update: Update }): JSX.Element {
  const { planner, target, update } = props
  const title = target?.kind === 'follow_up_epic' ? target.title : ''
  return (
    <fieldset className="cp-plan-fieldset">
      <legend>Where the work goes</legend>
      <p className="field-hint">
        A follow-up epic linked to this completed epic, as a draft you review and Save. The completed epic, its runs, reports and grades stay as they are; an open
        follow-up epic that already holds work of this retro takes the new work instead.
      </p>
      <label className="field">
        <span className="field-label">Title of a new follow-up epic</span>
        <input
          className="input"
          value={title}
          placeholder={`Follow-up: ${planner.epicTitle}`}
          onChange={(event) => update((now) => ({ ...now, target: { kind: 'follow_up_epic', title: event.target.value } }))}
        />
      </label>
    </fieldset>
  )
}

interface LaterSprintProps {
  name: string
  future: CorrectionHost['sprints']
  after: number
  chosen: string | null
  onChoose(target: TargetChoice): void
}

function LaterSprint(props: LaterSprintProps): JSX.Element {
  const { future, chosen } = props
  return (
    <label className={future.length === 0 ? 'cp-plan-option is-disabled' : 'cp-plan-option'}>
      <input
        type="radio"
        name={props.name}
        disabled={future.length === 0}
        checked={chosen !== null}
        onChange={() => props.onChoose({ kind: 'sprint', sprintId: future[0]?.id ?? '' })}
      />
      <span>
        <span>An existing later sprint of the draft</span>
        {future.length === 0 ? (
          <span className="field-hint">The draft has no sprint after Sprint {props.after}.</span>
        ) : (
          <select
            className="input"
            aria-label="Later sprint"
            value={chosen ?? ''}
            disabled={chosen === null}
            onChange={(event) => props.onChoose({ kind: 'sprint', sprintId: event.target.value })}
          >
            {future.map((sprint) => (
              <option key={sprint.id} value={sprint.id}>
                Sprint {sprint.ordinal}
                {sprint.goal.trim() === '' ? '' : ` · ${sprint.goal}`}
              </option>
            ))}
          </select>
        )}
      </span>
    </label>
  )
}

function SprintTarget(props: { planner: PlannerProps; target: TargetChoice | null; update: Update }): JSX.Element {
  const { planner, target, update } = props
  const name = useId()
  const setTarget = (next: TargetChoice | null): void => update((now) => ({ ...now, target: next }))
  const after = planner.sprintOrdinal ?? 0
  const chosen = target?.kind === 'sprint' ? target.sprintId : null
  return (
    <fieldset className="cp-plan-fieldset">
      <legend>Where the work goes</legend>
      <label className="cp-plan-option">
        {/* onClick, not onChange: choosing it while already checked (a dropped target shows it so) clears the kept target. */}
        <input type="radio" name={name} checked={chosen === null} readOnly onClick={() => setTarget(null)} />
        <span>
          <span>A new sprint appended to this epic&apos;s draft</span>
          <span className="field-hint">It ends at a human checkpoint. Sprint {after} and earlier stay as they are.</span>
        </span>
      </label>
      <LaterSprint name={name} future={laterSprints(planner)} after={after} chosen={chosen} onChoose={setTarget} />
    </fieldset>
  )
}

function Notice(props: { notice: PlannerNotice; onPreview(): void; onReload(): void; onDismiss(): void }): JSX.Element {
  const { notice } = props
  return (
    <div role="alert" className={notice.tone === 'error' ? 'cp-refusal' : 'cp-plan-info'}>
      <p>{notice.text}</p>
      <div className="cp-plan-actions">
        {notice.action === 'preview' ? (
          <button type="button" className="btn" onClick={props.onPreview}>
            Preview again
          </button>
        ) : null}
        {notice.action === 'reload' ? (
          <button type="button" className="btn" onClick={props.onReload}>
            Reload
          </button>
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={props.onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  )
}

/** Another work item of the request, to require it. */
interface OtherWork {
  ref: string
  label: string
}

function RequiresWork(props: { others: OtherWork[]; requires: string[]; onChange(requires: string[]): void }): JSX.Element | null {
  const { others, requires } = props
  if (others.length === 0) return null
  return (
    <fieldset className="cp-plan-fieldset">
      <legend>Requires other corrective work</legend>
      {others.map((other) => (
        <label key={other.ref} className="cp-plan-option">
          <input
            type="checkbox"
            checked={requires.includes(other.ref)}
            onChange={(event) => props.onChange(event.target.checked ? [...requires, other.ref] : requires.filter((item) => item !== other.ref))}
          />
          <span>{other.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

interface EditFormProps {
  /** "xp_… · work 1". */
  label: string
  size: string
  defaults: Required<WorkEditState>
  /** Whether the criteria default comes from a preview (else the person starts from none). */
  previewed: boolean
  edit: WorkEditState
  others: OtherWork[]
  onChange(patch: WorkEditState): void
  onDone(): void
  onReset(): void
}

/** The edit form of one generated work ticket; every change is kept in the planner store at once. */
function EditForm(props: EditFormProps): JSX.Element {
  const { defaults, edit, onChange } = props
  const title = useRef<HTMLInputElement>(null)
  useEffect(() => title.current?.focus(), [])
  const value = <K extends keyof WorkEditState>(field: K): Required<WorkEditState>[K] => (edit[field] ?? defaults[field]) as Required<WorkEditState>[K]
  return (
    <div className="cp-plan-edit" role="group" aria-label={`Edit ${props.label}`}>
      <label className="field">
        <span className="field-label">Title</span>
        <input ref={title} className="input" value={value('title')} onChange={(event) => onChange({ title: event.target.value })} />
      </label>
      <label className="field">
        <span className="field-label">Body: what changes</span>
        <textarea className="input" rows={3} value={value('body')} onChange={(event) => onChange({ body: event.target.value })} />
        <span className="field-hint">The experiment&apos;s context is added under it. The size stays the experiment&apos;s ({props.size}); restate the experiment to change it.</span>
      </label>
      <label className="field">
        <span className="field-label">Acceptance criteria, one per line</span>
        <textarea className="input" rows={3} value={value('criteria')} onChange={(event) => onChange({ criteria: event.target.value })} />
        {props.previewed ? null : <span className="field-hint">Preview first to start from the generated criteria; left empty, the generated ones are kept.</span>}
      </label>
      <RequiresWork others={props.others} requires={value('requires')} onChange={(requires) => onChange({ requires })} />
      <label className="field">
        <span className="field-label">Requires draft tickets (keys, separated by commas)</span>
        <input className="input" value={value('requiresTickets')} placeholder="e.g. DM-12" onChange={(event) => onChange({ requiresTickets: event.target.value })} />
      </label>
      <div className="cp-plan-actions">
        <button type="button" className="btn" onClick={props.onDone}>
          Done
        </button>
        <button type="button" className="btn btn-ghost" onClick={props.onReset}>
          Reset to the generated ticket
        </button>
      </div>
    </div>
  )
}

/** One work item of a selected experiment: its title as it would be created, and its edit, reset or keep/discard. */
interface WorkItem {
  ref: string
  experiment: RetroExperiment
  index: number
  /** The generated ticket of the current preview, when there is one. */
  ticket: CorrectionPlanView['tickets'][number] | undefined
  label: string
}

interface WorkItemProps {
  item: WorkItem
  others: OtherWork[]
  reportId: string
  state: PlannerState
  update: Update
}

/**
 * An edit kept for this work item, with what it stands against now: an edit written for work a newer revision restated
 * is held until the person keeps it (for the restated work) or discards it.
 */
function EditStandingLine(props: { item: WorkItem; reportId: string; update: Update; state: PlannerState }): JSX.Element | null {
  const { item, reportId, update } = props
  const edit = props.state.edits[item.ref]
  if (edit === undefined || editStanding(edit, item.experiment, item.index, reportId) !== 'restated') return null
  const now = editBasis(item.experiment, item.index, reportId)
  const keep = (): void => update((state) => ({ ...state, edits: { ...state.edits, [item.ref]: { ...edit, against: now } } }))
  const discard = (): void => update((state) => ({ ...state, edits: Object.fromEntries(Object.entries(state.edits).filter(([key]) => key !== item.ref)) }))
  return (
    <div role="alert" className="cp-refusal">
      <p>
        You edited this work when it read &quot;{edit.against.title}&quot;; this revision restates it as &quot;{now.title}&quot;. Your edit is left out until you keep it
        for the restated work or discard it.
      </p>
      <div className="cp-plan-actions">
        <button type="button" className="btn" onClick={keep}>
          Keep my edit
        </button>
        <button type="button" className="btn btn-ghost" onClick={discard}>
          Discard my edit
        </button>
      </div>
    </div>
  )
}

/** Focus back on the Edit button once the form it opened closes (Done or Reset), so focus is never lost to the page. */
function useReturnFocus(open: boolean): { button: RefObject<HTMLButtonElement>; arm(): void } {
  const button = useRef<HTMLButtonElement>(null)
  const armed = useRef(false)
  useEffect(() => {
    if (open || !armed.current) return
    armed.current = false
    button.current?.focus()
  }, [open])
  return {
    button,
    arm: () => {
      armed.current = true
    }
  }
}

function WorkItemHead(props: { item: WorkItem; edit: WorkEditState | undefined; size: string }): JSX.Element {
  const { item, edit } = props
  const title = edit?.title ?? item.experiment.proposedWork[item.index]?.title ?? ''
  return (
    <span className="cp-experiment-head">
      <span className="ew-mono cp-key">{item.ticket?.key ?? item.label}</span>
      <span>{title.trim() === '' ? '(no title)' : title}</span>
      <span className="ew-chip">{props.size}</span>
      {edit === undefined ? null : <span className="ew-pill ew-tone-edited">Edited</span>}
    </span>
  )
}

function WorkItemRow(props: WorkItemProps): JSX.Element {
  const { item, state, update, reportId } = props
  const edit = state.edits[item.ref]
  const open = state.editing === item.ref
  const focus = useReturnFocus(open)
  const basis = editBasis(item.experiment, item.index, reportId)
  const change = (patch: WorkEditState): void =>
    update((now) => ({ ...now, edits: { ...now.edits, [item.ref]: { ...now.edits[item.ref], ...patch, against: now.edits[item.ref]?.against ?? basis } } }))
  const reset = (): void => {
    // From the open form, focus returns once it closes; from the closed row the Reset button itself goes away.
    if (open) focus.arm()
    else focus.button.current?.focus()
    update((now) => ({ ...now, editing: now.editing === item.ref ? null : now.editing, edits: Object.fromEntries(Object.entries(now.edits).filter(([key]) => key !== item.ref)) }))
  }
  const sized = item.experiment.proposedWork[item.index]?.size ?? null
  const size = sized === null ? 'Unsized' : SIZE_LABELS[sized]
  return (
    <li className="cp-plan-ticket">
      <WorkItemHead item={item} edit={edit} size={size} />
      <EditStandingLine item={item} reportId={reportId} update={update} state={state} />
      {open ? (
        <EditForm
          label={item.label}
          size={size}
          defaults={editDefaults(item.experiment, item.index, item.ticket)}
          previewed={item.ticket !== undefined}
          edit={edit ?? {}}
          others={props.others}
          onChange={change}
          onDone={() => {
            focus.arm()
            update((now) => ({ ...now, editing: null }))
          }}
          onReset={reset}
        />
      ) : (
        <span className="cp-plan-actions">
          <button ref={focus.button} type="button" className="btn btn-ghost" onClick={() => update((now) => ({ ...now, editing: item.ref }))}>
            Edit title, body, criteria or prerequisites
          </button>
          {edit === undefined ? null : (
            <button type="button" className="btn btn-ghost" onClick={reset}>
              Reset to the generated ticket
            </button>
          )}
        </span>
      )}
    </li>
  )
}

/** Edits kept for work items this revision no longer has: dropped from the request; the person clears them. */
function GoneEdits(props: { held: HeldEdit[]; update: Update }): JSX.Element | null {
  const gone = props.held.filter((edit) => edit.standing === 'gone')
  if (gone.length === 0) return null
  const clear = (): void => {
    const refs = new Set(gone.map((edit) => edit.ref))
    props.update((now) => ({ ...now, edits: Object.fromEntries(Object.entries(now.edits).filter(([key]) => !refs.has(key))) }))
  }
  return (
    <div role="status" className="cp-plan-info">
      <p>
        {gone.map((edit) => `Your edit of ${edit.experimentId} work ${edit.index + 1}`).join('; ')}: this revision&apos;s experiment no longer has that work item, so the edit
        is left out of the request.
      </p>
      <button type="button" className="btn btn-ghost" onClick={clear}>
        Clear dropped edits
      </button>
    </div>
  )
}

/**
 * The work items of the selected experiments, each editable with or without a preview: an edit that leaves its
 * experiment blocked (a blank title, a vague body, no criteria) is fixed or reset here.
 */
function SelectedWork(props: { planner: PlannerProps; request: PlannerRequest; state: PlannerState; update: Update }): JSX.Element | null {
  const { planner, request, state, update } = props
  const ids = request.input.experimentIds
  if (ids.length === 0) return null
  // The last preview of this revision gives the generated keys and criteria to start an edit from, even once stale.
  const previewTickets = state.preview?.reportId === planner.report.id ? state.preview.view.tickets : []
  const items: WorkItem[] = planner.experiments
    .filter((experiment) => ids.includes(experiment.id))
    .flatMap((experiment) =>
      experiment.proposedWork.map((_, index) => {
        const ref = workRef(experiment.id, index)
        return { ref, experiment, index, ticket: previewTickets.find((ticket) => ticket.ref === ref), label: `${experiment.id} · work ${index + 1}` }
      })
    )
  const label = (item: WorkItem): string => `${item.ticket?.key ?? item.label} ${state.edits[item.ref]?.title ?? item.experiment.proposedWork[item.index]?.title ?? ''}`
  return (
    <section className="cp-plan-work" aria-label="Selected work">
      <h4 className="ew-eyebrow">SELECTED WORK · EDIT BEFORE YOU CREATE</h4>
      <ul className="cp-plan-tickets">
        {items.map((item) => (
          <WorkItemRow
            key={item.ref}
            item={item}
            reportId={planner.report.id}
            others={items.filter((other) => other.ref !== item.ref).map((other) => ({ ref: other.ref, label: label(other) }))}
            state={state}
            update={update}
          />
        ))}
      </ul>
      <GoneEdits held={request.held} update={update} />
    </section>
  )
}

function TicketFacts({ row }: { row: PreviewTicketRow }): JSX.Element {
  return (
    <dl className="cp-experiment-fields">
      <dt>Destination</dt>
      <dd>{row.repository}</dd>
      <dt>Tags</dt>
      <dd>{row.tags === '' ? 'None' : row.tags}</dd>
      <dt>Body</dt>
      <dd className="cp-plan-body">{row.body}</dd>
      <dt>Criteria</dt>
      <dd>
        <ul>
          {row.criteria.map((criterion, index) => (
            <li key={`${index}:${criterion.text}`}>
              {criterion.text}
              {criterion.covers === null ? null : <span className="ew-muted"> (covers {criterion.covers})</span>}
            </li>
          ))}
        </ul>
      </dd>
      <dt>Requires</dt>
      <dd>{row.requires.length === 0 ? 'Nothing' : row.requires.join(', ')}</dd>
    </dl>
  )
}

/** A previewed ticket; Edited marks work whose edit the request carries (a held edit is not in it). */
function TicketPreview(props: { row: PreviewTicketRow; sent: ReadonlySet<string> }): JSX.Element {
  const { row } = props
  const work = row.work
  const edited = work !== null && props.sent.has(workRef(work.experimentId, work.index))
  return (
    <li className="cp-plan-ticket" aria-label={`${row.role} ${row.key}`}>
      <span className="cp-experiment-head">
        <span className="ew-chip">{row.role}</span>
        <span className="ew-mono cp-key">{row.key}</span>
        <span>{row.title}</span>
        <span className="ew-chip">{row.size}</span>
        {row.existing ? <span className="ew-chip">existing node: gains covers</span> : null}
        {edited ? <span className="ew-pill ew-tone-edited">Edited</span> : null}
      </span>
      <TicketFacts row={row} />
    </li>
  )
}

function ExperimentStates(props: { rows: PreviewView['experiments']; edited: ReadonlySet<string>; host: CorrectionHost }): JSX.Element {
  return (
    <ul className="cp-plan-states" aria-label="Selected experiments">
      {props.rows.map((item) => (
        <li key={item.experimentId}>
          <span className={`ew-pill ew-tone-${item.tone}`}>{item.label}</span> <span className="ew-mono">{item.experimentId}</span>
          {item.problems.length === 0 ? null : <Lines items={item.problems} />}
          {item.tone === 'attention' && props.edited.has(item.experimentId) ? (
            <p className="ew-muted">Previewed with your edits: fix or reset them under Selected work.</p>
          ) : null}
          {item.existing === null ? null : (
            <span className="ew-muted">
              {' '}
              Already in {item.existing}.{' '}
              <button type="button" className="sc-link" onClick={() => props.host.openDraft(item.existingEpicId ?? '')}>
                Open that epic&apos;s draft
              </button>
            </span>
          )}
          {item.restatement === null ? null : (
            <details>
              <summary>How to restate it (for the orchestrator&apos;s next report revision)</summary>
              <pre className="ew-mono cp-plan-restatement">{item.restatement}</pre>
            </details>
          )}
        </li>
      ))}
    </ul>
  )
}

function Validation({ view }: { view: PreviewView }): JSX.Element {
  const lines = [...view.validation.errors.map((line) => `Error: ${line}`), ...view.validation.warnings.map((line) => `Warning: ${line}`), ...view.notes]
  return (
    <div role="group" aria-label="Validation">
      <h4 className="ew-eyebrow">THE DRAFT WITH THIS WORK</h4>
      <p className={view.validation.valid ? 'ew-muted' : 'cp-plan-stale'}>
        {view.validation.valid ? 'Valid: it can be saved once you have reviewed it.' : 'Not valid yet: Save stays blocked until these are fixed.'}
      </p>
      {lines.length === 0 ? null : <Lines items={lines} />}
    </div>
  )
}

function staleText(standing: PreviewStanding, previewed: number, current: number): string | null {
  if (standing === 'report_revised') {
    return `This preview was read for report revision ${previewed}; the report is now revision ${current}. Preview again: your selection and edits are kept.`
  }
  return standing === 'changed' ? 'Your choices changed since this preview: preview again to see what would be created.' : null
}

function PreviewPanel(props: { planner: PlannerProps; state: PlannerState; request: PlannerRequest; standing: PreviewStanding }): JSX.Element | null {
  const { state, planner } = props
  const preview = state.preview
  if (preview === null) return null
  const view = previewView(preview.view)
  const stale = staleText(props.standing, preview.view.source.reportRevision, planner.report.reportRevision)
  const edits = props.request.input.edits ?? []
  const edited = new Set(edits.map((edit) => edit.experimentId))
  const sent = new Set(edits.map((edit) => workRef(edit.experimentId, edit.index)))
  return (
    <section className="cp-plan-preview" aria-label="Preview of the corrective work">
      <h4 className="ew-eyebrow">PREVIEW · NOTHING IS WRITTEN YET</h4>
      {stale === null ? null : (
        <p role="status" className="cp-plan-stale">
          {stale}
        </p>
      )}
      <dl className="cp-experiment-fields">
        <dt>Goes into</dt>
        <dd>{view.target}</dd>
        <dt>Destination</dt>
        <dd>{view.destination}</dd>
        <dt>Draft</dt>
        <dd>{preview.view.draftRevision === null ? 'None open: created by this request' : `Read at draft revision ${preview.view.draftRevision}`}</dd>
      </dl>
      <ExperimentStates rows={view.experiments} edited={edited} host={planner.host} />
      {view.tickets.length === 0 ? <p className="ew-muted">No new ticket: every selected experiment is already created or blocked.</p> : null}
      <ul className="cp-plan-tickets" aria-label="Tickets it would add">
        {view.tickets.map((row) => (
          <TicketPreview key={row.ref} row={row} sent={sent} />
        ))}
      </ul>
      {view.dependencies.length === 0 ? null : (
        <div role="group" aria-label="Dependencies">
          <h4 className="ew-eyebrow">DEPENDENCIES</h4>
          <Lines items={view.dependencies} />
        </div>
      )}
      <Validation view={view} />
    </section>
  )
}

function ResultPanel(props: { result: CorrectionsResultView; host: CorrectionHost; epicCompleted: boolean }): JSX.Element {
  const view = resultView(props.result)
  return (
    <section className="cp-plan-result" aria-label="Corrective work created" role="status">
      <p>
        <span className={`ew-pill ew-tone-${view.tone}`}>{props.result.changed ? 'Draft work created' : 'Nothing added'}</span> {view.heading}
      </p>
      {view.tickets.length === 0 ? null : <Lines items={view.tickets} />}
      <ol className="cp-notes" aria-label="Next steps">
        {view.nextSteps.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
      <div className="cp-plan-actions">
        {view.epicId === null ? null : (
          <button type="button" className="btn btn-primary" onClick={() => props.host.openDraft(view.epicId ?? '')}>
            {view.sameEpic ? 'Open the draft to review and Save' : `Open "${view.epicTitle}" to review and Save`}
          </button>
        )}
        {view.sameEpic && !props.epicCompleted ? (
          <span className="field-hint">The checkpoint gate stays yours: Approve retro &amp; redraft saves, adopts and approves only when you press it.</span>
        ) : null}
      </div>
    </section>
  )
}

interface PlannerRequests {
  preview(): Promise<void>
  create(): Promise<void>
}

/**
 * Preview and Create, each ignoring a click while a request is in flight (read from the store, so a second click or a
 * remounted screen sees the first). A refusal keeps the selection and edits. One that a new preview recovers (a newer
 * draft, an edit to fix) drops the preview, so nothing is created before the person has seen the new one; a replaced
 * report keeps it, so once reloaded it reads as the preview of the earlier revision. Create sends the draft revision
 * the preview read, null included: a draft opened since a preview that found none is refused as stale too.
 */
function plannerRequests(key: string, props: PlannerProps, update: Update): PlannerRequests {
  const { report, experiments, host } = props
  const scope = scopeOf(props)
  return {
    async preview() {
      const current = plannerState(key)
      const ask = plannerRequest(report.id, current, experiments, scope).input
      if (current.pending !== null || ask.experimentIds.length === 0) return
      update((now) => ({ ...now, pending: 'preview', notice: null }))
      const answer = await host.preview(ask)
      update((now) =>
        answer.ok
          ? { ...now, pending: null, preview: { key: requestKey(ask), reportId: report.id, view: answer.value } }
          : { ...now, pending: null, notice: { ...plannerFailure(answer.failure, 'preview'), reportId: report.id } }
      )
    },
    async create() {
      const current = plannerState(key)
      const request = plannerRequest(report.id, current, experiments, scope)
      if (createBlock(current, request, host.busy) !== null || current.preview === null) return
      const expectedDraftRevision = current.preview.view.draftRevision
      update((now) => ({ ...now, pending: 'create', notice: null }))
      const answer = await host.create({ ...request.input, expectedDraftRevision })
      update((now) => {
        if (answer.ok) return { ...now, pending: null, preview: null, editing: null, result: { reportId: report.id, view: answer.value } }
        const notice = plannerFailure(answer.failure, 'create')
        return { ...now, pending: null, notice: { ...notice, reportId: report.id }, preview: notice.action === 'preview' ? null : now.preview }
      })
    }
  }
}

function PlannerControls(props: { state: PlannerState; input: CorrectionsInput; standing: PreviewStanding; block: string | null; requests: PlannerRequests }): JSX.Element {
  const { state, standing, block, requests } = props
  const hint = useId()
  return (
    <>
      <div className="cp-plan-actions">
        <button type="button" className="btn" disabled={state.pending !== null || props.input.experimentIds.length === 0} onClick={() => void requests.preview()}>
          {state.pending === 'preview' ? 'Reading the preview…' : standing === 'none' ? 'Preview corrective work' : 'Preview again'}
        </button>
        <button type="button" className="btn btn-primary" disabled={block !== null} aria-describedby={block === null ? undefined : hint} onClick={() => void requests.create()}>
          {state.pending === 'create' ? 'Creating draft work…' : 'Create draft work'}
        </button>
      </div>
      {block === null ? null : (
        <p id={hint} className="field-hint">
          {block}
        </p>
      )}
    </>
  )
}

/** The selection as sent, and what was left out of it and why. */
function SelectionLine(props: { request: PlannerRequest }): JSX.Element {
  const { input, leftOut, targetDropped, prerequisitesDropped } = props.request
  return (
    <>
      <p>Selected: {input.experimentIds.length === 0 ? 'none yet: tick experiments above.' : input.experimentIds.join(', ')}</p>
      {leftOut.length === 0 && targetDropped === null && prerequisitesDropped.length === 0 ? null : (
        <ul className="cp-notes" aria-label="Left out of the request">
          {leftOut.map((item) => (
            <li key={item.experimentId}>
              {item.experimentId} is left out: {item.why} Untick it to clear it from your selection.
            </li>
          ))}
          {targetDropped === null ? null : <li>{targetDropped}</li>}
          {prerequisitesDropped.map((item) => (
            <li key={`${item.ref}>${item.requires}`}>
              Your edit of {item.ref} requires {item.requires}, whose experiment is not selected: that prerequisite is left out of the request. Select its experiment
              again to keep it.
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** The corrective planner: select, choose the target, preview, edit and create draft work; nothing runs on its own. */
export function CorrectivePlanner(props: PlannerProps): JSX.Element {
  const key = plannerKey(props.folder, props.report)
  const [state, update] = usePlanner(key)
  const { report, experiments, host } = props
  const request = plannerRequest(report.id, state, experiments, scopeOf(props))
  const { input } = request
  const standing = previewStanding(state, report.id, input)
  const requests = plannerRequests(key, props, update)
  const Target = props.epicCompleted ? FollowUpTarget : SprintTarget
  const notice = shownNotice(state.notice, report)
  const result = resultStands(state.result, report.id, host.draftRevision) ? state.result : null
  const reload = (): void => {
    update((now) => ({ ...now, notice: null }))
    host.reload()
  }
  return (
    <section className="cp-section cp-planner" aria-label="Corrective work">
      <h3 className="ew-eyebrow">4 · CORRECTIVE WORK</h3>
      <p className="field-hint">
        Corrective work is created only when you ask, as DRAFT work you review. Opening this report or a low grade starts nothing, and nothing here saves, adopts, starts
        or approves.
      </p>
      <SelectionLine request={request} />
      <DestinationChoice experiments={experiments} />
      <Target planner={props} target={request.target} update={update} />
      <label className="cp-plan-option">
        <input type="checkbox" checked={state.fireguard} onChange={(event) => update((now) => ({ ...now, fireguard: event.target.checked }))} />
        <span>Add a Fireguard ticket that grades the corrective tests</span>
      </label>
      <SelectedWork planner={props} request={request} state={state} update={update} />
      <PlannerControls state={state} input={input} standing={standing} block={createBlock(state, request, host.busy)} requests={requests} />
      {notice === null ? null : <Notice notice={notice} onPreview={() => void requests.preview()} onReload={reload} onDismiss={() => update((now) => ({ ...now, notice: null }))} />}
      <PreviewPanel planner={props} state={state} request={request} standing={standing} />
      {result === null ? null : <ResultPanel result={result.view} host={host} epicCompleted={props.epicCompleted} />}
    </section>
  )
}
