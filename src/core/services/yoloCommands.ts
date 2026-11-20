import type { CommandName } from '../../shared/domain/api'
import type { Capability } from '../authz'
import { COMMAND_CAPABILITIES } from '../commands/capabilities'
import type { Ctx } from '../context'
import { auditYolo, isYoloEligible, proveYoloGrant } from './yolo'

const TARGET_FIELDS: Partial<Record<CommandName, string>> = {
  savePlan: 'epicId', grantRetry: 'ticketId', approveCheckpoint: 'reportId', approveAndAdvance: 'reportId', advanceSprint: 'runId'
}
const COMBINED_CAPABILITIES: readonly Capability[] = ['checkpoint.approve', 'checkpoint.advance']

export interface YoloCommandAdmission {
  grantId: string
  runId: string | null
  targetId: string | null
  command: CommandName
  capabilities: Capability[]
}

function commandFields(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' ? input as Record<string, unknown> : {}
}

function commandRun(ctx: Ctx, fields: Record<string, unknown>): string | null {
  if (typeof fields['runId'] === 'string') return fields['runId']
  if (typeof fields['epicId'] !== 'string') return null
  return ctx.db.get<{ id: string }>("SELECT id FROM runs WHERE epic_id = ? AND state IN ('running', 'awaiting_checkpoint', 'paused') ORDER BY number DESC LIMIT 1", fields['epicId'])?.id ?? null
}

/** Only validated stable IDs reach audit; command payloads and arbitrary strings never do. */
function commandTarget(fields: Record<string, unknown>, key: string): string | null {
  const value = fields[key]
  return typeof value === 'string' && /^(ep|tk|rp|rn)_[0-9a-z]{26}$/.test(value) ? value : null
}

export async function authorizeYoloCommand(ctx: Ctx, grantId: string, command: CommandName, input: unknown): Promise<YoloCommandAdmission | null> {
  const targetField = TARGET_FIELDS[command]
  if (targetField === undefined) return null
  const required = command === 'approveAndAdvance' ? COMBINED_CAPABILITIES : [COMMAND_CAPABILITIES[command]]
  const capabilities = required.filter((capability) => !ctx.session.capabilities.has(capability))
  if (capabilities.length === 0) return null
  const fields = commandFields(input)
  const runId = commandRun(ctx, fields)
  if (!capabilities.every((capability) => isYoloEligible(ctx, grantId, capability, runId))) return null
  if (!await proveYoloGrant(ctx, grantId)) return null
  if (commandRun(ctx, fields) !== runId) return null
  if (!capabilities.every((capability) => isYoloEligible(ctx, grantId, capability, runId))) return null
  return { grantId, runId, targetId: commandTarget(fields, targetField), command, capabilities }
}

export function auditYoloCommand(ctx: Ctx, admission: YoloCommandAdmission, result: 'admitted' | 'succeeded' | 'failed'): void {
  for (const capability of admission.capabilities) {
    auditYolo(ctx, { grantId: admission.grantId, runId: admission.runId, targetId: admission.targetId, command: admission.command, capability, result })
  }
}
