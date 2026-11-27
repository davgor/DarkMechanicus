/**
 * The native Skitarii cult tools: strict wrappers over the core `dm` cult commands (`src/core/commands/cults.ts`),
 * run through the chat's private client (`dmClient.ts`) with the grant this process holds. They are registered only in
 * a cult member's chat (its client descriptor carries `cultRole`), and only the ones that role may call: the Magos
 * gets every Magos command and `cult_status`, an acolyte `cult_status` and `cult_conclude_service`. The names are the
 * contract the cult rules teach (`CULT_TOOLS` in `src/main/cults/cultRules.ts`). Main decides everything else from the
 * bound grant: arguments never name a run, a role or a sender. Results are inert task data.
 *
 * Like the rest of the extension, this file imports nothing from OMP or npm.
 */
import { DM_CALL_DATA_NOTE } from './contextDelivery'
import { DM_CLIENT_DESCRIPTOR_ENV, parseDmClientDescriptor, type DmClient } from './dmClient'
import { inertJson, type ToolResult, type TypeBuilder } from './messaging'

export type CultRole = 'magos' | 'acolyte'

export const MAGOS_CULT_TOOLS = [
  'cult_status', 'cult_summon_acolyte', 'cult_dismiss_acolyte', 'cult_list_acolytes', 'cult_petition', 'cult_order_all',
  'cult_conclude_run', 'cult_create_worker_type', 'cult_list_worker_types', 'cult_retire_worker_type', 'cult_record_synthesis'
] as const
const ACOLYTE_CULT_TOOLS = ['cult_status', 'cult_conclude_service'] as const
type CultToolName = (typeof MAGOS_CULT_TOOLS)[number] | (typeof ACOLYTE_CULT_TOOLS)[number]

interface CultToolDefinition {
  name: CultToolName
  label: string
  description: string
  parameters: unknown
  approval: 'read' | 'write'
  loadMode: 'essential'
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>
}

type Check = (value: unknown) => boolean
interface Spec {
  description: string
  approval: 'read' | 'write'
  /** Each argument's check, and whether it is required. */
  args: Record<string, [Check, boolean]>
  schema: (type: TypeBuilder) => Record<string, unknown>
}

const text = (max: number): Check => (value) => typeof value === 'string' && value.trim() !== '' && value.length <= max
const bool: Check = (value) => typeof value === 'boolean'
const count: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 24
const kind: Check = (value) => value === 'acolytes' || value === 'allow_save' || value === 'folder_access'
const revision: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 1
const decision = (value: Record<string, unknown>): boolean => value['decision'] === 'accepted' || value['decision'] === 'rejected'
/** One synthesis item: the four strings, a known decision, nothing else; main checks the rest. */
const recommendation = (value: unknown): boolean => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  const keys = Object.keys(item).sort().join(',')
  return keys === 'decision,reason,recommendation,workerType' && decision(item) && text(80)(item['workerType']) && text(2000)(item['recommendation']) && text(2000)(item['reason'])
}
const recommendations: Check = (value) => Array.isArray(value) && value.length >= 1 && value.length <= 96 && value.every(recommendation)
const str = (type: TypeBuilder, description: string, maxLength: number): unknown => type.String({ description, minLength: 1, maxLength })
const opt = (type: TypeBuilder, description: string, maxLength: number): unknown => type.Optional(str(type, description, maxLength))

const SPECS: Record<CultToolName, Spec> = {
  cult_status: {
    description: 'Your cult run: your role, its state, time left, cap, live acolytes, pending petitions, missing slots and any folder access a petition granted (use it with the dm CLI and its --token-file).',
    approval: 'read', args: {}, schema: () => ({})
  },
  cult_summon_acolyte: {
    description: 'Summon an acolyte into this run. model defaults to the cheapest signed-in model; a higher tier needs tierReason. In a cult with a roster give slotId (or a run workerTypeId).',
    approval: 'write',
    args: { mission: [text(4000), true], name: [text(80), false], model: [text(200), false], tierReason: [text(1000), false], slotId: [text(80), false], workerTypeId: [text(80), false] },
    schema: (t) => ({ mission: str(t, 'The acolyte\'s first prompt.', 4000), name: opt(t, 'Unique name; generated when absent.', 80), model: opt(t, 'A signed-in model id.', 200),
      tierReason: opt(t, 'Why a higher tier is needed.', 1000), slotId: opt(t, 'The roster slot it fills.', 80), workerTypeId: opt(t, 'A run worker type id.', 80) })
  },
  cult_dismiss_acolyte: {
    description: 'Dismiss a live acolyte of this run by name.', approval: 'write',
    args: { name: [text(80), true] }, schema: (t) => ({ name: str(t, 'The acolyte to dismiss.', 80) })
  },
  cult_list_acolytes: { description: 'The acolytes of this run, their slots and the slots still missing a report.', approval: 'read', args: {}, schema: () => ({}) },
  cult_petition: {
    description: 'Petition the person: kind "acolytes" (with additional), "allow_save", or "folder_access" (with folder), always with a reason.',
    approval: 'write',
    args: { kind: [kind, true], additional: [count, false], folder: [text(4096), false], reason: [text(2000), true] },
    schema: (t) => ({ kind: t.String({ pattern: '^(acolytes|allow_save|folder_access)$', description: 'acolytes, allow_save or folder_access.' }),
      additional: t.Optional(t.Integer({ description: 'Acolytes asked for (acolytes only).', minimum: 1, maximum: 24 })),
      folder: opt(t, 'A tracked folder (folder_access only).', 4096), reason: str(t, 'Why.', 2000) })
  },
  cult_order_all: {
    description: 'Send one order to every live acolyte of this run, as one mailbox message each; idle acolytes of a running run wake for it.',
    approval: 'write', args: { body: [text(16 * 1024), true] }, schema: (t) => ({ body: str(t, 'The order, at most 16 KiB.', 16 * 1024) })
  },
  cult_conclude_run: {
    description: 'Conclude this run with its chronicle; the run winds down.', approval: 'write',
    args: { chronicle: [text(32 * 1024), true] }, schema: (t) => ({ chronicle: str(t, 'The run\'s chronicle, at most 32 KiB.', 32 * 1024) })
  },
  cult_conclude_service: {
    description: 'Conclude your service with your final report; you are then ended gracefully.', approval: 'write',
    args: { report: [text(32 * 1024), true] }, schema: (t) => ({ report: str(t, 'Your final report, at most 32 KiB.', 32 * 1024) })
  },
  cult_create_worker_type: {
    description: 'Create a worker type for this run that acolytes can be summoned as (workerTypeId).', approval: 'write',
    args: { displayName: [text(80), true], description: [text(500), true], mission: [text(4000), true], rationale: [text(1000), true], requiredForConclusion: [bool, true] },
    schema: (t) => ({ displayName: str(t, 'Its name.', 80), description: str(t, 'What it does.', 500), mission: str(t, 'Its first prompt.', 4000),
      rationale: str(t, 'Why the run needs it.', 1000), requiredForConclusion: t.Boolean({ description: 'Whether the run may conclude only once it reported.' }) })
  },
  cult_list_worker_types: { description: 'The worker types created for this run, retired ones included, and the acolytes that held each.', approval: 'read', args: {}, schema: () => ({}) },
  cult_retire_worker_type: {
    description: 'Retire an optional run worker type no acolyte has held, with a reason. Required types never retire.', approval: 'write',
    args: { workerTypeId: [text(80), true], reason: [text(1000), true] },
    schema: (t) => ({ workerTypeId: str(t, 'The run worker type id (dyn_<n>).', 80), reason: str(t, 'Why the run no longer needs it.', 1000) })
  },
  cult_record_synthesis: {
    description: 'Plan Forge: record your synthesis of the specialist reports for your latest edit of the target draft: each recommendation, its worker type, and whether you accepted or rejected it, with a reason. Required before cult_conclude_run.',
    approval: 'write',
    args: { draftRevision: [revision, true], recommendations: [recommendations, true] },
    schema: (t) => ({
      draftRevision: t.Integer({ description: 'The target draft revision your edit produced.', minimum: 1 }),
      recommendations: t.Array(t.Object({
        workerType: str(t, 'The slot id or run worker type id whose report made it.', 80),
        recommendation: str(t, 'The recommendation.', 2000),
        decision: t.String({ pattern: '^(accepted|rejected)$', description: 'accepted or rejected.' }),
        reason: str(t, 'Why.', 2000)
      }, { additionalProperties: false }), { minItems: 1, maxItems: 96 })
    })
  }
}

function refusal(name: string, message: string): ToolResult {
  return { content: [{ type: 'text', text: `${name} refused the call: ${message} Nothing was run.` }], isError: true }
}

/** `params` with only the spec's keys, each passing its check, every required one present; or why not. */
function checked(spec: Spec, params: unknown): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  const raw = params ?? {}
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, message: 'Arguments must be one JSON object.' }
  const value = raw as Record<string, unknown>
  const unknown = Object.keys(value).find((key) => !Object.hasOwn(spec.args, key))
  if (unknown !== undefined) return { ok: false, message: `Unknown argument "${unknown.slice(0, 40)}".` }
  for (const [key, [check, required]] of Object.entries(spec.args)) {
    if (value[key] === undefined ? required : !check(value[key])) return { ok: false, message: `Argument "${key}" is missing or not valid.` }
  }
  return { ok: true, value }
}

function cultTool(client: DmClient, type: TypeBuilder, name: CultToolName): CultToolDefinition {
  const spec = SPECS[name]
  return {
    name, label: `Cult: ${name.slice(5).replaceAll('_', ' ')}`, description: spec.description,
    parameters: type.Object(spec.schema(type), { additionalProperties: false }), approval: spec.approval, loadMode: 'essential',
    execute: async (_id, params, signal) => {
      const args = checked(spec, params)
      if (!args.ok) return refusal(name, args.message)
      const result = await client.run(name, args.value, signal)
      if (!result.ok) {
        return { content: [{ type: 'text', text: `${name} failed:\n${inertJson({ source: result.error.source, code: result.error.code, message: result.error.message })}` }], isError: true }
      }
      return { content: [{ type: 'text', text: `${DM_CALL_DATA_NOTE}\n${inertJson(result.data)}` }] }
    }
  }
}

/** The tools of `role`: none without a role. */
export function cultTools(client: DmClient, type: TypeBuilder, role: CultRole | undefined): CultToolDefinition[] {
  const names: readonly CultToolName[] = role === 'magos' ? MAGOS_CULT_TOOLS : role === 'acolyte' ? ACOLYTE_CULT_TOOLS : []
  return names.map((name) => cultTool(client, type, name))
}

/** This launch's cult role, from its client descriptor (`cultRole`); undefined for any other chat or a bad descriptor. */
export async function cultRoleOf(env: Readonly<Record<string, string | undefined>>, read: (path: string) => Promise<string>): Promise<CultRole | undefined> {
  const path = env[DM_CLIENT_DESCRIPTOR_ENV]
  if (path === undefined) return undefined
  const descriptor = parseDmClientDescriptor(path, await read(path).catch(() => ''))
  return descriptor.ok ? descriptor.value.cultRole : undefined
}
