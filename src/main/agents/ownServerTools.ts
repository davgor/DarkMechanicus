/**
 * Which approval requests are for a tool of the chat's own Dark Mechanicus server, the one the app passes
 * to the agent as `darkmechanicus`. Allow for this chat on such a request covers every tool of that
 * server for the rest of the chat; the server limits what each tool may do by the chat's role.
 *
 * Each vendor spells a tool of an MCP server its own way, and only that vendor's spelling counts, so a
 * name that merely looks like another vendor's never matches:
 * - Claude: `mcp__darkmechanicus__<tool>`. The tool is snake_case, so a server named
 *   `darkmechanicus__evil`, which Claude would spell the same way, is not taken for ours.
 * - Codex: asks per server, `mcp:darkmechanicus`; it never says which tool, so its allowance already
 *   covers the server and nothing else.
 * - Cursor: `darkmechanicus:<tool>`, from the call's `providerIdentifier` and `toolName`.
 *
 * The whole name has to match, so `mcp__darkmechanicus_evil__x`, `darkmechanicus_x` and
 * `mcp:darkmechanicus_evil` are other servers or no server. Only a request that is neither a command
 * nor a file edit can match.
 */
import type { ApprovalRequestItem } from '../../shared/agents/chat'
import type { AgentKind } from '../../shared/desktop/api'

/** The name the adapters give the chat's own server (`SERVER_NAME` in each adapter). */
const SERVER = 'darkmechanicus'
/** A Dark Mechanicus tool name: lower-case words joined by single underscores, as in `heartbeat_attempt`. */
const TOOL = '[a-z]+(?:_[a-z]+)*'

const OWN_SERVER_TOOL: Readonly<Record<AgentKind, RegExp>> = {
  claude: new RegExp(`^mcp__${SERVER}__${TOOL}$`),
  codex: new RegExp(`^mcp:${SERVER}$`),
  cursor: new RegExp(`^${SERVER}:${TOOL}$`)
}

/** True when the request is a call to a tool of the chat's own Dark Mechanicus server, as `agent` names it. */
export function isOwnServerCall(agent: AgentKind, request: Pick<ApprovalRequestItem, 'category' | 'tool'>): boolean {
  return request.category === 'other' && OWN_SERVER_TOOL[agent].test(request.tool)
}
