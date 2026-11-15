import { requireCapability } from '../authz'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { DomainError } from '../errors'
import type { CommandTable } from './types'

export const chatNamingCommands = {
  nameChat: {
    schema: COMMAND_SCHEMAS.nameChat,
    mutates: false,
    run: async (core, input) => {
      requireCapability(core.ctx().session, 'chat.name')
      const reply = await core.desktopClient.request({ op: 'name_chat', args: input })
      if (!reply.ok) throw new DomainError(reply.error.code, reply.error.message)
      return reply.data
    }
  }
} satisfies Partial<CommandTable>
