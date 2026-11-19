/**
 * Corrective work: the selected experiments of a sprint retro (`./experiments.ts`) turned into reviewable DRAFT work in
 * the same repository. For an unfinished epic the work goes into a future sprint of its draft (or a sprint appended
 * after the last one); for a completed epic it goes into a new follow-up epic linked to it (`EpicProvenance`). Nothing
 * is saved, adopted, started, approved or retried on anyone's behalf: the person reviews the draft and uses the normal
 * Save, adopt, run and checkpoint controls. Cross-repository destinations are created elsewhere.
 *
 * Every created ticket carries a stable correction marker (a `doc` reference naming the experiment's source report,
 * the experiment and the target, with the request's payload hash), so a repeat finds the work by identity, never by
 * title: renaming a ticket or the epic does not create it again, and a different payload for the same experiment is
 * refused.
 */
import type { TicketSize } from './bundle'
import type { ImprovementConcern, RetroExperimentInput } from './experiments'
import type { ValidationReport } from './views'

/**
 * Where the corrective work goes:
 * - `new_sprint`: a sprint appended after the last sprint of an unfinished epic's draft (the default there);
 * - `sprint`: an existing future sprint of that draft (after every sprint a run has reached or the report covers);
 * - `follow_up_epic`: a new epic linked to a completed one (the only target there), titled `title` when given.
 */
type CorrectionTargetInput = { kind: 'new_sprint' } | { kind: 'sprint'; sprintId: string } | { kind: 'follow_up_epic'; title?: string }

export type CorrectionTargetKind = CorrectionTargetInput['kind']

/** One proposed work item of a selected experiment: `proposedWork[index]`. */
interface CorrectionWorkRef {
  experimentId: string
  index: number
}

/** A prerequisite of a corrective ticket: another item of this request, or a ticket of the target draft (id or key). */
export type CorrectionPrerequisite = { work: CorrectionWorkRef } | { ticket: string }

/**
 * The person's edits to one generated ticket before it is created. Size stays the experiment's (restate the experiment
 * to change it); an edited body must still say what changes.
 */
export interface CorrectionWorkEdit extends CorrectionWorkRef {
  title?: string
  body?: string
  acceptanceCriteria?: string[]
  dependsOn?: CorrectionPrerequisite[]
}

/** What a preview or a creation is asked for. */
export interface CorrectionsInput {
  /** The sprint report revision whose retro holds the experiments: the latest revision of its sprint. */
  reportId: string
  /** The selected experiments (`xp_…`), each at most once. */
  experimentIds: string[]
  /** Defaults to `new_sprint` for an unfinished epic and `follow_up_epic` for a completed one. */
  target?: CorrectionTargetInput
  edits?: CorrectionWorkEdit[]
  /** Adds the Fireguard ticket that grades the corrective tests (default true). */
  fireguard?: boolean
}

export interface CreateCorrectionsInput extends CorrectionsInput {
  /**
   * The draft revision the preview read (`draftRevision`); a newer draft is a `conflict`. Null, as a preview that found
   * no draft reads it, expects none: a draft opened since is a `conflict` too.
   */
  expectedDraftRevision?: number | null
}

/**
 * Where a selected experiment stands:
 * - `ready`: fully specified, and creating it adds its tickets;
 * - `created`: already materialized under the same payload, so a repeat adds nothing;
 * - `conflict`: already materialized under another payload or target (a different request for the same experiment);
 * - `blocked`: not creatable as it is (unsized or vague work, finished, another repository); `problems` says why.
 */
type CorrectionExperimentState = 'ready' | 'created' | 'conflict' | 'blocked'

/** Where an experiment's corrective work already is: the epic and the draft or saved revision that holds its marker. */
export interface CorrectionExistingView {
  /** The idempotency key it was created under. */
  key: string
  payloadHash: string
  epicId: string
  /** `draft`: the epic's draft holds it; `revision`: only a saved revision does. */
  holder: 'draft' | 'revision'
  revisionNumber: number | null
  ticketIds: string[]
  keys: string[]
}

/** A blocked experiment as its sprint's next report revision restates it: by id, from its original source. */
export type CorrectionRestatement = Omit<RetroExperimentInput, 'concern'> & { concern?: ImprovementConcern }

export interface CorrectionExperimentView {
  experimentId: string
  concern: ImprovementConcern | null
  /**
   * The stable idempotency key: `<source report>/<experiment>/<target>`, where the source report is the report whose
   * frozen scorecard the experiment was drawn from (kept by every restatement) and the target is `epic:<id>` (a future
   * sprint of the unfinished epic) or `follow-up:<source epic id>`. Titles never take part.
   */
  key: string
  /** The content hash of what this request asks for the experiment (its definition, target and edits). */
  payloadHash: string
  state: CorrectionExperimentState
  problems: string[]
  /** For a `blocked` experiment whose work is unsized or vague: the restatement to fix and resubmit; else null. */
  restatement: CorrectionRestatement | null
  existing: CorrectionExistingView | null
}

type CorrectionTicketRole = 'work' | 'fireguard' | 'acceptance'

export interface CorrectionCriterionView {
  id: string
  text: string
  /** The ref of the generated ticket an acceptance criterion covers, or the key of an existing one. */
  covers: string | null
}

/** A ticket the corrective work adds (or, for the acceptance node, updates), before or after creation. */
export interface CorrectionTicketView {
  /** `<experiment id>#<index>` for work, `fireguard` (`fireguard:<repository>` in a folder of repositories), or `acceptance`. */
  ref: string
  role: CorrectionTicketRole
  experimentId: string | null
  workIndex: number | null
  /** The display key (planned in a preview: other edits may take it first; final after creation). */
  key: string
  /** Null in a preview. */
  ticketId: string | null
  /** True for the target sprint's acceptance node when it already existed (its criteria gain covers). */
  existing: boolean
  title: string
  body: string
  size: TicketSize | null
  tags: string[]
  repo: string | null
  acceptanceCriteria: CorrectionCriterionView[]
  /** Refs of generated tickets or keys of existing tickets this one requires. */
  dependsOn: string[]
}

interface CorrectionTargetView {
  kind: CorrectionTargetKind
  /** Null in a preview of a follow-up epic (it does not exist yet). */
  epicId: string | null
  epicTitle: string
  /** Null in a preview of a sprint still to be appended. */
  sprintId: string | null
  sprintOrdinal: number
  sprintGoal: string
  /** For an unfinished epic: corrections go after this sprint (the report's, or the furthest an active run reached). */
  afterOrdinal: number | null
}

interface CorrectionSourceView {
  epicId: string
  epicTitle: string
  epicStatus: string
  runId: string
  sprintId: string
  sprintOrdinal: number | null
  reportId: string
  reportRevision: number
}

/** A preview of the corrective work, or what a creation did (`changed`). */
export interface CorrectionPlanView {
  source: CorrectionSourceView
  target: CorrectionTargetView
  experiments: CorrectionExperimentView[]
  /** Every epic that already holds work of the selected experiments (`created`), with those experiments. */
  createdIn: { epicId: string; experimentIds: string[] }[]
  /** The tickets the `ready` experiments add, a Fireguard ticket per repository and the acceptance node with its covers. */
  tickets: CorrectionTicketView[]
  dependencies: { from: string; to: string }[]
  /** The target draft's revision: as read (preview) or as written (creation); null for a follow-up epic still to be created. */
  draftRevision: number | null
  /** The target draft once the work is added. */
  validation: ValidationReport
  /** What the person does next; nothing here is done on their behalf. */
  nextSteps: string[]
  notes: string[]
}

export interface CorrectionsResultView extends CorrectionPlanView {
  /** False when every selected experiment was already created: nothing was written. */
  changed: boolean
}
