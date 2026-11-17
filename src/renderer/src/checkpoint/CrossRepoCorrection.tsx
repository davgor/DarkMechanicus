/**
 * The Dark Mechanicus source panel of an experiment aimed at the Dark Mechanicus source: choose the checkout on this
 * machine that takes the work (this folder, another tracked folder, or one picked with the folder dialog), see exactly
 * where it goes and what it would write, then create it there as a NEW epic that project owns, or keep the request
 * pending while the checkout is unavailable. Once created, the epic is opened in its own folder with that project's
 * normal Save, Start run and checkpoint controls: nothing here saves, starts, approves or changes this project's epic,
 * runs, reports or scores. The grades of that epic come back here to measure the experiment (before/after).
 */
import { type ReactNode, useId } from 'react'
import type { CrossRepoCorrectionLinkView, CrossRepoCorrectionPreview } from '../../../shared/domain/crossRepoCorrections'
import type { ExperimentView, RetroExperiment } from '../../../shared/domain/experiments'
import {
  actionBlock,
  checkoutTarget,
  crossRepoResults,
  destinationView,
  gradeValue,
  heldEpic,
  mainAction,
  openBlock,
  type OutcomeView,
  stateView,
  targetOptions
} from './crossRepoView'
import { Field, Lines } from './RetroSections'
import { type CrossRepoPanelActions, type CrossRepoPanelState, useCrossRepoCorrection } from './useCrossRepoCorrection'

export interface CrossRepoCorrectionProps {
  folder: string
  /** The report revision the Improvement tab shows (the latest, for a request to be made from it). */
  reportId: string
  experiment: RetroExperiment
  read: ExperimentView | null
  /** The workspace's reload version: the panel reads everything again when it moves. */
  version: number | string
  /** Opens an epic of a tracked folder in its own workspace; null where this screen cannot navigate. */
  openFolderEpic: ((folderPath: string, epicId: string) => void) | null
  /** Tells the shell the target folder changed after a request wrote it (its sidebar lists the epic); null where it cannot. */
  folderChanged: ((folderPath: string) => void) | null
}

type Open = CrossRepoCorrectionProps['openFolderEpic']

/** The chosen checkout: its project, the exact folder the work is written to, and what is wrong with it. */
function Destination({ state }: { state: CrossRepoPanelState }): JSX.Element {
  const target = state.preview.status === 'ready' ? state.preview.value.target : state.checkout === null ? null : checkoutTarget(state.checkout)
  if (target === null) return <p className="ew-muted">Reading the chosen checkout…</p>
  const view = destinationView(target)
  return (
    <dl className="cp-experiment-fields">
      <Field label="Project">
        {view.project} <span className={`ew-pill ew-tone-${view.status.tone}`}>{view.status.label}</span>
      </Field>
      <Field label="Folder">{view.path === null ? 'None chosen' : <span className="ew-mono">{view.path}</span>}</Field>
      {view.problems.length === 0 ? null : (
        <Field label="Why">
          <Lines items={view.problems} />
        </Field>
      )}
    </dl>
  )
}

/** Where the work goes, and the folders it can be chosen among (each with its full path), or one picked in the dialog. */
function TargetChoice(props: { state: CrossRepoPanelState; actions: CrossRepoPanelActions; folder: string }): JSX.Element {
  const { state, actions } = props
  const name = useId()
  const chosenPath = state.checkout?.local?.path ?? null
  const busy = state.busy !== null
  return (
    <fieldset className="cp-plan-fieldset cp-xr-target">
      <legend>Target checkout</legend>
      <Destination state={state} />
      <div role="radiogroup" aria-label="Choose the target checkout">
        {targetOptions(state.folders, props.folder).map((option) => (
          <label key={option.path} className="cp-plan-option">
            <input type="radio" name={name} checked={option.path === chosenPath} disabled={busy} onChange={() => actions.associate(option.path)} />
            <span>
              <span>{option.label}</span>
              <span className="field-hint ew-mono">{option.path}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="cp-plan-actions">
        <button type="button" className="btn" disabled={busy} onClick={actions.pick}>
          Choose another folder…
        </button>
        {chosenPath === null ? null : (
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={actions.clear}>
            Forget the choice
          </button>
        )}
      </div>
    </fieldset>
  )
}

function ticketChip(ticket: CrossRepoCorrectionPreview['tickets'][number]): string {
  if (ticket.role === 'work') return ticket.size ?? 'Unsized'
  return ticket.role === 'fireguard' ? 'Fireguard' : 'Acceptance'
}

function TicketLines({ preview }: { preview: CrossRepoCorrectionPreview }): JSX.Element {
  return (
    <ul className="cp-plan-tickets" aria-label="Tickets the new epic would hold">
      {preview.tickets.map((ticket) => (
        <li key={ticket.ref}>
          <span className="ew-mono">{ticket.key}</span> {ticket.title} <span className="ew-chip">{ticketChip(ticket)}</span>
          <span className="ew-muted"> · {ticket.acceptanceCriteria.length} criteria</span>
        </li>
      ))}
    </ul>
  )
}

function validationText(preview: CrossRepoCorrectionPreview): string {
  const { validation } = preview
  if (validation === null) return 'Checked against the target once its checkout is available.'
  if (validation.errors.length > 0) return `Not valid there: ${validation.errors.map((issue) => issue.message).join(' ')}`
  return validation.warnings.length === 0 ? 'Valid in the target project.' : `Valid there, with ${validation.warnings.length} warning(s).`
}

/**
 * Exactly what creating it would write, and who owns it; once the target holds the epic, that epic as it stands there
 * (its actual keys and state), not a re-planned draft. Nothing is written by reading this.
 */
function ProposedWork({ preview }: { preview: CrossRepoCorrectionPreview }): JSX.Element {
  const owner = preview.target.projectName ?? 'the Dark Mechanicus source'
  const held = heldEpic(preview)
  return (
    <dl className="cp-experiment-fields">
      {held === null ? (
        <Field label="New epic">
          &quot;{preview.epic.title}&quot; · owned by {owner}: its own branch, runs, checkpoints and approvals, in its draft until someone there saves it
        </Field>
      ) : (
        <Field label="Epic there">
          &quot;{held.title}&quot; ({held.epicId}) · owned by {owner}: its own branch, runs, checkpoints and approvals · {held.standing}
        </Field>
      )}
      <Field label="Success">
        <Lines items={preview.epic.successCriteria} />
      </Field>
      {held === null ? (
        <Field label="Tickets">
          <TicketLines preview={preview} />
          {preview.dependencies.length === 0 ? null : <Lines items={preview.dependencies.map((edge) => `${edge.from} needs ${edge.to}`)} />}
        </Field>
      ) : (
        <Field label="Its tickets there">
          <span className="ew-mono">{held.keys.join(', ') || 'none found under this request'}</span>
        </Field>
      )}
      {held === null ? <Field label="Plan check">{validationText(preview)}</Field> : null}
      <Field label="Asked by">
        {preview.source.projectName} · epic &quot;{preview.source.epicTitle}&quot; ({preview.source.epicStatus}) · Sprint {preview.source.sprintOrdinal ?? '?'} report revision{' '}
        {preview.source.reportRevision} · {preview.experimentId}
        <span className="field-hint">This project&apos;s epic, runs, reports and scores stay exactly as they are.</span>
      </Field>
      {preview.key === null ? null : (
        <Field label="Request key">
          <span className="ew-mono">{preview.key}</span>
        </Field>
      )}
    </dl>
  )
}

function StateLine({ preview }: { preview: CrossRepoCorrectionPreview }): JSX.Element {
  const view = stateView(preview)
  return (
    <div role="group" aria-label="Where it stands">
      <p>
        <span className={`ew-pill ew-tone-${view.tone}`}>{view.label}</span> {view.meaning}
      </p>
      {preview.problems.length === 0 ? null : <Lines items={preview.problems} />}
      <ol className="cp-notes" aria-label="Next steps">
        {preview.nextSteps.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ol>
    </div>
  )
}

/**
 * Opens the epic the target holds, in its own folder, with that project's normal controls; only through a checkout of
 * the very project holding it (`openBlock`).
 */
function OpenTarget(props: { preview: CrossRepoCorrectionPreview; open: Open; busy: boolean }): JSX.Element | null {
  const held = heldEpic(props.preview)
  const { path, projectName } = props.preview.target
  if (held === null || props.open === null) return null
  const open = props.open
  const block = openBlock(props.preview, held)
  return (
    <button
      type="button"
      className="btn btn-primary"
      disabled={block !== null}
      title={block ?? `Opens epic ${held.epicId} in ${path ?? ''}`}
      onClick={() => (block === null && path !== null ? open(path, held.epicId) : undefined)}
    >
      Open &quot;{held.title}&quot; in {block === null ? (projectName ?? 'the Dark Mechanicus source') : 'the Dark Mechanicus source'}
      {held.saved ? ' to follow its runs and checkpoints' : ' to review, Save and start it'}
    </button>
  )
}

function MainButton(props: { preview: CrossRepoCorrectionPreview; state: CrossRepoPanelState; actions: CrossRepoPanelActions }): JSX.Element | null {
  const { preview, state, actions } = props
  const action = mainAction(preview)
  if (action === null) return null
  const block = actionBlock(preview, action, state.busy !== null)
  const press = (): void => (action.kind === 'recreate' && !state.confirmRecreate ? actions.askRecreate(true) : actions.run(action))
  const label = action.kind === 'recreate' && state.confirmRecreate ? `Yes: ${action.label}` : action.label
  return (
    <>
      <button type="button" className="btn btn-primary" disabled={block !== null} title={block ?? undefined} onClick={press}>
        {state.busy ?? label}
      </button>
      {action.kind === 'recreate' && state.confirmRecreate ? (
        <span className="field-hint" role="alert">
          A second epic is made in the chosen checkout; the one reached before stays wherever it is.{' '}
          <button type="button" className="sc-link" onClick={() => actions.askRecreate(false)}>
            Cancel
          </button>
        </span>
      ) : null}
    </>
  )
}

function PanelControls(props: { preview: CrossRepoCorrectionPreview; state: CrossRepoPanelState; actions: CrossRepoPanelActions; open: Open }): JSX.Element {
  const { preview, state, actions } = props
  const link = preview.link
  const busy = state.busy !== null
  const pending = link?.state === 'pending' ? link.key : null
  const linked = link?.state === 'linked' ? link.key : null
  return (
    <div className="cp-plan-actions">
      <MainButton preview={preview} state={state} actions={actions} />
      <OpenTarget preview={preview} open={props.open} busy={busy} />
      {pending === null ? null : (
        <button type="button" className="btn" disabled={busy} onClick={() => actions.withdraw(pending, false)}>
          Withdraw the request
        </button>
      )}
      {linked === null ? null : (
        <button type="button" className="btn" disabled={busy} onClick={() => actions.collect(linked)}>
          Bring back its grades
        </button>
      )}
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={actions.refresh}>
        Check again
      </button>
    </div>
  )
}

function OutcomeNote(props: { outcome: OutcomeView; state: CrossRepoPanelState; actions: CrossRepoPanelActions }): JSX.Element {
  const { outcome, state, actions } = props
  const key = state.unverifiedKey
  const retryable = outcome.retryable === null ? null : outcome.retryable ? 'Retryable: yes' : 'Retryable: no'
  return (
    <section className="cp-plan-result" role="status" aria-label="What the last request did">
      <p>
        <span className={`ew-pill ew-tone-${outcome.tone}`}>{outcome.heading}</span> {retryable === null ? null : <span className="ew-chip">{retryable}</span>}
      </p>
      <Lines items={outcome.lines} />
      <div className="cp-plan-actions">
        {key === null ? null : (
          <button type="button" className="btn btn-danger" disabled={state.busy !== null} onClick={() => actions.withdraw(key, true)}>
            Withdraw anyway, without checking the target
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={actions.dismiss}>
          Dismiss
        </button>
      </div>
    </section>
  )
}

/** What the correction epic's runs graded, as last brought back: the grades a result may cite. */
function CarriedGrades(props: { link: CrossRepoCorrectionLinkView; experiment: RetroExperiment }): JSX.Element | null {
  const results = props.link.results
  if (results === null) return null
  const unit = props.experiment.baseline.unit
  const landed = results.tickets.filter((ticket) => ticket.role === 'work')
  return (
    <Field label="Its grades">
      <span className="field-hint">
        Brought back {results.readAt} from &quot;{results.epicTitle}&quot; ({results.epicId}). Work tickets accepted:{' '}
        {landed.filter((ticket) => ticket.acceptedAt !== null).length} of {landed.length}.
      </span>
      {results.grades.length === 0 ? (
        <p className="ew-muted">No frozen {props.experiment.source.subject.level} grade yet: its runs have not reached a checkpoint report.</p>
      ) : (
        <Lines
          items={results.grades.map(
            (grade) =>
              `${props.experiment.baseline.measure} ${gradeValue(grade, unit)} · ${grade.subject.level} grade of report ${grade.reportId} revision ${grade.reportRevision} · window ${grade.from ?? 'no dispatch'} to ${grade.to} · cite { reportId: ${grade.reportId}, assessmentId: ${grade.assessmentId} }`
          )}
        />
      )}
    </Field>
  )
}

/** Each result read from that epic, before and after, each side linking to where it was graded. */
function BeforeAfter(props: { read: ExperimentView | null; open: Open; preview: CrossRepoCorrectionPreview }): JSX.Element | null {
  const rows = crossRepoResults(props.read)
  const path = props.preview.target.path
  const open = props.open
  if (rows.length === 0) return null
  return (
    <Field label="Before / after">
      <ul>
        {rows.map((row) => (
          <li key={row.label}>
            <span className="ew-chip">{row.label}</span> Before: {row.before} → After: {row.after}{' '}
            {open === null || path === null || props.preview.target.projectId !== row.projectId ? null : (
              <button type="button" className="sc-link" onClick={() => open(path, row.epicId)}>
                Open the correction epic
              </button>
            )}
          </li>
        ))}
      </ul>
    </Field>
  )
}

function PanelBody(props: { state: CrossRepoPanelState; actions: CrossRepoPanelActions; panel: CrossRepoCorrectionProps }): ReactNode {
  const { state, actions, panel } = props
  if (state.preview.status === 'loading') return <p className="ew-muted">Reading what it would write…</p>
  if (state.preview.status === 'error') {
    return (
      <>
        <p role="alert">The preview could not be read: {state.preview.message}</p>
        <button type="button" className="btn btn-ghost" disabled={state.busy !== null} onClick={actions.refresh}>
          Check again
        </button>
      </>
    )
  }
  const preview = state.preview.value
  return (
    <>
      <StateLine preview={preview} />
      <ProposedWork preview={preview} />
      <PanelControls preview={preview} state={state} actions={actions} open={panel.openFolderEpic} />
      <dl className="cp-experiment-fields">
        {state.link === null ? null : <CarriedGrades link={state.link} experiment={panel.experiment} />}
        <BeforeAfter read={panel.read} open={panel.openFolderEpic} preview={preview} />
      </dl>
    </>
  )
}

export function CrossRepoCorrection(props: CrossRepoCorrectionProps): JSX.Element {
  const [state, actions] = useCrossRepoCorrection({ folder: props.folder, reportId: props.reportId, experimentId: props.experiment.id, folderChanged: props.folderChanged }, props.version)
  return (
    <section className="cp-xr" aria-label={`Dark Mechanicus source: ${props.experiment.id}`}>
      <h4 className="ew-eyebrow">DARK MECHANICUS SOURCE · NOTHING IS WRITTEN UNTIL YOU CREATE IT</h4>
      <TargetChoice state={state} actions={actions} folder={props.folder} />
      {state.outcome === null ? null : <OutcomeNote outcome={state.outcome} state={state} actions={actions} />}
      <PanelBody state={state} actions={actions} panel={props} />
    </section>
  )
}
