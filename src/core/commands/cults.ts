import { requireCapability } from '../authz'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { DomainError } from '../errors'
import {
  cultAcolytesResultSchema, cultConcludeRunResultSchema, cultConcludeServiceResultSchema, cultDismissResultSchema,
  cultOrderAllResultSchema, cultPetitionResultSchema, cultStatusResultSchema, cultSummonResultSchema,
  cultRetireWorkerTypeResultSchema, cultShrineResultSchema, cultSynthesisResultSchema, cultWorkerTypeResultSchema, cultWorkerTypesResultSchema, type CultOperation, type CultOperationName
} from '../../shared/cults/cultControl'
import type { z } from 'zod'
import type { CommandTable, WorkspaceCore } from './types'

/**
 * Relays one cult operation to the desktop over the control pipe and parses its typed result. The command carries no
 * run, role or sender: main resolves the caller from the session's live bound grant (`src/main/cults/cultCommands.ts`).
 * A refusal surfaces as its typed code; a refused model also carries the available ids in `details`.
 */
async function relay<T extends z.ZodType>(core: WorkspaceCore, operation: CultOperation, result: T): Promise<z.output<T>> {
  requireCapability(core.ctx().session, 'cult.act')
  const reply = await core.desktopClient.request(operation)
  if (!reply.ok) throw new DomainError(reply.error.code, reply.error.message, reply.error.details)
  const parsed = result.safeParse(reply.data)
  if (!parsed.success) throw new DomainError('internal_error', 'Unexpected desktop cult reply.')
  return parsed.data
}

const op = <A>(name: CultOperationName, args: A) => ({ op: name, args }) as CultOperation

export const cultCommands = {
  cultStatus: {
    schema: COMMAND_SCHEMAS.cultStatus,
    mutates: false,
    run: (core) => relay(core, op('cult_status', {}), cultStatusResultSchema)
  },
  cultSummonAcolyte: {
    schema: COMMAND_SCHEMAS.cultSummonAcolyte,
    mutates: false,
    run: (core, input) => relay(core, op('cult_summon_acolyte', input), cultSummonResultSchema)
  },
  cultDismissAcolyte: {
    schema: COMMAND_SCHEMAS.cultDismissAcolyte,
    mutates: false,
    run: (core, input) => relay(core, op('cult_dismiss_acolyte', input), cultDismissResultSchema)
  },
  cultListAcolytes: {
    schema: COMMAND_SCHEMAS.cultListAcolytes,
    mutates: false,
    run: (core) => relay(core, op('cult_list_acolytes', {}), cultAcolytesResultSchema)
  },
  cultPetition: {
    schema: COMMAND_SCHEMAS.cultPetition,
    mutates: false,
    run: (core, input) => relay(core, op('cult_petition', input), cultPetitionResultSchema)
  },
  cultOrderAll: {
    schema: COMMAND_SCHEMAS.cultOrderAll,
    mutates: false,
    run: (core, input) => relay(core, op('cult_order_all', input), cultOrderAllResultSchema)
  },
  cultConcludeRun: {
    schema: COMMAND_SCHEMAS.cultConcludeRun,
    mutates: false,
    run: (core, input) => relay(core, op('cult_conclude_run', input), cultConcludeRunResultSchema)
  },
  cultConcludeService: {
    schema: COMMAND_SCHEMAS.cultConcludeService,
    mutates: false,
    run: (core, input) => relay(core, op('cult_conclude_service', input), cultConcludeServiceResultSchema)
  },
  cultCreateWorkerType: {
    schema: COMMAND_SCHEMAS.cultCreateWorkerType,
    mutates: false,
    run: (core, input) => relay(core, op('cult_create_worker_type', input), cultWorkerTypeResultSchema)
  },
  cultListWorkerTypes: {
    schema: COMMAND_SCHEMAS.cultListWorkerTypes,
    mutates: false,
    run: (core) => relay(core, op('cult_list_worker_types', {}), cultWorkerTypesResultSchema)
  },
  cultRetireWorkerType: {
    schema: COMMAND_SCHEMAS.cultRetireWorkerType,
    mutates: false,
    run: (core, input) => relay(core, op('cult_retire_worker_type', input), cultRetireWorkerTypeResultSchema)
  },
  cultRecordSynthesis: {
    schema: COMMAND_SCHEMAS.cultRecordSynthesis,
    mutates: false,
    run: (core, input) => relay(core, op('cult_record_synthesis', input), cultSynthesisResultSchema)
  },
  cultPublishShrine: {
    schema: COMMAND_SCHEMAS.cultPublishShrine,
    mutates: false,
    run: (core, input) => relay(core, op('cult_publish_shrine', input), cultShrineResultSchema)
  }
} satisfies Partial<CommandTable>
