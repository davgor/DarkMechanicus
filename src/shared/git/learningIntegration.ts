/** Learning-card guardrail integration contracts shared by main and the renderer. Renderer-safe: no Node imports. */
import type { VerifiedLearningManifest } from '../domain/kanban'

// ─── DM-948: prepare-only guardrail integration ───────────────────────────────────────────────────────────────────

/** Where one repository's guardrails should land: the canonical checkout and the epic/sprint target branch in it. */
export interface LearningIntegrationTargetInput {
  /** The child repository's name, or null for the root repository; matches the manifest's `repo`. */
  repository: string | null
  /** Absolute path of the canonical checkout's top level. Never switched, checked out or written by preparation. */
  checkout: string
  /** The local target branch (`sprint/x`, not `refs/heads/sprint/x`) the guardrail branch integrates onto. */
  branch: string
}

export interface PrepareLearningIntegrationRequest {
  /** The learning card (`kc_…`); names the per-card lock, owned worktrees and owned refs. */
  cardId: string
  /** The learning card attempt (`ka_…`) whose verified manifests are prepared; owns the per-card lock. */
  attemptId: string
  /** DM-938 `evidence.learning.manifests`: exactly one passed manifest per target repository. */
  manifests: readonly VerifiedLearningManifest[]
  targets: readonly LearningIntegrationTargetInput[]
}

/**
 * How the guardrail commit lands on the target: already contained (`noChange`), the target fast-forwards to it
 * (`fastForward`), or a merge commit made in an owned isolated worktree (`merge`).
 */
type PreparedTargetOutcome = 'noChange' | 'fastForward' | 'merge'

/** One repository's prepared result. Nothing in the canonical checkout has moved; `newHead` is held by `preparedRef`. */
export interface PreparedTarget {
  repository: string | null
  checkout: string
  /** The full target ref (`refs/heads/<branch>`) a later apply compares against `oldHead` before moving it. */
  targetRef: string
  /** The target branch head preparation was computed from. */
  oldHead: string
  /** The commit the target should point at after apply: `oldHead` (noChange), `sourceCommit` (fastForward) or the merge. */
  newHead: string
  outcome: PreparedTargetOutcome
  /** The isolated guardrail branch, its verified tip and the completed increment base it was rooted at. */
  source: { branch: string; commit: string; base: string }
  /** The owned ref (`refs/darkmechanicus/learning-prep/<cardId>/<repo|root>`) keeping `newHead` reachable. */
  preparedRef: string
}

/** A repository whose guardrail branch does not merge cleanly onto its target. */
export interface LearningIntegrationConflict {
  repository: string | null
  targetRef: string
  oldHead: string
  sourceCommit: string
  /** Repository-relative paths Git left unmerged, sorted. */
  files: string[]
  detail: string
}

/**
 * The outcome of preparation. `prepared`: every repository has a result held by its owned ref. `conflicted`: at
 * least one repository conflicts; every conflict is listed, no owned prepared ref is kept and nothing canonical moved.
 */
export type PreparedLearningIntegration =
  | { state: 'prepared'; cardId: string; attemptId: string; targets: PreparedTarget[] }
  | { state: 'conflicted'; cardId: string; attemptId: string; conflicts: LearningIntegrationConflict[] }

/** Why preparation, apply or recovery refused to start or stopped before changing what it reports. */
export type LearningIntegrationErrorCode =
  | 'invalid_request'
  | 'unsafe_path'
  | 'locked'
  | 'not_repository'
  | 'target_missing'
  | 'source_moved'
  | 'base_diverged'
  /** DM-949: the target is at neither the prepared `oldHead` nor a descendant of `newHead`, or its checkout left the branch. */
  | 'target_moved'
  /** DM-949: the recorded path is no longer the prepared repository (removed, rebound, or a clone without the owned identity). */
  | 'foreign_repository'
  /** DM-949: the owned prepared ref no longer holds `newHead` and the target does not contain it. */
  | 'not_prepared'
  /** DM-949: the checked-out target has staged, modified or colliding files that are not exactly either side of the transition. */
  | 'dirty_worktree'
  /** DM-949: cancelled or out of time; Git's actual state is left consistent and recovery continues from it. */
  | 'interrupted'

// ─── End of DM-948 ─────────────────────────────────────────────────────────────────────────────────────────────────

// ─── DM-949: canonical apply and recovery ─────────────────────────────────────────────────────────────────────────

/**
 * A prepared target with the owned identity of the repository it was prepared in: its absolute common Git folder
 * and a random token kept in an owned file there. A clone, even one holding the same objects and refs, has no such
 * file, so apply and recovery never write to a removed, rebound or foreign path.
 */
export interface PlannedLearningTarget extends PreparedTarget {
  identity: { commonDir: string; token: string }
}

/** What `persistPrepared` stores durably before the first canonical change, and what recovery resumes from. */
export interface LearningIntegrationPlan {
  cardId: string
  attemptId: string
  targets: PlannedLearningTarget[]
}

/** One completed (or recovered) target: the exact tuple its canonical target branch moved, or was found moved, by. */
export interface LearningIntegrationReceipt {
  repository: string | null
  oldHead: string
  newHead: string
}

interface LearningIntegrationCallbacks {
  /** Awaited after each completed or recovered target, in plan order; a rejection stops before the next target. */
  onApplied(receipt: LearningIntegrationReceipt): Promise<void>
  /** Stops before the next Git write; a running worktree update is never killed, and the call rejects once Git has exited. */
  signal?: AbortSignal
  /**
   * DM-952: when given, each target's canonical checkout must be clean before its canonical change. Ephemeral: main
   * derives it for this call (recovery derives it again) and it is never stored in the plan.
   */
  cleanCheckout?: CleanCheckoutRequirement
}

/**
 * DM-952: the one untracked path a clean checkout may hold: the current operation's portable record, written into the
 * registered root checkout by the repo-mode flush. Only main's operation-record binding issues one; a copy made
 * elsewhere (JSON, IPC, a persisted plan) grants nothing and is refused.
 */
export interface OwnedRecordAllowance {
  /** Absolute top level of the checkout the record sits in. */
  readonly checkout: string
  /** Repository-relative, forward-slash path of the record. */
  readonly path: string
}

export interface CleanCheckoutRequirement {
  /** The allowance for the registered root checkout, or null: every untracked, staged or modified path is refused. */
  record: OwnedRecordAllowance | null
}

export interface ApplyLearningIntegrationRequest extends PrepareLearningIntegrationRequest, LearningIntegrationCallbacks {
  /** Awaited after preparation and before the first canonical change; a rejection leaves every target unchanged. */
  persistPrepared(plan: LearningIntegrationPlan): Promise<void>
}

export interface RecoverLearningIntegrationRequest extends LearningIntegrationCallbacks {
  /** The attempt recovering the integration; it holds the card's lock while recovery runs. */
  attemptId: string
  /** The plan `persistPrepared` stored. */
  plan: LearningIntegrationPlan
}

/** Every target completed; `receipts` follows the plan's target order. A conflicted preparation persists nothing. */
export type AppliedLearningIntegration =
  | { state: 'applied'; plan: LearningIntegrationPlan; receipts: LearningIntegrationReceipt[] }
  | { state: 'conflicted'; cardId: string; attemptId: string; conflicts: LearningIntegrationConflict[] }

// ─── End of DM-949 ─────────────────────────────────────────────────────────────────────────────────────────────────
