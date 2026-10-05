/**
 * What the person is asked, and how the answer goes back, for each approval request `codex
 * app-server` sends (https://github.com/openai/codex, `codex-rs/app-server-protocol/schema/typescript`:
 * ServerRequest and the v2 `*RequestApproval*` params and responses).
 *
 * - `item/commandExecution/requestApproval` and `item/fileChange/requestApproval` answer with
 *   `{ decision }`: `accept` (once), `acceptForSession`, `decline`.
 * - `mcpServer/elicitation/request` is how Codex asks before a tool of an MCP server (the Dark
 *   Mechanicus one included) runs; it answers with `{ action, content, _meta }`, and
 *   `_meta.persist = "session"` asks Codex to remember an accept for the session.
 * - `item/permissions/requestApproval` asks for more access; it answers with the permissions
 *   granted and for how long (`turn` or `session`).
 */
import type { ApprovalCategory, ApprovalDecision, ApprovalRequestItem } from '../../../shared/agents/chat'
import { asRecord, asText, clip, type ChangedFile } from './codexItems'

type Fields = Record<string, unknown>
type Input = NonNullable<ApprovalRequestItem['input']>

export interface ApprovalDescription {
  category: ApprovalCategory
  tool: string
  summary: string
  input?: Input
}

/** The files a file-change item touches, by item id, as seen before its approval request. */
type ChangedFiles = ReadonlyMap<string, ChangedFile[]>

const SUMMARY_CLIP = 200
const LISTED = 3

function present(entries: [string, unknown][]): Input {
  return Object.fromEntries(entries.filter(([, value]) => value !== null && value !== undefined)) as Input
}

function describeCommand(params: Fields): ApprovalDescription {
  const command = asText(params.command)
  return {
    category: 'command',
    tool: 'shell',
    summary: command === null ? 'Run a command' : `Run: ${clip(command, SUMMARY_CLIP)}`,
    input: present([
      ['command', command === null ? null : clip(command)],
      ['cwd', asText(params.cwd)],
      ['reason', asText(params.reason)]
    ])
  }
}

function describeFiles(params: Fields, changes: ChangedFiles): ApprovalDescription {
  const paths = (changes.get(asText(params.itemId) ?? '') ?? []).map((file) => file.path)
  const shown = paths.slice(0, LISTED).join(', ')
  const more = paths.length > LISTED ? ', …' : ''
  const summary =
    paths.length === 0 ? 'Edit files' : paths.length === 1 ? `Edit ${shown}` : `Edit ${paths.length} files (${shown}${more})`
  return {
    category: 'file_edit',
    tool: 'apply_patch',
    summary,
    input: present([
      ['files', paths.length === 0 ? null : paths],
      ['reason', asText(params.reason)],
      ['grantRoot', asText(params.grantRoot)]
    ])
  }
}

function describeTool(params: Fields): ApprovalDescription {
  const server = asText(params.serverName) ?? 'mcp'
  const message = asText(params.message)
  return {
    category: 'other',
    tool: `mcp:${server}`,
    summary: message === null ? `Use a tool of the ${server} server` : clip(message, SUMMARY_CLIP),
    input: { server }
  }
}

function describePermissions(params: Fields): ApprovalDescription {
  const permissions = asRecord(params.permissions)
  return {
    category: 'other',
    tool: 'permissions',
    summary: asText(params.reason) ?? 'Extra permissions',
    input: present([['permissions', permissions as Input | null]])
  }
}

/** What to show for a server request, or null when it is not an approval. */
export function describeApproval(method: string, params: Fields, changes: ChangedFiles): ApprovalDescription | null {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return describeCommand(params)
    case 'item/fileChange/requestApproval':
      return describeFiles(params, changes)
    case 'mcpServer/elicitation/request':
      return describeTool(params)
    case 'item/permissions/requestApproval':
      return describePermissions(params)
    default:
      return null
  }
}

const DECISIONS = { allow_once: 'accept', allow_chat: 'acceptForSession', deny: 'decline' } as const satisfies Record<ApprovalDecision, string>

/** The permissions Codex asked for, in the shape of a grant (`null` entries are not asked for). */
function granted(requested: unknown): Fields {
  const asked = asRecord(requested) ?? {}
  return Object.fromEntries(Object.entries(asked).filter(([, value]) => value !== null && value !== undefined))
}

function answerElicitation(decision: ApprovalDecision): Fields {
  if (decision === 'deny') {
    return { action: 'decline', content: null, _meta: null }
  }
  return { action: 'accept', content: null, _meta: decision === 'allow_chat' ? { persist: 'session' } : null }
}

function answerPermissions(params: Fields, decision: ApprovalDecision): Fields {
  if (decision === 'deny') {
    return { permissions: {}, scope: 'turn' }
  }
  return { permissions: granted(params.permissions), scope: decision === 'allow_chat' ? 'session' : 'turn' }
}

/** The response to send back for the person's decision. */
export function answerFor(method: string, params: Fields, decision: ApprovalDecision): Fields {
  switch (method) {
    case 'mcpServer/elicitation/request':
      return answerElicitation(decision)
    case 'item/permissions/requestApproval':
      return answerPermissions(params, decision)
    default:
      return { decision: DECISIONS[decision] }
  }
}
