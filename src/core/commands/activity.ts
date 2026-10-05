import { COMMAND_SCHEMAS } from '../commandSchemas'
import { getAttemptTimeline, getRunTimeline } from '../services/activity'
import type { CommandTable } from './types'

const activityCommands = {
  getAttemptTimeline: {
    schema: COMMAND_SCHEMAS.getAttemptTimeline,
    mutates: false,
    run: (core, input) => getAttemptTimeline(core.ctx(), input)
  },
  getRunTimeline: {
    schema: COMMAND_SCHEMAS.getRunTimeline,
    mutates: false,
    run: (core, input) => getRunTimeline(core.ctx(), input)
  }
} satisfies Partial<CommandTable>

export { activityCommands }
