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

/** Runs one command and converts its outcome (or any thrown error) into a tool result. */
export async function runTool(fn: () => unknown): Promise<CallToolResult> {
  try {
    return toolSuccess(await fn())
  } catch (error) {
    return toolFailure(toErrorShape(error))
  }
}
