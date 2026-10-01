import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { toErrorShape } from '../core/errors'
import type { DomainErrorShape } from '../shared/domain/errors'

/**
 * Every tool answers with one JSON payload, mirrored in `content` (for hosts that only show text)
 * and `structuredContent`: `{ ok: true, data }` or `{ ok: false, error: { code, message, details? } }`.
 */
export function toolSuccess(data: unknown): CallToolResult {
  const payload = { ok: true, data }
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload }
}

export function toolFailure(error: DomainErrorShape): CallToolResult {
  const payload = { ok: false, error }
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
    isError: true
  }
}

/** A schema problem as zod reports it: where in the arguments, and what is wrong there. */
interface ArgumentIssue {
  readonly path: readonly PropertyKey[]
  readonly message: string
}

/** The most issues one `invalid_input` answer lists; any others are only counted. */
const MAX_REPORTED_ISSUES = 10

function issuePath(path: readonly PropertyKey[]): string {
  return path.length === 0 ? '(arguments)' : path.map(String).join('.')
}

/**
 * The `invalid_input` failure for arguments that do not match a tool's input schema. Each issue (up
 * to ten) is named by its dotted path, in the message and in `details.issues`.
 */
export function invalidInputFailure(tool: string, issues: readonly ArgumentIssue[]): CallToolResult {
  const reported = issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => ({ path: issuePath(issue.path), message: issue.message }))
  const listed = reported.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
  const unreported = issues.length - reported.length
  const more = unreported > 0 ? ` (and ${unreported} more)` : ''
  return toolFailure({
    code: 'invalid_input',
    message: `Invalid arguments for ${tool}: ${listed}${more}`,
    details: { tool, issues: reported }
  })
}

/** Runs one command and converts its outcome (or any thrown error) into a tool result. */
export async function runTool(fn: () => unknown): Promise<CallToolResult> {
  try {
    return toolSuccess(await fn())
  } catch (error) {
    return toolFailure(toErrorShape(error))
  }
}
