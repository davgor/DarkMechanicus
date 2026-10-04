import { COMMAND_SCHEMAS } from '../commandSchemas'
import type { Ctx } from '../context'
import { approveWithRedraft } from '../services/approveRedraft'
import {
  advanceSprint,
  approveAndAdvance,
  approveCheckpoint,
  authorizeAutoContinue,
  getCheckpoint,
  grantRetry
} from '../services/checkpoints'
import { expireLeases } from '../services/execution'
import { redraftNextSprint } from '../services/redraft'
import { getSprintReport, submitSprintReport } from '../services/reports'
import { requireRunView } from './execution'
import type { CommandTable } from './types'

/** Gates read attempt states as stored, so overdue leases are expired before evaluating them. */
function swept(ctx: Ctx, runId: string): Ctx {
  ctx.db.tx(() => expireLeases(ctx, runId))
  return ctx
}

const checkpointCommands = {
  redraftNextSprint: {
    schema: COMMAND_SCHEMAS.redraftNextSprint,
    mutates: true,
    run: (core, input) => redraftNextSprint(core.ctx(), input)
  },
  submitSprintReport: {
    schema: COMMAND_SCHEMAS.submitSprintReport,
    mutates: true,
    run: (core, input) => submitSprintReport(core.ctx(), input)
  },
  getSprintReport: {
    schema: COMMAND_SCHEMAS.getSprintReport,
    mutates: false,
    run: (core, input) => getSprintReport(core.ctx(), input)
  },
  getCheckpoint: {
    schema: COMMAND_SCHEMAS.getCheckpoint,
    mutates: true,
    run: (core, input) => getCheckpoint(swept(core.ctx(), input.runId), input)
  },
  approveCheckpoint: {
    schema: COMMAND_SCHEMAS.approveCheckpoint,
    mutates: true,
    run: (core, input) => approveCheckpoint(swept(core.ctx(), input.runId), input)
  },
  advanceSprint: {
    schema: COMMAND_SCHEMAS.advanceSprint,
    mutates: true,
    run: (core, input) => {
      advanceSprint(swept(core.ctx(), input.runId), input)
      return requireRunView(core.ctx(), input.runId)
    }
  },
  approveAndAdvance: {
    schema: COMMAND_SCHEMAS.approveAndAdvance,
    mutates: true,
    run: (core, input) => {
      approveAndAdvance(swept(core.ctx(), input.runId), input)
      return requireRunView(core.ctx(), input.runId)
    }
  },
  approveWithRedraft: {
    schema: COMMAND_SCHEMAS.approveWithRedraft,
    mutates: true,
    run: (core, input) => {
      // The flush completes the save (snapshot written, revision made current) before adoption reads it.
      const outcome = approveWithRedraft(core.ctx(), input, () => core.safeFlush())
      return { ...outcome, run: requireRunView(core.ctx(), input.runId) }
    }
  },
  authorizeAutoContinue: {
    schema: COMMAND_SCHEMAS.authorizeAutoContinue,
    mutates: true,
    run: (core, input) => {
      authorizeAutoContinue(core.ctx(), input)
      return requireRunView(core.ctx(), input.runId)
    }
  },
  grantRetry: {
    schema: COMMAND_SCHEMAS.grantRetry,
    mutates: true,
    run: (core, input) => {
      grantRetry(core.ctx(), input)
      return requireRunView(core.ctx(), input.runId)
    }
  }
} satisfies Partial<CommandTable>

export { checkpointCommands }
