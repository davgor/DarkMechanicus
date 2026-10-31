/**
 * How an ACP tool call is described in the transcript: its name and its raw input, cut down to what is
 * worth storing. The tool kinds are the ACP specification's (https://agentclientprotocol.com/protocol/tool-calls).
 */
import { clip, objectOf, type Json } from './acpJson'

/** A Map, not an object: a kind comes from the agent and must not reach `constructor` or `__proto__`. */
const TOOL_BY_KIND = new Map<string, string>([
  ['read', 'Read'],
  ['search', 'Search'],
  ['execute', 'Shell'],
  ['edit', 'Edit'],
  ['delete', 'Delete'],
  ['move', 'Move'],
  ['fetch', 'Fetch'],
  ['think', 'Think'],
  ['switch_mode', 'Switch mode']
])

const MAX_TOOL_NAME_CHARS = 80
const MAX_INPUT_STRING_CHARS = 2000
const MAX_INPUT_ENTRIES = 50
const MAX_INPUT_DEPTH = 4

export function stringOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** An MCP call may name its server and tool in its raw input (`providerIdentifier` and `toolName`). */
function mcpToolName(call: Record<string, unknown>): string | null {
  const input = objectOf(call.rawInput)
  const provider = stringOf(input?.providerIdentifier)
  const tool = stringOf(input?.toolName)
  return provider !== null && tool !== null ? `${provider}:${tool}` : null
}

/** What to call a tool in the transcript, and what an allowance for the chat covers: its MCP name, its kind, or its title. */
export function toolNameOf(call: Record<string, unknown>): string {
  const kind = stringOf(call.kind)
  const title = stringOf(call.title)
  const named = mcpToolName(call) ?? TOOL_BY_KIND.get(kind ?? '')
  return named ?? (title === null ? 'tool' : clip(title, MAX_TOOL_NAME_CHARS))
}

function shrink(value: unknown, depth: number): Json {
  if (typeof value === 'string') {
    return clip(value, MAX_INPUT_STRING_CHARS)
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value
  }
  if (depth >= MAX_INPUT_DEPTH) {
    return '…'
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_INPUT_ENTRIES).map((item: unknown) => shrink(item, depth + 1))
  }
  const entries = Object.entries(objectOf(value) ?? {}).slice(0, MAX_INPUT_ENTRIES)
  return Object.fromEntries(entries.map(([key, item]) => [key, shrink(item, depth + 1)]))
}

/** The raw input of a tool call, cut down to what is worth storing; undefined when it has none. */
export function summarizeInput(rawInput: unknown): Record<string, Json> | undefined {
  const input = objectOf(rawInput)
  return input === null ? undefined : (shrink(input, 0) as Record<string, Json>)
}
