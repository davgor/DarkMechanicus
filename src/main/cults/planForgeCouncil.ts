/**
 * The Plan Forge council (DM-738): the gate a Plan Forge run passes before its Magos may conclude it.
 *
 * - **Binding.** When the run starts, before its Magos, the run is bound to its target epic: the saved and draft
 *   revisions and the folder's event high-water mark, read through the workspace command layer (`cultPlanTrace` of the
 *   desktop's workspace pool, docs/design/cults.md section 9). Nothing here opens a project database.
 * - **Coverage.** Every required worker type needs one distinct member's report, tagged with the target revision it
 *   saw: the fixed six roster slots, plus every active Magos-created type marked `requiredForConclusion` (revision 5).
 *   A second report of a covered type covers nothing more; an optional created type never gates.
 * - **Synthesis.** The Magos records, for its latest edit of the target draft, the recommendations it accepted and
 *   rejected with a reason each, naming every required type. Its text is inert JSON, never read as an instruction.
 * - **Conclusion.** The target is re-read: any draft change or save not made through a Magos grant since the binding is
 *   `target_stale`; missing reports are `reports_missing` (fixed and created types apart); a missing or out-of-date
 *   synthesis, or a draft revision the Magos did not write, is `synthesis_missing`; then the real draft validation runs,
 *   and errors are `plan_invalid`. Each refusal leaves the run running. Saving is not part of this gate: the Magos saves
 *   only once the person grants Allow save (its grant carries `runSave: false`, `src/core/services/grants.ts`).
 *
 * Other archetypes are not governed: their conclusion keeps the plain required-slot check (`cultCommands.ts`).
 */
import { fail } from '../../core/errors'
import type { PlanTrace } from '../../core/services/planTrace'
import { NamingControlError } from '../../shared/agents/chatNaming'
import type { CultMemberView, CultRunView, SpecialistReportView } from '../../shared/cults/cult'
import type { CultRecordSynthesisArgs, PlanForgeStatus } from '../../shared/cults/cultControl'
import type { ValidationIssue } from '../../shared/domain/views'
import type { ProjectWorkspace } from '../desktop/workspaceClient'
import type { PlanBinding } from './cultPlanRecords'
import type { CultStore } from './cultStore'

export interface PlanForgeCouncilDeps {
  cults: Pick<CultStore, 'getCult' | 'listMembers' | 'listReports' | 'listWorkerTypes' | 'bindPlanTarget' | 'getPlanBinding' | 'recordSynthesis' | 'latestSynthesis'>
  /** The run folder's workspace through the desktop's tracked-folder gate and pool; never the database directly. */
  workspaceFor: (folder: string) => Pick<ProjectWorkspace, 'validatePlan' | 'call'>
  /** The grants a member chat holds now (its chat record's `grantIds`). */
  grantIdsOf: (run: CultRunView, chatId: string) => readonly string[]
}

export interface PlanForgeCouncil {
  /** True for a Plan Forge run: only those pass this gate. */
  governs(run: CultRunView): boolean
  /** Binds a Plan Forge run to its target's current revisions; nothing for any other run. */
  bind(run: CultRunView): Promise<void>
  /** The council's state and missing types; null for a run it does not govern. */
  status(run: CultRunView): Promise<PlanForgeStatus | null>
  /** Throws `target_stale`, `reports_missing`, `synthesis_missing` or `plan_invalid` unless the run may conclude. */
  assertConclusion(run: CultRunView): Promise<void>
  recordSynthesis(run: CultRunView, magos: CultMemberView, args: CultRecordSynthesisArgs): { draftRevision: number; accepted: number; rejected: number }
}

interface RequiredType {
  id: string
  fixed: boolean
}

interface Evaluation extends PlanForgeStatus {
  errors: ValidationIssue[]
}

/** How many validation errors a `plan_invalid` refusal carries. */
const MAX_PLAN_ERRORS = 20

/** The fixed required roster slots, then every active Magos-created type required for conclusion. */
function requiredTypes(deps: PlanForgeCouncilDeps, run: CultRunView): RequiredType[] {
  const slots = deps.cults.getCult(run.cultId)?.slots ?? []
  const created = deps.cults.listWorkerTypes(run.id).filter((type) => type.requiredForConclusion && type.retiredAt === null)
  return [
    ...slots.filter((slot) => slot.required).map((slot) => ({ id: slot.id, fixed: true })),
    ...created.map((type) => ({ id: type.id, fixed: false }))
  ]
}

/** The required types without a tagged report by a member no other type already counted. */
function missingTypes(reports: readonly SpecialistReportView[], required: readonly RequiredType[]): Pick<PlanForgeStatus, 'missingFixed' | 'missingCreated'> {
  const tagged = reports.filter((report) => report.targetRevision !== null)
  const counted = new Set<string>()
  const missing = required.filter((type) => {
    const report = tagged.find((candidate) => (candidate.slotId ?? candidate.runWorkerTypeId) === type.id && !counted.has(candidate.memberChatId))
    if (report !== undefined) counted.add(report.memberChatId)
    return report === undefined
  })
  return { missingFixed: missing.filter((type) => type.fixed).map((type) => type.id), missingCreated: missing.filter((type) => !type.fixed).map((type) => type.id) }
}

function magosGrants(deps: PlanForgeCouncilDeps, run: CultRunView): Set<string> {
  const magi = deps.cults.listMembers(run.id).filter((member) => member.role === 'magos')
  return new Set(magi.flatMap((member) => deps.grantIdsOf(run, member.chatId)))
}

/** A change since the binding not made through a Magos grant, or a saved revision no Magos save explains. */
function changedOutside(binding: PlanBinding, trace: PlanTrace, magos: ReadonlySet<string>): boolean {
  if (trace.changes.some((change) => change.grantId === null || !magos.has(change.grantId))) return true
  return trace.savedRevision !== binding.savedRevision && !trace.changes.some((change) => change.kind === 'plan.save_requested')
}

/** True unless the latest synthesis is of the current draft revision, which a Magos edit wrote, and names every required type. */
function synthesisMissing(deps: PlanForgeCouncilDeps, run: CultRunView, required: readonly RequiredType[], trace: PlanTrace, magos: ReadonlySet<string>): boolean {
  const synthesis = deps.cults.latestSynthesis(run.id)
  if (synthesis === null || synthesis.draftRevision !== trace.draftRevision) return true
  const edited = trace.changes.some((change) => change.kind === 'draft.updated' && change.draftRevision === synthesis.draftRevision && magos.has(change.grantId ?? ''))
  const named = new Set(synthesis.recommendations.map((item) => item.workerType))
  return !edited || required.some((type) => !named.has(type.id))
}

async function evaluate(deps: PlanForgeCouncilDeps, run: CultRunView): Promise<Evaluation> {
  const required = requiredTypes(deps, run)
  const missing = missingTypes(deps.cults.listReports(run.id), required)
  const binding = deps.cults.getPlanBinding(run.id)
  const at = (state: PlanForgeStatus['state'], errors: ValidationIssue[] = []): Evaluation => ({ state, ...missing, errors })
  if (binding === null) return at('stale')
  const workspace = deps.workspaceFor(run.workDir)
  const trace = await workspace.call('cultPlanTrace', binding.epicId, binding.eventSeq)
  const magos = magosGrants(deps, run)
  if (changedOutside(binding, trace, magos)) return at('stale')
  if (missing.missingFixed.length + missing.missingCreated.length > 0) return at('collecting')
  if (synthesisMissing(deps, run, required, trace, magos)) return at('resolving')
  const report = await workspace.validatePlan({ epicId: binding.epicId, view: 'draft' })
  return report.valid ? at('valid') : at('invalid', report.errors)
}

function refuse(evaluation: Evaluation): void {
  const { state, missingFixed, missingCreated, errors } = evaluation
  if (state === 'stale') fail('target_stale', 'The target plan changed outside this run.')
  if (state === 'collecting') throw new NamingControlError('reports_missing', { missingFixed, missingCreated })
  if (state === 'resolving') throw new NamingControlError('synthesis_missing')
  if (state === 'invalid') {
    const planErrors = errors.slice(0, MAX_PLAN_ERRORS).map((issue) => ({ code: issue.code.slice(0, 80), message: issue.message.slice(0, 500) }))
    throw new NamingControlError('plan_invalid', { planErrors })
  }
}

function recordSynthesis(deps: PlanForgeCouncilDeps, run: CultRunView, magos: CultMemberView, args: CultRecordSynthesisArgs) {
  const cult = deps.cults.getCult(run.cultId)
  if (cult?.archetype !== 'plan_forge') fail('invalid_state', 'Only a Plan Forge run records a synthesis.')
  const known = new Set([...cult.slots.map((slot) => slot.id), ...deps.cults.listWorkerTypes(run.id).map((type) => type.id)])
  const unknown = args.recommendations.find((item) => !known.has(item.workerType))
  if (unknown !== undefined) fail('invalid_input', `The run has no worker type ${unknown.workerType}.`)
  deps.cults.recordSynthesis(run.id, magos.chatId, args)
  const accepted = args.recommendations.filter((item) => item.decision === 'accepted').length
  return { draftRevision: args.draftRevision, accepted, rejected: args.recommendations.length - accepted }
}

export function createPlanForgeCouncil(deps: PlanForgeCouncilDeps): PlanForgeCouncil {
  const governs = (run: CultRunView): boolean => deps.cults.getCult(run.cultId)?.archetype === 'plan_forge'
  return {
    governs,
    async bind(run) {
      const epicId = deps.cults.getCult(run.cultId)?.targetEpicId ?? null
      if (!governs(run) || epicId === null) return
      const trace = await deps.workspaceFor(run.workDir).call('cultPlanTrace', epicId, null)
      deps.cults.bindPlanTarget(run.id, { epicId, savedRevision: trace.savedRevision, draftRevision: trace.draftRevision, eventSeq: trace.eventSeq })
    },
    async status(run) {
      if (!governs(run)) return null
      const { state, missingFixed, missingCreated } = await evaluate(deps, run)
      return { state, missingFixed, missingCreated }
    },
    async assertConclusion(run) {
      refuse(await evaluate(deps, run))
    },
    recordSynthesis: (run, magos, args) => recordSynthesis(deps, run, magos, args)
  }
}
