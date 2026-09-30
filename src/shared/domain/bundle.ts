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
  reasoning: { level: ReasoningLevel; rationale: string }
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

/** A partial edit of a capability profile: any group may be given, each group partially. */
export interface CapabilityPatch {
  workType?: WorkType
  reasoning?: Partial<CapabilityProfile['reasoning']>
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
export type ReferenceKind = (typeof REFERENCE_KINDS)[number]

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
  title: string
  /** Unrestricted Markdown narrative. */
  body: string
  acceptanceCriteria: Criterion[]
  tags: string[]
  priority: TicketPriority
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
export type TicketFailurePolicy = (typeof TICKET_FAILURE_POLICIES)[number]

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
