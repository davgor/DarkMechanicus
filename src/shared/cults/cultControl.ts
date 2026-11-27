/**
 * The cult commands a member agent sends over the desktop control pipe (`src/main/naming/controlPipe.ts`), as `dm` core
 * commands (`src/core/commands/cults.ts`) relay them. An operation never names a run, a role or a sender: main resolves
 * the caller from its bound grant, then its chat, then its cult membership (`src/main/cults/cultCommands.ts`).
 *
 * The operation names are the native cult tools' names (`CULT_TOOLS` in `src/main/cults/cultRules.ts`). Errors are
 * typed codes the Magos can act on, each with a fixed message; only a refused model carries data (the available ids).
 * No Node imports, so every side can share it.
 */
import { z } from 'zod'
import { DYNAMIC_TYPE_LIMITS, MAX_DYNAMIC_WORKER_TYPES } from './archetypes'
import { MAX_REPORT_BYTES, PETITION_KINDS } from './cult'
import type { DomainErrorCode } from '../domain/errors'
import { MAX_CAP } from './runState'

/** A mailbox message body, in UTF-8 bytes (the agent mail limit, `AGENT_MAIL_LIMITS.bodyBytes`). */
export const MAX_ORDER_BYTES = 16 * 1024
/** A chronicle or a specialist report: inert text of at most 32 KiB (UTF-8). */
export const MAX_LONG_TEXT_BYTES = MAX_REPORT_BYTES
/** How many model ids a `model_unavailable` refusal lists. */
export const MAX_LISTED_MODELS = 32
/** How many acolytes `cult_list_acolytes` lists: the live ones first, then the most recent to leave. */
export const MAX_LISTED_ACOLYTES = 48

const encoder = new TextEncoder()
/** One line of plain text: no control characters at all. */
const LINE = /^[^\p{Cc}\u2028\u2029]*$/u
/** Inert multi-line text: line breaks and tabs only, so its JSON form is at most twice its UTF-8 size. */
const LONG_TEXT = /^(?:[^\p{Cc}\u2028\u2029]|[\n\r\t])*$/u
/** A lone surrogate is not text and would be escaped to six bytes. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

const line = (max: number) => z.string().trim().min(1).max(max).regex(LINE, 'Use one line of plain text.')
const longText = (what: string) =>
  z
    .string()
    .min(1)
    .refine((value) => value.trim() !== '', `The ${what} must not be blank.`)
    .refine((value) => encoder.encode(value).byteLength <= MAX_LONG_TEXT_BYTES, `The ${what} is at most 32 KiB.`)
    .refine((value) => LONG_TEXT.test(value) && !LONE_SURROGATE.test(value), `The ${what} is plain text: no control characters.`)
const id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/)
/** The shape of a model id a command line may carry (`isSafeModelId`); whether it is signed in is main's check. */
const modelId = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._/+-]*(?:\[[A-Za-z0-9._/+=,-]*\])?$/)

export const CULT_OPERATION_NAMES = [
  'cult_status',
  'cult_summon_acolyte',
  'cult_dismiss_acolyte',
  'cult_list_acolytes',
  'cult_petition',
  'cult_order_all',
  'cult_conclude_run',
  'cult_conclude_service',
  'cult_create_worker_type',
  'cult_record_synthesis'
] as const
export type CultOperationName = (typeof CULT_OPERATION_NAMES)[number]

const none = z.strictObject({})

export const cultSummonArgsSchema = z
  .strictObject({
    name: line(80).optional().describe('The acolyte\'s name, unique in the run; generated when absent.'),
    mission: z.string().trim().min(1).max(4000).describe('The acolyte\'s first prompt.'),
    model: modelId.optional().describe('A signed-in model id; the cheapest signed-in model when absent.'),
    tierReason: line(1000).optional().describe('Why a model above the cheapest tier is needed; required for one.'),
    slotId: id.optional().describe('The roster slot the acolyte fills; required in a cult with a roster.'),
    workerTypeId: id.optional().describe('A worker type created for this run (cult_create_worker_type), instead of a slot.')
  })
  .refine((args) => args.slotId === undefined || args.workerTypeId === undefined, {
    path: ['workerTypeId'],
    message: 'An acolyte holds a slot or a run worker type, not both.'
  })
export type CultSummonArgs = z.infer<typeof cultSummonArgsSchema>

export const cultDismissArgsSchema = z.strictObject({ name: line(80).describe('The acolyte to dismiss.') })

export const cultPetitionArgsSchema = z
  .strictObject({
    kind: z.enum(PETITION_KINDS),
    additional: z.number().int().min(1).max(MAX_CAP).optional().describe('Acolytes asked for (kind "acolytes" only).'),
    folder: z.string().min(1).max(4096).regex(LINE).optional().describe('A tracked folder (kind "folder_access" only).'),
    reason: line(2000)
  })
  .superRefine((args, ctx) => {
    if ((args.kind === 'acolytes') !== (args.additional !== undefined))
      ctx.addIssue({ code: 'custom', path: ['additional'], message: 'An "acolytes" petition, and only one, says how many.' })
    if ((args.kind === 'folder_access') !== (args.folder !== undefined))
      ctx.addIssue({ code: 'custom', path: ['folder'], message: 'A "folder_access" petition, and only one, names a folder.' })
  })
export type CultPetitionArgs = z.infer<typeof cultPetitionArgsSchema>

export const cultOrderAllArgsSchema = z.strictObject({
  body: z
    .string()
    .min(1)
    .refine((value) => value.trim() !== '', 'The order must not be blank.')
    .refine((value) => LONG_TEXT.test(value) && !LONE_SURROGATE.test(value), 'The order is plain text: no control characters.')
    .refine((value) => encoder.encode(value).byteLength <= MAX_ORDER_BYTES, 'The order is at most 16 KiB.')
    .describe('The order every live acolyte of the run receives, as one mailbox message each.')
})

export const cultConcludeRunArgsSchema = z.strictObject({ chronicle: longText('chronicle').describe('The run\'s chronicle, at most 32 KiB.') })
export const cultConcludeServiceArgsSchema = z.strictObject({ report: longText('report').describe('Your final report, at most 32 KiB.') })

export const cultCreateWorkerTypeArgsSchema = z.strictObject({
  displayName: line(DYNAMIC_TYPE_LIMITS.displayName),
  description: line(DYNAMIC_TYPE_LIMITS.description),
  mission: z.string().trim().min(1).max(DYNAMIC_TYPE_LIMITS.mission),
  rationale: line(DYNAMIC_TYPE_LIMITS.rationale),
  requiredForConclusion: z.boolean()
})

/** One recommendation of the Plan Forge synthesis: which specialist made it, and the Magos's decision with its reason. */
const MAX_SYNTHESIS_ITEMS = 96
const recommendationSchema = z.strictObject({
  workerType: id.describe('The slot id (a fixed type) or run worker type id (dyn_<n>) whose report made it.'),
  recommendation: line(2000),
  decision: z.enum(['accepted', 'rejected']),
  reason: line(2000)
})
export const cultRecordSynthesisArgsSchema = z
  .strictObject({
    draftRevision: z.number().int().min(1).describe('The target draft revision this synthesis was applied to.'),
    recommendations: z.array(recommendationSchema).min(1).max(MAX_SYNTHESIS_ITEMS)
  })
  .refine((args) => encoder.encode(JSON.stringify(args.recommendations)).byteLength <= MAX_LONG_TEXT_BYTES, 'The synthesis is at most 32 KiB.')
export type CultRecordSynthesisArgs = z.infer<typeof cultRecordSynthesisArgsSchema>

const operation = <N extends CultOperationName, A extends z.ZodType>(op: N, args: A) => z.strictObject({ op: z.literal(op), args })

/** Each cult operation as the pipe carries it, without the request's authority fields. */
export const CULT_OPERATION_SCHEMAS = [
  operation('cult_status', none),
  operation('cult_summon_acolyte', cultSummonArgsSchema),
  operation('cult_dismiss_acolyte', cultDismissArgsSchema),
  operation('cult_list_acolytes', none),
  operation('cult_petition', cultPetitionArgsSchema),
  operation('cult_order_all', cultOrderAllArgsSchema),
  operation('cult_conclude_run', cultConcludeRunArgsSchema),
  operation('cult_conclude_service', cultConcludeServiceArgsSchema),
  operation('cult_create_worker_type', cultCreateWorkerTypeArgsSchema),
  operation('cult_record_synthesis', cultRecordSynthesisArgsSchema)
] as const
export type CultOperation = z.infer<(typeof CULT_OPERATION_SCHEMAS)[number]>

/** The operations only the Magos may send; an acolyte is refused them with `unauthorized`. */
export const MAGOS_OPERATIONS: readonly CultOperationName[] = [
  'cult_summon_acolyte',
  'cult_dismiss_acolyte',
  'cult_list_acolytes',
  'cult_petition',
  'cult_order_all',
  'cult_conclude_run',
  'cult_create_worker_type',
  'cult_record_synthesis'
]
/** The operations only an acolyte may send. */
export const ACOLYTE_OPERATIONS: readonly CultOperationName[] = ['cult_conclude_service']
/** The operations whose text runs past the shared request bound: a 32 KiB chronicle, report or synthesis, a 16 KiB order. */
export const LONG_TEXT_OPERATIONS: readonly string[] = ['cult_conclude_run', 'cult_conclude_service', 'cult_order_all', 'cult_record_synthesis']

/**
 * The Plan Forge council's state (`src/main/cults/planForgeCouncil.ts`): `stale` the target changed outside the run,
 * `collecting` a required type has no report, `resolving` the synthesis is missing or behind the draft, `invalid` the
 * draft does not validate, `valid` the run may conclude.
 */
const PLAN_FORGE_STATES = ['collecting', 'resolving', 'valid', 'stale', 'invalid'] as const
const planForgeStatusSchema = z.strictObject({
  state: z.enum(PLAN_FORGE_STATES),
  /** Fixed six types without a distinct member's report. */
  missingFixed: z.array(z.string().max(80)).max(MAX_CAP),
  /** Required Magos-created types without a distinct member's report. */
  missingCreated: z.array(z.string().max(80)).max(MAX_DYNAMIC_WORKER_TYPES)
})
export type PlanForgeStatus = z.infer<typeof planForgeStatusSchema>

export function isCultOperation(op: string): op is CultOperationName {
  return (CULT_OPERATION_NAMES as readonly string[]).includes(op)
}

// --- results ---------------------------------------------------------------------------------------------------

const name = z.string().max(80)
const nullableId = z.string().max(80).nullable()
const modelResult = z.string().max(200).nullable()

const slotState = z.strictObject({
  slotId: z.string().max(80),
  workerType: z.string().max(40),
  required: z.boolean(),
  /** The live acolyte holding the slot, if any. */
  holder: name.nullable(),
  reported: z.boolean()
})

export const cultStatusResultSchema = z.strictObject({
  name,
  role: z.enum(['magos', 'acolyte']),
  magosName: name,
  state: z.enum(['starting', 'running', 'paused', 'shutting_down', 'ended']),
  /** Running time left; null for an unlimited run. */
  remainingMs: z.number().int().min(0).nullable(),
  cap: z.number().int(),
  liveAcolytes: z.number().int(),
  pendingPetitions: z.array(z.strictObject({ id: z.string().max(80), kind: z.enum(PETITION_KINDS) })).max(64),
  workerType: z.string().max(80).nullable(),
  slotId: nullableId,
  reported: z.boolean(),
  missingSlots: z.array(z.string().max(80)).max(MAX_CAP),
  /**
   * Tracked folders an approved `folder_access` petition opened to this member for the run. Each is reached only from
   * the shell, with the dm CLI: `usage` is the exact command line (`dm --repo <folder> --token-file <file> <command>`).
   */
  folderAccess: z.array(z.strictObject({ folder: z.string().max(4096), tokenFile: z.string().max(4096), usage: z.string().max(9000) })).max(64),
  /** The Plan Forge council's state and coverage; null in every other archetype. */
  planForge: planForgeStatusSchema.nullable()
})
export type CultStatusResult = z.infer<typeof cultStatusResultSchema>

export const cultSummonResultSchema = z.strictObject({
  summoned: name,
  model: modelResult,
  tier: z.string().max(20).nullable(),
  tierReason: z.string().max(1000).nullable(),
  slotId: nullableId,
  workerType: z.string().max(80).nullable()
})
export type CultSummonResult = z.infer<typeof cultSummonResultSchema>

export const cultDismissResultSchema = z.strictObject({ dismissed: name })

export const cultAcolytesResultSchema = z.strictObject({
  acolytes: z
    .array(
      z.strictObject({
        name,
        model: modelResult,
        tier: z.string().max(20).nullable(),
        state: z.enum(['joining', 'active', 'concluded', 'dismissed', 'left']),
        workerType: z.string().max(80).nullable(),
        slotId: nullableId,
        reported: z.boolean()
      })
    )
    .max(MAX_LISTED_ACOLYTES),
  slots: z.array(slotState).max(MAX_CAP),
  missingSlots: z.array(z.string().max(80)).max(MAX_CAP)
})
export type CultAcolytesResult = z.infer<typeof cultAcolytesResultSchema>

export const cultPetitionResultSchema = z.strictObject({ petitionId: z.string().max(80), kind: z.enum(PETITION_KINDS), state: z.literal('pending') })
export const cultOrderAllResultSchema = z.strictObject({ orderId: z.string().max(80), recipients: z.array(name).min(1).max(MAX_CAP) })
export type CultOrderAllResult = z.infer<typeof cultOrderAllResultSchema>
export const cultConcludeRunResultSchema = z.strictObject({ concluding: z.literal('run') })
export const cultConcludeServiceResultSchema = z.strictObject({ concluding: z.literal('service'), reportStored: z.boolean() })
export const cultWorkerTypeResultSchema = z.strictObject({ workerTypeId: z.string().max(80), displayName: name, requiredForConclusion: z.boolean() })
export const cultSynthesisResultSchema = z.strictObject({ draftRevision: z.number().int(), accepted: z.number().int(), rejected: z.number().int() })

/** Every cult result, for the pipe's reply schema; each command parses its own. */
export const CULT_RESULT_SCHEMAS = [
  cultStatusResultSchema,
  cultSummonResultSchema,
  cultDismissResultSchema,
  cultAcolytesResultSchema,
  cultPetitionResultSchema,
  cultOrderAllResultSchema,
  cultConcludeRunResultSchema,
  cultConcludeServiceResultSchema,
  cultWorkerTypeResultSchema,
  cultSynthesisResultSchema
] as const

// --- errors ----------------------------------------------------------------------------------------------------

export const CULT_ERROR_CODES = [
  'cap_reached',
  'model_unavailable',
  'tier_reason_required',
  'run_paused',
  'run_ending',
  'name_taken',
  'folder_not_tracked',
  'no_acolytes',
  'slot_unknown',
  'slot_occupied',
  'reports_missing',
  'target_stale',
  'plan_invalid',
  'synthesis_missing',
  'invalid_state'
] as const satisfies readonly DomainErrorCode[]
type CultErrorCode = (typeof CULT_ERROR_CODES)[number]

export const CULT_ERROR_MESSAGES: Readonly<Record<CultErrorCode, string>> = {
  cap_reached: 'The run is at its acolyte cap. Petition for more acolytes (kind "acolytes") and wait for the decision.',
  model_unavailable: 'That model is not a signed-in model. Choose one of the available ids, or name none for the cheapest.',
  tier_reason_required: 'A model above the cheapest tier needs a tierReason saying why.',
  run_paused: 'The run is paused. Wait until it resumes.',
  run_ending: 'The run is ending. Conclude instead.',
  name_taken: 'A member of this run already has that name. Choose another, or name none to have one generated.',
  folder_not_tracked: 'That folder is not tracked by Dark Mechanicus.',
  no_acolytes: 'The run has no live acolytes to order.',
  slot_unknown: 'The cult has no such roster slot, or a cult with a roster needs a slotId.',
  slot_occupied: 'A live acolyte already holds that roster slot.',
  reports_missing: 'Every required slot must report before the run concludes.',
  target_stale: 'The target plan changed outside this run. Re-read it before concluding.',
  plan_invalid: 'The target draft does not validate. Fix it before concluding.',
  synthesis_missing: 'Record a synthesis (cult_record_synthesis) for your latest edit of the target draft, with a decision on a recommendation of every required type.',
  invalid_state: 'The run is not in a state that allows this.'
}

/**
 * What a refusal carries: a refused model's signed-in alternatives, the Plan Forge types still missing (fixed and
 * Magos-created apart), or the target draft's validation errors. Each is app-generated, never member text.
 */
export const cultErrorDetailsSchema = z.strictObject({
  available: z.array(modelId).max(MAX_LISTED_MODELS).optional(),
  missingFixed: z.array(z.string().max(80)).max(MAX_CAP).optional(),
  missingCreated: z.array(z.string().max(80)).max(MAX_DYNAMIC_WORKER_TYPES).optional(),
  planErrors: z.array(z.strictObject({ code: z.string().max(80), message: z.string().max(500) })).max(20).optional()
})
export type CultErrorDetails = z.infer<typeof cultErrorDetailsSchema>
