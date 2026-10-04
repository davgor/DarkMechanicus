/**
 * The plan bundle: the complete editorial + execution definition of one epic.
 * A draft holds one mutable bundle; every Save freezes a bundle into an immutable revision snapshot.
 * Layout is never part of the bundle — the desktop derives node positions from sprints and edges.
 */

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

export interface TicketContent {
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
  capability: CapabilityProfile
  references: TicketReference[]
  expectedArtifacts: string[]
  /** Optional tickets do not gate sprint advancement or epic completion. */
  optional: boolean
}

export const CHECKPOINT_MODES = ['human', 'auto'] as const
export type CheckpointMode = (typeof CHECKPOINT_MODES)[number]

export interface SprintDef {
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

export interface EpicProvenance {
  sourceEpicId: string
  note: string
}
