import { COMMAND_SCHEMAS } from '../commandSchemas'
import {
  acknowledgeAgentMessages,
  getAgentIdentity,
  getAgentMailStatus,
  listAgentPeers,
  readAgentInbox,
  sendAgentMessage
} from '../services/agentMail'
import type { CommandTable } from './types'

/**
 * Agent mail. Every write here is local-only (nothing portable to flush), so each declares `mutates: false` and runs
 * its own service transaction; that flag skips the portable flush and branch guard, and authorizes nothing.
 */
const agentMailCommands = {
  getAgentIdentity: {
    schema: COMMAND_SCHEMAS.getAgentIdentity,
    mutates: false,
    run: (core) => getAgentIdentity(core.ctx())
  },
  listAgentPeers: {
    schema: COMMAND_SCHEMAS.listAgentPeers,
    mutates: false,
    run: (core, input) => listAgentPeers(core.ctx(), input)
  },
  sendAgentMessage: {
    schema: COMMAND_SCHEMAS.sendAgentMessage,
    mutates: false,
    run: (core, input) => sendAgentMessage(core.ctx(), input)
  },
  readAgentInbox: {
    schema: COMMAND_SCHEMAS.readAgentInbox,
    mutates: false,
    run: (core, input) => readAgentInbox(core.ctx(), input)
  },
  acknowledgeAgentMessages: {
    schema: COMMAND_SCHEMAS.acknowledgeAgentMessages,
    mutates: false,
    run: (core, input) => acknowledgeAgentMessages(core.ctx(), input)
  },
  getAgentMailStatus: {
    schema: COMMAND_SCHEMAS.getAgentMailStatus,
    mutates: false,
    run: (core, input) => getAgentMailStatus(core.ctx(), input)
  }
} satisfies Partial<CommandTable>

export { agentMailCommands }
