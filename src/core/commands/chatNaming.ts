import { requireCapability } from '../authz'
import { COMMAND_SCHEMAS } from '../commandSchemas'
import { DomainError } from '../errors'
import { toolingRecoveryResultSchema } from '../../shared/agents/toolingRecovery'
import type { CommandTable } from './types'

export const chatNamingCommands = {
  nameChat: {
    schema: COMMAND_SCHEMAS.nameChat,
    mutates: false,
    run: async (core, input) => {
      requireCapability(core.ctx().session, 'chat.name')
      const reply = await core.desktopClient.request({ op: 'name_chat', args: input })
      if (!reply.ok) throw new DomainError(reply.error.code, reply.error.message)
      if (!('applied' in reply.data)) throw new DomainError('internal_error', 'Unexpected desktop naming reply.')
      return reply.data
    }
  },
  recoverTooling: {
    schema: COMMAND_SCHEMAS.recoverTooling,
    mutates: false,
    run: async (core, input) => {
      requireCapability(core.ctx().session, 'tooling.recover')
      const reply = await core.desktopClient.request({ op: 'recover_tooling', args: input })
      if (!reply.ok) throw new DomainError(reply.error.code, reply.error.message)
      return toolingRecoveryResultSchema.parse(reply.data)
    }
  }
} satisfies Partial<CommandTable>
