/**
 * Every mutation the epic workspace performs. Each action runs one or two commands through the
 * injected runner, marks the workspace busy meanwhile, asks the shell to refresh on success
 * (`onChanged`), always reloads (so conflicts pick up the latest draft), and reports the outcome
 * through reducer actions: a toast on success, the canvas banner or an inline notice on failure.
 */
import { acceptanceTitle } from '../../../core/plan/acceptance'
import type { StartOrchestratorResult } from '../../../shared/agents/chatApi'
import type { DraftOp } from '../../../shared/domain/api'
import type { PlanBundle } from '../../../shared/domain/bundle'
import type { ApproveWithRedraftResultView, DraftUpdateResultView, PlanView, RunView } from '../../../shared/domain/views'
import { followUpOp, type NextSprintItem } from '../checkpoint/gateView'
import type { NextSprintPlan } from '../checkpoint/nextSprint'
import { redraftRefusal, type RedraftRefusal } from '../checkpoint/redraftView'
import { dropTarget, type GraphModel } from '../graph/graphModel'
import { agentName } from '../agents/agentText'
import type { StartOrchestrator, StartRunChoice } from './orchestration'
import { failureOf, type Failure, type Runner } from './runner'
import { saveOutcome } from './validationView'
import type { WorkspaceAction, WorkspaceState } from './workspaceState'

export type Result<T> = { ok: true; value: T } | { ok: false; failure: Failure }

interface ActionDeps {
  runner: Runner
  epicId: string
  /** Starts an agent as the orchestrator of a new run (the run is queued with it). */
  startOrchestrator: StartOrchestrator
  /** A chat was created for a run: the shell fetches the folder's chats again. */
  onChatsChanged(): void
  getState(): WorkspaceState
  dispatch(action: WorkspaceAction): void
  reload(): void
  onChanged(): void
}

type RunCommandKind = 'pause' | 'resume' | 'cancel' | 'takeover'

export type ReviewInput =
  | { attemptId: string; decision: 'accept' }
  | { attemptId: string; decision: 'reject'; reason: string }
  | { attemptId: string; decision: 'abandon' }

export interface WorkspaceActions {
  perform<T>(task: () => Promise<T>): Promise<Result<T>>
  applyOps(ops: DraftOp[]): Promise<Result<DraftUpdateResultView>>
  editDraft(): Promise<void>
  discardDraft(): Promise<void>
  saveDraft(): Promise<void>
  /** Leave pending: queues the run for an external orchestrator, and closes the Start run dialog. */
  startRun(): Promise<void>
  /** Run with an agent: queues the run and starts the agent as its orchestrator in a chat, and closes the Start run dialog. */
  startRunWithAgent(choice: StartRunChoice): Promise<void>
  runCommand(kind: RunCommandKind): Promise<void>
  adopt(revisionId: string): Promise<void>
  connect(from: string, to: string): Promise<void>
  move(ticketId: string, sprintId: string): Promise<void>
  disconnect(from: string, to: string): Promise<void>
  /** A dragged card dropped at `top`: moves the ticket only when it lands in another sprint. */
  dropTicket(model: GraphModel, ticketId: string, top: number): Promise<void>
  addTicket(sprintId: string): Promise<void>
  /** Gives a draft sprint without one its acceptance node and selects it. */
  addAcceptance(sprintId: string): Promise<void>
  addSprint(): Promise<void>
  approve(reportId: string): Promise<void>
  /**
   * Saves the draft, adopts it into the run and approves the report in one step. Resolves with what refused it
   * (the step it stopped at and whether adoption is still needed), or null once it went through.
   */
  approveWithRedraft(reportId: string, expectedDraftRevision: number): Promise<RedraftRefusal | null>
  retry(ticketId: string): Promise<void>
  setAutoContinue(enabled: boolean): Promise<void>
  /** Puts a report follow-up, a retro discovery or a retro leftover into the draft's next sprint; resolves with whether that worked. */
  addFollowUp(item: NextSprintItem, checkpointOrdinal: number): Promise<boolean>
  review(input: ReviewInput): Promise<string | null>
}

const RUN_TOASTS: Record<RunCommandKind, string> = {
  pause: 'Run paused. Open attempts may still report.',
  resume: 'Run resumed.',
  cancel: 'Run canceled.',
  takeover: 'Run taken over. Reconcile expired attempts before resuming.'
}

function feedback(deps: ActionDeps, result: Result<unknown>, success: string): void {
  deps.dispatch(result.ok ? { type: 'toast', text: success } : { type: 'banner', text: result.failure.message })
}

async function perform<T>(deps: ActionDeps, task: () => Promise<T>): Promise<Result<T>> {
  deps.dispatch({ type: 'busy', value: true })
  try {
    const value = await task()
    deps.onChanged()
    return { ok: true, value }
  } catch (error: unknown) {
    return { ok: false, failure: failureOf(error) }
  } finally {
    deps.dispatch({ type: 'busy', value: false })
    deps.reload()
  }
}

function currentRun(deps: ActionDeps): RunView | null {
  return deps.getState().data?.run ?? null
}

function draftRevision(deps: ActionDeps): number | undefined {
  return deps.getState().data?.draft?.draftRevision ?? undefined
}

function runCommandFor(deps: ActionDeps, kind: RunCommandKind, runId: string): Promise<RunView> {
  const commands: Record<RunCommandKind, () => Promise<RunView>> = {
    pause: () => deps.runner('pauseRun', { runId }),
    resume: () => deps.runner('resumeRun', { runId }),
    cancel: () => deps.runner('cancelRun', { runId }),
    takeover: () => deps.runner('takeoverRun', { runId })
  }
  return commands[kind]()
}

function reviewCommand(deps: ActionDeps, input: ReviewInput): Promise<unknown> {
  switch (input.decision) {
    case 'accept':
      return deps.runner('acceptAttempt', { attemptId: input.attemptId })
    case 'reject':
      return deps.runner('rejectAttempt', { attemptId: input.attemptId, reasons: [input.reason] })
    case 'abandon':
      return deps.runner('reconcileAttempt', { attemptId: input.attemptId, resolution: 'abandon' })
  }
}

function approvalToast(run: RunView): string {
  return run.state === 'completed'
    ? 'Checkpoint approved — the epic is complete.'
    : `Checkpoint approved — Sprint ${run.activeSprintOrdinal ?? ''} started.`
}

/** "Retro and redraft approved — rev 5 adopted, Sprint 3 started." */
function redraftToast(result: ApproveWithRedraftResultView): string {
  if (result.advance.outcome === 'completed') {
    return 'Retro and redraft approved — the epic is complete.'
  }
  const adopted = result.adoption === null ? '' : ` rev ${result.save.revisionNumber} adopted,`
  return `Retro and redraft approved —${adopted} Sprint ${result.run.activeSprintOrdinal ?? ''} started.`
}

function draftActions(deps: ActionDeps): Pick<WorkspaceActions, 'editDraft' | 'discardDraft' | 'saveDraft'> {
  const epicId = deps.epicId
  return {
    async editDraft() {
      if (deps.getState().data?.epic.hasDraft === true) {
        deps.dispatch({ type: 'show_view', view: 'draft' })
        return
      }
      const result = await perform(deps, () => deps.runner('openDraft', { epicId }))
      deps.dispatch(result.ok ? { type: 'show_view', view: 'draft' } : { type: 'banner', text: result.failure.message })
    },
    async discardDraft() {
      deps.dispatch({ type: 'confirm', kind: null })
      const expected = draftRevision(deps)
      const result = await perform(deps, () => deps.runner('discardPlanDraft', { epicId, expectedDraftRevision: expected }))
      if (result.ok) {
        deps.dispatch({ type: 'draft_closed' })
      }
      feedback(deps, result, 'Draft discarded.')
    },
    async saveDraft() {
      const expected = draftRevision(deps)
      if (expected === undefined) {
        return
      }
      const result = await perform(deps, () => deps.runner('savePlan', { epicId, expectedDraftRevision: expected }))
      if (!result.ok) {
        deps.dispatch({ type: 'save_notice', notice: { tone: 'error', text: result.failure.message } })
        return
      }
      const outcome = saveOutcome(result.value)
      if (outcome.kind === 'pending') {
        deps.dispatch({ type: 'save_notice', notice: { tone: 'info', text: outcome.message } })
        return
      }
      deps.dispatch({ type: 'draft_closed' })
      deps.dispatch({ type: 'toast', text: outcome.message })
    }
  }
}

/** What starting an orchestrator came to: a toast when its chat is running, otherwise the banner says why it is not. */
function orchestratorFeedback(deps: ActionDeps, result: Result<StartOrchestratorResult>, choice: StartRunChoice): void {
  if (!result.ok) {
    deps.dispatch({ type: 'banner', text: result.failure.message })
    return
  }
  const { chat, problem } = result.value
  if (chat !== null) {
    deps.onChatsChanged()
  }
  if (problem === null) {
    deps.dispatch({ type: 'toast', text: `Run queued. ${agentName(choice.agent)} is orchestrating it.` })
  } else {
    deps.dispatch({ type: 'banner', text: problem })
  }
}

function runActions(deps: ActionDeps): Pick<WorkspaceActions, 'startRun' | 'startRunWithAgent' | 'runCommand' | 'adopt'> {
  const closeDialog = (): void => deps.dispatch({ type: 'start_run_dialog', open: false })
  return {
    async startRun() {
      const result = await perform(deps, () => deps.runner('queueRun', { epicId: deps.epicId }))
      closeDialog()
      feedback(deps, result, 'Run queued. It starts when an orchestrator picks it up.')
    },
    async startRunWithAgent(choice) {
      const result = await perform(deps, () => deps.startOrchestrator(choice))
      closeDialog()
      orchestratorFeedback(deps, result, choice)
    },
    async runCommand(kind) {
      const run = currentRun(deps)
      if (run === null) {
        return
      }
      feedback(deps, await perform(deps, () => runCommandFor(deps, kind, run.id)), RUN_TOASTS[kind])
    },
    async adopt(revisionId) {
      const run = currentRun(deps)
      if (run === null) {
        return
      }
      const result = await perform(deps, () => deps.runner('adoptRevision', { runId: run.id, revisionId }))
      feedback(deps, result, 'Revision adopted. The run continues on the new plan.')
    }
  }
}

function graphActions(
  deps: ActionDeps,
  applyOps: WorkspaceActions['applyOps']
): Pick<WorkspaceActions, 'connect' | 'move' | 'disconnect' | 'dropTicket' | 'addTicket' | 'addAcceptance' | 'addSprint'> {
  const edit = async (ops: DraftOp[]): Promise<void> => {
    const result = await applyOps(ops)
    deps.dispatch({ type: 'banner', text: result.ok ? null : result.failure.message })
  }
  return {
    async connect(from, to) {
      const result = await applyOps([{ op: 'add_dependency', from, to }])
      deps.dispatch(
        result.ok ? { type: 'banner', text: null } : { type: 'banner', text: result.failure.message, rejected: { from, to } }
      )
    },
    move: (ticketId, sprintId) => edit([{ op: 'move_ticket', ticket: ticketId, toSprint: sprintId }]),
    disconnect: (from, to) => edit([{ op: 'remove_dependency', from, to }]),
    async dropTicket(model, ticketId, top) {
      const target = dropTarget(model, ticketId, top)
      if (target !== null) {
        await edit([{ op: 'move_ticket', ticket: ticketId, toSprint: target }])
      }
    },
    async addTicket(sprintId) {
      const result = await applyOps([{ op: 'add_ticket', ref: 'new', sprint: sprintId, ticket: { title: 'New ticket' } }])
      deps.dispatch(
        result.ok
          ? { type: 'select_ticket', ticketId: result.value.refMap.new ?? null }
          : { type: 'banner', text: result.failure.message }
      )
    },
    async addAcceptance(sprintId) {
      const ordinal = deps.getState().data?.draft?.bundle.sprints.find((item) => item.id === sprintId)?.ordinal
      const title = ordinal === undefined ? 'Acceptance' : acceptanceTitle(ordinal)
      const ticket = { kind: 'acceptance' as const, title }
      const result = await applyOps([{ op: 'add_ticket', ref: 'new', sprint: sprintId, ticket }])
      deps.dispatch(
        result.ok
          ? { type: 'select_ticket', ticketId: result.value.refMap.new ?? null }
          : { type: 'banner', text: result.failure.message }
      )
    },
    addSprint: () => edit([{ op: 'add_sprint', sprint: { goal: '' } }])
  }
}

/** The approval of the retro and the redraft; resolves with what refused it, or null once it went through. */
async function approveWithRedraft(deps: ActionDeps, reportId: string, expectedDraftRevision: number): Promise<RedraftRefusal | null> {
  const run = currentRun(deps)
  if (run === null) {
    return null
  }
  const input = { runId: run.id, expectedDraftRevision, reportId }
  const result = await perform(deps, () => deps.runner('approveWithRedraft', input))
  if (!result.ok) {
    // The screen shows the refusal beside the approval, with its step, so it is not also a banner.
    return redraftRefusal(result.failure)
  }
  // As with a plain approval, the final one keeps the view open: it shows the completed epic's overview.
  if (result.value.advance.outcome !== 'completed') {
    deps.dispatch({ type: 'close_checkpoint' })
  }
  deps.dispatch({ type: 'toast', text: redraftToast(result.value) })
  return null
}

function checkpointActions(
  deps: ActionDeps
): Pick<WorkspaceActions, 'approve' | 'approveWithRedraft' | 'retry' | 'setAutoContinue'> {
  return {
    async approve(reportId) {
      const run = currentRun(deps)
      if (run === null) {
        return
      }
      const result = await perform(deps, () => deps.runner('approveAndAdvance', { runId: run.id, reportId }))
      // The final approval keeps the view open: once reloaded, it shows the completed epic's overview.
      if (result.ok && result.value.state !== 'completed') {
        deps.dispatch({ type: 'close_checkpoint' })
      }
      feedback(deps, result, result.ok ? approvalToast(result.value) : '')
    },
    approveWithRedraft: (reportId, expectedDraftRevision) => approveWithRedraft(deps, reportId, expectedDraftRevision),
    async retry(ticketId) {
      const run = currentRun(deps)
      if (run === null) {
        return
      }
      const result = await perform(deps, () => deps.runner('grantRetry', { runId: run.id, ticketId }))
      feedback(deps, result, 'Retry granted. The orchestrator can claim the ticket again.')
    },
    async setAutoContinue(enabled) {
      const run = currentRun(deps)
      if (run === null) {
        return
      }
      const result = await perform(deps, () => deps.runner('authorizeAutoContinue', { runId: run.id, enabled }))
      feedback(deps, result, enabled ? 'Automatic continuation allowed for this run.' : 'Automatic continuation turned off.')
    }
  }
}

async function ensureDraft(deps: ActionDeps): Promise<PlanView | null> {
  const draft = deps.getState().data?.draft ?? null
  if (draft !== null) {
    return draft
  }
  const result = await perform(deps, () => deps.runner('openDraft', { epicId: deps.epicId }))
  if (!result.ok) {
    deps.dispatch({ type: 'banner', text: result.failure.message })
    return null
  }
  return result.value
}

const NOT_PLACED = 'Could not place that in the draft: the ticket or the sprint it goes to is not in the draft.'

/** "DM-203, DM-204 and DM-205". */
function listed(keys: string[]): string {
  const last = keys.at(-1) ?? ''
  return keys.length < 2 ? last : `${keys.slice(0, -1).join(', ')} and ${last}`
}

/** What a checkpoint item did to the draft, or that the draft already had it. */
function nextSprintToast(item: NextSprintItem, plan: NextSprintPlan, draft: PlanBundle): string {
  const where = `Sprint ${plan.sprintOrdinal} of the draft`
  if (item.kind === 'leftover') {
    const key = draft.tickets.find((entry) => entry.id === item.ticketId)?.key ?? item.ticketId
    const [first = key, ...along] = plan.moved
    return plan.ops.length === 0
      ? `${key} is already in ${where}.`
      : `Moved ${first}${along.length === 0 ? '' : ` with ${listed(along)}`} to ${where}.`
  }
  if (plan.ops.length === 0) {
    return `"${item.title}" is already in ${where}.`
  }
  const added = plan.ops.some((op) => op.op === 'add_sprint') ? ' (a sprint added for it)' : ''
  return `Added "${item.title}" to ${where}${added}.`
}

async function addFollowUp(deps: ActionDeps, item: NextSprintItem, checkpointOrdinal: number): Promise<boolean> {
  const draft = await ensureDraft(deps)
  if (draft === null) {
    return false
  }
  const planned = followUpOp(item, draft.bundle, checkpointOrdinal)
  if (planned === null) {
    deps.dispatch({ type: 'banner', text: NOT_PLACED })
    return false
  }
  const toast = nextSprintToast(item, planned, draft.bundle)
  if (planned.ops.length === 0) {
    deps.dispatch({ type: 'toast', text: toast })
    return true
  }
  const expected = draft.draftRevision ?? undefined
  const result = await perform(deps, () =>
    deps.runner('updatePlanDraft', { epicId: deps.epicId, ops: planned.ops, expectedDraftRevision: expected })
  )
  feedback(deps, result, toast)
  return result.ok
}

export function createWorkspaceActions(deps: ActionDeps): WorkspaceActions {
  const applyOps: WorkspaceActions['applyOps'] = async (ops) => {
    const expected = draftRevision(deps)
    const result = await perform(deps, () =>
      deps.runner('updatePlanDraft', { epicId: deps.epicId, ops, expectedDraftRevision: expected })
    )
    if (result.ok) {
      deps.dispatch({ type: 'validation', report: result.value.validation })
    }
    return result
  }
  return {
    perform: (task) => perform(deps, task),
    applyOps,
    ...draftActions(deps),
    ...runActions(deps),
    ...graphActions(deps, applyOps),
    ...checkpointActions(deps),
    addFollowUp: (proposal, ordinal) => addFollowUp(deps, proposal, ordinal),
    async review(input) {
      const result = await perform(deps, () => reviewCommand(deps, input))
      return result.ok ? null : result.failure.message
    }
  }
}
