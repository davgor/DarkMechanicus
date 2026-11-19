import { COMMAND_SCHEMAS } from '../commandSchemas'
import { getRunMetrics, recordAttemptMetrics, recordRunMetrics } from '../services/metricReports'
import { getPlannedBaselines } from '../services/plannedBaselines'
import type { CommandTable } from './types'

const metricCommands = {
  recordAttemptMetrics: {
    schema: COMMAND_SCHEMAS.recordAttemptMetrics,
    mutates: true,
    run: (core, input) => recordAttemptMetrics(core.ctx(), input)
  },
  recordRunMetrics: {
    schema: COMMAND_SCHEMAS.recordRunMetrics,
    mutates: true,
    run: (core, input) => recordRunMetrics(core.ctx(), input)
  },
  getRunMetrics: {
    schema: COMMAND_SCHEMAS.getRunMetrics,
    mutates: false,
    run: (core, input) => getRunMetrics(core.ctx(), input)
  },
  getPlannedBaselines: {
    schema: COMMAND_SCHEMAS.getPlannedBaselines,
    mutates: false,
    run: (core, input) => getPlannedBaselines(core.ctx(), input)
  }
} satisfies Partial<CommandTable>

export { metricCommands }
