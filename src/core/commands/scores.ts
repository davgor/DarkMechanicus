import { COMMAND_SCHEMAS } from '../commandSchemas'
import { getRunEfficiency } from '../services/efficiency'
import { getGradingPolicy } from '../services/gradingPolicy'
import { getMetricsSummary } from '../services/metricsSummary'
import { recordEscapedDefects, recordHumanFeedback } from '../services/humanFeedback'
import { getEscapedDefects, getTicketPerformance } from '../services/performance'
import { getReportScorecard, reassessReportScorecard } from '../services/scorecards'
import { getEpicGrade, getRunGrade, getSprintGrade, getTicketGrade } from '../services/spaceGrades'
import { getSpaceSignals } from '../services/spaceSignals'
import { setTicketBudget } from '../services/ticketBudgets'
import { getRunTiming } from '../services/timing'
import type { CommandTable } from './types'

/** SPACE scorecard reads (each a core read model, unchanged) and the desktop's measurement controls. */
const scoreCommands = {
  getTicketGrade: {
    schema: COMMAND_SCHEMAS.getTicketGrade,
    mutates: false,
    run: (core, input) => getTicketGrade(core.ctx(), input)
  },
  getSprintGrade: {
    schema: COMMAND_SCHEMAS.getSprintGrade,
    mutates: false,
    run: (core, input) => getSprintGrade(core.ctx(), input)
  },
  getRunGrade: {
    schema: COMMAND_SCHEMAS.getRunGrade,
    mutates: false,
    run: (core, input) => getRunGrade(core.ctx(), input)
  },
  getEpicGrade: {
    schema: COMMAND_SCHEMAS.getEpicGrade,
    mutates: false,
    run: (core, input) => getEpicGrade(core.ctx(), input)
  },
  getReportScorecard: {
    schema: COMMAND_SCHEMAS.getReportScorecard,
    mutates: false,
    run: (core, input) => getReportScorecard(core.ctx(), input)
  },
  reassessReportScorecard: {
    schema: COMMAND_SCHEMAS.reassessReportScorecard,
    mutates: false,
    run: (core, input) => reassessReportScorecard(core.ctx(), input)
  },
  getSpaceSignals: {
    schema: COMMAND_SCHEMAS.getSpaceSignals,
    mutates: false,
    run: (core, input) => getSpaceSignals(core.ctx(), input)
  },
  getTicketPerformance: {
    schema: COMMAND_SCHEMAS.getTicketPerformance,
    mutates: false,
    run: (core, input) => getTicketPerformance(core.ctx(), input)
  },
  getEscapedDefects: {
    schema: COMMAND_SCHEMAS.getEscapedDefects,
    mutates: false,
    run: (core, input) => getEscapedDefects(core.ctx(), input)
  },
  getRunEfficiency: {
    schema: COMMAND_SCHEMAS.getRunEfficiency,
    mutates: false,
    run: (core, input) => getRunEfficiency(core.ctx(), input)
  },
  getRunTiming: {
    schema: COMMAND_SCHEMAS.getRunTiming,
    mutates: false,
    run: (core, input) => getRunTiming(core.ctx(), input)
  },
  getMetricsSummary: {
    schema: COMMAND_SCHEMAS.getMetricsSummary,
    mutates: false,
    run: (core, input) => getMetricsSummary(core.ctx(), input)
  },
  getGradingPolicy: {
    mutates: false,
    run: (core) => getGradingPolicy(core.ctx())
  },
  recordHumanFeedback: {
    schema: COMMAND_SCHEMAS.recordHumanFeedback,
    mutates: true,
    run: (core, input) => recordHumanFeedback(core.ctx(), input)
  },
  recordEscapedDefects: {
    schema: COMMAND_SCHEMAS.recordEscapedDefects,
    mutates: true,
    run: (core, input) => recordEscapedDefects(core.ctx(), input)
  },
  setTicketBudget: {
    schema: COMMAND_SCHEMAS.setTicketBudget,
    mutates: true,
    run: (core, input) => setTicketBudget(core.ctx(), input)
  }
} satisfies Partial<CommandTable>

export { scoreCommands }
