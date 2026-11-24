import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { COMMAND_SCHEMAS } from '../../core/commandSchemas'
import type { CommandApi } from '../../shared/domain/api'
import { defineSchemaTool, registerTools } from './define'

const TOOLS = [defineSchemaTool({
  name: 'recover_tooling', kind: 'idempotent', schema: COMMAND_SCHEMAS.recoverTooling,
  description: 'Pause your task and report a Dark Mechanicus tooling defect with action escalate, a stable incidentId, and a sanitized diagnostic {command,code,message,reproduction,expected,arguments?}. Files or reuses a bug card, starts a dedicated repair orchestrator, and alerts active supported chats that a fix is underway. Tool access stays available. Check startup, first-prompt delivery and connection separately. Use status and message while waiting. The repair chat reports available with version and evidence. Planner/orchestrator only. Replay the same incident after partial failure.',
  run: (api, input) => api.recoverTooling(input)
})]
export function registerToolingRecoveryTools(server: McpServer, api: CommandApi): void {
  registerTools(server, api, TOOLS)
}
