/**
 * Run-scoped worker types the Magos creates for a perspective the roster lacks (DM-739). Only the bound Magos of a
 * running run creates, lists or retires one (`MAGOS_OPERATIONS`); main generates its `dyn_<n>` id and the cult store
 * persists it with its event (`cultMembers.ts`). A created type is inert text: its contract rides in the acolyte's
 * mission and rules, and nothing else. It adds no capability, grant, folder, Save right, model or tier: an acolyte of
 * it is summoned like any other, under the same cap, model and petition rules.
 *
 * A type belongs to its run alone: a new run of the same cult starts with none, and the cult definition never gains
 * one. Required types never retire; an optional type retires only while no acolyte has ever held it.
 */
import { fail } from '../../core/errors'
import { MAX_DYNAMIC_WORKER_TYPES } from '../../shared/cults/archetypes'
import type { CultMemberView, CultRunView } from '../../shared/cults/cult'
import { type CultRetireWorkerTypeArgs, type CultWorkerTypesResult, MAX_LISTED_ACOLYTES } from '../../shared/cults/cultControl'
import type { CultStore } from './cultStore'
import { requireRunningRun } from './cultSupervisor'

export interface WorkerTypeDeps {
  cults: Pick<CultStore, 'createWorkerType' | 'retireWorkerType' | 'listWorkerTypes' | 'listMembers'>
}

/** The caller as the dispatcher resolved it from its bound grant: always the run's live Magos here. */
export interface WorkerTypeCaller {
  run: CultRunView
  member: CultMemberView
}

export interface WorkerTypeInput {
  displayName: string
  description: string
  mission: string
  rationale: string
  requiredForConclusion: boolean
}

/** Creates a type for the caller's running run; the store checks names, limits and the ceiling under its transaction. */
export function createWorkerType(deps: WorkerTypeDeps, { run, member }: WorkerTypeCaller, args: WorkerTypeInput) {
  requireRunningRun(run)
  const type = deps.cults.createWorkerType(run.id, member.chatId, args)
  return { workerTypeId: type.id, displayName: type.displayName, requiredForConclusion: type.requiredForConclusion }
}

/** The run's created types in creation order, retired ones included, each with every acolyte that held it. */
export function listWorkerTypes(deps: WorkerTypeDeps, { run }: WorkerTypeCaller): CultWorkerTypesResult {
  const members = deps.cults.listMembers(run.id)
  return {
    workerTypes: deps.cults.listWorkerTypes(run.id).map((type) => ({
      workerTypeId: type.id, displayName: type.displayName, description: type.description, mission: type.mission,
      rationale: type.rationale, requiredForConclusion: type.requiredForConclusion,
      state: type.retiredAt === null ? 'active' : 'retired',
      holders: members.filter((held) => held.runWorkerTypeId === type.id).map((held) => held.displayName).slice(0, MAX_LISTED_ACOLYTES)
    })),
    limit: MAX_DYNAMIC_WORKER_TYPES
  }
}

/** Retires an optional, never-assigned type of the caller's running run, recording who retired it and why. */
export function retireWorkerType(deps: WorkerTypeDeps, { run, member }: WorkerTypeCaller, args: CultRetireWorkerTypeArgs) {
  requireRunningRun(run)
  const type = deps.cults.retireWorkerType(run.id, args.workerTypeId, { byChatId: member.chatId, reason: args.reason })
  return { retired: type.id }
}

/**
 * The active run type a summon names, resolved in main before any process starts; `worker_type_unknown` for an id the
 * run never created, one it retired, or another run's. A summon without one needs nothing here.
 */
export function requireSummonableType(deps: WorkerTypeDeps, run: CultRunView, workerTypeId: string | undefined): void {
  if (workerTypeId === undefined) return
  const type = deps.cults.listWorkerTypes(run.id).find((candidate) => candidate.id === workerTypeId)
  if (type === undefined || type.retiredAt !== null) fail('worker_type_unknown', `The run has no active worker type ${workerTypeId}.`)
}
