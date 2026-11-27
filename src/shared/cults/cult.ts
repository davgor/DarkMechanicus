/**
 * The cult contract: what a cult definition, a run, its named members, petitions, specialist reports, run-scoped
 * worker types and events are, as main stores them and as IPC will carry them. Inputs are zod schemas (validated
 * at the store boundary); views are plain data. No Node imports, so the renderer can share it.
 *
 * Cults are app-level, not per folder: a `sanctum` cult has no folder at all. A cult's roster slots are
 * materialized from its archetype when it is founded (`materializeRoster`), so later catalog changes never rewrite
 * it. Run-scoped worker types belong to one run only: they stay in that run's history and never join the reusable
 * definition.
 */
import { z } from 'zod'
import {
  CULT_ARCHETYPES,
  CUSTOM_WORKER_TYPE,
  type CultArchetype,
  type RosterSlot,
  STANDARD_WORKER_TYPES,
  type WorkerType
} from './archetypes'
import {
  DEFAULT_ACOLYTE_GRACE_MS,
  DEFAULT_CAP,
  DEFAULT_MAGOS_WINDOW_MS,
  type EndReason,
  MAX_CAP,
  MAX_SHUTDOWN_TIMING_MS,
  MIN_CAP,
  MIN_SHUTDOWN_TIMING_MS,
  MIN_TIME_LIMIT_MS,
  type PetitionState,
  type RunState
} from './runState'

export const CULT_SCOPES = ['folder', 'sanctum'] as const
export type CultScope = (typeof CULT_SCOPES)[number]

export const MEMBER_ROLES = ['magos', 'acolyte'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

/** `joining` and `active` members are live; the rest have left the run, which is when their `leftAt` is set. */
export const MEMBER_STATES = ['joining', 'active', 'concluded', 'dismissed', 'left'] as const
export type MemberState = (typeof MEMBER_STATES)[number]
export const LIVE_MEMBER_STATES: readonly MemberState[] = ['joining', 'active']

export const PETITION_KINDS = ['acolytes', 'allow_save', 'folder_access'] as const
export type PetitionKind = (typeof PETITION_KINDS)[number]

/** What the cult pipeline shows, one row per event, in sequence order. */
export const CULT_EVENT_KINDS = [
  'summoned',
  'dismissed',
  'concluded',
  'left',
  'petition_created',
  'petition_approved',
  'petition_denied',
  'paused',
  'resumed',
  'shutdown_started',
  /** A step of the graceful shutdown: the Magos window opened, or the backstop ended what was left. */
  'shutdown_step',
  'ended',
  'shrine_published',
  'report_submitted',
  'worker_type_created',
  'worker_type_retired',
  'worker_type_assigned',
  /** One order the Magos sent every live acolyte (`cult_order_all`), with its mailbox message ids. */
  'order_all'
] as const
export type CultEventKind = (typeof CULT_EVENT_KINDS)[number]

/** A specialist report is inert text of at most 32 KiB (UTF-8). */
export const MAX_REPORT_BYTES = 32 * 1024
/** An event summary is inert, one-line-ish text. */
export const MAX_EVENT_SUMMARY_CHARS = 2000
export const MAX_EVENT_PAGE = 500

const text = (max: number) => z.string().trim().min(1).max(max)
const timingSchema = z.number().int().min(MIN_SHUTDOWN_TIMING_MS).max(MAX_SHUTDOWN_TIMING_MS)
const capSchema = z.number().int().min(MIN_CAP).max(MAX_CAP)
/** Null: unlimited. Otherwise at least one minute, with no upper bound. */
const timeLimitSchema = z.number().int().min(MIN_TIME_LIMIT_MS).max(Number.MAX_SAFE_INTEGER).nullable()

export const rosterSlotSchema = z.object({
  id: text(80),
  workerType: z.enum([...STANDARD_WORKER_TYPES, CUSTOM_WORKER_TYPE]),
  label: text(80),
  mission: text(4000),
  required: z.boolean()
})

/** Founding or editing a cult. `slots` replaces an editable archetype's defaults, or is a Custom cult's council. */
export const cultInputSchema = z
  .object({
    name: text(120),
    charter: text(32_000),
    scope: z.enum(CULT_SCOPES),
    folderPath: z.string().min(1).nullable(),
    archetype: z.enum(CULT_ARCHETYPES),
    targetEpicId: z.string().min(1).nullable().default(null),
    magosName: text(80),
    magosModelId: z.string().min(1).nullable(),
    defaultTimeLimitMs: timeLimitSchema,
    defaultCap: capSchema.default(DEFAULT_CAP),
    acolyteGraceMs: timingSchema.default(DEFAULT_ACOLYTE_GRACE_MS),
    magosWindowMs: timingSchema.default(DEFAULT_MAGOS_WINDOW_MS),
    slots: z.array(rosterSlotSchema).max(MAX_CAP).optional()
  })
  .superRefine((cult, ctx) => {
    if ((cult.scope === 'folder') !== (cult.folderPath !== null))
      ctx.addIssue({ code: 'custom', path: ['folderPath'], message: 'A folder cult has a folder; a sanctum cult has none.' })
    if (cult.archetype === 'plan_forge' && cult.scope !== 'folder')
      ctx.addIssue({ code: 'custom', path: ['scope'], message: 'A Plan Forge cult works in a folder.' })
    if (cult.archetype === 'plan_forge' && cult.targetEpicId === null)
      ctx.addIssue({ code: 'custom', path: ['targetEpicId'], message: 'A Plan Forge cult needs a target epic.' })
  })
export type CultInput = z.input<typeof cultInputSchema>
/** A cult definition after validation and defaults. */
export type CultDefinition = z.output<typeof cultInputSchema>

/** Starting a run: the cult's defaults apply to whatever is not given. */
export const runStartSchema = z.object({
  workDir: z.string().min(1),
  timeLimitMs: timeLimitSchema.optional(),
  cap: capSchema.optional(),
  acolyteGraceMs: timingSchema.optional(),
  magosWindowMs: timingSchema.optional()
})
export type RunStartInput = z.input<typeof runStartSchema>

/** A member joins as the Magos, or as an acolyte of a roster slot, of a run worker type, or of neither. */
export const memberInputSchema = z
  .object({
    chatId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
    role: z.enum(MEMBER_ROLES),
    /** Generated with `cultistName` when absent. Unique per run, case-insensitively. */
    displayName: text(80).optional(),
    mission: z.string().trim().max(4000).default(''),
    model: z.string().min(1).nullable().default(null),
    tier: z.string().min(1).nullable().default(null),
    tierReason: z.string().trim().max(1000).nullable().default(null),
    slotId: z.string().min(1).nullable().default(null),
    runWorkerTypeId: z.string().min(1).nullable().default(null)
  })
  .superRefine((member, ctx) => {
    if (member.slotId !== null && member.runWorkerTypeId !== null)
      ctx.addIssue({ code: 'custom', path: ['runWorkerTypeId'], message: 'A member holds a slot or a run worker type, not both.' })
    if (member.role === 'magos' && (member.slotId !== null || member.runWorkerTypeId !== null))
      ctx.addIssue({ code: 'custom', path: ['role'], message: 'The Magos holds no slot or worker type.' })
  })
export type MemberInput = z.input<typeof memberInputSchema>
/** A member after validation and defaults. */
export type MemberDefinition = z.output<typeof memberInputSchema>

export const memberUpdateSchema = z.object({
  state: z.enum(MEMBER_STATES).optional(),
  mission: z.string().trim().max(4000).optional(),
  model: z.string().min(1).nullable().optional(),
  tier: z.string().min(1).nullable().optional(),
  tierReason: z.string().trim().max(1000).nullable().optional()
})
export type MemberUpdate = z.input<typeof memberUpdateSchema>
/** A member change after validation. */
export type MemberChange = z.output<typeof memberUpdateSchema>

export const petitionInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('acolytes'), additional: z.number().int().min(1).max(MAX_CAP), reason: text(2000) }),
  z.object({ kind: z.literal('allow_save'), reason: text(2000) }),
  z.object({ kind: z.literal('folder_access'), folderPath: z.string().min(1), reason: text(2000) })
])
export type PetitionInput = z.input<typeof petitionInputSchema>

/** Approving an acolytes petition may grant fewer than asked (`granted`, default all); the run's cap rises by it. */
export const petitionDecisionSchema = z.object({
  approve: z.boolean(),
  granted: z.number().int().min(1).max(MAX_CAP).optional()
})
export type PetitionDecisionInput = z.input<typeof petitionDecisionSchema>

export const eventInputSchema = z.object({
  kind: z.enum(CULT_EVENT_KINDS),
  memberName: z.string().min(1).nullable().default(null),
  summary: text(MAX_EVENT_SUMMARY_CHARS)
})
export type CultEventInput = z.input<typeof eventInputSchema>

export const eventPageSchema = z.object({
  afterSeq: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(MAX_EVENT_PAGE).default(100)
})
export type CultEventPageRequest = z.input<typeof eventPageSchema>

export const reportInputSchema = z.object({
  memberChatId: z.string().min(1),
  slotId: z.string().min(1),
  text: z
    .string()
    .min(1)
    .refine((value) => new TextEncoder().encode(value).length <= MAX_REPORT_BYTES, 'A report is at most 32 KiB.'),
  targetRevision: z.string().min(1).nullable().default(null)
})
export type SpecialistReportInput = z.input<typeof reportInputSchema>

export interface CultView {
  id: string
  name: string
  charter: string
  scope: CultScope
  folderPath: string | null
  archetype: CultArchetype
  targetEpicId: string | null
  magosName: string
  magosModelId: string | null
  defaultTimeLimitMs: number | null
  defaultCap: number
  acolyteGraceMs: number
  magosWindowMs: number
  /** The materialized roster, in order. */
  slots: RosterSlot[]
  createdAt: string
  updatedAt: string
}

export interface CultRunView {
  id: string
  cultId: string
  state: RunState
  endReason: EndReason | null
  timeLimitMs: number | null
  acolyteGraceMs: number
  magosWindowMs: number
  accumulatedRunningMs: number
  runningSince: string | null
  cap: number
  workDir: string
  chronicle: string | null
  shrinePath: string | null
  shrineRevision: string | null
  startedAt: string
  endedAt: string | null
}

export interface CultMemberView {
  runId: string
  chatId: string
  role: MemberRole
  displayName: string
  mission: string
  model: string | null
  tier: string | null
  tierReason: string | null
  slotId: string | null
  /** The slot's worker type; null for the Magos and for members without a slot. */
  workerType: WorkerType | null
  runWorkerTypeId: string | null
  state: MemberState
  joinedAt: string
  leftAt: string | null
}

export interface CultPetitionView {
  id: string
  runId: string
  kind: PetitionKind
  /** Acolytes asked for (`acolytes` only). */
  additional: number | null
  /** Tracked folder asked for (`folder_access` only). */
  folderPath: string | null
  reason: string
  state: PetitionState
  /** Acolytes granted (an approved `acolytes` petition only). */
  granted: number | null
  createdAt: string
  decidedAt: string | null
}

/** What an `order_all` event records: the order, its one mailbox message per recipient, and the recipients by name. */
export interface CultOrderData {
  orderId: string
  messageIds: string[]
  recipients: string[]
}

export interface CultEventView {
  runId: string
  seq: number
  at: string
  memberName: string | null
  kind: CultEventKind
  summary: string
  /** Structured data of the event: an `order_all` event's order; null for every other kind. */
  data: CultOrderData | null
}

export interface CultEventPage {
  events: CultEventView[]
  /** Pass back as `afterSeq`; null when this page reached the end. */
  nextAfterSeq: number | null
}

export interface SpecialistReportView {
  id: number
  runId: string
  memberChatId: string
  slotId: string
  text: string
  targetRevision: string | null
  submittedAt: string
}

/** One roster slot's coverage in a run: who holds it now and how many reports it has. */
export interface SlotCoverage {
  slotId: string
  workerType: WorkerType
  label: string
  required: boolean
  liveMemberChatIds: string[]
  reportCount: number
  lastReportAt: string | null
}
