import type { IncrementRef, SubmitAttemptInput } from '../../shared/domain/api'
import type { ReadinessView, RunView, SprintIncrement } from '../../shared/domain/views'
import { requireCapability } from '../authz'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import type { Ctx } from '../context'
import { fail } from '../errors'
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
import { expireLeases, loadRunContext, runExecution } from '../services/execution'
import { matchCapabilities, registerHost } from '../services/hosts'
import { incrementContextOf } from '../services/increments'
import { verifyIncrement } from '../services/incrementVerify'
import { recordRowCheck } from '../services/rowChecks'
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
  ctx.db.tx(() => expireLeases(ctx, runId))
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
 * (the store is synchronous, git is not). Undefined when the attempt is not on an acceptance node, which the
 * submission then refuses. Read-only: nothing in the repository changes.
 */
async function verifiedIncrement(
  core: WorkspaceCore,
  input: SubmitAttemptInput & { increment: IncrementRef }
): Promise<SprintIncrement | undefined> {
  requireCapability(core.ctx().session, 'attempt.submit')
  const context = incrementContextOf(core.ctx(), input.attemptId)
  return context === null ? undefined : verifyIncrement(core.git, context, input.increment, core.clock.nowIso())
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
      return requireRunView(core.ctx(), run.id)
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
    run: (core, input) => claimTicket(core.ctx(), input)
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
      const verdict = input.increment === undefined ? undefined : await verifiedIncrement(core, { ...input, increment: input.increment })
      return submitAttempt(core.ctx(), input, verdict)
    }
  },
  acceptAttempt: {
    schema: COMMAND_SCHEMAS.acceptAttempt,
    mutates: true,
    run: (core, input) => acceptAttempt(core.ctx(), input)
  },
  rejectAttempt: {
    schema: COMMAND_SCHEMAS.rejectAttempt,
    mutates: true,
    run: (core, input) => rejectAttempt(core.ctx(), input)
  },
  failAttempt: {
    schema: COMMAND_SCHEMAS.failAttempt,
    mutates: true,
    run: (core, input) => failAttempt(core.ctx(), input)
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
    run: (core, input) => recordRowCheck(core.ctx(), input)
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
      return requireRunView(core.ctx(), input.runId)
    }
  },
  adoptRevision: {
    schema: COMMAND_SCHEMAS.adoptRevision,
    mutates: true,
    run: (core, input) => {
      adoptRevision(core.ctx(), input)
      return requireRunView(core.ctx(), input.runId)
    }
  }
} satisfies Partial<CommandTable>

export { executionCommands }
