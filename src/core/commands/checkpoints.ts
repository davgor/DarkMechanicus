import { COMMAND_SCHEMAS } from '../commandSchemas'
import {
  advanceSprint,
  approveAndAdvance,
  approveCheckpoint,
  authorizeAutoContinue,
  getCheckpoint,
  grantRetry
} from '../services/checkpoints'
import { getSprintReport, submitSprintReport } from '../services/reports'
import { requireRunView } from './execution'
import type { CommandTable } from './types'

export const checkpointCommands = {
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
    mutates: false,
    run: (core, input) => getCheckpoint(core.ctx(), input)
  },
  approveCheckpoint: {
    schema: COMMAND_SCHEMAS.approveCheckpoint,
    mutates: true,
    run: (core, input) => approveCheckpoint(core.ctx(), input)
  },
  advanceSprint: {
    schema: COMMAND_SCHEMAS.advanceSprint,
    mutates: true,
    run: (core, input) => {
      advanceSprint(core.ctx(), input)
      return requireRunView(core.ctx(), input.runId)
    }
  },
  approveAndAdvance: {
    schema: COMMAND_SCHEMAS.approveAndAdvance,
    mutates: true,
    run: (core, input) => {
      approveAndAdvance(core.ctx(), input)
      return requireRunView(core.ctx(), input.runId)
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
