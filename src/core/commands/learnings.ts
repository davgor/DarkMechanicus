import { COMMAND_SCHEMAS } from '../commandSchemas'
import { getStagedLearningDrafts } from '../services/learningPublication'
import { getLearning, listLearnings, replaceLearning, retireLearning } from '../services/learnings'
import type { CommandTable } from './types'

/** Published learnings: every role reads them; only the person at the desktop retires or replaces one. */
const learningCommands = {
  listLearnings: { schema: COMMAND_SCHEMAS.listLearnings, mutates: false, run: (core, input) => listLearnings(core.ctx(), input) },
  getLearning: { schema: COMMAND_SCHEMAS.getLearning, mutates: false, run: (core, input) => getLearning(core.ctx(), input) },
  getStagedLearningDrafts: {
    schema: COMMAND_SCHEMAS.getStagedLearningDrafts,
    mutates: false,
    run: (core, input) => getStagedLearningDrafts(core.ctx(), input)
  },
  retireLearning: { schema: COMMAND_SCHEMAS.retireLearning, mutates: true, run: (core, input) => retireLearning(core.ctx(), input) },
  replaceLearning: { schema: COMMAND_SCHEMAS.replaceLearning, mutates: true, run: (core, input) => replaceLearning(core.ctx(), input) }
} satisfies Partial<CommandTable>

export { learningCommands }
