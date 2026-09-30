/**
 * Every mutation the epic workspace performs. Each action runs one or two commands through the
 * injected runner, marks the workspace busy meanwhile, asks the shell to refresh on success
 * (`onChanged`), always reloads (so conflicts pick up the latest draft), and reports the outcome
 * through reducer actions: a toast on success, the canvas banner or an inline notice on failure.
 */
import type { DraftOp } from '../../../shared/domain/api'
import type { DraftUpdateResultView, FollowUpProposal, PlanView, RunView } from '../../../shared/domain/views'
import { followUpOp } from '../checkpoint/gateView'
import { failureOf, type Failure, type Runner } from './runner'
import { saveOutcome } from './validationView'
import type { WorkspaceAction, WorkspaceState } from './workspaceState'

export type Result<T> = { ok: true; value: T } | { ok: false; failure: Failure }

export interface ActionDeps {
  runner: Runner
  epicId: string
  getState(): WorkspaceState
  dispatch(action: WorkspaceAction): void
  reload(): void
  onChanged(): void
}

export type RunCommandKind = 'pause' | 'resume' | 'cancel' | 'takeover'

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
  startRun(): Promise<void>
  runCommand(kind: RunCommandKind): Promise<void>
  adopt(revisionId: string): Promise<void>
  connect(from: string, to: string): Promise<void>
  move(ticketId: string, sprintId: string): Promise<void>
  disconnect(from: string, to: string): Promise<void>
  addTicket(sprintId: string): Promise<void>
  addSprint(): Promise<void>
  approve(reportId: string): Promise<void>
  retry(ticketId: string): Promise<void>
  setAutoContinue(enabled: boolean): Promise<void>
  addFollowUp(proposal: FollowUpProposal, checkpointOrdinal: number): Promise<boolean>
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
        deps.dispatch({ type: 'show_view', view: 'saved' })
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
      deps.dispatch({ type: 'show_view', view: 'saved' })
      deps.dispatch({ type: 'toast', text: outcome.message })
    }
  }
}

function runActions(deps: ActionDeps): Pick<WorkspaceActions, 'startRun' | 'runCommand' | 'adopt'> {
  return {
    async startRun() {
      const result = await perform(deps, () => deps.runner('queueRun', { epicId: deps.epicId }))
      feedback(deps, result, 'Run queued. It starts when an orchestrator picks it up.')
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
): Pick<WorkspaceActions, 'connect' | 'move' | 'disconnect' | 'addTicket' | 'addSprint'> {
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
    async addTicket(sprintId) {
      const result = await applyOps([{ op: 'add_ticket', ref: 'new', sprint: sprintId, ticket: { title: 'New ticket' } }])
      deps.dispatch(
        result.ok
          ? { type: 'select_ticket', ticketId: result.value.refMap.new ?? null }
          : { type: 'banner', text: result.failure.message }
      )
    },
    addSprint: () => edit([{ op: 'add_sprint', sprint: { goal: '' } }])
  }
}

function checkpointActions(deps: ActionDeps): Pick<WorkspaceActions, 'approve' | 'retry' | 'setAutoContinue'> {
  return {
    async approve(reportId) {
      const run = currentRun(deps)
      if (run === null) {
        return
      }
      const result = await perform(deps, () => deps.runner('approveAndAdvance', { runId: run.id, reportId }))
      if (result.ok) {
        deps.dispatch({ type: 'close_checkpoint' })
      }
      feedback(deps, result, result.ok ? approvalToast(result.value) : '')
    },
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

async function addFollowUp(deps: ActionDeps, proposal: FollowUpProposal, checkpointOrdinal: number): Promise<boolean> {
  const draft = await ensureDraft(deps)
  const planned = draft === null ? null : followUpOp(proposal, draft.bundle, checkpointOrdinal)
  if (draft === null || planned === null) {
    return false
  }
  const expected = draft.draftRevision ?? undefined
  const result = await perform(deps, () =>
    deps.runner('updatePlanDraft', { epicId: deps.epicId, ops: [planned.op], expectedDraftRevision: expected })
  )
  feedback(deps, result, `Added "${proposal.title}" to Sprint ${planned.sprintOrdinal} of the draft.`)
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
