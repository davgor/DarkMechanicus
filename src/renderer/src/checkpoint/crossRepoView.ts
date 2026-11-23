/**
 * What the Dark Mechanicus source panel of an experiment (`CrossRepoCorrection`) says, as plain values: where the work
 * would go (the chosen checkout, its project and the folder on this machine), what the preview found, what the last
 * request did and which controls apply. Pure: the component only renders these.
 */
import type { TrackedFolderView } from '../../../shared/desktop/api'
import type { SourceCheckoutChoice, SourceCheckoutView } from '../../../shared/desktop/sourceCheckout'
import type {
  CrossRepoCorrectionLinkView,
  CrossRepoCorrectionPreview,
  CrossRepoCorrectionResult,
  CrossRepoCorrectionState,
  CrossRepoTargetAvailability,
  CrossRepoWithdrawalView
} from '../../../shared/domain/crossRepoCorrections'
import type { DomainErrorShape } from '../../../shared/domain/errors'
import type { ExperimentView } from '../../../shared/domain/experiments'
import { numberText } from './retroView'

type Tone = 'accepted' | 'neutral' | 'blocked' | 'attention'

/** The destination as the person reads it: always the project and the exact folder on this machine. */
interface DestinationView {
  /** "Dark Mechanicus (pj_…)", or "No checkout chosen". */
  project: string
  /** The folder the work is written to; null when none is chosen. */
  path: string | null
  status: { label: string; tone: Tone }
  /** What is wrong and what to do about it; empty when available. */
  problems: string[]
}

const STATUS: Record<CrossRepoTargetAvailability['status'], { label: string; tone: Tone }> = {
  available: { label: 'Available', tone: 'accepted' },
  unavailable: { label: 'Unavailable', tone: 'blocked' },
  none: { label: 'Not chosen', tone: 'attention' }
}

export function destinationView(target: CrossRepoTargetAvailability): DestinationView {
  const project = target.projectId === null ? 'No checkout chosen' : `${target.projectName ?? 'Dark Mechanicus'} (${target.projectId})`
  return {
    project,
    path: target.path,
    status: STATUS[target.status],
    problems: [target.message, target.recovery].flatMap((line) => (line === null || target.status === 'available' ? [] : [line]))
  }
}

/** The checkout as `window.dm.sourceCheckout` sees it, in the same terms (before any preview is read). */
export function checkoutTarget(view: SourceCheckoutView): CrossRepoTargetAvailability {
  const path = view.local === null ? null : view.local.projectPath ?? view.local.path
  return {
    status: view.status,
    projectId: view.target?.projectId ?? null,
    projectName: view.target?.projectName ?? null,
    path,
    displayPath: view.local?.displayPath ?? null,
    problem: view.problem,
    message: view.message,
    recovery: view.recovery
  }
}

const STATES: Record<CrossRepoCorrectionState, { label: string; tone: Tone; meaning: string }> = {
  ready: { label: 'Ready', tone: 'neutral', meaning: 'Creating it writes a new epic in the Dark Mechanicus source; nothing has been written yet.' },
  pending: { label: 'Pending', tone: 'attention', meaning: 'Requested here, not confirmed by the Dark Mechanicus source yet: retry it to finish it, or withdraw it.' },
  created: { label: 'Created', tone: 'accepted', meaning: 'The Dark Mechanicus source holds this work.' },
  conflict: { label: 'Conflict', tone: 'blocked', meaning: 'Requested before with another payload or for another project: nothing more is created.' },
  blocked: { label: 'Blocked', tone: 'blocked', meaning: 'Not creatable as it is.' }
}

export function stateView(preview: CrossRepoCorrectionPreview): { label: string; tone: Tone; meaning: string } {
  if (preview.needsRecreate) {
    return { label: 'Epic missing', tone: 'blocked', meaning: 'The chosen checkout no longer holds the epic this request reached before.' }
  }
  const linked = preview.link?.state === 'linked'
  if (preview.state === 'created' && !linked) {
    return { ...STATES.created, meaning: 'The Dark Mechanicus source already holds this work, but this project has no link to it: create it to record the link (nothing new is written there).' }
  }
  return STATES[preview.state]
}

/** Which request the main button makes, and how it reads; null when nothing can be created as it stands. */
export type MainAction = { kind: 'create' | 'record' | 'recreate' | 'retry'; label: string } | null

export function mainAction(preview: CrossRepoCorrectionPreview): MainAction {
  const project = preview.target.projectName ?? 'the Dark Mechanicus source'
  if (preview.needsRecreate) return { kind: 'recreate', label: `Create a new epic in ${project}` }
  if (preview.state === 'pending') return { kind: 'retry', label: 'Retry the request' }
  if (preview.state === 'created') return preview.link?.state === 'linked' ? null : { kind: 'record', label: 'Record the link here' }
  if (preview.state !== 'ready') return null
  return { kind: 'create', label: preview.target.status === 'available' ? `Create the epic in ${project}` : 'Save the request (pending)' }
}

/** Why the main button cannot be pressed now; null when it can. */
export function actionBlock(preview: CrossRepoCorrectionPreview, action: MainAction, busy: boolean): string | null {
  if (busy) return 'A request is on its way: wait for its answer.'
  if (action === null) return null
  if (preview.target.projectId === null) return 'Choose your Dark Mechanicus checkout first: the request names its project.'
  if (action.kind === 'recreate' || action.kind === 'record') {
    return preview.target.status === 'available' ? null : 'The chosen checkout must be available to check what it holds.'
  }
  return null
}

interface HeldEpicView {
  projectId: string
  epicId: string
  title: string
  /** The keys its tickets actually have there (not the re-planned keys of a new draft). */
  keys: string[]
  /** Read from the target now (`existing`); false when only the receipt names it. */
  current: boolean
  /** How it stands there, in words: an unsaved draft, or a saved plan with its status. */
  standing: string
  saved: boolean
}

/** The epic the target holds for this request (as read now, else as the receipt last named it). */
export function heldEpic(preview: CrossRepoCorrectionPreview): HeldEpicView | null {
  const held = preview.existing ?? preview.link?.target ?? null
  if (held === null) return null
  const current = preview.existing !== null
  // A receipt written before the epic's status was recorded names neither; it is shown as last linked.
  const saved = held.saved === true
  const standing = saved ? `saved plan, ${held.status.replace('_', ' ')}` : held.draftRevision === null ? 'no open draft' : `unsaved draft (revision ${held.draftRevision})`
  return { projectId: held.projectId, epicId: held.epicId, title: held.epicTitle, keys: held.keys, current, standing: current ? standing : `${standing}, as last linked`, saved }
}

/**
 * Why the held epic cannot be opened through the chosen checkout, or null when it can: the checkout must be available,
 * have a path, and be of the very project the epic (and the request's link) belongs to, so Open never navigates
 * another project's checkout to an epic id it does not hold.
 */
export function openBlock(preview: CrossRepoCorrectionPreview, held: { projectId: string }): string | null {
  const { target, link } = preview
  if (target.status !== 'available' || target.path === null) return 'The chosen checkout is unavailable: make it available to open the epic there.'
  if (target.projectId !== held.projectId || (link !== null && link.targetProjectId !== target.projectId)) {
    return `The chosen checkout is project ${target.projectId ?? 'unknown'}, not ${link?.targetProjectId ?? held.projectId} that holds this epic: choose that project's checkout to open it.`
  }
  return null
}

/** The last request's answer as the person reads it. */
export interface OutcomeView {
  heading: string
  tone: Tone
  lines: string[]
  /** Whether repeating the same request can succeed; null when nothing failed. */
  retryable: boolean | null
}

const PROGRESS: Record<CrossRepoCorrectionResult['progress'], { heading: string; tone: Tone }> = {
  linked: { heading: 'Created in the Dark Mechanicus source and linked here', tone: 'accepted' },
  target_created: { heading: 'Created in the Dark Mechanicus source; recording the link here failed', tone: 'attention' },
  pending: { heading: 'Kept here as a pending request; the Dark Mechanicus source was not written', tone: 'attention' }
}

function failureLines(failure: CrossRepoCorrectionResult['failure']): string[] {
  if (failure === null) return []
  const step = failure.step === 'target' ? 'Writing the Dark Mechanicus source' : 'Recording the link here'
  const again = failure.retryable ? 'Retrying can finish it.' : 'Retrying the same request cannot change this: withdraw it (or change what blocks it).'
  return [`${step} failed (${failure.error.code}): ${failure.error.message}`, again]
}

export function resultOutcome(result: CrossRepoCorrectionResult): OutcomeView {
  const base = PROGRESS[result.progress]
  const confirmed = result.progress === 'linked' && result.failure !== null
  const heading = confirmed ? 'Linked before; the chosen checkout could not confirm it this time' : result.changed || result.progress !== 'linked' ? base.heading : 'Already linked: nothing new was written'
  return {
    heading,
    tone: result.failure === null ? base.tone : 'attention',
    lines: [...failureLines(result.failure), ...result.nextSteps],
    retryable: result.failure === null ? null : result.failure.retryable
  }
}

export function withdrawalOutcome(view: CrossRepoWithdrawalView): OutcomeView {
  return view.verified
    ? { heading: 'Withdrawn: the Dark Mechanicus source was checked and holds none of it', tone: 'neutral', lines: ['The experiment can be requested again.'], retryable: null }
    : {
        heading: 'Withdrawn without checking the Dark Mechanicus source',
        tone: 'attention',
        lines: [
          'Its checkout could not be read, so it may hold this work after all: a request with the same payload links to that epic again, and another checkout of the project could get a second one.'
        ],
        retryable: null
      }
}

export function refusalOutcome(error: DomainErrorShape, what: string): OutcomeView {
  return { heading: `${what} refused (${error.code})`, tone: 'blocked', lines: [error.message], retryable: null }
}

/** Whether a refused withdrawal only lacks the person's confirmation that the target cannot be checked. */
export function needsUnverifiedConfirmation(error: DomainErrorShape): boolean {
  return error.code === 'conflict' && error.details?.problem === 'unverified'
}

export function choiceOutcome(choice: SourceCheckoutChoice): OutcomeView | null {
  switch (choice.outcome) {
    case 'cancelled':
      return null
    case 'associated':
      return { heading: `Chosen: ${choice.checkout.target?.projectName ?? 'Dark Mechanicus'} at ${choice.folder.path}`, tone: 'accepted', lines: choice.added ? ['The folder was also added to your folder list.'] : [], retryable: null }
    case 'needs_initialization':
      return { heading: 'Not set up yet', tone: 'attention', lines: [choice.message, choice.recovery, `It is in your folder list as ${choice.folder.path}.`], retryable: null }
    default:
      return {
        heading: 'Not usable as the Dark Mechanicus checkout',
        tone: 'blocked',
        lines: [choice.message, choice.recovery, ...(choice.folder === undefined ? [] : [`It was added to your folder list as ${choice.folder.path}.`])],
        retryable: null
      }
  }
}

/** The tracked folders the person may choose among, this folder first; each shows its full path. */
export function targetOptions(folders: TrackedFolderView[], sourceFolder: string): { path: string; label: string }[] {
  const usable = folders.filter((folder) => folder.initialized && folder.available)
  const ordered = [...usable.filter((folder) => folder.path === sourceFolder), ...usable.filter((folder) => folder.path !== sourceFolder)]
  return ordered.map((folder) => ({ path: folder.path, label: folder.path === sourceFolder ? `This folder (${folder.name})` : folder.name }))
}

/** "1,200 milliseconds (observed)". */
export function gradeValue(grade: { value: number | null; state: string }, unit: string): string {
  return grade.value === null ? `no value (${grade.state})` : `${numberText(grade.value)} ${unit} (${grade.state})`
}

/** The receipt of this experiment for the chosen target project, else its only one. */
export function experimentLink(links: CrossRepoCorrectionLinkView[], key: string | null): CrossRepoCorrectionLinkView | null {
  return links.find((link) => link.key === key) ?? links[0] ?? null
}

/** Results of the experiment read from another project's correction epic: the before/after pairs that link back here. */
export function crossRepoResults(read: ExperimentView | null): { label: string; epicId: string; projectId: string; before: string; after: string }[] {
  const outcome = read?.outcome
  if (outcome === undefined) return []
  const before = `${outcome.baseline.value === null ? 'no value' : numberText(outcome.baseline.value)} ${outcome.baseline.unit} (baseline, report ${outcome.baseline.assessment?.reportId ?? '?'} of this project)`
  return outcome.comparisons.flatMap((comparison) => {
    const carried = comparison.crossRepo
    if (carried === undefined) return []
    const after = `${comparison.after.value === null ? 'no value' : numberText(comparison.after.value)} ${comparison.after.unit} (report ${comparison.after.assessment?.reportId ?? '?'} of "${carried.epicTitle}")`
    return [{ label: `Result #${comparison.eventNumber} · ${comparison.classification.replaceAll('_', ' ')}`, epicId: carried.epicId, projectId: carried.projectId, before, after }]
  })
}
