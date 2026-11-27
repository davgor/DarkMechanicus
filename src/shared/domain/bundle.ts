/**
 * The plan bundle: the complete editorial + execution definition of one epic.
 * A draft holds one mutable bundle; every Save freezes a bundle into an immutable revision snapshot.
 * Layout is never part of the bundle — the desktop derives node positions from sprints and edges.
 */
import type { AttachmentRef } from './views'

export const PLAN_FORMAT_VERSION = 1

/** A checkable statement with a short id that is stable within its owner (e.g. `c1`, `s2`, `x1`). */
export interface Criterion {
  id: string
  text: string
}

/** A ticket's criterion. On an acceptance node it may name the ticket it verifies. */
export interface TicketCriterion extends Criterion {
  /** Stable id of the ticket this criterion verifies; set only on the criteria of an acceptance node. */
  covers?: string
}

export const WORK_TYPES = [
  'implementation',
  'architecture',
  'investigation',
  'testing',
  'review',
  'documentation'
] as const
export type WorkType = (typeof WORK_TYPES)[number]

export const REASONING_LEVELS = ['routine', 'multi_step', 'deep'] as const
export type ReasoningLevel = (typeof REASONING_LEVELS)[number]

/**
 * How hard a worker should think, separate from the reasoning level a model must be capable of.
 * Provider-neutral: a host maps each effort onto whatever knob its models offer.
 */
export const REASONING_EFFORTS = ['low', 'medium', 'high'] as const
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number]

/**
 * How big a ticket is, smallest to largest.
 * micro: one obvious change in one or two files, one targeted test, no design choice.
 * small: one coherent change inside one module.
 * medium: several modules, or one real design choice.
 * large: should usually be split.
 */
export const TICKET_SIZES = ['micro', 'small', 'medium', 'large'] as const
export type TicketSize = (typeof TICKET_SIZES)[number]

/**
 * What a ticket is for. `work` is an ordinary ticket and is never stored: the key is simply absent, so
 * plans saved before kinds existed keep their content hash. An `acceptance` node verifies its sprint:
 * it implicitly requires every other required ticket in the sprint, so it runs last.
 */
export const TICKET_KINDS = ['work', 'acceptance'] as const
export type TicketKind = (typeof TICKET_KINDS)[number]

export const MODALITIES = ['text', 'images'] as const
export type Modality = (typeof MODALITIES)[number]

export const TOOL_CAPABILITIES = [
  'repo_read',
  'repo_write',
  'shell',
  'browser',
  'test_execution',
  'network'
] as const
export type ToolCapability = (typeof TOOL_CAPABILITIES)[number]

/**
 * Provider-neutral task requirements. Hard constraints (modalities, tools, reasoning, context,
 * modelOverride) filter candidates; preferences only rank them. No vendor names are baked in.
 */
export interface CapabilityProfile {
  workType: WorkType
  /** `level` is what the model must be capable of (a floor); `effort` is how hard it should think. */
  reasoning: { level: ReasoningLevel; rationale: string; effort?: ReasoningEffort }
  skills: string[]
  modalities: Modality[]
  tools: ToolCapability[]
  context: { estimatedInputTokens: number | null; requiredArtifacts: string[] }
  constraints: {
    environments: string[]
    dataLocation: string | null
    maxDurationMinutes: number | null
    maxCostUsd: number | null
  }
  preferences: {
    quality: 'standard' | 'high' | null
    latency: 'low' | 'normal' | null
    cost: 'low' | 'normal' | null
    autonomy: 'supervised' | 'autonomous' | null
    modelOverride: string | null
  }
}

/**
 * A partial edit of a capability profile: any group may be given, each group partially.
 * `reasoning.effort: null` clears the effort (the stored profile then has no `effort` key).
 */
export interface CapabilityPatch {
  workType?: WorkType
  reasoning?: Partial<Omit<CapabilityProfile['reasoning'], 'effort'>> & { effort?: ReasoningEffort | null }
  skills?: string[]
  modalities?: Modality[]
  tools?: ToolCapability[]
  context?: Partial<CapabilityProfile['context']>
  constraints?: Partial<CapabilityProfile['constraints']>
  preferences?: Partial<CapabilityProfile['preferences']>
}

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'critical'] as const
export type TicketPriority = (typeof TICKET_PRIORITIES)[number]

export const REFERENCE_KINDS = ['url', 'file', 'ticket', 'doc', 'commit'] as const
type ReferenceKind = (typeof REFERENCE_KINDS)[number]

/** An inert pointer. References are never used as read/write/delete targets by the app. */
export interface TicketReference {
  kind: ReferenceKind
  label: string
  location: string
  hash: string | null
  remoteOnly: boolean
}

/**
 * Where a planned budget's numbers came from: a person's own estimate (`person_estimate`), the planner's estimate
 * (`planner_estimate`), or the actuals of similar earlier tickets (`prior_tickets`). Stated by whoever sets the budget;
 * it labels the estimate and never changes how a budget is graded.
 */
export const BUDGET_BASES = ['person_estimate', 'planner_estimate', 'prior_tickets'] as const
export type BudgetBasis = (typeof BUDGET_BASES)[number]

/**
 * A ticket's planned pre-dispatch resource budget, each in its named unit: `tokens` in tokens, `activeMs` in
 * milliseconds of active execution. At least one is set; `basis`, when given, says where the numbers came from. Saving
 * the plan freezes it as a new budget version at the server's save time; a run uses the version of the revision the
 * ticket was first dispatched under, so a later edit applies only prospectively.
 */
export interface TicketBudget {
  tokens?: number
  activeMs?: number
  /** Absent when not stated; never defaulted, so budgets saved without it keep their content hash. */
  basis?: BudgetBasis
}

export interface PlannedTestCase {
  startingCondition: string
  action: string
  expectedResult: string
  verificationMethod: string
}

export interface TicketContent {
  testCases?: PlannedTestCase[]
  id: string
  /** Display key such as `DM-12`. Display only — identity is `id`. */
  key: string
  /** Absent means `work`; never defaulted or stored as `work`, so older plans keep their content hash. */
  kind?: TicketKind
  title: string
  /** Unrestricted Markdown narrative. */
  body: string
  acceptanceCriteria: TicketCriterion[]
  tags: string[]
  priority: TicketPriority
  /** Absent until a planner sizes the ticket; never defaulted, so older plans keep their content hash. */
  size?: TicketSize
  /**
   * The repository of a folder of repositories this ticket targets; its title then starts with `<repo> - `.
   * Absent on a single-repository project's tickets and on acceptance nodes; never defaulted.
   */
  repo?: string
  capability: CapabilityProfile
  references: TicketReference[]
  expectedArtifacts: string[]
  /** Optional tickets do not gate sprint advancement or epic completion. */
  optional: boolean
  /**
   * Reference images to build from, at most 20. Absent when the ticket has none; never defaulted, so older plans keep
   * their content hash. The images are claimed by the ticket when the revision naming them is saved.
   */
  attachments?: AttachmentRef[]
  /**
   * The planned token and active-time budget (see `TicketBudget`). Absent when none is planned; never defaulted, so
   * older plans keep their content hash.
   */
  budget?: TicketBudget
}

export const CHECKPOINT_MODES = ['human', 'auto'] as const
export type CheckpointMode = (typeof CHECKPOINT_MODES)[number]

/** A sprint's structured delivery, checked after its checkpoint approval and before the next sprint's first claim. */
export interface SprintDelivery {
  /** The branch the sprint's increment reaches after its checkpoint approval (for example `main`). */
  target: string
  /** A Deploy release must contain the delivered commit. */
  release: boolean
  /** Before the next sprint's first claim, the installed app must run that release or later; requires `release`. */
  verifyInstalled: boolean
}

export interface SprintDef {
  deploymentVerification?: string
  id: string
  /** 1-based position; sprints execute in ordinal order. */
  ordinal: number
  goal: string
  ticketIds: string[]
  entryCriteria: Criterion[]
  exitCriteria: Criterion[]
  /** Maximum concurrently claimed tickets in this sprint; null = plan default. */
  concurrencyCap: number | null
  /** `auto` is only a request: it takes effect when the user authorizes auto-continue on the run. */
  checkpoint: { mode: CheckpointMode }
  /** Absent when the sprint declares none; never null, never defaulted, so older plans keep their content hash. */
  delivery?: SprintDelivery
}

/** `to` requires the accepted result of `from`. */
export interface DependencyEdge {
  from: string
  to: string
}

export const RELATION_KINDS = ['related_to', 'duplicate_of'] as const
export type RelationKind = (typeof RELATION_KINDS)[number]

/** Nonblocking relationship; never interpreted as an execution edge. */
export interface Relation {
  kind: RelationKind
  from: string
  to: string
}

export const TICKET_FAILURE_POLICIES = ['continue_independent', 'pause_run', 'fail_run'] as const
type TicketFailurePolicy = (typeof TICKET_FAILURE_POLICIES)[number]

export interface PlanPolicies {
  /** Plan-wide cap on concurrently claimed tickets; null = unlimited (sprint caps still apply). */
  maxConcurrency: number | null
  /** Maximum work attempts per ticket per run (before user-granted extra retries). */
  retryLimit: number
  onTicketFailure: TicketFailurePolicy
  /** Default claim lease duration. */
  leaseSeconds: number
  /**
   * Extra attempts the orchestrator may add itself (`retry_ticket`) per ticket, over every run of the epic, once `retryLimit` is used up,
   * before only the person's retry grants can add more. No default is stored, like a ticket's `size`: a plan saved
   * without it keeps its shape and hash and reads as `DEFAULT_AUTO_RETRY_LIMIT` (`autoRetryLimitOf`).
   */
  autoRetryLimit?: number
}

export interface EpicContent {
  title: string
  /** Markdown intent. */
  intent: string
  successCriteria: Criterion[]
  ownerRole: string | null
}

export interface PlanBundle {
  formatVersion: typeof PLAN_FORMAT_VERSION
  epic: EpicContent
  tickets: TicketContent[]
  sprints: SprintDef[]
  edges: DependencyEdge[]
  relations: Relation[]
  policies: PlanPolicies
  /** Markdown planning rationale. */
  rationale: string
}

export const DEFAULT_POLICIES: PlanPolicies = {
  maxConcurrency: null,
  retryLimit: 3,
  onTicketFailure: 'continue_independent',
  leaseSeconds: 900
}

/** Orchestrator retries per ticket over the epic's runs when a plan does not set `autoRetryLimit`. */
const DEFAULT_AUTO_RETRY_LIMIT = 3

/** The plan's orchestrator retry budget per ticket over the epic's runs, its default when unset. */
export function autoRetryLimitOf(policies: PlanPolicies): number {
  return policies.autoRetryLimit ?? DEFAULT_AUTO_RETRY_LIMIT
}

export function defaultCapabilityProfile(): CapabilityProfile {
  return {
    workType: 'implementation',
    reasoning: { level: 'multi_step', rationale: '' },
    skills: [],
    modalities: ['text'],
    tools: ['repo_read', 'repo_write'],
    context: { estimatedInputTokens: null, requiredArtifacts: [] },
    constraints: {
      environments: [],
      dataLocation: null,
      maxDurationMinutes: null,
      maxCostUsd: null
    },
    preferences: {
      quality: null,
      latency: null,
      cost: null,
      autonomy: null,
      modelOverride: null
    }
  }
}

/** Epic branch identity: work integrates into this branch, never automatically into the default branch. */
export interface EpicBranch {
  repository: string | null
  name: string
  startCommit: string | null
}

/** An epic that extends an earlier epic of this project (a follow-up, a split): `sourceEpicId` is an epic here. */
interface EarlierEpicProvenance {
  sourceEpicId: string
  note: string
}

/**
 * An epic another project asked of this one: the corrective work of an experiment in a sprint retro of that project
 * (the source), created here (the target) by the person at the desktop. Identities and hashes only, never a machine
 * path: the record means the same on every machine, and which local checkouts served the request is not recorded.
 * The source's epic, run and report live in the source project's records, not here, so nothing here links to them.
 */
export interface CorrectionProvenance {
  kind: 'cross_repo_correction'
  /**
   * The stable idempotency key: `<assessment report>/<experiment>/from:<source project>/to:<target project>`. One epic
   * per experiment of a source project and target project; a repeat finds it by this key, never by title.
   */
  key: string
  /** The content hash of what was asked when the epic was created (the experiment, title, edits, Fireguard choice). */
  payloadHash: string
  source: {
    projectId: string
    projectName: string
    epicId: string
    runId: string
    sprintId: string
    /** The sprint report revision the experiment was read from, its revision number and its content hash. */
    reportId: string
    reportRevision: number
    reportHash: string
    experimentId: string
    /** The frozen grade the experiment was drawn from: its report revision, its snapshot, and the policy it was graded under. */
    assessment: { reportId: string; assessmentId: string; snapshotId: string; policyHash: string }
  }
  target: { projectId: string }
  note: string
}

export type EpicProvenance = EarlierEpicProvenance | CorrectionProvenance
