import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { COMMAND_SCHEMAS } from '../../core/commandSchemas'
import { HUMAN_QUESTION_GUIDANCE } from '../../core/humanQuestions'
import type { CommandApi } from '../../shared/domain/api'
import { defineSchemaTool, registerTools } from './define'

export function registerQuestionTools(server: McpServer, api: CommandApi): void {
  registerTools(server, api, [
    defineSchemaTool({ name: 'ask_human', description: HUMAN_QUESTION_GUIDANCE, kind: 'external',
      schema: COMMAND_SCHEMAS.askHuman, run: (target, args) => target.askHuman(args) }),
    defineSchemaTool({ name: 'get_human_answer', description: 'Read delivery state and the paired human’s reply to a question by its returned questionId.',
      kind: 'read', schema: COMMAND_SCHEMAS.getHumanAnswer, run: (target, args) => target.getHumanAnswer(args) })
  ])
}
