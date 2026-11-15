import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { COMMAND_SCHEMAS } from '../../core/commandSchemas'
import type { CommandApi } from '../../shared/domain/api'
import { defineSchemaTool, registerTools } from './define'

const NAMING_TOOLS = [defineSchemaTool({
  name: 'name_chat',
  description: 'Reports a semantic title inferred by this selected agent from its complete first user message, or an inference error. At most five words; no prompt-prefix extraction. Requires chat.name and the current live terminal generation binding; manual, system, existing and completed titles always win. No caller-selected target.',
  kind: 'write', schema: COMMAND_SCHEMAS.nameChat,
  run: (api, input) => api.nameChat(input)
})]
export function registerChatNamingTools(server: McpServer, api: CommandApi): void {
  registerTools(server, api, NAMING_TOOLS)
}
