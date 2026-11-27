/**
 * The cult surface of the desktop bridge (`window.dm.cults`): one `cults:*` IPC channel per request and one push channel
 * (`cults:event`) carrying a run's snapshot each time the supervisor tells it changed. The renderer names cults, runs,
 * petitions and member chats, and supplies cult definitions; main checks every folder against the tracked folders and
 * never takes a path, a sanctum, a member's resolved worker type or a run worker type from the renderer: those come only
 * from main (the launcher) and the bound Magos's control commands.
 */
import type { CommandResult } from '../desktop/api'
import type { ARCHETYPE_INFO, CultArchetype, RunWorkerType, STANDARD_WORKER_TYPES, WORKER_TYPE_INFO, WorkerType } from './archetypes'
import type { CultEventPage, CultMemberView, CultPetitionView, CultRunView, CultView, SlotCoverage } from './cult'

/** Main pushes every `CultPushEvent` to the window on this channel. */
export const CULT_EVENT_CHANNEL = 'cults:event'

type CultScopeInput = { scope: 'folder'; folderPath: string } | { scope: 'sanctum'; folderPath: null }

/** One ordered roster slot the person defines: a stable id, its label and mission. */
interface CultSlotInput {
  id: string
  workerType: WorkerType
  label: string
  mission: string
  required: boolean
}

/** Founding or editing a cult. A folder cult's folder must be tracked; a Plan Forge's target epic must be in it. */
export type CultDefinitionInput = CultScopeInput & {
  name: string
  charter: string
  archetype: CultArchetype
  targetEpicId?: string | null
  magosName: string
  magosModelId: string | null
  defaultTimeLimitMs: number | null
  /** Plan Forge: at least six. */
  defaultCap?: number
  acolyteGraceMs?: number
  magosWindowMs?: number
  /** Replaces an editable archetype's defaults; a Custom cult's whole council, in order. */
  slots?: CultSlotInput[]
}

/** A run's overrides of its cult's defaults; the work folder is always the cult's own. */
interface CultRunOverrides {
  timeLimitMs?: number | null
  cap?: number
  acolyteGraceMs?: number
  magosWindowMs?: number
}

interface CultPipelineRequest {
  afterSeq?: number
  limit: number
}

/** A model a cult member may run on, cheapest tier first. */
interface CultModelOptionView {
  id: string
  provider: string
  label: string
  tier: 'low' | 'normal' | 'high' | 'unpriced'
}

export interface CultModelsView {
  options: readonly CultModelOptionView[]
  /** Why no model is offered; null when some are. */
  reason: string | null
}

/** The catalog the founding dialog offers: every archetype with its materialized preset, and the standard types. */
export interface CultCatalogView {
  archetypes: ({ id: CultArchetype } & (typeof ARCHETYPE_INFO)[CultArchetype])[]
  standardWorkerTypes: ({ id: (typeof STANDARD_WORKER_TYPES)[number]; origin: 'standard' } & (typeof WORKER_TYPE_INFO)[WorkerType])[]
}

/**
 * Where a member's worker type comes from: a slot of the cult's definition (a standard or custom type), a type the
 * Magos created for this run, or none (the Magos, or an acolyte of a cult without a roster).
 */
type MemberTypeOrigin = 'definition_slot' | 'magos_created' | null

/** What a live member is doing (`docs/design/cults.md` section 8); the renderer phrases it. */
export interface MemberActivity {
  working: boolean
  /** The last tool call: its name lower-cased and a reduced target (at most 80 characters, never the raw input). */
  tool: { name: string; target: string } | null
  /** When this activity was published, ISO. */
  at: string
}

export interface CultMemberDetail extends CultMemberView {
  typeOrigin: MemberTypeOrigin
  /** Whether the member has submitted a specialist report. */
  reported: boolean
  /** Null for a member not tracked live (not yet read, left, or the run ended). */
  activity: MemberActivity | null
}

/** A run-scoped type the Magos created (never from the renderer), with who holds it and its report state. */
export interface RunWorkerTypeDetail extends RunWorkerType {
  origin: 'magos_created'
  state: 'active' | 'retired'
  /** Member chats ever assigned the type. */
  assignedChatIds: string[]
  reportCount: number
}

/** A definition slot's coverage in the run. */
interface SlotCoverageDetail extends SlotCoverage {
  origin: 'definition_slot'
}

interface CultSynthesisView {
  draftRevision: number
  accepted: number
  rejected: number
  recordedAt: string
}

/** The run's published Shrine (DM-632): served only as `shrineUrl(run id, revision)`; null until a member publishes. */
export interface CultShrineView {
  /** The file's real path inside the run's work dir, for its name; the content is never read by path. */
  path: string
  /** Bumped on every publish and every change of the file: a new revision is a new address, so the view reloads. */
  revision: string
  kind: 'image' | 'html'
  /** The member who published it; null when the record has no name. */
  publishedBy: string | null
  /** When it was published or last changed, ISO. */
  updatedAt: string
}

/** A run as it is now: members with their types and report state, the council's coverage and the Magos's synthesis. */
export interface CultRunDetail {
  run: CultRunView
  /** The cult's Plan Forge target; null for other archetypes. */
  targetEpicId: string | null
  members: CultMemberDetail[]
  petitions: CultPetitionView[]
  slots: SlotCoverageDetail[]
  workerTypes: RunWorkerTypeDetail[]
  /** Required definition slots and required active Magos-created types without a report. */
  missing: { slots: string[]; workerTypes: string[] }
  synthesis: CultSynthesisView | null
  shrine: CultShrineView | null
}

export type CultPushEvent = { type: 'run_changed'; snapshot: CultRunDetail }

export interface CultsApi {
  list(): Promise<CommandResult<CultView[]>>
  get(cultId: string): Promise<CommandResult<CultView>>
  create(input: CultDefinitionInput): Promise<CommandResult<CultView>>
  update(cultId: string, input: CultDefinitionInput): Promise<CommandResult<CultView>>
  /** Ends an active run gracefully first (Stop, then waits for it to end), then deletes the cult. */
  delete(cultId: string): Promise<CommandResult<null>>
  models(refresh?: boolean): Promise<CommandResult<CultModelsView>>
  archetypes(): Promise<CommandResult<CultCatalogView>>
  start(cultId: string, overrides: CultRunOverrides): Promise<CommandResult<CultRunDetail>>
  pause(runId: string): Promise<CommandResult<CultRunDetail>>
  resume(runId: string): Promise<CommandResult<CultRunDetail>>
  stop(runId: string): Promise<CommandResult<CultRunDetail>>
  killNow(runId: string): Promise<CommandResult<CultRunDetail>>
  raiseCap(runId: string, cap: number): Promise<CommandResult<CultRunDetail>>
  decidePetition(petitionId: string, approve: boolean, granted?: number): Promise<CommandResult<CultPetitionView>>
  dismissAcolyte(runId: string, chatId: string): Promise<CommandResult<CultMemberView>>
  /** The cult's runs, newest first, each as its detail. */
  runs(cultId: string): Promise<CommandResult<CultRunDetail[]>>
  /** The run's pipeline page; served by the pipeline ticket (DM-630): `operation_unavailable` until then. */
  pipeline(runId: string, request: CultPipelineRequest): Promise<CommandResult<CultEventPage>>
  /** Subscribes to pushed run snapshots; returns the unsubscribe function. */
  onEvent(listener: (event: CultPushEvent) => void): () => void
}
