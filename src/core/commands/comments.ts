import { COMMAND_SCHEMAS } from '../commandSchemas'
import { addComment, listComments } from '../services/comments'
import type { CommandTable } from './types'

const commentCommands = {
  addComment: {
    schema: COMMAND_SCHEMAS.addComment,
    mutates: true,
    run: (core, input) => addComment(core.ctx(), input)
  },
  listComments: {
    schema: COMMAND_SCHEMAS.listComments,
    mutates: false,
    run: (core, input) => listComments(core.ctx(), input)
  }
} satisfies Partial<CommandTable>

export { commentCommands }
