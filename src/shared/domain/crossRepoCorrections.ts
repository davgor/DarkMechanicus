/**
 * Corrective work a sprint retro asks of the Dark Mechanicus source (an experiment whose destination is
 * `darkmechanicus_source`), created in that other project as a target-owned DRAFT epic by the desktop broker
 * (`src/main/desktop/crossRepoCorrections.ts`), never through MCP or the command line.
 *
 * Three records, kept apart:
 * - the **provenance** on the target epic (`CorrectionProvenance` in `./bundle`): portable, identities and hashes only;
 * - the **receipt** in the source project (`CrossRepoCorrectionLinkView`): machine-local, written `pending` with the fully
 *   specified draft before the target is written and `linked` once the target holds it, so an interrupted request is
 *   finished by a retry;
 * - the **local destination mapping** (which checkout on this machine serves the target): only the source checkout
 *   association (`../desktop/sourceCheckout.ts`) holds it; no receipt or provenance names a path.
 *
 * The target is one epic per experiment and target project, found again by its key, so a retry after any partial
 * failure recovers the same epic and tickets, and a different payload under the same key is refused. Nothing is saved,
 * started, adopted or approved on anyone's behalf, in either project.
 */
import type { CorrectionProvenance } from './bundle'
import type { CorrectionTicketView, CorrectionWorkEdit } from './corrections'
import type { DomainErrorShape } from './errors'
import type { ImprovementConcern } from './experiments'
import type { GradeSubject } from './space'
import type { WorkStatus } from './status'
import type { ValidationReport } from './views'

/** One experiment of a sprint report revision, aimed at the Dark Mechanicus source. */
export interface CrossRepoCorrectionInput {
  /** The latest revision of the sprint report whose retro holds the experiment. */
  reportId: string
  experimentId: string
  /** The target epic's title (default: from the source project and the experiment's issue). */
  title?: string
  /** Edits of the experiment's own work items; a prerequisite names another of its work items (the target epic is new). */
  edits?: CorrectionWorkEdit[]
  /** Adds the Fireguard ticket that grades the corrective tests (default true). */
  fireguard?: boolean
}

export interface CreateCrossRepoCorrectionInput extends CrossRepoCorrectionInput {
  /** The target project the preview showed (required): a different chosen checkout now is a `conflict`, and nothing is written. */
  expectedTargetProjectId: string
  /**
   * Make a new epic when the chosen checkout no longer holds the one this request reached before (deleted there, or
   * another checkout of the project holds it). Without it that case is a `conflict` (`problem: target_missing`).
   */
  recreate?: boolean
}

/** The target epic as the target project holds it (created by this request or an earlier one under the same key). */
export interface CrossRepoTargetEpicView {
  projectId: string
  epicId: string
  epicTitle: string
  /** The sprint holding the corrective tickets. */
  sprintId: string
  /** The corrective work and Fireguard tickets, in plan order. */
  ticketIds: string[]
  keys: string[]
  /** The draft's revision as read; null once the draft was discarded or saved away. */
  draftRevision: number | null
  /** The epic's status there as read (backlog until its plan is saved and run there, then in progress, completed…). */
  status: WorkStatus
  /** Whether the epic has a saved plan there (it was saved with that project's own Save). */
  saved: boolean
  /** True only in the answer of the call that created it; false when the target already held it, and in stored receipts. */
  created: boolean
}

/** Which step of a request failed: writing the target, or recording the link in the source afterwards. */
export type CrossRepoCorrectionStep = 'target' | 'link'

/**
 * The source project's receipt of one request. `pending`: requested, and the target has not confirmed it (a retry
 * delivers the stored draft; `target` is set when the target accepted it but the link failed, and later deliveries
 * expect that epic); `linked`: the target holds it as `target`. Machine-local and path-free.
 */
export interface CrossRepoCorrectionLinkView {
  key: string
  experimentId: string
  /** The report revision the request was first made from. */
  reportId: string
  sourceEpicId: string
  targetProjectId: string
  payloadHash: string
  state: 'pending' | 'linked'
  target: CrossRepoTargetEpicView | null
  /** Deliveries tried, successful or not. */
  attempts: number
  /** The last failed step, with its error code (and the checkout problem when the target was unavailable); no message or path. */
  lastError: { step: CrossRepoCorrectionStep; code: string; problem: string | null; at: string } | null
  createdAt: string
  updatedAt: string
  linkedAt: string | null
  /** What a linked request last brought back from the target epic for measuring the experiment; null before. */
  results: CrossRepoResultsView | null
}

/**
 * A frozen grade of the target epic at the experiment's baseline level, as the receipt last brought it back: what the
 * experiment's result may cite (`{ reportId, assessmentId }`), with the experiment's baseline measure read from it.
 */
export interface CrossRepoCarriedGrade {
  reportId: string
  reportRevision: number
  runId: string
  sprintId: string
  assessmentId: string
  subject: GradeSubject
  /** The window it measures: its scope's first dispatch to the scorecard's cutoff. */
  from: string | null
  to: string
  /** The baseline measure in it; null when it was not measured. */
  value: number | null
  state: 'observed' | 'estimated' | 'missing'
}

/** What a linked request last brought back from the target epic: its corrective tickets and frozen grades. */
export interface CrossRepoResultsView {
  readAt: string
  epicId: string
  epicTitle: string
  /** Its corrective tickets; the work has landed once every work ticket is accepted. */
  tickets: { key: string; title: string; role: 'work' | 'fireguard'; acceptedAt: string | null }[]
  grades: CrossRepoCarriedGrade[]
}

/**
 * A withdrawn request: its receipt as it was, and whether the target was checked (`verified`). Unverified, the target
 * may hold the work after all (a request with the same payload links to it; another checkout could get a second epic).
 */
export interface CrossRepoWithdrawalView {
  withdrawn: CrossRepoCorrectionLinkView
  verified: boolean
}

/** Withdrawing a pending request; `confirmUnverified` is required when the target cannot be checked. */
export interface CrossRepoWithdrawInput {
  key: string
  confirmUnverified?: boolean
}

/** The chosen Dark Mechanicus checkout as the broker sees it now. */
export interface CrossRepoTargetAvailability {
  /** `none`: no checkout is chosen; `unavailable`: see `problem`. */
  status: 'available' | 'unavailable' | 'none'
  projectId: string | null
  projectName: string | null
  /**
   * Where this machine finds it: the folder the broker writes to (canonical, a tracked folder) and the same path with
   * the home directory abbreviated. Machine-local: shown to the person, never kept in a receipt or provenance.
   */
  path: string | null
  displayPath: string | null
  /** A source checkout problem (`missing`, `relocated`, `project_mismatch`, …) or the error code that made it unusable. */
  problem: string | null
  message: string | null
  recovery: string | null
}

/**
 * Where the experiment stands for the chosen target:
 * - `ready`: creating it writes the target epic;
 * - `pending`: requested before and not confirmed by the target (creating it again, or retrying, finishes it);
 * - `created`: the target holds it (the source records the link, or creating records it without writing the target);
 * - `conflict`: requested or created before with another payload, or for another target project;
 * - `blocked`: not creatable as it is (`problems` says why; a pending request that is blocked is withdrawn, not retried).
 */
export type CrossRepoCorrectionState = 'ready' | 'pending' | 'created' | 'conflict' | 'blocked'

/** What creating the experiment's corrective work in the Dark Mechanicus source would write. Nothing is written. */
export interface CrossRepoCorrectionPreview {
  source: {
    projectId: string
    projectName: string
    epicId: string
    epicTitle: string
    epicStatus: string
    runId: string
    sprintId: string
    sprintOrdinal: number | null
    reportId: string
    reportRevision: number
  }
  experimentId: string
  concern: ImprovementConcern | null
  state: CrossRepoCorrectionState
  problems: string[]
  target: CrossRepoTargetAvailability
  /** Null until a checkout is chosen (the key names the target project). */
  key: string | null
  payloadHash: string | null
  /** The portable provenance the target epic will carry (null until a checkout is chosen). */
  provenance: CorrectionProvenance | null
  epic: { title: string; intent: string; successCriteria: string[] }
  /** The tickets the target epic's draft will hold; keys are planned (placeholders while the target is unavailable). */
  tickets: CorrectionTicketView[]
  dependencies: { from: string; to: string }[]
  /** The target draft once the work is added, validated against the target project (null while it is unavailable). */
  validation: ValidationReport | null
  /** The source receipt of this experiment, if it was requested before (for any target). */
  link: CrossRepoCorrectionLinkView | null
  /** The target epic already holding it, read from the target (null when none or the target is unavailable). */
  existing: CrossRepoTargetEpicView | null
  /** The chosen checkout does not hold the epic this request reached before: creating needs `recreate` (or the other checkout). */
  needsRecreate: boolean
  nextSteps: string[]
}

/**
 * What a create or retry did:
 * - `linked`: the target holds the epic and the source receipt names it (with `failure` when the chosen checkout could
 *   not be read to confirm it this time: the receipt is as it was);
 * - `target_created`: the target holds the epic but recording the link in the source failed (retry to record it);
 * - `pending`: the target was not written (unavailable, another project now, or refused); the receipt keeps the request.
 * A request the target refused for good (another payload under its key, a draft it does not accept) as this very call
 * wrote its receipt leaves no receipt: the call answers with that error instead.
 */
export interface CrossRepoCorrectionResult {
  progress: 'linked' | 'target_created' | 'pending'
  /** Whether this call wrote anything (a new receipt, the target epic, or the link). */
  changed: boolean
  link: CrossRepoCorrectionLinkView
  target: CrossRepoTargetEpicView | null
  /** The failed step; `retryable` is false when repeating the same request cannot succeed (withdraw it instead). */
  failure: { step: CrossRepoCorrectionStep; error: DomainErrorShape; retryable: boolean } | null
  nextSteps: string[]
}
