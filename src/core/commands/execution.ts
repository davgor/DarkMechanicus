import { verifyTicketIntegration } from '../services/deliveryWorkflow'
import type { RecordDeliveryInput, SubmitAttemptInput } from '../../shared/domain/api'
import type { ReadinessView, RunView, SprintIncrement } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import type { Ctx } from '../context'
import { fail } from '../errors'
import { filePaths, withKnowledgeContext } from '../knowledge/push'
import { adoptRevision } from '../services/adoption'
import {
  acceptAttempt,
  carryForwardTicket,
  claimTicket,
  failAttempt,
  heartbeatAttempt,
  reconcileAttempt,
  rejectAttempt,
  submitAttempt
} from '../services/attempts'
import { getCheckpoint } from '../services/checkpoints'
import { deliveryContextOf, recordDelivery } from '../services/deliveries'
import { verifyDelivery } from '../services/deliveryVerify'
import { loadRunContext, runExecution } from '../services/execution'
import { matchCapabilities, registerHost } from '../services/hosts'
import { isRepositoryFolder } from '../services/epicBranches'
import { incrementContextOf, repositoryIncrementsOf } from '../services/increments'
import { verifyIncrement, verifyRepositoryIncrements } from '../services/incrementVerify'
import { recordRowCheck } from '../services/rowChecks'
import { readInstalledApp } from '../installedApp'
import {
  cancelRun,
  getRun,
  pauseRun,
  queueRun,
  resumeRun,
  startRun,
  takeoverRun
} from '../services/runs'
import type { CommandTable, WorkspaceCore } from './types'

/** Adds the checkpoint gate view to runs that are executing or waiting at a checkpoint. */
function withCheckpoint(ctx: Ctx, run: RunView | null): RunView | null {
  if (!run || run.activeSprintId === null) {
    return run
  }
  const gated = run.state === 'running' || run.state === 'awaiting_checkpoint'
  return gated ? { ...run, checkpoint: getCheckpoint(ctx, { runId: run.id }) } : run
}

export function requireRunView(ctx: Ctx, runId: string): RunView {
  const run = withCheckpoint(ctx, getRun(ctx, { runId }))
  if (!run) {
    fail('not_found', `Run ${runId} not found.`)
  }
  return run
}

function readiness(ctx: Ctx, runId: string): ReadinessView {
  requireCapability(ctx.session, 'read')
  const { run } = loadRunContext(ctx, runId)
  const snapshot = runExecution(ctx, runId)
  const active = snapshot.tickets.filter((ticket) => ticket.sprintId === run.active_sprint_id)
  const claimable = (ticket: (typeof active)[number]): boolean =>
    ticket.state === 'ready' && ticket.blockers.length === 0
  return {
    runId,
    sprintId: run.active_sprint_id,
    ready: active.filter(claimable),
    blocked: active.filter(
      (ticket) =>
        !claimable(ticket) &&
        ticket.state !== 'accepted' &&
        ticket.state !== 'running' &&
        ticket.state !== 'submitted'
    ),
    inFlight: active.filter((ticket) => ticket.state === 'running' || ticket.state === 'submitted'),
    rows: snapshot.rows.filter((item) => item.sprintId === run.active_sprint_id),
    capacity: snapshot.capacity
  }
}

/**
 * The server's verdict on the increment a submission names, asked of git before the submission is stored
 * (the store is synchronous, git is not). Undefined when the attempt is not on an acceptance node, or the
 * increments are refused, which the submission then refuses. Read-only: nothing in the repository changes.
 * A folder of repositories' `increments` are verified one per repository, each with that repository's adapter.
 */
interface IncrementProof {
  verdict: SprintIncrement | SprintIncrement[]
  assertCurrent?(): void
}

async function verifiedIncrement(core: WorkspaceCore, input: SubmitAttemptInput): Promise<IncrementProof | undefined> {
  requireCapability(core.ctx().session, 'attempt.submit')
  if (input.increments !== undefined) {
    const entries = repositoryIncrementsOf(core.ctx(), input.attemptId, input.increments)
    return entries === null ? undefined : { verdict: await verifyRepositoryIncrements((repo) => core.gitFor(repo), entries, core.clock.nowIso()) }
  }
  const { increment } = input
  // A folder of repositories refuses a single increment; git is not asked about it.
  if (increment === undefined || isRepositoryFolder(core.ctx())) {
    return undefined
  }
  const context = incrementContextOf(core.ctx(), input.attemptId)
  if (context === null) return undefined
  const git = core.gitFor(null)
  const verdict = await verifyIncrement(git, context, increment, core.clock.nowIso())
  return { verdict, assertCurrent: git.assertCurrent }
}

/**
 * The installed build a delivery's `Installed app version` check reads: the desktop's own observation on this machine
 * when it recorded one, else this session's serverInfo, which any process can claim; null when neither exists.
 */
function installedBuild(core: WorkspaceCore): { version: string; packaged: boolean; source: string } | null {
  const observed = readInstalledApp(core.ctx())
  if (observed !== null) {
    return { version: observed.version, packaged: observed.packaged, source: `the desktop app's observation of ${observed.observedAt}` }
  }
  const info = core.options.serverInfo
  return info === undefined
    ? null
    : { version: info.version, packaged: info.packaged ?? false, source: "the recording session's serverInfo; the desktop app recorded no observation on this machine" }
}

/**
 * Applies every refusal, then asks git about the delivery outside any transaction, as increment verification does,
 * with the code repository's adapter (in Forge mode the code checkout, not the project folder).
 */
async function verifiedDelivery(core: WorkspaceCore, input: RecordDeliveryInput) {
  const context = deliveryContextOf(core.ctx(), input)
  const git = core.gitFor(null)
  const claim = {
    commit: input.commit,
    ...(input.releaseTag === undefined ? {} : { releaseTag: input.releaseTag }),
    ...(input.observedInstalledVersion === undefined ? {} : { observedInstalledVersion: input.observedInstalledVersion })
  }
  const verdict = await verifyDelivery(git, { delivery: context.delivery, increment: context.increment, installed: installedBuild(core) }, claim, core.clock.nowIso())
  return { increment: context.increment.commit, verdict, ...(git.assertCurrent === undefined ? {} : { assertCurrent: git.assertCurrent }) }
}

const executionCommands = {
  registerHost: {
    schema: COMMAND_SCHEMAS.registerHost,
    mutates: true,
    run: (core, input) => registerHost(core.ctx(), input)
  },
  matchCapabilities: {
    schema: COMMAND_SCHEMAS.matchCapabilities,
    mutates: false,
    run: (core, input) => matchCapabilities(core.ctx(), input)
  },
  queueRun: {
    schema: COMMAND_SCHEMAS.queueRun,
    mutates: true,
    run: (core, input) => {
      const run = queueRun(core.ctx(), input)
      return requireRunView(core.ctx(), run.id)
    }
  },
  startRun: {
    schema: COMMAND_SCHEMAS.startRun,
    mutates: true,
    run: (core, input) => {
      const run = startRun(core.ctx(), input)
      return withKnowledgeContext(core, requireRunView(core.ctx(), run.id), 'run.started')
    }
  },
  getRun: {
    schema: COMMAND_SCHEMAS.getRun,
    mutates: false,
    run: (core, input) => withCheckpoint(core.ctx(), getRun(core.ctx(), input))
  },
  getReadyTickets: {
    schema: COMMAND_SCHEMAS.getReadyTickets,
    mutates: true,
    run: (core, input) => readiness(core.ctx(), input.runId)
  },
  claimTicket: {
    schema: COMMAND_SCHEMAS.claimTicket,
    mutates: true,
    run: (core, input) => {
      const claim = claimTicket(core.ctx(), input)
      const ticket = claim.packet.ticket
      const event = ticket.kind === 'acceptance' ? 'acceptance.claimed' : 'ticket.claimed'
      return withKnowledgeContext(core, claim, event, filePaths(ticket.references))
    }
  },
  heartbeatAttempt: {
    schema: COMMAND_SCHEMAS.heartbeatAttempt,
    mutates: true,
    run: (core, input) => heartbeatAttempt(core.ctx(), input)
  },
  submitAttempt: {
    schema: COMMAND_SCHEMAS.submitAttempt,
    mutates: true,
    run: async (core, input) => {
      const proof = await verifiedIncrement(core, input)
      return submitAttempt(core.ctx(), input, proof?.verdict, proof?.assertCurrent)
    }
  },
  acceptAttempt: {
    schema: COMMAND_SCHEMAS.acceptAttempt,
    mutates: true,
    run: async (core, input) => {
      const ctx = core.ctx()
      requireCapability(ctx.session, 'attempt.review')
      const verified = await verifyTicketIntegration(ctx, input.attemptId, input.integration)
      return withKnowledgeContext(core, acceptAttempt(ctx, input, verified.passed, verified.assertCurrent), 'attempt.accepted')
    }
  },
  rejectAttempt: {
    schema: COMMAND_SCHEMAS.rejectAttempt,
    mutates: true,
    run: (core, input) => withKnowledgeContext(core, rejectAttempt(core.ctx(), input), 'attempt.rejected')
  },
  failAttempt: {
    schema: COMMAND_SCHEMAS.failAttempt,
    mutates: true,
    run: (core, input) => withKnowledgeContext(core, failAttempt(core.ctx(), input), 'attempt.failed')
  },
  reconcileAttempt: {
    schema: COMMAND_SCHEMAS.reconcileAttempt,
    mutates: true,
    run: (core, input) => reconcileAttempt(core.ctx(), input)
  },
  carryForwardTicket: {
    schema: COMMAND_SCHEMAS.carryForwardTicket,
    mutates: true,
    run: (core, input) => carryForwardTicket(core.ctx(), input)
  },
  recordRowCheck: {
    schema: COMMAND_SCHEMAS.recordRowCheck,
    mutates: true,
    run: async (core, input) => {
      const check = recordRowCheck(core.ctx(), input)
      return check.passed ? check : withKnowledgeContext(core, check, 'row_check.failed')
    }
  },
  recordDelivery: {
    schema: COMMAND_SCHEMAS.recordDelivery,
    mutates: true,
    run: async (core, input) => recordDelivery(core.ctx(), input, await verifiedDelivery(core, input))
  },
  pauseRun: {
    schema: COMMAND_SCHEMAS.pauseRun,
    mutates: true,
    run: (core, input) => {
      pauseRun(core.ctx(), input)
      return requireRunView(core.ctx(), input.runId)
    }
  },
  resumeRun: {
    schema: COMMAND_SCHEMAS.resumeRun,
    mutates: true,
    run: (core, input) => {
      resumeRun(core.ctx(), input)
      return requireRunView(core.ctx(), input.runId)
    }
  },
  cancelRun: {
    schema: COMMAND_SCHEMAS.cancelRun,
    mutates: true,
    run: (core, input) => {
      cancelRun(core.ctx(), input)
      return requireRunView(core.ctx(), input.runId)
    }
  },
  takeoverRun: {
    schema: COMMAND_SCHEMAS.takeoverRun,
    mutates: true,
    run: (core, input) => {
      takeoverRun(core.ctx(), input)
      return withKnowledgeContext(core, requireRunView(core.ctx(), input.runId), 'run.recovery')
    }
  },
  adoptRevision: {
    schema: COMMAND_SCHEMAS.adoptRevision,
    mutates: true,
    run: (core, input) => {
      adoptRevision(core.ctx(), input)
      return withKnowledgeContext(core, requireRunView(core.ctx(), input.runId), 'run.recovery')
    }
  }
} satisfies Partial<CommandTable>

export { executionCommands }
