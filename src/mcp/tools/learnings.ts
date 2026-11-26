import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { COMMAND_SCHEMAS } from '../../core/commandSchemas'
import type { CommandApi } from '../../shared/domain/api'
import { defineTool, registerTools } from './define'

/** Read-only: retiring and replacing a learning is the person's act at the desktop, so no tool offers it. */
const LEARNING_TOOLS = [
  defineTool({
    name: 'list_learnings',
    description:
      'Lists published learnings (prevention rules people approved), newest first, with their rule, check, applicability, cited evidence, source run/sprint/card/attempt, lifecycle and revision. Active ones by default; pass state retired or all to see retired ones. query keeps learnings whose content, source ids or history reasons contain every word.',
    kind: 'read',
    input: COMMAND_SCHEMAS.listLearnings.shape,
    run: (api, input) => api.listLearnings(input)
  }),
  defineTool({
    name: 'get_learning',
    description:
      'Returns one learning with its append-only history: who published, retired or replaced it, why, the revision after each change, and the linked predecessor or successor. Fails with `not_found` for an unknown id.',
    kind: 'read',
    input: COMMAND_SCHEMAS.getLearning.shape,
    run: (api, input) => api.getLearning(input)
  }),
  defineTool({
    name: 'get_staged_learning_drafts',
    description:
      "Returns the learning drafts a sprint learning card's attempt staged for review: each proposed rule, check and applicability, the drafts hash a person approves, and the cited sprint evidence quoted verbatim. Staged drafts grant nothing until a person approves the card. Fails with `invalid_state` when the attempt staged none.",
    kind: 'read',
    input: COMMAND_SCHEMAS.getStagedLearningDrafts.shape,
    run: (api, input) => api.getStagedLearningDrafts(input)
  })
]

export function registerLearningTools(server: McpServer, api: CommandApi): void {
  registerTools(server, api, LEARNING_TOOLS)
}
