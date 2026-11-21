import { askHuman, humanAnswer } from '../humanQuestions'
import { requireCapability } from '../authz'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { fail } from '../errors'
import type { CommandTable, WorkspaceCore } from './types'

function authorize(core: WorkspaceCore): void {
  if (core.isInitialized()) requireCapability(core.ctx().session, 'human.ask')
  else if (!core.roleCapabilities().includes('human.ask')) fail('unauthorized', 'This session cannot ask the human.')
}

export const questionCommands = {
  askHuman: {
    schema: COMMAND_SCHEMAS.askHuman, mutates: false, beforeInit: true,
    run(core, { question }) {
      authorize(core)
      return askHuman(core.homeDir, core.repoRoot, question)
    }
  },
  getHumanAnswer: {
    schema: COMMAND_SCHEMAS.getHumanAnswer, mutates: false, beforeInit: true,
    run(core, { questionId }) {
      authorize(core)
      return humanAnswer(core.homeDir, core.repoRoot, questionId)
    }
  }
} satisfies Partial<CommandTable>
