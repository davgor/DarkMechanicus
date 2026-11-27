/**
 * The cult commands members send over the desktop control pipe (`src/shared/cults/cultControl.ts`), in main. The caller
 * is resolved only from the pipe's bound grant: its chat must be a live member of a run this app supervises, in the
 * run's own folder. A Magos-only operation from an acolyte, an acolyte-only one from the Magos, and every operation
 * from any other chat are refused with `unauthorized`. Arguments never name a run, a role or a sender.
 *
 * Refusals are typed codes the Magos can act on (`CULT_ERROR_CODES`); data rides only on `model_unavailable` (the
 * signed-in model ids), `reports_missing` (the missing Plan Forge types) and `plan_invalid` (validation errors). A Plan
 * Forge run concludes through its council (`planForgeCouncil.ts`); any other run whose cult has required slots refuses
 * to conclude with `reports_missing` until every one of them has reported.
 */
import { fail } from '../../core/errors'
import { NamingControlError, type NamingOperation } from '../../shared/agents/chatNaming'
import type { CultMemberView, CultRunView, PetitionInput, SlotCoverage } from '../../shared/cults/cult'
import {
  ACOLYTE_OPERATIONS, type CultAcolytesResult, type CultOperation, type CultPetitionArgs, type CultRecordSynthesisArgs,
  type CultStatusResult, type CultSummonArgs, type CultSummonResult, isCultOperation, MAGOS_OPERATIONS, MAX_LISTED_ACOLYTES,
  MAX_LISTED_MODELS
} from '../../shared/cults/cultControl'
import { remainingMs } from '../../shared/cults/runState'
import type { NamingControlBinding, NamingDispatcher } from '../naming/controlPipe'
import { newCultId } from './cultRecords'
import type { CultStore } from './cultStore'
import { requireRunningRun, type CultSupervisor } from './cultSupervisor'
import type { PlanForgeCouncil } from './planForgeCouncil'
import { cheapest, type CultModelOption, TIER_RANK } from './ompModels'

/** One order: one mailbox message from the sender's own endpoint to each recipient, returning the message ids in order. */
export interface CultOrderSend {
  folder: string
  senderChatId: string
  recipientChatIds: string[]
  orderId: string
  body: string
}

export interface CultCommandDeps {
  supervisor: Pick<CultSupervisor, 'memberOf' | 'summonAcolyte' | 'dismissAcolyte' | 'petition' | 'concludeRun' | 'concludeMember'>
  cults: Pick<CultStore, 'getCult' | 'listMembers' | 'listPetitions' | 'listReports' | 'slotCoverage' | 'setChronicle' | 'submitReport' | 'createWorkerType' | 'recordOrder'>
  /** The signed-in OMP models, cheapest first (`OmpModelCatalog.list`). */
  models: () => Promise<readonly CultModelOption[]>
  sendOrder: (order: CultOrderSend) => Promise<string[]>
  /** The Plan Forge council (DM-738): the conclusion gate, state and synthesis of the runs it governs. */
  council?: Pick<PlanForgeCouncil, 'governs' | 'status' | 'assertConclusion' | 'recordSynthesis'>
  /** The target revision a specialist saw when it reported; null when the run has no target. */
  targetRevision?: (run: CultRunView) => Promise<string | null>
  now?: () => string
  /** The folder-access upgrades this member holds in the run (`CultLedger.grants`, kind `folder_access`); none by default. */
  folderGrants?: (runId: string, chatId: string) => readonly { folder: string; tokenFile: string }[]
  onError?: (error: unknown) => void
}

/** The caller: its run and its own live membership. */
interface Caller {
  run: CultRunView
  member: CultMemberView
}

/** The target epic's revisions as main reads them: `getEpic` of the run's folder workspace. */
type TargetEpic = (folder: string, epicId: string) => Promise<{ currentRevisionNumber: number | null; draftRevision: number | null }>

/** The target plan's revisions a specialist saw when it reported (`saved N, draft M`); null for a run without a target. */
export function planTargetRevision(cults: Pick<CultStore, 'getCult'>, epicOf: TargetEpic): NonNullable<CultCommandDeps['targetRevision']> {
  return async (run) => {
    const target = cults.getCult(run.cultId)?.targetEpicId
    if (target == null) return null
    const epic = await epicOf(run.workDir, target)
    return `saved ${epic.currentRevisionNumber ?? 0}, draft ${epic.draftRevision ?? 0}`
  }
}

type Handler = (deps: CultCommandDeps, caller: Caller, args: never) => Promise<unknown> | unknown

function resolveCaller(deps: CultCommandDeps, binding: NamingControlBinding, op: CultOperation['op']): Caller {
  const caller = deps.supervisor.memberOf(binding.chatId)
  if (caller === null || binding.folder !== caller.run.workDir) throw new NamingControlError('unauthorized')
  const role = caller.member.role
  if (role !== 'magos' && MAGOS_OPERATIONS.includes(op)) throw new NamingControlError('unauthorized')
  if (role !== 'acolyte' && ACOLYTE_OPERATIONS.includes(op)) throw new NamingControlError('unauthorized')
  return caller
}

const isLive = (member: CultMemberView): boolean => member.state === 'joining' || member.state === 'active'
const workerTypeOf = (member: CultMemberView): string | null => member.workerType ?? member.runWorkerTypeId
const missingSlots = (slots: readonly SlotCoverage[]): string[] =>
  slots.filter((slot) => slot.required && slot.reportCount === 0).map((slot) => slot.slotId)

function reportedChats(deps: CultCommandDeps, runId: string): Set<string> {
  return new Set(deps.cults.listReports(runId).map((report) => report.memberChatId))
}

async function status(deps: CultCommandDeps, { run, member }: Caller): Promise<CultStatusResult> {
  const members = deps.cults.listMembers(run.id)
  const magos = members.find((candidate) => candidate.role === 'magos' && isLive(candidate))
  const pending = deps.cults.listPetitions(run.id).filter((petition) => petition.state === 'pending')
  return {
    name: member.displayName,
    role: member.role,
    magosName: magos?.displayName ?? deps.cults.getCult(run.cultId)?.magosName ?? '',
    state: run.state,
    remainingMs: remainingMs(run, (deps.now ?? (() => new Date().toISOString()))()),
    cap: run.cap,
    liveAcolytes: members.filter((candidate) => candidate.role === 'acolyte' && isLive(candidate)).length,
    pendingPetitions: pending.slice(0, 64).map((petition) => ({ id: petition.id, kind: petition.kind })),
    workerType: workerTypeOf(member),
    slotId: member.slotId,
    reported: reportedChats(deps, run.id).has(member.chatId),
    missingSlots: missingSlots(deps.cults.slotCoverage(run.id)),
    folderAccess: (deps.folderGrants?.(run.id, member.chatId) ?? []).slice(0, 64).map(({ folder, tokenFile }) => ({
      folder, tokenFile, usage: `dm --repo ${JSON.stringify(folder)} --token-file ${JSON.stringify(tokenFile)} <command>`
    })),
    planForge: (await deps.council?.status(run)) ?? null
  }
}

/** The model a summon runs on: the cheapest signed-in one by default; a higher tier needs a reason. */
async function summonModel(deps: CultCommandDeps, args: CultSummonArgs): Promise<CultModelOption> {
  const options = await deps.models()
  const base = cheapest(options)
  const chosen = args.model === undefined ? base : options.find((option) => option.id === args.model)
  if (chosen == null) {
    throw new NamingControlError('model_unavailable', { available: options.slice(0, MAX_LISTED_MODELS).map((option) => option.id) })
  }
  const above = base === null || TIER_RANK[chosen.tier] > TIER_RANK[base.tier]
  if (above && (args.tierReason ?? '').trim() === '') fail('tier_reason_required', 'A model above the cheapest tier needs a tierReason.')
  return chosen
}

async function summon(deps: CultCommandDeps, { run }: Caller, args: CultSummonArgs): Promise<CultSummonResult> {
  const model = await summonModel(deps, args)
  const member = await deps.supervisor.summonAcolyte(run.id, {
    ...(args.name === undefined ? {} : { name: args.name }),
    mission: args.mission, model: model.id, tier: model.tier, tierReason: args.tierReason ?? null,
    slotId: args.slotId ?? null, runWorkerTypeId: args.workerTypeId ?? null
  })
  return {
    summoned: member.displayName, model: member.model, tier: member.tier, tierReason: member.tierReason,
    slotId: member.slotId, workerType: workerTypeOf(member)
  }
}

async function dismiss(deps: CultCommandDeps, { run }: Caller, args: { name: string }): Promise<{ dismissed: string }> {
  requireRunningRun(run)
  const wanted = args.name.trim().toLowerCase()
  const acolyte = deps.cults.listMembers(run.id).find((member) => member.role === 'acolyte' && isLive(member) && member.displayName.toLowerCase() === wanted)
  if (acolyte === undefined) fail('not_found', `No live acolyte named ${args.name}.`)
  const dismissed = await deps.supervisor.dismissAcolyte(run.id, acolyte.chatId)
  return { dismissed: dismissed.displayName }
}

/** Live acolytes first, then those that left, most recent first. */
function listed(members: readonly CultMemberView[]): CultMemberView[] {
  const acolytes = members.filter((member) => member.role === 'acolyte')
  const left = acolytes.filter((member) => !isLive(member)).sort((a, b) => (b.leftAt ?? '').localeCompare(a.leftAt ?? ''))
  return [...acolytes.filter(isLive), ...left].slice(0, MAX_LISTED_ACOLYTES)
}

function listAcolytes(deps: CultCommandDeps, { run }: Caller): CultAcolytesResult {
  const members = deps.cults.listMembers(run.id)
  const reported = reportedChats(deps, run.id)
  const names = new Map(members.map((member) => [member.chatId, member.displayName]))
  const slots = deps.cults.slotCoverage(run.id)
  return {
    acolytes: listed(members).map((member) => ({
      name: member.displayName, model: member.model, tier: member.tier, state: member.state,
      workerType: workerTypeOf(member), slotId: member.slotId, reported: reported.has(member.chatId)
    })),
    slots: slots.map((slot) => ({
      slotId: slot.slotId, workerType: slot.workerType, required: slot.required,
      holder: names.get(slot.liveMemberChatIds[0] ?? '') ?? null, reported: slot.reportCount > 0
    })),
    missingSlots: missingSlots(slots)
  }
}

function petitionInput(args: CultPetitionArgs): PetitionInput {
  if (args.kind === 'acolytes') return { kind: 'acolytes', additional: args.additional ?? 0, reason: args.reason }
  if (args.kind === 'folder_access') return { kind: 'folder_access', folderPath: args.folder ?? '', reason: args.reason }
  return { kind: 'allow_save', reason: args.reason }
}

function petition(deps: CultCommandDeps, { run, member }: Caller, args: CultPetitionArgs) {
  const created = deps.supervisor.petition(run.id, petitionInput(args), member.chatId)
  return { petitionId: created.id, kind: created.kind, state: 'pending' as const }
}

async function orderAll(deps: CultCommandDeps, { run, member }: Caller, args: { body: string }) {
  requireRunningRun(run)
  const acolytes = deps.cults.listMembers(run.id).filter((candidate) => candidate.role === 'acolyte' && isLive(candidate))
  if (acolytes.length === 0) fail('no_acolytes', 'The run has no live acolytes to order.')
  const orderId = newCultId('co')
  const messageIds = await deps.sendOrder({
    folder: run.workDir, senderChatId: member.chatId, recipientChatIds: acolytes.map((acolyte) => acolyte.chatId), orderId, body: args.body
  })
  const recipients = acolytes.map((acolyte) => acolyte.displayName)
  deps.cults.recordOrder(run.id, member.displayName, { orderId, messageIds, recipients })
  return { orderId, recipients }
}

/** Without a council: every required roster slot must have reported. */
function assertReportsIn(deps: CultCommandDeps, run: CultRunView): void {
  const missing = missingSlots(deps.cults.slotCoverage(run.id))
  if (missing.length > 0) fail('reports_missing', `Required slots without a report: ${missing.join(', ')}.`)
}

async function concludeRun(deps: CultCommandDeps, { run }: Caller, args: { chronicle: string }) {
  if (run.state === 'ended') fail('run_ending', 'The cult run has ended.')
  if (deps.council?.governs(run) === true) await deps.council.assertConclusion(run)
  else assertReportsIn(deps, run)
  deps.cults.setChronicle(run.id, args.chronicle)
  await deps.supervisor.concludeRun(run.id)
  return { concluding: 'run' as const }
}

/**
 * An acolyte's final report: a slot holder's, or a run worker type holder's, is its specialist report, tagged with the
 * target revision it saw; then its service ends, after this reply.
 */
async function concludeService(deps: CultCommandDeps, { run, member }: Caller, args: { report: string }) {
  if (run.state === 'paused') fail('run_paused', 'The cult run is paused.')
  if (run.state === 'ended') fail('run_ending', 'The cult run has ended.')
  let reportStored = false
  if (member.slotId !== null || member.runWorkerTypeId !== null) {
    const targetRevision = (await deps.targetRevision?.(run)) ?? null
    const of = { slotId: member.slotId, runWorkerTypeId: member.runWorkerTypeId }
    deps.cults.submitReport(run.id, { memberChatId: member.chatId, ...of, text: args.report, targetRevision })
    reportStored = true
  }
  setImmediate(() => void deps.supervisor.concludeMember(run.id, member.chatId).catch(deps.onError ?? (() => {})))
  return { concluding: 'service' as const, reportStored }
}

function createWorkerType(deps: CultCommandDeps, { run, member }: Caller, args: Parameters<CultStore['createWorkerType']>[2]) {
  const type = deps.cults.createWorkerType(run.id, member.chatId, args)
  return { workerTypeId: type.id, displayName: type.displayName, requiredForConclusion: type.requiredForConclusion }
}

/** The Magos's Plan Forge synthesis of its latest draft edit: accepted and rejected recommendations, each with a reason. */
function recordSynthesis(deps: CultCommandDeps, { run, member }: Caller, args: CultRecordSynthesisArgs) {
  requireRunningRun(run)
  if (deps.council?.governs(run) !== true) fail('invalid_state', 'Only a Plan Forge run records a synthesis.')
  return deps.council.recordSynthesis(run, member, args)
}

const HANDLERS: Readonly<Record<CultOperation['op'], Handler>> = {
  cult_status: status,
  cult_summon_acolyte: summon,
  cult_dismiss_acolyte: dismiss,
  cult_list_acolytes: listAcolytes,
  cult_petition: petition,
  cult_order_all: orderAll,
  cult_conclude_run: concludeRun,
  cult_conclude_service: concludeService,
  cult_create_worker_type: createWorkerType,
  cult_record_synthesis: recordSynthesis
}

/** The pipe dispatcher for cult operations; any other operation is not its to serve. */
export function createCultDispatcher(deps: CultCommandDeps): NamingDispatcher {
  return async (operation: NamingOperation, context) => {
    if (!isCultOperation(operation.op)) throw new NamingControlError('operation_unavailable')
    const cult = operation as CultOperation
    const caller = resolveCaller(deps, context.binding, cult.op)
    context.assertActive()
    return HANDLERS[cult.op](deps, caller, cult.args as never)
  }
}
